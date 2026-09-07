import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { StateStore } from '../dist/storage/state.js';
import { SpendLedger } from '../dist/spending/ledger.js';

const DAY = 86_400_000;
const NOW = 100 * DAY;
const stateUrl = new URL('../dist/storage/state.js', import.meta.url).href;
const ledgerUrl = new URL('../dist/spending/ledger.js', import.meta.url).href;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'atto-state-test-'));
  const stores = [];
  t.after(() => { for (const store of stores.reverse()) store.close(); rmSync(directory, { recursive: true, force: true }); });
  const open = () => { const store = new StateStore(directory); stores.push(store); return store; };
  const store = open();
  return { directory, open, store, ledger: new SpendLedger(store) };
}

function request(id, raw = '10', overrides = {}) {
  return { id, raw, index: 0, destination: 'synthetic-destination', createdAt: NOW, ...overrides };
}

function publish(ledger, id, raw, publishedAt, overrides = {}) {
  ledger.reserve(request(id, raw, { createdAt: publishedAt, ...overrides }));
  ledger.signed(id, `hash-${id}`, '{"type":"SEND"}');
  ledger.complete(id, { hash: `hash-${id}` }, publishedAt);
}

function child(source, args = []) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', source, ...args], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  process.stderr.on('data', (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => {
    process.on('error', reject);
    process.on('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
  return { process, exit };
}

test('state is durable across connections and rolls back incomplete transactions', async (t) => {
  // Given
  const { store, open, directory } = fixture(t);
  store.set('settings', { autoReceive: true });
  const other = open();

  // When
  assert.throws(() => store.transaction(() => { store.set('settings', { autoReceive: false }); throw new Error('rollback'); }));
  await store.withWalletLock(async () => {
    store.set('committedWhileLocked', true);
    assert.equal(other.get('committedWhileLocked'), true);
  });

  // Then
  assert.deepEqual(other.get('settings'), { autoReceive: true });
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(directory, 'state.sqlite')).mode & 0o777, 0o600);
    assert.equal(statSync(join(directory, 'state.sqlite-wal')).mode & 0o777, 0o600);
  }
});

test('wallet lock serializes connections and releases after callback failure', async (t) => {
  // Given
  const { store, open } = fixture(t);
  const other = open();
  const order = [];

  // When
  const first = store.withWalletLock(async () => { order.push('first'); await delay(50); throw new Error('operation failed'); });
  const second = other.withWalletLock(async () => { order.push('second'); });
  const third = store.withWalletLock(async () => { order.push('third'); });
  const results = await Promise.allSettled([first, second, third]);

  // Then
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(results[2].status, 'fulfilled');
  assert.equal(order[0], 'first');
  assert.deepEqual(new Set(order), new Set(['first', 'second', 'third']));
});

test('two processes cannot reserve the same remaining allowance', { timeout: 15_000 }, async (t) => {
  // Given
  const { directory, ledger } = fixture(t);
  ledger.setPolicy({ perRequest: null, rolling: [{ days: 1, amount: '100', unit: 'RAW' }] });
  const source = `
    import { StateStore } from ${JSON.stringify(stateUrl)};
    import { SpendLedger } from ${JSON.stringify(ledgerUrl)};
    const store = new StateStore(process.argv[1]);
    const ledger = new SpendLedger(store);
    process.once('message', async () => {
      try {
        await store.withWalletLock(async () => {
          ledger.reserve({ id: process.argv[2], index: 0, destination: 'synthetic', raw: '70', createdAt: Date.now() });
          await new Promise(resolve => setTimeout(resolve, 75));
        });
        process.send({ accepted: true });
      } catch (error) { process.send({ code: error.code }); }
      finally { store.close(); process.disconnect(); }
    });
    process.send('ready');
  `;
  const children = [child(source, [directory, 'one']), child(source, [directory, 'two'])];
  t.after(() => children.forEach(({ process }) => process.kill()));
  await Promise.all(children.map(({ process }) => once(process, 'message')));

  // When
  const responses = children.map(({ process }) => once(process, 'message'));
  children.forEach(({ process }) => process.send('start'));
  const outcomes = (await Promise.all(responses)).map(([message]) => message);
  const exits = await Promise.all(children.map(({ exit }) => exit));

  // Then
  assert.equal(outcomes.filter((result) => result.accepted).length, 1);
  assert.equal(outcomes.filter((result) => result.code === 'SPENDING_LIMIT').length, 1);
  assert.equal(ledger.usage().pendingRaw, '70');
  exits.forEach((result) => assert.equal(result.code, 0, result.stderr));
});

