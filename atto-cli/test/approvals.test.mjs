import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AttoBlock } from '@attocash/commons-core';

const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const { AttoApplication } = await import(pathToFileURL(join(cliDirectory, 'dist/application/app.js')).href);
const { marketTerms } = await import(pathToFileURL(join(cliDirectory, 'dist/pricing/terms.js')).href);
const { parseAddress } = await import(pathToFileURL(join(cliDirectory, 'dist/network/reader.js')).href);
const unlimited = { perRequest: null, rolling: [] };
const bounded = { perRequest: { amount: '100', unit: 'RAW' }, rolling: [{ days: 1, amount: '200', unit: 'RAW' }] };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'atto-limit-approval-'));
  let phrase = null;
  let secretReads = 0;
  const secrets = { get: async () => { secretReads++; return phrase; }, set: async value => { phrase = value; } };
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    response.writeHead(404);
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const sessions = [];
  const open = access => {
    const app = new AttoApplication({ directory, secrets, ...(access ? { access } : {}) });
    sessions.push(app);
    return app;
  };
  t.after(async () => {
    for (const app of sessions.reverse()) await app.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    phrase = null;
    await rm(directory, { recursive: true, force: true });
  });
  const local = open();
  const nodeUrl = `http://127.0.0.1:${server.address().port}`;
  await local.call('wallet_configure', { network: 'LOCAL', nodeUrl, workerUrl: nodeUrl, autoReceive: true });
  const wallet = await local.createWallet();
  return { local, mcp: open('mcp'), open, directory, wallet, requests, get secretReads() { return secretReads; } };
}

async function propose(application, policy = bounded, access) {
  const result = await application.call('limits_propose', { policy, ...(access ? { access } : {}) });
  assert.deepEqual(Object.keys(result), ['proposal']);
  return result.proposal;
}

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!await predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await delay(25);
  }
}

test('existing shared CLI budgets do not implicitly authorize MCP spending', async t => {
  // Given
  const f = await fixture(t);
  f.local.ledger.setPolicy(bounded);
  // When
  const limits = await f.mcp.call('limits_get');
  // Then
  assert.deepEqual(limits.policy, bounded);
  assert.equal(limits.mcpAccess, 'read-only');
  assert.equal(limits.proposal, null);
  assert.deepEqual((await f.mcp.call('wallet_status')).identity, f.wallet.identity);
  await assert.rejects(f.mcp.call('address_deactivate', { index: 0 }), { code: 'MCP_READ_ONLY' });
  assert.equal((await f.local.call('address_deactivate', { index: 0 })).active, false);
});

test('all shared limit requests only propose and the latest proposal survives restart', async t => {
  // Given
  const f = await fixture(t);
  f.local.ledger.setPolicy(bounded);
  const revision = f.local.store.get('spending.policyRevision');
  const seen = new Set();
  let latest;
  for (const [policy, access] of [
    [unlimited, undefined], [bounded, undefined],
    [{ perRequest: { amount: '1', unit: 'RAW' }, rolling: [] }, 'read-only'],
  ]) {
    // When
    latest = await propose(f.mcp, policy, access);
    // Then
    assert.match(latest.id, /^[a-f0-9-]{36}$/i);
    assert.equal(seen.has(latest.id), false);
    seen.add(latest.id);
    assert.deepEqual(latest.policy, policy);
    assert.equal(latest.access, access ?? 'spend');
    assert.equal(latest.status, 'pending');
    assert.equal(latest.baseRevision, revision);
    assert.equal(latest.walletFingerprint, f.wallet.identity.fingerprint);
    assert.equal(latest.network, 'LOCAL');
    assert.equal(latest.directory, f.directory);
    assert.ok(latest.expiresAt > latest.createdAt);
    const limits = await f.mcp.call('limits_get');
    assert.deepEqual(limits.policy, bounded);
    assert.equal(limits.mcpAccess, 'read-only');
    assert.equal(f.local.store.get('spending.policyRevision'), revision);
  }
  await f.mcp.close();
  assert.deepEqual((await f.open('mcp').call('limits_get')).proposal, latest);
  const fromGenericLocalCall = await propose(f.local, unlimited);
  assert.equal(fromGenericLocalCall.status, 'pending');
  assert.deepEqual(f.local.ledger.policy(), bounded);
});

