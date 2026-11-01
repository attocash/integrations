import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { AttoAddress, AttoAlgorithm, AttoPublicKey } from '@attocash/commons-core';

const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const { NodeReader, publicModel } = await import(pathToFileURL(join(cliDirectory, 'dist/network/reader.js')).href);
const { resolveNodeBatchSize } = await import(pathToFileURL(join(cliDirectory, 'dist/network/batching.js')).href);

const key = '11'.repeat(32);
const otherKey = '22'.repeat(32);
const hash = '33'.repeat(32);
const address = new AttoAddress(AttoAlgorithm.V1, new AttoPublicKey(new Int8Array(32).fill(17))).value;
const otherAddress = new AttoAddress(AttoAlgorithm.V1, new AttoPublicKey(new Int8Array(32).fill(34))).value;
const account = (publicKey = key, height = '3') => `{"publicKey":"${publicKey}","network":"LOCAL","version":0,"algorithm":"V1","height":${height},"balance":17999999999999999999,"lastTransactionHash":"${hash}","lastTransactionTimestamp":1704616009211,"representativeAlgorithm":"V1","representativePublicKey":"${otherKey}"}`;
const entry = (publicKey = key, height = 1) => JSON.stringify({ hash: height.toString(16).padStart(64, '0'), algorithm: 'V1', publicKey, height, blockType: 'RECEIVE', subjectAlgorithm: 'V1', subjectPublicKey: otherKey, previousBalance: 0, balance: 100, timestamp: 1704616009211 });
const receivable = `{"network":"LOCAL","hash":"${hash}","version":0,"algorithm":"V1","publicKey":"${key}","timestamp":1705517157478,"receiverAlgorithm":"V1","receiverPublicKey":"${otherKey}","amount":17999999999999999999}`;
const addresses = Array.from({ length: 7 }, (_, index) => new AttoAddress(AttoAlgorithm.V1, new AttoPublicKey(new Int8Array(32).fill(index + 1))).value);
const publicKeyOf = value => AttoAddress.parse(value).publicKey.toString();
async function requestBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return JSON.parse(body);
}
const transaction = JSON.stringify({ block: { type: 'SEND', network: 'LOCAL', version: 0, algorithm: 'V1', publicKey: key, height: 2, balance: 100, timestamp: 1704616009211, previous: hash, amount: 100, receiverAlgorithm: 'V1', receiverPublicKey: otherKey }, signature: '44'.repeat(64), work: '55'.repeat(8) });

async function server(t, handler, settings = {}) {
  const http = createServer((req, res) => { Promise.resolve(handler(req, res)).catch(() => { res.statusCode = 500; res.end(); }); });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(async () => { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); });
  return new NodeReader({ network: 'LOCAL', nodeUrl: `http://127.0.0.1:${http.address().port}`, workerUrl: 'http://127.0.0.1', representative: address, autoReceive: false, minReceiveRaw: '1', nodeBatchSize: 5, ...settings });
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

test('history pagination batches finite ranges and visits every prefetched address and height once', async t => {
  // Given: account responses and account history arrive in reverse address order.
  const requests = [];
  let headHeight = '3';
  const reader = await server(t, async (req, res) => {
    const body = await requestBody(req);
    requests.push({ method: req.method, path: req.url, body });
    if (req.url === '/accounts') {
      res.end('[' + body.addresses.toReversed().map(value => account(publicKeyOf(value), headHeight)).join(',') + ']');
      return;
    }
    res.end(body.search.toReversed().flatMap(range => Array.from({ length: range.toHeight - range.fromHeight + 1 }, (_, offset) => entry(publicKeyOf(range.address), range.fromHeight + offset))).join('\n') + '\n');
  });
  const base = { event: 'entry', addresses: [address, otherAddress], limit: 4, timeoutMs: 1000 };

  // When: page continuation happens after both account heads have advanced.
  const first = await reader.list(base);
  headHeight = '5';
  const second = await reader.list({ ...base, cursor: first.nextCursor });

  // Then: ordering and frozen heights survive interleaving without row lookups.
  assert.deepEqual([...first.items, ...second.items].map(value => [value.publicKey, value.height]), [[key, '1'], [key, '2'], [key, '3'], [otherKey, '1'], [otherKey, '2'], [otherKey, '3']]);
  assert.equal(second.nextCursor, undefined);
  assert.deepEqual(requests.map(value => [value.method, value.path]), [['POST', '/accounts'], ['POST', '/accounts/entries/stream'], ['POST', '/accounts/entries/stream']]);
  assert.deepEqual(requests[1].body, { search: [{ address, fromHeight: 1, toHeight: 3 }, { address: otherAddress, fromHeight: 1, toHeight: 1 }] });
  await assert.rejects(reader.list({ ...base, addresses: [otherAddress], cursor: first.nextCursor }), { code: 'INVALID_CURSOR' });
});

