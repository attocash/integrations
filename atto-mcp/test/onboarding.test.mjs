import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify, stripVTControlCharacters } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../../atto-cli/', import.meta.url));
const mcpDirectory = process.env.ATTO_TEST_MCP_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const { AttoApplication } = await import(pathToFileURL(join(cliDirectory, 'dist/application/app.js')).href);
const policy = { perRequest: { amount: '5', unit: 'ATTO' }, rolling: [{ days: 1, amount: '20', unit: 'ATTO' }] };

async function fixture(t, initialized = true) {
  const root = await mkdtemp(join(tmpdir(), 'atto-onboarding-'));
  const directory = join(root, 'wallet');
  t.after(() => rm(root, { recursive: true, force: true }));
  const open = () => new AttoApplication({ directory, secrets: {
    get: async () => { throw new Error('No real credentials may be read.'); },
    set: async () => { throw new Error('No real credentials may be stored.'); },
  } });
  if (initialized) {
    const application = open();
    application.store.set('identity', { address: 'atto_public_fixture', fingerprint: 'a'.repeat(64) });
    application.store.set('addresses', [{ index: 0, address: 'atto_public_fixture', publicKey: 'a'.repeat(64), active: true }]);
    application.ledger.setPolicy(policy);
    await application.close();
  }
  return { root, directory, open };
}

async function terminalRun(f, args, steps, options = {}) {
  const main = options.cli ? join(cliDirectory, 'dist/cli/main.js') : join(mcpDirectory, 'dist/main.js');
  const harness = `
    process.env.KOTLIN_LOGGING_STARTUP_MESSAGE = 'false';
    console.log = console.info = console.debug = console.error.bind(console);
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    Object.defineProperty(process.stderr, 'isTTY', { value: true });
    process.stdin.setRawMode = value => { process.stdin.isRaw = value; return process.stdin; };
    const { OsSecretStore } = await import(process.env.ATTO_TEST_SECRETS_MODULE);
    let phrase = null;
    OsSecretStore.prototype.get = async () => phrase;
    OsSecretStore.prototype.set = async value => {
      if (process.env.ATTO_TEST_STORE_FAILURE === '1') throw new Error('Synthetic password-store failure');
      phrase = value;
    };
    process.argv = [process.execPath, 'atto', ...JSON.parse(process.env.ATTO_TEST_ARGUMENTS)];
    await import(process.env.ATTO_TEST_MAIN);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', harness], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1', XDG_DATA_HOME: join(f.root, 'data'),
      ATTO_TEST_SECRETS_MODULE: pathToFileURL(join(cliDirectory, 'dist/storage/secrets.js')).href,
      ATTO_TEST_MAIN: pathToFileURL(main).href,
      ATTO_TEST_ARGUMENTS: JSON.stringify(['--data-dir', f.directory, ...args]),
      ATTO_TEST_STORE_FAILURE: options.storeFailure ? '1' : '0' },
  });
  let stdout = '';
  let stderr = '';
  let remaining = '';
  let index = 0;
  let answering = false;
  let stepError;
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => {
    stderr += value;
    remaining += stripVTControlCharacters(value.toString());
    const step = steps[index];
    if (!step || answering || !remaining.includes(step.prompt)) return;
    answering = true;
    remaining = '';
    Promise.resolve(step.beforeAnswer?.()).then(() => {
      index++;
      answering = false;
      child.stdin.write(step.raw ? step.answer : `${step.answer}\n`);
    }).catch(error => { stepError = error; child.kill(); });
  });
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Terminal test timed out: ${stripVTControlCharacters(stderr)}`)); }, 15_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr: stripVTControlCharacters(stderr) }); });
  });
  if (stepError) throw stepError;
  assert.equal(index, steps.length, result.stderr);
  return result;
}

