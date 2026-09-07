import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { interruptCli, sigintHarness } from './support/signals.mjs';

const execute = promisify(execFile);
const directory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const moduleUrl = name => pathToFileURL(join(directory, 'dist', name)).href;
const { AttoApplication } = await import(moduleUrl('application/app.js'));
const { parseOperation } = await import(moduleUrl('application/operations.js'));
const main = join(directory, 'dist/cli/main.js');

async function fixture(t) {
  const profile = await mkdtemp(join(tmpdir(), 'atto-usability-'));
  let phrase;
  const secrets = { get: async () => phrase, set: async value => { phrase = value; } };
  const sessions = [];
  const open = () => { const app = new AttoApplication({ directory: profile, secrets }); sessions.push(app); return app; };
  const app = open();
  const paths = [];
  const http = createServer((request, response) => {
    paths.push(request.url);
    response.writeHead(404);
    response.end();
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const nodeUrl = `http://127.0.0.1:${http.address().port}`;
  await app.call('wallet_configure', { nodeUrl, workerUrl: nodeUrl, autoReceive: false });
  t.after(async () => {
    for (const session of sessions.reverse()) await session.close();
    http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
    await rm(profile, { recursive: true, force: true });
  });
  const run = args => execute(process.execPath, [main, '--data-dir', profile, ...args], {
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1' }, timeout: 10_000,
  });
  return { app, open, profile, paths, run };
}

test('Adding accounts atomically allocates after the highest saved index and activates them', async t => {
  // Given two sessions sharing a wallet with a gap in its saved indexes.
  const f = await fixture(t);
  await f.app.createWallet();
  await f.app.call('address_derive', { index: 4 });
  const second = f.open();

  // When both sessions add an address concurrently.
  const added = await Promise.all([f.app.call('address_add'), second.call('address_add')]);

  // Then each receives a distinct active address without any network account creation.
  assert.deepEqual(added.map(value => value.index).sort(), [5, 6]);
  assert.equal(new Set(added.map(value => value.address)).size, 2);
  assert.ok(added.every(value => value.active));
  assert.deepEqual((await f.app.call('address_list')).addresses.map(value => [value.index, value.active]), [[0, true], [4, false], [5, true], [6, true]]);
  assert.deepEqual(f.paths, []);
  await f.app.call('address_derive', { index: 2147483647 });
  await assert.rejects(f.app.call('address_add'), { code: 'INDEX_LIMIT' });
});

test('Balance selection distinguishes active, all, saved indexes, and foreign addresses', async t => {
  // Given an active wallet account, an inactive derived account, and a foreign address.
  const f = await fixture(t);
  await f.app.createWallet();
  const inactive = await f.app.call('address_derive', { index: 1 });
  const active = (await f.app.call('address_list')).addresses[0];
  const foreign = (await f.app.call('wallet_status')).settings.representative;

  // When each public selection is queried through the real reader against unopened accounts.
  const normal = await f.app.call('balances_get');
  const all = await f.app.call('balances_get', { all: true });
  const selected = await f.app.call('balances_get', { index: 1 });
  const external = await f.app.call('balances_get', { addresses: [foreign] });

  // Then only matching saved addresses gain wallet indexes and activation metadata.
  assert.deepEqual(normal.balances.map(value => value.address), [active.address]);
  assert.deepEqual(all.balances.map(value => [value.index, value.active]), [[0, true], [1, false]]);
  assert.equal(selected.balances[0].address, inactive.address);
  assert.equal(external.balances[0].address, foreign);
  assert.equal(Object.hasOwn(external.balances[0], 'index'), false);
  assert.deepEqual(all.total, { raw: '0', atto: '0' });
  const cli = JSON.parse((await f.run(['--json', 'balances', '--all'])).stdout).result;
  assert.deepEqual(cli, all);
  await assert.rejects(f.app.call('balances_get', { index: 2 }), { code: 'ADDRESS_NOT_DERIVED' });
});

test('Read schemas reject ambiguous scopes, removed names, and unsupported cursors', () => {
  // Given the shared public schemas used by the CLI and MCP.
  assert.equal(parseOperation('history_list').event, 'entry');
  for (const name of ['balances_get', 'history_list', 'receivables_list']) {
    // When the caller combines two account selectors, input must be rejected.
    assert.throws(() => parseOperation(name, { index: 0, addresses: ['atto_test'] }), { code: 'INVALID_INPUT' });
  }
  for (const input of [{ all: true, index: 0 }, { all: true, addresses: ['atto_test'] }]) {
    assert.throws(() => parseOperation('balances_get', input), { code: 'INVALID_INPUT' });
  }
  assert.throws(() => parseOperation('receivables_list', { cursor: 'unsupported' }), { code: 'INVALID_INPUT' });
  assert.throws(() => parseOperation('wallet_configure'), { code: 'INVALID_INPUT' });
  for (const name of ['limits_set', 'voter_weight']) assert.throws(() => parseOperation(name), { code: 'UNKNOWN_OPERATION' });
  for (const input of [{ event: 'receivable', networkWide: true }, { event: 'transaction', hash: 'A'.repeat(64), index: 0 }, { event: 'account', networkWide: true, addresses: ['atto_test'] }]) {
    assert.throws(() => parseOperation('watch_start', input), { code: 'INVALID_INPUT' });
  }
  for (const input of [{}, { destination: 'atto_test', destinationIndex: 1 }]) {
    assert.throws(() => parseOperation('send', { ...input, amount: '1', requestId: 'scope-test' }), { code: 'INVALID_INPUT' });
  }
});

test('Watch defaults are wallet scoped, with explicit foreign and network-wide alternatives', async t => {
  // Given active and inactive accounts in a wallet whose receiving is disabled.
  const f = await fixture(t);
  await f.app.createWallet();
  const inactive = await f.app.call('address_derive', { index: 1 });
  const active = (await f.app.call('address_list')).addresses[0];
  const foreign = (await f.app.call('wallet_status')).settings.representative;

  // When callers choose the default scope or explicitly select another scope.
  const watch = input => f.app.call('watch_start', { event: 'transaction', ...input });
  assert.deepEqual((await watch({})).filter.addresses, [active.address]);
  assert.deepEqual((await watch({ index: 1 })).filter.addresses, [inactive.address]);
  assert.deepEqual((await watch({ addresses: [foreign] })).filter.addresses, [foreign]);
  assert.equal((await watch({ networkWide: true })).filter.addresses, undefined);
  assert.equal((await watch({ hash: 'A'.repeat(64) })).filter.hash, 'A'.repeat(64));

  // Then no receiving session starts and an empty default scope cannot become a global watch.
  assert.equal((await f.app.call('wallet_status')).autoReceive.running, false);
  await f.app.call('address_deactivate', { index: 0 });
  await assert.rejects(watch({}), { code: 'NO_ACTIVE_ACCOUNTS' });
});

test('CLI configuration toggles preserve omitted fields and receiving fails promptly when unusable', async t => {
  // Given a profile without a wallet; no command may prompt for or read credentials.
  const f = await fixture(t);
  const failure = async (args, code) => assert.rejects(f.run(['--json', ...args]), error => {
    assert.equal(JSON.parse(error.stdout).error.code, code);
    return true;
  });
  await failure(['wallet', 'receive'], 'WALLET_NOT_INITIALIZED');
  await failure(['wallet', 'configure'], 'INVALID_INPUT');
  await f.app.createWallet();
  await failure(['wallet', 'receive'], 'AUTO_RECEIVE_DISABLED');

  // When one setting or its explicit toggle changes.
  await f.run(['wallet', 'configure', '--auto-receive']);
  await f.run(['wallet', 'configure', '--min-receive-raw', '2']);
  let status = await f.app.call('wallet_status');
  assert.equal(status.settings.autoReceive, true);
  assert.equal(status.settings.minReceiveRaw, '2');
  assert.equal(status.directory, f.profile);
  await f.app.call('address_deactivate', { index: 0 });
  await failure(['wallet', 'receive'], 'NO_ACTIVE_ACCOUNTS');
  await f.run(['wallet', 'configure', '--no-auto-receive']);
  status = await f.app.call('wallet_status');
  assert.equal(status.settings.autoReceive, false);
  assert.equal(status.settings.minReceiveRaw, '2');
  assert.deepEqual(f.paths, []);
});

test('Real CLI watch reports an idle connection failure without starting receiving or reading credentials', { timeout: 15_000 }, async t => {
  // Given an initialized profile with automatic receiving enabled and an unavailable stream.
  const f = await fixture(t);
  await f.app.createWallet();
  await f.app.call('wallet_configure', { autoReceive: true });
  const harness = `
    ${sigintHarness}
    const { AttoApplication } = await import(process.env.ATTO_TEST_APP);
    const { OsSecretStore } = await import(process.env.ATTO_TEST_SECRETS);
    let starts = 0, secretReads = 0;
    AttoApplication.prototype.start = async () => { starts++; throw new Error('Unexpected receiver startup'); };
    OsSecretStore.prototype.get = async () => { secretReads++; throw new Error('Unexpected credential access'); };
    process.argv = [process.execPath, 'atto', '--data-dir', process.env.ATTO_TEST_PROFILE, 'watch', 'account'];
    await import(process.env.ATTO_TEST_MAIN);
    process.send({ starts, secretReads });
    process.disconnect();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', harness], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1', ATTO_TEST_APP: moduleUrl('application/app.js'),
      ATTO_TEST_SECRETS: moduleUrl('storage/secrets.js'), ATTO_TEST_PROFILE: f.profile, ATTO_TEST_MAIN: moduleUrl('cli/main.js') },
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
  t.after(() => { clearTimeout(timeout); child.kill('SIGKILL'); });
  let stdout = '', stderr = '', trace, interrupted = false;
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (!interrupted && stdout.includes('Last error:')) { interrupted = true; interruptCli(child); }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('message', value => { trace = value; });

  // When the Commons watch fails before receiving any event, the CLI reports it and can stop.
  const [code, signal] = await once(child, 'close');

  // Then a single Ctrl+C exits cleanly and observation has no signing side effects.
  assert.equal(code, 0, stdout + stderr);
  assert.equal(signal, null);
  assert.equal(interrupted, true);
  assert.match(stdout, /Status: reconnecting/);
  assert.match(stdout, /Events: None/);
  assert.deepEqual(trace, { starts: 0, secretReads: 0 });
  assert.ok(f.paths.length > 0);
  assert.equal(f.paths.some(path => path.includes('receivable')), false);
});