test('history timeout commits only a contiguous address prefix and replays buffered later addresses', async t => {
  // Given: the later account arrives completely before the first account stalls.
  let streams = 0;
  const reader = await server(t, async (req, res) => {
    const body = await requestBody(req);
    if (req.url === '/accounts') { res.end('[' + body.addresses.map(value => account(publicKeyOf(value), '2')).join(',') + ']'); return; }
    streams++;
    if (streams === 1) {
      res.write(entry(otherKey, 1) + '\n' + entry(otherKey, 2) + '\n' + entry(key, 1) + '\n');
      return;
    }
    res.end(body.search.toReversed().flatMap(range => Array.from({ length: range.toHeight - range.fromHeight + 1 }, (_, offset) => entry(publicKeyOf(range.address), range.fromHeight + offset))).join('\n') + '\n');
  });
  const base = { event: 'entry', addresses: [address, otherAddress] };

  // When: the first request times out and the caller continues its v1 cursor.
  const first = await reader.list({ ...base, timeoutMs: 100 });
  const rest = await reader.list({ ...base, cursor: first.nextCursor });

  // Then: buffered later events are replayed exactly once in address order.
  assert.equal(first.timedOut, true);
  assert.deepEqual(first.items.map(value => [value.publicKey, value.height]), [[key, '1']]);
  assert.deepEqual(rest.items.map(value => [value.publicKey, value.height]), [[key, '2'], [otherKey, '1'], [otherKey, '2']]);
  assert.equal(rest.nextCursor, undefined);
});

