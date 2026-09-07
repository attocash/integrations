import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import test from 'node:test';

const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const moduleUrl = path => pathToFileURL(join(cliDirectory, 'dist', path)).href;
const { AttoApplication } = await import(moduleUrl('application/app.js'));
const { createApplication, operations } = await import(moduleUrl('core.js'));
const identity = { address: 'atto_public_lifecycle_fixture', fingerprint: 'a'.repeat(64) };

async function fixture(t, initialized = true) {
  const root = await mkdtemp(join(tmpdir(), 'atto-wallet-lifecycle-'));
  const directory = join(root, 'profile');
  t.after(() => rm(root, { recursive: true, force: true }));
  const open = () => new AttoApplication({ directory, secrets: {
    get: async () => { throw new Error('Real credentials are forbidden in this fixture.'); },
    set: async () => { throw new Error('Real credentials are forbidden in this fixture.'); },
    remove: async () => { throw new Error('Real credentials are forbidden in this fixture.'); },
  } });
  if (initialized) {
    const app = open();
    app.store.set('identity', identity);
    app.store.set('addresses', [{ index: 0, address: identity.address, publicKey: 'a'.repeat(64), active: true }]);
    await app.close();
  }
  return { root, directory, open, initialized };
}

async function run(f, args, steps = [], terminal = true) {
  const tracePath = join(f.root, 'trace.json');
  const harness = `
    import os from 'node:os';
    import { writeFile } from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    os.homedir = () => process.env.ATTO_TEST_USER_DIRECTORY;
    syncBuiltinESMExports();
    process.env.KOTLIN_LOGGING_STARTUP_MESSAGE = 'false';
    console.log = console.info = console.debug = console.error.bind(console);
    Object.defineProperty(process.stdin, 'isTTY', { value: process.env.ATTO_TEST_TERMINAL === '1' });
    Object.defineProperty(process.stderr, 'isTTY', { value: process.env.ATTO_TEST_TERMINAL === '1' });
    process.stdin.isRaw = false;
    const trace = { reads: 0, writes: 0, removals: 0, resets: 0, rawModes: [] };
    // A real TTY releases its read handle when paused; this simulated terminal
    // uses a pipe, so mirror that handle lifecycle without closing stdin.
    process.stdin.on('resume', () => process.stdin.ref?.());
    process.stdin.on('pause', () => process.stdin.unref?.());
    process.stdin.setRawMode = value => { trace.rawModes.push(Boolean(value)); process.stdin.isRaw = value; return process.stdin; };
    const { OsSecretStore } = await import(process.env.ATTO_TEST_SECRETS_MODULE);
    let credential = process.env.ATTO_TEST_INITIALIZED === '1' ? 'synthetic-reset-credential' : null;
    OsSecretStore.prototype.get = async () => { trace.reads++; return credential; };
    OsSecretStore.prototype.set = async value => { trace.writes++; credential = value; };
    OsSecretStore.prototype.remove = async () => { trace.removals++; credential = null; };
    const { AttoApplication } = await import(process.env.ATTO_TEST_APP_MODULE);
    const reset = AttoApplication.prototype.resetWallet;
    AttoApplication.prototype.resetWallet = async function(fingerprint) {
      trace.resets++; trace.fingerprint = fingerprint;
      return reset.call(this, fingerprint);
    };
    process.argv = [process.execPath, 'atto', ...JSON.parse(process.env.ATTO_TEST_ARGUMENTS)];
    trace.flowingBeforeImport = process.stdin.readableFlowing;
    await import(process.env.ATTO_TEST_MAIN);
    trace.rawAfter = Boolean(process.stdin.isRaw);
    trace.flowingAfterImport = process.stdin.readableFlowing;
    trace.hasCredential = credential !== null;
    await writeFile(process.env.ATTO_TEST_TRACE, JSON.stringify(trace));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', harness], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1',
      XDG_DATA_HOME: join(f.root, 'data'), XDG_CACHE_HOME: join(f.root, 'cache'), LOCALAPPDATA: join(f.root, 'local'),
      ATTO_TEST_USER_DIRECTORY: f.root, ATTO_TEST_TERMINAL: terminal ? '1' : '0',
      ATTO_TEST_INITIALIZED: f.initialized ? '1' : '0', ATTO_TEST_TRACE: tracePath,
      ATTO_TEST_SECRETS_MODULE: moduleUrl('storage/secrets.js'), ATTO_TEST_APP_MODULE: moduleUrl('application/app.js'),
      ATTO_TEST_MAIN: moduleUrl('cli/main.js'), ATTO_TEST_ARGUMENTS: JSON.stringify(['--data-dir', f.directory, ...args]) },
  });
  let stdout = '';
  let stderr = '';
  let pending = '';
  let index = 0;
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => {
    stderr += value;
    pending += stripVTControlCharacters(value.toString());
    const step = steps[index];
    if (!step || !pending.includes(step.prompt)) return;
    pending = '';
    index++;
    child.stdin.write(step.raw ? step.answer : `${step.answer}\n`);
  });
  // Keep stdin open: one Ctrl+C must restore input state and let the CLI exit by itself.
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(async () => {
      const trace = await readFile(tracePath, 'utf8').catch(() => 'unavailable');
      child.kill();
      reject(new Error(`CLI did not exit after its terminal response: ${stripVTControlCharacters(stderr)}\nInput trace: ${trace}`));
    }, 10_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr: stripVTControlCharacters(stderr) }); });
  });
  assert.equal(index, steps.length, result.stderr);
  return { ...result, trace: JSON.parse(await readFile(tracePath, 'utf8')) };
}

async function status(f) {
  const app = f.open();
  try { return await app.call('wallet_status'); }
  finally { await app.close(); }
}

function noCredentialChanges(result) {
  assert.equal(result.trace.writes, 0);
  assert.equal(result.trace.removals, 0);
  assert.equal(result.trace.resets, 0);
}

test('Successful import displays its address by default and preserves full JSON on request', async t => {
  // Given a valid synthetic recovery phrase and a fresh profile for each output mode.
  const phrase = `${'abandon '.repeat(23)}art`;
  for (const json of [false, true]) {
    const f = await fixture(t, false);

    // When the phrase is entered only through the hidden terminal prompt.
    const result = await run(f, [...(json ? ['--json'] : []), 'wallet', 'import'], [
      { prompt: 'Recovery phrase (hidden): ', answer: phrase },
    ]);
    const stored = await status(f);

    // Then public success output follows the selected mode and recovery material stays out of output.
    assert.equal(result.code, 0, result.stderr);
    assert.equal(stored.initialized, true);
    assert.equal(result.trace.writes, 1);
    assert.equal(result.trace.hasCredential, true);
    assert.equal(result.trace.rawAfter, false);
    assert.equal((result.stdout + result.stderr).includes(phrase), false);
    if (json) {
      const payload = JSON.parse(result.stdout).result;
      assert.deepEqual(payload.identity, stored.identity);
      assert.deepEqual(payload.addresses, stored.addresses);
    } else {
      assert.equal(result.stdout, `Wallet imported.\nAddress: ${stored.identity.address}\n`);
    }
  }
});

test('Successful creation displays its address and keeps recovery on the terminal', async t => {
  // Given an empty temporary profile and a synthetic in-memory password store in each output mode.
  for (const json of [false, true]) {
    const f = await fixture(t, false);

    // When the real CLI creates and stores a wallet before displaying recovery.
    const result = await run(f, [...(json ? ['--json'] : []), 'wallet', 'create']);
    const stored = await status(f);
    const phrase = result.stderr.match(/Recovery phrase \(keep a private offline copy\):\n([^\n]+)/)?.[1];

    // Then only the terminal receives recovery words; normal stdout is concise and JSON retains public metadata.
    assert.equal(result.code, 0, result.stderr);
    assert.equal(stored.initialized, true);
    assert.equal(result.trace.writes, 1);
    assert.equal(result.trace.hasCredential, true);
    assert.equal(phrase?.split(' ').length, 24);
    assert.equal(result.stdout.includes(phrase), false);
    if (json) {
      const payload = JSON.parse(result.stdout).result;
      assert.deepEqual(payload.identity, stored.identity);
      assert.deepEqual(payload.addresses, stored.addresses);
    } else {
      assert.equal(result.stdout, `Wallet created.\nAddress: ${stored.identity.address}\n`);
    }
  }
});

test('Import rejects an initialized wallet before prompting or reading credentials', async t => {
  // Given an initialized public profile and an instrumented synthetic password store.
  const f = await fixture(t);

  for (const json of [false, true]) {
    // When import is requested in either output mode.
    const result = await run(f, [...(json ? ['--json'] : []), 'wallet', 'import']);

    // Then the existing wallet error explains reset or another directory without requesting secrets.
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr, /Recovery phrase \(hidden\):/);
    assert.equal(result.trace.reads, 0);
    assert.deepEqual(result.trace.rawModes, []);
    noCredentialChanges(result);
    if (json) {
      assert.equal(JSON.parse(result.stdout).error.code, 'WALLET_EXISTS');
      assert.equal(result.stderr, '');
    } else {
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /already initialized/i);
      assert.match(result.stderr, /wallet reset/);
      assert.match(result.stderr, /--data-dir/);
      assert.doesNotMatch(result.stderr, /"error"\s*:/);
    }
    assert.deepEqual((await status(f)).identity, identity);
  }
});

test('One Ctrl+C cancels hidden import and exits with restored input state', async t => {
  // Given an uninitialized profile and hidden synthetic partial input.
  const f = await fixture(t, false);
  const partial = 'synthetic-private-partial-input';

  for (const json of [false, true]) {
    // When exactly one raw Ctrl+C follows the partial input while stdin remains open.
    const result = await run(f, [...(json ? ['--json'] : []), 'wallet', 'import'], [
      { prompt: 'Recovery phrase (hidden): ', answer: `${partial}\u0003`, raw: true },
    ]);

    // Then cancellation exits once without echoing input or touching the password store.
    assert.equal(result.code, 1);
    assert.equal((result.stdout + result.stderr).includes(partial), false);
    assert.equal(result.trace.reads, 0);
    assert.equal(result.trace.rawAfter, false);
    assert.equal(result.trace.flowingAfterImport, false);
    assert.deepEqual(result.trace.rawModes, [true, false]);
    noCredentialChanges(result);
    if (json) {
      assert.equal(result.stdout.trim().split('\n').length, 1);
      assert.equal(JSON.parse(result.stdout).error.code, 'CANCELLED');
      assert.doesNotMatch(result.stderr, /CANCELLED|Wallet import cancelled/);
    } else {
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Wallet import cancelled\./);
      assert.doesNotMatch(result.stderr, /"error"\s*:/);
    }
    assert.equal((await status(f)).initialized, false);
  }
});

test('Import reports an unfinished reset before prompting for recovery material', async t => {
  // Given the durable marker left when password-store cleanup is interrupted.
  const f = await fixture(t);
  const app = f.open();
  app.store.set('wallet.reset', { startedAt: new Date().toISOString() });
  await app.close();

  for (const json of [false, true]) {
    // When import is attempted before that reset has finished.
    const result = await run(f, [...(json ? ['--json'] : []), 'wallet', 'import']);

    // Then the reset-specific preflight wins without a hidden prompt or credential lookup.
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr, /Recovery phrase \(hidden\):/);
    assert.equal(result.trace.reads, 0);
    noCredentialChanges(result);
    if (json) {
      assert.equal(JSON.parse(result.stdout).error.code, 'WALLET_RESET_REQUIRED');
      assert.equal(result.stderr, '');
    } else {
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /reset is unfinished/i);
      assert.match(result.stderr, /wallet reset/);
    }
    assert.equal((await status(f)).resetPending, true);
  }
});

test('Import and reset reject nonterminal use before opening a profile', async t => {
  // Given a profile path that does not exist and no interactive terminal.
  const f = await fixture(t, false);

  for (const command of ['import', 'reset']) for (const json of [false, true]) {
    // When a terminal-only operation is requested through pipes.
    const result = await run(f, [...(json ? ['--json'] : []), 'wallet', command], [], false);

    // Then it fails before prompts, credential access, or public profile creation.
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr, /Recovery phrase \(hidden\):|Type reset to delete/);
    assert.equal(result.trace.reads, 0);
    noCredentialChanges(result);
    if (json) {
      assert.equal(JSON.parse(result.stdout).error.code, 'TERMINAL_REQUIRED');
      assert.equal(result.stderr, '');
    } else {
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /interactive terminal/i);
    }
    await assert.rejects(readdir(f.directory), { code: 'ENOENT' });
  }
});

test('Reset has no yes or force bypass and requires the exact confirmation', async t => {
  // Given an initialized wallet with public state and a synthetic stored credential.
  const f = await fixture(t);
  const declines = [{ answer: 'no' }, { answer: 'yes' }, { answer: 'RESET', json: true }, { answer: '\u0003', raw: true }];

  for (const choice of declines) {
    // When confirmation is declined or interrupted once.
    const result = await run(f, [...(choice.json ? ['--json'] : []), 'wallet', 'reset'], [
      { prompt: 'Type reset to delete this local wallet: ', ...choice },
    ]);

    // Then reset never reaches its destructive application method or credential store.
    assert.equal(result.code, 1);
    assert.equal(result.trace.reads, 0);
    noCredentialChanges(result);
    if (choice.json) assert.equal(JSON.parse(result.stdout).error.code, 'CANCELLED');
    else { assert.equal(result.stdout, ''); assert.match(result.stderr, /cancelled/i); }
    assert.deepEqual((await status(f)).identity, identity);
  }
  for (const option of ['--yes', '--force']) {
    // When a caller attempts a noninteractive approval flag.
    const result = await run(f, ['wallet', 'reset', option]);

    // Then argument validation rejects the unsupported flag before confirmation.
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /Type reset to delete/);
    noCredentialChanges(result);
    assert.deepEqual((await status(f)).identity, identity);
  }
});

test('Confirmed reset displays loss warnings and binds deletion to the reviewed wallet', async t => {
  // Given a fresh synthetic initialized profile for each output mode.
  for (const json of [false, true]) {
    const f = await fixture(t);

    // When the user reviews the profile and types the exact reset confirmation.
    const result = await run(f, [...(json ? ['--json'] : []), 'wallet', 'reset'], [
      { prompt: 'Type reset to delete this local wallet: ', answer: 'reset' },
    ]);

    // Then one credential removal resets only the reviewed identity and uses the requested output mode.
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Profile:/);
    assert.ok(result.stderr.includes(JSON.stringify(f.directory)));
    assert.ok(result.stderr.includes(identity.address));
    assert.match(result.stderr, /Network: "LIVE"/);
    assert.match(result.stderr, /removes the recovery phrase from the OS password store/i);
    assert.match(result.stderr, /payment journal, spending limits, and access permissions/i);
    assert.match(result.stderr, /Stop other sessions using this wallet before resetting/);
    assert.doesNotMatch(result.stderr, /MCP/);
    assert.match(result.stderr, /offline backup.*recover any funds/i);
    assert.equal(result.trace.resets, 1);
    assert.equal(result.trace.fingerprint, identity.fingerprint);
    assert.equal(result.trace.removals, 1);
    assert.equal(result.trace.writes, 0);
    assert.equal(result.trace.hasCredential, false);
    if (json) assert.deepEqual(JSON.parse(result.stdout), { result: { reset: true } });
    else { assert.equal(result.stdout, ''); assert.match(result.stderr, /Local wallet reset\./); }
    const reopened = await status(f);
    assert.equal(reopened.initialized, false);
    assert.equal(reopened.mcpAccess, 'read-only');
    assert.deepEqual(reopened.addresses, []);
  }
});

test('The core facade and MCP operation registry expose no wallet reset capability', async t => {
  // Given an isolated MCP-restricted public application session.
  const f = await fixture(t, false);
  const session = createApplication({ directory: f.directory, access: 'mcp' });
  try {
    // When a client inspects or attempts to invoke local reset methods through the shared API.
    assert.equal(operations.some(operation => /reset/i.test(operation.name)), false);
    for (const name of ['reviewWalletReset', 'resetWallet', 'wallet_reset']) {
      assert.equal(name in session, false);
      await assert.rejects(session.call(name), { code: 'UNKNOWN_OPERATION' });
    }

    // Then the facade remains limited to ordinary calls and its own lifecycle.
    assert.deepEqual(Object.keys(session).sort(), ['call', 'close', 'start']);
    assert.equal((await session.call('wallet_status')).initialized, false);
  } finally { await session.close(); }
});
