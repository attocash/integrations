import { createHash } from 'node:crypto';
import { z } from 'zod';
import { addressPublicKey, upperHex } from '@attocash/atto-marketplace-nano-adapter/protocol';
import { canonicalJson } from './marketplace-api.js';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const amount = z.string().regex(/^[1-9][0-9]{0,64}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const nativeHash = z.string().regex(/^[A-F0-9]{64}$/);
const instant = z.string().datetime({ offset: true });
const ACCOUNT_BINDING = 'marketplace-account-binding';

const paymentRequestShape = z.strictObject({
  version: z.literal(1),
  type: z.literal('marketplace-x402-payment-request'),
  handoffId: z.string().regex(/^[a-f0-9]{32}$/),
  origin: z.string().min(1).max(2048),
  audience: z.string().min(1).max(512),
  accountId: uuid,
  asset: z.literal('XNO'),
  network: z.enum(['nano:mainnet', 'nano:dev']),
  amountAtomic: amount,
  requestId: uuid,
  paymentIdentifier: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  intentId: uuid,
  resourceUrl: z.string().min(1).max(4096),
  expiresAt: instant,
  paymentRequired: z.string().min(4).max(100_000),
  paymentRequiredSha256: digest,
  requestSha256: digest,
});

const paymentResponseShape = z.strictObject({
  version: z.literal(1),
  type: z.literal('marketplace-x402-payment-response'),
  handoffId: z.string().regex(/^[a-f0-9]{32}$/),
  requestSha256: digest,
  intentId: uuid,
  requestId: uuid,
  accountId: uuid,
  asset: z.literal('XNO'),
  network: z.enum(['nano:mainnet', 'nano:dev']),
  amountAtomic: amount,
  origin: z.string().min(1).max(2048),
  paymentIdentifier: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  resourceUrl: z.string().min(1).max(4096),
  paymentRequiredSha256: digest,
  sendHash: nativeHash,
  payer: z.string().min(1).max(128),
  signedDeadline: instant,
  paymentSignature: z.string().min(4).max(90_000),
});

export type XnoPaymentRequest = z.infer<typeof paymentRequestShape>;
export type XnoPaymentResponse = z.infer<typeof paymentResponseShape>;

export interface NewXnoPaymentRequest extends Omit<XnoPaymentRequest, 'paymentRequiredSha256' | 'requestSha256'> {}

export class PaymentHandoffError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Bind the exact decoded server challenge bytes and all immutable intent identity into one request digest. */
export function createXnoPaymentRequest(input: NewXnoPaymentRequest): XnoPaymentRequest {
  const base = paymentRequestShape.omit({ paymentRequiredSha256: true, requestSha256: true }).parse(input);
  const challengeBytes = decodeCanonicalBase64(base.paymentRequired, 75_000);
  const challenge = parseJsonObject(challengeBytes);
  validateRequirement(challenge, base);
  const paymentRequiredSha256 = sha256(challengeBytes);
  const unsigned = { ...base, paymentRequiredSha256 };
  return paymentRequestShape.parse({ ...unsigned, requestSha256: sha256(canonicalJson(unsigned)) });
}

/** Recheck both digests and the Marketplace challenge before accepting a request from a private file. */
export function parseXnoPaymentRequest(value: unknown, now = Date.now()): XnoPaymentRequest {
  const request = paymentRequestShape.parse(value);
  validatePinnedOrigin(request.origin);
  if (request.paymentIdentifier !== request.requestId
    || request.resourceUrl !== `${request.origin}/v1/agent/topups/${request.intentId}`
    || Date.parse(request.expiresAt) <= now) throw invalidHandoff();
  const challengeBytes = decodeCanonicalBase64(request.paymentRequired, 75_000);
  if (sha256(challengeBytes) !== request.paymentRequiredSha256) throw invalidHandoff();
  const challenge = parseJsonObject(challengeBytes);
  validateRequirement(challenge, request);
  const { requestSha256: _requestSha256, ...unsigned } = request;
  if (sha256(canonicalJson(unsigned)) !== request.requestSha256) throw invalidHandoff();
  return request;
}

/** Validate a payer response against the immutable request and its exact x402 v2 challenge. */
export function parseXnoPaymentResponse(value: unknown, requestValue: unknown, handoffId: string, now = Date.now()): XnoPaymentResponse {
  const request = parseXnoPaymentRequest(requestValue, now);
  const response = paymentResponseShape.parse(value);
  if (response.handoffId !== handoffId || response.handoffId !== request.handoffId
    || response.requestSha256 !== request.requestSha256 || response.intentId !== request.intentId
    || response.requestId !== request.requestId || response.accountId !== request.accountId
    || response.asset !== request.asset || response.network !== request.network
    || response.amountAtomic !== request.amountAtomic || response.origin !== request.origin
    || response.paymentIdentifier !== request.paymentIdentifier || response.resourceUrl !== request.resourceUrl
    || response.paymentRequiredSha256 !== request.paymentRequiredSha256
    || response.signedDeadline !== request.expiresAt) {
    throw invalidHandoff();
  }
  const required = parseJsonObject(decodeCanonicalBase64(request.paymentRequired, 75_000));
  const signed = parseJsonObject(decodeCanonicalBase64(response.paymentSignature, 65_536));
  validateSignedPayment(signed, required, request, response);
  return response;
}

export function xnoPaymentRequestDigest(requestValue: unknown): string {
  const request = parseXnoPaymentRequest(requestValue, 0);
  return request.requestSha256;
}

function validateRequirement(value: Record<string, unknown>, request: Pick<XnoPaymentRequest,
  'origin' | 'network' | 'amountAtomic' | 'accountId' | 'intentId' | 'paymentIdentifier' | 'expiresAt' | 'resourceUrl'>): void {
  const resource = object(value.resource);
  const accepts = value.accepts;
  if (value.x402Version !== 2 || resource.url !== request.resourceUrl
    || !Array.isArray(accepts) || accepts.length !== 1) throw invalidHandoff();
  const accepted = object(accepts[0]);
  const extra = accepted.extra === undefined ? {} : object(accepted.extra);
  if (accepted.scheme !== 'exact' || accepted.network !== request.network || accepted.asset !== 'XNO'
    || accepted.amount !== request.amountAtomic || typeof accepted.payTo !== 'string'
    || (extra.assetTransferMethod !== undefined && extra.assetTransferMethod !== 'native-state')
    || (extra.paymentFlow !== undefined && extra.paymentFlow !== 'upfront')
    || (extra.workOptional !== undefined && typeof extra.workOptional !== 'boolean')
    || !Number.isInteger(accepted.maxTimeoutSeconds) || Number(accepted.maxTimeoutSeconds) < 1 || Number(accepted.maxTimeoutSeconds) > 86400) throw invalidHandoff();
  const extensions = value.extensions === undefined ? {} : object(value.extensions);
  if (Object.hasOwn(extensions, 'payment-identifier')) {
    const identifier = object(extensions['payment-identifier']), info = object(identifier.info);
    object(identifier.schema);
    if (typeof info.required !== 'boolean' || (Object.hasOwn(info, 'id') && info.id !== request.paymentIdentifier)) throw invalidHandoff();
  }
  if (Object.hasOwn(extensions, ACCOUNT_BINDING)) {
    const binding = object(extensions[ACCOUNT_BINDING]), info = object(binding.info);
    object(binding.schema);
    if (info.required !== true || info.version !== 1 || info.domain !== 'marketplace.nano.exact.state.v1'
      || info.accountId !== request.accountId || info.intentId !== request.intentId
      || info.paymentIdentifier !== request.paymentIdentifier || info.intentExpiresAt !== request.expiresAt
      || Object.hasOwn(info, 'bindingSignature')) throw invalidHandoff();
  }
}

function validateSignedPayment(value: Record<string, unknown>, required: Record<string, unknown>, request: XnoPaymentRequest,
  response: XnoPaymentResponse): void {
  const resource = object(value.resource);
  const accepted = object(value.accepted);
  const expectedResource = object(required.resource);
  const expectedAccepts = required.accepts;
  if (!Array.isArray(expectedAccepts) || expectedAccepts.length !== 1
    || canonicalJson(resource) !== canonicalJson(expectedResource)
    || canonicalJson(accepted) !== canonicalJson(expectedAccepts[0]) || value.x402Version !== 2) throw invalidHandoff();
  const payload = object(value.payload);
  const send = object(payload.block);
  if (Object.keys(payload).length !== 1 || send.link_as_account !== accepted.payTo
    || send.account !== response.payer || send.type !== 'state'
    || !/^[A-Fa-f0-9]{64}$/.test(String(send.previous))
    || !/^[A-Fa-f0-9]{64}$/.test(String(send.link))
    || !/^[A-Fa-f0-9]{128}$/.test(String(send.signature))
    || !/^[A-Fa-f0-9]{16}$/.test(String(send.work))
    || !/^(0|[1-9][0-9]{0,64})$/.test(String(send.balance))) throw invalidHandoff();
  try {
    if (upperHex(addressPublicKey(String(send.link_as_account))) !== String(send.link).toUpperCase()) throw invalidHandoff();
  } catch { throw invalidHandoff(); }
  const extensions = value.extensions === undefined ? {} : object(value.extensions);
  const expectedExtensions = required.extensions === undefined ? {} : structuredClone(object(required.extensions));
  if (Object.hasOwn(expectedExtensions, 'payment-identifier')) {
    const identifier = object(expectedExtensions['payment-identifier']);
    identifier.info = { ...object(identifier.info), id: request.paymentIdentifier };
  }
  if (Object.hasOwn(expectedExtensions, ACCOUNT_BINDING)) {
    const binding = object(expectedExtensions[ACCOUNT_BINDING]);
    const signedBinding = object(extensions[ACCOUNT_BINDING]), info = object(signedBinding.info);
    if (!/^[A-F0-9]{128}$/.test(String(info.bindingSignature))) throw invalidHandoff();
    binding.info = { ...object(binding.info), bindingSignature: info.bindingSignature };
  }
  if (canonicalJson(extensions) !== canonicalJson(expectedExtensions)) throw invalidHandoff();
}

function validatePinnedOrigin(origin: string): void {
  let url: URL;
  try { url = new URL(origin); } catch { throw invalidHandoff(); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.origin !== origin || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw invalidHandoff();
}

function decodeCanonicalBase64(value: string, maxBytes: number): Uint8Array {
  if (value.length > 100_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw invalidHandoff();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 1 || bytes.length > maxBytes || bytes.toString('base64') !== value) throw invalidHandoff();
  return bytes;
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> {
  try { return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch { throw invalidHandoff(); }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidHandoff();
  return value as Record<string, unknown>;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function invalidHandoff(): PaymentHandoffError {
  return new PaymentHandoffError('PAYMENT_BINDING', 'The XNO payment handoff is invalid or does not match its saved request.');
}
