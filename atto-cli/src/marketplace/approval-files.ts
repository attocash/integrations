import { randomBytes } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { AttoError } from '../domain/errors.js';
import type { MarketplaceProofApprovalRequest, MarketplaceProofApprovalResponse } from './proof-approval.js';

const MAX_REQUEST_BYTES = 32_768;
const PRIVATE_FILE_MODE = 0o600;

export function readMarketplaceProofApprovalRequest(pathValue: string): MarketplaceProofApprovalRequest {
  if (typeof pathValue !== 'string' || pathValue.length > 4096 || pathValue.includes('\0')) throw invalidFile();
  const path = resolve(pathValue);
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || !ownedByCurrentUser(before.uid)
      || (before.mode & 0o022) !== 0 || before.size < 2 || before.size > MAX_REQUEST_BYTES) throw invalidFile();
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || !ownedByCurrentUser(info.uid)
      || (info.mode & 0o022) !== 0 || info.size < 2 || info.size > MAX_REQUEST_BYTES) throw invalidFile();
    const bytes = readFileSync(descriptor);
    if (bytes.length > MAX_REQUEST_BYTES) throw invalidFile();
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidFile();
    return parsed as MarketplaceProofApprovalRequest;
  } catch (error) {
    if (error instanceof AttoError) throw error;
    throw invalidFile();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function writeMarketplaceProofApprovalResponse(requestPathValue: string, response: MarketplaceProofApprovalResponse): string {
  const requestPath = resolve(requestPathValue);
  const requestName = basename(requestPath);
  if (!/^[a-f0-9]{32}\.request\.json$/.test(requestName) || requestName.slice(0, 32) !== response.handoffId) throw invalidFile();
  const directoryPath = dirname(requestPath);
  const directory = lstatSync(directoryPath);
  const request = lstatSync(requestPath);
  if (!directory.isDirectory() || directory.isSymbolicLink() || !ownedByCurrentUser(directory.uid)
    || (directory.mode & 0o022) !== 0 || !request.isFile() || request.isSymbolicLink() || !ownedByCurrentUser(request.uid)) throw invalidFile();
  const responsePath = join(directoryPath, `${response.handoffId}.response.json`);
  const temporaryPath = join(directoryPath, `.${randomBytes(16).toString('hex')}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
    fchmodSync(descriptor, PRIVATE_FILE_MODE);
    writeFileSync(descriptor, `${JSON.stringify(response)}\n`, { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try { linkSync(temporaryPath, responsePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AttoError('MARKETPLACE_APPROVAL_EXISTS', 'An approval response file already exists. Keep the exact response or request a new Marketplace challenge.');
      throw error;
    }
    const directoryFd = openSync(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    return responsePath;
  } catch (error) {
    if (error instanceof AttoError) throw error;
    throw new AttoError('MARKETPLACE_APPROVAL_FILE', 'The signed response could not be stored in a private response file.');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporaryPath); } catch { /* No temp file remains if link failed or cleanup already ran. */ }
  }
}

function ownedByCurrentUser(uid: number): boolean {
  return typeof process.getuid === 'function' && uid === process.getuid();
}

function invalidFile(): AttoError {
  return new AttoError('MARKETPLACE_APPROVAL_FILE', 'Use the exact private Marketplace approval request file from its configured handoff directory.');
}