test('reader rejects malformed models, oversized records, invalid ranges and unsynchronized history', async t => {
  // Given: malformed stream data, followed by an account whose first height is missing.
  let mode = 'invalid';
  const reader = await server(t, (req, res) => {
    if (req.url === '/accounts') { res.end('[' + account() + ']'); return; }
    res.end(mode === 'invalid' ? '{"secret":"never-return-this"}\n' : mode === 'large' ? 'x'.repeat(1024 * 1024 + 1) : entry(key, 2) + '\n');
  });

  // When / Then: model failures remain sanitized and incomplete history cannot advance.
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

test('a fetch headers timeout rejects the subscription without leaking upstream details', async t => {
  // Given: the same fetch rejection shape captured from the terminated MCP server.
  const cause = Object.assign(new Error('Private upstream headers timeout details.'), { name: 'HeadersTimeoutError', code: 'UND_ERR_HEADERS_TIMEOUT' });
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed', { cause }); });
  const reader = new NodeReader({ network: 'LOCAL', nodeUrl: 'http://127.0.0.1' });

  // When / Then: the network failure reaches the caller as a sanitized error.
  await assert.rejects(reader.stream({ event: 'account' }, () => assert.fail('No events expected'), new AbortController().signal), {
    code: 'NODE_STREAM_ERROR', message: 'The node stream failed. Check endpoint availability and node responses.',
  });
});

test('a dropped response body rejects the subscription after its delivered event', async t => {
  // Given: a stream disconnects after sending one complete record.
  const reader = await server(t, (_req, res) => {
    res.write(entry() + '\n');
    setTimeout(() => res.destroy(), 30);
  });
  const events = [];

  // When
  await assert.rejects(reader.stream({ event: 'entry' }, model => events.push(publicModel(model)), new AbortController().signal), { code: 'NODE_STREAM_ERROR' });

  // Then: delivered data remains valid, and the connection failure is catchable.
  assert.deepEqual(events.map(value => value.height), ['1']);
});


test('account batches preserve exact balances, requested order, duplicates and unopened accounts within the gatekeeper limit', async t => {
  // Given: seven distinct accounts, including an unopened account and a duplicate request.
  const batches = [];
  const reader = await server(t, async (req, res) => {
    const body = await requestBody(req);
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/accounts');
    assert.ok(body.addresses.length <= 5);
    batches.push(body.addresses);
    res.end('[' + body.addresses.toReversed().filter(value => value !== addresses[2]).map(value => account(publicKeyOf(value))).join(',') + ']');
  });
  const requested = [addresses[6], ...addresses.slice(0, 6), addresses[0]];

  // When
  const result = await reader.accounts(requested);

  // Then: native batches replace one request per account without numeric rounding.
  assert.deepEqual(batches.map(batch => batch.length), [5, 2]);
  assert.deepEqual(result.map(value => value?.address.value ?? null), requested.map(value => value === addresses[2] ? null : value));
  assert.ok(result.filter(Boolean).every(value => publicModel(value).balance === '17999999999999999999'));
  assert.deepEqual(await reader.accounts([]), []);
});

test('account batches propagate cancellation and HTTP failures without fallback account reads', async t => {
  // Given: an endpoint that rejects one batch, then leaves the next response pending.
  const requests = [];
  let fail = true;
  let close;
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  const closed = new Promise(resolve => { close = resolve; });
  const reader = await server(t, (req, res) => {
    requests.push([req.method, req.url]);
    if (fail) { res.writeHead(503); res.end('private upstream body'); return; }
    res.on('close', close);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('[');
    started();
  });

  // When / Then: errors stay typed, and cancelling a body stops transport work.
  await assert.rejects(reader.accounts(addresses), { code: 'NODE_HTTP_ERROR', details: { httpStatus: 503 } });
  fail = false;
  const controller = new AbortController();
  const reading = reader.accounts(addresses, controller.signal);
  await pending;
  controller.abort();
  await assert.rejects(reading, { code: 'CANCELLED' });
  await closed;
  assert.deepEqual(requests, [['POST', '/accounts'], ['POST', '/accounts']]);
});

test('multi-address history skips unopened accounts and chunks heads and ranges for the gatekeeper', async t => {
  // Given: seven addresses with only one historical record each, and one unopened.
  const requests = [];
  const reader = await server(t, async (req, res) => {
    const body = await requestBody(req);
    requests.push({ path: req.url, body });
    if (req.url === '/accounts') {
      assert.ok(body.addresses.length <= 5);
      res.end('[' + body.addresses.filter(value => value !== addresses[0]).map(value => account(publicKeyOf(value), '1')).join(',') + ']');
      return;
    }
    assert.ok(body.search.length <= 5);
    res.end(body.search.toReversed().map(range => entry(publicKeyOf(range.address), range.fromHeight)).join('\n') + '\n');
  });

  // When
  const page = await reader.list({ event: 'entry', addresses, limit: 100 });

  // Then: all records appear once in input order, with batched head and range reads.
  assert.deepEqual(page.items.map(value => value.publicKey), addresses.slice(1).map(publicKeyOf));
  assert.deepEqual(requests.map(value => [value.path, (value.body.addresses ?? value.body.search).length]), [['/accounts', 5], ['/accounts/entries/stream', 4], ['/accounts', 2], ['/accounts/entries/stream', 2]]);
  assert.equal(page.nextCursor, undefined);
});

test('a later account cannot hide an early account gap in a finite batch', async t => {
  // Given: the node closes a finite batch after returning only its later account.
  const reader = await server(t, async (req, res) => {
    const body = await requestBody(req);
    if (req.url === '/accounts') { res.end('[' + body.addresses.map(value => account(publicKeyOf(value), '1')).join(',') + ']'); return; }
    res.end(entry(otherKey, 1) + '\n');
  });

  // When / Then: completion rejects rather than advancing past the missing account.
  await assert.rejects(reader.list({ event: 'entry', addresses: [address, otherAddress] }), { code: 'HISTORY_GAP' });
});

test('address watches chunk every stream kind within five addresses and preserve each account order', async t => {
  // Given: a gatekeeper enforcing five addresses or ranges per subscription.
  const requests = [];
  const reader = await server(t, async (req, res) => {
    const body = await requestBody(req);
    const selected = body.addresses ?? body.search.map(range => range.address);
    assert.ok(selected.length <= 5);
    requests.push({ path: req.url, size: selected.length });
    const payloads = selected.flatMap(value => req.url.includes('receivables') ? [receivable] : req.url.includes('entries') ? [entry(publicKeyOf(value), 1), entry(publicKeyOf(value), 2)] : req.url.includes('transactions') ? [transaction] : [account(publicKeyOf(value))]);
    res.end(payloads.join('\n') + '\n');
  });

  // When: all stream kinds watch seven addresses.
  for (const event of ['account', 'entry', 'transaction', 'receivable']) {
    const events = [];
    await reader.stream({ event, addresses }, model => events.push(publicModel(model)), new AbortController().signal);
    if (event === 'entry') for (const value of addresses) assert.deepEqual(events.filter(model => model.publicKey === publicKeyOf(value)).map(model => model.height), ['1', '2']);
  }

  // Then: every subscription stays within the public gatekeeper contract.
  assert.equal(requests.length, 8);
  for (let offset = 0; offset < requests.length; offset += 2) {
    assert.deepEqual(requests.slice(offset, offset + 2).map(value => value.size).sort(), [2, 5]);
    assert.equal(requests[offset].path, requests[offset + 1].path);
  }
});

test('one chunk failure stops and joins sibling streams', async t => {
  // Given: both chunks connect, then one fails while its sibling has an open body.
  let connections = 0;
  let release;
  const both = new Promise(resolve => { release = resolve; });
  let close;
  const closed = new Promise(resolve => { close = resolve; });
  const reader = await server(t, async (req, res) => {
    const body = await requestBody(req);
    if (++connections === 2) release();
    if (body.addresses.length === 5) {
      res.on('close', close);
      res.write(account(publicKeyOf(body.addresses[0])) + '\n');
      return;
    }
    await both;
    res.writeHead(503);
    res.end('private upstream details');
  });

  // When / Then: the failing chunk rejects only after sibling cleanup finishes.
  await assert.rejects(reader.stream({ event: 'account', addresses }, () => {}, new AbortController().signal), { code: 'NODE_STREAM_ERROR' });
  await closed;
  assert.equal(connections, 2);
});

test('cancelling a multi-chunk watch closes every open body before returning', async t => {
  // Given: both chunks have connected and emitted their first record.
  let ready;
  let closed;
  const connected = new Promise(resolve => { ready = resolve; });
  const disconnected = new Promise(resolve => { closed = resolve; });
  let connections = 0;
  let closes = 0;
  const reader = await server(t, async (req, res) => {
    const body = await requestBody(req);
    res.on('close', () => { if (++closes === 2) closed(); });
    res.write(account(publicKeyOf(body.addresses[0])) + '\n');
    if (++connections === 2) ready();
  });
  const controller = new AbortController();
  let events = 0;

  // When: the caller cancels a subscription spanning two native requests.
  const watching = reader.stream({ event: 'account', addresses }, () => { events++; }, controller.signal);
  await connected;
  controller.abort();
  await watching;
  await disconnected;

  // Then: both connections are closed and no callbacks can arrive afterward.
  const delivered = events;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events, delivered);
  assert.equal(closes, 2);
});

test('a one-item page prefetches only one nearby head batch for a hundred selected addresses', async t => {
  // Given: a hundred selected accounts each have historical entries.
  const selected = Array.from({ length: 100 }, (_, index) => new AttoAddress(AttoAlgorithm.V1, new AttoPublicKey(new Int8Array(32).fill(index + 1))).value);
  const requests = [];
  const reader = await server(t, async (req, res) => {
    const body = await requestBody(req);
    requests.push({ path: req.url, body });
    if (req.url === '/accounts') {
      res.end('[' + body.addresses.map(value => account(publicKeyOf(value), '3')).join(',') + ']');
      return;
    }
    res.end(entry(publicKeyOf(body.search[0].address), body.search[0].fromHeight) + '\n');
  });

  // When: the caller asks for only its first historical entry.
  const page = await reader.list({ event: 'entry', addresses: selected, limit: 1 });

  // Then: only five nearby heads and the one required height are requested.
  assert.equal(page.items.length, 1);
  assert.deepEqual(requests.map(value => value.path), ['/accounts', '/accounts/entries/stream']);
  assert.deepEqual(requests[0].body.addresses, selected.slice(0, 5));
  assert.deepEqual(requests[1].body.search, [{ address: selected[0], fromHeight: 1, toHeight: 1 }]);
  const cursor = JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString());
  assert.deepEqual(cursor.upper.slice(0, 5), Array(5).fill('3'));
  assert.ok(cursor.upper.slice(5).every(value => value === null));
});