test('terminal approval applies exactly the reviewed proposal and is harmless to repeat', async t => {
  // Given
  const f = await fixture(t);
  const proposal = await propose(f.mcp);
  const review = await f.local.reviewLimitsProposal(proposal.id);
  assert.deepEqual(review.proposal, proposal);
  assert.equal(review.directory, f.directory);
  assert.deepEqual(review.identity, f.wallet.identity);
  assert.equal(review.network, 'LOCAL');
  assert.deepEqual(review.policy, unlimited);
  assert.equal(review.mcpAccess, 'read-only');
  // When: independent local sessions approve the same immutable proposal.
  await Promise.all([f.local.approveLimitsProposal(proposal.id), f.open().approveLimitsProposal(proposal.id)]);
  const revision = f.local.store.get('spending.policyRevision');
  const approved = await f.mcp.call('limits_get');
  // Then
  assert.equal(revision, proposal.baseRevision + 1);
  assert.deepEqual(approved.policy, bounded);
  assert.equal(approved.mcpAccess, 'spend');
  assert.equal(approved.proposal.status, 'approved');
  const repeated = await f.local.approveLimitsProposal(proposal.id);
  assert.deepEqual(repeated.policy, approved.policy);
  assert.deepEqual(repeated.proposal, approved.proposal);
  assert.equal(repeated.mcpAccess, approved.mcpAccess);
  assert.equal(f.local.store.get('spending.policyRevision'), revision);
  assert.equal((await f.mcp.call('address_deactivate', { index: 0 })).active, false);
  await f.mcp.close();
  assert.deepEqual((await f.open('mcp').call('limits_get')).policy, bounded);
  assert.equal((await f.open('mcp').call('limits_get')).mcpAccess, 'spend');
});

test('superseded proposals and approvals based on an old policy revision cannot apply', async t => {
  // Given
  const f = await fixture(t);
  const first = await propose(f.mcp, unlimited);
  const current = await propose(f.mcp, bounded);
  // When
  const oldReview = f.local.reviewLimitsProposal(first.id);
  // Then
  await assert.rejects(oldReview, { code: 'PROPOSAL_NOT_FOUND' });
  await assert.rejects(f.local.approveLimitsProposal(first.id), { code: 'PROPOSAL_NOT_FOUND' });
  f.local.ledger.setPolicy({ perRequest: { amount: '5', unit: 'RAW' }, rolling: [] });
  const policy = f.local.ledger.policy();
  await assert.rejects(f.local.approveLimitsProposal(current.id), { code: 'PROPOSAL_STALE' });
  assert.deepEqual(f.local.ledger.policy(), policy);
  assert.equal((await f.mcp.call('limits_get')).mcpAccess, 'read-only');
});

test('approval fails closed after expiry or a changed wallet, network, or directory context', async t => {
  // Given: each case starts with an independently initialized synthetic wallet.
  // When: a proposal expires or its bound context changes before approval.
  // Then: approval fails without changing the active policy or access.
  for (const context of ['expiry', 'wallet', 'network', 'directory']) {
    await t.test(context, async child => {
      // Given
      const f = await fixture(child);
      const proposal = await propose(f.mcp);
      // When
      if (context === 'expiry') f.local.store.set('spending.proposal', { ...proposal, createdAt: Date.now() - 86_400_000, expiresAt: Date.now() - 1 });
      if (context === 'wallet') f.local.store.set('identity', { ...f.wallet.identity, fingerprint: 'changed-wallet' });
      if (context === 'network') await f.local.call('wallet_configure', { network: 'BETA' });
      if (context === 'directory') f.local.store.set('spending.proposal', { ...proposal, directory: join(f.directory, 'another-profile') });
      // Then
      await assert.rejects(f.local.approveLimitsProposal(proposal.id), {
        code: context === 'expiry' ? 'PROPOSAL_EXPIRED' : 'PROPOSAL_STALE',
      });
      assert.deepEqual(f.local.ledger.policy(), unlimited);
      assert.equal((await f.mcp.call('limits_get')).mcpAccess, 'read-only');
    });
  }
});

test('rejection persists without changing policy or granting access', async t => {
  // Given
  const f = await fixture(t);
  f.local.ledger.setPolicy(bounded);
  const proposal = await propose(f.mcp, unlimited);
  // When
  await f.local.rejectLimitsProposal(proposal.id);
  await f.local.close();
  const reopened = f.open();
  const limits = await reopened.call('limits_get');
  // Then
  assert.equal(limits.proposal.status, 'rejected');
  assert.deepEqual(limits.policy, bounded);
  assert.equal(limits.mcpAccess, 'read-only');
  await assert.rejects(reopened.approveLimitsProposal(proposal.id), { code: 'PROPOSAL_REJECTED' });
});

