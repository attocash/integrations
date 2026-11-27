import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { tmpdir } from '../../test/support/temporary-directory.mjs';

const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const moduleUrl = path => pathToFileURL(join(cliDirectory, 'dist', path)).href;
const { AttoApplication } = await import(moduleUrl('application/app.js'));
const { StateStore } = await import(moduleUrl('storage/state.js'));
const { SpendLedger } = await import(moduleUrl('spending/ledger.js'));
const { OsSecretStore } = await import(moduleUrl('storage/secrets.js'));
const {
  inspectMarketplaceWalletSetup, inspectMarketplacePaymentIntent, prepareMarketplacePayments,
  marketplacePaymentsUsable, validateMarketplacePaymentCap,
} = await import(moduleUrl('internal-marketplace.js'));
const phrase = `${'abandon '.repeat(23)}art`;
const bounded = { perRequest: { amount: '5', unit: 'ATTO' }, rolling: [{ days: 2, amount: '12', unit: 'ATTO' }] };
const unlimited = { perRequest: null, rolling: [] };

function terminal(t) {
  for (const stream of [process.stdin, process.stderr]) {
    const previous = Object.getOwnPropertyDescriptor(stream, 'isTTY');
    Object.defineProperty(stream, 'isTTY', { configurable: true, value: true });
    t.after(() => {
      if (previous) Object.defineProperty(stream, 'isTTY', previous);
      else delete stream.isTTY;
    });
  }
}

