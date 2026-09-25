import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AttoAmount, AttoMnemonic, AttoTransaction, AttoUnit, AttoWork, toAttoIndex } from '@attocash/commons-core';
import { derivedSigner, signingWallet } from '../dist/wallet/signing.js';

function validWork(block) {
  const candidate = AttoWork.Companion.parse('914C000000000000');
  if (candidate.isValid(block)) return candidate;
  for (let nonce = 0; nonce < 1_000_000; nonce++) {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setUint32(0, nonce, true);
    const work = new AttoWork(new Int8Array(bytes.buffer));
    if (work.isValid(block)) return work;
  }
  throw new Error('Could not generate bounded synthetic LOCAL work.');
}

async function fixture(t, stalledRoute) {
  const seed = await (await AttoMnemonic.generate()).toSeedAsync();
  const signer = await derivedSigner(seed, 0);
  const recipient = await derivedSigner(seed, 1);
  const requests = [];
  let stalledSocket;
  const account = JSON.stringify({
    network: 'LOCAL', version: 0, algorithm: 'V1', publicKey: signer.publicKey.toString(),
    height: 3, balance: 1000000000, lastTransactionHash: '33'.repeat(32),
    lastTransactionTimestamp: 1704616009211, representativeAlgorithm: 'V1',
    representativePublicKey: recipient.publicKey.toString(),
  });
  const http = createServer((request, response) => {
    requests.push(request.url);
    if (request.url.startsWith(stalledRoute)) {
      request.resume();
      stalledSocket = request.socket;
      return;
    }
    void (async () => {
      let body = '';
      for await (const chunk of request) body += chunk;
      response.writeHead(200, { 'content-type': 'application/json' });
      if (request.method === 'POST' && request.url === '/accounts') return response.end(`[${account}]`);
      if (request.url.startsWith('/instants/')) {
        const now = new Date().toISOString();
        return response.end(JSON.stringify({ clientInstant: now, serverInstant: now, differenceMillis: 0 }));
      }
      if (request.method === 'POST' && request.url === '/transactions/stream') {
        const transaction = AttoTransaction.fromJson(body);
        assert.equal(await transaction.isValid(), true);
        return response.end(`${transaction.toJson()}\n`);
      }
      response.writeHead(404);
      response.end();
    })().catch(error => {
      response.writeHead(500);
      response.end();
      throw error;
    });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(async () => {
    seed.value.fill(0);
    http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
  });
  const url = `http://127.0.0.1:${http.address().port}`;
  return {
    seed, recipient, requests,
    socket: () => stalledSocket,
    settings: { network: 'LOCAL', nodeUrl: url, workerUrl: url, representative: recipient.address.value, autoReceive: false, minReceiveRaw: '1' },
  };
}

test('Commons account opening cancels a stalled request without signing', { timeout: 25_000 }, async t => {
  const f = await fixture(t, '/accounts');
  let signatures = 0;
  const start = Date.now();
  await assert.rejects(signingWallet(f.seed, 0, f.settings, () => { signatures++; }));
  assert.ok(Date.now() - start < 20_000, 'Account lookup must be bounded by the Commons 10-second HTTP timeout.');
  await delay(100);
  assert.equal(f.socket()?.destroyed, true, 'Timeout must cancel the underlying HTTP request.');
  assert.equal(signatures, 0);
  assert.deepEqual(f.requests, ['/accounts']);
});

test('Commons time lookup cancels a stalled send before signing or publication', { timeout: 25_000 }, async t => {
  const f = await fixture(t, '/instants/');
  let signatures = 0;
  const { wallet } = await signingWallet(f.seed, 0, f.settings, () => { signatures++; });
  t.after(() => wallet.close());
  const start = Date.now();
  await assert.rejects(wallet.sendByIndex(toAttoIndex(0), f.recipient.address, AttoAmount.from(AttoUnit.RAW, '1'), null));
  assert.ok(Date.now() - start < 20_000, 'Time lookup must be bounded by the Commons 10-second HTTP timeout.');
  await delay(100);
  assert.equal(f.socket()?.destroyed, true, 'Timeout must cancel the underlying HTTP request.');
  assert.equal(signatures, 0);
  assert.equal(f.requests.filter(path => path.startsWith('/instants/')).length, 1);
  assert.equal(f.requests.some(path => path.startsWith('/works') || path.startsWith('/transactions')), false);
});

test('prepare-only SEND returns a Commons-valid transaction without publishing or advancing the cached account', async t => {
  // Given an opened LOCAL account, a valid worker, and a signing wallet.
  const f = await fixture(t, '/never');
  const worker = { workBlock: async block => validWork(block), close() {} };
  let approvals = 0;
  const { wallet } = await signingWallet(f.seed, 0, f.settings, () => { approvals++; }, worker);
  t.after(() => wallet.close());
  const index = toAttoIndex(0);
  const before = await wallet.getAccountByIndex(index);
  // When preparing a SEND without asking the wallet to publish it.
  const transaction = await wallet.prepareSendByIndex(index, f.recipient.address, AttoAmount.from(AttoUnit.RAW, '1'), null);

  // Then the transaction is valid, the policy hook ran, and the wallet head is unchanged.
  assert.equal(await transaction.isValid(), true);
  assert.equal(approvals, 1);
  assert.equal(f.requests.some(path => path.startsWith('/transactions')), false);
  assert.equal((await wallet.getAccountByIndex(index)).lastTransactionHash.toString(), before.lastTransactionHash.toString());
});

test('ordinary SEND still publishes and advances the cached account after confirmation', async t => {
  // Given the same LOCAL signing fixture.
  const f = await fixture(t, '/never');
  const worker = { workBlock: async block => validWork(block), close() {} };
  const { wallet } = await signingWallet(f.seed, 0, f.settings, () => {}, worker);
  t.after(() => wallet.close());
  const index = toAttoIndex(0);
  // When the existing SEND operation completes.
  const transaction = await wallet.sendByIndex(index, f.recipient.address, AttoAmount.from(AttoUnit.RAW, '1'), null);

  // Then the ordinary behavior still publishes and advances its cached head.
  assert.equal(await transaction.isValid(), true);
  assert.equal(f.requests.includes('/transactions/stream'), true);
  assert.equal((await wallet.getAccountByIndex(index)).lastTransactionHash.toString(), transaction.hash.toString());
});
