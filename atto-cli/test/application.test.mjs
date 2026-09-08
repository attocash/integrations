import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AttoBlock } from '@attocash/commons-core';
import { AttoApplication } from '../dist/application/app.js';
import { MarketData } from '../dist/pricing/market.js';
import { marketTerms } from '../dist/pricing/terms.js';
import { defaultSettings, representativePublicKeys } from '../dist/wallet/defaults.js';
import { parseAddress } from '../dist/network/reader.js';
import { amountOutput, amountRaw } from '../dist/domain/amount.js';

function fixture(t, market) {
  const directory = mkdtempSync(join(tmpdir(), 'atto-application-'));
  let phrase = null;
  let reads = 0;
  const secrets = { get: async () => { reads++; return phrase; }, set: async value => { phrase = value; } };
  const sessions = [];
  const open = () => { const app = new AttoApplication({ directory, secrets, market }); sessions.push(app); return app; };
  t.after(async () => { for (const app of sessions.reverse()) await app.close(); rmSync(directory, { recursive: true, force: true }); });
  return { app: open(), open, directory, secrets, get phrase() { return phrase; }, get reads() { return reads; } };
}

test('public operations on an empty wallet do not read credentials or query a global history', async t => {
  const f = fixture(t);
  assert.equal((await f.app.call('wallet_status')).initialized, false);
  assert.deepEqual(await f.app.call('balances_get'), { balances: [], total: { raw: '0', atto: '0' } });
  assert.deepEqual(await f.app.call('history_list', { event: 'transaction' }), { items: [], timedOut: false });
  assert.deepEqual(await f.app.call('receivables_list'), { items: [], timedOut: false });
  assert.equal(f.reads, 0);
});

test('mnemonic stays in injected password storage while public metadata survives restart', async t => {
  const f = fixture(t);
  await f.app.createWallet();
  const address = await f.app.call('address_activate', { index: 1 });
  assert.equal(address.active, true);
  await f.app.call('address_deactivate', { index: 0 });
  const status = await f.app.call('wallet_status');
  assert.equal(status.addresses[0].active, false);
  assert.equal(f.phrase.split(' ').length, 24);
  assert.equal(JSON.stringify(status).includes(f.phrase), false);
  for (const name of readdirSync(f.directory)) assert.equal(readFileSync(join(f.directory, name)).includes(Buffer.from(f.phrase)), false);
  await f.app.close();
  const reopened = f.open();
  assert.deepEqual((await reopened.call('wallet_status')).addresses, status.addresses);
  assert.equal(await reopened.backupMnemonic(), f.phrase);
});

test('credential mismatch prevents deriving new keys without changing public wallet state', async t => {
  const first = fixture(t);
  const second = fixture(t);
  await first.app.createWallet();
  await second.app.createWallet();
  await first.secrets.set(second.phrase);
  await assert.rejects(first.app.call('address_derive', { index: 1 }), { code: 'WALLET_MISMATCH' });
  assert.equal((await first.app.call('address_list')).addresses.length, 1);
});

test('empty credential lookups distinguish an initialized profile from a new wallet', async t => {
  // Given a new profile with neither public identity nor a saved credential.
  const f = fixture(t);
  await assert.rejects(f.app.backupMnemonic(), { code: 'WALLET_NOT_INITIALIZED' });
  await f.app.createWallet();
  const before = await f.app.call('wallet_status');

  // When its external password store subsequently returns no credential.
  await f.secrets.set(null);

  // Then recovery and key derivation report missing credentials while retaining public identity.
  await assert.rejects(f.app.backupMnemonic(), { code: 'WALLET_CREDENTIAL_MISSING' });
  await assert.rejects(f.app.call('address_derive', { index: 1 }), { code: 'WALLET_CREDENTIAL_MISSING' });
  assert.deepEqual((await f.app.call('wallet_status')).identity, before.identity);
  assert.deepEqual((await f.app.call('address_list')).addresses, before.addresses);
});

test('USD terms must be explicitly accepted at the current version before price lookup', async t => {
  let lookups = 0;
  const market = new MarketData(undefined, async () => { lookups++; throw new Error('not requested'); });
  const { app } = fixture(t, market);
  const request = { destination: defaultSettings().representative, amount: '1', unit: 'USD', requestId: 'usd-terms' };
  await assert.rejects(app.call('send', request), { code: 'TERMS_REQUIRED' });
  await assert.rejects(app.call('terms_accept', { version: 'old', accepted: true }), { code: 'TERMS_VERSION' });
  await assert.rejects(app.call('terms_accept', { version: marketTerms.version, accepted: false }), { code: 'INVALID_INPUT' });
  assert.equal(lookups, 0);
  await app.call('terms_accept', { version: marketTerms.version, accepted: true });
  assert.equal((await app.call('terms_get')).accepted, true);
  await app.call('wallet_configure', { network: 'LOCAL' });
  await assert.rejects(app.call('send', request), { code: 'NETWORK_MISMATCH' });
  await assert.rejects(app.call('send', { ...request, requestId: 'local-usd' }), { code: 'USD_NETWORK' });
  assert.equal(lookups, 0);
  await app.call('wallet_configure', { network: 'LIVE' });
  await assert.rejects(app.call('send', request), { code: 'MARKET_DATA_UNAVAILABLE' });
  assert.equal(lookups, 1);
});

