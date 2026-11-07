import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { MarketplaceTopUpClient } from '../dist/marketplace/topups.js';
import { formatMarketplaceApprovalPreview } from '../dist/cli/cli.js';

const apiOrigin = 'http://localhost:8080';
const browserOrigin = 'http://localhost:5173';
const accountId = '00000000-0000-4000-8000-000000000100';
const identityId = '00000000-0000-4000-8000-000000000101';
const linkId = '00000000-0000-4000-8000-000000000102';
const authorizingAddress = `atto://${'a'.repeat(61)}`;
const newIdentityAddress = `atto://${'b'.repeat(61)}`;
const taskId = '00000000-0000-4000-8000-000000000200';
const idempotencyKey = '00000000-0000-4000-8000-000000000201';

function createClient(browserOrigins = [browserOrigin]) {
  const connection = {
    version: 1,
    apiUrl: `${apiOrigin}/v1/agent/topups`,
    audience: 'marketplace-agent',
    controllerIndex: 0,
    controllerAddress: authorizingAddress,
    accountId,
    agentId: '00000000-0000-4000-8000-000000000103',
    identityId,
    walletFingerprint: 'fingerprint',
    ...(browserOrigins === null ? {} : { browserOrigins }),
  };
  const saved = new Map([
    ['identity', { address: authorizingAddress, fingerprint: 'fingerprint' }],
    ['marketplace.topups.connection', connection],
  ]);
  const addresses = [
    { index: 0, address: authorizingAddress, publicKey: '00', active: true },
    { index: 1, address: newIdentityAddress, publicKey: '01', active: true },
  ];
  return new MarketplaceTopUpClient({ get: key => saved.get(key), set: (key, value) => saved.set(key, value) }, {
    settings: () => ({ network: 'LOCAL' }),
    addresses: () => addresses,
    seed: async () => { throw new Error('inspect must not access wallet key material'); },
    mcp: false,
  });
}