test('Setup and approvals require a terminal before opening a profile', async t => {
  // Given
  const f = await fixture(t, false);
  const main = join(mcpDirectory, 'dist/main.js');

  for (const args of [['setup'], ['limits', 'approve', 'proposal'], ['limits', 'reject', 'proposal']]) {
    // When
    await assert.rejects(execute(process.execPath, [main, '--data-dir', f.directory, ...args]), error => {
      // Then
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /interactive terminal/);
      return true;
    });
  }
  await assert.rejects(readdir(f.directory), { code: 'ENOENT' });
  await assert.rejects(execute(process.execPath, [main, '--data-dir', f.directory, 'setup', '--yes']), error => {
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /Unknown option/);
    return true;
  });
});

test('Read-only setup preserves shared CLI limits and emits public config using the latest release', async t => {
  // Given
  const f = await fixture(t);

  // When
  const result = await terminalRun(f, ['setup'], [
    { prompt: 'Existing CLI wallet: ', answer: '2' },
    { prompt: 'Configure account pool: ', answer: '' },
    { prompt: 'Bounded spending: ', answer: '' },
    { prompt: 'Type yes to approve this exact proposal: ', answer: 'yes' },
  ]);

  // Then
  assert.equal(result.code, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.deepEqual(config.mcpServers.atto, { command: 'npx', args: ['--yes', '@attocash/mcp@latest', '--data-dir', f.directory] });
  assert.match(result.stderr, /shares funds, payment history, and spending limits/);
  assert.match(result.stderr, /Wallet: "atto_public_fixture"/);
  assert.match(result.stderr, /MCP access: \[1\] Read-only \(default\)/);
  assert.match(result.stderr, /Current limits: Per payment: 5 ATTO; rolling: 20 ATTO \/ 1 day/);
  assert.match(result.stderr, /Requested limits: Per payment: 5 ATTO; rolling: 20 ATTO \/ 1 day/);
  assert.match(result.stderr, /Current pool: indexes 0; consolidation disabled/);
  assert.match(result.stderr, /Requested pool: indexes 0; consolidation disabled/);
  assert.match(result.stderr, /Expires: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  assert.doesNotMatch(result.stderr, /baseRevision|walletFingerprint/);
  assert.doesNotMatch(result.stdout + result.stderr, /Recovery phrase \(keep/);
  const application = f.open();
  try {
    const usage = await application.call('limits_get');
    assert.deepEqual(usage.policy, policy);
    assert.equal(usage.mcpAccess, 'read-only');
    assert.equal(usage.proposal.status, 'approved');
  } finally { await application.close(); }
});

test('Bounded setup requires concrete payment and rolling limits before approval', async t => {
  // Given
  const f = await fixture(t);

  // When
  const result = await terminalRun(f, ['setup'], [
    { prompt: 'Existing CLI wallet: ', answer: '' },
    { prompt: 'Configure account pool: ', answer: '' },
    { prompt: 'Bounded spending: ', answer: '2' },
    { prompt: 'Maximum ATTO per payment: ', answer: '2.5' },
    { prompt: 'Maximum ATTO across a rolling 24 hours: ', answer: '10' },
    { prompt: 'Type yes to approve this exact proposal: ', answer: 'yes' },
  ]);

  // Then
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /MCP access: read-only → spend/);
  assert.match(result.stderr, /Requested limits: Per payment: 2\.5 ATTO; rolling: 10 ATTO \/ 1 day/);
  const application = f.open();
  try {
    const usage = await application.call('limits_get');
    assert.equal(usage.mcpAccess, 'spend');
    assert.deepEqual(usage.policy, { perRequest: { amount: '2.5', unit: 'ATTO' }, rolling: [{ days: 1, amount: '10', unit: 'ATTO' }] });
  } finally { await application.close(); }
});

test('Declining approval and Ctrl+C preserve the existing policy', async t => {
  // Given
  const f = await fixture(t);

  for (const response of [{ answer: 'no' }, { answer: '\u0003', raw: true }]) {
    // When
    const result = await terminalRun(f, ['setup'], [
      { prompt: 'Existing CLI wallet: ', answer: '2' },
      { prompt: 'Configure account pool: ', answer: '' },
      { prompt: 'Bounded spending: ', answer: '2' },
      { prompt: 'Maximum ATTO per payment: ', answer: '1' },
      { prompt: 'Maximum ATTO across a rolling 24 hours: ', answer: '2' },
      { prompt: 'Type yes to approve this exact proposal: ', ...response },
    ]);

    // Then
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /No approval was granted|cancelled/i);
    const application = f.open();
    try {
      const usage = await application.call('limits_get');
      assert.deepEqual(usage.policy, policy);
      assert.equal(usage.mcpAccess, 'read-only');
    } finally { await application.close(); }
  }
});

test('Approval cannot apply a replacement proposed while the user reviews', async t => {
  // Given
  const f = await fixture(t);
  const application = f.open();
  const { proposal } = await application.call('limits_propose', { policy, access: 'spend' });
  await application.close();

  // When
  const result = await terminalRun(f, ['limits', 'approve', proposal.id], [{
    prompt: 'Type yes to approve this exact proposal: ', answer: 'yes',
    beforeAnswer: async () => {
      const other = f.open();
      try { await other.call('limits_propose', { policy: { perRequest: null, rolling: [] }, access: 'spend' }); }
      finally { await other.close(); }
    },
  }]);

  // Then
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /proposal is unavailable or was replaced/);
  const reopened = f.open();
  try {
    const usage = await reopened.call('limits_get');
    assert.deepEqual(usage.policy, policy);
    assert.equal(usage.mcpAccess, 'read-only');
  } finally { await reopened.close(); }
});

