import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const { notifyUpdate, refreshUpdateCache } = await import(pathToFileURL(join(cliDirectory, 'dist/cli/updates.js')).href);
const day = 24 * 60 * 60 * 1000;

function fixture(t) {
  const directory = mkdtempSync(join(os.tmpdir(), 'atto-update-test-'));
  const environment = ['XDG_CACHE_HOME', 'LOCALAPPDATA', 'CI', 'NODE_ENV', 'NO_UPDATE_NOTIFIER'];
  const original = Object.fromEntries(environment.map(key => [key, process.env[key]]));
  const tty = [process.stdout, process.stderr].map(stream => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
  const clock = { now: Date.UTC(2026, 8, 5, 12) };
  const output = [];
  const children = [];
  const requests = [];
  const behavior = { spawnFailure: false, fetch: async () => { throw new Error('No network access in update tests.'); } };
  for (const key of environment) delete process.env[key];
  process.env.XDG_CACHE_HOME = join(directory, 'xdg');
  process.env.LOCALAPPDATA = join(directory, 'local');
  for (const stream of [process.stdout, process.stderr]) Object.defineProperty(stream, 'isTTY', { configurable: true, value: true });
  t.mock.method(os, 'homedir', () => directory);
  t.mock.method(Date, 'now', () => clock.now);
  t.mock.method(process.stderr, 'write', chunk => { output.push(String(chunk)); return true; });
  t.mock.method(globalThis, 'fetch', async (...args) => { requests.push(args); return behavior.fetch(...args); });
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    if (behavior.spawnFailure) throw new Error('Synthetic private spawn diagnostic.');
    const child = new EventEmitter();
    let unrefs = 0;
    child.unref = () => { unrefs++; };
    children.push({ command, args, options, child, unrefs: () => unrefs });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const [index, stream] of [process.stdout, process.stderr].entries()) {
      if (tty[index]) Object.defineProperty(stream, 'isTTY', tty[index]);
      else delete stream.isTTY;
    }
    for (const key of environment) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const cacheFile = process.platform === 'win32'
    ? join(directory, 'local', 'atto-cli', 'Cache', 'update.json')
    : process.platform === 'darwin'
      ? join(directory, 'Library', 'Caches', 'atto-cli', 'update.json')
      : join(directory, 'xdg', 'atto-cli', 'update.json');
  return {
    cacheFile, clock, output, children, requests, behavior,
    write(cache) { mkdirSync(dirname(cacheFile), { recursive: true }); writeFileSync(cacheFile, JSON.stringify(cache)); },
    read() { return JSON.parse(readFileSync(cacheFile, 'utf8')); },
  };
}

test('a fresh cached newer stable version prints a pinned update command without spawning or fetching', t => {
  // Given
  const update = fixture(t);
  update.write({ checkedAt: update.clock.now - 1000, latest: '0.10.0' });

  // When
  assert.equal(notifyUpdate('0.2.0'), undefined);

  // Then
  assert.match(update.output.join(''), /npm install --global @attocash\/cli@0\.10\.0/);
  assert.equal(update.children.length, 0);
  assert.equal(update.requests.length, 0);
});

test('a stale cached notice remains available while one detached refresh reserves the next 24 hours', t => {
  // Given
  const update = fixture(t);
  update.write({ checkedAt: update.clock.now - day, latest: '0.10.0' });

  // When
  notifyUpdate('0.2.0');
  notifyUpdate('0.2.0');

  // Then
  assert.match(update.output.join(''), /@attocash\/cli@0\.10\.0/);
  assert.deepEqual(update.read(), { checkedAt: update.clock.now, latest: '0.10.0' });
  assert.equal(update.children.length, 1);
  const worker = update.children[0];
  assert.equal(worker.command, process.execPath);
  assert.deepEqual(worker.args, [join(cliDirectory, 'dist/cli/update-check.js'), update.cacheFile]);
  assert.equal(worker.options.detached, true);
  assert.equal(worker.options.stdio, 'ignore');
  assert.equal(worker.unrefs(), 1);
  assert.equal(update.requests.length, 0);
});

test('an empty cache starts a background check without a notice or network work in the CLI', t => {
  // Given
  const update = fixture(t);

  // When
  notifyUpdate('0.2.0');

  // Then
  assert.deepEqual(update.read(), { checkedAt: update.clock.now });
  assert.equal(update.children.length, 1);
  assert.deepEqual(update.output, []);
  assert.deepEqual(update.requests, []);
});

test('noninteractive streams, CI, tests, and explicit opt-outs suppress every update side effect', t => {
  // Given
  const update = fixture(t);
  const cases = [{ stream: process.stdout }, { stream: process.stderr }, { env: ['CI', 'true'] },
    { env: ['CI', '0'] }, { env: ['NODE_ENV', 'test'] }, { env: ['NO_UPDATE_NOTIFIER', ''] }];

  // When / Then
  for (const option of cases) {
    if (option.stream) Object.defineProperty(option.stream, 'isTTY', { configurable: true, value: false });
    if (option.env) process.env[option.env[0]] = option.env[1];
    notifyUpdate('0.2.0');
    if (option.stream) Object.defineProperty(option.stream, 'isTTY', { configurable: true, value: true });
    if (option.env) delete process.env[option.env[0]];
  }
  assert.equal(existsSync(update.cacheFile), false);
  assert.deepEqual(update.children, []);
  assert.deepEqual(update.requests, []);
  assert.deepEqual(update.output, []);

  // Given / When / Then: CI=false is an explicit interactive exception.
  process.env.CI = 'false';
  notifyUpdate('0.2.0');
  assert.equal(update.children.length, 1);
});

