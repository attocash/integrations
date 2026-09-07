import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { AttoAddress, AttoAlgorithm, AttoPublicKey } from '@attocash/commons-core';
import { NodeReader } from '../dist/network/reader.js';
import { WatchManager } from '../dist/watches/manager.js';

const key = '11'.repeat(32);
const otherKey = '22'.repeat(32);
const address = new AttoAddress(AttoAlgorithm.V1, new AttoPublicKey(new Int8Array(32).fill(17))).value;
const otherAddress = new AttoAddress(AttoAlgorithm.V1, new AttoPublicKey(new Int8Array(32).fill(34))).value;
const entry = (publicKey, height) => JSON.stringify({ hash: height.toString(16).padStart(64, '0'), algorithm: 'V1', publicKey, height, blockType: 'RECEIVE', subjectAlgorithm: 'V1', subjectPublicKey: otherKey, previousBalance: 0, balance: 100, timestamp: 1704616009211 });

async function fixture(t, handler, options = {}, checkpoints) {
  const http = createServer((req, res) => { Promise.resolve(handler(req, res)).catch(() => { res.statusCode = 500; res.end(); }); });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const reader = new NodeReader({ network: 'LOCAL', nodeUrl: `http://127.0.0.1:${http.address().port}`, workerUrl: 'http://127.0.0.1', representative: address, autoReceive: false, minReceiveRaw: '1' });
  const manager = new WatchManager(reader, checkpoints, { backoffMs: 10, maxBackoffMs: 30, ...options });
  t.after(async () => { await manager.close(); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); });
  return { reader, manager };
}

