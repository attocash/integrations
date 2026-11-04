import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MarketplaceApiError } from './marketplace-api.js';

export const MAX_PRIVATE_FILE_BYTES = 104_857_600;
const MAX_TRANSFER_MS = 15 * 60 * 1000;

export interface LocalPrivateFile {
  path: string;
  filename: string;
  byteLength: number;
  sha256: string;
  bytes: Buffer;
}

export interface ImmutableFileManifestEntry {
  ordinal: number;
  fileId: string;
  contentVersionId: string;
  filename: string;
  byteLength: number;
  mediaType: string;
  sha256: string;
}

export function requireFilesDirectory(configured: string | undefined): string {
  if (!configured || !isAbsolute(configured) || configured.includes('\0') || configured.length > 4096) {
    throw new MarketplaceApiError('FILES_DIRECTORY_REQUIRED', 'Configure an absolute private files directory with --files-dir or MARKETPLACE_MCP_FILES_DIR before using file tools.');
  }
  let canonical: string;
  try { canonical = realDirectory(configured); }
  catch { throw new MarketplaceApiError('FILES_DIRECTORY_INVALID', 'The configured private files directory is unavailable or unsafe.'); }
  return canonical;
}

export function readLocalSource(configuredRoot: string | undefined, rawPath: string): LocalPrivateFile {
  const root = requireFilesDirectory(configuredRoot);
  const path = resolveBoundedPath(root, rawPath, true);
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1n || before.size > BigInt(MAX_PRIVATE_FILE_BYTES)) throw pathError();
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.size < 1n || opened.size > BigInt(MAX_PRIVATE_FILE_BYTES)
      || before.ino !== opened.ino || before.dev !== opened.dev) throw pathError();
    const chunks: Buffer[] = [];
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const read = readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (read === 0) break;
      total += read;
      if (total > MAX_PRIVATE_FILE_BYTES) throw pathError();
      chunks.push(Buffer.from(chunk.subarray(0, read)));
    }
    const bytes = Buffer.concat(chunks, total);
    const after = fstatSync(descriptor, { bigint: true });
    if (opened.size !== BigInt(bytes.byteLength) || after.size !== opened.size
      || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) throw pathError();
    const filename = validateFilename(basename(path));
    return { path, filename, byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), bytes };
  } catch (error) {
    if (error instanceof MarketplaceApiError) throw error;
    throw pathError();
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function resolveDownloadDestination(configuredRoot: string | undefined, rawPath: string): string {
  const root = requireFilesDirectory(configuredRoot);
  const target = resolveBoundedPath(root, rawPath, false);
  try {
    const info = lstatSync(target);
    if (info.isSymbolicLink() || !info.isFile()) throw pathError();
    throw new MarketplaceApiError('FILES_DESTINATION_EXISTS', 'The explicit download destination already exists; Marketplace MCP will not overwrite it.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return target;
}

export async function publishVerifiedResponse(configuredRoot: string | undefined, rawPath: string,
  response: Response, manifest: Pick<ImmutableFileManifestEntry, 'byteLength' | 'sha256'>): Promise<string> {
  const target = resolveDownloadDestination(configuredRoot, rawPath);
  if (!Number.isSafeInteger(manifest.byteLength) || manifest.byteLength < 1 || manifest.byteLength > MAX_PRIVATE_FILE_BYTES
    || !/^[0-9a-f]{64}$/.test(manifest.sha256)) throw protocolError('The submission file manifest is invalid.');
  const declared = response.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== manifest.byteLength)) {
    await response.body?.cancel().catch(() => undefined);
    throw integrityError('Marketplace returned a content length that differs from the immutable submission manifest.');
  }
  if (!response.body) throw integrityError('Marketplace returned no bytes for the private file.');

  const parent = dirname(target);
  assertDirectoryInside(requireFilesDirectory(configuredRoot), parent);
  const temporary = join(parent, `.${basename(target)}.${randomBytes(12).toString('hex')}.tmp`);
  let descriptor: number | undefined;
  const reader = response.body.getReader();
  const hash = createHash('sha256');
  let total = 0;
  const deadline = Date.now() + MAX_TRANSFER_MS;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const mode = fstatSync(descriptor).mode;
    if ((mode & 0o077) !== 0) throw pathError();
    for (;;) {
      if (Date.now() >= deadline) throw integrityError('The private download exceeded its 15-minute time limit.');
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > manifest.byteLength || total > MAX_PRIVATE_FILE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw integrityError('Marketplace streamed more bytes than the immutable submission manifest allows.');
      }
      hash.update(value);
      writeAll(descriptor, value);
    }
    if (total !== manifest.byteLength || hash.digest('hex') !== manifest.sha256) {
      throw integrityError('The downloaded file bytes do not match the immutable submission manifest.');
    }
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;

    // Re-check the configured root and destination immediately before the
    // atomic hard-link publication; linkSync fails if another file appeared.
    const rechecked = resolveDownloadDestination(configuredRoot, rawPath);
    if (rechecked !== target) throw pathError();
    linkSync(temporary, target);
    unlinkSync(temporary);
    syncDirectory(parent);
    return target;
  } catch (error) {
    if (error instanceof MarketplaceApiError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new MarketplaceApiError('FILES_DESTINATION_EXISTS', 'The explicit download destination already exists; Marketplace MCP will not overwrite it.');
    }
    throw pathError();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    await reader.cancel().catch(() => undefined);
    try { unlinkSync(temporary); } catch { /* The temp file was never created or was already published. */ }
    reader.releaseLock();
  }
}

