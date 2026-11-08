import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AttoAlgorithm, AttoPublicKey } from '@attocash/commons-core';
import { AttoApplication } from '../dist/application/app.js';

const keys = Array.from({ length: 7 }, (_, index) => (index + 17).toString(16).repeat(32));
const addresses = keys.map(key => AttoPublicKey.Companion.parse(key).toAddress(AttoAlgorithm.V1).value);
const raw = '9007199254740993';
const account = (publicKey, height = '4') => `{"publicKey":"${publicKey}","network":"LOCAL","version":0,"algorithm":"V1","height":${height},"balance":${raw},"lastTransactionHash":"${'ab'.repeat(32)}","lastTransactionTimestamp":1704616009211,"representativeAlgorithm":"V1","representativePublicKey":"${keys[1]}"}`;

async function fixture(t, handler) {
  const directory = await mkdtemp(join(tmpdir(), 'atto-read-queries-'));
  let secretReads = 0;
  const http = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(error => { res.statusCode = 500; res.end(String(error)); });
  });
  const applications = new Set();
  const open = (options = {}) => {
    const app = new AttoApplication({ directory, ...options });
    applications.add(app);
    return app;
  };
  t.after(async () => {
    for (const app of applications) await app.close();
    http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const app = open({ secrets: { get: async () => { secretReads++; return null; }, set: async () => assert.fail('Read queries cannot write credentials') } });
  await app.call('wallet_configure', { network: 'LOCAL', nodeUrl: `http://127.0.0.1:${http.address().port}`, nodeBatchSize: 5, autoReceive: false });
  return { app, directory, open, secretReads: () => secretReads };
}

test('batch override persists, resetting to auto follows the configured endpoint, and status reports the effective size', async t => {
  // Given a custom node supporting a whole selected set in one query.
  const batches = [];
  const f = await fixture(t, async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/accounts');
    let text = '';
    for await (const part of req) text += part;
    const selected = JSON.parse(text).addresses;
    batches.push(selected.length);
    res.end('[' + selected.map(address => account(keys[addresses.indexOf(address)])).join(',') + ']');
  });

  // When selecting automatic custom-node sizing, then storing an explicit size and reopening the profile.
  await f.app.call('wallet_configure', { nodeBatchSize: null });
  assert.equal((await f.app.call('wallet_status')).effectiveNodeBatchSize, 1000);
  await f.app.call('account_get', { addresses });
  await f.app.call('wallet_configure', { nodeBatchSize: 2 });
  const reopened = f.open();
  const saved = await reopened.call('wallet_status');
  await reopened.call('account_get', { addresses });
  await reopened.call('wallet_configure', { nodeUrl: 'https://gatekeeper.live.application.atto.cash', nodeBatchSize: null });
  const automatic = await reopened.call('wallet_status');

  // Then the override survives restart, requests honor it, and auto restores gateway defaults without a query.
  assert.equal(saved.settings.nodeBatchSize, 2);
  assert.equal(saved.effectiveNodeBatchSize, 2);
  assert.deepEqual(batches, [7, 2, 2, 2, 1]);
  assert.equal(automatic.settings.nodeBatchSize, null);
  assert.equal(automatic.effectiveNodeBatchSize, 5);
  assert.equal(f.secretReads(), 0);
});

test('bulk full-account and balance queries share gateway-sized requests without credentials', async t => {
  // Given seven external accounts, one unopened, and an upstream that returns snapshots in reverse order.
  const requests = [];
  const f = await fixture(t, async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/accounts');
    let text = '';
    for await (const part of req) text += part;
    const batch = JSON.parse(text).addresses;
    assert.ok(batch.length <= 5);
    requests.push(batch);
    res.end('[' + batch.filter(address => address !== addresses[1]).reverse().map(address => account(keys[addresses.indexOf(address)])).join(',') + ']');
  });

  // When reading full snapshots and balances, with a duplicate address in the selection.
  const full = await f.app.call('account_get', { addresses: [...addresses, addresses[0]] });
  const balances = await f.app.call('balances_get', { addresses });

  // Then callers receive full ordered snapshots and exact totals from two bulk queries per operation.
  assert.deepEqual(full.accounts.map(row => row.address), addresses);
  assert.equal(full.accounts[1].account, null);
  assert.equal(full.accounts[0].account.height, '4');
  assert.equal(full.accounts[0].account.balance, raw);
  assert.equal(full.accounts[0].account.representativePublicKey, keys[1].toUpperCase());
  assert.deepEqual(balances.balances.map(row => row.found), [true, false, true, true, true, true, true]);
  assert.equal(balances.total.raw, (BigInt(raw) * 6n).toString());
  assert.deepEqual(requests.map(batch => batch.length), [5, 2, 5, 2]);
  assert.equal(f.secretReads(), 0);
});

