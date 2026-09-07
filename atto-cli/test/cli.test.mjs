import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const { parseOperation } = await import(pathToFileURL(join(cliDirectory, 'dist/application/operations.js')).href);

async function updateNoticeFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'atto-cli-updates-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cacheRoot = join(directory, 'cache');
  const localAppData = join(directory, 'local-app-data');
  const cache = process.platform === 'win32' ? join(localAppData, 'atto-cli', 'Cache', 'update.json')
    : process.platform === 'darwin' ? join(directory, 'Library', 'Caches', 'atto-cli', 'update.json')
      : join(cacheRoot, 'atto-cli', 'update.json');
  const contents = JSON.stringify({ checkedAt: Date.now(), latest: '999.0.0' });
  await mkdir(dirname(cache), { recursive: true });
  await writeFile(cache, contents);
  const environment = {
    ...process.env,
    XDG_CACHE_HOME: cacheRoot,
    LOCALAPPDATA: localAppData,
    ATTO_TEST_USER_DIRECTORY: directory,
    ATTO_TEST_CLI_MAIN: pathToFileURL(join(cliDirectory, 'dist/cli/main.js')).href,
  };
  for (const key of ['CI', 'GITHUB_ACTIONS', 'NODE_ENV', 'NODE_TEST_CONTEXT', 'NO_UPDATE_NOTIFIER']) delete environment[key];
  const harness = `
    import os from 'node:os';
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    os.homedir = () => process.env.ATTO_TEST_USER_DIRECTORY;
    childProcess.spawn = () => {
      process.exitCode = 99;
      throw new Error('CLI cache fixture must not launch a background check.');
    };
    syncBuiltinESMExports();
    Object.defineProperty(process.stdout, 'isTTY', { value: process.env.ATTO_TEST_STDOUT_TTY === '1' });
    Object.defineProperty(process.stderr, 'isTTY', { value: process.env.ATTO_TEST_STDERR_TTY === '1' });
    process.argv = [process.execPath, 'atto', ...JSON.parse(process.env.ATTO_TEST_ARGUMENTS)];
    await import(process.env.ATTO_TEST_CLI_MAIN);
  `;
  return {
    cache,
    contents,
    run: (args, options = {}) => execute(process.execPath, ['--input-type=module', '--eval', harness], {
      timeout: 10_000,
      env: {
        ...environment,
        ATTO_TEST_STDOUT_TTY: options.stdoutTty === false ? '0' : '1',
        ATTO_TEST_STDERR_TTY: options.stderrTty === false ? '0' : '1',
        ATTO_TEST_ARGUMENTS: JSON.stringify(args),
        ...options.env,
      },
    }),
  };
}

test('shared validation rejects numeric amounts, secrets, invalid indexes, and ambiguous accounts', () => {
  // Given: shared operation schemas used by both interfaces.
  // When: callers provide invalid or ambiguous inputs.
  // Then: validation rejects them without echoing their contents.
  assert.throws(() => parseOperation('send', { destination: 'atto_test', amount: 1, requestId: 'id' }), { code: 'INVALID_INPUT' });
  assert.throws(() => parseOperation('wallet_configure', { mnemonic: 'private recovery phrase' }), error => {
    assert.equal(error.code, 'INVALID_INPUT');
    assert.doesNotMatch(JSON.stringify(error), /private recovery phrase/);
    return true;
  });
  assert.throws(() => parseOperation('address_derive', { index: 2147483648 }), { code: 'INVALID_INPUT' });
  assert.throws(() => parseOperation('account_get', { address: 'atto_test', index: 0 }), { code: 'INVALID_INPUT' });
  assert.throws(() => parseOperation('wallet_configure', { nodeUrl: 'https://name:password@example.com' }), { code: 'INVALID_INPUT' });
  assert.throws(() => parseOperation('limits_propose', { policy: { perRequest: null, rolling: [{ days: 0.5, amount: '1', unit: 'ATTO' }] } }), { code: 'INVALID_INPUT' });
  assert.deepEqual(parseOperation('address_derive', {}), { index: 0 });
  assert.deepEqual(parseOperation('send', { destination: 'atto_test', amount: '1', unit: 'USD', requestId: 'usd-1' }), { destination: 'atto_test', amount: '1', unit: 'USD', requestId: 'usd-1' });
  assert.throws(() => parseOperation('terms_accept', { version: '2026-09-05', accepted: false }), { code: 'INVALID_INPUT' });
  assert.throws(() => parseOperation('terms_accept', { version: '2026-09-05' }), { code: 'INVALID_INPUT' });
});

