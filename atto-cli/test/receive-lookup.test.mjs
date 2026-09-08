import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AttoAddress, AttoAlgorithm, AttoPublicKey } from '@attocash/commons-core';

const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const { AttoApplication } = await import(pathToFileURL(join(cliDirectory, 'dist/application/app.js')).href);
const { StateStore } = await import(pathToFileURL(join(cliDirectory, 'dist/storage/state.js')).href);
const hashes = ['AA'.repeat(32), 'BB'.repeat(32)];
const addresses = [17, 34].map((byte, index) => {
  const key = new AttoPublicKey(new Int8Array(32).fill(byte));
  return { index, publicKey: key.toString(), address: new AttoAddress(AttoAlgorithm.V1, key).value, active: true };
});

function receivable(index) {
  return JSON.stringify({ network: 'LOCAL', hash: hashes[index], version: 0, algorithm: 'V1', publicKey: '33'.repeat(32),
    timestamp: 1705517157478, receiverAlgorithm: 'V1', receiverPublicKey: addresses[index].publicKey, amount: 10 });
}

async function until(predicate, timeout = 3000) {
  const deadline = performance.now() + timeout;
  while (!await predicate()) {
    assert.ok(performance.now() < deadline, 'Expected observable receiving progress before deadline.');
    await delay(20);
  }
}

async function fixture(t, handler) {
  const directory = await mkdtemp(join(tmpdir(), 'atto-receive-lookup-'));
  const requests = [];
  const failures = [];
  const locks = [];
  const stores = [];
  let secretReads = 0;
  const http = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    response.setHeader('content-type', 'application/x-ndjson');
    if (!request.url.includes('/receivables/stream')) {
      response.statusCode = 404;
      response.end();
      return;
    }
    Promise.resolve().then(() => handler(request, response, requests)).catch(error => {
      failures.push(error);
      response.statusCode = 500;
      response.end();
    });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const url = `http://127.0.0.1:${http.address().port}`;
  const app = new AttoApplication({ directory, secrets: {
    async get() { secretReads++; return null; },
    async set() { throw new Error('Receiving fixtures must not save credentials.'); },
  } });
  t.after(async () => {
    for (const release of locks) release();
    http.closeAllConnections();
    await app.close();
    for (const store of stores) store.close();
    await new Promise(resolve => http.close(resolve));
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(failures, []);
  });
  app.store.set('identity', { address: addresses[0].address, fingerprint: 'synthetic-receive-lookup' });
  app.store.set('addresses', addresses);
  await app.call('wallet_configure', { network: 'LOCAL', nodeUrl: url, workerUrl: url, autoReceive: false });
  const hold = index => {
    const store = new StateStore(directory);
    stores.push(store);
    const release = store.tryAccountLocks([index]);
    assert.equal(typeof release, 'function');
    locks.push(release);
    return release;
  };
  return { app, requests, hold, get secretReads() { return secretReads; } };
}

test('a pending-payment lookup deadline is retryable and does not access wallet secrets', async t => {
  // Given: the node accepts the lookup but has not finished replaying receivables.
  const f = await fixture(t, (_request, response) => response.flushHeaders());

  // When / Then
  await assert.rejects(f.app.call('receive', { index: 0, hash: hashes[0] }), { code: 'RECEIVABLE_LOOKUP_TIMEOUT' });
  assert.equal(f.secretReads, 0);
  assert.equal(f.app.store.get(`receive.LOCAL.${hashes[0]}`), undefined);
  assert.equal(f.app.store.busy, false);
});

test('a completed receivables stream still reports absence without accessing secrets', async t => {
  // Given: the node completes the requested stream without the requested payment.
  const f = await fixture(t, (_request, response) => response.end(`${receivable(1)}\n`));

  // When / Then
  await assert.rejects(f.app.call('receive', { index: 0, hash: hashes[0] }), { code: 'RECEIVABLE_NOT_PENDING' });
  assert.equal(f.secretReads, 0);
  assert.equal(f.app.store.get(`receive.LOCAL.${hashes[0]}`), undefined);
});

test('finding the requested receivable aborts lookup successfully and proceeds to credential access', async t => {
  // Given: a matching payment is emitted on a stream that remains open.
  const f = await fixture(t, (_request, response) => response.write(`${receivable(0)}\n`));

  // When / Then: this synthetic wallet deliberately has no credential, so it
  // stops immediately after the successful lookup and never signs anything.
  await assert.rejects(f.app.call('receive', { index: 0, hash: hashes[0].toLowerCase() }), { code: 'WALLET_CREDENTIAL_MISSING' });
  assert.equal(f.secretReads, 1);
  assert.equal(f.app.store.get(`receive.LOCAL.${hashes[0]}`), undefined);
});

test('automatic receiving retries a timed-out lookup while its original stream remains connected', { timeout: 20_000 }, async t => {
  // Given: one subscription event, followed by a stalled first lookup. The node
  // completes the retry with no match; no reconnect or duplicate event prompts it.
  let lookups = 0;
  const f = await fixture(t, (request, response) => {
    if (request.method === 'POST') { response.write(`${receivable(0)}\n`); return; }
    lookups++;
    if (lookups === 1) response.flushHeaders();
    else response.end();
  });
  await f.app.call('wallet_configure', { autoReceive: true });

  // When
  await f.app.start();
  await until(async () => (await f.app.call('wallet_status')).autoReceive.lastError?.code === 'RECEIVABLE_LOOKUP_TIMEOUT', 5000);
  await until(() => lookups === 2, 13_000);

  // Then
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
  assert.equal(f.secretReads, 0);
});

test('manual receive still waits for its account lock before querying the node', async t => {
  // Given
  const f = await fixture(t, (_request, response) => response.end());
  const release = f.hold(0);

  // When
  const receiving = assert.rejects(f.app.call('receive', { index: 0, hash: hashes[0] }), { code: 'RECEIVABLE_NOT_PENDING' });
  await delay(80);
  assert.equal(f.requests.length, 0);
  release();
  await receiving;

  // Then
  assert.equal(f.requests.length, 1);
  assert.equal(f.secretReads, 0);
});

test('a busy automatic account leaves other accounts usable and does not block shutdown', { timeout: 7000 }, async t => {
  // Given: account zero stays locked throughout this receiver session.
  const f = await fixture(t, (request, response) => {
    if (request.method === 'POST') response.write(`${receivable(0)}\n${receivable(1)}\n`);
    else response.end();
  });
  const release = f.hold(0);
  await f.app.call('wallet_configure', { autoReceive: true });

  // When
  await f.app.start();
  const lookupFor = index => f.requests.filter(request => request.path.includes(`/accounts/${addresses[index].publicKey}/receivables/stream`));
  await until(() => lookupFor(1).length === 1);
  const closing = f.app.close();
  try {
    await Promise.race([closing, delay(1500).then(() => assert.fail('Shutdown waited for an unrelated account lock.'))]);
  } finally { release(); await closing; }

  // Then
  assert.equal(lookupFor(0).length, 0);
  assert.equal(f.secretReads, 0);
});
