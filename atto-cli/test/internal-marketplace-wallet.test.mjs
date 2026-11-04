import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInternalMarketplaceWalletApplication } from '../dist/internal-marketplace.js';
import { AttoError } from '../dist/domain/errors.js';
import { StateStore } from '../dist/storage/state.js';
import { fixture, gate, until } from './support/payments.mjs';

async function privateWallet(t, authorizeWrite) {
  const directory = await mkdtemp(join(tmpdir(), 'atto-private-wallet-'));
  const app = createInternalMarketplaceWalletApplication({ directory, authorizeWrite });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, directory };
}

test('private wallet facade exposes only native/controller operations and retains read-only access by default', async t => {
  let writes = 0;
  const { app } = await privateWallet(t, () => { writes++; });
  assert.deepEqual(Object.keys(app).sort(), ['call', 'close', 'start']);
  assert.equal((await app.call('wallet_status')).mcpAccess, 'read-only');
  await assert.rejects(app.call('wallet_configure', { autoReceive: false }), { code: 'UNKNOWN_OPERATION' });
  await assert.rejects(app.call('address_derive', { index: 1 }), { code: 'UNKNOWN_OPERATION' });
  await assert.rejects(app.call('receive', { hash: 'AB'.repeat(32) }), { code: 'MCP_READ_ONLY' });
  assert.equal(writes, 0);
});

test('private authorization restricts approved MCP writes without restricting wallet reads', async t => {
  const { app, directory } = await privateWallet(t, () => { throw new AttoError('EXTERNAL_TRANSFERS_DENIED', 'Denied'); });
  const store = new StateStore(directory);
  store.set('spending.mcpAccess', 'spend');
  store.close();
  assert.equal((await app.call('wallet_status')).mcpAccess, 'spend');
  await assert.rejects(app.call('receive', { hash: 'AB'.repeat(32) }), { code: 'EXTERNAL_TRANSFERS_DENIED' });
});

test('private write authorization is rechecked after network awaits immediately before signing', { timeout: 20000 }, async t => {
  let f;
  f = await fixture(t, [10], undefined, '100', undefined, {
    internalMarketplaceAuthorizeWrite: () => {
      if (f?.state.requests.some(request => request.path.startsWith('/instants/'))) {
        throw new AttoError('EXTERNAL_TRANSFERS_DENIED', 'Revoked during transaction preparation');
      }
    },
  });
  const mcp = f.open('mcp');
  await assert.rejects(mcp.call('send', f.request('private-revoked-before-signing')), { code: 'EXTERNAL_TRANSFERS_DENIED' });
  const record = f.app.ledger.get('private-revoked-before-signing');
  assert.equal(record.status, 'failed');
  assert.equal(record.hash, undefined);
  assert.equal(f.state.publicationAttempts.length, 0);
  assert.equal(f.state.works.length, 0);
  assert.equal(f.app.ledger.usage().pendingRaw, '0');
});

test('private RECEIVE lost acknowledgement retains one candidate across restart and fences new SENDs until reconciliation', { timeout: 20000 }, async t => {
  // Given an approved private source and one confirmed incoming native SEND.
  const f = await fixture(t, [10, 0], undefined, '100', undefined, {
    internalMarketplaceReceiveSafety: true, receivingAllowed: () => false,
  });
  const incoming = await f.app.call('send', { index: 0, destination: f.addresses[1].address,
    amount: '1', unit: 'RAW', requestId: 'private-receive-incoming' });
  let mcp = f.open('mcp');
  // When publication succeeds but its acknowledgement and hash lookup are unavailable.
  f.state.failPublication = 2;
  f.state.hideHashLookup = true;
  const args = { index: 1, hash: incoming.hash };
  const pending = await mcp.call('receive', args);
  assert.deepEqual(pending, { status: 'unknown', hash: pending.hash, index: 1, sendHash: incoming.hash,
    sourceAddress: f.addresses[1].address, network: 'LOCAL', amountAtomic: null });
  assert.match(pending.hash, /^[A-F0-9]{64}$/);
  const key = `receive.LOCAL.${incoming.hash}`;
  // Then restart retains the same candidate and blocks new spending until exact reconciliation.
  const saved = f.app.store.get(key);
  assert.equal(saved.blockHash, pending.hash);
  assert.equal(saved.sourceAddress, f.addresses[1].address);
  assert.equal(saved.network, 'LOCAL');
  assert.equal(saved.result, undefined);
  assert.equal(f.state.publicationAttempts.length, 2);
  await mcp.close();
  mcp = f.open('mcp');
  // Reconciliation must finish before the private path attempts key access again.
  mcp.seed = async () => { throw new Error('An existing RECEIVE candidate must not read keys or sign a replacement'); };
  assert.deepEqual(await mcp.call('receive', args), pending);
  assert.equal(f.state.publicationAttempts.length, 2);
  assert.deepEqual(f.app.store.get(key), saved);
  await assert.rejects(mcp.call('receive', { index: 0, hash: incoming.hash }), { code: 'WRONG_RECEIVER' });
  const outgoing = { index: 1, destination: f.recipient.address, amount: '1', unit: 'RAW', requestId: 'private-receive-fenced-send' };
  await assert.rejects(mcp.call('send', outgoing), { code: 'SOURCE_FENCED' });
  assert.equal(f.app.ledger.get(outgoing.requestId), undefined);
  assert.equal(f.state.publicationAttempts.length, 2);
  f.state.hideHashLookup = false;
  const received = await mcp.call('receive', args);
  assert.equal(received.status, 'received');
  assert.equal(received.hash, pending.hash);
  assert.equal(f.state.publicationAttempts.length, 2);
  const resumed = f.open('mcp');
  const sent = await resumed.call('send', outgoing);
  assert.equal(sent.status, 'published');
  assert.equal(f.state.publicationAttempts.length, 3);
});