test('equal, older, prerelease, and invalid cached versions never produce update commands', t => {
  // Given
  const update = fixture(t);

  // When
  for (const latest of ['0.2.0', '0.1.9', '1.0.0-beta.1', 'garbage\nprivate output']) {
    update.write({ checkedAt: update.clock.now, latest });
    notifyUpdate('0.2.0');
  }

  // Then
  assert.deepEqual(update.output, []);
  assert.deepEqual(update.children, []);
  assert.deepEqual(update.requests, []);
});

test('the worker fetches only public CLI metadata and preserves the reserved attempt timestamp', async t => {
  // Given
  const update = fixture(t);
  const checkedAt = update.clock.now - 500;
  update.write({ checkedAt, latest: '0.2.0' });
  update.behavior.fetch = async () => Response.json({ name: '@attocash/cli', version: '0.10.0' });

  // When
  await refreshUpdateCache(update.cacheFile);

  // Then
  assert.deepEqual(update.read(), { checkedAt, latest: '0.10.0' });
  assert.equal(update.requests.length, 1);
  const [url, options] = update.requests[0];
  assert.equal(url, 'https://registry.npmjs.org/@attocash%2fcli/latest');
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(update.output, []);
});

test('failed worker attempts retain the known version and wait 24 hours before retrying', async t => {
  // Given
  const update = fixture(t);
  const original = { checkedAt: update.clock.now, latest: '0.1.9' };
  update.write(original);

  // When
  for (const fetch of [async () => new Response(null, { status: 503 }), async () => { throw new Error('Synthetic private network diagnostic.'); }]) {
    update.behavior.fetch = fetch;
    await refreshUpdateCache(update.cacheFile);
    assert.deepEqual(update.read(), original);
  }
  update.clock.now += day - 1;
  notifyUpdate('0.2.0');

  // Then
  assert.deepEqual(update.children, []);
  assert.deepEqual(update.output, []);

  // When / Then: a failed attempt becomes eligible again at the TTL boundary.
  update.clock.now++;
  notifyUpdate('0.2.0');
  assert.equal(update.children.length, 1);
  assert.deepEqual(update.read(), { checkedAt: update.clock.now, latest: '0.1.9' });
});

test('unrelated packages, prereleases, and malformed registry data cannot replace a known version', async t => {
  // Given
  const update = fixture(t);
  const original = { checkedAt: update.clock.now, latest: '0.2.0' };
  update.write(original);

  // When / Then
  for (const metadata of [{ name: '@attocash/mcp', version: '9.0.0' }, { name: '@attocash/cli', version: '9.0.0-beta.1' },
    { name: '@attocash/cli', version: '9.0.0\nprivate output' }, { name: '@attocash/cli', version: 9 }, null]) {
    update.behavior.fetch = async () => Response.json(metadata);
    await refreshUpdateCache(update.cacheFile);
    assert.deepEqual(update.read(), original);
  }
  assert.deepEqual(update.output, []);
});

test('worker spawn exceptions and asynchronous errors remain silent and preserve the attempt TTL', t => {
  // Given
  const update = fixture(t);
  update.behavior.spawnFailure = true;

  // When / Then
  assert.doesNotThrow(() => notifyUpdate('0.2.0'));
  update.behavior.spawnFailure = false;
  notifyUpdate('0.2.0');
  assert.deepEqual(update.children, []);
  update.clock.now += day;
  notifyUpdate('0.2.0');
  assert.equal(update.children.length, 1);
  assert.doesNotThrow(() => update.children[0].child.emit('error', new Error('Synthetic private spawn diagnostic.')));
  assert.deepEqual(update.output, []);
  assert.deepEqual(update.requests, []);
});

test('unwritable cache paths do not interrupt CLI commands or worker cleanup', async t => {
  // Given
  const update = fixture(t);
  mkdirSync(dirname(dirname(update.cacheFile)), { recursive: true });
  writeFileSync(dirname(update.cacheFile), 'Synthetic file blocks cache directory.');

  // When / Then
  assert.doesNotThrow(() => notifyUpdate('0.2.0'));
  await assert.doesNotReject(refreshUpdateCache(update.cacheFile));
  assert.deepEqual(update.output, []);
  assert.deepEqual(update.children, []);
  assert.deepEqual(update.requests, []);
});

test('oversized cache data is ignored and replaced with a fresh background attempt', t => {
  // Given
  const update = fixture(t);
  update.write({ checkedAt: update.clock.now, latest: '9.0.0', padding: 'x'.repeat(4096) });

  // When
  notifyUpdate('0.2.0');

  // Then
  assert.deepEqual(update.output, []);
  assert.deepEqual(update.read(), { checkedAt: update.clock.now });
  assert.equal(update.children.length, 1);
});
