import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const { StateStore } = await import(pathToFileURL(join(packageDirectory, 'dist/storage/state.js')).href);
const { SpendLedger } = await import(pathToFileURL(join(packageDirectory, 'dist/spending/ledger.js')).href);
const { paymentMetadataSchema } = await import(pathToFileURL(join(packageDirectory, 'dist/spending/journal.js')).href);
const now = Date.now();
const policy = { perRequest: { amount: '100', unit: 'RAW' }, rolling: [{ days: 1, amount: '100', unit: 'RAW' }] };

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'atto-journal-test-'));
  const stores = [];
  const open = () => {
    const store = new StateStore(directory);
    stores.push(store);
    return { store, ledger: new SpendLedger(store) };
  };
  t.after(() => { for (const store of stores) store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, open, ...open() };
}

function payment(id = 'invoice-one', raw = '100') {
  return {
    id, index: 0, sourceAddress: 'synthetic-source-0', destination: 'synthetic-recipient', raw, createdAt: now,
    network: 'LOCAL', selection: 'automatic', metadata: { reason: 'Invoice one', invoice: { reference: 'one' } },
    quote: { usd: '1', amount: { raw } },
    plan: { indexes: [0, 1], steps: [
      { id: 'fund-send', kind: 'send', index: 1, sourceAddress: 'synthetic-source-1', destination: 'synthetic-source-0', raw: '40', status: 'planned' },
      { id: 'fund-receive', kind: 'receive', index: 0, sourceAddress: 'synthetic-source-0', destination: 'synthetic-source-0', raw: '40', sourceStepId: 'fund-send', status: 'planned' },
    ] },
  };
}

test('a pending payment rechecks lowered per-request limits without releasing its reservation', t => {
  // Given
  const { ledger } = fixture(t);
  ledger.setPolicy(policy);
  ledger.reserve(payment());
  ledger.stepSigned('invoice-one', 'fund-send', 'internal-hash', '{}');
  ledger.stepComplete('invoice-one', 'fund-send', { hash: 'internal-hash' }, now);

  // When
  ledger.setPolicy({ ...policy, perRequest: { amount: '99', unit: 'RAW' } });

  // Then
  assert.throws(() => ledger.assertReservationAllowed('invoice-one', now), { code: 'SPENDING_LIMIT' });
  assert.equal(ledger.usage(now).pendingRaw, '100');
  assert.equal(ledger.get('invoice-one').plan.steps[0].status, 'published');
});

test('reservation checks count other pending and rolling spend while excluding the payment itself', t => {
  // Given
  const { ledger } = fixture(t);
  const direct = (id, raw) => ({ ...payment(id, raw), plan: { indexes: [0], steps: [] } });
  ledger.reserve(direct('published', '30'));
  ledger.signed('published', 'published-hash', '{}');
  ledger.complete('published', { hash: 'published-hash' }, now);
  ledger.reserve(direct('other-pending', '20'));
  ledger.reserve(direct('current', '50'));
  ledger.setPolicy(policy);

  // When / Then: all three records exactly fill the cap; the current payment is charged once.
  assert.doesNotThrow(() => ledger.assertReservationAllowed('current', now));
  assert.equal(ledger.usage(now).rolling[0].usedRaw, '100');
  ledger.setPolicy({ ...policy, rolling: [{ days: 1, amount: '99', unit: 'RAW' }] });
  assert.throws(() => ledger.assertReservationAllowed('current', now), { code: 'SPENDING_LIMIT' });
  assert.equal(ledger.usage(now).pendingRaw, '70');

  // When / Then: expired published spend stops counting, while every pending amount stays reserved.
  assert.doesNotThrow(() => ledger.assertReservationAllowed('current', now + 86_400_000));
  assert.equal(ledger.usage(now + 86_400_000).rolling[0].usedRaw, '70');
  assert.throws(() => ledger.assertReservationAllowed('published', now), { code: 'SEND_STATE' });
  assert.throws(() => ledger.assertReservationAllowed('missing', now), { code: 'SEND_NOT_FOUND' });
});