test('private RECEIVE never converts missing input or mismatched persisted identity into a pending observation', async t => {
  // Given no pending receipt, followed by a persisted candidate bound to a different account.
  const f = await fixture(t, [10], undefined, '100', undefined, { internalMarketplaceReceiveSafety: true });
  const mcp = f.open('mcp'), hash = 'CD'.repeat(32);
  // When each request is received, then the original denial remains an error without a fabricated candidate.
  await assert.rejects(mcp.call('receive', { index: 0, hash }), { code: 'RECEIVABLE_NOT_PENDING' });
  f.app.store.set(`receive.LOCAL.${hash}`, { hash, index: 0, blockHash: 'EF'.repeat(32),
    network: 'LOCAL', sourceAddress: f.recipient.address });
  await assert.rejects(mcp.call('receive', { index: 0, hash }), { code: 'INVALID_STATE' });
});


test('private facade replays an existing standalone RECEIVE record without new keys, signature or metadata changes', { timeout: 20000 }, async t => {
  // Given the stable standalone CLI has already received and saved its original record shape.
  const f = await fixture(t, [10, 0]);
  const incoming = await f.app.call('send', { index: 0, destination: f.addresses[1].address,
    amount: '1', unit: 'RAW', requestId: 'standalone-receive-incoming' });
  const received = await f.app.call('receive', { index: 1, hash: incoming.hash });
  const key = `receive.LOCAL.${incoming.hash}`, before = f.app.store.get(key);
  assert.deepEqual(Object.keys(before).sort(), ['blockHash', 'hash', 'index', 'result']);
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const beforeDigest = digest(before);
  // When Marketplace selects that existing profile, it validates and replays the same saved candidate.
  const privateWallet = createInternalMarketplaceWalletApplication({ directory: f.directory, authorizeWrite: () => undefined });
  try {
    const replayed = await privateWallet.call('receive', { index: 1, hash: incoming.hash });
    // Then no credentials, new signature, publication or private metadata migration is needed.
    assert.equal(replayed.hash, received.hash);
    assert.equal(replayed.status, 'received');
    assert.equal(f.state.publicationAttempts.length, 2);
    assert.equal(digest(f.app.store.get(key)), beforeDigest);
    f.app.store.set(key, { ...before, network: 'LOCAL' });
    await assert.rejects(privateWallet.call('receive', { index: 1, hash: incoming.hash }), { code: 'INVALID_STATE' });
  } finally { await privateWallet.close(); }
});


test('private RECEIVE rechecks fresh shared pool authority after asynchronous key access before signing', { timeout: 20000 }, async t => {
  // Given a selected private receiving account currently belongs to the shared CLI spending pool.
  const proceed = gate();
  t.after(() => proceed.release());
  let enforce = false, paused = false;
  const snapshots = [];
  const f = await fixture(t, [10, 0], undefined, '100', undefined, {
    internalMarketplaceReceiveSafety: true, receivingAllowed: () => false,
    internalMarketplaceAuthorizeWrite: status => {
      if (!enforce) return;
      snapshots.push(status);
      if (!status.pool.indexes.includes(1)) throw new AttoError('PERMISSION_DENIED', 'The selected receiving account left the shared approved pool');
    },
  });
  const incoming = await f.app.call('send', { index: 0, destination: f.addresses[1].address,
    amount: '1', unit: 'RAW', requestId: 'private-pool-revocation-incoming' });
  const mcp = f.open('mcp');
  const seed = mcp.seed.bind(mcp);
  mcp.seed = async () => { paused = true; await proceed.promise; return seed(); };
  enforce = true;
  const receiving = assert.rejects(mcp.call('receive', { index: 1, hash: incoming.hash }), { code: 'PERMISSION_DENIED' });
  await until(() => paused);
  const admitted = snapshots.at(-1);
  assert.deepEqual(Object.keys(admitted).sort(), ['addresses', 'identity', 'initialized', 'mcpAccess', 'pool', 'settings']);
  assert.equal(admitted.initialized, true);
  assert.equal(admitted.mcpAccess, 'spend');
  assert.equal(admitted.settings.network, 'LOCAL');
  assert.equal(admitted.addresses.find(account => account.index === 1).address, f.addresses[1].address);
  assert.ok(admitted.pool.indexes.includes(1));
  // When the CLI writer removes that account while key access is pending.
  await f.approve({ indexes: [0], consolidate: false });
  proceed.release();
  await receiving;
  // Then the pre-sign callback sees current authority and denies before saving a candidate or publishing.
  assert.ok(snapshots.some(status => !status.pool.indexes.includes(1)));
  assert.equal(f.app.store.get(`receive.LOCAL.${incoming.hash}`), undefined);
  assert.equal(f.state.publicationAttempts.length, 1);
});