async function fixture(t, { access = 'read-only', policy = bounded, pool = { indexes: [0, 7], consolidate: true }, signing = [1, 7], index = 7 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'marketplace-payment-plan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = new AttoApplication({ directory, secrets: { get: async () => phrase, set: async () => {}, remove: async () => {} } });
  try {
    await app.createWallet(phrase);
    for (const index of [1, 7]) await app.call('address_derive', { index });
    app.store.set('settings', { ...app.store.get('settings'), network: 'LOCAL', autoReceive: false,
      nodeUrl: 'http://127.0.0.1:41234', workerUrl: 'http://127.0.0.1:41235' });
    app.ledger.reserve({ id: 'retained-reservation', index: 0, destination: app.store.get('identity').address,
      raw: '1000', network: 'LOCAL', createdAt: Date.now() });
    app.ledger.setPolicy(policy);
    app.store.set('spending.mcpAccess', access);
    app.store.set('spending.pool', pool);
    app.store.set('signing.messageIndexes', signing);
  } finally { await app.close(); }
  terminal(t);
  return {
    directory, index,
    snapshot: () => inspectMarketplaceWalletSetup({ directory, index }),
    rows: () => withStore(directory, store => store.entries('')),
    mutate: action => withStore(directory, store => store.withWalletLock(async () => action(store))),
  };
}

async function withStore(directory, action) {
  const store = new StateStore(directory);
  try { return await action(store); }
  finally { store.close(); }
}

async function pending(f, overrides = {}) {
  const before = await f.snapshot();
  return f.mutate(store => new SpendLedger(store).proposePolicy(
    overrides.policy ?? { perRequest: { amount: '2', unit: 'ATTO' }, rolling: [] }, overrides.access ?? 'spend', {
      directory: f.directory, walletFingerprint: before.fingerprint, network: before.settings.network,
    }, overrides.pool ?? before.pool, overrides.signing ?? before.messageSigningIndexes));
}

for (const mode of ['login-only', 'limited', 'unlimited']) {
  test(`preparing ${mode} is read-only and never asks for terminal answers, credentials or networking`, async t => {
    // Given initialized shared authority, a financial journal and a pending unrelated request.
    const f = await fixture(t);
    await pending(f, { access: 'read-only' });
    const before = await f.snapshot(), rows = await f.rows();
    for (const method of ['get', 'set', 'remove']) t.mock.method(OsSecretStore.prototype, method, () => { throw new Error('No credential access'); });
    t.mock.method(globalThis, 'fetch', () => { throw new Error('No networking'); });
    const output = [];
    const originalError = process.stderr.write;
    t.mock.method(process.stderr, 'write', (value, ...rest) => { if (typeof value !== 'string') return originalError.call(process.stderr, value, ...rest); output.push(value); return true; });

    // When an exact native plan is prepared, validated, and then left uncommitted after the review.
    const plan = await prepareMarketplacePayments({ expected: before, mode });
    await plan.validate();

    // Then all rows and pending intent are preserved and the caller receives review text only.
    assert.deepEqual(await f.rows(), rows);
    assert.deepEqual(output, []);
    assert.ok(plan.review.includes(before.address));
    assert.match(plan.review, /Account index: 7 \| Network: atto:local/);
    for (const hidden of [before.fingerprint, before.settings.nodeUrl, before.settings.workerUrl, before.proposal.id, phrase]) {
      assert.equal(plan.review.includes(hidden), false);
    }
    if (mode === 'unlimited') assert.match(plan.review, /including future deposits/);
  });
}

test('Marketplace amount setup preserves recipients and cannot resume a proposal to clear them', async t => {
  const f = await fixture(t);
  let before = await f.snapshot();
  const allowed = [before.address];
  await f.mutate(store => {
    const ledger = new SpendLedger(store);
    const wallet = { directory: f.directory, walletFingerprint: before.fingerprint, network: before.settings.network };
    const approved = ledger.proposePolicy(before.policy, 'read-only', wallet, before.pool, before.messageSigningIndexes, allowed);
    ledger.approveProposal(approved.id, wallet);
    ledger.proposePolicy(before.policy, 'spend', wallet, before.pool, before.messageSigningIndexes, null);
  });
  before = await f.snapshot();
  assert.deepEqual(before.recipientAllowlist, allowed);
  assert.equal(inspectMarketplacePaymentIntent(before, 'limited').resumeProposalId, undefined);
  const plan = await prepareMarketplacePayments({ expected: before, mode: 'limited' });
  assert.ok(plan.review.includes(`Approved ATTO recipients: ${before.address}`));
  assert.match(plan.review, /Pending ATTO recipients to replace: any ATTO address/);
  const saved = await plan.commit();
  assert.deepEqual(saved.recipientAllowlist, allowed);
});

test('login-only commit preserves native authority and any incompatible pending proposal', async t => {
  // Given an active shared wallet and a separate pending authority request.
  const f = await fixture(t, { access: 'spend' });
  await pending(f, { signing: [] });
  const before = await f.snapshot(), rows = await f.rows();

  // When the final caller commits only login access.
  const plan = await prepareMarketplacePayments({ expected: before, mode: 'login-only' });
  const after = await plan.commit();
  await plan.validate();

  // Then neither existing spend authority nor pending terms are rewritten.
  assert.deepEqual(after, before);
  assert.deepEqual(await f.rows(), rows);
});

for (const mode of ['limited', 'unlimited']) {
  test(`already-effective ${mode} authority preserves an unrelated mode-compatible pending proposal`, async t => {
    // Given effective saved authority and a later same-mode proposal with different pool terms.
    const f = await fixture(t, { access: 'spend', policy: mode === 'limited' ? bounded : unlimited });
    await pending(f, { policy: mode === 'limited' ? { perRequest: { amount: '2', unit: 'ATTO' }, rolling: [] } : unlimited,
      pool: { indexes: [7], consolidate: false } });
    const before = await f.snapshot(), rows = await f.rows();

    // When setup chooses a mode that the selected account already has.
    const intent = inspectMarketplacePaymentIntent(before, mode);
    const plan = await prepareMarketplacePayments({ expected: before, mode });
    const after = await plan.commit();

    // Then existing authority is retained without resuming or replacing someone else's pending change.
    assert.deepEqual(intent, { policy: before.policy, requiresPolicy: false });
    assert.deepEqual(after, before);
    assert.deepEqual(await f.rows(), rows);
    assert.doesNotMatch(plan.review, /Resume|replaces the existing pending/);
  });
}

test('explicit Limited caps are immutable review input when the saved policy is unbounded', async t => {
  // Given an unbounded existing wallet and explicitly requested finite caps.
  const f = await fixture(t, { policy: unlimited }), expected = await f.snapshot();
  const desired = structuredClone(bounded), rows = await f.rows();
  const plan = await prepareMarketplacePayments({ expected, mode: 'limited', policy: desired });
  assert.deepEqual(await f.rows(), rows);

  // When caller-owned input objects change after preparation and final consent commits the original review.
  desired.perRequest.amount = '999';
  expected.settings.nodeUrl = 'http://caller-mutated-input.invalid';
  const after = await plan.commit();

  // Then only the exact policy reviewed during preparation is effective.
  assert.deepEqual(after.policy, bounded);
  assert.match(plan.review, /Requested limits: Per payment: 5 ATTO; rolling: 12 ATTO \/ 2 days/);
});

for (const mode of ['limited', 'unlimited']) {
  test(`${mode} commit preserves the shared pool, consolidation, signing and journals while adding the selected account`, async t => {
    // Given selected account 7 outside a read-only pool and nonempty saved signing grants.
    const f = await fixture(t, { pool: { indexes: [0, 1], consolidate: true } });
    const before = await f.snapshot(), rows = await f.rows();
    for (const method of ['get', 'set', 'remove']) t.mock.method(OsSecretStore.prototype, method, () => { throw new Error('Saved pool accounts need no keys'); });
    const plan = await prepareMarketplacePayments({ expected: before, mode });
    assert.match(plan.review, /Native payments become enabled for pool indexes 0, 1, 7; consolidation enabled/);
    assert.match(plan.review, /generic message signing becomes available for account indexes 1, 7/);

    // When final consent commits the exact authority and the caller validates it again.
    const after = await plan.commit();
    await plan.validate();

    // Then true Unlimited or the exact saved Limited policy is effective with unrelated state retained.
    assert.equal(after.access, 'spend');
    assert.equal(marketplacePaymentsUsable(after), true);
    assert.deepEqual(after.policy, mode === 'unlimited' ? unlimited : before.policy);
    assert.deepEqual(after.pool, { indexes: [0, 1, 7], consolidate: true });
    assert.deepEqual(after.messageSigningIndexes, before.messageSigningIndexes);
    for (const key of ['settings', 'identity', 'addresses']) assert.deepEqual(after[key], before[key]);
    const retained = entries => entries.filter(row => !row.key.startsWith('spending.') || row.key === 'spending.records');
    assert.deepEqual(retained(await f.rows()), retained(rows));
    assert.deepEqual(await plan.commit(), after);
  });
}

test('the readonly-to-spend review shows an unchanged entire pool and omits an empty generic signing list', async t => {
  // Given read-only access to a saved shared pool without generic signing grants.
  const f = await fixture(t, { signing: [] }), before = await f.snapshot();

  // When Unlimited is prepared without any pool membership changes.
  const plan = await prepareMarketplacePayments({ expected: before, mode: 'unlimited' });

  // Then effective pool/consolidation scope is shown even though the pool itself is preserved.
  assert.match(plan.review, /Native payments become enabled for pool indexes 0, 7; consolidation enabled/);
  assert.doesNotMatch(plan.review, /Payment pool: indexes|generic message signing|\[\]/);
});

const mutations = {
  'endpoint': store => store.set('settings', { ...store.get('settings'), nodeUrl: 'http://127.0.0.1:45555' }),
  'network': store => store.set('settings', { ...store.get('settings'), network: 'BETA' }),
  'identity': store => store.set('identity', { ...store.get('identity'), fingerprint: 'ef'.repeat(32) }),
  'revision': store => store.set('spending.policyRevision', store.get('spending.policyRevision') + 1),
  'pool': store => store.set('spending.pool', { indexes: [7], consolidate: false }),
  'generic signing': store => store.set('signing.messageIndexes', []),
  'pending proposal': store => store.set('spending.proposal', { ...store.get('spending.proposal'), id: 'replacement-by-another-terminal' }),
};
for (const [kind, mutate] of Object.entries(mutations)) {
  test(`a changed ${kind} rejects validate and commit without overwriting the concurrent state`, async t => {
    // Given a prepared native authority change and a concurrent wallet owner's update.
    const f = await fixture(t);
    await pending(f, { access: 'read-only' });
    const plan = await prepareMarketplacePayments({ expected: await f.snapshot(), mode: 'unlimited' });
    await f.mutate(mutate);
    const concurrent = await f.rows();

    // When the caller validates or commits its stale final review.
    await assert.rejects(plan.validate(), { code: 'PROPOSAL_STALE' });
    await assert.rejects(plan.commit(), { code: 'PROPOSAL_STALE' });

    // Then the newer wallet state and original lack of spend access survive.
    assert.deepEqual(await f.rows(), concurrent);
    assert.equal((await f.snapshot()).access, 'read-only');
  });
}

test('stale preparation rejects the exact snapshot before creating any native proposal', async t => {
  // Given an inspected wallet and a subsequent authority revision change.
  const f = await fixture(t), expected = await f.snapshot();
  await f.mutate(mutations.revision);
  const concurrent = await f.rows();

  // When a caller tries to prepare from its older snapshot.
  await assert.rejects(prepareMarketplacePayments({ expected, mode: 'limited' }), { code: 'PROPOSAL_STALE' });

  // Then no authority or proposal is created or overwritten.
  assert.deepEqual(await f.rows(), concurrent);
});

for (const mode of ['limited', 'unlimited']) {
  test(`compatible ${mode} pending intent resumes its exact ID, terms, pool changes and expiry`, async t => {
    // Given an existing compatible proposal that deliberately changes the native pool and consolidation.
    const f = await fixture(t), policy = mode === 'unlimited' ? unlimited : { perRequest: { amount: '2', unit: 'ATTO' }, rolling: [] };
    const proposal = await pending(f, { policy, pool: { indexes: [7], consolidate: false } });
    const before = await f.snapshot(), intent = inspectMarketplacePaymentIntent(before, mode), rows = await f.rows();
    assert.deepEqual(intent, { policy, resumeProposalId: proposal.id, requiresPolicy: false });

    // When the native owner prepares read-only and then commits the exact pending proposal.
    const plan = await prepareMarketplacePayments({ expected: before, mode, ...intent });
    assert.deepEqual(await f.rows(), rows);
    assert.match(plan.review, /Resume the exact existing pending native settings/);
    assert.match(plan.review, /indexes 0, 7 → 7; consolidation enabled → disabled/);
    assert.ok(plan.review.includes(new Date(proposal.expiresAt).toISOString()));
    const after = await plan.commit();
    await plan.validate();

    // Then approval retains the original proposal identity and expiry with its exact authority changes.
    assert.equal(after.proposal.id, proposal.id);
    assert.equal(after.proposal.createdAt, proposal.createdAt);
    assert.equal(after.proposal.expiresAt, proposal.expiresAt);
    assert.equal(after.proposal.status, 'approved');
    assert.deepEqual(after.policy, proposal.policy);
    assert.deepEqual(after.pool, proposal.pool);
    assert.deepEqual(after.messageSigningIndexes, before.messageSigningIndexes);
  });
}

test('incompatible pending replacement discloses all old terms and changes nothing before final consent', async t => {
  // Given an incompatible pending request with different limits, signing and consolidation.
  const f = await fixture(t);
  const proposal = await pending(f, { policy: { perRequest: { amount: '9', unit: 'ATTO' }, rolling: [{ days: 3, amount: '14', unit: 'ATTO' }] },
    pool: { indexes: [0], consolidate: false }, signing: [1] });
  const before = await f.snapshot(), rows = await f.rows();

  // When Unlimited is prepared and the person may still decline its combined final review.
  const plan = await prepareMarketplacePayments({ expected: before, mode: 'unlimited' });
  await plan.validate();

  // Then replacement is explicit, fully reviewed, and the original pending proposal remains intact.
  assert.deepEqual(await f.rows(), rows);
  assert.match(plan.review, /replaces the existing pending native settings only after approval/);
  assert.match(plan.review, /Pending native settings to replace: access spend; Per payment: 9 ATTO; rolling: 14 ATTO \/ 3 days; payment pool indexes 0; consolidation disabled/);
  assert.match(plan.review, /Pending generic message signing indexes to replace: 1/);
  assert.ok(plan.review.includes(new Date(proposal.expiresAt).toISOString()));
  assert.equal(plan.review.includes(proposal.id), false);

  // When final caller consent commits that exact replacement.
  const after = await plan.commit();

  // Then only the reviewed replacement changes authority, preserving current pool and signing scope.
  assert.notEqual(after.proposal.id, proposal.id);
  assert.deepEqual(after.policy, unlimited);
  assert.deepEqual(after.pool, before.pool);
  assert.deepEqual(after.messageSigningIndexes, before.messageSigningIndexes);
});

test('pending expiry after preparation rejects validation and approval without renewal', async t => {
  // Given a compatible pending request and a frozen clock just before its expiry.
  const f = await fixture(t), proposal = await pending(f), before = await f.snapshot();
  let now = proposal.expiresAt - 1;
  t.mock.method(Date, 'now', () => now);
  const plan = await prepareMarketplacePayments({ expected: before, mode: 'limited', resumeProposalId: proposal.id });
  const rows = await f.rows();

  // When final consent occurs after the exact pending expiry.
  now = proposal.expiresAt;
  await assert.rejects(plan.validate(), { code: 'PROPOSAL_EXPIRED' });
  await assert.rejects(plan.commit(), { code: 'PROPOSAL_EXPIRED' });

  // Then its original pending identity, terms and expiry are never renewed or replaced.
  assert.deepEqual(await f.rows(), rows);
});

for (const changed of ['same-policy replacement', 'more-permissive replacement', 'expired']) {
  test(`restart disclosure identifies ${changed} while preserving the original desired policy`, async t => {
    // Given previously reviewed pending intent followed by a replacement or expiry before restart.
    const f = await fixture(t), original = await pending(f);
    const previousProposal = { id: original.id, expiresAt: original.expiresAt };
    if (changed === 'expired') {
      await f.mutate(store => store.set('spending.proposal', { ...original, createdAt: Date.now() - 2000, expiresAt: Date.now() - 1000 }));
    } else {
      await pending(f, { policy: changed === 'same-policy replacement' ? original.policy
        : { perRequest: { amount: '99', unit: 'ATTO' }, rolling: [] } });
    }
    const before = await f.snapshot(), rows = await f.rows();

    // When a new read-only plan reviews the current snapshot with the saved desired caps and prior reference.
    const plan = await prepareMarketplacePayments({ expected: before, mode: 'limited', policy: original.policy, previousProposal });

    // Then review requires fresh approval, never claims original intent resumed, and retains the old desired policy.
    assert.deepEqual(await f.rows(), rows);
    assert.match(plan.review, /Previous pending native settings changed or expired; the current terms require fresh approval/);
    assert.doesNotMatch(plan.review, /Resume the exact existing pending/);
    assert.match(plan.review, /Requested limits: Per payment: 2 ATTO; rolling: Unlimited/);
    if (changed === 'same-policy replacement') assert.match(plan.review, /Approve the current pending native settings/);
    else assert.match(plan.review, /replaces the existing pending native settings only after approval/);
  });
}

test('a settings change between proposal review and approval is caught inside the native approval lock', async t => {
  // Given final caller consent and a concurrent settings change immediately before native approval.
  const f = await fixture(t), before = await f.snapshot();
  const plan = await prepareMarketplacePayments({ expected: before, mode: 'unlimited' });
  const approve = AttoApplication.prototype.approveLimitsProposal;
  t.mock.method(AttoApplication.prototype, 'approveLimitsProposal', async function (...args) {
    await this.store.withWalletLock(async () => mutations.endpoint(this.store));
    return approve.apply(this, args);
  });

  // When the plan invokes the public native proposal approval method.
  await assert.rejects(plan.commit(), { code: 'PROPOSAL_STALE' });

  // Then the final lock-owned snapshot check denies spend authority and preserves the concurrent settings.
  const after = await f.snapshot();
  assert.equal(after.access, 'read-only');
  assert.deepEqual(after.policy, before.policy);
  assert.equal(after.settings.nodeUrl, 'http://127.0.0.1:45555');
  assert.equal(after.proposal.status, 'pending');
});

test('post-commit validation accepts only its own exact committed snapshot and never rolls back later login failure', async t => {
  // Given an approved native change followed by a failure in the caller's later login stage.
  const f = await fixture(t), plan = await prepareMarketplacePayments({ expected: await f.snapshot(), mode: 'unlimited' });
  const committed = await plan.commit();
  await assert.rejects(Promise.reject(new Error('Login fixture failed')), /Login fixture failed/);

  // When the caller verifies the native plan, then another terminal changes a reviewed setting.
  committed.settings.nodeUrl = 'http://caller-mutated-return.invalid';
  await plan.validate();
  await f.mutate(mutations.endpoint);
  await assert.rejects(plan.validate(), { code: 'PROPOSAL_STALE' });

  // Then approved native authority persists honestly and later foreign changes cannot be adopted silently.
  const after = await f.snapshot();
  assert.equal(after.access, 'spend');
  assert.deepEqual(after.policy, unlimited);
  assert.equal(after.proposal.status, 'approved');
});

test('intent preserves zero as bounded and send-blocking while receiving remains authorized', async t => {
  // Given a saved spend policy containing an intentional zero cap.
  const f = await fixture(t, { access: 'spend', policy: { perRequest: { amount: '0', unit: 'ATTO' }, rolling: [] } });
  const before = await f.snapshot();

  // When Limited retains saved intent and Unlimited is deliberately chosen.
  const limited = inspectMarketplacePaymentIntent(before, 'limited');
  const plan = await prepareMarketplacePayments({ expected: before, mode: 'limited' });
  const unchanged = await plan.commit();
  await withStore(f.directory, store => assert.throws(() => new SpendLedger(store).assertCanReserve('1'), { code: 'SPENDING_LIMIT' }));
  const unbounded = await prepareMarketplacePayments({ expected: unchanged, mode: 'unlimited' });
  const after = await unbounded.commit();

  // Then zero never turns into Unlimited implicitly, and unbounded native policy permits general payments.
  assert.deepEqual(limited, { policy: before.policy, requiresPolicy: false });
  assert.equal(marketplacePaymentsUsable(unchanged), true);
  assert.deepEqual(unchanged, before);
  assert.deepEqual(after.policy, unlimited);
  assert.equal(marketplacePaymentsUsable(after), true);
});

test('Limited needs explicit caps for an unbounded wallet and rejects malformed policies before mutation', async t => {
  // Given an existing unbounded wallet without a bounded pending request.
  const f = await fixture(t, { policy: unlimited }), before = await f.snapshot(), rows = await f.rows();

  // When Limited is requested without usable caps or with malformed explicit terms.
  assert.deepEqual(inspectMarketplacePaymentIntent(before, 'limited'), { requiresPolicy: true });
  for (const policy of [undefined, unlimited, null, {}, { perRequest: { amount: '2' }, rolling: [] },
    { perRequest: null, rolling: [{ days: 1, amount: '2' }] }, { perRequest: null, rolling: [{ days: 0, amount: '2', unit: 'ATTO' }] }]) {
    await assert.rejects(prepareMarketplacePayments({ expected: before, mode: 'limited', policy }), { code: 'INVALID_POLICY' });
  }
  await assert.rejects(prepareMarketplacePayments({ expected: before, mode: 'unlimited', policy: bounded }), { code: 'INVALID_POLICY' });

  // Then preparation rejects invalid authority before creating or replacing any proposal.
  assert.deepEqual(await f.rows(), rows);
});

test('native cap validation accepts only positive ATTO amounts for interactive Limited questions', () => {
  // Given the native amount boundary used by the caller's local input-correction loop.
  const valid = ['1', '0.000000001', '2.123456789'];
  const invalid = ['', '0', 'bad', '-1', '1.0000000001', '9'.repeat(100)];

  // When each answer is validated without terminal I/O.
  for (const amount of valid) validateMarketplacePaymentCap(amount);

  // Then malformed or zero answers retain the exact native INVALID_AMOUNT classification.
  for (const amount of invalid) assert.throws(() => validateMarketplacePaymentCap(amount), { code: 'INVALID_AMOUNT' });
});

test('changing an already-enabled multiaccount wallet from Limited to Unlimited discloses the whole shared scope',async t=>{
  // Given native spend access on unchanged pool [0, 7], selected account 7 and already effective saved signing grants.
  const f=await fixture(t,{access:'spend'}),before=await f.snapshot(),rows=await f.rows();
  // When Unlimited is prepared without changing the pool or signing indexes.
  const plan=await prepareMarketplacePayments({expected:before,mode:'unlimited'});
  // Then the review names every account affected by removal of shared limits without claiming generic signing is newly enabled.
  assert.match(plan.review,/Shared native spending limits apply to pool indexes 0, 7; consolidation enabled\./);
  assert.match(plan.review,/Requested limits: Per payment: Unlimited; rolling: Unlimited/);
  assert.doesNotMatch(plan.review,/generic message signing becomes available|Native payments become enabled/);
  assert.deepEqual(await f.rows(),rows);
});

test('a full native pool rejects an automatic selected-account addition during read-only preparation',async t=>{
  // Given the maximum approved 100-account pool excluding saved selected account 7.
  const indexes=Array.from({length:101},(_,index)=>index).filter(index=>index!==7);
  const f=await fixture(t,{pool:{indexes,consolidate:true}}),before=await f.snapshot(),rows=await f.rows();
  // When preparation would need to add account 7 without removing any existing member.
  await assert.rejects(prepareMarketplacePayments({expected:before,mode:'unlimited'}),{code:'INVALID_POOL'});
  // Then the invalid plan is rejected before any selected wallet can commit, preserving authority and pending intent.
  assert.deepEqual(await f.rows(),rows);
});