test('consolidation records durable progress while billing only the external parent payment', t => {
  // Given
  const { ledger } = fixture(t);
  ledger.setPolicy(policy);
  ledger.reserve(payment());

  // When
  ledger.stepSigned('invoice-one', 'fund-send', 'internal-send-hash', '{"synthetic":"send"}');
  ledger.stepComplete('invoice-one', 'fund-send', { hash: 'internal-send-hash' }, now);
  ledger.stepSigned('invoice-one', 'fund-receive', 'internal-receive-hash', '{"synthetic":"receive"}');
  ledger.stepComplete('invoice-one', 'fund-receive', { hash: 'internal-receive-hash' }, now);

  // Then
  assert.equal(ledger.usage(now).pendingRaw, '100');
  assert.equal(ledger.usage(now).rolling[0].usedRaw, '100');
  assert.equal(ledger.journalList().items.length, 1);
  assert.throws(() => ledger.assertCanReserve('1', now), { code: 'SPENDING_LIMIT' });

  // When / Then: publishing the external payment moves, rather than duplicates, usage.
  ledger.signed('invoice-one', 'external-hash', '{"synthetic":"external"}');
  ledger.complete('invoice-one', { hash: 'external-hash' }, now);
  assert.equal(ledger.usage(now).pendingRaw, '0');
  assert.equal(ledger.usage(now).rolling[0].publishedRaw, '100');
  assert.equal(ledger.usage(now).rolling[0].usedRaw, '100');
});

test('a reopened uncertain internal step keeps its plan, quote, metadata, and full external reservation', t => {
  // Given
  const f = fixture(t);
  f.ledger.setPolicy(policy);
  f.ledger.reserve(payment());
  f.ledger.stepSigned('invoice-one', 'fund-send', 'internal-hash', '{"synthetic":true}');
  f.ledger.stepUncertain('invoice-one', 'fund-send');
  const expected = f.ledger.get('invoice-one');
  f.store.close();

  // When
  const reopened = f.open().ledger;

  // Then
  assert.deepEqual(reopened.journalGet('invoice-one'), expected);
  assert.equal(reopened.pending()[0].plan.steps[0].status, 'unknown');
  assert.equal(reopened.usage(now + 2 * 86_400_000).pendingRaw, '100');
  assert.throws(() => reopened.fail('invoice-one'), { code: 'SEND_STATE' });
  assert.throws(() => reopened.signed('invoice-one', 'too-early', '{}'), { code: 'SEND_STATE' });
  assert.throws(() => reopened.stepSigned('invoice-one', 'fund-send', 'replacement-hash', '{}'), { code: 'SEND_STATE' });
});

test('a proven internal canonical conflict fails its pinned plan but retains every recorded block', t => {
  // Given
  const { ledger } = fixture(t);
  ledger.reserve(payment());
  ledger.stepSigned('invoice-one', 'fund-send', 'excluded-hash', '{"synthetic":true}');

  // When
  ledger.stepReject('invoice-one', 'fund-send');

  // Then
  const record = ledger.get('invoice-one');
  assert.equal(record.status, 'failed');
  assert.equal(record.plan.steps[0].status, 'failed');
  assert.equal(record.plan.steps[0].hash, 'excluded-hash');
  assert.equal(ledger.usage(now).pendingRaw, '0');
  assert.throws(() => ledger.stepSigned('invoice-one', 'fund-send', 'new-hash', '{}'), { code: 'SEND_STATE' });
});

test('reusing a request ID preserves omitted metadata and rejects changes to the pinned payment', t => {
  // Given
  const { ledger } = fixture(t);
  const request = payment();
  const original = ledger.reserve(request);

  // When / Then
  const { metadata: _metadata, ...withoutMetadata } = request;
  assert.deepEqual(ledger.reserve(withoutMetadata), original);
  for (const change of [
    { metadata: { reason: 'Different invoice' } }, { quote: { usd: '2' } }, { selection: 'explicit' },
    { sourceAddress: 'different-source', plan: undefined },
    { plan: { ...request.plan, steps: request.plan.steps.map(step => ({ ...step, raw: '41' })) } },
  ]) assert.throws(() => ledger.reserve({ ...request, ...change }), { code: 'REQUEST_CONFLICT' });
  assert.deepEqual(ledger.get(request.id), original);
});