test('timeout during a later head batch preserves earlier progress and prefetched heights', async t => {
  // Given: five accounts finish, then the next head batch stalls.
  const requests = [];
  let stall = true;
  const reader = await server(t, async (req, res) => {
    const body = await requestBody(req);
    requests.push({ path: req.url, body });
    if (req.url === '/accounts') {
      if (body.addresses[0] === addresses[5] && stall) { res.write('['); return; }
      res.end('[' + body.addresses.map(value => account(publicKeyOf(value), '1')).join(',') + ']');
      return;
    }
    res.end(body.search.toReversed().map(range => entry(publicKeyOf(range.address), range.fromHeight)).join('\n') + '\n');
  });
  const base = { event: 'entry', addresses, limit: 100 };

  // When: the caller continues after the timeout while later heads become available.
  const first = await reader.list({ ...base, timeoutMs: 150 });
  stall = false;
  const rest = await reader.list({ ...base, cursor: first.nextCursor });

  // Then: completed head batches and history are not fetched again or duplicated.
  assert.equal(first.timedOut, true);
  assert.deepEqual(first.items.map(value => value.publicKey), addresses.slice(0, 5).map(publicKeyOf));
  const cursor = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString());
  assert.equal(cursor.addressIndex, 5);
  assert.deepEqual(cursor.upper, ['1', '1', '1', '1', '1', null, null]);
  assert.deepEqual(rest.items.map(value => value.publicKey), addresses.slice(5).map(publicKeyOf));
  assert.equal(rest.nextCursor, undefined);
  assert.equal(requests.filter(value => value.path === '/accounts' && value.body.addresses[0] === addresses[0]).length, 1);
});

