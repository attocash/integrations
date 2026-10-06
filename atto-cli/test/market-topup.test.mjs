import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './support/payments.mjs';
import { AttoError } from '../dist/domain/errors.js';
import { parseAttoExactRequirement } from '../dist/spending/atto-x402.js';
import { MarketTopUpClient } from '../dist/market/topups.js';

const apiUrl = 'http://127.0.0.1:43210/v1/agent/topups';
const intentId = '00000000-0000-4000-8000-000000000079';

function marketStatus(amountRaw, changes = {}) {
  return { intentId, asset: 'ATTO', network: 'atto:local', amountAtomic: amountRaw,
    state: 'PENDING', expiresAt: new Date(Date.now() + 300_000).toISOString(),
    sendHash: null, payer: null, paymentState: null, receivePending: null, discrepancy: null, receiveStatus: null,
    ...changes };
}

function mockTopUps(app, amountRaw, onPay = async () => {}) {
  const identity = app.store.get('identity');
  const controller = app.store.get('addresses').find(value => value.index === 0);
  const connection = { version: 1, apiUrl, audience: 'market-test', controllerIndex: 0,
    controllerAddress: controller.address, accountId: '00000000-0000-4000-8000-000000000100', agentId: '00000000-0000-4000-8000-000000000102',
    identityId: '00000000-0000-4000-8000-000000000101', walletFingerprint: identity.fingerprint };
  let status = marketStatus(amountRaw);
  const requirementJson = JSON.stringify({ x402Version: 2,
    resource: { url: `${apiUrl}/${intentId}` },
    accepts: [{ scheme: 'exact', network: 'atto:local', amount: amountRaw, asset: 'atto',
      payTo: app.store.get('addresses').find(value => value.index === 1).address,
      maxTimeoutSeconds: 300, extra: { assetTransferMethod: 'native', paymentFlow: 'authorization' } }],
    extensions: { 'payment-identifier': { schema: { type: 'object', properties: { id: { type: 'string' } } }, info: { required: true } } },
  });
  const challenge = { status, requirement: parseAttoExactRequirement({
    header: Buffer.from(requirementJson, 'utf8').toString('base64'), apiUrl, intentId,
    network: 'atto:local', amountRaw,
  }), requirementHeader: Buffer.from(requirementJson, 'utf8').toString('base64') };
  return {
    connection: () => connection,
    challenge: async (_connection, _paymentIdentifier, raw) => {
      assert.equal(raw, amountRaw);
      return { status, challenge };
    },
    status: async (_connection, requestedIntent, _paymentIdentifier, raw, network) => {
      assert.equal(requestedIntent, intentId);
      assert.equal(raw, amountRaw);
      assert.equal(network, 'atto:local');
      return status;
    },
    pay: async (_connection, _status, paymentIdentifier, header, expected, beforeSubmit) => {
      await onPay({ app, paymentIdentifier, header, expected, beforeSubmit, setStatus: value => { status = value; } });
      return status;
    },
  };
}

