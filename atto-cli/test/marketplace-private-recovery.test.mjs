import assert from 'node:assert/strict';
import test from 'node:test';
import { AttoTransaction } from '@attocash/commons-core';
import { fixture, gate, until } from './support/payments.mjs';

const config = { apiUrl: 'http://127.0.0.1:43210/v1/agent/topups', audience: 'private-recovery' };
function intent(f, requestId = 'private-recovery-request-0001') {
  const intentId = '00000000-0000-4000-8000-000000000079';
  const resourceUrl = `${config.apiUrl}/${intentId}`;
  const requirement = { x402Version: 2, resource: { url: resourceUrl }, accepts: [{ scheme: 'exact', network: 'atto:local',
    amount: '2', asset: 'atto', payTo: f.recipient.address, maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: 'native', paymentFlow: 'authorization' } }],
    extensions: { 'payment-identifier': { schema: { type: 'object', properties: { id: { type: 'string' } } }, info: { required: true } } } };
  return { requestId, intentId, amountAtomic: '2', paymentIdentifier: requestId, ...config, resourceUrl,
    paymentRequired: Buffer.from(JSON.stringify(requirement)).toString('base64'), expiresAt: new Date(Date.now() + 300_000).toISOString() };
}
async function interruptBeforeSigning(f, request) {
  const seed = f.app.payments.wallet.seed;
  f.app.payments.wallet.seed = async () => { throw new Error('Synthetic unavailable keyring'); };
  try { await assert.rejects(f.app.call('marketplace_pay_intent', request), /Synthetic unavailable keyring/); }
  finally { f.app.payments.wallet.seed = seed; }
  assert.equal(f.app.ledger.get(request.requestId).hash, undefined);
  assert.equal(f.app.ledger.externalSecretsFor(request.requestId).paymentSignature, undefined);
  assert.equal(f.state.publicationAttempts.length, 0);
}
async function afterExpiry(t, request, run) {
  const now = Date.now;
  const offset = Date.parse(request.expiresAt) - now() + 1000;
  t.mock.method(Date, 'now', () => now() + offset);
  try { return await run(); } finally { t.mock.restoreAll(); }
}

for (const trigger of ['status', 'prepare', 'ordinary-send']) {
  test(`an unsigned interrupted intent expires through ${trigger}, releases its source and keeps the original terminal identity`, { timeout: 30_000 }, async t => {
    const f = await fixture(t, [10], undefined, '2', undefined, { internalMarketplacePayment: config });
    await f.reopen('mcp');
    const request = intent(f);
    await interruptBeforeSigning(f, request);
    const pending = await f.app.call('marketplace_pay_intent_status', { requestId: request.requestId });
    assert.deepEqual(pending, { requestId: request.requestId, intentId: request.intentId, network: 'atto:local', amountAtomic: '2',
      paymentState: 'PENDING_SIGNATURE', nativeState: 'challenged' });
    assert.equal(f.app.ledger.usage().pendingRaw, '2');
    await f.reopen(trigger === 'ordinary-send' ? undefined : 'mcp');
    let publicPayment;
    await afterExpiry(t, request, async () => {
      if (trigger === 'status') await f.app.call('marketplace_pay_intent_status', { requestId: request.requestId });
      else if (trigger === 'prepare') await f.app.call('marketplace_pay_intent', request);
      else publicPayment = await f.app.call('send', f.request('public-after-unsigned-expiry', '1'));
    });
    const saved = f.app.ledger.get(request.requestId);
    assert.equal(saved.status, 'failed');
    assert.equal(saved.external.marketplaceState, 'EXPIRED');
    assert.equal(saved.external.nativeState, 'challenged');
    assert.equal(saved.external.paymentState, 'FAILED');
    assert.deepEqual(saved.result, { status: 'failed', reason: 'MARKETPLACE_CHALLENGE_EXPIRED' });
    assert.equal(saved.hash, undefined);
    assert.equal(f.app.ledger.usage().pendingRaw, '0');
    await f.reopen('mcp');
    const failed = await f.app.call('marketplace_pay_intent_status', { requestId: request.requestId });
    assert.deepEqual(failed, { requestId: request.requestId, intentId: request.intentId, paymentIdentifier: request.requestId,
      network: 'atto:local', amountAtomic: '2', payer: f.addresses[0].address, hash: null,
      paymentState: 'FAILED', nativeState: 'challenged', failureReason: 'MARKETPLACE_CHALLENGE_EXPIRED' });
    // Exact replay retains the failure even after restart. Changed terms cannot recycle this ID.
    assert.deepEqual(await f.app.call('marketplace_pay_intent', request), failed);
    await assert.rejects(f.app.call('marketplace_pay_intent', { ...request, expiresAt: new Date(Date.now() + 600_000).toISOString() }), { code: 'REQUEST_CONFLICT' });
    if (!publicPayment) publicPayment = await f.app.call('send', f.request('public-after-unsigned-expiry', '1'));
    assert.equal(publicPayment.status, 'published');
    assert.equal(f.state.publicationAttempts.length, 1);
    assert.equal(f.app.ledger.externalSecretsFor(request.requestId).paymentSignature, undefined);
  });
}

