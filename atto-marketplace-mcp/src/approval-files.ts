import { chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { ProfileError } from './profile-store.js';
import { canonicalJson } from './canonical-json.js';
import { validAttoProof } from './atto-proof.js';
import { offchainVerify } from '@attocash/atto-marketplace-nano-adapter/protocol';

const MAX_FILE_BYTES = 32_768;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const USER_APPROVAL_PURPOSES = new Set([
  'login', 'link authorizer', 'link new identity', 'unlink',
  'API-key creation', 'API-key rotation', 'API-key revocation',
  'payout address enrollment', 'payout address selection', 'payout address disablement',
  'withdrawal creation', 'product purchase', 'product refund',
]);

export interface MarketplaceProofApprovalRequest {
  version: 1;
  type: 'marketplace-controller-approval-request';
  profileId: string;
  handoffId: string;
  marketplaceOrigin: string;
  transport: 'AGENT_API' | 'BROWSER';
  proofOrigin: string | null;
  audience: string;
  accountId?: string;
  identityId?: string;
  controller: { network: 'ATTO' | 'NANO'; address: string; index: number };
  purpose: string;
  action: Record<string, unknown>;
  challenge: { challengeId: string; message: string; issuedAt: string; expiresAt: string };
}

export interface MarketplaceProofApprovalResponse {
  version: 1;
  type: 'marketplace-controller-approval-response';
  profileId: string;
  handoffId: string;
  requestDigest: string;
  challengeId: string;
  message: string;
  signature: string;
  controllerAddress: string;
  controllerIndex: number;
}

export async function writeApprovalRequest(home: string, profileId: string, handoffId: string, envelope: MarketplaceProofApprovalRequest): Promise<string> {
  assertNames(profileId, handoffId);
  requireUserApproval(envelope);
  if (envelope.profileId !== profileId || envelope.handoffId !== handoffId) throw invalidFile();
  const root = resolve(home);
  const directory = join(root, 'approvals', profileId);
  secureDirectoryChain(root, directory);
  const path = join(directory, `${handoffId}.request.json`);
  writeUniquePrivateFile(path, `${canonicalJson(envelope)}\n`);
  return path;
}

export function readApprovalRequest(home: string, profileId: string, handoffId: string): MarketplaceProofApprovalRequest {
  assertNames(profileId, handoffId);
  const request = readEnvelope(join(resolve(home), 'approvals', profileId, `${handoffId}.request.json`)) as unknown as MarketplaceProofApprovalRequest;
  requireUserApproval(request);
  if (request.profileId !== profileId || request.handoffId !== handoffId) throw invalidFile();
  return request;
}

export function readApprovalResponse(home: string, profileId: string, handoffId: string): MarketplaceProofApprovalResponse {
  assertNames(profileId, handoffId);
  return readEnvelope(join(resolve(home), 'approvals', profileId, `${handoffId}.response.json`)) as unknown as MarketplaceProofApprovalResponse;
}

/** Publish one immutable response, recovering only exactly identical bytes. */
export async function writeApprovalResponse(home: string, request: MarketplaceProofApprovalRequest,
  response: MarketplaceProofApprovalResponse): Promise<string> {
  const saved = readApprovalRequest(home, request.profileId, request.handoffId);
  if (approvalRequestDigest(saved) !== approvalRequestDigest(request)) throw invalidFile();
  validateApprovalResponse(request, response);
  const path = approvalResponsePath(home, request.profileId, request.handoffId);
  writeUniquePrivateFile(path, `${canonicalJson(response)}\n`);
  return path;
}

export function approvalRequestPath(home: string, profileId: string, handoffId: string): string {
  assertNames(profileId, handoffId);
  return join(resolve(home), 'approvals', profileId, `${handoffId}.request.json`);
}

export function approvalResponsePath(home: string, profileId: string, handoffId: string): string {
  assertNames(profileId, handoffId);
  return join(resolve(home), 'approvals', profileId, `${handoffId}.response.json`);
}

export function approvalRequestDigest(request: MarketplaceProofApprovalRequest): string {
  // Keep the approval envelope's digest implementation identical to the wallet helper.
  return createHash('sha256').update(canonicalJson(request), 'utf8').digest('hex');
}

export function validateApprovalResponse(request: MarketplaceProofApprovalRequest, input: unknown): MarketplaceProofApprovalResponse {
  requireUserApproval(request);
  const response = asRecord(input);
  const allowed = ['version','type','profileId','handoffId','requestDigest','challengeId','message','signature','controllerAddress','controllerIndex'];
  if (Object.keys(response).some(key => !allowed.includes(key)) || Object.keys(response).length !== allowed.length
    || response.version !== 1 || response.type !== 'marketplace-controller-approval-response'
    || response.profileId !== request.profileId || response.handoffId !== request.handoffId
    || response.requestDigest !== approvalRequestDigest(request)
    || response.challengeId !== request.challenge.challengeId || response.message !== request.challenge.message
    || response.controllerAddress !== request.controller.address || response.controllerIndex !== request.controller.index
    || typeof response.signature !== 'string' || response.signature.length < 32 || response.signature.length > 4096
    || /[\r\n\0]/.test(response.signature)) throw invalidFile();
  return response as unknown as MarketplaceProofApprovalResponse;
}

export async function verifyApprovalSignature(request: MarketplaceProofApprovalRequest, response: MarketplaceProofApprovalResponse,
  sourceEnv: NodeJS.ProcessEnv = process.env): Promise<void> {
  requireUserApproval(request);
  if (request.controller.network === 'ATTO') {
    if (!await validAttoProof(request.controller.address, request.challenge.message, response.signature)) throw invalidFile();
    return;
  }
  if (!/^[A-Fa-f0-9]{128}$/.test(response.signature)) throw invalidFile();
  if (!offchainVerify(request.controller.address, request.challenge.message, response.signature)) throw invalidFile();
}

/** Marketplace MCP prepares and consumes account-owner approvals only. */
function requireUserApproval(request: MarketplaceProofApprovalRequest): void {
  const action = request.action;
  if (!USER_APPROVAL_PURPOSES.has(request.purpose) || !action || typeof action !== 'object'
    || Array.isArray(action) || (action.authority !== undefined && action.authority !== 'SELLER')) throw invalidFile();
}

function secureDirectoryChain(root: string, directory: string): void {
  assertPrivateDirectory(root, false);
  const relative = directory.slice(root.length).split('/').filter(Boolean);
  let current = root;
  for (const component of relative) {
    current = join(current, component);
    try { mkdirSync(current, { mode: PRIVATE_DIRECTORY_MODE }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw invalidFile(); }
    assertPrivateDirectory(current, true);
  }
}

function assertPrivateDirectory(path: string, secure: boolean): void {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || !ownedByCurrentUser(info.uid)) throw invalidFile();
    if (secure) chmodSync(path, PRIVATE_DIRECTORY_MODE);
    const secured = secure ? lstatSync(path) : info;
    if ((secured.mode & 0o077) !== 0) throw invalidFile();
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    throw invalidFile();
  }
}

