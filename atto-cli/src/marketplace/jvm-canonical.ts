import { createHash } from 'node:crypto';

/** Java/Kotlin-compatible canonicalization helpers for Marketplace approval binding hashes. */
export function javaTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
  return value.slice(start, end);
}

export function boundedAsciiSpaceReason(value: unknown, maximumCodePoints: number): string | undefined {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) === 0x20) end--;
  const normalized = value.slice(start, end);
  const length = [...normalized].length;
  return length >= 1 && length <= maximumCodePoints ? normalized : undefined;
}

export function boundedDisputeText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.includes('\0')) return undefined;
  const normalized = normalizeDisputeText(value);
  const length = [...normalized].length;
  return length >= 1 && length <= 2_000 ? normalized : undefined;
}

export function normalizeDisputeText(value: string): string {
  const characters = [...value];
  let first = 0;
  let last = characters.length;
  while (first < last && isKotlinWhitespace(characters[first]!)) first++;
  while (last > first && isKotlinWhitespace(characters[last - 1]!)) last--;
  return characters.slice(first, last).join('');
}

function isKotlinWhitespace(character: string): boolean {
  const point = character.codePointAt(0)!;
  return (point >= 0x0009 && point <= 0x000d) || (point >= 0x001c && point <= 0x0020)
    || point === 0x00a0 || point === 0x1680 || (point >= 0x2000 && point <= 0x200a)
    || point === 0x2028 || point === 0x2029 || point === 0x202f || point === 0x205f || point === 0x3000;
}

export function normalizeEvidenceUrls(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 5 || value.some(item => typeof item !== 'string')) return undefined;
  const urls: string[] = [];
  for (const item of value as string[]) {
    if (item.length < 1 || item.length > 2_048) return undefined;
    const canonical = backendEvidenceUrl(item);
    if (!canonical) return undefined;
    urls.push(canonical);
  }
  return new Set(urls).size === urls.length ? urls : undefined;
}

function backendEvidenceUrl(raw: string): string | undefined {
  // java.net.URI.toASCIIString emits non-ASCII URI text in NFC form before
  // escaping its UTF-8 bytes. Keep the same spelling behavior for the
  // backend's length-prefixed approval binding.
  const normalized = raw.normalize('NFC');
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(.*)$/su.exec(normalized);
  if (!match || match[1]!.toLowerCase() !== 'https') return undefined;
  const authority = match[2]!;
  if (!authority || authority.includes('@') || !validUriCharacters(normalized)) return undefined;
  const serverAuthority = /^([^:\[\]@/?#]+)(?::([0-9]*))?$/u.exec(authority);
  if (!serverAuthority) return undefined;
  const rawHost = serverAuthority[1]!;
  const portText = serverAuthority[2];
  if (portText !== undefined && portText !== '') {
    const port = Number(portText);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return undefined;
  }
  const host = rawHost.toLowerCase();
  const labels = host.split('.');
  if (labels.length < 2 || labels.some(label => !label || label.length > 63
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
    || labels.at(-1)!.length < 2 || /^\d+$/.test(labels.at(-1)!)
    || ['localhost', 'local', 'internal', 'test', 'invalid'].includes(labels.at(-1)!)
    || /^[0-9.]+$/.test(host) || host.includes(':')) return undefined;
  return toAsciiUri(normalized);
}

function validUriCharacters(value: string): boolean {
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)(.*)$/su.exec(value);
  if (!match) return false;
  const suffix = match[2]!;
  const fragmentAt = suffix.indexOf('#');
  if (fragmentAt >= 0 && suffix.indexOf('#', fragmentAt + 1) >= 0) return false;
  const queryAt = suffix.indexOf('?');
  const pathEnd = Math.min(queryAt < 0 ? suffix.length : queryAt,
    fragmentAt < 0 ? suffix.length : fragmentAt);
  const path = suffix.slice(0, pathEnd);
  if (path !== '' && !path.startsWith('/')) return false;
  const query = queryAt >= 0 && (fragmentAt < 0 || queryAt < fragmentAt)
    ? suffix.slice(queryAt + 1, fragmentAt < 0 ? suffix.length : fragmentAt) : undefined;
  const fragment = fragmentAt >= 0 ? suffix.slice(fragmentAt + 1) : undefined;
  const authority = match[1]!;
  return validUriPart(authority, 'authority')
    && validUriPart(path, 'path')
    && (query === undefined || validUriPart(query, 'query'))
    && (fragment === undefined || validUriPart(fragment, 'fragment'));
}

function validUriPart(value: string, part: 'authority' | 'path' | 'query' | 'fragment'): boolean {
  for (let index = 0; index < value.length;) {
    const point = value.codePointAt(index)!;
    const character = String.fromCodePoint(point);
    if (point <= 0x20 || (point >= 0x7f && point <= 0x9f) || (point >= 0xd800 && point <= 0xdfff)) return false;
    if (point <= 0x7f) {
      const allowed = part === 'authority'
        ? /^[A-Za-z0-9.:-]$/
        : part === 'path'
          ? /^[A-Za-z0-9\-._~!$&'()*+,;=:@/%]$/
          : /^[A-Za-z0-9\-._~!$&'()*+,;=:@/?%\[\]]$/;
      if (!allowed.test(character)) return false;
    }
    if (character === '%' && !/^[0-9A-Fa-f]{2}$/.test(value.slice(index + 1, index + 3))) return false;
    index += character.length;
  }
  return true;
}

function toAsciiUri(value: string): string {
  return [...value].map(character => {
    const point = character.codePointAt(0)!;
    if (point <= 0x7f) return character;
    return [...Buffer.from(character, 'utf8')].map(byte => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');
  }).join('');
}

export function lengthPrefixedSha256(fields: string[]): string {
  const digest = createHash('sha256');
  for (const field of fields) {
    const bytes = Buffer.from(field, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    digest.update(length);
    digest.update(bytes);
  }
  return digest.digest('hex');
}