test('invalid durable plans cannot reserve allowance', t => {
  // Given
  const { ledger } = fixture(t);
  const variants = [
    plan => { plan.indexes = [0, 0]; },
    plan => { plan.steps[1].id = plan.steps[0].id; },
    plan => { plan.steps[1].sourceStepId = 'missing'; },
    plan => { plan.steps[1].raw = '41'; },
    plan => { plan.steps[0].destination = 'outside-wallet'; },
    plan => { plan.steps[0].raw = '0'; },
  ];

  // When / Then
  for (const change of variants) {
    const request = payment();
    change(request.plan);
    assert.throws(() => ledger.reserve(request), { code: 'INVALID_REQUEST' });
  }
  assert.deepEqual(ledger.pending(), []);
});

test('direct unsigned plans survive reopening while legacy journal entries retain their old shape', t => {
  // Given
  const f = fixture(t);
  const legacy = { id: 'legacy', index: 0, destination: 'synthetic', raw: '1', createdAt: now, status: 'reserved' };
  f.store.set('spending.records', [legacy]);
  const direct = { ...payment('direct', '2'), plan: { indexes: [0], steps: [] } };
  f.ledger.reserve(direct);
  f.store.close();

  // When
  const reopened = f.open().ledger;

  // Then
  assert.deepEqual(reopened.get('legacy'), legacy);
  assert.deepEqual(reopened.get('direct').plan, direct.plan);
  assert.equal(reopened.get('direct').selection, 'automatic');
  assert.equal(reopened.pending().length, 2);
  reopened.fail('legacy');
  assert.equal(reopened.usage(now).pendingRaw, '2');
});

test('corrupted recorded step ordering fails closed before journal or allowance use', t => {
  // Given
  const { ledger, store } = fixture(t);
  ledger.reserve(payment());
  const records = store.get('spending.records');
  records[0].plan.steps[1] = { ...records[0].plan.steps[1], status: 'signed', hash: 'out-of-order', blockJson: '{}' };
  store.set('spending.records', records);

  // When / Then
  assert.throws(() => ledger.journalList(), { code: 'INVALID_STATE' });
  assert.throws(() => ledger.assertCanReserve('1'), { code: 'INVALID_STATE' });
});

test('journal pagination stays stable when new payments arrive and rejects changed filters', t => {
  // Given
  const { ledger, store } = fixture(t);
  for (const id of ['one', 'two', 'three']) ledger.reserve({ id, index: 0, destination: 'synthetic', raw: '1', createdAt: now });
  const page = ledger.journalList({ limit: 2, status: 'reserved' });

  // When
  ledger.reserve({ id: 'four', index: 0, destination: 'synthetic', raw: '1', createdAt: now });
  const before = store.get('spending.records');
  const next = ledger.journalList({ limit: 2, status: 'reserved', cursor: page.nextCursor });

  // Then
  assert.deepEqual(page.items.map(record => record.id), ['three', 'two']);
  assert.deepEqual(next.items.map(record => record.id), ['one']);
  assert.equal(next.nextCursor, undefined);
  assert.equal(ledger.journalGet('missing'), undefined);
  assert.throws(() => ledger.journalList({ cursor: page.nextCursor, status: 'published' }), { code: 'INVALID_CURSOR' });
  assert.throws(() => ledger.journalList({ limit: 101 }), { code: 'INVALID_INPUT' });
  assert.deepEqual(store.get('spending.records'), before);
});

test('pool changes share policy approval revisions and omitted pools preserve approved selection', t => {
  // Given
  const { ledger, directory } = fixture(t);
  const wallet = { directory, walletFingerprint: 'synthetic-wallet', network: 'LOCAL' };
  const pool = { indexes: [0, 2], consolidate: true };
  assert.deepEqual(ledger.pool(), { indexes: [0], consolidate: false });
  const stale = ledger.proposePolicy(policy, 'spend', wallet, pool);
  ledger.setPolicy(policy);

  // When / Then
  assert.throws(() => ledger.approveProposal(stale.id, wallet), { code: 'PROPOSAL_STALE' });
  assert.deepEqual(ledger.pool(), { indexes: [0], consolidate: false });
  const current = ledger.proposePolicy(policy, 'spend', wallet, pool);
  ledger.approveProposal(current.id, wallet);
  assert.deepEqual(ledger.usage(now).pool, pool);
  assert.equal(ledger.usage(now).mcpAccess, 'spend');
  const omitted = ledger.proposePolicy(policy, 'read-only', wallet);
  assert.deepEqual(omitted.pool, pool);
  ledger.approveProposal(omitted.id, wallet);
  assert.deepEqual(ledger.pool(), pool);
  assert.equal(ledger.mcpAccess(), 'read-only');
});