test('published USD retries survive restart with the original quote without reading new prices', async t => {
  let lookups = 0;
  const market = new MarketData(undefined, async () => { lookups++; throw new Error('price service offline'); });
  const f = fixture(t, market);
  const request = { index: 0, destination: defaultSettings().representative, amount: '1', unit: 'USD', requestId: 'usd-paid' };
  const quote = { usd: '1', priceUsd: '0.00003594', priceDate: '2026-09-04', amount: { raw: '27824151363383', atto: '27824.151363383' }, informational: true };
  const result = { status: 'published', hash: 'A'.repeat(64), requestId: request.requestId, quote };
  f.app.ledger.reserve({ id: request.requestId, index: 0, destination: request.destination, raw: quote.amount.raw, createdAt: Date.now() });
  f.app.ledger.signed(request.requestId, result.hash, '{}');
  f.app.store.set(`send.quote.${request.requestId}`, quote);
  f.app.ledger.complete(request.requestId, result, Date.now());
  await f.app.close();
  const app = f.open();
  assert.deepEqual(await app.call('send', request), result);
  await assert.rejects(app.call('send', { ...request, amount: '2' }), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(app.call('send', { ...request, amount: quote.amount.atto, unit: 'ATTO' }), { code: 'REQUEST_CONFLICT' });
  assert.equal(lookups, 0);
});

test('concurrent watch creation retains every session ID and stops after configuration changes', async t => {
  const { app } = fixture(t);
  await app.call('wallet_configure', { nodeUrl: 'http://127.0.0.1:1', autoReceive: false });
  const watches = await Promise.all(['account', 'transaction', 'entry'].map(event => app.call('watch_start', { event, networkWide: true })));
  assert.deepEqual(new Set((await app.call('watch_list')).map(watch => watch.id)), new Set(watches.map(watch => watch.id)));
  await app.call('wallet_configure', { minReceiveRaw: '2' });
  assert.deepEqual(await app.call('watch_list'), []);
});

test('uncertain USD retries retain their original conversion and spending reservation across restart', async t => {
  let lookups = 0;
  const market = new MarketData(undefined, async () => { lookups++; throw new Error('price changed or unavailable'); });
  const http = createServer((_request, response) => { response.writeHead(404); response.end(); });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(async () => { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); });
  const f = fixture(t, market);
  await f.app.call('wallet_configure', { network: 'LOCAL', nodeUrl: `http://127.0.0.1:${http.address().port}` });
  const block = AttoBlock.fromJson(JSON.stringify({ type: 'SEND', network: 'LOCAL', version: 0, algorithm: 'V1',
    publicKey: representativePublicKeys[0], height: 2, balance: 90, timestamp: 1704616009211, previous: '11'.repeat(32),
    receiverAlgorithm: 'V1', receiverPublicKey: representativePublicKeys[1], amount: 10 }));
  const request = { index: 0, destination: block.receiverAddress.value, amount: '1', unit: 'USD', requestId: 'usd-uncertain' };
  const quote = { usd: '1', amount: { raw: '10', atto: '0.00000001' }, priceUsd: '100000000', informational: true };
  f.app.ledger.setPolicy({ perRequest: null, rolling: [{ days: 1, amount: '10', unit: 'RAW' }] });
  f.app.ledger.reserve({ id: request.requestId, index: 0, destination: request.destination, raw: '10', createdAt: Date.now() });
  f.app.ledger.signed(request.requestId, block.hash.toString(), block.toJson());
  f.app.ledger.uncertain(request.requestId);
  f.app.store.set(`send.quote.${request.requestId}`, quote);
  await f.app.close();
  const app = f.open();
  for (let retry = 0; retry < 2; retry++) await assert.rejects(app.call('send', request), { code: 'PUBLICATION_UNCERTAIN' });
  assert.equal((await app.call('limits_get')).rolling[0].remainingRaw, '0');
  assert.deepEqual(app.store.get(`send.quote.${request.requestId}`), quote);
  assert.equal(lookups, 0);
  assert.equal(f.reads, 0);
});

test('active address capacity is enforced before credential access and frees on deactivation', async t => {
  const f = fixture(t);
  await f.app.createWallet();
  for (let index = 1; index < 100; index++) await f.app.call('address_activate', { index });
  const reads = f.reads;
  await assert.rejects(f.app.call('address_activate', { index: 100 }), { code: 'ACTIVE_ADDRESS_LIMIT' });
  assert.equal(f.reads, reads);
  await f.app.call('address_deactivate', { index: 1 });
  assert.equal((await f.app.call('address_activate', { index: 100 })).active, true);
});

test('all twelve desktop representatives are valid and initialization keeps its selected representative', async t => {
  assert.equal(representativePublicKeys.length, 12);
  assert.equal(new Set(representativePublicKeys.map(key => key.toUpperCase())).size, 12);
  const { app, open } = fixture(t);
  const settings = (await app.call('wallet_status')).settings;
  assert.ok(representativePublicKeys.some(key => key.toUpperCase() === parseAddress(settings.representative).publicKey.toString().toUpperCase()));
  await app.close();
  assert.equal((await open().call('wallet_status')).settings.representative, settings.representative);
});

test('amounts preserve raw precision and reject accidental sub-RAW rounding', () => {
  assert.equal(amountRaw('1.000000001'), '1000000001');
  assert.equal(amountRaw('1.0000000010'), '1000000001');
  assert.equal(amountRaw('100.000', 'RAW'), '100');
  for (const [value, unit] of [['1.0000000001', 'ATTO'], ['0.1', 'RAW'], ['0', 'RAW']]) assert.throws(() => amountRaw(value, unit), { code: 'INVALID_AMOUNT' });
  assert.deepEqual(amountOutput('18446744073709551616'), { raw: '18446744073709551616', atto: '18446744073.709551616' });
});
