import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { tmpdir } from '../../test/support/temporary-directory.mjs';

const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const moduleUrl = path => pathToFileURL(join(cliDirectory, 'dist', path)).href;
const { AttoApplication } = await import(moduleUrl('application/app.js'));
const { StateStore } = await import(moduleUrl('storage/state.js'));
const { OsSecretStore } = await import(moduleUrl('storage/secrets.js'));
const { inspectMarketplaceWalletSetup, withUnchangedMarketplaceWalletSetup } = await import(moduleUrl('internal-marketplace.js'));
const recoveryPhrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

function terminal(t, enabled = true) {
  for (const stream of [process.stdin, process.stderr]) {
    const previous = Object.getOwnPropertyDescriptor(stream, 'isTTY');
    Object.defineProperty(stream, 'isTTY', { configurable: true, value: enabled });
    t.after(() => {
      if (previous) Object.defineProperty(stream, 'isTTY', previous);
      else delete stream.isTTY;
    });
  }
}

async function fixture(t, initialize = true) {
  const root = await mkdtemp(join(tmpdir(), 'marketplace-wallet-inspection-'));
  const directory = join(root, 'wallet');
  t.after(() => rm(root, { recursive: true, force: true }));
  const open = () => new AttoApplication({ directory, secrets: {
    get: async () => recoveryPhrase, set: async () => {}, remove: async () => {},
  } });
  if (initialize) {
    const application = open();
    try {
      await application.createWallet(recoveryPhrase);
      await application.call('address_derive', { index: 1 });
      application.ledger.setPolicy({ perRequest: { amount: '5', unit: 'ATTO' }, rolling: [{ days: 2, amount: '12', unit: 'ATTO' }] });
      application.store.set('spending.mcpAccess', 'spend');
      application.store.set('spending.pool', { indexes: [0], consolidate: true });
      application.store.set('signing.messageIndexes', [0]);
      application.ledger.reserve({ id: 'preserved-payment', index: 0, destination: application.store.get('identity').address,
        raw: '1000', network: 'LIVE', createdAt: Date.now() });
      application.ledger.proposePolicy({ perRequest: { amount: '2', unit: 'ATTO' }, rolling: [] }, 'read-only', {
        directory, walletFingerprint: application.store.get('identity').fingerprint, network: 'LIVE',
      });
    } finally { await application.close(); }
  }
  return { root, directory, open };
}

function savedRows(directory) {
  const store = new StateStore(directory);
  try { return store.entries(''); }
  finally { store.close(); }
}

function options(f, expected) {
  return { directory: f.directory, index: 0, expected, terminalConfirmed: true };
}

test('saved wallet inspection and unchanged selection preserve every public row without credentials or networking', async t => {
  // Given a wallet with active grants, unfinished payments, and a pending proposal.
  const f = await fixture(t);
  terminal(t);
  const before = savedRows(f.directory);
  const filesBefore = (await readdir(f.directory)).filter(file => file.endsWith('.json'));
  let credentialCalls = 0;
  let networkCalls = 0;
  for (const method of ['get', 'set', 'remove']) t.mock.method(OsSecretStore.prototype, method, () => {
    credentialCalls++;
    throw new Error('Inspection must not access credentials');
  });
  t.mock.method(globalThis, 'fetch', () => { networkCalls++; throw new Error('Inspection must not access the network'); });
  t.mock.method(AttoApplication.prototype, 'call', () => { throw new Error('Inspection must not execute wallet operations'); });

  // When setup inspects and records its own approved selection.
  const snapshot = await inspectMarketplaceWalletSetup({ directory: f.directory, index: 0 });
  let selected = false;
  const result = await withUnchangedMarketplaceWalletSetup(options(f, snapshot), async () => { selected = true; return 'saved'; });

  // Then only the caller-owned selection runs; wallet grants and journals remain intact.
  assert.equal(result, 'saved');
  assert.equal(selected, true);
  assert.equal(credentialCalls, 0);
  assert.equal(networkCalls, 0);
  assert.equal(snapshot.network, 'atto:live');
  assert.equal(snapshot.fingerprint, snapshot.identity.fingerprint);
  assert.equal(snapshot.address, snapshot.addresses.find(value => value.index === 0).address);
  assert.equal(snapshot.access, 'spend');
  assert.deepEqual(snapshot.pool, { indexes: [0], consolidate: true });
  assert.deepEqual(snapshot.messageSigningIndexes, [0]);
  assert.match(snapshot.formattedLimits, /Per payment: 5 ATTO; rolling: 12 ATTO \/ 2 days/);
  assert.equal(snapshot.proposal.status, 'pending');
  assert.deepEqual(savedRows(f.directory), before);
  assert.deepEqual((await readdir(f.directory)).filter(file => file.endsWith('.json')), filesBefore);
});

