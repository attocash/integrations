// Invoked only by the isolated Market LOCAL integration test with a disposable profile.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { AttoMnemonic, AttoWork } from '@attocash/commons-core';
import { AttoApplication } from '../dist/application/app.js';

const [stage, directory, marketOrigin, nodeOrigin, fundingHash] = process.argv.slice(2);
const secretFile = join(directory, 'e2e-mnemonic');
const secrets = {
  get: async () => readFile(secretFile, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  }),
  set: async phrase => writeFile(secretFile, phrase, { mode: 0o600 }),
};
const request = { amount: '500000000', unit: 'RAW', requestId: 'real-market-local-e2e' };
const digest = value => createHash('sha256').update(value).digest('hex');
const app = new AttoApplication({ directory, secrets });
// The disposable node image has no /works service. Supply valid Commons work
// through the wallet's existing block-worker interface; signing/publication are unchanged.
app.work.worker = () => ({
  async workBlock(block, signal) {
    for (let nonce = 0; nonce < 1_000_000; nonce++) {
      if (signal?.aborted) throw signal.reason;
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setUint32(0, nonce, true);
      const work = new AttoWork(new Int8Array(bytes.buffer));
      if (work.isValid(block)) return work;
      if (nonce % 1000 === 999) await yieldToEventLoop();
    }
    throw new Error('No valid bounded LOCAL work found for the exact block.');
  },
  close() {},
});

try {
  if (stage === 'setup') {
    await app.createWallet((await AttoMnemonic.generate()).phrase);
    const address = (await app.call('address_derive', { index: 0 }));
    await app.call('wallet_configure', { network: 'LOCAL', nodeUrl: nodeOrigin,
      workerUrl: nodeOrigin, representative: address.address, autoReceive: false });
    const { proposal } = await app.call('limits_propose', {
      policy: { perRequest: { amount: '1000000000', unit: 'RAW' },
        rolling: [{ days: 1, amount: '1000000000', unit: 'RAW' }] },
      access: 'spend', pool: { indexes: [0], consolidate: false },
    });
    await app.approveLimitsProposal(proposal.id);
    const connected = await app.connectMarket({ apiUrl: `${marketOrigin}/v1/agent/topups`,
      audience: 'urn:atto-market:agent-api:test', controllerIndex: 0 });
    console.log(JSON.stringify({ stage, address: address.address, publicKey: address.publicKey,
      accountId: connected.accountId, agentId: connected.agentId, identityId: connected.identityId }));
  } else if (stage === 'receive') {
    assert.match(fundingHash, /^[A-Fa-f0-9]{64}$/);
    const received = await app.call('receive', { index: 0, hash: fundingHash });
    console.log(JSON.stringify({ stage, hash: received.hash, status: received.status }));
  } else if (stage === 'first' || stage === 'recover') {
    let observed;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input);
      if (url.origin === marketOrigin && url.pathname.startsWith('/v1/agent/topups/')
        && init.method === 'POST') {
        assert.equal(init.body, undefined, 'The paid continuation must be bodyless.');
        const header = new Headers(init.headers).get('PAYMENT-SIGNATURE');
        assert.ok(header);
        observed = { headerDigest: digest(header), bodyless: true };
        const response = await originalFetch(input, init);
        observed.httpStatus = response.status;
        if (stage === 'first') throw new Error('Injected test-only acknowledgement loss after forwarding.');
        return response;
      }
      return originalFetch(input, init);
    };
    if (stage === 'first') {
      await assert.rejects(app.call('market_topup', request), { code: 'MARKET_UNAVAILABLE' });
      assert.ok(observed, 'Market continuation was not forwarded.');
      const record = app.ledger.get(request.requestId);
      const privateData = app.ledger.externalSecretsFor(request.requestId);
      assert.equal(record.status, 'signed');
      assert.ok(record.hash && privateData.paymentSignature && privateData.transactionJson);
      assert.equal(digest(privateData.paymentSignature), observed.headerDigest);
      console.log(JSON.stringify({ stage, hash: record.hash, status: record.status,
        marketState: record.external.marketState, pendingRaw: app.ledger.usage().pendingRaw,
        paymentIdentifier: record.external.paymentIdentifier,
        headerDigest: observed.headerDigest, transactionDigest: digest(privateData.transactionJson),
        forwardedHttpStatus: observed.httpStatus, bodyless: observed.bodyless }));
    } else {
      const before = app.ledger.get(request.requestId);
      const privateData = app.ledger.externalSecretsFor(request.requestId);
      assert.ok(before.hash && privateData.paymentSignature && privateData.transactionJson);
      await assert.rejects(app.call('market_topup', { ...request, amount: '500000001' }),
        { code: 'REQUEST_CONFLICT' });
      const other = await app.call('address_derive', { index: 1 });
      await assert.rejects(app.call('send', { destination: other.address, amount: '1', unit: 'RAW',
        requestId: 'ordinary-send-blocked-by-market' }), { code: 'POOL_BUSY' });
      const pending = await app.call('market_topup_status', { requestId: request.requestId });
      assert.equal(pending.marketState, 'PENDING');
      const result = await app.call('market_topup', request);
      assert.ok(observed, 'The exact payment was not replayed.');
      assert.ok(['PROCESSED', 'SETTLED'].includes(result.marketState),
        'confirmed funding remains successful after the linked RECEIVE settles');
      assert.equal(result.hash, before.hash);
      assert.equal(observed.headerDigest, digest(privateData.paymentSignature));
      const final = app.ledger.get(request.requestId);
      console.log(JSON.stringify({ stage, hash: final.hash, status: final.status,
        marketState: final.external.marketState, paymentState: final.external.paymentState,
        pendingRaw: app.ledger.usage().pendingRaw, headerDigest: observed.headerDigest,
        transactionDigest: digest(privateData.transactionJson), forwardedHttpStatus: observed.httpStatus,
        bodyless: observed.bodyless, changedRequestRejected: true, ordinarySendBlocked: true,
        pendingBeforeReplay: pending.marketState }));
    }
  } else {
    throw new Error(`Unknown test stage: ${stage}`);
  }
} finally {
  await app.close();
}
