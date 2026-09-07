import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AttoAddress, AttoAlgorithm, AttoPublicKey } from '@attocash/commons-core';

const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const { AutoReceiver } = await import(pathToFileURL(join(cliDirectory, 'dist/wallet/auto-receive.js')));
const { AttoError } = await import(pathToFileURL(join(cliDirectory, 'dist/domain/errors.js')));
const key = '22'.repeat(32);
const address = new AttoAddress(AttoAlgorithm.V1, new AttoPublicKey(new Int8Array(32).fill(34))).value;
const sendHash = '33'.repeat(32);
const receiveHash = '44'.repeat(32);
const receivable = `{"network":"LOCAL","hash":"${sendHash}","version":0,"algorithm":"V1","publicKey":"${'11'.repeat(32)}","timestamp":1705517157478,"receiverAlgorithm":"V1","receiverPublicKey":"${key}","amount":17999999999999999999}`;

async function until(predicate) {
  const deadline = performance.now() + 2500;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'Expected receiver progress before the deadline.');
    await delay(10);
  }
}

async function fixture(t, handler, receive, observe) {
  const events = [];
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('content-type', 'application/x-ndjson');
    handler(response, requests.length);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const snapshot = {
    settings: { network: 'LOCAL', nodeUrl: `http://127.0.0.1:${server.address().port}`, workerUrl: 'http://127.0.0.1', representative: address, autoReceive: true, minReceiveRaw: '1' },
    addresses: [{ index: 2, address, publicKey: key, active: true }],
  };
  const receiver = new AutoReceiver(() => snapshot, receive, event => { events.push(event); observe?.(event); });
  t.after(async () => {
    await receiver.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { receiver, events, requests, snapshot };
}

test('Progress follows one payment through duplicate arrivals and observer failures', { timeout: 5000 }, async t => {
  // Given a repeated pending payment and an observer that throws on every update.
  const attempts = [];
  const f = await fixture(t, response => response.write(`${receivable}\n${receivable}\n`), async (index, hash) => {
    attempts.push({ index, hash });
    return { hash: receiveHash };
  }, () => { throw new Error('Synthetic output failure.'); });

  // When the receiver consumes the payment and its session closes.
  f.receiver.start();
  await until(() => f.events.some(event => event.event === 'received'));
  await f.receiver.close();

  // Then progress and exact public amounts survive, without duplicate receiving or retries.
  assert.deepEqual(attempts, [{ index: 2, hash: sendHash }]);
  assert.deepEqual(f.events.map(event => event.event), ['pending', 'receiving', 'received']);
  for (const event of f.events) {
    assert.equal(event.index, 2);
    assert.equal(event.address, address);
    assert.equal(event.sendHash, sendHash);
    assert.deepEqual(event.amount, { raw: '17999999999999999999', atto: '17999999999.999999999' });
  }
  assert.equal(f.events.at(-1).receiveHash, receiveHash);
  assert.deepEqual(f.receiver.status(), { running: false, lastError: null });
});

test('Failed receiving reports a sanitized retry before the existing delay expires', { timeout: 5000 }, async t => {
  // Given a transient dependency error and a clock that can advance the existing retry deadline.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let attempts = 0;
  const f = await fixture(t, response => response.write(`${receivable}\n`), async () => {
    if (++attempts === 1) throw new Error('Synthetic private dependency detail.');
    return { hash: receiveHash };
  });

  // When the failure is reported, then its ten-second retry deadline arrives.
  f.receiver.start();
  await until(() => f.events.some(event => event.event === 'retry'));
  const retry = f.events.find(event => event.event === 'retry');
  assert.equal(attempts, 1);
  t.mock.timers.tick(10_000);
  await until(() => f.events.some(event => event.event === 'received'));
  await f.receiver.close();

  // Then the same payment retries once, without another pending notification or leaked error details.
  assert.equal(attempts, 2);
  assert.deepEqual(f.events.map(event => event.event), ['pending', 'receiving', 'retry', 'receiving', 'received']);
  assert.equal(retry.retryInMs, 10_000);
  assert.equal(retry.sendHash, sendHash);
  assert.equal(retry.error.code, 'OPERATION_FAILED');
  assert.doesNotMatch(JSON.stringify(f.events), /Synthetic private dependency detail/);
  assert.equal(f.receiver.status().lastError, null);
});

test('A payment consumed elsewhere is skipped without claiming receipt', { timeout: 5000 }, async t => {
  // Given a pending notification whose payment has already been consumed by another session.
  let attempts = 0;
  const f = await fixture(t, response => response.write(`${receivable}\n`), async () => {
    attempts++;
    throw new AttoError('RECEIVABLE_NOT_PENDING', 'The payment is no longer pending.');
  });

  // When the mutation gate rejects that stale notification.
  f.receiver.start();
  await until(() => f.events.some(event => event.event === 'skipped'));
  await f.receiver.close();

  // Then the terminal can explain the outcome without reporting a successful transaction or retry.
  assert.equal(attempts, 1);
  assert.deepEqual(f.events.map(event => event.event), ['pending', 'receiving', 'skipped']);
  assert.equal(f.events.at(-1).error.code, 'RECEIVABLE_NOT_PENDING');
  assert.equal(f.events.at(-1).sendHash, sendHash);
});

test('Stream failures report reconnect delays while configuration cancellation stays quiet', { timeout: 5000 }, async t => {
  // Given an unavailable node, a subsequent ended stream, and then an idle live connection.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture(t, (response, attempt) => {
    if (attempt === 1) { response.statusCode = 503; response.end('Synthetic private HTTP detail.'); }
    else if (attempt === 2) response.end();
    else response.flushHeaders();
  }, async () => { assert.fail('An empty stream must not attempt receiving.'); });

  // When both failures trigger the existing backoff and the user disables the connected receiver.
  f.receiver.start();
  await until(() => f.events.length === 1);
  t.mock.timers.tick(1000);
  await until(() => f.events.length === 2);
  t.mock.timers.tick(2000);
  await until(() => f.requests.length === 3);
  f.snapshot.settings = { ...f.snapshot.settings, autoReceive: false };
  await until(() => !f.receiver.status().running);
  await f.receiver.close();

  // Then only real connection failures produce sanitized reconnect events, preserving their delays.
  assert.deepEqual(f.events.map(event => event.event), ['reconnecting', 'reconnecting']);
  assert.deepEqual(f.events.map(event => event.retryInMs), [1000, 2000]);
  assert.ok(f.events.every(event => typeof event.error.code === 'string' && typeof event.error.message === 'string'));
  assert.doesNotMatch(JSON.stringify(f.events), /Synthetic private HTTP detail/);
});

test('Closing during receiving suppresses cancellation retry noise', { timeout: 5000 }, async t => {
  // Given an in-flight receive that will fail as the session shuts down.
  let rejectReceive = () => {};
  t.after(() => rejectReceive(new Error('Synthetic cancellation.')));
  const f = await fixture(t, response => response.write(`${receivable}\n`), () => new Promise((_, reject) => { rejectReceive = reject; }));

  // When the user closes the receiver before its outstanding operation rejects.
  f.receiver.start();
  await until(() => f.events.some(event => event.event === 'receiving'));
  const closed = f.receiver.close();
  rejectReceive(new Error('Synthetic cancellation.'));
  await closed;

  // Then neither the cancelled operation nor the aborted stream adds a misleading retry event.
  assert.deepEqual(f.events.map(event => event.event), ['pending', 'receiving']);
  assert.equal(f.receiver.status().running, false);
});