test('approving limits preserves confirmed spending and uncertain reservations', async t => {
  // Given
  const f = await fixture(t);
  const source = f.wallet.addresses[0];
  const destination = (await f.local.call('wallet_status')).settings.representative;
  for (const [id, amount, published] of [['confirmed', 10, true], ['uncertain', 20, false]]) {
    const block = AttoBlock.fromJson(JSON.stringify({
      type: 'SEND', network: 'LOCAL', version: 0, algorithm: 'V1', publicKey: source.publicKey,
      height: 2, balance: 100 - amount, timestamp: Date.now(), previous: '11'.repeat(32),
      receiverAlgorithm: 'V1', receiverPublicKey: parseAddress(destination).publicKey.toString(), amount,
    }));
    f.local.ledger.reserve({ id, index: 0, destination, raw: String(amount), createdAt: Date.now() });
    f.local.ledger.signed(id, block.hash.toString(), block.toJson());
    if (published) f.local.ledger.complete(id, { hash: block.hash.toString() }, Date.now());
    else f.local.ledger.uncertain(id);
  }
  const journal = f.local.store.get('spending.records');
  const policy = { perRequest: null, rolling: [{ days: 1, amount: '25', unit: 'RAW' }] };
  // When
  await f.local.approveLimitsProposal((await propose(f.mcp, policy)).id);
  // Then
  assert.deepEqual(f.local.store.get('spending.records'), journal);
  const limits = f.local.ledger.usage();
  assert.equal(limits.pendingRaw, '20');
  assert.equal(limits.rolling[0].publishedRaw, '10');
  assert.equal(limits.rolling[0].usedRaw, '30');
  assert.equal(limits.rolling[0].remainingRaw, '0');
  assert.throws(() => f.local.ledger.reserve({ id: 'over-limit', index: 0, destination, raw: '1', createdAt: Date.now() }), { code: 'SPENDING_LIMIT' });
});

test('read-only MCP blocks every wallet mutation before secrets or network activity', async t => {
  // Given
  const f = await fixture(t);
  const before = await f.local.call('wallet_status');
  const reads = f.secretReads;
  const destination = before.settings.representative;
  for (const [name, input] of [
    ['wallet_configure', { autoReceive: true }], ['address_derive', { index: 1 }],
    ['address_activate', { index: 1 }], ['address_deactivate', { index: 0 }],
    ['send', { destination, amount: '1', unit: 'RAW', requestId: 'not-authorized' }],
    ['receive', { hash: 'A'.repeat(64) }], ['receive_all', {}],
    ['representative_change', { representative: destination }],
    ['terms_accept', { version: marketTerms.version, accepted: true }],
  ]) {
    // When
    const mutation = f.mcp.call(name, input);
    // Then
    await assert.rejects(mutation, { code: 'MCP_READ_ONLY' }, name);
  }
  assert.equal(f.secretReads, reads);
  assert.equal(f.requests.length, 0);
  const after = await f.local.call('wallet_status');
  assert.deepEqual(after.settings, before.settings);
  assert.deepEqual(after.addresses, before.addresses);
  assert.equal((await f.mcp.call('terms_get')).accepted, false);
  const watch = await f.mcp.call('watch_start', { event: 'account', addresses: [destination] });
  assert.ok((await f.mcp.call('watch_list')).some(item => item.id === watch.id));
  assert.deepEqual(await f.mcp.call('watch_stop', { id: watch.id }), { stopped: true });
});

test('MCP automatic receiving starts after local approval and stops after revocation', async t => {
  // Given
  const f = await fixture(t);
  const reads = f.secretReads;
  // When
  await f.mcp.start();
  await delay(300);
  // Then
  assert.equal((await f.mcp.call('wallet_status')).autoReceive.running, false);
  assert.equal(f.requests.length, 0);
  assert.equal(f.secretReads, reads);

  // When
  await f.local.approveLimitsProposal((await propose(f.mcp)).id);
  // Then: the existing session observes the grant without a restart.
  await waitUntil(async () => (await f.mcp.call('wallet_status')).autoReceive.running
    && f.requests.some(request => request.path.includes('/receivables/stream')), 'Approved MCP receiving did not start.');

  // When
  await f.local.approveLimitsProposal((await propose(f.mcp, bounded, 'read-only')).id);
  // Then
  await waitUntil(async () => !(await f.mcp.call('wallet_status')).autoReceive.running, 'Revoked MCP receiving did not stop.');
  const requestsAfterRevocation = f.requests.length;
  await delay(300);
  assert.equal((await f.mcp.call('wallet_status')).autoReceive.running, false);
  assert.equal(f.requests.length, requestsAfterRevocation);
  assert.equal(f.secretReads, reads);
});

test('a queued MCP mutation rechecks access after a local revocation', { timeout: 5000 }, async t => {
  // Given
  const f = await fixture(t);
  await f.local.approveLimitsProposal((await propose(f.mcp)).id);
  const revocation = await propose(f.mcp, bounded, 'read-only');
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let resume;
  const paused = new Promise(resolve => { resume = resolve; });
  const lock = f.mcp.store.withWalletLock.bind(f.mcp.store);
  f.mcp.store.withWalletLock = async operation => { entered(); await paused; return lock(operation); };
  // When
  try {
    const rejected = assert.rejects(f.mcp.call('address_deactivate', { index: 0 }), { code: 'MCP_READ_ONLY' });
    await waiting;
    await f.local.approveLimitsProposal(revocation.id);
    resume();
    // Then
    await rejected;
  } finally {
    resume();
    f.mcp.store.withWalletLock = lock;
  }
  assert.equal((await f.local.call('address_list')).addresses[0].active, true);
  assert.equal((await f.mcp.call('limits_get')).mcpAccess, 'read-only');
});