test('single account reads keep their existing shape and reject ambiguous bulk selectors', async t => {
  // Given the existing single-account GET route and no initialized wallet credential.
  const requests = [];
  const f = await fixture(t, (req, res) => {
    requests.push(req.url);
    if (req.url === `/accounts/${keys[0].toUpperCase()}`) res.end(account(keys[0]));
    else { res.statusCode = 404; res.end(); }
  });

  // When requesting an existing or unopened single account, or mixing single and bulk selectors.
  const one = await f.app.call('account_get', { address: addresses[0] });
  const unopened = await f.app.call('account_get', { address: addresses[1] });
  await assert.rejects(f.app.call('account_get', { address: addresses[0], addresses: [addresses[1]] }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.app.call('account_get', { index: 0, addresses: [addresses[1]] }), { code: 'INVALID_INPUT' });

  // Then legacy consumers keep {account}, and invalid selections never reach the network.
  assert.equal(one.account.balance, raw);
  assert.equal(one.accounts, undefined);
  assert.equal(unopened.account, null);
  assert.equal(requests.length, 2);
  assert.equal(f.secretReads(), 0);
});

test('entry lookup and default history expose action subjects without raw transaction lookups', async t => {
  // Given an account that opens, sends, receives, and changes its representative.
  const actions = [
    ['OPEN', '0', raw], ['SEND', raw, '9007198004740993'],
    ['RECEIVE', '9007198004740993', '9007199254740993'], ['CHANGE', raw, raw],
  ];
  const entries = actions.map(([blockType, previousBalance, balance], i) => JSON.stringify({
    hash: (i + 1).toString(16).padStart(64, '0'), algorithm: 'V1', publicKey: keys[0], height: i + 1, blockType,
    subjectAlgorithm: 'V1', subjectPublicKey: keys[1], previousBalance, balance, timestamp: 1704616009211 + i,
  }));
  const requests = [];
  const f = await fixture(t, async (req, res) => {
    requests.push(req.url);
    if (req.url === '/accounts/entries/stream') res.end(entries.join('\n') + '\n');
    else if (req.url.startsWith('/accounts/entries/')) {
      const hash = req.url.split('/')[3];
      res.end(entries[Number.parseInt(hash, 16) - 1] + '\n');
    } else if (req.url === '/accounts') res.end('[' + account(keys[0]) + ']');
    else { res.statusCode = 404; res.end(); }
  });

  // When querying an individual action and the default entry history.
  const change = await f.app.call('entry_get', { hash: '4'.padStart(64, '0') });
  const page = await f.app.call('history_list', { addresses: [addresses[0]] });

  // Then owner/subject semantics and exact transfer amounts are ready for both CLI and MCP consumers.
  assert.equal(change.entry.subjectRole, 'representative');
  assert.equal(change.entry.subjectAddress, addresses[1]);
  assert.equal(change.entry.amount, undefined);
  assert.deepEqual(page.items.map(row => row.subjectRole), ['sender', 'receiver', 'sender', 'representative']);
  assert.ok(page.items.every(row => row.address === addresses[0] && row.subjectAddress === addresses[1]));
  assert.deepEqual(page.items[0].amount, { raw, atto: '9007199.254740993' });
  assert.deepEqual(page.items[1].amount, { raw: '1250000000', atto: '1.25' });
  assert.equal(page.nextCursor, undefined);
  assert.ok(requests.every(path => !path.startsWith('/transactions')));
  assert.equal(f.secretReads(), 0);
});