test('inspection requires a real local terminal and explicit existing initialized wallet', async t => {
  // Given an absent wallet and a non-terminal caller.
  const f = await fixture(t, false);
  terminal(t, false);

  // When inspection is requested without terminal access.
  await assert.rejects(inspectMarketplaceWalletSetup({ directory: f.directory, index: 0 }), { code: 'TERMINAL_REQUIRED' });

  // Then no profile or wallet is initialized, even after terminal input validation.
  await assert.rejects(access(f.directory));
  for (const stream of [process.stdin, process.stderr]) Object.defineProperty(stream, 'isTTY', { configurable: true, value: true });
  await assert.rejects(inspectMarketplaceWalletSetup({ directory: 'relative', index: 0 }), { code: 'INVALID_INPUT' });
  await assert.rejects(inspectMarketplaceWalletSetup({ directory: f.directory, index: -1 }), { code: 'INVALID_INPUT' });
  await assert.rejects(inspectMarketplaceWalletSetup({ directory: f.directory, index: 0 }), { code: 'WALLET_NOT_INITIALIZED' });
  await assert.rejects(access(f.directory));
  const store = new StateStore(f.directory);
  store.close();
  const before = savedRows(f.directory);
  await assert.rejects(inspectMarketplaceWalletSetup({ directory: f.directory, index: 0 }), { code: 'WALLET_NOT_INITIALIZED' });
  assert.deepEqual(savedRows(f.directory), before);
});

test('an unsaved account index fails without deriving its address or reading credentials', async t => {
  // Given an initialized wallet with only index zero saved.
  const f = await fixture(t);
  terminal(t);
  const before = savedRows(f.directory);
  t.mock.method(OsSecretStore.prototype, 'get', () => { throw new Error('No credential read is allowed'); });

  // When setup selects an index requiring advanced wallet setup.
  await assert.rejects(inspectMarketplaceWalletSetup({ directory: f.directory, index: 9 }), { code: 'MARKETPLACE_ADVANCED_SETUP_REQUIRED' });

  // Then no address, grant, proposal, or financial journal changes.
  assert.deepEqual(savedRows(f.directory), before);
});