test('Shared schemas preserve automatic sources and validate pools and journal queries', () => {
  // Given
  const payment = { destination: 'atto_test', amount: '1', requestId: 'payment-1', metadata: { reason: 'Invoice', order: { id: '42' } } };
  const policy = { perRequest: null, rolling: [] };

  // When
  const automatic = parseOperation('send', payment);
  const explicit = parseOperation('send', { ...payment, index: 0 });

  // Then
  assert.equal(Object.hasOwn(automatic, 'index'), false);
  assert.equal(explicit.index, 0);
  assert.deepEqual(automatic.metadata, payment.metadata);
  for (const pool of [{ indexes: [], consolidate: false }, { indexes: [0, 0], consolidate: false }, { indexes: [2147483648], consolidate: true }]) {
    assert.throws(() => parseOperation('limits_propose', { policy, pool }), { code: 'INVALID_INPUT' });
  }
  assert.deepEqual(parseOperation('limits_propose', { policy, pool: { indexes: [0, 2], consolidate: true } }).pool, { indexes: [0, 2], consolidate: true });
  assert.throws(() => parseOperation('send', { ...payment, metadata: ['not an object'] }), { code: 'INVALID_INPUT' });
  assert.throws(() => parseOperation('send', { ...payment, metadata: { reason: 'x'.repeat(4097) } }), { code: 'INVALID_INPUT' });
  assert.deepEqual(parseOperation('journal_list'), { limit: 50 });
  assert.throws(() => parseOperation('journal_list', { limit: 101 }), { code: 'INVALID_INPUT' });
  assert.throws(() => parseOperation('journal_list', { status: 'complete' }), { code: 'INVALID_INPUT' });
});