test('legacy proposals without a pool preserve the active pool and invalid pools are rejected', t => {
  // Given
  const { ledger, store, directory } = fixture(t);
  const wallet = { directory, walletFingerprint: 'synthetic-wallet', network: 'LOCAL' };
  const pool = { indexes: [3, 5], consolidate: false };
  const first = ledger.proposePolicy(policy, 'spend', wallet, pool);
  ledger.approveProposal(first.id, wallet);
  const legacy = ledger.proposePolicy(policy, 'read-only', wallet);
  delete legacy.pool;
  store.set('spending.proposal', legacy);

  // When
  ledger.approveProposal(legacy.id, wallet);

  // Then
  assert.deepEqual(ledger.pool(), pool);
  for (const invalid of [{ indexes: [], consolidate: false }, { indexes: [0, 0], consolidate: true }, { indexes: [-1], consolidate: false }]) {
    assert.throws(() => ledger.proposePolicy(policy, 'spend', wallet, invalid), { code: 'INVALID_POOL' });
  }
});

test('payment metadata accepts bounded JSON objects and rejects oversized or deeply nested content', () => {
  // Given / When / Then
  assert.equal(paymentMetadataSchema.safeParse({ reason: 'Invoice', tags: ['one', 'two'], context: { number: 3 } }).success, true);
  for (const value of [[], { reason: '€'.repeat(1500) }, { a: { b: { c: { d: { e: { f: true } } } } } }, { unsupported: 1n }]) {
    assert.equal(paymentMetadataSchema.safeParse(value).success, false);
  }
});

function historicalPayment(kind, id, raw, status = 'reserved') {
  return { id, index: 1, destination: 'historical-recipient', raw, createdAt: now, status,
    ...(status === 'unknown' || status === 'published' ? { hash: `${id}-hash`, blockJson: '{}',
      ...(status === 'published' ? { publishedAt: now } : {}) } : {}),
    external: { kind, version: 1, paymentIdentifier: `identifier-${id}`, network: 'atto:local',
      intentId: '11111111-1111-4111-8111-111111111111', resourceUrl: 'http://localhost/v1/agent/topups',
      requirementHash: 'a'.repeat(64), intentExpiresAt: new Date(now + 60_000).toISOString(), marketState: 'PENDING',
      paymentState: null, nativeState: status === 'reserved' ? 'challenged' : 'unknown',
      ...(status !== 'reserved' ? { attemptedAt: now } : {}) } };
}

test('historical Market records preserve generic journal reads, reservations, and exact stored bytes', t => {
  // Given a shared wallet with ordinary history, both old payment kinds, and a current Marketplace record.
  const { store, ledger, directory } = fixture(t);
  const generic = { ...payment('ordinary', '10'), plan: undefined, status: 'reserved' };
  const topup = historicalPayment('market-topup', 'historical-topup', '20');
  const intent = historicalPayment('market-intent', 'historical-intent', '30', 'unknown');
  const published = historicalPayment('market-topup', 'historical-published', '40', 'published');
  const { marketState, ...currentExternal } = historicalPayment('marketplace-topup', 'current-topup', '5').external;
  const current = { ...historicalPayment('marketplace-topup', 'current-topup', '5'),
    external: { ...currentExternal, marketplaceState: marketState } };
  const records = [generic, topup, intent, published, current];
  store.set('spending.records', records);
  ledger.setPolicy({ ...policy, rolling: [{ days: 1, amount: '105', unit: 'RAW' }] });
  const snapshot = () => ['state.sqlite', 'state.sqlite-wal'].map(name => readFileSync(join(directory, name)));
  const before = snapshot();
  const saved = JSON.stringify(store.get('spending.records'));

  // When historical records are read through the same paths as ordinary wallet history and spending checks.
  const page = ledger.journalList();
  const usage = ledger.usage(now);
  ledger.assertReservationAllowed('ordinary', now);

  // Then old tags stay visible, all reservations remain counted, and reading performs no database rewrite.
  assert.equal(ledger.journalGet('ordinary').id, generic.id);
  assert.deepEqual(ledger.get(topup.id), topup);
  assert.deepEqual(ledger.get(intent.id), intent);
  assert.deepEqual(ledger.get(current.id), current);
  assert.equal(page.items.length, 5);
  assert.deepEqual(ledger.pending().map(record => record.id), ['ordinary', topup.id, intent.id, current.id]);
  assert.equal(usage.pendingRaw, '65');
  assert.equal(usage.rolling[0].publishedRaw, '40');
  assert.equal(usage.rolling[0].usedRaw, '105');
  assert.throws(() => ledger.assertCanReserve('1', now), { code: 'SPENDING_LIMIT' });
  assert.equal(JSON.stringify(store.get('spending.records')), saved);
  assert.deepEqual(snapshot(), before);
});