function writeUniquePrivateFile(path: string, content: string): void {
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.byteLength > MAX_FILE_BYTES) throw invalidFile();
  const directory = dirname(path);
  const temporary = join(directory, `.${randomBytes(16).toString('hex')}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
    fchmodSync(descriptor, PRIVATE_FILE_MODE);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try { linkSync(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || readPrivateFile(path) !== content.trimEnd()) throw error;
    }
    fsyncDirectory(directory);
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    throw invalidFile();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); fsyncDirectory(directory); } catch { /* A committed file is already durable; a temp cleanup is best effort. */ }
  }
}

function readEnvelope(path: string): Record<string, unknown> {
  const content = readPrivateFile(path);
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw invalidFile(); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidFile();
  return value as Record<string, unknown>;
}

function readPrivateFile(path: string): string {
  let descriptor: number | undefined;
  try {
    assertPrivateDirectory(dirname(path), false);
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || !ownedByCurrentUser(before.uid)
      || (before.mode & 0o777) !== PRIVATE_FILE_MODE || before.size < 2 || before.size > MAX_FILE_BYTES) throw invalidFile();
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || !ownedByCurrentUser(info.uid)
      || (info.mode & 0o777) !== PRIVATE_FILE_MODE || info.size < 2 || info.size > MAX_FILE_BYTES) throw invalidFile();
    const bytes = readFileSync(descriptor);
    if (bytes.length > MAX_FILE_BYTES) throw invalidFile();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\n$/, '');
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    throw invalidFile();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function ownedByCurrentUser(uid: number): boolean {
  return typeof process.getuid === 'function' && uid === process.getuid();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidFile();
  return value as Record<string, unknown>;
}

function assertNames(profileId: string, handoffId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(profileId) || !/^[a-f0-9]{32}$/.test(handoffId)) throw invalidFile();
}

function invalidFile(): ProfileError {
  return new ProfileError('APPROVAL_FILE', 'The private Marketplace wallet-approval handoff file is unavailable or invalid.');
}
