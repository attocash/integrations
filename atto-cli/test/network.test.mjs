import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { AttoAddress, AttoAlgorithm, AttoPublicKey } from '@attocash/commons-core';

const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const { NodeReader, publicModel } = await import(pathToFileURL(join(cliDirectory, 'dist/network/reader.js')).href);

const key = '11'.repeat(32);
const otherKey = '22'.repeat(32);
const hash = '33'.repeat(32);
const address = new AttoAddress(AttoAlgorithm.V1, new AttoPublicKey(new Int8Array(32).fill(17))).value;
const otherAddress = new AttoAddress(AttoAlgorithm.V1, new AttoPublicKey(new Int8Array(32).fill(34))).value;
const account = (publicKey = key, height = '3') => `{"publicKey":"${publicKey}","network":"LOCAL","version":0,"algorithm":"V1","height":${height},"balance":17999999999999999999,"lastTransactionHash":"${hash}","lastTransactionTimestamp":1704616009211,"representativeAlgorithm":"V1","representativePublicKey":"${otherKey}"}`;
const entry = (publicKey = key, height = 1) => JSON.stringify({ hash: height.toString(16).padStart(64, '0'), algorithm: 'V1', publicKey, height, blockType: 'RECEIVE', subjectAlgorithm: 'V1', subjectPublicKey: otherKey, previousBalance: 0, balance: 100, timestamp: 1704616009211 });
const receivable = `{"network":"LOCAL","hash":"${hash}","version":0,"algorithm":"V1","publicKey":"${key}","timestamp":1705517157478,"receiverAlgorithm":"V1","receiverPublicKey":"${otherKey}","amount":17999999999999999999}`;
const transaction = JSON.stringify({ block: { type: 'SEND', network: 'LOCAL', version: 0, algorithm: 'V1', publicKey: key, height: 2, balance: 100, timestamp: 1704616009211, previous: hash, amount: 100, receiverAlgorithm: 'V1', receiverPublicKey: otherKey }, signature: '44'.repeat(64), work: '55'.repeat(8) });

async function server(t, handler) {
  const http = createServer((req, res) => { Promise.resolve(handler(req, res)).catch(() => { res.statusCode = 500; res.end(); }); });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(async () => { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); });
  return new NodeReader({ network: 'LOCAL', nodeUrl: `http://127.0.0.1:${http.address().port}`, workerUrl: 'http://127.0.0.1', representative: address, autoReceive: false, minReceiveRaw: '1' });
}

test('reads preserve exact Atto amounts and follow account, transaction, entry and vote-weight routes', async t => {
  const requests = [];
  const reader = await server(t, (req, res) => {
    requests.push(req.url);
    if (req.url === `/accounts/${key}`) res.end(account());
    else if (req.url === `/transactions/${hash}`) res.end(transaction);
    else if (req.url === `/accounts/entries/${hash}/stream`) res.end(entry() + '\n');
    else if (req.url.startsWith('/vote-weights/')) res.end('{"weight":17999999999999999999}');
    else { res.statusCode = 404; res.end('sensitive upstream message'); }
  });
  assert.equal(publicModel(await reader.account(address)).balance, '17999999999999999999');
  assert.equal(publicModel(await reader.account(address)).height, '3');
  assert.equal(publicModel(await reader.transaction(hash)).block.type, 'SEND');
  assert.equal(publicModel(await reader.entry(hash)).height, '1');
  assert.equal((await reader.voterWeight(address)).weight, '17999999999999999999');
  assert.equal(await reader.transaction('FF'.repeat(32)), null);
  assert.equal(requests.filter(value => value.startsWith('/vote-weights/')).length, 1);
});

test('NDJSON handles fragmented records and CRLF line endings', async t => {
  const reader = await server(t, async (req, res) => {
    assert.ok(req.headers.accept?.split(',').map(value => value.trim()).includes('application/x-ndjson'));
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(receivable.slice(0, 83));
    await new Promise(resolve => setTimeout(resolve, 10));
    res.end(receivable.slice(83) + '\r\n' + receivable + '\n');
  });
  const results = [];
  await reader.stream({ event: 'receivable', addresses: [otherAddress] }, value => results.push(publicModel(value)), new AbortController().signal);
  assert.equal(results.length, 2);
  assert.equal(results[0].amount, '17999999999999999999');
});

test('all stream model types and multi-address request bodies match the node API', async t => {
  const requests = [];
  const reader = await server(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
    if (req.url.includes('receivables')) res.end(receivable + '\n');
    else if (req.url.includes('transactions')) res.end(transaction + '\n');
    else if (req.url.includes('entries')) res.end(entry() + '\n');
    else res.end(account() + '\n');
  });
  for (const event of ['account', 'transaction', 'entry', 'receivable']) {
    const filter = { event, addresses: [address, otherAddress], ...(['entry', 'transaction'].includes(event) ? { fromHeight: '2', toHeight: '5' } : {}) };
    const events = [];
    await reader.stream(filter, model => events.push(publicModel(model)), new AbortController().signal);
    assert.equal(events.length, 1);
    const request = requests.at(-1);
    assert.equal(request.method, 'POST');
    if (['entry', 'transaction'].includes(event)) {
      assert.deepEqual(request.body.search, [address, otherAddress].map(value => ({ address: value, fromHeight: 2, toHeight: 5 })));
    } else assert.deepEqual(request.body, { addresses: [address, otherAddress] });
  }
  assert.deepEqual(requests.map(value => value.url), ['/accounts/stream', '/accounts/transactions/stream', '/accounts/entries/stream', '/accounts/receivables/stream?minAmount=0']);
});