test('New-wallet setup displays recovery only after password storage succeeds', async t => {
  // Given
  const f = await fixture(t, false);

  // When
  const result = await terminalRun(f, ['setup'], [
    { prompt: 'Existing CLI wallet: ', answer: '' },
    { prompt: 'Import a recovery phrase: ', answer: '' },
    { prompt: 'Type yes to store this wallet in the OS password store: ', answer: 'yes' },
    { prompt: 'Configure account pool: ', answer: '' },
    { prompt: 'Bounded spending: ', answer: '' },
    { prompt: 'Type yes to approve this exact proposal: ', answer: 'yes' },
  ]);

  // Then
  assert.equal(result.code, 0, result.stderr);
  const phrase = result.stderr.match(/Recovery phrase \(keep a private offline copy\):\n([^\n]+)/)?.[1];
  assert.equal(phrase?.split(' ').length, 24);
  assert.ok(JSON.parse(result.stdout).mcpServers.atto);
  assert.equal(result.stdout.includes(phrase), false);
  for (const file of await readdir(f.directory)) assert.equal((await readFile(join(f.directory, file))).includes(Buffer.from(phrase)), false);
});

test('Password-store failure never displays a generated recovery phrase', async t => {
  // Given
  const f = await fixture(t, false);

  // When
  const result = await terminalRun(f, ['setup'], [
    { prompt: 'Existing CLI wallet: ', answer: '' },
    { prompt: 'Import a recovery phrase: ', answer: '' },
    { prompt: 'Type yes to store this wallet in the OS password store: ', answer: 'yes' },
  ], { storeFailure: true });

  // Then
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /Recovery phrase \(keep|Synthetic password-store failure/);
});

test('Setup imports recovery through hidden input without echoing or persisting it', async t => {
  // Given
  const f = await fixture(t, false);
  const phrase = `${'abandon '.repeat(23)}art`;

  // When
  const result = await terminalRun(f, ['setup'], [
    { prompt: 'Existing CLI wallet: ', answer: '' },
    { prompt: 'Import a recovery phrase: ', answer: '2' },
    { prompt: 'Type yes to store this wallet in the OS password store: ', answer: 'yes' },
    { prompt: 'Recovery phrase (hidden): ', answer: phrase },
    { prompt: 'Configure account pool: ', answer: '' },
    { prompt: 'Bounded spending: ', answer: '' },
    { prompt: 'Type yes to approve this exact proposal: ', answer: 'yes' },
  ]);

  // Then
  assert.equal(result.code, 0, result.stderr);
  assert.equal((result.stdout + result.stderr).includes(phrase), false);
  assert.ok(JSON.parse(result.stdout).mcpServers.atto);
  for (const file of await readdir(f.directory)) assert.equal((await readFile(join(f.directory, file))).includes(Buffer.from(phrase)), false);
});