test('Real CLI defaults to account zero, opts into pooling, and forwards metadata and journal queries', async t => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), 'atto-cli-payment-interface-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const harness = `
    process.env.KOTLIN_LOGGING_STARTUP_MESSAGE = 'false';
    const { AttoApplication } = await import(process.env.ATTO_TEST_APP_MODULE);
    const { parseOperation } = await import(process.env.ATTO_TEST_OPERATIONS_MODULE);
    AttoApplication.prototype.call = async (name, input) => ({ name, input: parseOperation(name, input) });
    process.argv = [process.execPath, 'atto', ...JSON.parse(process.env.ATTO_TEST_ARGUMENTS)];
    await import(process.env.ATTO_TEST_MAIN);
  `;
  const run = args => execute(process.execPath, ['--input-type=module', '--eval', harness], {
    timeout: 10_000,
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1',
      ATTO_TEST_APP_MODULE: pathToFileURL(join(cliDirectory, 'dist/application/app.js')).href,
      ATTO_TEST_OPERATIONS_MODULE: pathToFileURL(join(cliDirectory, 'dist/application/operations.js')).href,
      ATTO_TEST_MAIN: pathToFileURL(join(cliDirectory, 'dist/cli/main.js')).href,
      ATTO_TEST_ARGUMENTS: JSON.stringify(['--json', '--data-dir', directory, ...args]) },
  });

  // When
  const defaultSource = JSON.parse((await run(['send', 'atto_test', '1.25', '--request-id', 'invoice-1', '--metadata', '{"orderId":"42"}', '--reason', 'Invoice 42'])).stdout).result;
  const explicit = JSON.parse((await run(['send', 'atto_test', '1', '--request-id', 'invoice-2', '--index', '2'])).stdout).result;
  const automatic = JSON.parse((await run(['send', 'atto_test', '1', '--request-id', 'invoice-pool', '--pool'])).stdout).result;
  const generatedRun = await run(['send', 'atto_test', '1']);
  const generated = JSON.parse(generatedRun.stdout).result.input.requestId;
  const another = JSON.parse((await run(['send', 'atto_test', '1'])).stdout).result.input.requestId;
  const page = JSON.parse((await run(['journal', 'list', '--status', 'unknown', '--limit', '2', '--cursor', 'opaque-cursor'])).stdout).result;
  const record = JSON.parse((await run(['journal', 'show', 'invoice-1'])).stdout).result;
  const pool = JSON.parse((await run(['pool', 'status'])).stdout).result;
  const indexed = JSON.parse((await run(['send', '--to-index', '1', '--amount', '1'])).stdout).result;
  const history = JSON.parse((await run(['history', '--index', '1'])).stdout).result;
  const receivables = JSON.parse((await run(['receivables', '--index', '1'])).stdout).result;

  // Then
  assert.deepEqual(defaultSource, { name: 'send', input: { destination: 'atto_test', amount: '1.25', unit: 'ATTO', index: 0, requestId: 'invoice-1', metadata: { orderId: '42', reason: 'Invoice 42' } } });
  assert.equal(explicit.input.index, 2);
  assert.match(generated, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(generated, another);
  assert.ok(generatedRun.stderr.includes(JSON.stringify({ progress: { requestId: generated } })));
  assert.equal(Object.hasOwn(explicit.input, 'metadata'), false);
  assert.deepEqual(automatic, { name: 'send', input: { destination: 'atto_test', amount: '1', unit: 'ATTO', requestId: 'invoice-pool' } });
  assert.deepEqual(page, { name: 'journal_list', input: { status: 'unknown', limit: 2, cursor: 'opaque-cursor' } });
  assert.deepEqual(record, { name: 'journal_get', input: { requestId: 'invoice-1' } });
  assert.deepEqual(pool, { name: 'pool_get', input: {} });
  assert.equal(indexed.input.index, 0);
  assert.equal(indexed.input.destinationIndex, 1);
  assert.equal(indexed.input.destination, undefined);
  assert.equal(indexed.input.amount, '1');
  assert.equal(indexed.input.unit, 'ATTO');
  assert.match(indexed.input.requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(history, { name: 'history_list', input: { event: 'entry', index: 1 } });
  assert.deepEqual(receivables, { name: 'receivables_list', input: { index: 1 } });
  for (const flags of [['--pool', '--index', '0'], ['--index', '2', '--pool']]) {
    await assert.rejects(run(['send', 'atto_test', '1', '--request-id', 'ambiguous-source', ...flags]), error => {
      assert.equal(JSON.parse(error.stdout).error.code, 'INVALID_INPUT');
      assert.match(JSON.parse(error.stdout).error.message, /--pool.*--index/);
      return true;
    });
  }
  await assert.rejects(run(['send', 'atto_test', '1', '--request-id', 'invoice-3', '--metadata', '{"reason":"original"}', '--reason', 'replacement']), error => {
    assert.equal(JSON.parse(error.stdout).error.code, 'INVALID_INPUT');
    assert.doesNotMatch(error.stdout + error.stderr, /original|replacement/);
    return true;
  });
  for (const args of [['send', 'atto_test', '--to-index', '1', '--amount', '1'], ['send', '--to-index', '1'], ['receivables', '--cursor', 'unsupported']]) {
    await assert.rejects(run(args), error => {
      assert.equal(JSON.parse(error.stdout).error.code, 'INVALID_INPUT');
      return true;
    });
  }
});

test('real CLI refuses nonterminal recovery commands and prints only public JSON', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atto-cli-interface-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = join(cliDirectory, 'dist/cli/main.js');
  for (const command of ['create', 'import', 'backup']) {
    await assert.rejects(execute(process.execPath, [cli, '--json', '--data-dir', directory, 'wallet', command]), error => {
      assert.equal(JSON.parse(error.stdout).error.code, 'TERMINAL_REQUIRED');
      assert.doesNotMatch(error.stdout + error.stderr, /Recovery phrase \(keep/);
      return true;
    });
  }
  const result = await execute(process.execPath, [cli, '--json', '--data-dir', directory, 'address', 'list']);
  assert.ok(JSON.parse(result.stdout).result);
  await assert.rejects(execute(process.execPath, [cli, '--json', '--data-dir', directory, 'send', 'atto_test', '1', '--usd', '1', '--request-id', 'ambiguous']), error => {
    assert.equal(JSON.parse(error.stdout).error.code, 'INVALID_INPUT');
    return true;
  });
  await assert.rejects(execute(process.execPath, [cli, '--json', 'wallet', 'import', '--mnemonic=private-recovery-input']), error => {
    assert.equal(JSON.parse(error.stdout).error.code, 'INVALID_INPUT');
    assert.doesNotMatch(error.stdout + error.stderr, /private-recovery-input/);
    return true;
  });
  await assert.rejects(execute(process.execPath, [cli, '--json', '--data-dir', directory, 'pool', 'configure', '--indexes', '0']), error => {
    assert.equal(JSON.parse(error.stdout).error.code, 'TERMINAL_REQUIRED');
    return true;
  });
});

test('CLI shows cached update notices on stderr with readable operation names on stdout', async t => {
  // Given
  const fixture = await updateNoticeFixture(t);

  // When
  const result = await fixture.run(['operations']);

  // Then
  assert.match(result.stdout, /\bsend\b/);
  assert.doesNotMatch(result.stdout, /"result"\s*:/);
  assert.match(result.stderr, /Atto CLI update available: .+ → 999\.0\.0/);
  assert.match(result.stderr, /npm install --global @attocash\/cli@999\.0\.0/);
  assert.equal(await readFile(fixture.cache, 'utf8'), fixture.contents);
});

test('JSON and explicit opt-out suppress CLI notices without touching the cache', async t => {
  // Given
  const fixture = await updateNoticeFixture(t);

  for (const args of [['--json', 'operations'], ['--no-update-notifier', 'operations']]) {
    // When
    const result = await fixture.run(args);

    // Then
    if (args.includes('--json')) assert.ok(Array.isArray(JSON.parse(result.stdout).result));
    else {
      assert.match(result.stdout, /\bsend\b/);
      assert.doesNotMatch(result.stdout, /"result"\s*:/);
    }
    assert.equal(result.stderr, '');
    assert.equal(await readFile(fixture.cache, 'utf8'), fixture.contents);
  }
});

test('Pipes and environment opt-outs leave CLI output and update cache unchanged', async t => {
  // Given
  const fixture = await updateNoticeFixture(t);
  const suppressed = [
    { stdoutTty: false },
    { stderrTty: false },
    { env: { NO_UPDATE_NOTIFIER: '' } },
    { env: { CI: 'true' } },
    { env: { NODE_ENV: 'test' } },
  ];

  for (const options of suppressed) {
    // When
    const result = await fixture.run(['operations'], options);

    // Then
    assert.match(result.stdout, /\bsend\b/);
    assert.doesNotMatch(result.stdout, /"result"\s*:/);
    assert.equal(result.stderr, '');
    assert.equal(await readFile(fixture.cache, 'utf8'), fixture.contents);
  }
});

test('Help, version, and parser failures never check for CLI updates', async t => {
  // Given
  const fixture = await updateNoticeFixture(t);

  for (const args of [[], ['--help'], ['--version'], ['wallet', '--help']]) {
    // When
    const result = await fixture.run(args);

    // Then
    assert.notEqual(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(await readFile(fixture.cache, 'utf8'), fixture.contents);
  }
  for (const args of [['--unknown-option'], ['wallet']]) {
    // When
    await assert.rejects(fixture.run(args), error => {
      // Then
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /Error: (Unknown option|Missing subcommand)/);
      assert.match(error.stderr, /Usage: atto /);
      assert.doesNotMatch(error.stderr, /update available/);
      return true;
    });
  }
  assert.equal(await readFile(fixture.cache, 'utf8'), fixture.contents);
});
