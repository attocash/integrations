const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPAQUE_HANDLE_PATTERN = /^[a-f0-9]{32}$/;
export const POSITIVE_ATOMIC_PATTERN = /^[1-9][0-9]{0,64}$/;
export const NONNEGATIVE_ATOMIC_PATTERN = /^(0|[1-9][0-9]{0,64})$/;
const ATTO_ADDRESS_PATTERN = /^atto:\/\/[a-z2-7]{61}$/;
const NANO_ADDRESS_PATTERN = /^(?:nano|xrb)_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/;

export const CREDENTIAL_SCOPES = [
  'tasks:read', 'applications:read', 'applications:apply', 'applications:withdraw', 'tasks:draft:write', 'tasks:publish',
  'submissions:read', 'submissions:write', 'activity:read', 'activity:write', 'payments:read', 'payments:write',
  'files:read', 'files:write', 'products:read', 'products:write', 'products:publish', 'products:purchase',
  'purchases:read', 'purchases:refund', 'services:read', 'services:write',
] as const;

export const CREDENTIAL_SCOPE_SET = new Set<string>(CREDENTIAL_SCOPES);

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const LOWER_HEX = '0123456789abcdef';
const UPPER_HEX = '0123456789ABCDEF';

function bytesToHex(bytes: Uint8Array, uppercase: boolean): string {
  const alphabet = uppercase ? UPPER_HEX : LOWER_HEX;
  let out = '';
  for (const byte of bytes) out += alphabet[byte >> 4]! + alphabet[byte & 0x0f]!;
  return out;
}

export function isProfileId(value: unknown): value is string {
  return typeof value === 'string' && PROFILE_ID_PATTERN.test(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Validate and round-trip a canonical lowercase UUID through its 16 raw bytes. */
export function canonicalUuid(value: unknown, onInvalid?: () => never): string {
  if (!isUuid(value)) {
    if (onInvalid) onInvalid();
    throw new Error('Invalid UUID.');
  }
  const hex = value.replaceAll('-', '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const canonical = bytesToHex(bytes, false);
  return `${canonical.slice(0, 8)}-${canonical.slice(8, 12)}-${canonical.slice(12, 16)}-${canonical.slice(16, 20)}-${canonical.slice(20)}`;
}

/** Validate and round-trip a 64-byte hex Ed25519 signature through its raw bytes. */
export function canonicalHexSignature(value: unknown, onInvalid: () => never): string {
  if (typeof value !== 'string' || !/^[0-9A-Fa-f]{128}$/.test(value)) onInvalid();
  const bytes = new Uint8Array(64);
  for (let i = 0; i < 64; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytesToHex(bytes, value === value.toUpperCase());
}

export function isOpaqueHandle(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_HANDLE_PATTERN.test(value);
}

export function isPositiveAtomic(value: unknown): value is string {
  return typeof value === 'string' && POSITIVE_ATOMIC_PATTERN.test(value);
}

export function isControllerAddress(network: 'ATTO' | 'NANO', value: string): boolean {
  return network === 'ATTO' ? ATTO_ADDRESS_PATTERN.test(value) : NANO_ADDRESS_PATTERN.test(value);
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.includes(hostname.toLowerCase());
}

export function trimAsciiControlAndSpace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
  return value.slice(start, end);
}

export function parseMarketplaceOrigin(value: string, onInvalid: (reason: 'syntax' | 'scheme') => never): string {
  let url: URL;
  try { url = new URL(value); } catch { onInvalid('syntax'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname)))) {
    onInvalid('scheme');
  }
  return url.origin;
}

export function parseIsoDateMillis(value: unknown, onInvalid: () => never): number {
  if (typeof value !== 'string') onInvalid();
  const timestamp = Date.parse(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) onInvalid();
  return timestamp;
}

export interface ApprovalChallenge {
  challengeId: string;
  message: string;
  issuedAt: string;
  expiresAt: string;
  accountId?: string;
  controllerId?: string;
}

export function parseChallengeEnvelope(input: unknown, onInvalid: () => never): ApprovalChallenge {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) onInvalid();
  const value = input as Record<string, unknown>;
  if (!isUuid(value.challengeId) || typeof value.message !== 'string' || value.message.length < 1 || value.message.length > 4096
    || /\0/.test(value.message) || typeof value.issuedAt !== 'string' || typeof value.expiresAt !== 'string') onInvalid();
  const issued = parseIsoDateMillis(value.issuedAt, onInvalid);
  const expires = parseIsoDateMillis(value.expiresAt, onInvalid);
  if (issued > Date.now() + 30_000 || expires <= Date.now() || expires <= issued || expires - issued > 300_000) onInvalid();
  if ((value.accountId !== undefined || value.controllerId !== undefined)
    && (!isUuid(value.accountId) || !isUuid(value.controllerId))) onInvalid();
  return {
    challengeId: value.challengeId,
    message: value.message,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    ...(value.accountId !== undefined ? { accountId: value.accountId as string, controllerId: value.controllerId as string } : {}),
  };
}

export function validateCredentialCeilingRules(input: {
  scopes: readonly string[];
  publishAttoLimit?: string | null | undefined;
  publishXnoLimit?: string | null | undefined;
  productPublishAttoLimit?: string | null | undefined;
  productPublishXnoLimit?: string | null | undefined;
  purchaseAttoLimit?: string | null | undefined;
  purchaseXnoLimit?: string | null | undefined;
}): { publishInvalid: boolean; productPublishInvalid: boolean; purchaseInvalid: boolean } {
  const publish = input.scopes.includes('tasks:publish');
  const productPublish = input.scopes.includes('products:publish');
  const purchase = input.scopes.includes('products:purchase');
  return {
    publishInvalid: publish !== Boolean(input.publishAttoLimit || input.publishXnoLimit),
    productPublishInvalid: Boolean(input.productPublishAttoLimit || input.productPublishXnoLimit) && !productPublish,
    purchaseInvalid: purchase !== Boolean(input.purchaseAttoLimit || input.purchaseXnoLimit),
  };
}
