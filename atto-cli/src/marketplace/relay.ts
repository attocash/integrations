import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AttoError } from '../domain/errors.js';
import { parseJsonObject } from './strict-json.js';

const hash = z.string().regex(/^[a-fA-F0-9]{64}$/);
const integer = z.string().regex(/^(0|[1-9][0-9]*)$/);
const termsSchema = z.strictObject({ paymentId: z.string().uuid(), purpose: z.enum(['PUBLICATION_FEE', 'SHOP_ORDER', 'TASK_MILESTONE', 'BUYER_REFUND']),
  sourceReference: z.string().min(1).max(512), ownerAccountId: z.string().uuid(), asset: z.enum(['ATTO', 'XNO']), network: z.string(),
  senderAddress: z.string().min(1).max(160), recipientAddress: z.string().min(1).max(160), amountAtomic: z.string().regex(/^[1-9][0-9]{0,38}$/),
  termsHash: hash, versionHash: hash, baselineHeight: integer, baselineFrontier: hash.nullable() });
export type RelayTerms = z.infer<typeof termsSchema>;
export interface RelayRequest { requestId: string; origin: string; audience: string; terms: RelayTerms; paymentRequired: string; index?: number }
export interface RelayProof { challengeId: string; message: string; signature: string }
export interface RelayOffer { header: string; raw: Record<string, unknown>; terms: RelayTerms; expiresAt: number }
export interface RelayRecord extends RelayRequest { version: 1; paymentSignature?: string }
export const MARKETPLACE_BINDING = 'marketplace-binding';
function invalid(message = 'The x402 offer differs from the frozen Marketplace payment.'): never { throw new AttoError('PAYMENT_PROTOCOL', message); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
export function decodePaymentHeader(header: string): Record<string, unknown> {
  if (typeof header !== 'string' || header.length < 1 || header.length > 90_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(header)) invalid('Invalid x402 header.');
  const bytes = Buffer.from(header, 'base64');
  if (bytes.length > 65_536 || bytes.toString('base64') !== header) invalid('Invalid x402 header.');
  try { return parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return invalid('Invalid x402 JSON.'); }
}
export function parseRelayOffer(request: RelayRequest, allowExpired = false, now = Date.now()): RelayOffer {
  const terms = termsSchema.parse(request.terms);
  let origin: URL;
  try { origin = new URL(request.origin); } catch { return invalid(); }
  if (origin.origin !== request.origin || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || !/^https?:$/.test(origin.protocol) || (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
    || typeof request.audience !== 'string' || request.audience.length < 1 || request.audience.length > 255
    || request.requestId !== terms.paymentId || !/^[A-Za-z0-9_-]{16,128}$/.test(request.requestId)) invalid();
  if (terms.asset === 'ATTO' ? !/^atto:(live|beta|dev|local)$/.test(terms.network) || BigInt(terms.amountAtomic) > (1n << 64n) - 1n
    : !/^nano:(mainnet|dev)$/.test(terms.network) || BigInt(terms.amountAtomic) > (1n << 128n) - 1n) invalid();
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
  if (Object.keys(extensions).sort().join(',') !== 'marketplace-binding,payment-identifier') invalid('Unsupported x402 extension.');
  const identifier = object(extensions['payment-identifier']), idInfo = object(identifier.info);
  object(identifier.schema);
  if (idInfo.required !== true || Object.keys(idInfo).some(key => !['required', 'id'].includes(key))
    || (idInfo.id !== undefined && idInfo.id !== request.requestId)) invalid();
  const binding = object(extensions[MARKETPLACE_BINDING]), info = object(binding.info);
  object(binding.schema);
  const { offerExpiresAt, ...boundTerms } = info;
  if (!isDeepStrictEqual(boundTerms, { required: true, version: 1, ...terms }) || Object.keys(binding).sort().join(',') !== 'info,schema'
    || typeof offerExpiresAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(offerExpiresAt)) invalid();
  const expiresAt = Date.parse(offerExpiresAt);
  if (!Number.isSafeInteger(expiresAt) || (!allowExpired && expiresAt <= now)) invalid('The unused x402 offer expired. Recover the original request before preparing a replacement.');
  return { header: request.paymentRequired, raw, terms, expiresAt };
}
/** Only an unused, expired offer window can change; every other offered byte remains semantically identical. */
export function validateRelayOfferRefresh(previous: RelayRequest, next: RelayRequest, now = Date.now()): void {
  const definition = (request: RelayRequest) => ({ requestId: request.requestId, origin: request.origin, audience: request.audience, terms: request.terms, index: request.index });
  const oldOffer = parseRelayOffer(previous, true, now), freshOffer = parseRelayOffer(next, false, now);
  const withoutWindow = (offer: RelayOffer) => {
    const extensions = object(offer.raw.extensions), binding = object(extensions[MARKETPLACE_BINDING]);
    const { offerExpiresAt: _unused, ...info } = object(binding.info);
    return { ...offer.raw, extensions: { ...extensions, [MARKETPLACE_BINDING]: { ...binding, info } } };
  };
  if (oldOffer.expiresAt > now || freshOffer.expiresAt <= oldOffer.expiresAt || !isDeepStrictEqual(definition(previous), definition(next))
    || !isDeepStrictEqual(withoutWindow(oldOffer), withoutWindow(freshOffer))) invalid('Only an expired unused offer window may be refreshed for the original payment.');
}
export function relayEvidenceBinding(terms: RelayTerms, transactionHash: string): string {
  return createHash('sha256').update(['Marketplace payment evidence v1', terms.paymentId, terms.versionHash, terms.termsHash,
    terms.ownerAccountId, terms.network, terms.senderAddress, terms.recipientAddress, terms.amountAtomic, transactionHash.toLowerCase()].join('\n')).digest('hex');
}
const relayChallenge = z.strictObject({
  challengeId: z.string().uuid(),
  message: z.string().min(1).max(4096),
  signature: z.string().regex(/^[a-fA-F0-9]{128}$/).optional(),
});
const signedProof = relayChallenge.required();

/** Check the unsigned challenge before either wallet opens its signing key. */
export function validateRelayChallenge(terms: RelayTerms, transactionHash: string, audience: string, challenge: unknown, now = Date.now()) {
  const parsed = relayChallenge.safeParse(challenge);
  if (!parsed.success) invalid('Invalid payment proof.');
  return validateChallengeFrame(terms, transactionHash, audience, parsed.data, false, now);
}

export function validateRelayProof(offer: RelayOffer, transactionHash: string, audience: string, proof: RelayProof, allowExpired = false, now = Date.now()): void {
  const parsed = signedProof.safeParse(proof);
  if (!parsed.success) invalid('Invalid payment proof.');
  validateChallengeFrame(offer.terms, transactionHash, audience, parsed.data, allowExpired, now);
}

function validateChallengeFrame(terms: RelayTerms, transactionHash: string, audience: string,
  challenge: Pick<RelayProof, 'challengeId' | 'message'>, allowExpired: boolean, now: number) {
  const lines = challenge.message.split('\n');
  if (lines.length !== 10 || /[\r\0]/.test(challenge.message) || lines[0] !== `${terms.asset === 'ATTO' ? '' : 'Nano '}Marketplace Agent Controller Proof v1`
    || lines[1] !== `Audience: ${audience}` || lines[2] !== `Network: ${terms.asset === 'ATTO' ? 'live' : terms.network}`
    || lines[3] !== `Address: ${terms.senderAddress}` || lines[4] !== 'Purpose: payment evidence' || lines[5] !== `Request ID: ${challenge.challengeId}`
    || lines[6] !== `Binding Hash: ${relayEvidenceBinding(terms, transactionHash)}` || !/^Nonce: [a-f0-9]{64}$/.test(lines[7]!)
    || !lines[8]!.startsWith('Issued At: ') || !lines[9]!.startsWith('Expiration Time: ')) invalid('Payment proof differs from the original candidate or audience.');
  const issuedAt = lines[8]!.slice('Issued At: '.length);
  const expiresAt = lines[9]!.slice('Expiration Time: '.length);
  const issued = Date.parse(issuedAt), expires = Date.parse(expiresAt);
  if (!Number.isSafeInteger(issued) || !Number.isSafeInteger(expires) || expires <= issued || expires - issued > 300_000
    || (!allowExpired && (issued > now + 30_000 || expires <= now))) invalid('Payment proof expired or has invalid timing.');
  return { issuedAt, expiresAt };
}
export function relayPaymentPayload(offer: RelayOffer, requestId: string, payload: Record<string, unknown>, proof: RelayProof): string {
  const extensions = object(offer.raw.extensions), identifier = object(extensions['payment-identifier']), binding = object(extensions[MARKETPLACE_BINDING]);
  const raw = { x402Version: 2, resource: offer.raw.resource, accepted: (offer.raw.accepts as unknown[])[0], payload,
    extensions: { ...extensions, 'payment-identifier': { ...identifier, info: { ...object(identifier.info), id: requestId } },
      [MARKETPLACE_BINDING]: { ...binding, proof } } };
  const json = JSON.stringify(raw);
  if (Buffer.byteLength(json) > 65_536) invalid('The x402 payload exceeds its byte limit.');
  return Buffer.from(json).toString('base64');
}
export function relayProofFromHeader(header: string): RelayProof { return object(object(decodePaymentHeader(header).extensions)[MARKETPLACE_BINDING]).proof as RelayProof; }