test('automatic batch sizing recognizes official gatekeepers and keeps custom nodes unbatched', () => {
  // Given: official gatekeepers, direct nodes and a private gateway have distinct hostnames.
  const official = ['live', 'beta', 'dev'].map(network => `https://gatekeeper.${network}.application.atto.cash`);
  const custom = ['http://localhost:8080', 'https://node.example.test', 'https://private-gateway.example.test', 'https://gatekeeper.live.application.atto.cash.example.test'];

  // When / Then: auto uses only known public gateway limits, including an explicit reset to null.
  for (const nodeUrl of official) {
    assert.equal(resolveNodeBatchSize({ nodeUrl }), 5);
    assert.equal(resolveNodeBatchSize({ nodeUrl: `${nodeUrl}./` }), 5);
    assert.equal(resolveNodeBatchSize({ nodeUrl, nodeBatchSize: null }), 5);
    assert.equal(resolveNodeBatchSize({ nodeUrl, nodeBatchSize: 2 }), 2);
  }
  for (const nodeUrl of custom) {
    assert.equal(resolveNodeBatchSize({ nodeUrl }), 1000);
    assert.equal(resolveNodeBatchSize({ nodeUrl, nodeBatchSize: null }), 1000);
    assert.equal(resolveNodeBatchSize({ nodeUrl, nodeBatchSize: 5 }), 5);
  }
});