export function validateFilename(value: string): string {
  if (!value || Array.from(value).length > 255 || value === '.' || value === '..'
    || /[\\/\u0000-\u001f\u007f]/u.test(value)) throw pathError();
  return value;
}

function resolveBoundedPath(root: string, rawPath: string, mustExist: boolean): string {
  if (!rawPath || rawPath.includes('\0') || rawPath.length > 4096
    || rawPath.split(/[\\/]/).some(segment => segment === '..')) throw pathError();
  const target = resolve(isAbsolute(rawPath) ? rawPath : join(root, rawPath));
  const relativePath = relative(root, target);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw pathError();
  const parts = relativePath.split(sep);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part || part === '.' || part === '..') throw pathError();
    current = join(current, part);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) throw pathError();
    } catch (error) {
      if (!mustExist && index === parts.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  try {
    const existingPath = mustExist ? target : dirname(target);
    const real = realDirectoryOrFile(existingPath);
    const realRelative = relative(root, real);
    if (realRelative === '..' || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) throw pathError();
  } catch { throw pathError(); }
  return target;
}

function assertDirectoryInside(root: string, directory: string): void {
  const real = realDirectory(directory);
  const rel = relative(root, real);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw pathError();
}

function realDirectory(path: string): string {
  const canonical = realpathSync(path);
  const info = statSync(canonical);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0
    || (process.getuid !== undefined && info.uid !== process.getuid())) throw pathError();
  return canonical;
}

function realDirectoryOrFile(path: string): string {
  const canonical = realpathSync(path);
  const info = statSync(canonical);
  if (!info.isDirectory() && !info.isFile()) throw pathError();
  return canonical;
}

function writeAll(descriptor: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    if (written < 1) throw pathError();
    offset += written;
  }
}

function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try { descriptor = openSync(path, constants.O_RDONLY); fsyncSync(descriptor); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function pathError(): MarketplaceApiError { return new MarketplaceApiError('FILES_PATH', 'The explicit local file path is unavailable or escapes the configured private files directory.'); }
function protocolError(message: string): MarketplaceApiError { return new MarketplaceApiError('FILE_PROTOCOL', message); }
function integrityError(message: string): MarketplaceApiError { return new MarketplaceApiError('FILE_INTEGRITY', message); }
