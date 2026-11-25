import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AttoError } from '../domain/errors.js';
import { parseJsonObject } from './strict-json.js';

const hash = z.string().regex(/^[a-fA-F0-9]{64}$/);
const integer = z.string().regex(/^(0|[1-9][0-9]*)$/);
const termsSchema = z.strictObject({ paymentId: z.string().uuid(), purpose: z.enum(['PUBLICATION_FEE', 'SHOP_ORDER', 'TASK_MILESTONE', 'SERVICE_MILESTONE', 'BUYER_REFUND']),
  sourceReference: z.string().min(1).max(512), ownerAccountId: z.string().uuid(), asset: z.enum(['ATTO', 'XNO']), network: z.string(),
  senderAddress: z.string().min(1).max(160), recipientAddress: z.string().min(1).max(160), amountAtomic: z.string().regex(/^[1-9][0-9]{0,38}$/),
  termsHash: hash, versionHash: hash, baselineHeight: integer, baselineFrontier: hash.nullable() });
export type RelayTerms = z.infer<typeof termsSchema>;
interface RelayBinding { requestId: string; origin: string; audience: string; terms: RelayTerms; index?: number }
export interface RelayRequest extends RelayBinding { mode?: never; paymentRequired: string }
export interface DurableRelayRequest extends RelayBinding { mode: 'DURABLE_NATIVE'; paymentRequired?: never }
export type WalletRelayRequest = RelayRequest | DurableRelayRequest;
interface RelayProof { challengeId: string; message: string; signature: string }
export interface RelayOffer { header: string; raw: Record<string, unknown>; terms: RelayTerms; audience: string }
export type RelayRecord = (RelayRequest & { paymentSignature?: string; nativePayloadJson?: never }
  | DurableRelayRequest & { paymentSignature?: never; nativePayloadJson?: string }) & { version: 1 };