async function until(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('address watches replay reconnects at each account height without duplicate events', async t => {
  const calls = [];
  const { manager } = await fixture(t, (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const publicKey = url.pathname.split('/')[2];
    const from = Number(url.searchParams.get('fromHeight'));
    calls.push([publicKey, from]);
    if (from === 1) res.end(entry(publicKey, 1) + '\n');
    else res.write(entry(publicKey, 2) + '\n' + entry(publicKey, 3) + '\n');
  });
  const watch = manager.start({ event: 'entry', addresses: [address, otherAddress] });
  await until(() => manager.read(watch.id).events.length === 6);
  const page = manager.read(watch.id);
  assert.equal(page.gapDetected, false);
  assert.equal(new Set(page.events.map(value => `${value.data.publicKey}:${value.data.height}`)).size, 6);
  assert.deepEqual(calls.filter(value => value[0] === key).map(value => value[1]), [1, 2]);
  assert.deepEqual(calls.filter(value => value[0] === otherKey).map(value => value[1]), [1, 2]);
  await manager.stop(watch.id);
  assert.equal(manager.read(watch.id).status, 'stopped');
});

test('persistent checkpoints acknowledge delivered pages and replay unread events after restart', async t => {
  const persisted = new Map();
  const checkpoints = { get: key => persisted.get(key), set: (key, value) => persisted.set(key, value) };
  const requested = [];
  const { manager, reader } = await fixture(t, (req, res) => {
    const from = Number(new URL(req.url, 'http://localhost').searchParams.get('fromHeight'));
    requested.push(from);
    res.write(Array.from({ length: 4 - from }, (_, offset) => entry(key, from + offset)).join('\n') + '\n');
  }, {}, checkpoints);
  const filter = { event: 'entry', addresses: [address] };
  const first = manager.start(filter);
  await until(() => manager.read(first.id).events.length === 3);
  const page = manager.read(first.id, 0, 1);
  assert.equal(page.events[0].data.height, '1');
  assert.equal(persisted.size, 0, 'arrival and unacknowledged page reads must not advance persistent height');
  const unreadPage = manager.read(first.id, page.nextCursor, 1);
  assert.equal(unreadPage.events[0].data.height, '2');
  assert.deepEqual([...persisted.values()], [{ [address]: '1' }]);
  await manager.close();
  const restarted = new WatchManager(reader, checkpoints, { backoffMs: 10 });
  t.after(() => restarted.close());
  const second = restarted.start(filter);
  await until(() => restarted.read(second.id).events.length === 2);
  assert.equal(requested.at(-1), 2);
  assert.deepEqual(restarted.read(second.id).events.map(value => value.data.height), ['2', '3']);
});

test('watch retention bounds memory and reports event gaps with a usable next cursor', async t => {
  const { manager } = await fixture(t, (_req, res) => {
    res.write(Array.from({ length: 5 }, (_, offset) => entry(key, offset + 1)).join('\n') + '\n');
  }, { retention: 3 });
  const watch = manager.start({ event: 'entry', addresses: [address] });
  await until(() => manager.read(watch.id).latestCursor === 5);
  const page = manager.read(watch.id, 0, 2);
  assert.equal(page.gapDetected, true);
  assert.equal(page.oldestCursor, 3);
  assert.deepEqual(page.events.map(value => value.cursor), [3, 4]);
  assert.equal(page.nextCursor, 4);
  assert.equal(manager.read(watch.id, page.nextCursor).gapDetected, false);
});

test('nonreplayable disconnects emit gap markers and suppress repeated snapshot events', async t => {
  let connections = 0;
  const { manager } = await fixture(t, (_req, res) => {
    connections++;
    if (connections === 1) res.end(entry(key, 1) + '\n');
    else res.write(entry(key, 1) + '\n' + entry(key, 2) + '\n');
  });
  const watch = manager.start({ event: 'entry' });
  await until(() => manager.read(watch.id).events.filter(value => value.data.height).length === 2);
  const page = manager.read(watch.id);
  assert.equal(page.replayable, false);
  assert.equal(page.gapDetected, true);
  assert.deepEqual(page.events.filter(value => value.data.height).map(value => value.data.height), ['1', '2']);
  assert.deepEqual(page.events.find(value => value.data.type === 'gap').data, { type: 'gap', reason: 'disconnected', replayable: false });
});

test('stopping cancels reconnect backoff and frees a bounded session slot', async t => {
  let calls = 0;
  const { manager } = await fixture(t, (_req, res) => { calls++; res.statusCode = 503; res.end('secret response'); }, { maxWatches: 1, backoffMs: 500, maxBackoffMs: 500 });
  const watch = manager.start({ event: 'account' });
  assert.throws(() => manager.start({ event: 'account' }), { code: 'WATCH_LIMIT' });
  await until(() => manager.read(watch.id).status === 'reconnecting');
  assert.equal(manager.read(watch.id).lastError.message.includes('secret'), false);
  const before = Date.now();
  await manager.stop(watch.id);
  assert.ok(Date.now() - before < 150);
  assert.equal(calls, 1);
  const replacement = manager.start({ event: 'account' });
  assert.notEqual(replacement.id, watch.id);
  assert.throws(() => manager.read(watch.id), { code: 'WATCH_NOT_FOUND' });
});

test('bounded height watches finish without reconnecting and reject cursor misuse', async t => {
  let connections = 0;
  const { manager } = await fixture(t, (_req, res) => { connections++; res.end(entry(key, 2) + '\n' + entry(key, 3) + '\n'); });
  const watch = manager.start({ event: 'entry', addresses: [address], fromHeight: '2', toHeight: '3' });
  await until(() => manager.read(watch.id).status === 'completed');
  assert.equal(connections, 1);
  assert.deepEqual(manager.read(watch.id).events.map(value => value.data.height), ['2', '3']);
  assert.throws(() => manager.read(watch.id, 999), { code: 'INVALID_WATCH_CURSOR' });
  assert.throws(() => manager.read(watch.id, 0, 0), { code: 'INVALID_WATCH_CURSOR' });
});

test('height gaps trigger reconnect without advancing checkpoint past missing events', async t => {
  const heights = [];
  let calls = 0;
  const { manager } = await fixture(t, (req, res) => {
    calls++;
    heights.push(new URL(req.url, 'http://localhost').searchParams.get('fromHeight'));
    if (calls === 1) res.end(entry(key, 1) + '\n' + entry(key, 3) + '\n');
    else res.write(entry(key, 2) + '\n' + entry(key, 3) + '\n');
  });
  const watch = manager.start({ event: 'entry', addresses: [address] });
  await until(() => manager.read(watch.id).events.length === 3);
  assert.deepEqual(heights, ['1', '2']);
  assert.deepEqual(manager.read(watch.id).events.map(value => value.data.height), ['1', '2', '3']);
});
