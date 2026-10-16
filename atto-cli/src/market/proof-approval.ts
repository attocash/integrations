import { createHash } from 'node:crypto';
import { AttoError } from '../domain/errors.js';
import type { MarketConnection } from './topups.js';

const PURPOSES = new Set([
  'login', 'API-key creation', 'API-key rotation', 'API-key revocation',
  'link authorizer', 'link new identity', 'unlink',
  'payout address enrollment', 'payout address selection', 'payout address disablement',
  'withdrawal creation', 'administrator public moderation', 'administrator job cancellation or expiry',
  'administrator dispute opening', 'administrator dispute resolution',
]);
const SCOPES = new Set([
  'jobs:read', 'applications:read', 'applications:apply', 'applications:withdraw',
  'jobs:draft:write', 'jobs:publish', 'submissions:write', 'submissions:read',
  'activity:read', 'activity:write', 'balances:read',
  'files:read', 'files:write', 'products:read', 'products:write', 'products:publish', 'products:purchase',
  'purchases:read', 'purchases:refund',
]);
const SHOP_SCOPES = new Set([
  'files:read', 'files:write', 'products:read', 'products:write', 'products:publish', 'products:purchase',
  'purchases:read', 'purchases:refund',
]);

export interface MarketProofApprovalRequest {
  version: 1;
  type: 'atto-market-controller-approval-request';
  profileId: string;
  handoffId: string;
  marketOrigin: string;
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

export interface MarketProofApprovalResponse {
  version: 1;
  type: 'atto-market-controller-approval-response';
  profileId: string;
  handoffId: string;
  requestDigest: string;
  challengeId: string;
  message: string;
  signature: string;
  controllerAddress: string;
  controllerIndex: number;
}

export interface MarketProofApprovalPreview {
  profileId: string;
  handoffId: string;
  marketOrigin: string;
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

export function inspectMarketProofApproval(input: unknown, connection: MarketConnection | undefined,
  knownAddress: (index: number) => string | undefined): { request: MarketProofApprovalRequest; preview: MarketProofApprovalPreview } {
  const request = parseRequest(input);
  const origin = parseOrigin(request.marketOrigin);
  if (origin !== request.marketOrigin) throw protocolFailure();
  const login = request.purpose === 'login';
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
        throw new AttoError('MARKET_APPROVAL_MISMATCH', 'This browser origin is not provisioned on the connected Market account.');
      }
    } else if (request.proofOrigin !== origin) {
      throw new AttoError('MARKET_APPROVAL_MISMATCH', 'Cross-origin browser approvals require a locally provisioned Market connection.');
    }
  } else if (request.proofOrigin !== null || !/^[^\r\n\0]{1,255}$/.test(request.audience) || request.audience.trim() !== request.audience) {
    throw protocolFailure();
  }

  if (!login) {
    if (!connection || !uuid(request.accountId) || !uuid(request.identityId)
      || request.accountId !== connection.accountId || request.identityId !== connection.identityId
      || origin !== new URL(connection.apiUrl).origin
      || (!newIdentityApproval && (request.controller.address !== connection.controllerAddress
        || request.controller.index !== connection.controllerIndex))) throw new AttoError('MARKET_APPROVAL_MISMATCH', 'This approval is for a different connected Market account or controller.');
    if (newIdentityApproval && (request.action.authorizingIdentityId !== connection.identityId
      || request.action.authorizingAddress !== connection.controllerAddress)) {
      throw new AttoError('MARKET_APPROVAL_MISMATCH', 'A new-controller proof must be paired with the connected account authorizer.');
    }
    if (request.transport === 'AGENT_API' && request.audience !== connection.audience) throw new AttoError('MARKET_APPROVAL_MISMATCH', 'This approval uses a different Agent API audience.');
  } else if (request.accountId !== undefined || request.identityId !== undefined) {
    throw protocolFailure();
  } else if (connection && origin !== new URL(connection.apiUrl).origin) {
    throw new AttoError('MARKET_APPROVAL_MISMATCH', 'This login request is for a different connected Market origin.');
  }

  const message = parseProofMessage(request);
  const expected = expectedPurpose(request.action);
  if (message.purpose !== request.purpose || message.audience !== request.audience
    || message.address !== request.controller.address || message.challengeId !== request.challenge.challengeId
    || message.issuedAt !== request.challenge.issuedAt || message.expiresAt !== request.challenge.expiresAt
    || message.network !== 'live' || expected !== request.purpose) throw protocolFailure();
  const issuedAt = millis(request.challenge.issuedAt);
  const expiresAt = millis(request.challenge.expiresAt);
  const now = Date.now();
  if (issuedAt > now + 30_000 || expiresAt <= now || expiresAt <= issuedAt || expiresAt - issuedAt > 300_000) {
    throw new AttoError('MARKET_APPROVAL_EXPIRED', 'The Market approval challenge has expired or is outside its five-minute lifetime. Request a new challenge.');
  }
  const binding = bindingHash(request);
  if (binding === undefined ? message.bindingHash !== undefined : message.bindingHash !== binding) throw protocolFailure();

  const preview: MarketProofApprovalPreview = {
    profileId: request.profileId, handoffId: request.handoffId, marketOrigin: request.marketOrigin,
    transport: request.transport, proofOrigin: request.proofOrigin, audience: request.audience,
    controller: request.controller, purpose: request.purpose, challengeId: request.challenge.challengeId,
    issuedAt: request.challenge.issuedAt, expiresAt: request.challenge.expiresAt, action: request.action,
    ...(request.accountId ? { accountId: request.accountId } : {}),
    ...(request.identityId ? { identityId: request.identityId } : {}),
  };
  return { request, preview };
}