const MARKETPLACE_BINDING = 'marketplace-binding';
function invalid(message = 'The x402 offer differs from the frozen Marketplace payment.'): never { throw new AttoError('PAYMENT_PROTOCOL', message); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
export function decodePaymentHeader(header: string): Record<string, unknown> {
  if (typeof header !== 'string' || header.length < 1 || header.length > 90_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(header)) invalid('Invalid x402 header.');
  const bytes = Buffer.from(header, 'base64');
  if (bytes.length > 65_536 || bytes.toString('base64') !== header) invalid('Invalid x402 header.');
  try { return parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return invalid('Invalid x402 JSON.'); }
}
function parseRelayBinding(request: RelayBinding): RelayTerms {
  const terms = termsSchema.parse(request.terms);
  let origin: URL;
  try { origin = new URL(request.origin); } catch { return invalid(); }
  if (origin.origin !== request.origin || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || !/^https?:$/.test(origin.protocol) || (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
    || typeof request.audience !== 'string' || request.audience.length < 1 || request.audience.length > 255
    || request.requestId !== terms.paymentId || !/^[A-Za-z0-9_-]{16,128}$/.test(request.requestId)) invalid();
  if (terms.asset === 'ATTO' ? !/^atto:(live|beta|dev|local)$/.test(terms.network) || BigInt(terms.amountAtomic) > (1n << 64n) - 1n
    : !/^nano:(mainnet|dev)$/.test(terms.network) || BigInt(terms.amountAtomic) > (1n << 128n) - 1n) invalid();
  return terms;
}

export function parseDurableRelayRequest(request: DurableRelayRequest): RelayTerms {
  if (request.mode !== 'DURABLE_NATIVE' || request.paymentRequired !== undefined
    || typeof request.requestId !== 'string' || request.requestId !== request.requestId.toLowerCase()) {
    invalid('Invalid durable Marketplace relay authorization.');
  }
  const terms = parseRelayBinding(request);
  if (terms.termsHash !== terms.termsHash.toLowerCase() || terms.versionHash !== terms.versionHash.toLowerCase()) {
    invalid('Durable relay requires canonical payment terms and version hashes.');
  }
  return terms;
}

export function parseRelayOffer(request: RelayRequest, retained = false): RelayOffer {
  if (request.mode !== undefined) invalid();
  const terms = parseRelayBinding(request);
  const raw = decodePaymentHeader(request.paymentRequired), resource = object(raw.resource);
  if (raw.x402Version !== 2 || resource.url !== `${request.origin}/v1/agent/payments/${terms.paymentId}`
    || !Array.isArray(raw.accepts) || raw.accepts.length !== 1) invalid();
  const accepted = object(raw.accepts[0]);
  if (accepted.scheme !== 'exact' || accepted.network !== terms.network || accepted.asset !== (terms.asset === 'ATTO' ? 'atto' : 'XNO')
    || accepted.payTo !== terms.recipientAddress || accepted.amount !== terms.amountAtomic
    || accepted.maxTimeoutSeconds !== (terms.asset === 'ATTO' ? 60 : 300)) invalid();
  if (terms.asset === 'ATTO' && !isDeepStrictEqual(accepted.extra, { assetTransferMethod: 'native', paymentFlow: 'authorization' })) invalid();
  // Nano proposal3432@96f65c29 does not declare transfer-method/flow metadata.
  if (terms.asset === 'XNO' && accepted.extra !== undefined) invalid('Unsupported Nano x402 profile metadata.');
  const extensions = object(raw.extensions);
  if (Object.keys(extensions).some(key => key !== 'payment-identifier' && !(retained && key === MARKETPLACE_BINDING))) invalid('Unsupported x402 extension.');
  const identifier = object(extensions['payment-identifier']), idInfo = object(identifier.info);
  object(identifier.schema);
  if (Object.keys(identifier).sort().join(',') !== 'info,schema' || idInfo.required !== true || Object.keys(idInfo).some(key => !['required', 'id'].includes(key))
    || (idInfo.id !== undefined && idInfo.id !== request.requestId)) invalid();
  if (Object.hasOwn(extensions, MARKETPLACE_BINDING)) {
    // Older journals froze application terms inside the offer. Verify them before using its candidate.
    const binding = object(extensions[MARKETPLACE_BINDING]);
    const { offerExpiresAt, ...boundTerms } = object(binding.info);
    object(binding.schema);
    if (!isDeepStrictEqual(boundTerms, { required: true, version: 1, ...terms }) || Object.keys(binding).sort().join(',') !== 'info,schema'
      || typeof offerExpiresAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(offerExpiresAt) || !Number.isSafeInteger(Date.parse(offerExpiresAt))) invalid();
  }
  return { header: request.paymentRequired, raw, terms, audience: request.audience };
}

/** An unsigned reservation may adopt a standard offer for its original payment. */
export function validateRelayOfferRefresh(previous: RelayRequest, next: RelayRequest): void {
  const definition = (request: RelayRequest) => ({ requestId: request.requestId, origin: request.origin, audience: request.audience, terms: request.terms, index: request.index });
  parseRelayOffer(previous, true);
  parseRelayOffer(next);
  if (!isDeepStrictEqual(definition(previous), definition(next))) invalid('The refreshed offer differs from the original payment.');
}
function relayEvidenceBinding(terms: RelayTerms, transactionHash: string): string {
  return createHash('sha256').update(['Marketplace payment evidence v1', terms.paymentId, terms.versionHash, terms.termsHash,
    terms.ownerAccountId, terms.network, terms.senderAddress, terms.recipientAddress, terms.amountAtomic, transactionHash.toLowerCase()].join('\n')).digest('hex');
}
const signedProof = z.strictObject({
  challengeId: z.string().uuid(),
  message: z.string().min(1).max(4096),
  signature: z.string().regex(/^[a-fA-F0-9]{128}$/),
});

// Only existing journals can contain this retired authorization frame.
function validateLegacyProof(terms: RelayTerms, transactionHash: string, audience: string, challenge: RelayProof): void {
  const lines = challenge.message.split('\n');
  if (lines.length !== 10 || /[\r\0]/.test(challenge.message) || lines[0] !== `${terms.asset === 'ATTO' ? '' : 'Nano '}Marketplace Agent Controller Proof v1`
    || lines[1] !== `Audience: ${audience}` || lines[2] !== `Network: ${terms.asset === 'ATTO' ? 'live' : terms.network}`
    || lines[3] !== `Address: ${terms.senderAddress}` || lines[4] !== 'Purpose: payment evidence' || lines[5] !== `Request ID: ${challenge.challengeId}`
    || lines[6] !== `Binding Hash: ${relayEvidenceBinding(terms, transactionHash)}` || !/^Nonce: [a-f0-9]{64}$/.test(lines[7]!)
    || !lines[8]!.startsWith('Issued At: ') || !lines[9]!.startsWith('Expiration Time: ')) invalid('Payment proof differs from the original candidate or audience.');
  const issuedAt = lines[8]!.slice('Issued At: '.length);
  const expiresAt = lines[9]!.slice('Expiration Time: '.length);
  const issued = Date.parse(issuedAt), expires = Date.parse(expiresAt);
  if (!Number.isSafeInteger(issued) || !Number.isSafeInteger(expires) || expires <= issued || expires - issued > 300_000) invalid('Invalid saved proof timing.');
}

function encodePayload(offer: RelayOffer, payload: Record<string, unknown>, extensions: Record<string, unknown>): string {
  const json = JSON.stringify({ x402Version: 2, resource: offer.raw.resource, accepted: (offer.raw.accepts as unknown[])[0], payload, extensions });
  if (Buffer.byteLength(json) > 65_536) invalid('The x402 payload exceeds its byte limit.');
  return Buffer.from(json).toString('base64');
}

function identifierExtension(offer: RelayOffer, requestId: string) {
  const identifier = object(object(offer.raw.extensions)['payment-identifier']);
  return { ...identifier, info: { ...object(identifier.info), id: requestId } };
}

export function relayPaymentPayload(offer: RelayOffer, requestId: string, payload: Record<string, unknown>): string {
  return encodePayload(offer, payload, { 'payment-identifier': identifierExtension(offer, requestId) });
}

export function validateRetainedRelayPayload(offer: RelayOffer, requestId: string, header: string, transactionHash: string) {
  const envelope = decodePaymentHeader(header), payload = object(envelope.payload), extensions = object(envelope.extensions);
  let expected: string, proof: RelayProof | undefined;
  if (Object.hasOwn(extensions, MARKETPLACE_BINDING)) {
    const original = object(offer.raw.extensions), binding = object(original[MARKETPLACE_BINDING]);
    proof = signedProof.parse(object(extensions[MARKETPLACE_BINDING]).proof);
    validateLegacyProof(offer.terms, transactionHash, offer.audience, proof);
    expected = encodePayload(offer, payload, { ...original, 'payment-identifier': identifierExtension(offer, requestId),
      [MARKETPLACE_BINDING]: { ...binding, proof: object(extensions[MARKETPLACE_BINDING]).proof } });
  } else {
    expected = relayPaymentPayload(offer, requestId, payload);
  }
  if (expected !== header) invalid('The saved payment header differs from the original offer.');
  return { payload, proof };
}