test('expiry never releases a saved signed candidate without canonical chain evidence', { timeout: 30_000 }, async t => {
  const f = await fixture(t, [10], undefined, '2', undefined, { internalMarketplacePayment: config });
  await f.reopen('mcp');
  const request = intent(f);
  const ready = await f.app.call('marketplace_pay_intent', request);
  f.state.hideHashLookup = true;
  await f.reopen('mcp');
  await afterExpiry(t, request, async () => {
    const recovered = await f.app.call('marketplace_pay_intent_status', { requestId: request.requestId });
    assert.equal(recovered.paymentState, 'READY');
    assert.equal(recovered.paymentSignature, ready.paymentSignature);
    assert.equal(recovered.hash, ready.hash);
    assert.equal(recovered.nativeState, 'unknown');
    const replay = await f.app.call('marketplace_pay_intent', request);
    assert.equal(replay.paymentSignature, ready.paymentSignature);
    assert.equal(replay.hash, ready.hash);
    await assert.rejects(f.app.call('send', f.request('blocked-after-signed-expiry')), { code: 'SPENDING_LIMIT' });
  });
  assert.equal(f.app.ledger.get(request.requestId).status, 'signed');
  assert.equal(f.app.ledger.usage().pendingRaw, '2');
  assert.equal(f.state.publicationAttempts.length, 0);
});

test('concurrent private status and repeated preparation share the first saved signature', { timeout: 30_000 }, async t => {
  const f = await fixture(t, [10], undefined, '100', undefined, { internalMarketplacePayment: config });
  await f.reopen('mcp');
  const request = intent(f);
  const held = gate();
  const seed = f.app.payments.wallet.seed;
  let seedReads = 0;
  f.app.payments.wallet.seed = async () => { seedReads++; await held.promise; return seed(); };
  const first = f.app.call('marketplace_pay_intent', request);
  await until(() => seedReads === 1);
  const status = f.app.call('marketplace_pay_intent_status', { requestId: request.requestId });
  const repeated = f.app.call('marketplace_pay_intent', request);
  held.release();
  const results = await Promise.all([first, status, repeated]);
  assert.equal(seedReads, 1);
  for (const result of results) {
    assert.equal(result.paymentState, 'READY');
    assert.equal(result.hash, results[0].hash);
    assert.equal(result.paymentSignature, results[0].paymentSignature);
  }
  assert.equal(f.app.ledger.pending().length, 1);
  assert.equal(f.state.publicationAttempts.length, 0);
});

test('partial private signed material is never treated as an unsigned expiry', async t => {
  for (const field of ['transactionJson', 'paymentJson', 'paymentSignature']) {
    const f = await fixture(t, [10], undefined, '2', undefined, { internalMarketplacePayment: config });
    await f.reopen('mcp');
    const request = intent(f);
    await interruptBeforeSigning(f, request);
    // A partially recovered private candidate is ambiguous, even with no public hash.
    const saved = f.app.store.get('spending.externalSecrets');
    f.app.store.set('spending.externalSecrets', { ...saved, [request.requestId]: { ...saved[request.requestId], [field]: 'partial-signed-material' } });
    await afterExpiry(t, request, async () => {
      await assert.rejects(f.app.call('marketplace_pay_intent_status', { requestId: request.requestId }), { code: 'INVALID_STATE' });
      await assert.rejects(f.app.call('send', f.request('blocked-by-partial-private-candidate')), { code: 'SPENDING_LIMIT' });
    });
    assert.equal(f.app.ledger.get(request.requestId).status, 'reserved');
    assert.equal(f.app.ledger.usage().pendingRaw, '2');
    assert.equal(f.state.publicationAttempts.length, 0);
  }
});

for (const network of ['BETA', 'DEV']) {
  test(`private ${network} payment reaches signing with the matching challenge and retains its unsigned journal`, { timeout: 30_000 }, async t => {
    // Given matching private wallet, native account and server challenge networks.
    const privateConfig = { apiUrl: 'https://marketplace.example.test/v1/agent/topups', audience: config.audience };
    const f = await fixture(t, [10], undefined, '100', undefined, { fixtureNetwork: network, internalMarketplacePayment: privateConfig });
    await f.reopen('mcp');
    const request = { ...intent(f, `private-${network.toLowerCase()}-request-0001`), ...privateConfig };
    request.resourceUrl = `${privateConfig.apiUrl}/${request.intentId}`;
    const challenge = JSON.parse(Buffer.from(request.paymentRequired, 'base64'));
    challenge.resource.url = request.resourceUrl;
    challenge.accepts[0].network = `atto:${network.toLowerCase()}`;
    request.paymentRequired = Buffer.from(JSON.stringify(challenge)).toString('base64');
    // When keys are temporarily unavailable at the actual signing boundary.
    await interruptBeforeSigning(f, request);
    // Then route selection succeeded, the exact unsigned intent is retained, and recovery needs no new intent.
    const saved = f.app.ledger.get(request.requestId);
    assert.equal(saved.network, network);
    assert.equal(saved.external.network, challenge.accepts[0].network);
    assert.equal((await f.app.call('marketplace_pay_intent_status', { requestId: request.requestId })).paymentState, 'PENDING_SIGNATURE');
    assert.equal(f.app.ledger.externalSecretsFor(request.requestId).requirementJson, JSON.stringify(challenge));
  });
}

