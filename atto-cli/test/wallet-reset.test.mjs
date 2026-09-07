import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const stateUrl = pathToFileURL(join(packageDirectory, 'dist/storage/state.js')).href;
const { StateStore } = await import(stateUrl);
const { AttoApplication } = await import(pathToFileURL(join(packageDirectory, 'dist/application/app.js')).href);
const phrase = `${'abandon '.repeat(23)}art`;
const identity = { address: 'atto_synthetic_reset_identity', fingerprint: 'synthetic-reset-fingerprint' };

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'atto-wallet-reset-'));
  const applications = [];
  let credential = phrase;
  let removals = 0;
  const secrets = {
    async get() { return credential; },
    async set(value) { credential = value; },
    async remove() { removals++; credential = null; },
  };
  const open = (extra = {}) => {
    const app = new AttoApplication({ directory, secrets, ...extra });
    applications.push(app);
    return app;
  };
  const app = open(options);
  app.store.set('identity', identity);
  app.store.set('addresses', [{ index: 0, address: identity.address, publicKey: '00'.repeat(32), active: false }]);
  t.after(async () => {
    for (const application of applications) await application.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, app, open, secrets, credential: () => credential, removals: () => removals };
}

test('confirmed reset clears wallet state and credential while preserving profile and lock identities', async t => {
  // Given
  const { directory, app, open, credential, removals } = fixture(t);
  const profile = JSON.stringify({ version: 1, credentialService: 'Atto MCP' });
  writeFileSync(join(directory, 'profile.json'), profile);
  const release = app.store.tryAccountLocks([0]);
  release();
  const paths = ['state.sqlite', 'coordination.sqlite', 'lifecycle.sqlite', 'account-locks/0.sqlite', 'profile.json'];
  const inodes = paths.map(path => statSync(join(directory, path)).ino);
  app.store.set('spending.mcpAccess', 'spend');
  app.store.set('spending.pool', { indexes: [0, 1], consolidate: true });
  app.store.set('spending.policy', { perRequest: { amount: '3', unit: 'RAW' }, rolling: [] });
  app.store.set('market.terms', { version: 'synthetic' });
  app.store.set('receive.synthetic', { hash: 'synthetic' });
  app.store.set('spending.records', [{ id: 'completed', index: 0, destination: 'synthetic', raw: '1', createdAt: 0, status: 'failed' }]);
  const reviewed = await app.reviewWalletReset();

  // When
  const result = await app.resetWallet(reviewed.identity.fingerprint);
  const reopened = open();
  const status = await reopened.call('wallet_status');

  // Then
  assert.deepEqual(reviewed, { directory, identity, network: 'LIVE' });
  assert.deepEqual(result, { reset: true });
  assert.equal(credential(), null);
  assert.equal(removals(), 1);
  assert.equal(status.initialized, false);
  assert.equal(status.resetPending, false);
  assert.equal(status.mcpAccess, 'read-only');
  assert.deepEqual(status.addresses, []);
  assert.deepEqual(status.pool, { indexes: [0], consolidate: false });
  assert.deepEqual(reopened.ledger.policy(), { perRequest: null, rolling: [] });
  for (const key of ['market.terms', 'receive.synthetic', 'spending.records']) assert.equal(reopened.store.get(key), undefined);
  assert.equal(readFileSync(join(directory, 'profile.json'), 'utf8'), profile);
  assert.deepEqual(paths.map(path => statSync(join(directory, path)).ino), inodes);
  await assert.rejects(app.call('wallet_status'), { code: 'SESSION_CLOSED' });
  const imported = await reopened.createWallet(phrase);
  assert.equal(typeof imported.identity.fingerprint, 'string');
  assert.equal((await reopened.call('wallet_status')).mcpAccess, 'read-only');
});

test('failed credential deletion preserves recoverable state and blocks use until reset resumes', async t => {
  // Given
  const { app, open, secrets, credential } = fixture(t);
  const remove = secrets.remove;
  secrets.remove = async () => { throw new Error('Synthetic keyring failure.'); };

  // When
  await assert.rejects(app.resetWallet(identity.fingerprint), /Synthetic keyring failure/);
  const interrupted = open();
  const status = await interrupted.call('wallet_status');

  // Then
  assert.equal(status.resetPending, true);
  assert.deepEqual(status.identity, identity);
  assert.equal(await interrupted.backupMnemonic(), phrase);
  await assert.rejects(interrupted.createWallet(phrase), { code: 'WALLET_RESET_REQUIRED' });
  await assert.rejects(interrupted.call('address_derive', { index: 1 }), { code: 'WALLET_RESET_REQUIRED' });
  await assert.rejects(interrupted.start(), { code: 'WALLET_RESET_REQUIRED' });
  secrets.remove = remove;
  await interrupted.resetWallet((await interrupted.reviewWalletReset()).identity.fingerprint);
  assert.equal(credential(), null);
  assert.equal((await open().call('wallet_status')).resetPending, false);
});