const changes = {
  'network': store => store.set('settings', { ...store.get('settings'), network: 'LOCAL' }),
  'node endpoint': store => store.set('settings', { ...store.get('settings'), nodeUrl: 'http://127.0.0.1:40001' }),
  'worker endpoint': store => store.set('settings', { ...store.get('settings'), workerUrl: 'http://127.0.0.1:40002' }),
  'receiving settings': store => store.set('settings', { ...store.get('settings'), autoReceive: !store.get('settings').autoReceive }),
  'wallet fingerprint': store => store.set('identity', { ...store.get('identity'), fingerprint: 'ff'.repeat(32) }),
  'identity address': store => store.set('identity', { ...store.get('identity'), address: store.get('addresses').find(value => value.index === 1).address }),
  'selected saved address': store => store.set('addresses', store.get('addresses').map(value => value.index === 0 ? { ...value, address: store.get('addresses').find(saved => saved.index === 1).address } : value)),
  'selected public key': store => store.set('addresses', store.get('addresses').map(value => ({ ...value, publicKey: 'ff'.repeat(32) }))),
  'account activation': store => store.set('addresses', store.get('addresses').map(value => ({ ...value, active: !value.active }))),
  'per-payment policy': store => store.set('spending.policy', { perRequest: { amount: '4', unit: 'ATTO' }, rolling: [{ days: 2, amount: '12', unit: 'ATTO' }] }),
  'rolling policy': store => store.set('spending.policy', { perRequest: { amount: '5', unit: 'ATTO' }, rolling: [{ days: 1, amount: '12', unit: 'ATTO' }] }),
  'access': store => store.set('spending.mcpAccess', 'read-only'),
  'pool indexes': store => store.set('spending.pool', { indexes: [0, 1], consolidate: true }),
  'consolidation': store => store.set('spending.pool', { indexes: [0], consolidate: false }),
  'message signing': store => store.set('signing.messageIndexes', []),
  'authority revision': store => store.set('spending.policyRevision', store.get('spending.policyRevision') + 1),
  'pending proposal': store => store.set('spending.proposal', { ...store.get('spending.proposal'), id: 'another-terminal-proposal' }),
};
for (const [name, change] of Object.entries(changes)) {
  test(`changed ${name} rejects the reviewed snapshot before saving Marketplace selections`, async t => {
    // Given a saved setup snapshot and a later wallet change.
    const f = await fixture(t);
    terminal(t);
    const expected = await inspectMarketplaceWalletSetup({ directory: f.directory, index: 0 });
    const store = new StateStore(f.directory);
    try { await store.withWalletLock(async () => change(store)); }
    finally { store.close(); }
    const changed = savedRows(f.directory);
    let called = false;

    // When setup attempts its compare-and-save operation.
    await assert.rejects(withUnchangedMarketplaceWalletSetup(options(f, expected), async () => { called = true; }), { code: 'PROPOSAL_STALE' });

    // Then the selection callback never runs and the newer wallet state is preserved.
    assert.equal(called, false);
    assert.deepEqual(savedRows(f.directory), changed);
  });
}

test('inspection and approval preserve the reset fence', async t => {
  // Given a reviewed wallet followed by an interrupted reset.
  const f = await fixture(t);
  terminal(t);
  const expected = await inspectMarketplaceWalletSetup({ directory: f.directory, index: 0 });
  const store = new StateStore(f.directory);
  store.set('wallet.reset', { fingerprint: expected.fingerprint });
  store.close();
  let called = false;

  // When either setup phase encounters the reset marker.
  await assert.rejects(inspectMarketplaceWalletSetup({ directory: f.directory, index: 0 }), { code: 'WALLET_RESET_REQUIRED' });
  await assert.rejects(withUnchangedMarketplaceWalletSetup(options(f, expected), async () => { called = true; }), { code: 'WALLET_RESET_REQUIRED' });

  // Then reset recovery remains mandatory and Marketplace preferences are untouched.
  assert.equal(called, false);
  assert.deepEqual(savedRows(f.directory).find(row => row.key === 'wallet.reset').value, { fingerprint: expected.fingerprint });
});

test('human review holds no lock, while final selection persistence owns the wallet lock and releases it on failure', async t => {
  // Given a wallet inspected before the user reviews terminal prompts.
  const f = await fixture(t);
  terminal(t);
  const expected = await inspectMarketplaceWalletSetup({ directory: f.directory, index: 0 });
  const competitor = new StateStore(f.directory);
  t.after(() => competitor.close());
  let entered = false;
  await competitor.withWalletLock(async () => { entered = true; });
  assert.equal(entered, true);
  entered = false;
  let competing;

  // When final persistence runs, another session waits until the callback finishes.
  await assert.rejects(withUnchangedMarketplaceWalletSetup(options(f, expected), async () => {
    competing = competitor.withWalletLock(async () => { entered = true; });
    await delay(60);
    assert.equal(entered, false);
    throw new Error('Selection save failed');
  }), /Selection save failed/);
  await competing;

  // Then the competing operation and an exclusive lifecycle operation can proceed.
  assert.equal(entered, true);
  await competitor.withExclusiveReset(async () => {});
});

