import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { unlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fixture, gate, until } from './support/payments.mjs';
import { cli, credentialEnvironment } from './support/detached.mjs';
const applicationUrl = process.env.ATTO_TEST_CLI_PACKAGE_DIR
  ? pathToFileURL(join(process.env.ATTO_TEST_CLI_PACKAGE_DIR, 'dist/application/app.js'))
  : new URL('../dist/application/app.js', import.meta.url);
const { MarketData } = await import(new URL('../pricing/market.js', applicationUrl).href);

for (const mode of ['transient', 'persistent', 'unexpected']) {
  test(`payment fixture cleanup handles ${mode} file-removal errors`, { timeout: 30_000 }, async () => {
    // Given an isolated process emulating Windows refusing to unlink a busy SQLite file.
    const source = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { rm, stat } from 'node:fs/promises';
      import { join } from 'node:path';
      const mode = process.argv[1];
      const code = mode === 'unexpected' ? 'EIO' : 'EBUSY';
      let blockedFile;
      let attempts = 0;
      const unlink = fs.unlink;
      fs.unlink = (file, callback) => {
        if (String(file) === blockedFile && (mode !== 'transient' || attempts < 2)) {
          attempts++;
          queueMicrotask(() => callback(Object.assign(new Error('Synthetic file-removal failure'), { code })));
        } else unlink(file, callback);
      };
      const { fixture } = await import(${JSON.stringify(new URL('./support/payments.mjs', import.meta.url).href)});
      const cleanups = [];
      const f = await fixture({ after: cleanup => cleanups.push(cleanup) }, [10]);
      blockedFile = join(f.directory, 'coordination.sqlite');
      try {
        if (mode === 'transient') {
          await cleanups[0]();
          assert.equal(attempts, 2);
          await assert.rejects(stat(f.directory), { code: 'ENOENT' });
        } else {
          await assert.rejects(cleanups[0](), { code });
          if (mode === 'unexpected') assert.equal(attempts, 1);
          else assert.ok(attempts > 1);
        }
      } finally {
        blockedFile = undefined;
        await rm(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    `;
    // When the actual fixture teardown encounters transient, persistent, or unrelated errors.
    const execution = promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, mode], { timeout: 25_000 });
    // Then transient locks are retried; persistent and unrelated errors remain failures.
    await assert.doesNotReject(execution);
  });
}

test('a confirmed payment stays published when speculative persistence fails', async t => {
  // Given a working payment path and a storage failure limited to the work queue.
  const f = await fixture(t, [10], undefined, '100', undefined, { workExecution: 'detached' });
  const set = f.app.store.set.bind(f.app.store);
  f.app.store.set = (key, value) => {
    if (key === 'work.queue') throw new Error('Synthetic speculative storage failure');
    set(key, value);
  };
  let result;
  // When the payment is confirmed before optional preparation is persisted.
  try { result = await f.app.call('send', f.request('preparation-storage-failure')); }
  finally { f.app.store.set = set; }
  // Then success, the journal, and the single debit are preserved.
  assert.equal(result.status, 'published');
  assert.equal((await f.app.call('journal_get', { requestId: 'preparation-storage-failure' })).record.status, 'published');
  assert.equal(f.state.publications.length, 1);
});

test('a real CLI send exits while preparation continues and the next CLI send consumes that cache', { timeout: 20_000 }, async t => {
  // Given a synthetic wallet and credentials isolated from the user's keyring.
  const f = await fixture(t, [10]);
  const env = await credentialEnvironment(t, f.mnemonic());
  const args = id => ['send', f.recipient.address, '1', '--unit', 'RAW', '--request-id', id];
  // When a finite send exits, its detached preparation finishes independently.
  const first = await cli(f.directory, args('cli-detached-first'), env);
  assert.equal(first.status, 'published');
  await until(async () => (await f.app.call('pool_get')).accounts[0].workReady, 10_000);
  const requestsForPreparedHead = f.state.works.filter(value => value.target === first.hash).length;
  const second = await cli(f.directory, args('cli-detached-second'), env);
  // Then the new process publishes using the prepared head without recomputing it.
  assert.equal(second.status, 'published');
  assert.equal(requestsForPreparedHead, 1);
  assert.equal(f.state.works.filter(value => value.target === first.hash).length, 1);
  assert.equal(f.state.publications.length, 2);
});

test('work lock and detached-launch failures fall back without changing a confirmed send', async t => {
  // Given unusable lock directories, while ordinary wallet state remains writable.
  const f = await fixture(t, [10], undefined, '100', undefined, { workExecution: 'detached' });
  const paths = ['work-locks', 'process-locks'].map(name => join(f.directory, name));
  for (const path of paths) await writeFile(path, 'synthetic blocked directory');
  try {
    // When foreground generation cannot coordinate and the detached owner cannot start.
    const result = await f.app.call('send', f.request('work-lock-fallback'));
    await delay(500);
    // Then the payment still succeeds and its optional public job remains retryable.
    assert.equal(result.status, 'published');
    assert.equal(f.state.publications.length, 1);
    assert.equal(f.state.works.length, 1);
    assert.equal(f.app.store.get('work.queue').length, 1);
  } finally { for (const path of paths) await unlink(path); }
});

test('Automatic selection prefers sufficient prepared work over a larger cold account', { timeout: 20_000 }, async t => {
  // Given two funded accounts and work prepared only for index 1 through the public session lifecycle.
  const f = await fixture(t, [3, 2], { indexes: [1], consolidate: false });
  await f.app.start();
  await until(async () => (await f.app.call('pool_get')).accounts[0].workReady);
  await f.approve({ indexes: [0, 1], consolidate: false });
  const before = await f.app.call('pool_get');
  assert.equal(before.accounts.find(account => account.index === 0).workReady, false);

  // When an automatic payment can be covered by either account.
  const result = await f.app.call('send', f.request('ready-account'));

  // Then the prepared account is selected and only one signed payment is published.
  assert.equal(result.index, 1);
  assert.equal(result.sourceAddress, f.addresses[1].address);
  assert.equal(f.state.publications.length, 1);
  assert.equal(f.state.publications[0].address.value, f.addresses[1].address);
});

test('Consolidation bills the final payment once and preserves its journal after restart', { timeout: 20_000 }, async t => {
  // Given two accounts holding 1 RAW each and an approved 2 RAW payment budget.
  const f = await fixture(t, [1, 1], { indexes: [0, 1], consolidate: true }, '2');
  const request = f.request('consolidated', '2', { metadata: { reason: 'Invoice', order: { id: '42' } } });

  // When one payment consolidates a donor, receives it, and pays the destination.
  const result = await f.app.call('send', request);
  await f.reopen();
  const { record } = await f.app.call('journal_get', { requestId: request.requestId });
  const usage = await f.app.call('limits_get');

  // Then all three valid network transactions belong to one durable 2 RAW payment.
  assert.equal(f.state.publications.length, 3);
  assert.deepEqual(f.state.publications.map(value => JSON.parse(value.block.toJson()).type), ['SEND', 'RECEIVE', 'SEND']);
  assert.equal(result.index, 0);
  assert.equal(record.sourceAddress, f.addresses[0].address);
  assert.equal(record.network, 'LOCAL');
  assert.deepEqual(record.metadata, request.metadata);
  assert.deepEqual(record.plan.steps.map(step => step.status), ['published', 'published']);
  assert.equal(record.hash, result.hash);
  assert.equal(usage.pendingRaw, '0');
  assert.equal(usage.rolling[0].publishedRaw, '2');
  assert.equal(usage.rolling[0].remainingRaw, '0');
  assert.deepEqual((await f.app.call('journal_list', { status: 'published' })).items.map(value => value.id), [request.requestId]);
  assert.deepEqual(await f.app.call('send', request), result);
  assert.equal(f.state.publications.length, 3);
});

test('Concurrent sessions choose distinct accounts and atomically share one budget', { timeout: 20_000 }, async t => {
  // Given three sessions, two funded accounts, and allowance for only two payments.
  const f = await fixture(t, [3, 3], undefined, '2');
  const sessions = [f.app, f.open('mcp'), f.open('mcp')];
  f.state.holdPublications = gate();

  // When the first payments overlap while their node responses are held open.
  const results = Promise.allSettled(sessions.map((application, index) => application.call('send', f.request(`concurrent-${index}`))));
  await until(() => f.state.publications.length === 2);
  const sources = f.state.publications.map(value => value.address.value);
  f.state.holdPublications.release();
  const settled = await results;

  // Then two distinct account chains advance and the third payment cannot exceed the shared cap.
  assert.equal(new Set(sources).size, 2);
  assert.equal(settled.filter(value => value.status === 'fulfilled').length, 2);
  assert.deepEqual(settled.filter(value => value.status === 'rejected').map(value => value.reason.code), ['SPENDING_LIMIT']);
  const usage = await f.app.call('limits_get');
  assert.equal(usage.rolling[0].publishedRaw, '2');
  assert.equal(usage.pendingRaw, '0');
  assert.equal(f.state.publications.length, 2);
});

test('A lost internal-publication response resumes the same plan without duplicate transfers', { timeout: 20_000 }, async t => {
  // Given a node that commits the donor transaction but loses its response.
  const f = await fixture(t, [1, 1], { indexes: [0, 1], consolidate: true }, '2');
  const request = f.request('resume-plan', '2', { metadata: { reason: 'One payment' } });
  f.state.failPublication = 1;
  f.state.hideHashLookup = true;

  // When the caller reopens the application and retries using canonical account history.
  await assert.rejects(f.app.call('send', request), { code: 'PUBLICATION_UNCERTAIN' });
  const before = (await f.app.call('journal_get', { requestId: request.requestId })).record;
  assert.equal(before.plan.steps[0].status, 'unknown');
  assert.equal(f.state.publications.length, 1);
  await f.reopen();
  const result = await f.app.call('send', f.request(request.requestId, '2'));

  // Then the original donor hash is retained and only the missing receive and final send execute.
  const after = (await f.app.call('journal_get', { requestId: request.requestId })).record;
  assert.equal(result.status, 'published');
  assert.deepEqual(result.metadata, request.metadata);
  assert.equal(after.plan.steps[0].hash, before.plan.steps[0].hash);
  assert.equal(after.index, before.index);
  assert.equal(f.state.publications.length, 3);
  assert.equal(new Set(f.state.publicationAttempts.map(value => value.hash.toString())).size, 3);
  assert.ok(f.state.requests.some(value => value.path.endsWith('/transactions/stream') && value.method === 'GET'));
  assert.equal((await f.app.call('limits_get')).rolling[0].publishedRaw, '2');
});

test('Metadata is immutable across retries while omitted metadata retains the original', { timeout: 20_000 }, async t => {
  // Given a published payment with nested caller metadata.
  const f = await fixture(t, [3]);
  const request = f.request('metadata', '1', { metadata: { reason: 'Invoice', order: { id: '42' } } });
  const result = await f.app.call('send', request);
  await f.reopen();

  // When retries omit, repeat, or change the original metadata.
  const omitted = await f.app.call('send', f.request(request.requestId));
  const repeated = await f.app.call('send', request);
  await assert.rejects(f.app.call('send', { ...request, metadata: { reason: 'Different' } }), { code: 'REQUEST_CONFLICT' });

  // Then successful retries return the original result without a new publication.
  assert.deepEqual(omitted, result);
  assert.deepEqual(repeated, result);
  assert.deepEqual((await f.app.call('journal_get', { requestId: request.requestId })).record.metadata, request.metadata);
  assert.equal(f.state.publications.length, 1);
});

test('Pool proposals require approval and explicit sources never consolidate', { timeout: 20_000 }, async t => {
  // Given a two-account pool whose balances are insufficient individually.
  const f = await fixture(t, [1, 1, 3], { indexes: [0, 1], consolidate: false });
  const mcp = f.open('mcp');
  const policy = (await f.app.call('limits_get')).policy;
  const { proposal } = await mcp.call('limits_propose', { policy, pool: { indexes: [0, 1], consolidate: true } });

  // When a proposal is still pending and callers select automatic or explicit sources.
  await assert.rejects(mcp.call('send', f.request('unapproved', '2')), { code: 'CONSOLIDATION_REQUIRED' });
  await f.app.approveLimitsProposal(proposal.id);
  await assert.rejects(mcp.call('send', f.request('explicit-insufficient', '2', { index: 0 })), { code: 'INSUFFICIENT_BALANCE' });
  await assert.rejects(mcp.call('send', f.request('outside-pool', '1', { index: 2 })), { code: 'POOL_APPROVAL_REQUIRED' });
  const local = await f.app.call('send', f.request('local-explicit', '1', { index: 2 }));

  // Then only the permitted local explicit account sends, with no consolidation steps.
  assert.equal(local.index, 2);
  assert.equal(f.state.publications.length, 1);
  assert.equal(local.consolidation, undefined);
  assert.equal((await f.app.call('journal_list')).items.length, 1);
});

test('Revocation after reservation releases an unsigned payment and its allowance', { timeout: 20_000 }, async t => {
  // Given an approved MCP session paused after the durable reservation releases the wallet lock.
  const f = await fixture(t, [3], undefined, '2');
  const mcp = f.open('mcp');
  const proceed = gate();
  f.state.releaseExecution = proceed.release;
  const withWalletLock = mcp.store.withWalletLock.bind(mcp.store);
  let paused = false;
  mcp.store.withWalletLock = async callback => {
    const value = await withWalletLock(callback);
    if (!paused && value?.id === 'revoked' && value.status === 'reserved') {
      paused = true;
      await proceed.promise;
    }
    return value;
  };

  // When local approval revokes MCP access before the payment can execute.
  const payment = assert.rejects(mcp.call('send', f.request('revoked')), { code: 'MCP_READ_ONLY' });
  await until(() => paused);
  await f.approve(undefined, 'read-only');
  proceed.release();
  await payment;

  // Then no signing/work/publication occurs and the failed reservation releases the account and budget.
  const { record } = await f.app.call('journal_get', { requestId: 'revoked' });
  assert.equal(record.status, 'failed');
  assert.equal(record.hash, undefined);
  assert.equal(f.state.works.length, 0);
  assert.equal(f.state.publications.length, 0);
  const usage = await f.app.call('limits_get');
  assert.equal(usage.pendingRaw, '0');
  assert.equal(usage.rolling[0].remainingRaw, '2');
  assert.equal((await f.app.call('pool_get')).accounts[0].busy, false);
});

test('Revoking consolidation after an internal transfer pauses and later resumes the plan', { timeout: 20_000 }, async t => {
  // Given an approved consolidation whose donor publication response is held open.
  const f = await fixture(t, [1, 1], { indexes: [0, 1], consolidate: true }, '2');
  f.state.holdPublications = gate();
  const request = f.request('paused-plan', '2');

  // When consolidation is revoked after the donor commits, before the receiving signature.
  const paused = assert.rejects(f.app.call('send', request), { code: 'CONSOLIDATION_REQUIRED' });
  await until(() => f.state.publications.length === 1);
  await f.approve({ indexes: [0, 1], consolidate: false });
  f.state.holdPublications.release();
  await paused;
  const before = (await f.app.call('journal_get', { requestId: request.requestId })).record;
  const pending = await f.app.call('limits_get');
  await f.approve({ indexes: [0, 1], consolidate: true });
  const resumed = await f.app.call('send', request);

  // Then only confirmed internal progress is retained and resumption never repeats that transfer.
  assert.equal(before.status, 'unknown');
  assert.equal(pending.pendingRaw, '2');
  assert.equal(pending.rolling[0].publishedRaw, '0');
  assert.equal(before.plan.steps[0].status, 'published');
  assert.equal(before.plan.steps[1].hash, undefined);
  assert.equal(before.hash, undefined);
  assert.equal(resumed.status, 'published');
  assert.equal(f.state.publications.length, 3);
  assert.equal((await f.app.call('limits_get')).rolling[0].publishedRaw, '2');
});

test('Lowering spending limits after an internal transfer blocks further signing until restored', { timeout: 20_000 }, async t => {
  // Given a 2 RAW payment whose donor committed while its publication response remains pending.
  const pool = { indexes: [0, 1], consolidate: true };
  const f = await fixture(t, [1, 1], pool, '2');
  const request = f.request('reduced-limit', '2');
  f.state.holdPublications = gate();

  // When local approval lowers the spending cap to 1 RAW before the receiving signature.
  const blocked = assert.rejects(f.app.call('send', request), { code: 'SPENDING_LIMIT' });
  await until(() => f.state.publications.length === 1);
  const { proposal } = await f.app.call('limits_propose', {
    policy: { perRequest: { amount: '1', unit: 'RAW' }, rolling: [{ days: 1, amount: '1', unit: 'RAW' }] },
    pool,
  });
  await f.app.approveLimitsProposal(proposal.id);
  f.state.holdPublications.release();
  await blocked;
  const before = (await f.app.call('journal_get', { requestId: request.requestId })).record;
  const pending = await f.app.call('limits_get');
  await f.approve();
  const resumed = await f.app.call('send', request);

  // Then the allowance remains reserved and restoring the cap resumes only the missing transactions.
  assert.deepEqual(pending.pool, pool);
  assert.equal(before.status, 'unknown');
  assert.equal(before.plan.steps[0].status, 'published');
  assert.equal(before.plan.steps[1].hash, undefined);
  assert.equal(before.hash, undefined);
  assert.equal(pending.pendingRaw, '2');
  assert.equal(pending.rolling[0].publishedRaw, '0');
  assert.equal(resumed.status, 'published');
  assert.equal(f.state.publications.length, 3);
  assert.equal(new Set(f.state.publicationAttempts.map(value => value.hash.toString())).size, 3);
  assert.equal((await f.app.call('limits_get')).rolling[0].publishedRaw, '2');
});

test('Changing networks during a USD quote rejects the payment before reservation or signing', { timeout: 20_000 }, async t => {
  // Given accepted USD terms and a market fetch held open entirely within this fixture.
  const response = gate();
  let lookups = 0;
  const market = new MarketData('https://metrics.example.test/prices', async () => {
    lookups++;
    await response.promise;
    return Response.json({ metrics: [{ name: 'price.usd', date: new Date().toISOString().slice(0, 10), value: '1000000000' }] });
  });
  const f = await fixture(t, [3], undefined, '2', market);
  f.state.releaseExecution = response.release;
  await f.app.call('wallet_configure', { network: 'LIVE' });
  const { version } = await f.app.call('terms_get');
  await f.app.call('terms_accept', { version, accepted: true });
  const request = f.request('quote-network-race', '1', { unit: 'USD' });
  const other = f.open();

  // When another session selects LOCAL while the valid USD conversion is pending.
  const rejected = assert.rejects(f.app.call('send', request), { code: 'NETWORK_MISMATCH' });
  await until(() => lookups === 1);
  await other.call('wallet_configure', { network: 'LOCAL' });
  response.release();
  await rejected;

  // Then no journal reservation, account lookup, signature, work, or publication can follow the stale network decision.
  assert.equal(lookups, 1);
  assert.deepEqual((await f.app.call('journal_list')).items, []);
  assert.equal((await f.app.call('limits_get')).pendingRaw, '0');
  assert.equal(f.state.requests.length, 0);
  assert.equal(f.state.works.length, 0);
  assert.equal(f.state.publications.length, 0);
});

test('Concurrent retries of one request share a reservation and publish once', { timeout: 20_000 }, async t => {
  // Given two sessions and one payment waiting for its publication response.
  const f = await fixture(t, [3, 3], undefined, '1');
  const other = f.open('mcp');
  const request = f.request('same-request', '1', { metadata: { reason: 'One invoice' } });
  f.state.holdPublications = gate();
  const first = f.app.call('send', request);
  await until(() => f.state.publications.length === 1);

  // When the other session retries that request before the original call completes.
  const retry = other.call('send', request);
  const journal = await f.app.call('journal_list');
  const pending = await f.app.call('limits_get');
  f.state.holdPublications.release();
  const results = await Promise.all([first, retry]);

  // Then both callers observe one result, one allowance reservation, and one network publication.
  assert.equal(journal.items.length, 1);
  assert.equal(journal.items[0].id, request.requestId);
  assert.equal(pending.pendingRaw, '1');
  assert.deepEqual(results[0], results[1]);
  assert.equal(f.state.publications.length, 1);
  assert.equal(f.state.publicationAttempts.length, 1);
  assert.equal((await f.app.call('limits_get')).rolling[0].publishedRaw, '1');
});

test('personal-name payments retain destination and original name across rename, removal, reassignment and restart', { timeout: 20_000 }, async t => {
  // Given a funded wallet and an exact personal destination.
  const f = await fixture(t, [5]);
  await f.app.call('labels_set', { address: f.recipient.address, label: 'Savings' });
  const request = { destinationLabel: '  sAvInGs  ', amount: '1', unit: 'RAW', requestId: 'personal-payment' };

  // When publication succeeds, then the label changes between retries.
  const result = await f.app.call('send', request);
  const expected = { network: 'LOCAL', address: f.recipient.address, label: 'Savings' };
  for (const change of [
    () => f.app.call('labels_set', { address: f.recipient.address, label: 'Renamed' }),
    () => f.app.call('labels_remove', { address: f.recipient.address }),
    () => f.app.call('labels_set', { address: f.addresses[0].address, label: 'Savings' }),
  ]) {
    await change();
    await f.reopen();
    const retry = await f.app.call('send', request);
    // Then retries keep the original signed hash and local binding.
    assert.equal(retry.hash, result.hash);
    assert.deepEqual(retry.destinationBinding, expected);
  }
  assert.deepEqual((await f.app.call('journal_get', { requestId: request.requestId })).record.destinationBinding, expected);
  assert.equal(f.state.publications[0].block.receiverAddress.value, f.recipient.address);
  assert.equal(f.state.publications.length, 1);
  assert.equal((await f.app.call('send', { ...request, destinationLabel: undefined, destination: f.recipient.address })).hash, result.hash);
  await assert.rejects(f.app.call('send', { ...request, destinationLabel: 'Renamed' }), { code: 'REQUEST_CONFLICT' });
});

test('a pre-reservation node failure pins the local name before the first request and a later retry still pays that address', { timeout: 20_000 }, async t => {
  // Given a named recipient and a node URL that fails account lookup.
  const f = await fixture(t, [5]);
  await f.app.call('labels_set', { address: f.recipient.address, label: 'Savings' });
  const fetch = globalThis.fetch;
  const request = { destinationLabel: 'Savings', amount: '1', unit: 'RAW', requestId: 'node-failed-before-reserve' };
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    assert.equal(f.app.store.get(`send.destination.${request.requestId}`).address, f.recipient.address);
    throw new TypeError('Synthetic network failure');
  };
  try { await assert.rejects(f.app.call('send', request)); }
  finally { globalThis.fetch = fetch; }
  assert.ok(calls > 0);
  assert.equal(f.app.ledger.get(request.requestId), undefined);
  await f.app.call('labels_remove', { address: f.recipient.address });
  await f.app.call('labels_set', { address: f.addresses[0].address, label: 'Savings' });
  await f.reopen();

  // When the network recovers and the same ID is retried.
  const result = await f.app.call('send', request);

  // Then account lookup failure did not permit rebinding, and the original recipient receives one payment.
  assert.equal(result.destination, f.recipient.address);
  assert.equal(f.state.publications.length, 1);
  assert.equal(f.state.publications[0].block.receiverAddress.value, f.recipient.address);
});

test('concurrent same-ID label sends and publication recovery preserve one debit after the label is reassigned', { timeout: 20_000 }, async t => {
  // Given a label payment held while the node commits its publication.
  const f = await fixture(t, [5]);
  await f.app.call('labels_set', { address: f.recipient.address, label: 'Savings' });
  f.state.holdPublications = gate();
  const request = { destinationLabel: 'Savings', amount: '1', unit: 'RAW', requestId: 'concurrent-label' };
  const first = f.app.call('send', request);
  await until(() => f.state.publications.length === 1);
  await f.app.call('labels_remove', { address: f.recipient.address });
  await f.app.call('labels_set', { address: f.addresses[0].address, label: 'Savings' });
  const other = f.open();

  // When another session retries the same name while its original request is running.
  const retry = other.call('send', request);
  f.state.holdPublications.release();
  const results = await Promise.all([first, retry]);

  // Then both observe the same address, hash, binding and one charged payment.
  assert.equal(results[0].hash, results[1].hash);
  assert.equal(results[1].destinationBinding.address, f.recipient.address);
  assert.equal(f.state.publications.length, 1);
  assert.equal((await f.app.call('limits_get')).rolling[0].publishedRaw, '1');
});
