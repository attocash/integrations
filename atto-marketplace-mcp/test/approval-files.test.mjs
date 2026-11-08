import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { join } from 'node:path';
import { approvalRequestDigest, readApprovalRequest, readApprovalResponse, validateApprovalResponse, verifyApprovalSignature, writeApprovalRequest } from '../dist/approval-files.js';

const handoffId = '0123456789abcdef0123456789abcdef';

test('typed wallet-approval request is durable, private, and immutable by opaque handle', async () => {
  // Given one configured private Marketplace profile and a server-authored controller challenge.
  const home = await mkdtemp(join(tmpdir(), 'atto-marketplace-mcp-approval-'));
  const request = approvalRequest();
  try {
    // When the Marketplace MCP creates the typed request file for its exact handoff.
    const path = await writeApprovalRequest(home, 'agent', handoffId, request);
    await chmod(path, 0o600);
    const bytes = await readFile(path, 'utf8');
    const file = await lstat(path);

    // Then the wallet CLI can validate one canonical digest from an owner-only artifact.
    assert.equal(file.mode & 0o777, 0o600);
    assert.deepEqual(readApprovalRequest(home, 'agent', handoffId), request);
    assert.equal(approvalRequestDigest(request), approvalRequestDigest(JSON.parse(bytes)));
    const response = { version: 1, type: 'marketplace-controller-approval-response', profileId: 'agent', handoffId,
      requestDigest: approvalRequestDigest(request), challengeId: request.challenge.challengeId, message: request.challenge.message,
      signature: 'c'.repeat(64), controllerAddress: request.controller.address, controllerIndex: request.controller.index };
    assert.deepEqual(validateApprovalResponse(request, response), response);
    for (const changed of [
      { ...request, accountId: '99999999-9999-4999-8999-999999999999' },
      { ...request, audience: 'other-audience' },
      { ...request, action: { ...request.action, command: { ...request.action.command, atomicAmount: '124' } } },
      { ...request, action: { ...request.action, destinationAddress: 'atto://ccccccccccccccccccccccccccccccccccccccccccccccccccccc' } },
      { ...request, action: { ...request.action, command: { ...request.action.command, idempotencyKey: '66666666-6666-4666-8666-666666666666' } } },
    ]) assert.throws(() => validateApprovalResponse(changed, response));
    assert.equal(await writeApprovalRequest(home, 'agent', handoffId, request), path);
    await assert.rejects(writeApprovalRequest(home, 'agent', handoffId, { ...request, purpose: 'payout address disablement' }));
    assert.throws(() => readApprovalResponse(home, 'agent', handoffId));
    assert.throws(() => readApprovalRequest(home, '../other', handoffId));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Nano approval responses bind the full request domain, network, controller, challenge, purpose and Shop action', () => {
  // Given one public Nano controller challenge and its exact v1 approval response envelope.
  const request = nanoApprovalRequest();
  const response = nanoApprovalResponse(request);

  // When the envelope is checked against the saved request.
  assert.deepEqual(validateApprovalResponse(request, response), response);
  const changedRequests = [
    { ...request, marketplaceOrigin: 'https://another.marketplace.example' },
    { ...request, transport: 'BROWSER', proofOrigin: 'https://marketplace.example' },
    { ...request, audience: 'another-agent-api' },
    { ...request, controller: { ...request.controller, network: 'ATTO' } },
    { ...request, controller: { ...request.controller, address: `nano_${'1'.repeat(60)}` } },
    { ...request, controller: { ...request.controller, index: 1 } },
    { ...request, purpose: 'product refund' },
    { ...request, action: { ...request.action, grossAtomic: '100' } },
    { ...request, challenge: { ...request.challenge, challengeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } },
    { ...request, challenge: { ...request.challenge, message: 'changed challenge' } },
  ];

  // Then changing any binding field changes the canonical digest and rejects the original response.
  for (const changed of changedRequests) {
    assert.notEqual(approvalRequestDigest(changed), approvalRequestDigest(request));
    assert.throws(() => validateApprovalResponse(changed, response), { code: 'APPROVAL_FILE' });
  }
  assert.throws(() => validateApprovalResponse(request, { ...response, requestDigest: '0'.repeat(64) }), { code: 'APPROVAL_FILE' });
  assert.throws(() => validateApprovalResponse(request, { ...response, controllerAddress: `nano_${'1'.repeat(60)}` }), { code: 'APPROVAL_FILE' });
  assert.throws(() => validateApprovalResponse(request, { ...response, controllerIndex: 1 }), { code: 'APPROVAL_FILE' });
  assert.throws(() => validateApprovalResponse(request, { ...response, challengeId: request.challenge.challengeId.replace('a', 'c') }), { code: 'APPROVAL_FILE' });
  assert.throws(() => validateApprovalResponse(request, { ...response, message: 'changed challenge' }), { code: 'APPROVAL_FILE' });
});

test('Nano approval verification checks the public proof locally without opening wallet configuration', async () => {
  const request = nanoApprovalRequest();
  const response = nanoApprovalResponse(request);
  const env = {
    MARKETPLACE_MCP_WALLET_HOST_COMMAND: '/this-command-must-not-be-executed',
    MARKETPLACE_MCP_NANO_WALLET_DATA_DIR: '/this-path-must-not-be-opened',
    MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR: '/this-path-must-not-be-opened',
    MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR: '/this-path-must-not-be-opened',
  };

  await verifyApprovalSignature(request, response, env);
  await assert.rejects(verifyApprovalSignature(request, { ...response, signature: `${response.signature.slice(0, -1)}0` }, env),
    { code: 'APPROVAL_FILE' });
  await assert.rejects(verifyApprovalSignature({ ...request, challenge: { ...request.challenge, message: `${request.challenge.message} ` } }, response, env),
    { code: 'APPROVAL_FILE' });
});

test('approval files reject symlinked profile directories and permissive request files', async () => {
  // Given a profile approval directory and a request that must never follow attacker-controlled links.
  const parent = await mkdtemp(join(tmpdir(), 'atto-marketplace-mcp-approval-links-'));
  const home = join(parent, 'home');
  const outside = join(parent, 'outside');
  const request = approvalRequest();
  try {
    await import('node:fs/promises').then(fs => fs.mkdir(home, { mode: 0o700 }));
    await import('node:fs/promises').then(fs => fs.mkdir(outside, { mode: 0o700 }));
    await symlink(outside, join(home, 'approvals'));
    await assert.rejects(writeApprovalRequest(home, 'agent', handoffId, request));
    await rm(join(home, 'approvals'));
    const path = await writeApprovalRequest(home, 'agent', handoffId, request);
    await chmod(path, 0o644);

    // When the server later reads the response, it refuses to open a permissive request artifact.
    assert.throws(() => readApprovalRequest(home, 'agent', handoffId));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

for (const network of ['ATTO', 'NANO']) {
  test(`${network === 'ATTO' ? 'Atto' : 'Nano'} approval handoffs reject administrator purposes and refund authority`, async () => {
    // Given private request/response artifacts with otherwise matching bindings.
    const home = await mkdtemp(join(tmpdir(), 'marketplace-no-admin-approval-'));
    const base = network === 'ATTO' ? approvalRequest() : nanoApprovalRequest();
    const handle = base.handoffId;
    const blocked = [
      ...['withdrawal cap exception', 'administrator dispute opening', 'administrator dispute resolution',
        'administrator public moderation', 'administrator task cancellation or expiry']
        .map(purpose => ({ ...base, purpose })),
      { ...base, purpose: 'product refund', action: { kind: 'productRefund', authority: 'ADMIN' } },
    ];
    try {
      const path = await writeApprovalRequest(home, 'agent', handle, base);
      for (const request of blocked) {
        const response = { version: 1, type: 'marketplace-controller-approval-response', profileId: 'agent', handoffId: handle,
          requestDigest: approvalRequestDigest(request), challengeId: request.challenge.challengeId,
          message: request.challenge.message, signature: network === 'NANO' ? nanoSignature : 'a'.repeat(128),
          controllerAddress: request.controller.address, controllerIndex: request.controller.index };

        // When an administrator request is written, restored from disk, or matched to an existing response.
        await assert.rejects(writeApprovalRequest(home, 'agent', handle, request), { code: 'APPROVAL_FILE' });
        await writeFile(path, JSON.stringify(request));

        // Then no administrator handoff can be consumed, including a cryptographically valid public Nano signature.
        assert.throws(() => readApprovalRequest(home, 'agent', handle), { code: 'APPROVAL_FILE' });
        assert.throws(() => validateApprovalResponse(request, response), { code: 'APPROVAL_FILE' });
        await assert.rejects(verifyApprovalSignature(request, response), { code: 'APPROVAL_FILE' });
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}

function approvalRequest() {
  return {
    version: 1,
    type: 'marketplace-controller-approval-request',
    profileId: 'agent',
    handoffId,
    marketplaceOrigin: 'https://marketplace.example',
    transport: 'AGENT_API',
    proofOrigin: null,
    audience: 'marketplace-agent-api',
    accountId: '11111111-1111-4111-8111-111111111111',
    identityId: '33333333-3333-4333-8333-333333333333',
    controller: { network: 'ATTO', address: 'atto://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', index: 0 },
    purpose: 'withdrawal creation',
    action: {
      kind: 'withdrawal',
      command: { asset: 'ATTO', atomicAmount: '123', destinationId: '22222222-2222-4222-8222-222222222222', expectedSelectionVersion: 0, idempotencyKey: '44444444-4444-4444-8444-444444444444' },
      network: 'atto:live',
      destinationAddress: 'atto://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
    challenge: {
      challengeId: '55555555-5555-4555-8555-555555555555',
      message: 'exact server-authored challenge message',
      issuedAt: '2026-09-26T12:00:00Z',
      expiresAt: '2026-09-26T12:03:00Z',
    },
  };
}

function nanoApprovalRequest() {
  return {
    version: 1, type: 'marketplace-controller-approval-request', profileId: 'agent', handoffId: 'a'.repeat(32),
    marketplaceOrigin: 'https://marketplace.example', transport: 'AGENT_API', proofOrigin: null, audience: 'marketplace',
    accountId: '11111111-1111-4111-8111-111111111111', identityId: '22222222-2222-4222-8222-222222222222',
    controller: { network: 'NANO', address: nanoAddress, index: 0 }, purpose: 'product purchase',
    action: { kind: 'productPurchase', releaseId: '33333333-3333-4333-8333-333333333333', grossAtomic: '101', idempotencyKey: '44444444-4444-4444-8444-444444444444' },
    challenge: { challengeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', message: nanoMessage,
      issuedAt: '2026-10-16T20:00:00.000Z', expiresAt: '2026-10-16T20:02:00.000Z' },
  };
}

const nanoAddress = 'nano_3noms9a1zytox399kygpge6cc7hu1z79ms1cgzojodz8741qi7w5u3nzb8mn';
const nanoMessage = 'Hej Nano!🥦';
const nanoSignature = '535c745819d0f40056f3c46402b4fae4356b3a8897bde99c955d411920e740d781e6dddcbde228e8b86c4383a1003f9f315519ff73bd356f561d19865dc90f09';

function nanoApprovalResponse(request) {
  return { version: 1, type: 'marketplace-controller-approval-response', profileId: request.profileId,
    handoffId: request.handoffId, requestDigest: approvalRequestDigest(request), challengeId: request.challenge.challengeId,
    message: request.challenge.message, signature: nanoSignature, controllerAddress: request.controller.address,
    controllerIndex: request.controller.index };
}