test('process death releases coordination lock and preserves committed reservation', { timeout: 15_000 }, async (t) => {
  // Given
  const { directory, store, ledger } = fixture(t);
  const source = `
    import { StateStore } from ${JSON.stringify(stateUrl)};
    import { SpendLedger } from ${JSON.stringify(ledgerUrl)};
    const store = new StateStore(process.argv[1]);
    await store.withWalletLock(async () => {
      new SpendLedger(store).reserve({ id: 'crash', index: 0, destination: 'synthetic', raw: '42', createdAt: Date.now() });
      process.send('locked');
      await new Promise(() => {});
    });
  `;
  const running = child(source, [directory]);
  t.after(() => running.process.kill());
  await once(running.process, 'message');

  // When
  running.process.kill('SIGKILL');
  await running.exit;
  await store.withWalletLock(async () => store.set('recovered', true));

  // Then
  assert.equal(store.get('recovered'), true);
  assert.equal(ledger.get('crash').raw, '42');
  assert.equal(ledger.usage().pendingRaw, '42');
});

test('unlimited default preserves integers beyond JavaScript number precision', (t) => {
  // Given
  const { ledger } = fixture(t);

  // When
  ledger.reserve(request('large', '9007199254740993'));

  // Then
  assert.deepEqual(ledger.policy(), { perRequest: null, rolling: [] });
  assert.equal(ledger.usage(NOW).pendingRaw, '9007199254740993');
});

test('all rolling rules apply across addresses and retain unresolved old reservations', (t) => {
  // Given
  const { ledger } = fixture(t);
  publish(ledger, 'published', '30', NOW - 5 * DAY);
  ledger.reserve(request('old-pending', '10', { index: 7, createdAt: NOW - 30 * DAY }));
  ledger.setPolicy({ perRequest: { amount: '80', unit: 'RAW' }, rolling: [
    { days: 1, amount: '50', unit: 'RAW' },
    { days: 7, amount: '60', unit: 'RAW' },
  ] });

  // When
  ledger.reserve(request('allowed', '20', { index: 2 }));
  const usage = ledger.usage(NOW);

  // Then
  assert.equal(usage.rolling[0].usedRaw, '30');
  assert.equal(usage.rolling[1].usedRaw, '60');
  assert.equal(usage.rolling[1].remainingRaw, '0');
  assert.throws(() => ledger.reserve(request('too-much', '1')), { code: 'SPENDING_LIMIT' });
  assert.throws(() => ledger.reserve(request('per-request', '81')), { code: 'SPENDING_LIMIT' });
  assert.equal(ledger.get('too-much'), undefined);
});

test('rolling windows expire at the exact boundary and survive policy replacement', (t) => {
  // Given
  const { ledger } = fixture(t);
  publish(ledger, 'boundary', '20', NOW - DAY);
  publish(ledger, 'inside', '15', NOW - DAY + 1);
  publish(ledger, 'clock-rollback', '5', NOW + 1);
  ledger.setPolicy({ perRequest: null, rolling: [{ days: 1, amount: '100', unit: 'RAW' }] });

  // When
  const oneDay = ledger.usage(NOW).rolling[0];
  ledger.setPolicy({ perRequest: null, rolling: [] });
  ledger.setPolicy({ perRequest: null, rolling: [{ days: 7, amount: '100', unit: 'RAW' }] });

  // Then
  assert.equal(oneDay.publishedRaw, '20');
  assert.equal(ledger.usage(NOW).rolling[0].publishedRaw, '40');
  assert.equal(ledger.get('boundary').status, 'published');
});

