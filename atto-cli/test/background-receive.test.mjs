import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fixture, gate, until } from './support/payments.mjs';
import { cli, credentialEnvironment, moduleUrl } from './support/detached.mjs';

const { BackgroundReceiver } = await import(moduleUrl('wallet/background-receive.js'));
const controller = f => new BackgroundReceiver(f.app.store);
const receiveCount = f => f.state.publications.filter(value => JSON.parse(value.block.toJson()).type === 'RECEIVE').length;
// A transient lookup/work failure uses the real ten-second receive retry.
const received = (f, count) => until(() => receiveCount(f) === count, 20_000);
async function enable(f) {
  await f.app.call('address_activate', { index: 1 });
  await f.app.call('wallet_configure', { autoReceive: true });
}

test('background receiving survives CLI exit, reconnects, and shares account recovery with CLI and MCP', { timeout: 60_000 }, async t => {
  // Given an isolated synthetic wallet; only the detached child receives automatically.
  const f = await fixture(t, [20, 0]);
  const env = await credentialEnvironment(t, f.mnemonic());
  await enable(f);
  const starts = await Promise.all([cli(f.directory, ['wallet', 'receive', '--background'], env), cli(f.directory, ['wallet', 'receive', '--background'], env)]);
  assert.ok(starts.every(value => value.backgroundReceive.state === 'running'));
  const token = f.app.store.get('receive.background').token;
  await until(() => f.state.streams.size === 1);

  // When payments arrive after both launching CLI processes have exited.
  const first = await f.app.call('send', f.request('background-first', '3', { destination: f.addresses[1].address }));
  await received(f, 1);
  const retry = await f.app.call('receive', { index: 1, hash: first.hash });
  assert.equal(retry.status, 'received');
  await until(async () => (await f.app.call('pool_get')).accounts.find(value => value.index === 1).workReady);
  for (const stream of f.state.streams) stream.response.end();
  await until(() => controller(f).status().lastError !== null);
  await until(() => f.state.streams.size === 1);
  const mcp = f.open('mcp');
  await mcp.start();
  const second = await f.app.call('send', f.request('background-second', '2', { destination: f.addresses[1].address }));
  await received(f, 2);
  await f.app.call('receive', { index: 1, hash: second.hash });
  // Either supervisor can win. The other settles any busy/lookup retry through
  // the shared journal on its normal ten-second retry cadence.
  await until(() => controller(f).status().lastError === null, 15_000);

  // Then reconciliation prevents duplicate receives and background status is separate.
  assert.equal(receiveCount(f), 2);
  assert.equal(f.app.store.get('receive.background').token, token);
  const status = await f.app.call('wallet_status');
  assert.equal(status.autoReceive.running, false);
  assert.equal(status.backgroundReceive.state, 'running');
  assert.equal(status.backgroundReceive.lastError, null);
  await cli(f.directory, ['wallet', 'receive', 'stop'], env);
  await until(() => controller(f).status().state === 'stopped');
  assert.equal((await cli(f.directory, ['wallet', 'receive', 'stop'], env)).backgroundReceive.state, 'stopped');
});

test('stop retains singleton ownership until the current publication finishes and reset stays blocked', { timeout: 30_000 }, async t => {
  // Given a receiver whose accepted publication has not yet been acknowledged.
  const f = await fixture(t, [10, 0]);
  const env = await credentialEnvironment(t, f.mnemonic());
  const sent = await f.app.call('send', f.request('held-receive', '1', { destination: f.addresses[1].address }));
  await enable(f);
  f.state.holdPublications = gate();
  await cli(f.directory, ['wallet', 'receive', '--background'], env);
  await received(f, 1);

  // When stop and another start are requested during that operation.
  assert.equal((await cli(f.directory, ['wallet', 'receive', 'stop'], env)).backgroundReceive.state, 'stopping');
  assert.equal((await cli(f.directory, ['wallet', 'receive', '--background'], env)).backgroundReceive.state, 'stopping');
  assert.equal(f.app.store.tryAccountLocks([1]), undefined);
  await assert.rejects(f.app.resetWallet(f.app.store.get('identity').fingerprint), { code: 'WALLET_BUSY' });
  f.state.holdPublications.release();
  await until(() => controller(f).status().state === 'stopped');

  // Then shutdown completes only after the receive journal has its result.
  assert.ok(f.app.store.get(`receive.LOCAL.${sent.hash}`).result);
  const release = f.app.store.tryAccountLocks([1]);
  assert.ok(release);
  release();
  assert.equal(receiveCount(f), 1);
});

test('unavailable credentials are reported and background start grants no MCP spending access', { timeout: 20_000 }, async t => {
  // Given pending funds and no accessible password store in the detached child.
  const f = await fixture(t, [10, 0]);
  await f.app.call('send', f.request('unavailable-credentials', '1', { destination: f.addresses[1].address }));
  await f.approve(undefined, 'read-only');
  await enable(f);
  const env = await credentialEnvironment(t, f.mnemonic(), 'unavailable');

  // When local initialization succeeds but the receive cannot retrieve credentials.
  assert.equal((await cli(f.directory, ['wallet', 'receive', '--background'], env)).backgroundReceive.state, 'running');
  await until(() => controller(f).status().lastError?.code === 'SECRET_STORE_UNAVAILABLE');

  // Then only receive status records the failure; no payment or MCP access changes.
  assert.equal(receiveCount(f), 0);
  assert.equal((await f.app.call('wallet_status')).mcpAccess, 'read-only');
  await assert.rejects(f.open('mcp').call('send', f.request('mcp-denied')), { code: 'MCP_READ_ONLY' });
});