test('x402 exact bytes survive an unknown outcome and restart; ordinary sends stay behind the frontier lock', { timeout: 30_000 }, async t => {
  // Given a funded LOCAL wallet and a Market endpoint that loses each continuation acknowledgement.
  const f = await fixture(t, [10]);
  const request = { amount: '2', unit: 'RAW', requestId: 'market-timeout-recovery' };
  const submitted = [];
  const install = app => {
    app.payments.topUps = mockTopUps(app, '2', async context => {
      await context.beforeSubmit();
      const record = app.ledger.get(request.requestId);
      const secrets = app.ledger.externalSecretsFor(request.requestId);
      assert.ok(record.hash, 'The native hash must be durable before the continuation request.');
      assert.equal(secrets.paymentSignature, context.header);
      submitted.push({ hash: record.hash, header: context.header, transaction: secrets.transactionJson });
      context.setStatus(marketStatus('2', { state: 'PENDING', paymentState: 'PENDING', sendHash: record.hash }));
      throw new AttoError('MARKET_UNAVAILABLE', 'Synthetic lost acknowledgement.');
    });
  };
  install(f.app);

  // When Market receives the first exact continuation but its acknowledgement is lost.
  await assert.rejects(f.app.call('market_topup', request), { code: 'MARKET_UNAVAILABLE' });

  // Then the exact signed bytes and allowance remain private, durable, and reserved.
  const first = f.app.ledger.get(request.requestId);
  assert.equal(first.status, 'signed');
  assert.ok(first.hash);
  assert.deepEqual(first.plan, { indexes: [first.index], steps: [] }, 'An x402 top-up signs one pool account and never consolidates.');
  assert.equal(f.app.ledger.usage().pendingRaw, '2');
  assert.equal(f.app.ledger.externalSecretsFor(request.requestId).paymentSignature, submitted[0].header);
  const publicJournal = JSON.stringify(f.app.ledger.journalGet(request.requestId));
  assert.equal(publicJournal.includes(submitted[0].header), false);
  assert.equal(publicJournal.includes(submitted[0].transaction), false);

  // And the public status operation only reads the same intent and transaction.
  const status = await f.app.call('market_topup_status', { requestId: request.requestId });
  assert.equal(status.requestId, request.requestId);
  assert.equal(status.hash, submitted[0].hash);

  // And an ordinary send cannot use the still-reserved account.
  await assert.rejects(f.app.call('send', f.request('ordinary-blocked-by-x402', '1')), { code: 'POOL_BUSY' });

  // When the same request is resumed after reopening the wallet database.
  await f.reopen();
  install(f.app);
  await assert.rejects(f.app.call('market_topup', request), { code: 'MARKET_UNAVAILABLE' });

  // Then recovery replays the same payment identifier, transaction, and header without a replacement SEND.
  assert.equal(submitted.length, 2);
  assert.deepEqual(submitted[1], submitted[0]);
  assert.equal(f.app.ledger.get(request.requestId).hash, submitted[0].hash);
  assert.equal(f.app.ledger.usage().pendingRaw, '2');
  assert.equal(f.state.publicationAttempts.length, 0);
  await assert.rejects(f.app.call('send', f.request('ordinary-blocked-after-restart', '1')), { code: 'POOL_BUSY' });
});

test('ACCEPTED and SETTLED top-up states are usable and never trigger a second SEND', { timeout: 30_000 }, async t => {
  const f = await fixture(t, [10]);
  const request = { amount: '2', unit: 'RAW', requestId: 'market-processed-settled-once' };
  let submissions = 0;
  let status = marketStatus('2');
  let updateStatus;
  f.app.payments.topUps = mockTopUps(f.app, '2', async context => {
    submissions++;
    await context.beforeSubmit();
    updateStatus = context.setStatus;
    const record = context.app.ledger.get(request.requestId);
    status = marketStatus('2', { state: 'ACCEPTED', paymentState: 'ACCEPTED',
      sendHash: record.hash, payer: record.sourceAddress, receivePending: true });
    updateStatus(status);
  });

  const processed = await f.app.call('market_topup', request);
  assert.equal(processed.marketState, 'ACCEPTED');
  assert.equal(processed.paymentState, 'ACCEPTED');
  assert.equal(submissions, 1);

  status = { ...status, state: 'SETTLED', paymentState: 'SETTLED', receivePending: false, receiveStatus: 'SETTLED' };
  updateStatus(status);
  const settled = await f.app.call('market_topup_status', { requestId: request.requestId });
  assert.equal(settled.marketState, 'SETTLED');
  assert.equal(settled.paymentState, 'SETTLED');
  const replay = await f.app.call('market_topup', request);
  assert.equal(replay.marketState, 'SETTLED');
  assert.equal(submissions, 1, 'usable status must not submit another payment');
  assert.equal(f.app.ledger.get(request.requestId).hash, processed.hash);
});

