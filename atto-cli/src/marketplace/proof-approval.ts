import { createHash } from 'node:crypto';
import { AttoError } from '../domain/errors.js';
import {
  boundedAsciiSpaceReason, boundedDisputeText, javaTrim, lengthPrefixedSha256,
  normalizeDisputeText, normalizeEvidenceUrls,
} from './jvm-canonical.js';
import { isProofWindowValid, parseControllerProofFrame } from './proof-frame.js';

export { normalizeDisputeText, normalizeEvidenceUrls };

export interface ProofApprovalConnection {
  apiUrl: string;
  audience: string;
  controllerIndex: number;
  controllerAddress: string;
  accountId: string;
  identityId: string;
  browserOrigins?: string[];
}

const PURPOSES = new Set([
  'login', 'API-key creation', 'API-key rotation', 'API-key revocation',
  'link authorizer', 'link new identity', 'unlink',
  'administrator public moderation', 'administrator task cancellation or expiry',
  'administrator dispute opening', 'administrator dispute resolution',
]);
const SCOPES = new Set([
  'tasks:read', 'applications:read', 'applications:apply', 'applications:withdraw',
  'tasks:draft:write', 'tasks:publish', 'submissions:write', 'submissions:read',
  'activity:read', 'activity:write', 'payments:read', 'payments:write',
  'files:read', 'files:write', 'products:read', 'products:write', 'products:publish', 'products:purchase',
  'purchases:read', 'purchases:refund', 'services:read', 'services:write',
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
  controller: { network: 'ATTO'; address: string; index: number };
  purpose: string;
  action: Record<string, unknown>;
  challenge: { challengeId: string; message: string; issuedAt: string; expiresAt: string };
}

/** Internal Marketplace owner contract; the standalone CLI remains Atto-only. */
export type MarketplaceUserProofApprovalRequest = Omit<MarketplaceProofApprovalRequest, 'controller'> & {
  controller: { network: 'ATTO' | 'NANO'; address: string; index: number };
};

/** Exact typed validation shared by Marketplace's terminal and native signers. */
export function validateMarketplaceUserProofApproval(input: unknown, options: {
  network: 'ATTO' | 'NANO'; nativeNetwork: string; now?: number; allowExpired?: boolean;
}): MarketplaceUserProofApprovalRequest {
  const request = parseRequest(input, options.network);
  const purposes = new Set(['login', 'API-key creation', 'API-key rotation', 'API-key revocation',
    'link authorizer', 'link new identity', 'unlink', 'browser sign-in grant']);
  const atto = options.network === 'ATTO';
  if (!purposes.has(request.purpose)
    || request.controller.network !== options.network || !Number.isSafeInteger(request.controller.index)
    || request.controller.index < 0 || request.controller.index > (atto ? 0x7fff_ffff : 0xffff_ffff)
    || !(atto ? /^atto:\/\/[a-z2-7]{61}$/.test(request.controller.address)
      : /^nano_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/.test(request.controller.address))
    || !uuid(request.accountId) || !uuid(request.identityId)
    || parseOrigin(request.marketplaceOrigin) !== request.marketplaceOrigin
    || request.transport !== 'AGENT_API' || request.proofOrigin !== null
    || !/^[^\r\n\0]{1,255}$/.test(request.audience) || request.audience.trim() !== request.audience
    || (atto ? options.nativeNetwork !== 'live' : !['nano:mainnet','nano:dev'].includes(options.nativeNetwork))) throw protocolFailure();
  if (request.purpose === 'browser sign-in grant' && (request.marketplaceOrigin !== 'https://api.atto.market'
    || request.audience !== 'urn:marketplace:agent-api:live' || options.nativeNetwork !== (atto ? 'live' : 'nano:mainnet'))) throw protocolFailure();
  if (request.action.kind === 'credential' && record(request.action.command).operation !== request.action.operation) throw protocolFailure();
  const message = parseProofMessage(request, atto ? 'Marketplace Agent Controller Proof v1' : 'Nano Marketplace Agent Controller Proof v1');
  if (message.purpose !== request.purpose || expectedPurpose(request.action) !== request.purpose
    || message.audience !== request.audience || message.address !== request.controller.address
    || message.network !== options.nativeNetwork || message.challengeId !== request.challenge.challengeId
    || message.issuedAt !== request.challenge.issuedAt || message.expiresAt !== request.challenge.expiresAt
    || message.bindingHash !== bindingHash(request, message.network)) throw protocolFailure();
  const issued = millis(request.challenge.issuedAt), expires = millis(request.challenge.expiresAt);
  if (!isProofWindowValid(issued, expires, { now: options.now, allowExpired: options.allowExpired })) {
    throw new AttoError('MARKETPLACE_APPROVAL_EXPIRED', 'The Marketplace approval challenge has expired or is outside its five-minute lifetime. Request a new challenge.');
  }
  return request;
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

export interface MarketplaceProofApprovalPreview {
  profileId: string;
  handoffId: string;
  marketplaceOrigin: string;
  transport: 'AGENT_API' | 'BROWSER';
  proofOrigin: string | null;
  audience: string;
  accountId?: string;
  identityId?: string;
  controller: { network: 'ATTO'; address: string; index: number };
  purpose: string;
  challengeId: string;
  issuedAt: string;
  expiresAt: string;
  action: Record<string, unknown>;
}

export function inspectMarketplaceProofApproval(input: unknown, connection: ProofApprovalConnection | undefined,
  knownAddress: (index: number) => string | undefined): { request: MarketplaceProofApprovalRequest; preview: MarketplaceProofApprovalPreview } {
  const request = parseRequest(input);
  const origin = parseOrigin(request.marketplaceOrigin);
  if (origin !== request.marketplaceOrigin) throw protocolFailure();
  const login = request.purpose === 'login';
  if (request.action.kind === 'identity-link'
    && (![request.action.authorizingAddress, request.action.newIdentityAddress].every(address => typeof address === 'string' && /^atto:\/\/[a-z2-7]{61}$/.test(address)))) throw protocolFailure();
  const newIdentityApproval = request.action.kind === 'identity-link' && request.action.operation === 'NEW_IDENTITY';
  if (!PURPOSES.has(request.purpose) || request.controller.network !== 'ATTO'
    || !Number.isSafeInteger(request.controller.index) || request.controller.index < 0 || request.controller.index > 0x7fff_ffff
    || !/^atto:\/\/[a-z2-7]{61}$/.test(request.controller.address)
    || knownAddress(request.controller.index) !== request.controller.address) {
    throw protocolFailure();
  }

  if (request.transport === 'BROWSER') {
    if (!request.proofOrigin || request.proofOrigin !== request.audience || parseOrigin(request.proofOrigin) !== request.proofOrigin) throw protocolFailure();
    if (connection) {
      if (!browserOriginAllowed(connection, request.proofOrigin)) {
        throw new AttoError('MARKETPLACE_APPROVAL_MISMATCH', 'This browser origin is not provisioned on the connected Marketplace account.');
      }
    } else if (request.proofOrigin !== origin) {
      throw new AttoError('MARKETPLACE_APPROVAL_MISMATCH', 'Cross-origin browser approvals require a locally provisioned Marketplace connection.');
    }
  } else if (request.proofOrigin !== null || !/^[^\r\n\0]{1,255}$/.test(request.audience) || request.audience.trim() !== request.audience) {
    throw protocolFailure();
  }

  if (!login) {
    if (!connection || !uuid(request.accountId) || !uuid(request.identityId)
      || request.accountId !== connection.accountId || request.identityId !== connection.identityId
      || origin !== new URL(connection.apiUrl).origin
      || (!newIdentityApproval && (request.controller.address !== connection.controllerAddress
        || request.controller.index !== connection.controllerIndex))) throw new AttoError('MARKETPLACE_APPROVAL_MISMATCH', 'This approval is for a different connected Marketplace account or controller.');
    if (newIdentityApproval && (request.action.authorizingIdentityId !== connection.identityId
      || request.action.authorizingAddress !== connection.controllerAddress)) {
      throw new AttoError('MARKETPLACE_APPROVAL_MISMATCH', 'A new-controller proof must be paired with the connected account authorizer.');
    }
    if (request.transport === 'AGENT_API' && request.audience !== connection.audience) throw new AttoError('MARKETPLACE_APPROVAL_MISMATCH', 'This approval uses a different Agent API audience.');
  } else if (!uuid(request.accountId) || !uuid(request.identityId)) {
    throw protocolFailure();
  } else if (connection && (origin !== new URL(connection.apiUrl).origin
    || request.accountId !== connection.accountId || request.identityId !== connection.identityId
    || request.controller.address !== connection.controllerAddress || request.controller.index !== connection.controllerIndex
    || (request.transport === 'AGENT_API' && request.audience !== connection.audience))) {
    throw new AttoError('MARKETPLACE_APPROVAL_MISMATCH', 'This login request is for a different connected Marketplace origin.');
  }

  const message = parseProofMessage(request);
  const expected = expectedPurpose(request.action);
  if (message.purpose !== request.purpose || message.audience !== request.audience
    || message.address !== request.controller.address || message.challengeId !== request.challenge.challengeId
    || message.issuedAt !== request.challenge.issuedAt || message.expiresAt !== request.challenge.expiresAt
    || message.network !== 'live' || expected !== request.purpose) throw protocolFailure();
  const issuedAt = millis(request.challenge.issuedAt);
  const expiresAt = millis(request.challenge.expiresAt);
  if (!isProofWindowValid(issuedAt, expiresAt)) {
    throw new AttoError('MARKETPLACE_APPROVAL_EXPIRED', 'The Marketplace approval challenge has expired or is outside its five-minute lifetime. Request a new challenge.');
  }
  const binding = bindingHash(request, message.network);
  if (binding === undefined ? message.bindingHash !== undefined : message.bindingHash !== binding) throw protocolFailure();

  const preview: MarketplaceProofApprovalPreview = {
    profileId: request.profileId, handoffId: request.handoffId, marketplaceOrigin: request.marketplaceOrigin,
    transport: request.transport, proofOrigin: request.proofOrigin, audience: request.audience,
    controller: request.controller as MarketplaceProofApprovalRequest['controller'], purpose: request.purpose, challengeId: request.challenge.challengeId,
    issuedAt: request.challenge.issuedAt, expiresAt: request.challenge.expiresAt, action: request.action,
    ...(request.accountId ? { accountId: request.accountId } : {}),
    ...(request.identityId ? { identityId: request.identityId } : {}),
  };
  return { request: request as MarketplaceProofApprovalRequest, preview };
}

export function approvalRequestDigest(request: MarketplaceUserProofApprovalRequest): string {
  return sha256(canonicalJson(request));
}

export function createMarketplaceProofApprovalResponse(request: MarketplaceUserProofApprovalRequest, signature: string): MarketplaceProofApprovalResponse {
  if (typeof signature !== 'string' || signature.length < 32 || signature.length > 4096 || /[\r\n\0]/.test(signature)) throw protocolFailure();
  return { version: 1, type: 'marketplace-controller-approval-response', profileId: request.profileId,
    handoffId: request.handoffId, requestDigest: approvalRequestDigest(request),
    challengeId: request.challenge.challengeId, message: request.challenge.message, signature,
    controllerAddress: request.controller.address, controllerIndex: request.controller.index };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function parseRequest(input: unknown, network: 'ATTO' | 'NANO' = 'ATTO'): MarketplaceUserProofApprovalRequest {
  const value = record(input);
  if (!onlyKeys(value, ['version','type','profileId','handoffId','marketplaceOrigin','transport','proofOrigin','audience','accountId','identityId','controller','purpose','action','challenge'])
    || value.version !== 1 || value.type !== 'marketplace-controller-approval-request'
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(String(value.profileId))
    || !/^[a-f0-9]{32}$/.test(String(value.handoffId))
    || (value.transport !== 'AGENT_API' && value.transport !== 'BROWSER')
    || typeof value.audience !== 'string' || value.audience.length > 255 || typeof value.purpose !== 'string'
    || !record(value.controller) || !record(value.action) || !record(value.challenge)) throw protocolFailure();
  const controller = value.controller as Record<string, unknown>;
  const action = value.action as Record<string, unknown>;
  const challenge = value.challenge as Record<string, unknown>;
  if (!onlyKeys(controller, ['network','address','index']) || !onlyKeys(challenge, ['challengeId','message','issuedAt','expiresAt'])
    || !validActionKeys(action) || controller.network !== network || typeof controller.address !== 'string' || typeof controller.index !== 'number'
    || typeof challenge.challengeId !== 'string' || !uuid(challenge.challengeId) || typeof challenge.message !== 'string' || challenge.message.length > 4096
    || typeof challenge.issuedAt !== 'string' || typeof challenge.expiresAt !== 'string'
    || !(value.proofOrigin === null || typeof value.proofOrigin === 'string')
    || !(value.accountId === undefined || typeof value.accountId === 'string')
    || !(value.identityId === undefined || typeof value.identityId === 'string')) throw protocolFailure();
  return value as unknown as MarketplaceUserProofApprovalRequest;
}

function parseProofMessage(request: MarketplaceUserProofApprovalRequest, header = 'Marketplace Agent Controller Proof v1') {
  const frame = parseControllerProofFrame(request.challenge.message, header);
  if (!frame) throw protocolFailure();
  return frame;
}

function expectedPurpose(action: Record<string, unknown>): string {
  switch (action.kind) {
    case 'login': return 'login';
    case 'browser-sign-in-grant': return 'browser sign-in grant';
    case 'identity-link': return action.operation === 'AUTHORIZE' ? 'link authorizer'
      : action.operation === 'NEW_IDENTITY' ? 'link new identity' : '';
    case 'identity-unlink': return 'unlink';
    case 'credential': return ({ CREATE: 'API-key creation', ROTATE: 'API-key rotation', REVOKE: 'API-key revocation' } as Record<string, string>)[String(action.operation)] ?? '';
    case 'adminModeration': return 'administrator public moderation';
    case 'adminTaskClose': return 'administrator task cancellation or expiry';
    case 'adminDisputeOpen': return 'administrator dispute opening';
    case 'adminDisputeResolution': return 'administrator dispute resolution';
    default: return '';
  }
}

function validActionKeys(action: Record<string, unknown>): boolean {
  if (action.kind === 'browser-sign-in-grant') return onlyKeys(action, ['kind','browserOrigin','grantHash']);
  if (action.kind === 'login') return onlyKeys(action, ['kind','network','address']);
  if (action.kind === 'identity-link') return onlyKeys(action,
    ['kind','operation','linkId','authorizingIdentityId','authorizingAddress','newIdentityAddress','authorizingNetworkId','newIdentityNetworkId']);
  if (action.kind === 'identity-unlink') return onlyKeys(action,
    ['kind','targetIdentityId','authorizingIdentityId']);
  if (action.kind === 'credential') {
    if (!onlyKeys(action, ['kind','operation','command'])) return false;
    const command = record(action.command);
    if (!onlyKeys(command, ['operation','idempotencyKey','targetApiKeyId','credential'])) return false;
    if (command.credential === undefined) return true;
    return onlyKeys(record(command.credential), ['name','expiresInDays','scopes','publishAttoLimit','publishXnoLimit',
      'purchaseAttoLimit','purchaseXnoLimit','productPublishAttoLimit','productPublishXnoLimit']);
  }
  if (action.kind === 'adminModeration') return onlyKeys(action,
    ['kind','targetKind','action','targetId','expectedTargetVersion','expectedModerationVersion','reason','idempotencyKey']);
  if (action.kind === 'adminTaskClose') return onlyKeys(action,
    ['kind','taskId','action','expectedVersion','reason','idempotencyKey']);
  if (action.kind === 'adminDisputeOpen') return onlyKeys(action,
    ['kind','taskId','expectedEngagementVersion','representedAgentId','reason','statement','evidenceUrls','auditReason','idempotencyKey']);
  if (action.kind === 'adminDisputeResolution') return onlyKeys(action,
    ['kind','disputeId','expectedDisputeVersion','outcome','rationale','idempotencyKey']);
  return false;
}

function bindingHash(request: MarketplaceUserProofApprovalRequest, signerNetworkId: string): string | undefined {
  const action = request.action;
  if (action.kind === 'login') {
    if (action.network !== request.controller.network || action.address !== request.controller.address
      || !uuid(request.accountId) || !uuid(request.identityId)) throw protocolFailure();
    return sha256(['marketplace-login-v1', request.accountId!, request.identityId!].join('\n'));
  }
  if (!request.accountId || !request.identityId) throw protocolFailure();
  if (action.kind === 'browser-sign-in-grant') {
    if (action.browserOrigin !== 'https://atto.market' || typeof action.grantHash !== 'string'
      || !/^[0-9a-f]{64}$/.test(action.grantHash)) throw protocolFailure();
    return sha256(['marketplace-browser-sign-in-grant-v1', request.accountId, request.identityId, action.browserOrigin, action.grantHash].join('\n'));
  }
  if (action.kind === 'identity-link') {
    const operation = action.operation;
    const linkId = uuid(action.linkId);
    const authorizingIdentityId = uuid(action.authorizingIdentityId);
    const authorizingAddress = action.authorizingAddress;
    const newIdentityAddress = action.newIdentityAddress;
    if (!['AUTHORIZE','NEW_IDENTITY'].includes(String(operation)) || !linkId
      || !authorizingIdentityId || authorizingIdentityId !== request.identityId
      || (action.authorizingNetworkId === undefined) !== (action.newIdentityNetworkId === undefined)
      || authorizingAddress === newIdentityAddress
      || (operation === 'AUTHORIZE' && request.controller.address !== authorizingAddress)
      || (operation === 'NEW_IDENTITY' && request.controller.address !== newIdentityAddress)) throw protocolFailure();
    const authorizerNetwork = linkNetwork(authorizingAddress, action.authorizingNetworkId);
    const targetNetwork = linkNetwork(newIdentityAddress, action.newIdentityNetworkId);
    const signerNetwork = operation === 'AUTHORIZE' ? authorizerNetwork : targetNetwork;
    if (signerNetwork !== (request.controller.network === 'ATTO' ? `atto:${signerNetworkId}` : signerNetworkId)) throw protocolFailure();
    return sha256([request.accountId, linkId, `${authorizerNetwork}:${authorizingAddress}`,
      `${targetNetwork}:${newIdentityAddress}`].join('\n'));
  }
  if (action.kind === 'identity-unlink') {
    const targetIdentityId = uuid(action.targetIdentityId);
    const authorizingIdentityId = uuid(action.authorizingIdentityId);
    if (!targetIdentityId || !authorizingIdentityId || authorizingIdentityId !== request.identityId
      || targetIdentityId === authorizingIdentityId) throw protocolFailure();
    return sha256(`unlink\n${request.accountId}\n${targetIdentityId}\n${authorizingIdentityId}`);
  }
  if (action.kind === 'credential') {
    const command = record(action.command);
    const operation = String(command.operation);
    const key = uuid(command.idempotencyKey);
    const target = command.targetApiKeyId === undefined ? '' : uuid(command.targetApiKeyId);
    if (!key || target === false || (operation === 'CREATE') !== (command.credential !== undefined)
      || (operation === 'CREATE') !== (target === '')) throw protocolFailure();
    let payload = '';
    if (operation === 'CREATE') {
      const credential = record(command.credential);
      const name = typeof credential.name === 'string' ? javaTrim(credential.name) : '';
      const expiresInDays = credential.expiresInDays;
      const scopes = credential.scopes;
      if (!name || name.length > 64 || /[\x00-\x1f\x7f]/.test(name)
        || typeof expiresInDays !== 'number' || !Number.isSafeInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365
        || !Array.isArray(scopes) || scopes.length === 0 || scopes.some(scope => typeof scope !== 'string' || !SCOPES.has(scope))
        || new Set(scopes).size !== scopes.length) throw protocolFailure();
      const publishAttoLimit = atomicOrEmpty(credential.publishAttoLimit);
      const publishXnoLimit = atomicOrEmpty(credential.publishXnoLimit);
      const purchaseAttoLimit = atomicOrEmpty(credential.purchaseAttoLimit);
      const purchaseXnoLimit = atomicOrEmpty(credential.purchaseXnoLimit);
      const productPublishAttoLimit = atomicOrEmpty(credential.productPublishAttoLimit);
      const productPublishXnoLimit = atomicOrEmpty(credential.productPublishXnoLimit);
      if ((scopes.includes('tasks:publish')) !== Boolean(publishAttoLimit || publishXnoLimit)
        || (scopes.includes('products:purchase')) !== Boolean(purchaseAttoLimit || purchaseXnoLimit)
        || (Boolean(productPublishAttoLimit || productPublishXnoLimit) && !scopes.includes('products:publish'))) throw protocolFailure();
      payload = ['marketplace-credential-v1',name,String(expiresInDays),[...scopes].sort().join(','),publishAttoLimit,publishXnoLimit,
        purchaseAttoLimit,purchaseXnoLimit,productPublishAttoLimit,productPublishXnoLimit].join('\n');
    }
    return sha256(['agent-credential-v1', request.accountId, request.identityId, operation,
      target || '', key, payload].join('\n'));
  }
  if (action.kind === 'adminModeration') {
    const targetKind = action.targetKind;
    const operation = action.action;
    const targetId = uuid(action.targetId);
    const targetVersion = safeVersion(action.expectedTargetVersion);
    const moderationVersion = safeVersion(action.expectedModerationVersion);
    const reason = boundedAsciiSpaceReason(action.reason, 1_000);
    const key = uuid(action.idempotencyKey);
    if ((targetKind !== 'TASK' && targetKind !== 'PROFILE')
      || !['HIDE','RESTORE','SUSPEND'].includes(String(operation))
      || (targetKind === 'TASK' && operation === 'SUSPEND')
      || !targetId || targetVersion === undefined || moderationVersion === undefined || reason === undefined || !key) {
      throw protocolFailure();
    }
    return lengthPrefixedSha256(['marketplace-admin-public-moderation-v1', request.accountId,
      request.identityId, targetKind, targetId, String(operation), String(targetVersion),
      String(moderationVersion), reason, key]);
  }
  if (action.kind === 'adminTaskClose') {
    const taskId = uuid(action.taskId);
    const operation = action.action;
    const version = safeVersion(action.expectedVersion);
    const reason = boundedAsciiSpaceReason(action.reason, 1_000);
    const key = uuid(action.idempotencyKey);
    if (!taskId || (operation !== 'CANCEL' && operation !== 'EXPIRE')
      || version === undefined || reason === undefined || !key) throw protocolFailure();
    return lengthPrefixedSha256(['marketplace-admin-task-close-v1', request.accountId, request.identityId,
      taskId, operation, String(version), reason, key]);
  }
  if (action.kind === 'adminDisputeOpen') {
    const taskId = uuid(action.taskId);
    const engagementVersion = safeVersion(action.expectedEngagementVersion);
    const representedAgentId = uuid(action.representedAgentId);
    const reason = action.reason;
    const key = uuid(action.idempotencyKey);
    const statement = boundedDisputeText(action.statement);
    const auditReason = boundedDisputeText(action.auditReason);
    const evidence = normalizeEvidenceUrls(action.evidenceUrls);
    if (!taskId || engagementVersion === undefined || !representedAgentId
      || (reason !== 'NON_DELIVERY' && reason !== 'DELIVERABLE_MISMATCH' && reason !== 'OTHER')
      || !key || statement === undefined || auditReason === undefined || evidence === undefined) throw protocolFailure();
    return lengthPrefixedSha256(['dispute-admin-open-v1', request.accountId, request.identityId, taskId,
      String(engagementVersion), representedAgentId, reason, key, statement, auditReason, ...evidence]);
  }
  if (action.kind === 'adminDisputeResolution') {
    const disputeId = uuid(action.disputeId);
    const version = safeVersion(action.expectedDisputeVersion);
    const outcome = action.outcome;
    const rationale = boundedDisputeText(action.rationale);
    const key = uuid(action.idempotencyKey);
    if (!disputeId || version === undefined || (outcome !== 'WORKER_SUPPORTED' && outcome !== 'BUYER_SUPPORTED')
      || rationale === undefined || !key) throw protocolFailure();
    return lengthPrefixedSha256(['dispute-admin-resolve-v1', request.accountId, request.identityId,
      disputeId, String(version), outcome, rationale, key]);
  }
  throw protocolFailure();
}

function browserOriginAllowed(connection: ProofApprovalConnection, proofOrigin: string): boolean {
  const apiOrigin = new URL(connection.apiUrl).origin;
  const allowed = connection.browserOrigins ?? [apiOrigin];
  return allowed.includes(proofOrigin);
}

function safeVersion(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseOrigin(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw protocolFailure(); }
  const loopback = ['localhost','127.0.0.1','[::1]'].includes(parsed.hostname.toLowerCase());
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash
    || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))) throw protocolFailure();
  return parsed.origin;
}

function atomicOrEmpty(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,64}$/.test(value)) throw protocolFailure();
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw protocolFailure();
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function uuid(value: unknown): string | false {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) ? value : false;
}

function millis(value: string): number {
  const result = Date.parse(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw protocolFailure();
  return result;
}

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function protocolFailure(): AttoError { return new AttoError('MARKETPLACE_APPROVAL_PROTOCOL', 'This typed Marketplace wallet-approval request is invalid. Request a fresh approval file from Marketplace.'); }

function linkNetwork(address: unknown, networkId: unknown): string {
  if (typeof address === 'string') {
    if (/^atto:\/\/[a-z2-7]{61}$/.test(address) && (networkId === undefined || networkId === 'live')) return 'atto:live';
    if (/^nano_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/.test(address)) {
      // Older envelopes predate explicit network IDs and bind Nano mainnet.
      if (networkId === undefined || networkId === 'nano:mainnet') return 'nano:mainnet';
      if (networkId === 'nano:dev') return networkId;
    }
  }
  throw protocolFailure();
}
