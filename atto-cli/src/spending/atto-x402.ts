import { createHash } from 'node:crypto';
import { AttoTransaction } from '@attocash/commons-core';
import { AttoError } from '../domain/errors.js';
import { parseAddress } from '../network/reader.js';

const MAX_REQUIRED_BYTES = 65_536;
const MAX_HEADER_CHARS = 90_000;

export interface AttoExactRequirement {
  rawJson: string;
  resource: Record<string, unknown>;
  accepted: Record<string, unknown>;
  network: 'atto:live' | 'atto:local';
  amountRaw: string;
  payTo: string;
  maxTimeoutSeconds: number;
  resourceUrl: string;
  identifierSchema: Record<string, unknown>;
  fingerprint: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function decodeBase64(value: string, maxBytes: number): string {
  if (value.length < 1 || value.length > MAX_HEADER_CHARS || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new AttoError('MARKET_PROTOCOL', 'Market returned an invalid payment challenge.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 1 || bytes.length > maxBytes || bytes.toString('base64') !== value) {
    throw new AttoError('MARKET_PROTOCOL', 'Market returned an invalid payment challenge.');
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new AttoError('MARKET_PROTOCOL', 'Market returned an invalid payment challenge.'); }
}

export function parseAttoExactRequirement(input: {
  header: string;
  apiUrl: string;
  intentId: string;
  network: 'atto:live' | 'atto:local';
  amountRaw: string;
}): AttoExactRequirement {
  const rawJson = decodeBase64(input.header, MAX_REQUIRED_BYTES);
  let decoded: unknown;
  try { decoded = JSON.parse(rawJson); }
  catch { throw new AttoError('MARKET_PROTOCOL', 'Market returned an invalid payment challenge.'); }
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
    || extra?.assetTransferMethod !== 'native' || extra.paymentFlow !== 'authorization'
    || identifierInfo?.required !== true || !identifierSchema) {
    throw new AttoError('MARKET_PROTOCOL', 'Market returned an unsupported ATTO payment challenge.');
  }
  let offered: URL;
  try { offered = new URL(resourceUrl); }
  catch { throw new AttoError('MARKET_PROTOCOL', 'Market returned an invalid payment resource.'); }
  if (offered.origin !== expected.origin || offered.pathname !== expected.pathname || offered.search || offered.hash
    || offered.username || offered.password) {
    throw new AttoError('MARKET_RESOURCE_MISMATCH', 'Market offered a payment resource outside the configured top-up origin and intent.');
  }
  let payTo: string;
  try { payTo = parseAddress(accepted.payTo as string).value; }
  catch { throw new AttoError('MARKET_PROTOCOL', 'Market returned an invalid ATTO deposit address.'); }
  if (payTo !== accepted.payTo) throw new AttoError('MARKET_PROTOCOL', 'Market returned a noncanonical ATTO deposit address.');
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
    fingerprint: createHash('sha256').update(rawJson, 'utf8').digest('hex'),
  };
}

/** Embed Commons JSON verbatim so unsigned native integers never pass through JS Number. */
export function paymentPayload(requirement: AttoExactRequirement, paymentIdentifier: string, transaction: AttoTransaction): { json: string; header: string } {
  const transactionJson = transaction.toJson();
  if (!transactionJson || Buffer.byteLength(transactionJson, 'utf8') > MAX_REQUIRED_BYTES) {
    throw new AttoError('MARKET_PROTOCOL', 'The signed ATTO transaction exceeds the supported payment size.');
  }
  const json = `{"x402Version":2,"resource":${JSON.stringify(requirement.resource)},"accepted":${JSON.stringify(requirement.accepted)},"payload":{"transaction":${transactionJson}},"extensions":{"payment-identifier":{"schema":${JSON.stringify(requirement.identifierSchema)},"info":{"required":true,"id":${JSON.stringify(paymentIdentifier)}}}}}`;
  const encoded = Buffer.from(json, 'utf8').toString('base64');
  if (Buffer.byteLength(json, 'utf8') > MAX_REQUIRED_BYTES || encoded.length > MAX_HEADER_CHARS) {
    throw new AttoError('MARKET_PROTOCOL', 'The ATTO payment payload exceeds the supported size.');
  }
  return { json, header: encoded };
}

export function paymentDeadline(transaction: AttoTransaction, maxTimeoutSeconds: number, intentExpiresAt: string): bigint {
  const timeoutDeadline = BigInt(transaction.block.timestamp.toEpochMilliseconds()) + BigInt(maxTimeoutSeconds) * 1000n;
  const expiry = Date.parse(intentExpiresAt);
  if (!Number.isSafeInteger(expiry) || expiry < 0) throw new AttoError('MARKET_PROTOCOL', 'Market returned an invalid top-up expiry.');
  const intentDeadline = BigInt(expiry);
  return timeoutDeadline < intentDeadline ? timeoutDeadline : intentDeadline;
}
