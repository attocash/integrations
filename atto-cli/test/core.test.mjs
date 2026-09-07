import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const { createApplication, operations, errorResult } = await import(pathToFileURL(join(cliDirectory, 'dist/core.js')).href);

async function profile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'atto-core-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('public session owns its lifecycle and exposes no recovery or storage access', async t => {
  // Given
  const session = createApplication({ directory: await profile(t) });
  t.after(() => session.close());

  // When
  await session.start();
  const status = await session.call('wallet_status');
  await session.close();

  // Then
  assert.deepEqual(Object.keys(session).sort(), ['call', 'close', 'start']);
  for (const name of ['createWallet', 'backupMnemonic', 'store', 'ledger', 'secrets']) assert.equal(name in session, false);
  assert.equal(status.initialized, false);
  assert.equal(operations.length, 36);
  await assert.rejects(session.call('wallet_status'), { code: 'SESSION_CLOSED' });
  assert.deepEqual(errorResult(new Error('private dependency details')), {
    code: 'OPERATION_FAILED', message: 'The operation failed. Check wallet status and endpoint availability.',
  });
});

test('package core export imports without parsing CLI arguments or changing process output', async () => {
  // Given
  const source = `
    import assert from 'node:assert/strict';
    const output = [console.log, console.info, console.debug, process.stdout.write, process.exit];
    process.argv = [process.execPath, 'unused', '--not-a-real-CLI-option'];
    const core = await import('@attocash/cli/core');
    assert.deepEqual([console.log, console.info, console.debug, process.stdout.write, process.exit], output);
    process.stdout.write(JSON.stringify(Object.keys(core).sort()));
  `;

  // When
  const result = await execute(process.execPath, ['--input-type=module', '-e', source], { cwd: cliDirectory });

  // Then
  assert.deepEqual(JSON.parse(result.stdout), ['createApplication', 'errorResult', 'operations', 'runDoctor']);
  assert.equal(result.stderr, '');
});

test('pre-split profile reopens with the same identity, terms, limits and pending-send journal', async t => {
  // Given: these exact public rows were captured from the pre-split application.
  const directory = await profile(t);
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pre-split-profile.json', import.meta.url), 'utf8'));
  const database = new DatabaseSync(join(directory, 'state.sqlite'));
  database.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version = 1;');
  for (const { key, value } of fixture.rows) database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
  database.close();
  const original = Object.fromEntries(fixture.rows.map(({ key, value }) => [key, JSON.parse(value)]));
  const session = createApplication({ directory });
  t.after(() => session.close());

  // When
  const status = await session.call('wallet_status');
  const terms = await session.call('terms_get');
  const limits = await session.call('limits_get');
  await session.close();

  // Then
  assert.deepEqual(status.identity, original.identity);
  assert.deepEqual(status.addresses, original.addresses);
  assert.deepEqual(status.settings, original.settings);
  assert.deepEqual(status.pendingSends, original['spending.records'].map(({ id, hash, status }) => ({ requestId: id, hash, status })));
  assert.equal(terms.version, original['market.terms'].version);
  assert.equal(terms.accepted, true);
  assert.deepEqual(limits.policy, original['spending.policy']);
  assert.equal(limits.rolling[0].usedRaw, '10');
  const reopened = new DatabaseSync(join(directory, 'state.sqlite'));
  try {
    assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, fixture.userVersion);
    const rows = reopened.prepare('SELECT key, value FROM settings ORDER BY key').all();
    assert.deepEqual(rows.map(row => ({ ...row })), fixture.rows);
  } finally { reopened.close(); }
});