test('reset resumes when the credential was deleted before interruption was reported', async t => {
  // Given
  const { app, open, secrets, removals } = fixture(t);
  const remove = secrets.remove;
  secrets.remove = async () => { await remove(); throw new Error('Synthetic interruption after deletion.'); };

  // When
  await assert.rejects(app.resetWallet(identity.fingerprint), /Synthetic interruption after deletion/);
  const interrupted = open();
  await assert.rejects(interrupted.backupMnemonic(), { code: 'WALLET_NOT_INITIALIZED' });
  await interrupted.resetWallet(identity.fingerprint);

  // Then
  assert.equal(removals(), 1);
  assert.equal((await open().call('wallet_status')).initialized, false);
});

test('public-state cleanup rolls back atomically if restoring defaults fails', async t => {
  // Given
  const { app, open, credential } = fixture(t);
  const set = app.store.set.bind(app.store);
  app.store.set = (key, value) => {
    if (key === 'settings') throw new Error('Synthetic state write failure.');
    set(key, value);
  };

  // When
  await assert.rejects(app.resetWallet(identity.fingerprint), /Synthetic state write failure/);
  const interrupted = open();
  const status = await interrupted.call('wallet_status');

  // Then
  assert.equal(credential(), null);
  assert.equal(status.resetPending, true);
  assert.deepEqual(status.identity, identity);
  await interrupted.resetWallet(identity.fingerprint);
  assert.equal((await open().call('wallet_status')).initialized, false);
});

test('reset verifies credential deletion before clearing public state', async t => {
  // Given
  const { app, open, secrets, credential } = fixture(t);
  secrets.remove = async () => {};

  // When
  await assert.rejects(app.resetWallet(identity.fingerprint), { code: 'SECRET_STORE_UNAVAILABLE' });
  const status = await open().call('wallet_status');

  // Then
  assert.equal(credential(), phrase);
  assert.equal(status.resetPending, true);
  assert.deepEqual(status.identity, identity);
});

test('reset rejects unsupported stores, MCP callers, and changed confirmation before deletion', async t => {
  // Given
  const unsupported = fixture(t);
  delete unsupported.secrets.remove;
  const mcp = fixture(t, { access: 'mcp' });
  const changed = fixture(t);
  const review = await changed.app.reviewWalletReset();
  changed.app.store.set('identity', { ...identity, fingerprint: 'replacement-wallet' });

  // When / Then
  await assert.rejects(unsupported.app.reviewWalletReset(), { code: 'SECRET_STORE_UNSUPPORTED' });
  await assert.rejects(unsupported.app.resetWallet(identity.fingerprint), { code: 'SECRET_STORE_UNSUPPORTED' });
  await assert.rejects(mcp.app.reviewWalletReset(), { code: 'LOCAL_APPROVAL_REQUIRED' });
  await assert.rejects(mcp.app.resetWallet(identity.fingerprint), { code: 'LOCAL_APPROVAL_REQUIRED' });
  await assert.rejects(changed.app.resetWallet(review.identity.fingerprint), { code: 'WALLET_CHANGED' });
  for (const value of [unsupported, mcp, changed]) {
    assert.equal(value.credential(), phrase);
    assert.equal(value.removals(), 0);
  }
  assert.equal(changed.open().store.get('wallet.reset'), undefined);
});

test('pending payments prevent both review and a reset after confirmation', async t => {
  // Given
  for (const status of ['reserved', 'signed', 'unknown']) {
    const { app, open, credential, removals } = fixture(t);
    const review = await app.reviewWalletReset();
    app.store.set('spending.records', [{ id: `pending-${status}`, index: 0, destination: 'synthetic', raw: '1', createdAt: 0, status,
      ...(status === 'signed' ? { hash: 'synthetic', blockJson: '{}' } : {}) }]);

    // When / Then
    await assert.rejects(app.reviewWalletReset(), { code: 'PUBLICATION_UNCERTAIN' });
    await assert.rejects(app.resetWallet(review.identity.fingerprint), { code: 'PUBLICATION_UNCERTAIN' });
    assert.equal(credential(), phrase);
    assert.equal(removals(), 0);
    assert.equal(open().store.get('wallet.reset'), undefined);
  }
});