function sha256(text) { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function lengthPrefixed(fields) {
  const hash = createHash('sha256');
  for (const field of fields) {
    const bytes = Buffer.from(field, 'utf8');
    const size = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    hash.update(size);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function request({ action, purpose, address = authorizingAddress, index = 0, binding,
  marketplace = apiOrigin, proof = browserOrigin, audience = proof, account = accountId, identity = identityId }) {
  const challengeId = '00000000-0000-4000-8000-000000000301';
  const issuedAt = new Date(Date.now() - 1000).toISOString();
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  binding ??= purpose === 'login' ? sha256(['signer-controller-enrollment-v1', account, identity].join('\n')) : undefined;
  const lines = [
    'Marketplace Agent Controller Proof v1', `Audience: ${audience}`, 'Network: live',
    `Address: ${address}`, `Purpose: ${purpose}`, `Request ID: ${challengeId}`,
    ...(binding ? [`Binding Hash: ${binding}`] : []), `Nonce: ${'cd'.repeat(32)}`,
    `Issued At: ${issuedAt}`, `Expiration Time: ${expiresAt}`,
  ];
  return {
    version: 1,
    type: 'marketplace-controller-approval-request',
    profileId: 'marketplace-browser',
    handoffId: 'e'.repeat(32),
    marketplaceOrigin: marketplace,
    transport: 'BROWSER',
    proofOrigin: proof,
    audience,
    ...(account ? { accountId: account } : {}),
    ...(identity ? { identityId: identity } : {}),
    controller: { network: 'ATTO', address, index },
    purpose,
    action,
    challenge: { challengeId, message: lines.join('\n'), issuedAt, expiresAt },
  };
}

test('a provisioned browser origin is accepted for the connected API and is the exact proof audience', () => {
  const action = { kind: 'login', network: 'ATTO', address: authorizingAddress };
  const login = request({ action, purpose: 'login' });
  const { preview } = createClient().inspectProofApproval(login);
  assert.equal(preview.marketplaceOrigin, apiOrigin);
  assert.equal(preview.proofOrigin, browserOrigin);
  assert.equal(preview.audience, browserOrigin);

  const unprovisioned = request({ action, purpose: 'login', proof: 'http://localhost:5174',
    audience: 'http://localhost:5174' });
  assert.throws(() => createClient().inspectProofApproval(unprovisioned), { code: 'MARKETPLACE_APPROVAL_MISMATCH' });
  assert.throws(() => createClient(null).inspectProofApproval(login), { code: 'MARKETPLACE_APPROVAL_MISMATCH' });

  const apiSameOrigin = request({ action, purpose: 'login', proof: apiOrigin, audience: apiOrigin, });
  assert.equal(createClient(null).inspectProofApproval(apiSameOrigin).preview.proofOrigin, apiOrigin);
  assert.throws(() => createClient().inspectProofApproval(apiSameOrigin), { code: 'MARKETPLACE_APPROVAL_MISMATCH' });
});

test('login enrollment rejects missing tuple metadata, altered bindings and a different saved account', () => {
  const valid = request({ action: { kind: 'login', network: 'ATTO', address: authorizingAddress }, purpose: 'login' });
  for (const field of ['accountId', 'identityId']) {
    const missing = structuredClone(valid); delete missing[field];
    assert.throws(() => createClient().inspectProofApproval(missing), { code: 'MARKETPLACE_APPROVAL_PROTOCOL' });
  }
  const changed = structuredClone(valid);
  changed.challenge.message = changed.challenge.message.replace(/Binding Hash: [a-f0-9]{64}/, `Binding Hash: ${'0'.repeat(64)}`);
  assert.throws(() => createClient().inspectProofApproval(changed), { code: 'MARKETPLACE_APPROVAL_PROTOCOL' });
  const wrongTuple = request({ action: valid.action, purpose: 'login', account: '00000000-0000-4000-8000-000000000999' });
  assert.throws(() => createClient().inspectProofApproval(wrongTuple), { code: 'MARKETPLACE_APPROVAL_MISMATCH' });
});

test('saved browser-origin allowlists reject duplicates, wildcards, paths, and more than eight entries', () => {
  for (const origins of [
    ['https://site.example', 'https://site.example'],
    ['https://*.example.com'],
    ['https://site.example/path'],
    Array.from({ length: 9 }, (_, index) => `https://site${index}.example`),
  ]) {
    assert.throws(() => createClient(origins).connection(), { code: 'MARKETPLACE_CONFIGURATION' });
  }
});

test('two controller-link proofs bind the same account, identity pair, link ID, and exact controller role', () => {
  const action = {
    kind: 'identity-link', operation: 'NEW_IDENTITY', linkId,
    authorizingIdentityId: identityId, authorizingAddress, newIdentityAddress,
  };
  const binding = sha256([accountId, linkId, `atto:live:${authorizingAddress}`, `atto:live:${newIdentityAddress}`].join('\n'));
  const authorizerRequest = request({ action: { ...action, operation: 'AUTHORIZE' },
    purpose: 'link authorizer', binding });
  assert.equal(createClient().inspectProofApproval(authorizerRequest).preview.purpose, 'link authorizer');
  const targetRequest = request({ action, purpose: 'link new identity', address: newIdentityAddress, index: 1, binding });
  const { preview } = createClient().inspectProofApproval(targetRequest);
  assert.equal(preview.controller.address, newIdentityAddress);
  assert.equal(preview.identityId, identityId);

  assert.throws(() => createClient().inspectProofApproval({ ...targetRequest,
    action: { ...action, linkId: '00000000-0000-4000-8000-000000000199' } }), { code: 'MARKETPLACE_APPROVAL_PROTOCOL' });
  assert.throws(() => createClient().inspectProofApproval({ ...targetRequest,
    action: { ...action, authorizingIdentityId: '00000000-0000-4000-8000-000000000198' } }));
  assert.throws(() => createClient().inspectProofApproval({ ...targetRequest,
    action: { ...action, operation: 'AUTHORIZE' } }));
  assert.throws(() => createClient().inspectProofApproval({ ...targetRequest,
    controller: { ...targetRequest.controller, index: 0 } }), { code: 'MARKETPLACE_APPROVAL_PROTOCOL' });
  assert.throws(() => createClient().inspectProofApproval({ ...targetRequest,
    accountId: '00000000-0000-4000-8000-000000000198' }), { code: 'MARKETPLACE_APPROVAL_MISMATCH' });
});

test('typed controller unlink requires a different active authorizer and target', () => {
  const action = { kind: 'identity-unlink', targetIdentityId: '00000000-0000-4000-8000-000000000180', authorizingIdentityId: identityId };
  const binding = sha256(`unlink\n${accountId}\n${action.targetIdentityId}\n${identityId}`);
  const valid = request({ action, purpose: 'unlink', binding });
  assert.equal(createClient().inspectProofApproval(valid).preview.purpose, 'unlink');
  assert.throws(() => createClient().inspectProofApproval({ ...valid,
    action: { ...action, targetIdentityId: identityId } }), { code: 'MARKETPLACE_APPROVAL_PROTOCOL' });
});

test('admin moderation uses safe integer versions and the length-prefixed UTF-8 binding contract', () => {
  const action = {
    kind: 'adminModeration', targetKind: 'PROFILE', action: 'SUSPEND',
    targetId: '00000000-0000-4000-8000-000000000211', expectedTargetVersion: 12,
    expectedModerationVersion: 3, reason: '  café 🪙  ', idempotencyKey,
  };
  const normalizedReason = 'café 🪙';
  const binding = lengthPrefixed(['marketplace-admin-public-moderation-v1', accountId, identityId,
    'PROFILE', action.targetId, 'SUSPEND', '12', '3', normalizedReason, idempotencyKey]);
  const valid = request({ action, purpose: 'administrator public moderation', binding });
  assert.equal(createClient().inspectProofApproval(valid).preview.purpose, 'administrator public moderation');
  assert.throws(() => createClient().inspectProofApproval({ ...valid,
    action: { ...action, expectedTargetVersion: Number.MAX_SAFE_INTEGER + 1 } }), { code: 'MARKETPLACE_APPROVAL_PROTOCOL' });
  assert.throws(() => createClient().inspectProofApproval({ ...valid,
    action: { ...action, expectedModerationVersion: 4 } }), { code: 'MARKETPLACE_APPROVAL_PROTOCOL' });
  assert.equal(createClient().inspectProofApproval({ ...valid,
    action: { ...action, reason: 'café 🪙' } }).preview.purpose, 'administrator public moderation');
  assert.throws(() => createClient().inspectProofApproval({ ...valid,
    accountId: '00000000-0000-4000-8000-000000000199' }), { code: 'MARKETPLACE_APPROVAL_MISMATCH' });
  assert.throws(() => createClient().inspectProofApproval({ ...valid,
    identityId: '00000000-0000-4000-8000-000000000199' }), { code: 'MARKETPLACE_APPROVAL_MISMATCH' });
});

test('task close and administrator dispute approvals bind every typed field in wire order', () => {
  const close = { kind: 'adminTaskClose', taskId, action: 'CANCEL', expectedVersion: 14,
    reason: '  no longer needed  ', idempotencyKey };
  const closeBinding = lengthPrefixed(['marketplace-admin-task-close-v1', accountId, identityId, taskId,
    'CANCEL', '14', 'no longer needed', idempotencyKey]);
  assert.equal(createClient().inspectProofApproval(request({ action: close,
    purpose: 'administrator task cancellation or expiry', binding: closeBinding })).preview.purpose,
  'administrator task cancellation or expiry');
  const retiredClose={...close,kind:'adminJobClose',jobId:taskId};
  delete retiredClose.taskId;
  assert.throws(()=>createClient().inspectProofApproval(request({action:retiredClose,
    purpose:'administrator task cancellation or expiry',binding:closeBinding})),{code:'MARKETPLACE_APPROVAL_PROTOCOL'});

  const dispute = { kind: 'adminDisputeOpen', taskId, expectedEngagementVersion: 5,
    representedAgentId: '00000000-0000-4000-8000-000000000212', reason: 'NON_DELIVERY',
    statement: '  Work was not delivered.  ', evidenceUrls: ['https://evidence.example/report.pdf'],
    auditReason: '  Verified by review  ', idempotencyKey };
  const disputeBinding = lengthPrefixed(['dispute-admin-open-v1', accountId, identityId, taskId, '5',
    dispute.representedAgentId, 'NON_DELIVERY', idempotencyKey, 'Work was not delivered.',
    'Verified by review', ...dispute.evidenceUrls]);
  assert.equal(createClient().inspectProofApproval(request({ action: dispute,
    purpose: 'administrator dispute opening', binding: disputeBinding })).preview.purpose,
  'administrator dispute opening');
  assert.throws(() => createClient().inspectProofApproval(request({ action: { ...dispute,
    evidenceUrls: ['https://evidence.example/report.pdf', 'https://evidence.example/report.pdf'] },
    purpose: 'administrator dispute opening', binding: disputeBinding })), { code: 'MARKETPLACE_APPROVAL_PROTOCOL' });

  const resolution = { kind: 'adminDisputeResolution', disputeId: '00000000-0000-4000-8000-000000000213',
    expectedDisputeVersion: 8, outcome: 'BUYER_REFUND', rationale: 'The buyer is entitled to a refund.', idempotencyKey };
  const resolutionBinding = lengthPrefixed(['dispute-admin-resolve-v1', accountId, identityId,
    resolution.disputeId, '8', 'BUYER_REFUND', resolution.rationale, idempotencyKey]);
  assert.equal(createClient().inspectProofApproval(request({ action: resolution,
    purpose: 'administrator dispute resolution', binding: resolutionBinding })).preview.purpose,
  'administrator dispute resolution');
  assert.throws(() => createClient().inspectProofApproval(request({ action: { ...resolution,
    outcome: 'WORKER_AWARD' }, purpose: 'administrator dispute resolution', binding: resolutionBinding })),
  { code: 'MARKETPLACE_APPROVAL_PROTOCOL' });
});

test('administrator dispute text uses Kotlin whitespace trimming including controls but preserves FEFF', () => {
  const statement = '\u001cApproved\u001c';
  const auditReason = '\u001cReviewed\u001c';
  const dispute = { kind: 'adminDisputeOpen', taskId, expectedEngagementVersion: 5,
    representedAgentId: '00000000-0000-4000-8000-000000000212', reason: 'OTHER',
    statement, evidenceUrls: [], auditReason, idempotencyKey };
  const binding = lengthPrefixed(['dispute-admin-open-v1', accountId, identityId, taskId, '5',
    dispute.representedAgentId, 'OTHER', idempotencyKey, 'Approved', 'Reviewed']);
  assert.equal(createClient().inspectProofApproval(request({ action: dispute,
    purpose: 'administrator dispute opening', binding })).preview.purpose, 'administrator dispute opening');

  const rationale = '\ufeffApproved\ufeff';
  const resolution = { kind: 'adminDisputeResolution', disputeId: '00000000-0000-4000-8000-000000000213',
    expectedDisputeVersion: 8, outcome: 'BUYER_REFUND', rationale, idempotencyKey };
  const resolutionBinding = lengthPrefixed(['dispute-admin-resolve-v1', accountId, identityId,
    resolution.disputeId, '8', 'BUYER_REFUND', rationale, idempotencyKey]);
  assert.equal(createClient().inspectProofApproval(request({ action: resolution,
    purpose: 'administrator dispute resolution', binding: resolutionBinding })).preview.purpose,
  'administrator dispute resolution');
});

test('administrator dispute preview escapes terminal controls without changing the signed rationale', () => {
  const rationale = 'Reviewed \u001b[2J\u001b[HOutcome: WORKER_AWARD';
  const resolution = { kind: 'adminDisputeResolution', disputeId: '00000000-0000-4000-8000-000000000213',
    expectedDisputeVersion: 8, outcome: 'BUYER_REFUND', rationale, idempotencyKey };
  const binding = lengthPrefixed(['dispute-admin-resolve-v1', accountId, identityId,
    resolution.disputeId, '8', 'BUYER_REFUND', rationale, idempotencyKey]);
  const { preview } = createClient().inspectProofApproval(request({ action: resolution,
    purpose: 'administrator dispute resolution', binding }));
  const rendered = formatMarketplaceApprovalPreview(preview);
  assert.doesNotMatch(rendered, /\u001b|\r/);
  assert.equal(rendered.split('\n').filter(line => line.startsWith('  Outcome:')).length, 1);
  assert.match(rendered, /Outcome: BUYER_REFUND/);
  assert.ok(rendered.includes(String.raw`\\u{1B}[2J\\u{1B}[HOutcome: WORKER_AWARD`));
  assert.equal(resolution.rationale, rationale);
});

test('administrator evidence binding follows URI.toASCIIString normalization and component rules', () => {
  const evidenceUrls = [
    'https://evidence.example',
    'HTTPS://Evidence.Example:443/naïve?q=✓',
    'https://evidence.example?items[]=1',
    'https://evidence.example#note[1]',
    'https://evidence.example/e\u0301',
  ];
  const dispute = { kind: 'adminDisputeOpen', taskId, expectedEngagementVersion: 5,
    representedAgentId: '00000000-0000-4000-8000-000000000212', reason: 'OTHER',
    statement: 'Reviewed evidence.', evidenceUrls, auditReason: 'Verified', idempotencyKey };
  const binding = lengthPrefixed(['dispute-admin-open-v1', accountId, identityId, taskId, '5',
    dispute.representedAgentId, 'OTHER', idempotencyKey, 'Reviewed evidence.', 'Verified',
    'https://evidence.example', 'HTTPS://Evidence.Example:443/na%C3%AFve?q=%E2%9C%93',
    'https://evidence.example?items[]=1', 'https://evidence.example#note[1]',
    'https://evidence.example/%C3%A9']);
  assert.equal(createClient().inspectProofApproval(request({ action: dispute,
    purpose: 'administrator dispute opening', binding })).preview.purpose, 'administrator dispute opening');
});


test('task moderation signs the current TASK target and rejects retired target kinds',()=>{
  const action={kind:'adminModeration',targetKind:'TASK',action:'HIDE',targetId:taskId,
    expectedTargetVersion:2,expectedModerationVersion:0,reason:'reviewed',idempotencyKey};
  const binding=lengthPrefixed(['marketplace-admin-public-moderation-v1',accountId,identityId,'TASK',taskId,
    'HIDE','2','0','reviewed',idempotencyKey]);
  const valid=request({action,purpose:'administrator public moderation',binding});
  assert.equal(createClient().inspectProofApproval(valid).preview.action.targetKind,'TASK');
  assert.throws(()=>createClient().inspectProofApproval({...valid,action:{...action,targetKind:'JOB'}}),
    {code:'MARKETPLACE_APPROVAL_PROTOCOL'});
  assert.throws(()=>createClient().inspectProofApproval({...valid,action:{...action,action:'SUSPEND'}}),
    {code:'MARKETPLACE_APPROVAL_PROTOCOL'});
});

test('withdrawal approval preview escapes every field at the terminal boundary', () => {
  // Given a proof-bound destination containing terminal controls and a Unicode display override.
  const destinationAddress = 'nano_destination\u001b[2J\r\n  Amount: 0\u202E';
  const destinationId = '00000000-0000-4000-8000-000000000202';
  const action = { kind: 'withdrawal', network: 'nano:mainnet', destinationAddress,
    command: { asset: 'XNO', atomicAmount: '25', destinationId, expectedSelectionVersion: 2, idempotencyKey } };
  const binding = sha256(['withdrawal-create-v2', accountId, identityId, 'XNO', '25', action.network,
    destinationId, destinationAddress, '2', idempotencyKey].join('\n'));
  const original = request({ action, purpose: 'withdrawal creation', binding });
  const { preview } = createClient().inspectProofApproval(original);

  // When the accepted request is formatted for local approval.
  const rendered = formatMarketplaceApprovalPreview(preview);

  // Then it cannot control the terminal or inject a line, while the signed request is untouched.
  assert.doesNotMatch(rendered, /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u202E]/u);
  assert.equal(rendered.split('\n').filter(line => line.startsWith('  Action:')).length, 1);
  assert.equal(rendered.split('\n').filter(line => line.startsWith('  Destination:')).length, 1);
  assert.match(rendered, /Action: withdraw 25 XNO on nano:mainnet/);
  assert.ok(rendered.includes(String.raw`\u{1B}[2J\u{D}\u{A}  Amount: 0\u{202E}`));
  assert.equal(preview.action.destinationAddress, destinationAddress);
  assert.equal(original.challenge.message.includes(binding), true);
});