test('background receiving respects disabled receiving, active addresses and the current minimum', { timeout: 30_000 }, async t => {
  // Given automatic receiving disabled and a valid synthetic wallet.
  const f = await fixture(t, [10, 0]);
  const env = await credentialEnvironment(t, f.mnemonic());
  await assert.rejects(controller(f).start(), { code: 'AUTO_RECEIVE_DISABLED' });
  await f.app.call('wallet_configure', { autoReceive: true, minReceiveRaw: '2' });
  await f.app.call('send', f.request('below-minimum', '1', { destination: f.addresses[1].address }));
  await cli(f.directory, ['wallet', 'receive', '--background'], env);
  await delay(500);
  assert.equal(receiveCount(f), 0);

  // When the inactive recipient is activated, its amount is still below the minimum.
  await f.app.call('address_activate', { index: 1 });
  await until(() => f.state.requests.some(value => value.path === '/accounts/receivables/stream'));
  await delay(500);
  assert.equal(receiveCount(f), 0);
  await f.app.call('wallet_configure', { minReceiveRaw: '1' });

  // Then the next configuration snapshot permits exactly one receive.
  await received(f, 1);
  await f.app.call('wallet_configure', { autoReceive: false });
  await delay(500);
  await f.app.call('send', f.request('disabled-running', '1', { destination: f.addresses[1].address }));
  await delay(500);
  assert.equal(receiveCount(f), 1);
});

test('a dead owner is stopped, restored intent does not launch, and stale tokens cannot restart receiving', { timeout: 20_000 }, async t => {
  // Given a verified child holding the same SQLite process lock as a receiver.
  const f = await fixture(t, [10, 0]);
  await enable(f);
  const token = 'synthetic-dead-owner';
  f.app.store.set('receive.background', { token, desired: true, state: 'running', lastError: null });
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { StateStore } from ${JSON.stringify(moduleUrl('storage/state.js'))};
    const store = new StateStore(process.argv[1]);
    const release = store.tryProcessLock('receive-daemon');
    process.on('message', () => release());
    process.send('ready');
  `, f.directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => child.kill());
  await once(child, 'message');
  assert.equal(controller(f).status().state, 'running');

  // When that exact child dies without updating persisted control state.
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;

  // Then status probes the real lock, and only a new explicit start can resume.
  assert.equal(controller(f).status().state, 'stopped');
  assert.equal(controller(f).status().lastError.code, 'RECEIVER_EXITED');
  await delay(100);
  assert.equal(f.state.publications.length, 0);
  const env = await credentialEnvironment(t, f.mnemonic());
  await cli(f.directory, ['wallet', 'receive', '--background'], env);
  assert.notEqual(f.app.store.get('receive.background').token, token);
  assert.equal(controller(f).claim(token), undefined);
  await cli(f.directory, ['wallet', 'receive', 'stop'], env);
  await until(() => controller(f).status().state === 'stopped');
});

test('a lost receive publication response recovers without another publication', { timeout: 20_000 }, async t => {
  // Given a pending send and a node that commits the receive but loses its response.
  const f = await fixture(t, [10, 0]);
  const env = await credentialEnvironment(t, f.mnemonic());
  const sent = await f.app.call('send', f.request('receive-recovery', '1', { destination: f.addresses[1].address }));
  f.state.failPublication = 2;
  await enable(f);
  // When the background receiver retries the unresolved receive journal entry.
  await cli(f.directory, ['wallet', 'receive', '--background'], env);
  await until(() => controller(f).status().lastError !== null);
  await until(() => Boolean(f.app.store.get(`receive.LOCAL.${sent.hash}`)?.result), 15_000);
  await until(() => controller(f).status().lastError === null);
  // Then canonical publication evidence settles the original receive exactly once.
  assert.equal(receiveCount(f), 1);
  assert.equal(f.state.publicationAttempts.length, 2);
  assert.equal(controller(f).status().lastError, null);
  await until(async () => (await f.app.call('pool_get')).accounts.find(value => value.index === 1).workReady);
});

test('startup acknowledges local initialization while node failures remain visible and retryable', { timeout: 30_000 }, async t => {
  // Given an initialized profile and an unavailable stream endpoint.
  const f = await fixture(t, [10, 0]);
  const env = await credentialEnvironment(t, f.mnemonic());
  await enable(f);
  f.state.failStreams = true;
  // When local launch succeeds and the first network subscription fails.
  assert.equal((await cli(f.directory, ['wallet', 'receive', '--background'], env)).backgroundReceive.state, 'running');
  await until(() => controller(f).status().lastError !== null);
  f.state.failStreams = false;
  await until(() => f.state.streams.size === 1);
  // Then retry restores receiving without another launch.
  await f.app.call('send', f.request('stream-recovered', '1', { destination: f.addresses[1].address }));
  await received(f, 1);
  await until(() => controller(f).status().lastError === null);
});