export function approvalRequestDigest(request: MarketProofApprovalRequest): string {
  return sha256(canonicalJson(request));
}

export function createMarketProofApprovalResponse(request: MarketProofApprovalRequest, signature: string): MarketProofApprovalResponse {
  if (typeof signature !== 'string' || signature.length < 32 || signature.length > 4096 || /[\r\n\0]/.test(signature)) throw protocolFailure();
  return { version: 1, type: 'atto-market-controller-approval-response', profileId: request.profileId,
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

function parseRequest(input: unknown): MarketProofApprovalRequest {
  const value = record(input);
  if (!onlyKeys(value, ['version','type','profileId','handoffId','marketOrigin','transport','proofOrigin','audience','accountId','identityId','controller','purpose','action','challenge'])
    || value.version !== 1 || value.type !== 'atto-market-controller-approval-request'
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(String(value.profileId))
    || !/^[a-f0-9]{32}$/.test(String(value.handoffId))
    || (value.transport !== 'AGENT_API' && value.transport !== 'BROWSER')
    || typeof value.audience !== 'string' || value.audience.length > 255 || typeof value.purpose !== 'string'
    || !record(value.controller) || !record(value.action) || !record(value.challenge)) throw protocolFailure();
  const controller = value.controller as Record<string, unknown>;
  const action = value.action as Record<string, unknown>;
  const challenge = value.challenge as Record<string, unknown>;
  if (!onlyKeys(controller, ['network','address','index']) || !onlyKeys(challenge, ['challengeId','message','issuedAt','expiresAt'])
    || !validActionKeys(action) || controller.network !== 'ATTO' || typeof controller.address !== 'string' || typeof controller.index !== 'number'
    || typeof challenge.challengeId !== 'string' || !uuid(challenge.challengeId) || typeof challenge.message !== 'string' || challenge.message.length > 4096
    || typeof challenge.issuedAt !== 'string' || typeof challenge.expiresAt !== 'string'
    || !(value.proofOrigin === null || typeof value.proofOrigin === 'string')
    || !(value.accountId === undefined || typeof value.accountId === 'string')
    || !(value.identityId === undefined || typeof value.identityId === 'string')) throw protocolFailure();
  return value as unknown as MarketProofApprovalRequest;
}

function parseProofMessage(request: MarketProofApprovalRequest): { audience: string; network: string; address: string; purpose: string; challengeId: string; bindingHash?: string; issuedAt: string; expiresAt: string } {
  const lines = request.challenge.message.split('\n');
  if (lines.length !== 9 && lines.length !== 10) throw protocolFailure();
  if (lines[0] !== 'Atto Market Agent Controller Proof v1' || !lines[1]?.startsWith('Audience: ')
    || !lines[2]?.startsWith('Network: ') || !lines[3]?.startsWith('Address: ')
    || !lines[4]?.startsWith('Purpose: ') || !lines[5]?.startsWith('Request ID: ')) throw protocolFailure();
  const hasBinding = lines[6]?.startsWith('Binding Hash: ') === true;
  const nonceIndex = hasBinding ? 7 : 6;
  if ((hasBinding && lines.length !== 10) || (!hasBinding && lines.length !== 9)
    || !/^Nonce: [0-9a-f]{64}$/.test(lines[nonceIndex] ?? '')
    || !lines[nonceIndex + 1]?.startsWith('Issued At: ')
    || !lines[nonceIndex + 2]?.startsWith('Expiration Time: ')) throw protocolFailure();
  const bindingHash = hasBinding ? lines[6]!.slice('Binding Hash: '.length) : undefined;
  if (bindingHash !== undefined && !/^[0-9a-f]{64}$/.test(bindingHash)) throw protocolFailure();
  return {
    audience: lines[1]!.slice('Audience: '.length), network: lines[2]!.slice('Network: '.length),
    address: lines[3]!.slice('Address: '.length), purpose: lines[4]!.slice('Purpose: '.length),
    challengeId: lines[5]!.slice('Request ID: '.length), ...(bindingHash ? { bindingHash } : {}),
    issuedAt: lines[nonceIndex + 1]!.slice('Issued At: '.length),
    expiresAt: lines[nonceIndex + 2]!.slice('Expiration Time: '.length),
  };
}

function expectedPurpose(action: Record<string, unknown>): string {
  switch (action.kind) {
    case 'login': return 'login';
    case 'identity-link': return action.operation === 'AUTHORIZE' ? 'link authorizer'
      : action.operation === 'NEW_IDENTITY' ? 'link new identity' : '';
    case 'identity-unlink': return 'unlink';
    case 'credential': return ({ CREATE: 'API-key creation', ROTATE: 'API-key rotation', REVOKE: 'API-key revocation' } as Record<string, string>)[String(action.operation)] ?? '';
    case 'payout-address': return ({ ENROLL: 'payout address enrollment', SELECT: 'payout address selection', DISABLE: 'payout address disablement' } as Record<string, string>)[String(record(action.command).action)] ?? '';
    case 'withdrawal': return 'withdrawal creation';
    case 'adminModeration': return 'administrator public moderation';
    case 'adminJobClose': return 'administrator job cancellation or expiry';
    case 'adminDisputeOpen': return 'administrator dispute opening';
    case 'adminDisputeResolution': return 'administrator dispute resolution';
    default: return '';
  }
}

function validActionKeys(action: Record<string, unknown>): boolean {
  if (action.kind === 'login') return onlyKeys(action, ['kind','network','address']);
  if (action.kind === 'identity-link') return onlyKeys(action,
    ['kind','operation','linkId','authorizingIdentityId','authorizingAddress','newIdentityAddress']);
  if (action.kind === 'identity-unlink') return onlyKeys(action,
    ['kind','targetIdentityId','authorizingIdentityId']);
  if (action.kind === 'credential') {
    if (!onlyKeys(action, ['kind','operation','command'])) return false;
    const command = record(action.command);
    if (!onlyKeys(command, ['operation','idempotencyKey','targetApiKeyId','credential'])) return false;
    if (command.credential === undefined) return true;
    return onlyKeys(record(command.credential), ['name','expiresInDays','scopes','publishAttoLimit','publishXnoLimit',
      'applyAttoLimit','applyXnoLimit','purchaseAttoLimit','purchaseXnoLimit']);
  }
  if (action.kind === 'payout-address') {
    return onlyKeys(action, ['kind','command','network','canonicalTargetAddress'])
      && onlyKeys(record(action.command), ['action','asset','idempotencyKey','address','destinationId','expectedSelectionVersion','network']);
  }
  if (action.kind === 'withdrawal') {
    return onlyKeys(action, ['kind','command','network','destinationAddress'])
      && onlyKeys(record(action.command), ['asset','atomicAmount','destinationId','expectedSelectionVersion','idempotencyKey','network']);
  }
  if (action.kind === 'adminModeration') return onlyKeys(action,
    ['kind','targetKind','action','targetId','expectedTargetVersion','expectedModerationVersion','reason','idempotencyKey']);
  if (action.kind === 'adminJobClose') return onlyKeys(action,
    ['kind','jobId','action','expectedVersion','reason','idempotencyKey']);
  if (action.kind === 'adminDisputeOpen') return onlyKeys(action,
    ['kind','jobId','expectedEngagementVersion','representedAgentId','reason','statement','evidenceUrls','auditReason','idempotencyKey']);
  if (action.kind === 'adminDisputeResolution') return onlyKeys(action,
    ['kind','disputeId','expectedDisputeVersion','outcome','rationale','idempotencyKey']);
  return false;
}

function bindingHash(request: MarketProofApprovalRequest): string | undefined {
  const action = request.action;
  if (action.kind === 'login') {
    if (action.network !== 'ATTO' || action.address !== request.controller.address) throw protocolFailure();
    return undefined;
  }
  if (!request.accountId || !request.identityId) throw protocolFailure();
  if (action.kind === 'identity-link') {
    const operation = action.operation;
    const linkId = uuid(action.linkId);
    const authorizingIdentityId = uuid(action.authorizingIdentityId);
    const authorizingAddress = action.authorizingAddress;
    const newIdentityAddress = action.newIdentityAddress;
    if (!['AUTHORIZE','NEW_IDENTITY'].includes(String(operation)) || !linkId
      || !authorizingIdentityId || authorizingIdentityId !== request.identityId
      || typeof authorizingAddress !== 'string' || !/^atto:\/\/[a-z2-7]{61}$/.test(authorizingAddress)
      || typeof newIdentityAddress !== 'string' || !/^atto:\/\/[a-z2-7]{61}$/.test(newIdentityAddress)
      || authorizingAddress === newIdentityAddress
      || (operation === 'AUTHORIZE' && request.controller.address !== authorizingAddress)
      || (operation === 'NEW_IDENTITY' && request.controller.address !== newIdentityAddress)) throw protocolFailure();
    return sha256([request.accountId, linkId, `atto:live:${authorizingAddress}`,
      `atto:live:${newIdentityAddress}`].join('\n'));
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
      const applyAttoLimit = atomicOrEmpty(credential.applyAttoLimit);
      const applyXnoLimit = atomicOrEmpty(credential.applyXnoLimit);
      const purchaseAttoLimit = atomicOrEmpty(credential.purchaseAttoLimit);
      const purchaseXnoLimit = atomicOrEmpty(credential.purchaseXnoLimit);
      if ((scopes.includes('jobs:publish')) !== Boolean(publishAttoLimit || publishXnoLimit)
        || (scopes.includes('applications:apply')) !== Boolean(applyAttoLimit || applyXnoLimit)
        || (scopes.includes('products:purchase')) !== Boolean(purchaseAttoLimit || purchaseXnoLimit)) throw protocolFailure();
      const orderedFields = [name, String(expiresInDays), [...scopes].sort().join(','), publishAttoLimit, publishXnoLimit, applyAttoLimit];
      payload = scopes.some(scope => SHOP_SCOPES.has(scope))
        ? ['agent-credential-v3', ...orderedFields, applyXnoLimit, purchaseAttoLimit, purchaseXnoLimit].join('\n')
        : ['agent-credential-v2', ...orderedFields, applyXnoLimit].join('\n');
    }
    return sha256(['agent-credential-v1', request.accountId, request.identityId, operation,
      target || '', key, payload].join('\n'));
  }
  if (action.kind === 'payout-address') {
    const command = record(action.command);
    const actionName = String(command.action);
    const asset = String(command.asset);
    const key = uuid(command.idempotencyKey);
    const destinationId = command.destinationId === undefined ? '' : uuid(command.destinationId);
    const version = command.expectedSelectionVersion;
    const network = action.network;
    const address = action.canonicalTargetAddress;
    if (!['ENROLL','SELECT','DISABLE'].includes(actionName) || !['ATTO','XNO'].includes(asset) || !key
      || destinationId === false || typeof network !== 'string' || typeof address !== 'string' || !address
      || (command.network !== undefined && command.network !== network)
      || !(version === undefined || (typeof version === 'number' && Number.isSafeInteger(version) && version >= 0))
      || (actionName === 'ENROLL') !== (typeof command.address === 'string')
      || (actionName === 'ENROLL') !== (destinationId === '')) throw protocolFailure();
    return sha256(['payout-address-v1', request.accountId, request.identityId, actionName, asset,
      network, destinationId || '', address, version === undefined ? '' : String(version), key].join('\n'));
  }
  if (action.kind === 'withdrawal') {
    const command = record(action.command);
    const asset = String(command.asset);
    const amount = command.atomicAmount;
    const destinationId = uuid(command.destinationId);
    const key = uuid(command.idempotencyKey);
    const version = command.expectedSelectionVersion;
    const network = action.network;
    const address = action.destinationAddress;
    if (!['ATTO','XNO'].includes(asset) || typeof amount !== 'string' || !/^[1-9][0-9]{0,64}$/.test(amount)
      || !destinationId || !key || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0
      || typeof network !== 'string' || typeof address !== 'string' || !address
      || (command.network !== undefined && command.network !== network)) throw protocolFailure();
    return sha256(['withdrawal-create-v2', request.accountId, request.identityId, asset, amount,
      network, destinationId, address, String(version), key].join('\n'));
  }
  if (action.kind === 'adminModeration') {
    const targetKind = action.targetKind;
    const operation = action.action;
    const targetId = uuid(action.targetId);
    const targetVersion = safeVersion(action.expectedTargetVersion);
    const moderationVersion = safeVersion(action.expectedModerationVersion);
    const reason = boundedAsciiSpaceReason(action.reason, 1_000);
    const key = uuid(action.idempotencyKey);
    if ((targetKind !== 'JOB' && targetKind !== 'PROFILE')
      || !['HIDE','RESTORE','SUSPEND'].includes(String(operation))
      || (targetKind === 'JOB' && operation === 'SUSPEND')
      || !targetId || targetVersion === undefined || moderationVersion === undefined || reason === undefined || !key) {
      throw protocolFailure();
    }
    return lengthPrefixedSha256(['market-admin-public-moderation-v1', request.accountId,
      request.identityId, targetKind, targetId, String(operation), String(targetVersion),
      String(moderationVersion), reason, key]);
  }
  if (action.kind === 'adminJobClose') {
    const jobId = uuid(action.jobId);
    const operation = action.action;
    const version = safeVersion(action.expectedVersion);
    const reason = boundedAsciiSpaceReason(action.reason, 1_000);
    const key = uuid(action.idempotencyKey);
    if (!jobId || (operation !== 'CANCEL' && operation !== 'EXPIRE')
      || version === undefined || reason === undefined || !key) throw protocolFailure();
    return lengthPrefixedSha256(['market-admin-job-close-v1', request.accountId, request.identityId,
      jobId, operation, String(version), reason, key]);
  }
  if (action.kind === 'adminDisputeOpen') {
    const jobId = uuid(action.jobId);
    const engagementVersion = safeVersion(action.expectedEngagementVersion);
    const representedAgentId = uuid(action.representedAgentId);
    const reason = action.reason;
    const key = uuid(action.idempotencyKey);
    const statement = boundedDisputeText(action.statement);
    const auditReason = boundedDisputeText(action.auditReason);
    const evidence = canonicalEvidenceUrls(action.evidenceUrls);
    if (!jobId || engagementVersion === undefined || !representedAgentId
      || (reason !== 'NON_DELIVERY' && reason !== 'DELIVERABLE_MISMATCH' && reason !== 'OTHER')
      || !key || statement === undefined || auditReason === undefined || evidence === undefined) throw protocolFailure();
    return lengthPrefixedSha256(['dispute-admin-open-v1', request.accountId, request.identityId, jobId,
      String(engagementVersion), representedAgentId, reason, key, statement, auditReason, ...evidence]);
  }
  if (action.kind === 'adminDisputeResolution') {
    const disputeId = uuid(action.disputeId);
    const version = safeVersion(action.expectedDisputeVersion);
    const outcome = action.outcome;
    const rationale = boundedDisputeText(action.rationale);
    const key = uuid(action.idempotencyKey);
    if (!disputeId || version === undefined || (outcome !== 'WORKER_AWARD' && outcome !== 'BUYER_REFUND')
      || rationale === undefined || !key) throw protocolFailure();
    return lengthPrefixedSha256(['dispute-admin-resolve-v1', request.accountId, request.identityId,
      disputeId, String(version), outcome, rationale, key]);
  }
  throw protocolFailure();
}

function browserOriginAllowed(connection: MarketConnection, proofOrigin: string): boolean {
  const apiOrigin = new URL(connection.apiUrl).origin;
  const allowed = connection.browserOrigins ?? [apiOrigin];
  return allowed.includes(proofOrigin);
}

function safeVersion(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function boundedAsciiSpaceReason(value: unknown, maximumCodePoints: number): string | undefined {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const normalized = value.replace(/^ +| +$/g, '');
  return [...normalized].length >= 1 && [...normalized].length <= maximumCodePoints ? normalized : undefined;
}

function boundedDisputeText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.includes('\0')) return undefined;
  const normalized = normalizeDisputeText(value);
  return [...normalized].length >= 1 && [...normalized].length <= 2_000 ? normalized : undefined;
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

function canonicalEvidenceUrls(value: unknown): string[] | undefined {
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

export function normalizeEvidenceUrls(value: unknown): string[] | undefined {
  return canonicalEvidenceUrls(value);
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
    || ['localhost','local','internal','test','invalid'].includes(labels.at(-1)!)
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

function lengthPrefixedSha256(fields: string[]): string {
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

function javaTrim(value: string): string { return value.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, ''); }
function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function protocolFailure(): AttoError { return new AttoError('MARKET_APPROVAL_PROTOCOL', 'This typed Market wallet-approval request is invalid. Request a fresh approval file from Market.'); }