test('another session blocks reset and cannot silently adopt a replacement wallet', async t => {
  // Given
  const { app, open, removals } = fixture(t);
  const other = open({ access: 'mcp' });

  // When
  await assert.rejects(app.resetWallet(identity.fingerprint), { code: 'WALLET_BUSY' });
  const unchanged = await other.call('wallet_status');
  await other.close();
  const retry = open();
  await retry.resetWallet(identity.fingerprint);

  // Then
  assert.deepEqual(unchanged.identity, identity);
  assert.equal(removals(), 1);
  await assert.rejects(other.call('wallet_status'), { code: 'SESSION_CLOSED' });
  assert.equal((await open().call('wallet_status')).initialized, false);
});

test('active recovery reads, facade calls, and started sessions cannot reset themselves', async t => {
  // Given
  const { app, secrets, credential } = fixture(t);
  let finishRead;
  secrets.get = () => new Promise(resolve => { finishRead = resolve; });
  const backup = app.backupMnemonic();

  // When / Then
  await assert.rejects(app.resetWallet(identity.fingerprint), { code: 'WALLET_BUSY' });
  finishRead(phrase);
  assert.equal(await backup, phrase);
  const status = app.call('wallet_status');
  await assert.rejects(app.resetWallet(identity.fingerprint), { code: 'WALLET_BUSY' });
  await status;
  await app.start();
  await assert.rejects(app.resetWallet(identity.fingerprint), { code: 'WALLET_BUSY' });
  assert.equal(credential(), phrase);
});

test('an in-progress local import rejects reset without closing its application', async t => {
  // Given
  const { app, secrets } = fixture(t);
  app.store.set('identity', null);
  app.store.set('addresses', []);
  const get = secrets.get;
  let entered;
  let finish;
  const reading = new Promise(resolve => { entered = resolve; });
  secrets.get = async () => { entered(); return new Promise(resolve => { finish = resolve; }); };
  const importing = app.createWallet(phrase);
  await reading;

  // When
  await assert.rejects(app.resetWallet(null), { code: 'WALLET_BUSY' });
  finish(phrase);
  await importing;
  secrets.get = get;

  // Then
  assert.equal((await app.call('wallet_status')).initialized, true);
  assert.equal(await app.backupMnemonic(), phrase);
  assert.equal(app.store.get('wallet.reset'), undefined);
});

test('a signing account lock also blocks reset without touching the credential', async t => {
  // Given: this connection models a process using the earlier account-lock protocol.
  const { directory, app, open, removals } = fixture(t);
  app.store.tryAccountLocks([0])();
  const account = new DatabaseSync(join(directory, 'account-locks', '0.sqlite'));
  account.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;');

  // When
  try { await assert.rejects(app.resetWallet(identity.fingerprint), { code: 'WALLET_BUSY' }); }
  finally { account.close(); }

  // Then
  assert.equal(removals(), 0);
  assert.equal(open().store.get('wallet.reset'), undefined);
});

test('a reset in progress excludes new sessions before they open public state', async t => {
  // Given
  const { directory, app, open, secrets } = fixture(t);
  let entered;
  let finish;
  const deleting = new Promise(resolve => { entered = resolve; });
  const remove = secrets.remove;
  secrets.remove = async () => { entered(); await new Promise(resolve => { finish = resolve; }); await remove(); };

  // When
  const reset = app.resetWallet(identity.fingerprint);
  await deleting;
  assert.throws(() => new StateStore(directory), { code: 'WALLET_BUSY' });
  await assert.rejects(app.call('wallet_status'), { code: 'WALLET_BUSY' });
  finish();
  await reset;

  // Then
  assert.equal((await open().call('wallet_status')).initialized, false);
});

test('failed state construction releases its lifecycle lease', async t => {
  // Given
  const directory = mkdtempSync(join(tmpdir(), 'atto-reset-constructor-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = new DatabaseSync(join(directory, 'state.sqlite'));
  database.exec('PRAGMA user_version = 999;');
  database.close();

  // When
  assert.throws(() => new StateStore(directory), { code: 'STATE_VERSION' });
  const lifecycle = new DatabaseSync(join(directory, 'lifecycle.sqlite'));

  // Then
  try { lifecycle.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE; ROLLBACK;'); }
  finally { lifecycle.close(); }
});

test('session process death releases the lifecycle lease for reset', { timeout: 15_000 }, async t => {
  // Given
  const { directory, app, open } = fixture(t);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { StateStore } from ${JSON.stringify(stateUrl)};
    const store = new StateStore(process.argv[1]);
    process.on('message', () => {});
    process.send('ready');
  `, directory], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => child.kill());
  await once(child, 'message');

  // When
  await assert.rejects(app.resetWallet(identity.fingerprint), { code: 'WALLET_BUSY' });
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  await exit;
  await open().resetWallet(identity.fingerprint);

  // Then
  assert.equal((await open().call('wallet_status')).initialized, false);
});
