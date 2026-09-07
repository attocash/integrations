import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { AttoAddress, AttoAlgorithm, AttoPublicKey } from '@attocash/commons-core';

const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const { NodeReader } = await import(pathToFileURL(join(cliDirectory, 'dist/network/reader.js')).href);
const { AutoReceiver } = await import(pathToFileURL(join(cliDirectory, 'dist/wallet/auto-receive.js')).href);
const publicKey = '22'.repeat(32);
const address = new AttoAddress(AttoAlgorithm.V1, new AttoPublicKey(new Int8Array(32).fill(34))).value;
const hash = '33'.repeat(32);
const payload = `{"network":"LOCAL","hash":"${hash}","version":0,"algorithm":"V1","publicKey":"${'11'.repeat(32)}","timestamp":1705517157478,"receiverAlgorithm":"V1","receiverPublicKey":"${publicKey}","amount":17999999999999999999}`;
const filter = { event: 'receivable', addresses: [address], minAmountRaw: '1' };

async function server(t, handler) {
  const http = createServer(handler);
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(async () => { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); });
  const url = `http://127.0.0.1:${http.address().port}`;
  const settings = { network: 'LOCAL', nodeUrl: url, workerUrl: url, representative: address, autoReceive: true, minReceiveRaw: '1' };
  return { settings, reader: new NodeReader(settings) };
}

test('an idle receiving subscription survives delayed headers and receives its first exact event without reconnecting', { timeout: 18_000 }, async t => {
  // Given: the node accepts the request but emits no HTTP headers until the
  // first receivable arrives after eleven seconds. No wallet or secret store is used.
  let markRequested;
  const requested = new Promise(resolve => { markRequested = resolve; });
  let requests = 0;
  let closed = 0;
  const { settings } = await server(t, (_request, response) => {
    requests++;
    markRequested();
    const timer = setTimeout(() => {
      response.setHeader('content-type', 'application/x-ndjson');
      response.write(`${payload}\n`);
    }, 11_000);
    response.once('close', () => { clearTimeout(timer); closed++; });
  });
  const progress = [];
  const received = [];
  const receiver = new AutoReceiver(
    () => ({ settings, addresses: [{ index: 0, address, publicKey, active: true }] }),
    async (index, sendHash) => { received.push({ index, sendHash }); return {}; },
    event => progress.push(event),
  );

  // When
  receiver.start();
  try {
    await requested;
    await delay(11_500);

    // Then: an idle stream stays connected, and Commons decodes the amount exactly.
    assert.equal(requests, 1);
    assert.equal(closed, 0);
    assert.equal(progress.filter(event => event.event === 'reconnecting').length, 0);
    const deadline = performance.now() + 2000;
    while (received.length === 0) {
      assert.ok(performance.now() < deadline, 'The delayed receivable was not delivered.');
      await delay(20);
    }
    assert.deepEqual(received, [{ index: 0, sendHash: hash }]);
    const pending = progress.find(event => event.event === 'pending');
    assert.equal(pending.address, address);
    assert.equal(pending.sendHash, hash);
    assert.deepEqual(pending.amount, { raw: '17999999999999999999', atto: '17999999999.999999999' });
    assert.equal(receiver.status().lastError, null);
  } finally { await receiver.close(); }
});

test('a subscription can be canceled before the node sends its first headers', { timeout: 5000 }, async t => {
  // Given
  let markRequested;
  const requested = new Promise(resolve => { markRequested = resolve; });
  const { reader } = await server(t, () => markRequested());
  const controller = new AbortController();
  const events = [];

  // When
  const streaming = reader.stream(filter, event => events.push(event), controller.signal);
  await requested;
  controller.abort();
  await streaming;

  // Then: caller cancellation succeeds without waiting for a first response.
  assert.deepEqual(events, []);
});

test('finite receivable lists still honor their deadline before response headers', { timeout: 5000 }, async t => {
  // Given
  let requests = 0;
  const { reader } = await server(t, () => { requests++; });

  // When
  const result = await reader.list({ ...filter, limit: 1, timeoutMs: 100 });

  // Then: removing the subscription deadline does not remove a list caller's deadline.
  assert.equal(requests, 1);
  assert.deepEqual(result, { items: [], timedOut: true });
});
