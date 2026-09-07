import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { interruptCli, sigintHarness } from './support/signals.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AttoAddress, AttoAlgorithm, AttoPublicKey } from '@attocash/commons-core';

const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const moduleUrl = path => pathToFileURL(join(cliDirectory, 'dist', path)).href;
const { StateStore } = await import(moduleUrl('storage/state.js'));
const { defaultSettings } = await import(moduleUrl('wallet/defaults.js'));
const { formatHumanResult } = await import(moduleUrl('cli/output.js'));
const sendHashes = ['AA'.repeat(32), 'BB'.repeat(32)];
const receiveHash = 'CC'.repeat(32);
const walletAddresses = [17, 34].map((byte, index) => {
  const key = new AttoPublicKey(new Int8Array(32).fill(byte));
  return { index, publicKey: key.toString(), address: new AttoAddress(AttoAlgorithm.V1, key).value, active: true };
});

function incoming(index) {
  return JSON.stringify({ network: 'LOCAL', hash: sendHashes[index], version: 0, algorithm: 'V1', publicKey: '44'.repeat(32),
    timestamp: 1705517157478, receiverAlgorithm: 'V1', receiverPublicKey: walletAddresses[index].publicKey,
    amount: index === 0 ? 1_000_000_001 : 2_000_000_000 });
}

async function fixture(t, startupInterrupt = false) {
  const directory = await mkdtemp(join(tmpdir(), 'atto-receive-progress-'));
  let stopForStartup;
  const timers = [];
  const requests = [];
  const http = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('content-type', 'application/x-ndjson');
    if (request.method === 'POST' && request.url.startsWith('/accounts/receivables/stream')) {
      if (startupInterrupt) response.flushHeaders();
      else response.write(`${incoming(0)}\n${incoming(1)}\n`);
    } else if (request.url.includes('/receivables/stream')) {
      // The uncached second payment reaches the real lookup deadline before
      // any signing or credential access. Keep this stream open until canceled.
      response.flushHeaders();
    } else if (startupInterrupt && request.url.startsWith('/accounts/')) {
      stopForStartup?.();
      timers.push(setTimeout(() => { response.statusCode = 404; response.end(); }, 400));
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const url = `http://127.0.0.1:${http.address().port}`;
  const store = new StateStore(directory);
  try {
    store.set('settings', { ...defaultSettings(), network: 'LOCAL', nodeUrl: url, workerUrl: url, autoReceive: true });
    store.set('identity', { address: walletAddresses[0].address, fingerprint: 'synthetic-progress-wallet' });
    store.set('addresses', walletAddresses);
    store.set('labels.personal.LOCAL', [{ address: walletAddresses[0].address, label: 'Savings' }]);
    store.set(`receive.LOCAL.${sendHashes[0]}`, { hash: sendHashes[0], index: 0, blockHash: receiveHash,
      result: { status: 'received', hash: receiveHash } });
  } finally { store.close(); }
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, requests, startupInterrupt, onStartup: stop => { stopForStartup = stop; } };
}

async function runCli(t, f, json) {
  const harness = `
    ${sigintHarness}
    process.env.KOTLIN_LOGGING_STARTUP_MESSAGE = 'false';
    const { OsSecretStore } = await import(process.env.ATTO_TEST_SECRETS_MODULE);
    let secretAccesses = 0;
    for (const method of ['get', 'set', 'remove']) OsSecretStore.prototype[method] = async () => {
      secretAccesses++;
      throw new Error('Credential access is forbidden in this synthetic receiving fixture.');
    };
    process.argv = [process.execPath, 'atto', ...JSON.parse(process.env.ATTO_TEST_ARGUMENTS)];
    await import(process.env.ATTO_TEST_MAIN);
    process.send({ secretAccesses, sigintListeners: process.listenerCount('SIGINT'), sigtermListeners: process.listenerCount('SIGTERM') });
    process.disconnect();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', harness], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1', XDG_DATA_HOME: join(f.directory, 'data'), XDG_CACHE_HOME: join(f.directory, 'cache'),
      ATTO_TEST_SECRETS_MODULE: moduleUrl('storage/secrets.js'), ATTO_TEST_MAIN: moduleUrl('cli/main.js'),
      ATTO_TEST_ARGUMENTS: JSON.stringify(['--data-dir', f.directory, ...(json ? ['--json'] : []), 'wallet', 'receive']) },
  });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '';
  let stderr = '';
  let trace;
  let interrupted = false;
  const interrupt = () => {
    if (interrupted) return;
    interrupted = true;
    interruptCli(child);
  };
  if (f.startupInterrupt) f.onStartup(interrupt);
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (f.startupInterrupt) return;
    const retryPrinted = json ? stdout.split('\n').some(line => {
      try { return JSON.parse(line).result.event === 'retry'; } catch { return false; }
    }) : stdout.includes('Retrying in 10s.');
    if (retryPrinted) interrupt();
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('message', message => { trace = message; });
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Receiving CLI did not stop cleanly.\n${stdout}\n${stderr}`)); }, 10_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr, trace }); });
  });
  assert.equal(interrupted, true, 'The test must send exactly one Ctrl+C signal.');
  return result;
}