test('the ledger rejects an altered wire transaction even when native bytes are hidden elsewhere in its envelope', { timeout: 30_000 }, async t => {
  // Given a valid prepared payment and the same immutable reservation awaiting its atomic candidate save.
  const f = await fixture(t, [10], undefined, '100', undefined, { internalMarketplacePayment: config });
  await f.reopen('mcp');
  const request = intent(f), ready = await f.app.call('marketplace_pay_intent', request);
  const record = f.app.ledger.get(request.requestId), secrets = f.app.ledger.externalSecretsFor(request.requestId);
  const original = JSON.parse(secrets.paymentJson);
  f.app.store.set('spending.records', [{ ...record, hash: undefined, blockJson: undefined, status: 'reserved' }]);
  const transaction = AttoTransaction.fromJson(secrets.transactionJson);
  const attempt = paymentJson => f.app.ledger.externalAttempt(request.requestId, { hash: ready.hash,
    blockJson: transaction.block.toJson(), transactionJson: secrets.transactionJson, paymentJson,
    paymentSignature: Buffer.from(paymentJson).toString('base64'), attemptedAt: Date.now() });
  // When an attacker changes signed wire values and retains native JSON only as unrelated envelope data.
  for (const field of ['amount', 'balance', 'signature', 'work']) {
    const payment = structuredClone(original);
    if (field === 'signature' || field === 'work') payment.payload.transaction[field] = '00'.repeat(field === 'signature' ? 64 : 8);
    else payment.payload.transaction.block[field] = '999';
    const attack = JSON.stringify(payment).replace(/}$/, `,"unrelated":${secrets.transactionJson}}`);
    assert.ok(attack.includes(secrets.transactionJson));
    // Then the native journal remains unsigned and unassigned after every rejection.
    assert.throws(() => attempt(attack), { code: 'SEND_STATE' });
    assert.equal(f.app.ledger.get(request.requestId).hash, undefined);
    assert.equal(f.app.ledger.get(request.requestId).status, 'reserved');
  }
  attempt(secrets.paymentJson);
  assert.equal(f.app.ledger.get(request.requestId).hash, ready.hash);
});

test('private recovery returns a retained numeric envelope and unchanged native journal after restart', { timeout: 30_000 }, async t => {
  // Given an already-issued payment saved using the previous numeric envelope format.
  const f = await fixture(t, [10], undefined, '100', undefined, { internalMarketplacePayment: config });
  await f.reopen('mcp');
  const request = intent(f), ready = await f.app.call('marketplace_pay_intent', request);
  const allSecrets = f.app.store.get('spending.externalSecrets'), secrets = allSecrets[request.requestId];
  const requirement = JSON.parse(secrets.requirementJson);
  const paymentJson = `{"x402Version":2,"resource":${JSON.stringify(requirement.resource)},"accepted":${JSON.stringify(requirement.accepts[0])},"payload":{"transaction":${secrets.transactionJson}},"extensions":{"payment-identifier":{"schema":${JSON.stringify(requirement.extensions['payment-identifier'].schema)},"info":{"required":true,"id":${JSON.stringify(request.paymentIdentifier)}}}}}`;
  const paymentSignature = Buffer.from(paymentJson).toString('base64');
  f.app.store.set('spending.externalSecrets', { ...allSecrets, [request.requestId]: { ...secrets, paymentJson, paymentSignature } });
  const recordsBefore = f.app.store.get('spending.records'), secretsBefore = f.app.store.get('spending.externalSecrets');
  await f.reopen('mcp');
  f.app.payments.wallet.seed = async () => { throw Error('Retained payment recovery must not access keys'); };
  // When status and exact preparation recover that original operation.
  const recovered = await f.app.call('marketplace_pay_intent_status', { requestId: request.requestId });
  const repeated = await f.app.call('marketplace_pay_intent', request);
  // Then the original header, signature, hash and journal bytes survive without a new native transaction.
  assert.equal(recovered.paymentSignature, paymentSignature);
  assert.equal(repeated.paymentSignature, paymentSignature);
  assert.equal(recovered.hash, ready.hash);
  assert.deepEqual(f.app.store.get('spending.records'), recordsBefore);
  assert.deepEqual(f.app.store.get('spending.externalSecrets'), secretsBefore);
  assert.equal(f.state.publicationAttempts.length, 0);
});