test('request IDs are idempotent and conflicting reuse is rejected', (t) => {
  // Given
  const { ledger } = fixture(t);
  const initial = ledger.reserve(request('same'));

  // When
  const repeated = ledger.reserve(request('same', '10', { createdAt: NOW + 1000 }));

  // Then
  assert.deepEqual(repeated, initial);
  assert.equal(ledger.usage(NOW).pendingRaw, '10');
  for (const difference of [{ raw: '11' }, { index: 1 }, { destination: 'another' }]) {
    assert.throws(() => ledger.reserve({ ...request('same'), ...difference }), { code: 'REQUEST_CONFLICT' });
  }
});

test('signed uncertain payments persist across restart and complete once', (t) => {
  // Given
  const { store, open, ledger } = fixture(t);
  ledger.reserve(request('uncertain'));
  ledger.signed('uncertain', 'hash', '{"block":"public"}');
  ledger.uncertain('uncertain');
  store.close();

  // When
  const reopened = new SpendLedger(open());
  assert.equal(reopened.pending()[0].hash, 'hash');
  assert.equal(reopened.pending()[0].blockJson, '{"block":"public"}');
  reopened.complete('uncertain', { hash: 'hash', height: '3' }, NOW + DAY);
  reopened.complete('uncertain', { hash: 'hash', height: '3' }, NOW + 2 * DAY);

  // Then
  assert.equal(reopened.pending().length, 0);
  assert.equal(reopened.get('uncertain').publishedAt, NOW + DAY);
  assert.deepEqual(reopened.get('uncertain').result, { hash: 'hash', height: '3' });
});

test('only definite failures release reservations', (t) => {
  // Given
  const { ledger } = fixture(t);
  ledger.reserve(request('not-signed', '4'));
  ledger.reserve(request('signed', '6'));
  ledger.signed('signed', 'hash', '{}');
  ledger.uncertain('signed');

  // When
  ledger.fail('not-signed');

  // Then
  assert.equal(ledger.usage(NOW + 30 * DAY).pendingRaw, '6');
  assert.throws(() => ledger.fail('signed'), { code: 'SEND_STATE' });
  ledger.reject('signed');
  assert.equal(ledger.usage(NOW).pendingRaw, '0');
  assert.equal(ledger.get('signed').hash, 'hash');
  assert.equal(ledger.get('signed').status, 'failed');
});

test('invalid public policies fail without replacing the existing policy', (t) => {
  // Given
  const { ledger } = fixture(t);
  const policy = { perRequest: { amount: '0', unit: 'RAW' }, rolling: [] };
  ledger.setPolicy(policy);

  // When / Then
  for (const invalid of [null, {}, { rolling: [] }, { perRequest: { amount: '1' }, rolling: [] },
    { perRequest: null, rolling: [{ days: 0, amount: '1', unit: 'RAW' }] },
    { perRequest: null, rolling: [{ days: 1.5, amount: '1', unit: 'RAW' }] },
    { perRequest: null, rolling: [{ days: 1, amount: '-1', unit: 'RAW' }] },
    { perRequest: null, rolling: [{ days: 1, amount: '1.2', unit: 'RAW' }] },
  ]) assert.throws(() => ledger.setPolicy(invalid), { code: 'INVALID_POLICY' });
  assert.deepEqual(ledger.policy(), policy);
  assert.throws(() => ledger.reserve(request('blocked')), { code: 'SPENDING_LIMIT' });
});

test('invalid persisted spending records stop payments instead of dropping allowance usage', (t) => {
  // Given
  const { store, ledger } = fixture(t);
  const invalid = { ...request('damaged'), status: 'unrecognized-status' };
  store.set('spending.records', [invalid]);

  // When / Then
  assert.throws(() => ledger.usage(NOW), { code: 'INVALID_STATE' });
  assert.throws(() => ledger.reserve(request('new')), { code: 'INVALID_STATE' });
  assert.deepEqual(store.get('spending.records'), [invalid]);
});