test('ordinary payment mutations preserve historical records without upgrading their authorization', t => {
  // Given both historical kinds in the same journal as an ordinary pending send.
  const { store, ledger } = fixture(t);
  const historical = [historicalPayment('market-topup', 'historical-topup', '20'),
    historicalPayment('market-intent', 'historical-intent', '30', 'unknown')];
  store.set('spending.records', historical);
  const before = JSON.stringify(historical);
  const request = { ...payment('new-ordinary', '10'), plan: undefined };

  // When a new ordinary payment is reserved and then signed.
  ledger.reserve(request);
  ledger.signed(request.id, 'ordinary-send-hash', '{}');

  // Then the new payment uses its normal format and neither old record is rewritten or usable for new signing.
  assert.equal(ledger.get(request.id).status, 'signed');
  assert.equal(ledger.get(request.id).external, undefined);
  assert.equal(JSON.stringify(store.get('spending.records').slice(0, 2)), before);
  for (const record of historical) {
    assert.throws(() => ledger.reserve({ ...record, id: `${record.id}-replacement` }), { code: 'INVALID_REQUEST' });
    assert.throws(() => ledger.signed(record.id, 'replacement-hash', '{}'));
    assert.throws(() => ledger.externalStatus(record.id, { marketplaceState: 'ACCEPTED' }), { code: 'SEND_STATE' });
  }
  assert.equal(JSON.stringify(store.get('spending.records').slice(0, 2)), before);
});

test('historical payment accounting does not resume old Marketplace authorizations', async t => {
  // Given old payment records and current private Marketplace wallet entrypoints.
  const { store, ledger } = fixture(t);
  store.set('spending.records', [historicalPayment('market-topup', 'historical-topup', '20'),
    historicalPayment('market-intent', 'historical-intent', '30', 'unknown')]);
  const { Payments } = await import(pathToFileURL(join(packageDirectory, 'dist/spending/payments.js')).href);
  const payments = new Payments(store, ledger, { mcp: true }, undefined, undefined,
    undefined, undefined, undefined, { apiUrl: 'http://localhost/v1/agent/topups', audience: 'marketplace' });
  const before = JSON.stringify(store.get('spending.records'));

  // When current recovery operations receive the old IDs.
  const topup = payments.marketplaceTopUpStatus('historical-topup');
  const intent = payments.marketplacePayIntentStatus('historical-intent');

  // Then neither current entrypoint accepts the old authorization, and pending accounts remain fenced.
  await assert.rejects(topup, { code: 'REQUEST_CONFLICT' });
  await assert.rejects(intent, { code: 'REQUEST_CONFLICT' });
  assert.throws(() => payments.requireAvailable(1), { code: 'ACCOUNT_RESERVED' });
  assert.equal(JSON.stringify(store.get('spending.records')), before);
});

test('historical journal compatibility still rejects malformed and hybrid payment records', t => {
  // Given representative corruptions of old payment tags and shared accounting data.
  const { store, ledger } = fixture(t);
  const valid = historicalPayment('market-topup', 'historical-topup', '20');
  const variants = [
    { ...valid, raw: '-1' },
    ...[{ kind: 'market-unknown' }, { marketState: undefined }, { marketState: 'INVALID' },
      { marketplaceState: 'PENDING' }, { version: 2 }, { requirementHash: 'invalid' },
      { nativeState: 'unknown' }].map(change => ({ ...valid, external: { ...valid.external, ...change } })),
  ];

  // When each malformed record is loaded from durable state.
  for (const record of variants) {
    store.set('spending.records', [record]);
    const before = JSON.stringify(store.get('spending.records'));

    // Then it remains rejected without a cleanup or migration write.
    assert.throws(() => ledger.journalList(), { code: 'INVALID_STATE' });
    assert.equal(JSON.stringify(store.get('spending.records')), before);
  }
});