test('a legacy CREDITED wallet journal remains readable without replaying its old SEND against a reset Market', { timeout: 30_000 }, async t => {
  const f = await fixture(t, [10]);
  const request = { amount: '2', unit: 'RAW', requestId: 'market-legacy-credited' };
  let continuationAttempts = 0;
  f.app.payments.topUps = mockTopUps(f.app, '2', async context => {
    continuationAttempts++;
    await context.beforeSubmit();
    throw new AttoError('MARKET_UNAVAILABLE', 'Synthetic lost acknowledgement.');
  });
  await assert.rejects(f.app.call('market_topup', request), { code: 'MARKET_UNAVAILABLE' });

  const original = f.app.ledger.get(request.requestId);
  const originalSecrets = f.app.ledger.externalSecretsFor(request.requestId);
  assert.ok(original.hash);
  f.app.ledger.externalStatus(request.requestId, { marketState: 'CREDITED', paymentState: 'CONFIRMED' });
  await f.reopen();

  // The preserved profile can be disconnected from the freshly reset Market database.
  f.app.payments.topUps = undefined;
  const status = await f.app.call('market_topup_status', { requestId: request.requestId });
  const replay = await f.app.call('market_topup', request);

  assert.equal(status.marketState, 'PENDING');
  assert.equal(status.historicalOnly, true);
  assert.equal(status.currentMarketBalance, 'unverified');
  assert.match(status.message, /does not establish a balance in the current Market database/);
  assert.equal(replay.marketState, 'PENDING');
  assert.equal(replay.historicalOnly, true);
  assert.equal(continuationAttempts, 1, 'the old continuation must never be submitted again');
  assert.equal(f.app.ledger.get(request.requestId).hash, original.hash);
  assert.deepEqual({ hash: f.app.ledger.get(request.requestId).hash,
    transactionJson: f.app.ledger.externalSecretsFor(request.requestId).transactionJson,
    paymentSignature: f.app.ledger.externalSecretsFor(request.requestId).paymentSignature },
  { hash: original.hash, transactionJson: originalSecrets.transactionJson,
    paymentSignature: originalSecrets.paymentSignature });
  assert.equal(f.state.publicationAttempts.length, 0, 'the recorded signed SEND must not be published again');
});

