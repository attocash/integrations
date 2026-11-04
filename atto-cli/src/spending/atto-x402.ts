import { createHash } from 'node:crypto';
import { AttoSendBlock, AttoTransaction } from '@attocash/commons-core';
import { AttoError } from '../domain/errors.js';
import { parseAddress } from '../network/reader.js';

export type AttoPaymentNetwork = 'atto:live' | 'atto:beta' | 'atto:dev' | 'atto:local';

const MAX_REQUIRED_BYTES = 65_536;
const MAX_HEADER_CHARS = 90_000;

export interface AttoExactRequirement {
  rawJson: string;
  resource: Record<string, unknown>;
  accepted: Record<string, unknown>;
  network: AttoPaymentNetwork;
  amountRaw: string;
  payTo: string;
  maxTimeoutSeconds: number;
  resourceUrl: string;
  identifierSchema: Record<string, unknown>;
  extensions: Record<string, unknown>;
  fingerprint: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function decodeBase64(value: string, maxBytes: number): string {
  if (value.length < 1 || value.length > MAX_HEADER_CHARS || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new AttoError('MARKETPLACE_PROTOCOL', 'Marketplace returned an invalid payment challenge.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 1 || bytes.length > maxBytes || bytes.toString('base64') !== value) {
    throw new AttoError('MARKETPLACE_PROTOCOL', 'Marketplace returned an invalid payment challenge.');
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new AttoError('MARKETPLACE_PROTOCOL', 'Marketplace returned an invalid payment challenge.'); }
}

export function parseAttoExactRequirement(input: {
  header: string;
  apiUrl: string;
  intentId: string;
  network: AttoPaymentNetwork;
  amountRaw: string;
}): AttoExactRequirement {
  const rawJson = decodeBase64(input.header, MAX_REQUIRED_BYTES);
  let decoded: unknown;
  try { decoded = JSON.parse(rawJson); }
  catch { throw new AttoError('MARKETPLACE_PROTOCOL', 'Marketplace returned an invalid payment challenge.'); }
  const requirement = object(decoded);
  const resource = object(requirement?.resource);
  const accepts = requirement?.accepts;
  const accepted = Array.isArray(accepts) && accepts.length === 1 ? object(accepts[0]) : undefined;
  const extra = object(accepted?.extra);
  const extensions = object(requirement?.extensions);
  const identifier = object(extensions?.['payment-identifier']);
  const identifierInfo = object(identifier?.info);
  const identifierSchema = object(identifier?.schema);
  const resourceUrl = resource?.url;
  const expected = new URL(`${input.apiUrl.replace(/\/+$/, '')}/${input.intentId}`);
  if (!requirement || requirement.x402Version !== 2 || !resource || typeof resourceUrl !== 'string'
    || !accepted || accepted.scheme !== 'exact' || accepted.network !== input.network
    || accepted.amount !== input.amountRaw || accepted.asset !== 'atto'
    || typeof accepted.payTo !== 'string' || !Number.isSafeInteger(accepted.maxTimeoutSeconds)
    || (accepted.maxTimeoutSeconds as number) < 1 || (accepted.maxTimeoutSeconds as number) > 3600
    || (accepted.extra !== undefined && !extra)
    || (extra && Object.hasOwn(extra, 'assetTransferMethod') && extra.assetTransferMethod !== 'native')
    || (extra && Object.hasOwn(extra, 'paymentFlow') && extra.paymentFlow !== 'authorization')
    || identifierInfo?.required !== true || !identifierSchema) {
    throw new AttoError('MARKETPLACE_PROTOCOL', 'Marketplace returned an unsupported ATTO payment challenge.');
  }
  let offered: URL;
  try { offered = new URL(resourceUrl); }
  catch { throw new AttoError('MARKETPLACE_PROTOCOL', 'Marketplace returned an invalid payment resource.'); }
  if (offered.origin !== expected.origin || offered.pathname !== expected.pathname || offered.search || offered.hash
    || offered.username || offered.password) {
    throw new AttoError('MARKETPLACE_RESOURCE_MISMATCH', 'Marketplace offered a payment resource outside the configured top-up origin and intent.');
  }
  let payTo: string;
  try { payTo = parseAddress(accepted.payTo as string).value; }
  catch { throw new AttoError('MARKETPLACE_PROTOCOL', 'Marketplace returned an invalid ATTO deposit address.'); }
  if (payTo !== accepted.payTo) throw new AttoError('MARKETPLACE_PROTOCOL', 'Marketplace returned a noncanonical ATTO deposit address.');
  return {
    rawJson,
    resource,
    accepted,
    network: input.network,
    amountRaw: input.amountRaw,
    payTo,
    maxTimeoutSeconds: accepted.maxTimeoutSeconds as number,
    resourceUrl: offered.toString(),
    identifierSchema,
    extensions: extensions!,
    fingerprint: createHash('sha256').update(rawJson, 'utf8').digest('hex'),
  };
}

/** Build the x402 string profile directly from exact Commons values, leaving native JSON untouched. */
function wireTransaction(transaction: AttoTransaction): Record<string, unknown> {
  const block = transaction.block;
  if (!(block instanceof AttoSendBlock)) throw new AttoError('MARKETPLACE_PROTOCOL', 'An ATTO payment must be a native SEND.');
  return { block: { type: 'SEND', network: block.network.name, version: Number(block.version.toString()),
    algorithm: block.algorithm.name, address: block.address.value, height: block.height.toString(),
    balance: block.balance.toString(), timestamp: block.timestamp.toEpochMilliseconds().toString(),
    previous: block.previous.toString(), receiverAddress: block.receiverAddress.value, amount: block.amount.toString() },
    signature: transaction.signature.toString(), work: transaction.work.toString() };
}

function echoedExtensions(requirement: AttoExactRequirement, paymentIdentifier: string): Record<string, unknown> {
  const identifier = object(requirement.extensions['payment-identifier'])!;
  const info = object(identifier.info)!;
  if (Object.hasOwn(info, 'id') && info.id !== paymentIdentifier) {
    throw new AttoError('MARKETPLACE_PROTOCOL', 'The offered payment identifier differs from the original operation.');
  }
  return { ...requirement.extensions, 'payment-identifier': { ...identifier, info: { ...info, id: paymentIdentifier } } };
}

export function paymentPayload(requirement: AttoExactRequirement, paymentIdentifier: string, transaction: AttoTransaction): { json: string; header: string } {
  const json = JSON.stringify({ x402Version: 2, resource: requirement.resource, accepted: requirement.accepted,
    payload: { transaction: wireTransaction(transaction) }, extensions: echoedExtensions(requirement, paymentIdentifier) });
  const header = Buffer.from(json, 'utf8').toString('base64');
  if (Buffer.byteLength(json, 'utf8') > MAX_REQUIRED_BYTES || header.length > MAX_HEADER_CHARS) {
    throw new AttoError('MARKETPLACE_PROTOCOL', 'The ATTO payment payload exceeds the supported size.');
  }
  return { json, header };
}

/** Bind the parsed wire SEND to the complete native transaction, including signature and work. */
export function paymentTransactionMatches(paymentJson: string, transaction: AttoTransaction): boolean {
  try {
    const payment = object(JSON.parse(paymentJson));
    const wire = object(object(payment?.payload)?.transaction);
    const block = object(wire?.block);
    const native = transaction.block;
    if (!wire || !block || !(native instanceof AttoSendBlock) || block.type !== 'SEND'
      || block.address !== native.address.value || block.receiverAddress !== native.receiverAddress.value
      || block.algorithm !== native.algorithm.name || block.version !== Number(native.version.toString())) return false;
    const expectedBlock = object(wireTransaction(transaction).block)!;
    for (const field of ['height', 'balance', 'amount', 'timestamp']) {
      const value = block[field];
      if (value !== expectedBlock[field]) return false;
      if (typeof value !== 'string' || !(field === 'timestamp' ? /^(?:0|-?[1-9][0-9]*)$/ : /^(?:0|[1-9][0-9]*)$/).test(value)) return false;
    }
    const compatibility = { publicKey: native.publicKey.toString(), receiverAlgorithm: native.receiverAlgorithm.name,
      receiverPublicKey: native.receiverPublicKey.toString() };
    for (const [key, expected] of Object.entries(compatibility)) {
      if (Object.hasOwn(block, key) && block[key] !== expected) return false;
    }
    const decoded = AttoTransaction.fromJson(JSON.stringify({ ...wire, block: { ...block, ...compatibility } }));
    return decoded.hash.toString() === transaction.hash.toString()
      && decoded.signature.toString() === transaction.signature.toString() && decoded.work.toString() === transaction.work.toString()
      && Buffer.from(decoded.toByteArray()).equals(Buffer.from(transaction.toByteArray()));
  } catch { return false; }
}

/** Retained journals may contain the previous numeric envelope; recover its exact bytes without rewriting it. */
export function savedPaymentMatches(requirement: AttoExactRequirement, paymentIdentifier: string, transaction: AttoTransaction,
  paymentJson: string, paymentSignature: string): boolean {
  if (Buffer.from(paymentJson, 'utf8').toString('base64') !== paymentSignature) return false;
  const legacy = `{"x402Version":2,"resource":${JSON.stringify(requirement.resource)},"accepted":${JSON.stringify(requirement.accepted)},"payload":{"transaction":${transaction.toJson()}},"extensions":{"payment-identifier":{"schema":${JSON.stringify(requirement.identifierSchema)},"info":{"required":true,"id":${JSON.stringify(paymentIdentifier)}}}}}`;
  if (paymentJson === legacy) return true;
  try { return paymentPayload(requirement, paymentIdentifier, transaction).json === paymentJson; }
  catch { return false; }
}

export function paymentDeadline(transaction: AttoTransaction, maxTimeoutSeconds: number, intentExpiresAt: string): bigint {
  const timeoutDeadline = BigInt(transaction.block.timestamp.toEpochMilliseconds()) + BigInt(maxTimeoutSeconds) * 1000n;
  const expiry = Date.parse(intentExpiresAt);
  if (!Number.isSafeInteger(expiry) || expiry < 0) throw new AttoError('MARKETPLACE_PROTOCOL', 'Marketplace returned an invalid top-up expiry.');
  const intentDeadline = BigInt(expiry);
  return timeoutDeadline < intentDeadline ? timeoutDeadline : intentDeadline;
}