test('missing explicit terminal confirmation never executes selection persistence', async t => {
  // Given an inspected wallet in a terminal.
  const f = await fixture(t);
  terminal(t);
  const expected = await inspectMarketplaceWalletSetup({ directory: f.directory, index: 0 });
  let called = false;

  // When a caller omits the typed terminal confirmation.
  await assert.rejects(withUnchangedMarketplaceWalletSetup({ ...options(f, expected), terminalConfirmed: false }, async () => { called = true; }), { code: 'LOCAL_APPROVAL_REQUIRED' });

  // Then no selection is saved.
  assert.equal(called, false);
});


test('read-only unlimited authority remains available for login-only setup without an upgrade', async t => {
  // Given an existing wallet with read-only access and unlimited native policy.
  const f = await fixture(t);
  terminal(t);
  const application = f.open();
  try {
    application.ledger.setPolicy({ perRequest: null, rolling: [] });
    application.store.set('spending.mcpAccess', 'read-only');
    application.store.set('signing.messageIndexes', []);
  } finally { await application.close(); }
  const before = savedRows(f.directory);

  // When a login-only selection reviews and rechecks the existing wallet.
  const expected = await inspectMarketplaceWalletSetup({ directory: f.directory, index: 0 });
  const selected = await withUnchangedMarketplaceWalletSetup(options(f, expected), async () => 'login-only');

  // Then setup does not infer or approve any native spending or signing grants.
  assert.equal(selected, 'login-only');
  assert.equal(expected.access, 'read-only');
  assert.equal(expected.formattedLimits, 'Per payment: Unlimited; rolling: Unlimited');
  assert.deepEqual(savedRows(f.directory), before);
});


test('legacy wallet schemas are rejected before ordinary wallet opening can migrate them', async t => {
  // Given an existing legacy wallet schema requiring an explicit CLI upgrade.
  const f = await fixture(t);
  terminal(t);
  const database = new DatabaseSync(join(f.directory, 'state.sqlite'));
  const before = database.prepare('SELECT key, value FROM settings ORDER BY key').all();
  database.exec('PRAGMA user_version = 1;');
  database.close();

  // When compact setup inspects that profile.
  await assert.rejects(inspectMarketplaceWalletSetup({ directory: f.directory, index: 0 }), { code: 'STATE_VERSION' });

  // Then both the legacy schema version and every saved wallet row remain unchanged.
  const after = new DatabaseSync(join(f.directory, 'state.sqlite'), { readOnly: true });
  try {
    assert.equal(after.prepare('PRAGMA user_version').get().user_version, 1);
    assert.deepEqual(after.prepare('SELECT key, value FROM settings ORDER BY key').all(), before);
  } finally { after.close(); }
});


test('saved identity and account fields reject terminal control text before returning a review snapshot', async t => {
  // Given a corrupted saved public address containing terminal control text.
  const f = await fixture(t);
  terminal(t);
  const store = new StateStore(f.directory);
  store.set('addresses', store.get('addresses').map(value => value.index === 0 ? { ...value, address: '\u001b[2Junsafe' } : value));
  store.close();
  const before = savedRows(f.directory);

  // When compact setup tries to prepare a terminal review.
  await assert.rejects(inspectMarketplaceWalletSetup({ directory: f.directory, index: 0 }), { code: 'INVALID_STATE' });

  // Then the unsafe value is never returned for display or rewritten implicitly.
  assert.deepEqual(savedRows(f.directory), before);
});