test('a malformed terminal recovery response leaves the signed payment and allowance reserved', { timeout: 30_000 }, async t => {
  const f = await fixture(t, [10]);
  const request = { amount: '2', unit: 'RAW', requestId: 'market-unbound-terminal' };
  let continuations = 0;
  f.app.payments.topUps = mockTopUps(f.app, '2', async context => {
    await context.beforeSubmit();
    continuations++;
    throw new AttoError('MARKET_UNAVAILABLE', 'Synthetic lost acknowledgement.');
  });
  await assert.rejects(f.app.call('market_topup', request), { code: 'MARKET_UNAVAILABLE' });
  const before = f.app.ledger.get(request.requestId);
  const secrets = f.app.ledger.externalSecretsFor(request.requestId);
  const payload = { hash: before.hash, transactionJson: secrets.transactionJson,
    paymentSignature: secrets.paymentSignature };
  const client = new MarketTopUpClient(f.app.store, f.app.wallet);
  client.authorize = async () => ({ accessToken: 'local-test-access' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (new URL(input).pathname === `/v1/agent/topups/${intentId}`) {
      return new Response(JSON.stringify(marketStatus('2', { state: 'ACCEPTED', paymentState: 'ACCEPTED',
        sendHash: null, payer: null })), { status: 200 });
    }
    return originalFetch(input, init);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  f.app.payments.topUps.status = client.status.bind(client);

  await assert.rejects(f.app.call('market_topup_status', { requestId: request.requestId }), { code: 'MARKET_PROTOCOL' });
  await assert.rejects(f.app.call('market_topup', request), { code: 'MARKET_PROTOCOL' });
  const after = f.app.ledger.get(request.requestId);
  const currentSecrets = f.app.ledger.externalSecretsFor(request.requestId);
  assert.equal(after.status, 'signed');
  assert.deepEqual(after.external, before.external);
  assert.deepEqual({ hash: after.hash, transactionJson: currentSecrets.transactionJson,
    paymentSignature: currentSecrets.paymentSignature }, payload);
  assert.equal(f.app.ledger.usage().pendingRaw, '2');
  assert.equal(continuations, 1);
  assert.equal(f.state.publicationAttempts.length, 0);
  await assert.rejects(f.app.call('send', f.request('ordinary-still-blocked', '1')), { code: 'POOL_BUSY' });
});

test('a Market request ID cannot be reused with a changed amount after an uncertain result', { timeout: 30_000 }, async t => {
  // Given one durable x402 attempt whose Market continuation acknowledgement is unknown.
  const f = await fixture(t, [10]);
  let challenges = 0;
  f.app.payments.topUps = mockTopUps(f.app, '2', async context => {
    await context.beforeSubmit();
    throw new AttoError('MARKET_UNAVAILABLE', 'Synthetic lost acknowledgement.');
  });
  const request = { amount: '2', unit: 'RAW', requestId: 'market-changed-amount' };

  // When the caller reuses the ID with another amount.
  const originalChallenge = f.app.payments.topUps.challenge;
  f.app.payments.topUps.challenge = async (...args) => { challenges++; return originalChallenge(...args); };
  await assert.rejects(f.app.call('market_topup', request), { code: 'MARKET_UNAVAILABLE' });
  await assert.rejects(f.app.call('market_topup', { ...request, amount: '3' }), { code: 'REQUEST_CONFLICT' });

  // Then no new challenge or debit can replace the exact unresolved payment.
  assert.equal(challenges, 1);
  assert.equal(f.app.ledger.get(request.requestId).raw, '2');
  assert.equal(f.app.ledger.usage().pendingRaw, '2');
});

test('a pending ordinary payment blocks a Market top-up after restart', { timeout: 30_000 }, async t => {
  // Given an unfinished ordinary reservation on the only approved account.
  const f = await fixture(t, [10]);
  f.app.ledger.reserve({ id: 'ordinary-pending', index: 0, sourceAddress: f.addresses[0].address,
    destination: f.recipient.address, raw: '3', createdAt: Date.now(), network: 'LOCAL', selection: 'explicit',
    plan: { indexes: [0], steps: [] } });
  await f.reopen();
  let continuations = 0;
  f.app.payments.topUps = mockTopUps(f.app, '2', async () => { continuations++; });

  // When a new Market payment tries to select that same account.
  await assert.rejects(f.app.call('market_topup', { amount: '2', unit: 'RAW', requestId: 'blocked-by-ordinary' }), { code: 'POOL_BUSY' });

  // Then the existing ordinary reservation still owns the frontier and allowance.
  assert.equal(f.app.ledger.get('ordinary-pending').status, 'reserved');
  assert.equal(f.app.ledger.get('blocked-by-ordinary'), undefined);
  assert.equal(f.app.ledger.usage().pendingRaw, '3');
  assert.equal(continuations, 0);
});

test('spending policy is rechecked after proof of work immediately before first x402 submission', { timeout: 30_000 }, async t => {
  // Given an approved limit that permits a 2 RAW top-up before work begins.
  const f = await fixture(t, [10]);
  let continuationSubmitted = false;
  f.app.payments.topUps = mockTopUps(f.app, '2', async context => {
    // Simulate a locally tightened policy after PoW but before the HTTP continuation.
    f.app.ledger.setPolicy({ perRequest: { amount: '1', unit: 'RAW' }, rolling: [] });
    await context.beforeSubmit();
    continuationSubmitted = true;
  });

  // When the payer reaches the protected HTTP boundary.
  await assert.rejects(f.app.call('market_topup', { amount: '2', unit: 'RAW', requestId: 'policy-after-work' }), { code: 'SPENDING_LIMIT' });

  // Then the Market continuation was not sent and no signed block was durably assigned.
  assert.equal(continuationSubmitted, false);
  const record = f.app.ledger.get('policy-after-work');
  assert.equal(record.status, 'reserved');
  assert.equal(record.hash, undefined);
  assert.equal(f.app.ledger.externalSecretsFor(record.id).paymentSignature, undefined);
  assert.equal(f.app.ledger.usage().pendingRaw, '2');
});

test('an explicit Market account removed from the pool after work cannot reach the first continuation', { timeout: 30_000 }, async t => {
  // Given an explicit CLI-source top-up reserved from the approved pool.
  const f = await fixture(t, [10]);
  const request = { amount: '2', unit: 'RAW', requestId: 'market-pool-removed-after-work', index: 0 };
  let continuationSubmitted = false;
  f.app.payments.topUps = mockTopUps(f.app, '2', async context => {
    assert.ok(f.state.works.length, 'The native transaction must finish PoW before the pool changes.');

    // When the local owner removes the source account before the HTTP boundary.
    await f.approve({ indexes: [1], consolidate: false });
    await context.beforeSubmit();
    continuationSubmitted = true;
  });

  // Then the changed approved pool rejects the payment before it is assigned or submitted.
  await assert.rejects(f.app.call('market_topup', request), { code: 'POOL_APPROVAL_REQUIRED' });
  const record = f.app.ledger.get(request.requestId);
  assert.equal(continuationSubmitted, false);
  assert.equal(record.status, 'reserved');
  assert.equal(record.hash, undefined);
  assert.equal(f.app.ledger.externalSecretsFor(request.requestId).transactionJson, undefined);
  assert.equal(f.app.ledger.externalSecretsFor(request.requestId).paymentSignature, undefined);
  assert.equal(f.state.publicationAttempts.length, 0);
  assert.equal(f.app.ledger.usage().pendingRaw, '2');
});

test('an explicit Market replay rechecks pool membership and keeps the original signed SEND reserved', { timeout: 30_000 }, async t => {
  // Given a first x402 submission with an unknown outcome and an exact durable transaction.
  const f = await fixture(t, [10]);
  const request = { amount: '2', unit: 'RAW', requestId: 'market-pool-removed-before-retry', index: 0 };
  const initial = [];
  let continuationSubmitted = 0;
  f.app.payments.topUps = mockTopUps(f.app, '2', async context => {
    if (initial.length === 0) {
      await context.beforeSubmit();
      const record = f.app.ledger.get(request.requestId);
      const secrets = f.app.ledger.externalSecretsFor(request.requestId);
      initial.push({ hash: record.hash, transactionJson: secrets.transactionJson,
        paymentSignature: secrets.paymentSignature });
      context.setStatus(marketStatus('2', { state: 'PENDING', paymentState: 'PENDING',
        sendHash: record.hash, payer: record.sourceAddress }));
      continuationSubmitted++;
      throw new AttoError('MARKET_UNAVAILABLE', 'Synthetic lost acknowledgement.');
    }

    // When the same request retries after its explicit source was removed from the approved pool.
    await context.beforeSubmit();
    continuationSubmitted++;
  });

  await assert.rejects(f.app.call('market_topup', request), { code: 'MARKET_UNAVAILABLE' });
  const first = f.app.ledger.get(request.requestId);
  assert.equal(first.status, 'signed');
  await f.approve({ indexes: [1], consolidate: false });

  // Then replay is denied before continuation and cannot replace the assigned SEND.
  await assert.rejects(f.app.call('market_topup', request), { code: 'POOL_APPROVAL_REQUIRED' });
  const current = f.app.ledger.get(request.requestId);
  const secrets = f.app.ledger.externalSecretsFor(request.requestId);
  assert.equal(continuationSubmitted, 1);
  assert.equal(current.hash, initial[0].hash);
  assert.equal(secrets.transactionJson, initial[0].transactionJson);
  assert.equal(secrets.paymentSignature, initial[0].paymentSignature);
  assert.equal(f.app.ledger.usage().pendingRaw, '2');
  assert.equal(f.state.publicationAttempts.length, 0);
});
