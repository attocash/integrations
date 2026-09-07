import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const stateUrl = pathToFileURL(join(packageDirectory, 'dist/storage/state.js')).href;
const { StateStore } = await import(stateUrl);

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'atto-account-lock-test-'));
  const stores = [];
  const open = () => { const store = new StateStore(directory); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, open, store: open() };
}

function child(t, source, args) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', source, ...args], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  process.stderr.on('data', chunk => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => {
    process.on('error', reject);
    process.on('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
  t.after(() => process.kill());
  return { process, exit };
}

test('busy accounts do not block disjoint accounts or short wallet reservations', async t => {
  // Given
  const { store, open } = fixture(t);
  const other = open();
  const release = store.tryAccountLocks([0]);
  assert.equal(typeof release, 'function');
  t.after(() => release());

  // When
  const same = other.tryAccountLocks([0]);
  const disjoint = other.tryAccountLocks([1]);
  assert.equal(typeof disjoint, 'function');
  disjoint();
  await other.withWalletLock(async () => other.set('reserved', true));

  // Then
  assert.equal(same, undefined);
  assert.equal(store.get('reserved'), true);
  assert.throws(() => store.close(), { code: 'WALLET_BUSY' });
  release();
  release();
  const reacquired = other.tryAccountLocks([0]);
  assert.equal(typeof reacquired, 'function');
  reacquired();
});

test('a failed multi-account attempt releases partial acquisitions immediately', t => {
  // Given
  const { store, open } = fixture(t);
  const other = open();
  const releaseBusy = other.tryAccountLocks([2]);
  t.after(() => releaseBusy());

  // When
  const attempted = store.tryAccountLocks([2, 0, 1]);
  const independent = other.tryAccountLocks([0, 1]);

  // Then
  assert.equal(attempted, undefined);
  assert.equal(typeof independent, 'function');
  independent();
  releaseBusy();
  const complete = store.tryAccountLocks([2, 0, 1, 0]);
  assert.equal(typeof complete, 'function');
  complete();
});

test('account callbacks may take short wallet locks and release their accounts after failure', async t => {
  // Given
  const { store, open } = fixture(t);
  const other = open();
  const order = [];

  // When
  const first = store.withAccountLocks([1, 0], async () => {
    order.push('first');
    await store.withWalletLock(async () => store.set('first', true));
    await delay(50);
    throw new Error('Synthetic callback failure.');
  });
  const second = other.withAccountLocks([0, 1], async () => {
    order.push('second');
    await other.withWalletLock(async () => other.set('second', true));
  });
  const results = await Promise.allSettled([first, second]);

  // Then
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(store.get('first'), true);
  assert.equal(store.get('second'), true);
});

test('account locks reject invalid indexes and refuse new work after close', t => {
  // Given
  const { store } = fixture(t);

  // When / Then
  for (const indexes of [[], [-1], [1.5], [2147483648]]) assert.throws(() => store.tryAccountLocks(indexes), { code: 'INVALID_INDEX' });
  store.close();
  assert.throws(() => store.tryAccountLocks([0]), { code: 'STATE_CLOSED' });
});

test('a process holding one account leaves others usable and death releases its lock', { timeout: 15_000 }, async t => {
  // Given
  const { store, directory } = fixture(t);
  const running = child(t, `
    import { StateStore } from ${JSON.stringify(stateUrl)};
    const store = new StateStore(process.argv[1]);
    process.on('message', () => {});
    await store.withAccountLocks([1], async () => {
      await store.withWalletLock(async () => store.set('durable', true));
      process.send('locked');
      await new Promise(() => {});
    });
  `, [directory]);
  await once(running.process, 'message');

  // When
  const busy = store.tryAccountLocks([1]);
  busy?.();
  assert.equal(busy, undefined);
  const release = store.tryAccountLocks([0]);
  assert.equal(typeof release, 'function');
  release();
  running.process.kill('SIGKILL');
  await running.exit;
  await store.withAccountLocks([1], async () => store.set('recovered', true));

  // Then
  assert.equal(store.get('durable'), true);
  assert.equal(store.get('recovered'), true);
});

test('processes requesting the same account set in opposite orders serialize without deadlock', { timeout: 15_000 }, async t => {
  // Given
  const { store, directory } = fixture(t);
  store.set('counter', 0);
  const source = `
    import { StateStore } from ${JSON.stringify(stateUrl)};
    const store = new StateStore(process.argv[1]);
    process.once('message', async () => {
      try {
        await store.withAccountLocks(JSON.parse(process.argv[2]), async () => {
          const previous = store.get('counter');
          await new Promise(resolve => setTimeout(resolve, 75));
          store.set('counter', previous + 1);
        });
        process.send('done');
      } finally { store.close(); process.disconnect(); }
    });
    process.send('ready');
  `;
  const children = [[0, 1], [1, 0]].map(indexes => child(t, source, [directory, JSON.stringify(indexes)]));
  await Promise.all(children.map(({ process }) => once(process, 'message')));

  // When
  const done = children.map(({ process }) => once(process, 'message'));
  children.forEach(({ process }) => process.send('start'));
  await Promise.all(done);
  const exits = await Promise.all(children.map(({ exit }) => exit));

  // Then
  assert.equal(store.get('counter'), 2);
  for (const result of exits) assert.equal(result.code, 0, result.stderr);
});
