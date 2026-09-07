import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AttoAmount, AttoMnemonic, AttoUnit, toAttoIndex } from '@attocash/commons-core';
import { derivedSigner, signingWallet } from '../dist/wallet/signing.js';

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
    request.resume();
    if (request.url.startsWith(stalledRoute)) {
      stalledSocket = request.socket;
      return;
    }
    if (request.method === 'POST' && request.url === '/accounts') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(`[${account}]`);
    } else {
      response.writeHead(500);
      response.end();
    }
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