test('Local rejection leaves spending and MCP access unchanged', async t => {
  // Given
  const f = await fixture(t);
  const application = f.open();
  const { proposal } = await application.call('limits_propose', { policy: { perRequest: null, rolling: [] }, access: 'spend' });
  await application.close();

  // When
  const result = await terminalRun(f, ['--json', 'limits', 'reject', proposal.id], [
    { prompt: 'Type yes to reject this exact proposal: ', answer: 'yes' },
  ]);

  // Then
  assert.equal(result.code, 0, result.stderr);
  const usage = JSON.parse(result.stdout).result;
  assert.deepEqual(usage.policy, policy);
  assert.equal(usage.mcpAccess, 'read-only');
  assert.equal(usage.proposal.status, 'rejected');
  assert.match(result.stderr, /Requested limits: Per payment: Unlimited; rolling: Unlimited/);
  assert.doesNotMatch(result.stderr, /baseRevision|walletFingerprint/);
});

test('Local CLI limits set uses terminal approval and preserves MCP access', async t => {
  // Given
  const f = await fixture(t);
  const next = { perRequest: { amount: '3', unit: 'ATTO' }, rolling: [] };

  // When
  const result = await terminalRun(f, ['--json', 'limits', 'set', '--input', JSON.stringify(next)], [
    { prompt: 'Type yes to approve this exact proposal: ', answer: 'yes' },
  ], { cli: true });

  // Then
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).result.policy, next);
  assert.equal(JSON.parse(result.stdout).result.mcpAccess, 'read-only');
});

test('Setup includes account indexes and consolidation in local approval', async t => {
  // Given
  const f = await fixture(t, false);

  // When
  const result = await terminalRun(f, ['setup'], [
    { prompt: 'Existing CLI wallet: ', answer: '' },
    { prompt: 'Import a recovery phrase: ', answer: '' },
    { prompt: 'Type yes to store this wallet in the OS password store: ', answer: 'yes' },
    { prompt: 'Configure account pool: ', answer: '2' },
    { prompt: 'Account indexes, separated by commas [0]: ', answer: '0,1' },
    { prompt: 'Consolidation: [1] Disabled (default), [2] Enabled: ', answer: '2' },
    { prompt: 'Bounded spending: ', answer: '' },
    { prompt: 'Type yes to approve this exact proposal: ', answer: 'yes' },
  ]);

  // Then
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Current pool: indexes 0; consolidation disabled/);
  assert.match(result.stderr, /Requested pool: indexes 0, 1; consolidation enabled/);
  const application = f.open();
  try {
    const usage = await application.call('limits_get');
    assert.deepEqual(usage.pool, { indexes: [0, 1], consolidate: true });
    assert.equal(usage.mcpAccess, 'read-only');
    const addresses = (await application.call('address_list')).addresses;
    assert.equal(addresses.find(address => address.index === 1).active, false);
  } finally { await application.close(); }
});

test('CLI pool configuration preserves limits and requires exact local approval', async t => {
  // Given
  const f = await fixture(t);

  // When
  const result = await terminalRun(f, ['--json', 'pool', 'configure', '--indexes', '0', '--consolidate'], [
    { prompt: 'Type yes to approve this exact proposal: ', answer: 'yes' },
  ], { cli: true });

  // Then
  assert.equal(result.code, 0, result.stderr);
  const usage = JSON.parse(result.stdout).result;
  assert.deepEqual(usage.policy, policy);
  assert.equal(usage.mcpAccess, 'read-only');
  assert.deepEqual(usage.pool, { indexes: [0], consolidate: true });
  assert.match(result.stderr, /Requested pool: indexes 0; consolidation enabled/);
});