test('explicit node batch sizes validate the public reader settings boundary', () => {
  // Given: direct reader consumers may bypass wallet configuration validation.
  const settings = { nodeUrl: 'https://node.example.test' };

  // When / Then: supported overrides remain exact and unsupported values fail safely.
  for (const nodeBatchSize of [1, 2, 5, 1000]) assert.equal(resolveNodeBatchSize({ ...settings, nodeBatchSize }), nodeBatchSize);
  for (const nodeBatchSize of [0, -1, 1001, 1.5, NaN, '5']) {
    assert.throws(() => resolveNodeBatchSize({ ...settings, nodeBatchSize }), { code: 'INVALID_BATCH_SIZE' });
  }
});

test('custom nodes query more than five accounts, history ranges and watches in one native batch', async t => {
  // Given: a custom node has no public gatekeeper limit or explicit override.
  const requests = [];
  const reader = await server(t, async (req, res) => {
    const body = await requestBody(req);
    requests.push({ path: req.url, body });
    if (req.url === '/accounts') res.end('[' + body.addresses.toReversed().map(value => account(publicKeyOf(value), '1')).join(',') + ']');
    else if (req.url === '/accounts/stream') res.end(body.addresses.map(value => account(publicKeyOf(value), '1')).join('\n') + '\n');
    else res.end(body.search.toReversed().map(range => entry(publicKeyOf(range.address), range.fromHeight)).join('\n') + '\n');
  }, { nodeBatchSize: undefined });

  // When: account reads, history and watches select seven addresses.
  const accounts = await reader.accounts(addresses);
  const history = await reader.list({ event: 'entry', addresses });
  await reader.stream({ event: 'account', addresses }, () => {}, new AbortController().signal);

  // Then: each operation uses one batch, with no repeated row lookups.
  assert.deepEqual(accounts.map(value => value.address.value), addresses);
  assert.deepEqual(history.items.map(value => value.publicKey), addresses.map(publicKeyOf));
  assert.deepEqual(requests.map(value => [value.path, (value.body.addresses ?? value.body.search).length]), [['/accounts', 7], ['/accounts', 7], ['/accounts/entries/stream', 7], ['/accounts/stream', 7]]);
});

test('explicit batch size two controls account queries, finite history and watches', async t => {
  // Given: a custom gateway is configured with a two-address request limit.
  const selected = addresses.slice(0, 6);
  const requests = [];
  const reader = await server(t, async (req, res) => {
    const body = await requestBody(req);
    const size = (body.addresses ?? body.search).length;
    assert.ok(size <= 2);
    requests.push({ path: req.url, size });
    if (req.url === '/accounts') res.end('[' + body.addresses.map(value => account(publicKeyOf(value), '1')).join(',') + ']');
    else if (req.url === '/accounts/stream') res.end(body.addresses.map(value => account(publicKeyOf(value), '1')).join('\n') + '\n');
    else res.end(body.search.toReversed().map(range => entry(publicKeyOf(range.address), range.fromHeight)).join('\n') + '\n');
  }, { nodeBatchSize: 2 });

  // When: every address-selecting reader path uses the override.
  await reader.accounts(selected);
  const page = await reader.list({ event: 'entry', addresses: selected });
  await reader.stream({ event: 'account', addresses: selected }, () => {}, new AbortController().signal);

  // Then: every native batch has two addresses and history retains its input order.
  assert.deepEqual(page.items.map(value => value.publicKey), selected.map(publicKeyOf));
  assert.deepEqual(requests.filter(value => value.path === '/accounts').map(value => value.size), Array(6).fill(2));
  assert.deepEqual(requests.filter(value => value.path === '/accounts/entries/stream').map(value => value.size), [2, 2, 2]);
  assert.deepEqual(requests.filter(value => value.path === '/accounts/stream').map(value => value.size), [2, 2, 2]);
});
