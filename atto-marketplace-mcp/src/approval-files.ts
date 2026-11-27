import { recoverPrivatePublication, syncPublishedPrivateFile } from './private-file-sync.js';
import { securePrivatePermissions, syncPrivateDirectory } from '@attocash/cli/internal-marketplace';
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { isOpaqueHandle, isProfileId, type ApprovalChallenge } from './marketplace-validation.js';
import { ProfileError } from './profile-error.js';
import { canonicalJson } from './canonical-json.js';
import { validAttoProof } from './atto-proof.js';
import { offchainVerify } from '@attocash/atto-marketplace-nano-adapter/protocol';

const MAX_FILE_BYTES = 32_768;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const USER_APPROVAL_PURPOSES = new Set([
  'login', 'link authorizer', 'link new identity', 'unlink',
  'API-key creation', 'API-key rotation', 'API-key revocation', 'browser sign-in grant',
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

export function createApprovalRequest(input: {
  profileId: string;
  handoffId: string;
  origin: string;
  audience: string;
  controllerNetwork?: 'ATTO' | 'NANO';
  controllerAddress: string;
  controllerIndex: number;
  accountId?: string;
  identityId?: string;
  purpose: string;
  action: Record<string, unknown>;
  challenge: Pick<ApprovalChallenge, 'challengeId' | 'message' | 'issuedAt' | 'expiresAt'>;
}): MarketplaceProofApprovalRequest {
  return {
    version: 1,
    type: 'marketplace-controller-approval-request',
    profileId: input.profileId,
    handoffId: input.handoffId,
    marketplaceOrigin: input.origin,
    transport: 'AGENT_API',
    proofOrigin: null,
    audience: input.audience,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.identityId ? { identityId: input.identityId } : {}),
    controller: { network: input.controllerNetwork ?? 'ATTO', address: input.controllerAddress, index: input.controllerIndex },
    purpose: input.purpose,
    action: input.action,
    challenge: {
      challengeId: input.challenge.challengeId,
      message: input.challenge.message,
      issuedAt: input.challenge.issuedAt,
      expiresAt: input.challenge.expiresAt,
    },
  };
}

export function parseApprovalRequest(input: unknown, onInvalid?: () => never): MarketplaceProofApprovalRequest {
  const fail = onInvalid ?? (() => {
    throw new ProfileError('APPROVAL_FILE', 'The saved typed wallet approval request is invalid.');
  });
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail();
  const request = input as Record<string, unknown>;
  const controller = request.controller !== null && typeof request.controller === 'object' && !Array.isArray(request.controller)
    ? request.controller as Record<string, unknown> : undefined;
  if (request.version !== 1 || request.type !== 'marketplace-controller-approval-request'
    || typeof request.profileId !== 'string' || typeof request.handoffId !== 'string'
    || typeof request.marketplaceOrigin !== 'string' || request.transport !== 'AGENT_API' || request.proofOrigin !== null
    || typeof request.audience !== 'string' || typeof request.purpose !== 'string'
    || !controller || (controller.network !== 'ATTO' && controller.network !== 'NANO')
    || !request.challenge || !request.action || typeof request.action !== 'object') {
    fail();
  }
  return request as unknown as MarketplaceProofApprovalRequest;
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

/** Only ENOENT beneath safe private directories proves an unsigned handoff has no response. */
export function approvalResponseIsAbsent(home: string, profileId: string, handoffId: string): boolean {
  const path = approvalResponsePath(home, profileId, handoffId);
  const root = resolve(home);
  assertPrivateDirectory(root, false);
  for (const directory of [join(root, 'approvals'), join(root, 'approvals', profileId)]) {
    try { lstatSync(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw invalidFile(); }
    assertPrivateDirectory(directory, false);
  }
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
      || (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o777) !== PRIVATE_FILE_MODE))) throw invalidFile();
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    if (error instanceof ProfileError) throw error;
    throw invalidFile();
  }
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

export async function verifyApprovalSignature(request: MarketplaceProofApprovalRequest, response: Pick<MarketplaceProofApprovalResponse, 'signature'>,
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
  const descendants = relative(root, directory).split(sep).filter(Boolean);
  let current = root;
  for (const component of descendants) {
    current = join(current, component);
    try { mkdirSync(current, { mode: PRIVATE_DIRECTORY_MODE }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw invalidFile(); }
    assertPrivateDirectory(current, true);
  }
}

function assertPrivateDirectory(path: string, secure: boolean): void {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (typeof process.getuid !== 'function' || info.uid !== process.getuid()))) throw invalidFile();
    if (secure && process.platform !== 'win32') chmodSync(path, PRIVATE_DIRECTORY_MODE);
    const secured = secure ? lstatSync(path) : info;
    if (process.platform !== 'win32' && (secured.mode & 0o077) !== 0) throw invalidFile();
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    throw invalidFile();
  }
}

function writeUniquePrivateFile(path: string, content: string): void {
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.byteLength > MAX_FILE_BYTES) throw invalidFile();
  const directory = dirname(path);
  assertPrivateDirectory(directory, false);
  const temporary = join(directory, `.${randomBytes(16).toString('hex')}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
    // Windows files use the ordinary permissions inherited from their directory.
    if (process.platform !== 'win32') securePrivatePermissions(temporary, 'file');
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try { linkSync(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      unlinkSync(temporary);
      if (readPrivateFile(path) !== content.trimEnd()) throw error;
    }
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    syncPublishedPrivateFile(path);
    syncPrivateDirectory(directory);
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    throw invalidFile();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); syncPrivateDirectory(directory); } catch { /* A committed file is already durable; a temp cleanup is best effort. */ }
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
    const publication = lstatSync(path);
    if (!publication.isFile() || publication.isSymbolicLink()
      || (process.platform !== 'win32' && (typeof process.getuid !== 'function' || publication.uid !== process.getuid()
        || (publication.mode & 0o777) !== PRIVATE_FILE_MODE))) throw invalidFile();
    recoverPrivatePublication(path, /^\.[a-f0-9]{32}\.tmp$/);
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || (process.platform !== 'win32' && (typeof process.getuid !== 'function' || before.uid !== process.getuid()
        || (before.mode & 0o777) !== PRIVATE_FILE_MODE)) || before.size < 2 || before.size > MAX_FILE_BYTES) throw invalidFile();
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.nlink !== 1
      || (process.platform !== 'win32' && (typeof process.getuid !== 'function' || info.uid !== process.getuid()
        || (info.mode & 0o777) !== PRIVATE_FILE_MODE)) || info.size < 2 || info.size > MAX_FILE_BYTES) throw invalidFile();
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

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidFile();
  return value as Record<string, unknown>;
}

function assertNames(profileId: string, handoffId: string): void {
  if (!isProfileId(profileId) || !isOpaqueHandle(handoffId)) throw invalidFile();
}

function invalidFile(): ProfileError {
  return new ProfileError('APPROVAL_FILE', 'The private Marketplace wallet-approval handoff file is unavailable or invalid.');
}