test('stream abort closes a pending HTTP body and does not deliver later records', async t => {
  let closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  const reader = await server(t, (req, res) => {
    req.on('close', closed);
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(entry() + '\n' + entry(key, 2) + '\n');
  });
  const controller = new AbortController();
  let count = 0;
  await reader.stream({ event: 'entry' }, () => { count++; controller.abort(); }, controller.signal);
  await Promise.race([disconnected, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('connection stayed open')), 1000).unref())]);
  assert.equal(count, 1);
});

test('immediate stream cancellation settles before subscription work starts', { timeout: 3000 }, async t => {
  // Given: subscription work has not yet reached the node.
  const reader = await server(t, (_req, res) => res.write(entry() + '\n'));
  const controller = new AbortController();
  let events = 0;

  // When: cancellation happens in the same turn that starts the subscription.
  const streaming = reader.stream({ event: 'entry' }, () => { events++; }, controller.signal);
  controller.abort();
  await streaming;

  // Then: cleanup settles without requiring a started SDK coroutine callback.
  assert.equal(events, 0);
});

test('a JavaScript observer failure closes its subscription without leaking details or delivering later records', { timeout: 3000 }, async t => {
  // Given: two records arrive together and the observer throws a regular JS error.
  let closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  const reader = await server(t, (req, res) => {
    req.on('close', closed);
    res.write(entry() + '\n' + entry(key, 2) + '\n');
  });
  let events = 0;

  // When / Then: the public promise rejects safely and its HTTP work is stopped.
  await assert.rejects(reader.stream({ event: 'entry' }, () => {
    events++;
    throw new Error('Synthetic private observer detail.');
  }, new AbortController().signal), error => error.code === 'NODE_STREAM_ERROR' && !error.message.includes('Synthetic private observer detail'));
  await disconnected;
  assert.equal(events, 1);
});

test('history pagination visits every address and height exactly once across page boundaries', async t => {
  const ranges = [];
  const reader = await server(t, (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const publicKey = url.pathname.split('/')[2];
    if (!url.pathname.endsWith('/stream')) { res.end(account(publicKey)); return; }
    const from = Number(url.searchParams.get('fromHeight'));
    const to = Number(url.searchParams.get('toHeight'));
    ranges.push([publicKey, from, to]);
    res.end(Array.from({ length: to - from + 1 }, (_, offset) => entry(publicKey, from + offset)).join('\n') + '\n');
  });
  const base = { event: 'entry', addresses: [address, otherAddress], limit: 2, timeoutMs: 1000 };
  const all = [];
  let cursor;
  do {
    const page = await reader.list({ ...base, cursor });
    all.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(all.map(value => [value.publicKey, value.height]), [[key, '1'], [key, '2'], [key, '3'], [otherKey, '1'], [otherKey, '2'], [otherKey, '3']]);
  assert.equal(ranges.filter(range => range[0] === otherKey && range[1] === 1).length, 1);
  const first = await reader.list(base);
  await assert.rejects(reader.list({ ...base, addresses: [otherAddress], cursor: first.nextCursor }), { code: 'INVALID_CURSOR' });
});

test('history timeout returns only delivered heights and resumes at the next undelivered height', async t => {
  let call = 0;
  const reader = await server(t, (req, res) => {
    if (!req.url.includes('/stream')) { res.end(account()); return; }
    const url = new URL(req.url, 'http://localhost');
    const from = Number(url.searchParams.get('fromHeight'));
    call++;
    if (call === 1) { res.write(entry(key, from) + '\n'); return; }
    res.end([entry(key, from), entry(key, from + 1)].join('\n') + '\n');
  });
  const first = await reader.list({ event: 'entry', addresses: [address], timeoutMs: 70 });
  assert.equal(first.timedOut, true);
  assert.deepEqual(first.items.map(value => value.height), ['1']);
  const rest = await reader.list({ event: 'entry', addresses: [address], cursor: first.nextCursor });
  assert.deepEqual(rest.items.map(value => value.height), ['2', '3']);
});

test('reader rejects malformed models, oversized records, invalid ranges and unsynchronized history', async t => {
  let mode = 'invalid';
  const reader = await server(t, (req, res) => {
    if (!req.url.includes('/stream')) { res.end(account()); return; }
    res.end(mode === 'invalid' ? '{"secret":"never-return-this"}\n' : mode === 'large' ? 'x'.repeat(1024 * 1024 + 1) : entry(key, 2) + '\n');
  });
  await assert.rejects(reader.stream({ event: 'entry' }, () => {}, new AbortController().signal), error => error.code === 'NODE_STREAM_ERROR' && !error.message.includes('never-return-this'));
  mode = 'large';
  await assert.rejects(reader.stream({ event: 'entry' }, () => {}, new AbortController().signal), { code: 'NODE_STREAM_ERROR' });
  mode = 'gap';
  await assert.rejects(reader.list({ event: 'entry', addresses: [address] }), { code: 'HISTORY_GAP' });
  await assert.rejects(reader.list({ event: 'entry', addresses: [address], fromHeight: '2', toHeight: '1' }), { code: 'INVALID_HEIGHT' });
  await assert.rejects(reader.list({ event: 'receivable' }), { code: 'INVALID_FILTER' });
});

test('nonreplayable list timeout is bounded and never advertises a misleading continuation cursor', async t => {
  const reader = await server(t, (_req, res) => { res.write(entry() + '\n'); });
  const page = await reader.list({ event: 'entry', timeoutMs: 50 });
  assert.equal(page.items.length, 1);
  assert.equal(page.timedOut, true);
  assert.equal(page.nextCursor, undefined);
});