test('Friendly CLI limit flags preserve omitted rules and pool toggles preserve membership', async t => {
  // Given an existing daily limit plus a separate weekly budget.
  const f = await fixture(t);
  const weekly = { days: 7, amount: '100', unit: 'ATTO' };
  const original = { ...policy, rolling: [...policy.rolling, weekly] };
  const application = f.open();
  application.ledger.setPolicy(original);
  await application.close();
  const approve = args => terminalRun(f, ['--json', ...args], [
    { prompt: 'Type yes to approve this exact proposal: ', answer: 'yes' },
  ], { cli: true });

  // When only one limit is edited at a time and consolidation is toggled independently.
  const perPayment = await approve(['limits', 'set', '--per-payment', '3']);
  assert.equal(perPayment.code, 0, perPayment.stderr);
  assert.deepEqual(JSON.parse(perPayment.stdout).result.policy, { perRequest: { amount: '3', unit: 'ATTO' }, rolling: original.rolling });
  const daily = await approve(['limits', 'set', '--daily', '500', '--unit', 'RAW']);
  assert.equal(daily.code, 0, daily.stderr);
  assert.deepEqual(JSON.parse(daily.stdout).result.policy, { perRequest: { amount: '3', unit: 'ATTO' }, rolling: [weekly, { days: 1, amount: '500', unit: 'RAW' }] });
  for (const [flags, consolidate] of [[['--consolidate'], true], [['--indexes', '0'], true], [['--no-consolidate'], false]]) {
    const pool = await approve(['pool', 'configure', ...flags]);
    assert.equal(pool.code, 0, pool.stderr);
    const result = JSON.parse(pool.stdout).result;
    assert.deepEqual(result.pool, { indexes: [0], consolidate });
    assert.deepEqual(result.policy, JSON.parse(daily.stdout).result.policy);
    assert.equal(result.mcpAccess, 'read-only');
  }
});

test('MCP terminal approval is human by default and terminal JSON errors remain explicit', async t => {
  // Given a pending proposal in an isolated wallet.
  const f = await fixture(t);
  const application = f.open();
  const { proposal } = await application.call('limits_propose', { policy, access: 'read-only' });
  await application.close();

  // When the local terminal approves it without --json.
  const result = await terminalRun(f, ['limits', 'approve', proposal.id], [
    { prompt: 'Type yes to approve this exact proposal: ', answer: 'yes' },
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Status: approved/);
  assert.doesNotMatch(result.stdout, /"result"\s*:/);

  // Then noninteractive JSON clients get a single structured failure and cannot approve.
  await assert.rejects(execute(process.execPath, [join(mcpDirectory, 'dist/main.js'), '--json', '--data-dir', f.directory, 'limits', 'approve', proposal.id]), error => {
    assert.equal(JSON.parse(error.stdout).error.code, 'TERMINAL_REQUIRED');
    assert.equal(error.stderr, '');
    return true;
  });
});

test('MCP parser help is local to the failing command and server startup never prints nonprotocol JSON', async t => {
  // Given invalid terminal input, including a token that must never be echoed.
  const f = await fixture(t, false);
  const main = join(mcpDirectory, 'dist/main.js');
  for (const [args, usage] of [[['limits'], 'limits'], [['limits', 'approve'], 'limits approve'], [['setup', '--private-input'], 'setup']]) {
    await assert.rejects(execute(process.execPath, [main, '--data-dir', f.directory, ...args]), error => {
      assert.equal(error.stdout, '');
      assert.match(error.stderr, new RegExp(`Usage: atto-mcp ${usage}`));
      assert.doesNotMatch(error.stderr, /private-input/);
      return true;
    });
  }
  // When server initialization fails even with the terminal-only --json option.
  const file = join(f.root, 'not-a-directory');
  await writeFile(file, 'synthetic fixture');
  await assert.rejects(execute(process.execPath, [main, '--json', '--data-dir', file]), error => {
    // Then stdout stays reserved for JSON-RPC.
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /Error:/);
    return true;
  });
});