for (const json of [false, true]) {
  test(`real receiving CLI emits ${json ? 'JSON' : 'human'} progress and exits cleanly after one Ctrl+C`, async t => {
    // Given: a completed synthetic receive record and a second pending payment
    // whose localhost lookup stalls. No real wallet or signing operation exists.
    const f = await fixture(t);

    // When: the CLI renders actual receiver events and gets Ctrl+C after retry output.
    const result = await runCli(t, f, json);

    // Then: output keeps exact amounts and both hashes, and shutdown releases its listeners and state.
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.deepEqual(result.trace, { secretAccesses: 0, sigintListeners: 0, sigtermListeners: 0 });
    if (json) {
      const lines = result.stdout.trim().split('\n').map(line => JSON.parse(line));
      for (const line of lines) assert.deepEqual(Object.keys(line), ['result']);
      assert.equal(lines[0].result.initialized, true);
      const events = lines.slice(1).map(line => line.result);
      assert.deepEqual(events.map(event => event.event), ['pending', 'pending', 'receiving', 'received', 'receiving', 'retry']);
      const received = events.find(event => event.event === 'received');
      assert.deepEqual(received.amount, { raw: '1000000001', atto: '1.000000001' });
      assert.equal(received.address, walletAddresses[0].address);
      assert.equal(received.addressLabels[received.address].personal.label, 'Savings');
      assert.equal(received.sendHash, sendHashes[0]);
      assert.equal(received.receiveHash, receiveHash);
      const retry = events.at(-1);
      assert.equal(retry.error.code, 'RECEIVABLE_LOOKUP_TIMEOUT');
      assert.equal(retry.retryInMs, 10_000);
      assert.deepEqual(retry.amount, { raw: '2000000000', atto: '2' });
    } else {
      assert.match(result.stdout, /Automatic receiving session\. Press Ctrl\+C to stop\./);
      assert.ok(result.stdout.includes(`Pending: 1.000000001 ATTO for account 0 ${walletAddresses[0].address} (Savings [personal]) (send ${sendHashes[0]})`));
      assert.ok(result.stdout.includes(`Receiving: 1.000000001 ATTO for account 0 ${walletAddresses[0].address} (Savings [personal]) (send ${sendHashes[0]})`));
      assert.ok(result.stdout.includes(`Received: 1.000000001 ATTO for account 0 ${walletAddresses[0].address} (Savings [personal]) (send ${sendHashes[0]})`));
      assert.ok(result.stdout.includes(`Receive transaction: ${receiveHash}`));
      assert.ok(result.stdout.includes(`Receive delayed: 2 ATTO for account 1 ${walletAddresses[1].address} (send ${sendHashes[1]})`));
      assert.match(result.stdout, /RECEIVABLE_LOOKUP_TIMEOUT:.*Retrying in 10s\./);
      assert.doesNotMatch(result.stdout, /"result"|"event"|MCP|Receiver running: No/);
    }
    const reopened = new StateStore(f.directory);
    try { await reopened.withExclusiveReset(async () => {}); }
    finally { reopened.close(); }
  });
}

test('one Ctrl+C during startup account lookup is handled and closes the receiver', async t => {
  // Given: the startup account lookup remains in flight when the signal arrives.
  const f = await fixture(t, true);

  // When
  const result = await runCli(t, f, false);

  // Then: interruption is graceful even before start() returns.
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.trace, { secretAccesses: 0, sigintListeners: 0, sigtermListeners: 0 });
  assert.match(result.stdout, /Automatic receiving session/);
  assert.doesNotMatch(result.stdout, /Pending:|Receiving:|Receive delayed:|connection interrupted/);
});

test('human receive progress escapes untrusted errors and hashes without rounding amounts', () => {
  // Given: synthetic observer data contains terminal controls and an exact tiny amount.
  const payment = { index: 0, address: 'synthetic', sendHash: 'send\u001b[2J\nforged', amount: { raw: '1', atto: '0.000000001' } };
  const events = [
    { event: 'received', ...payment, receiveHash: 'receive\rforged' },
    { event: 'retry', ...payment, error: { code: 'TEST\u009b', message: 'wait\nforged\u202e' }, retryInMs: 10_000 },
    { event: 'skipped', ...payment, error: { code: 'TEST', message: 'skip\u001b[2J' } },
    { event: 'reconnecting', error: { code: 'TEST', message: 'retry\u2066' }, retryInMs: 1000 },
  ];

  // When
  const output = events.map(event => formatHumanResult(event, 'receive_progress')).join('');

  // Then
  assert.match(output, /0\.000000001 ATTO/);
  assert.match(output, /send\\u001b\[2J\\u000aforged/);
  assert.match(output, /Receive transaction: receive\\u000dforged/);
  assert.match(output, /TEST\\u009b: wait\\u000aforged\\u202e/);
  assert.match(output, /Skipped:/);
  assert.match(output, /retry\\u2066 Retrying in 1s\./);
  assert.doesNotMatch(output, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
});
