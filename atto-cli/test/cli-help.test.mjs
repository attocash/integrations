import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const cli = join(cliDirectory, 'dist/cli/main.js');
const privateToken = 'synthetic-private-recovery-input';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'atto-cli-help-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environment = {
    ...process.env,
    LOCALAPPDATA: join(directory, 'local'),
    XDG_DATA_HOME: join(directory, 'data'),
    XDG_CACHE_HOME: join(directory, 'cache'),
    NO_UPDATE_NOTIFIER: '1',
    ATTO_TEST_USER_DIRECTORY: directory,
    ATTO_TEST_CLI_MAIN: pathToFileURL(cli).href,
  };
  const harness = `
    import os from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    os.homedir = () => process.env.ATTO_TEST_USER_DIRECTORY;
    syncBuiltinESMExports();
    process.argv = [process.execPath, 'atto', ...JSON.parse(process.env.ATTO_TEST_ARGUMENTS)];
    await import(process.env.ATTO_TEST_CLI_MAIN);
  `;
  return {
    async run(args, bare = false) {
      try {
        const result = await execute(process.execPath, ['--input-type=module', '--eval', harness], {
          cwd: directory, timeout: 10_000,
          env: { ...environment, ATTO_TEST_ARGUMENTS: JSON.stringify([...(bare ? [] : ['--data-dir', join(directory, 'profile')]), ...args]) },
        });
        return { code: 0, ...result };
      } catch (error) {
        if (typeof error.code !== 'number') throw error;
        return { code: error.code, stdout: error.stdout, stderr: error.stderr };
      }
    },
    async assertNoProfile() {
      assert.deepEqual(await readdir(directory), [], 'Help and parser errors must not initialize wallet state or an update cache.');
    },
  };
}

test('Bare CLI prints top-level help successfully without opening a profile', async t => {
  // Given a clean isolated home and no command arguments.
  const f = await fixture(t);

  // When the real CLI starts without a command.
  const result = await f.run([], true);

  // Then help is useful stdout output, not an error or a wallet operation.
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^Usage: atto\b/m);
  assert.match(result.stdout, /Commands:/);
  assert.match(result.stdout, /wallet/);
  assert.match(result.stdout, /send/);
  assert.equal(result.stderr, '');
  await f.assertNoProfile();
});

test('Incomplete command groups explain the missing subcommand with relevant help', async t => {
  // Given every public CLI command group and an unused profile directory.
  const f = await fixture(t);
  const groups = ['wallet', 'address', 'labels', 'limits', 'pool', 'journal', 'terms', 'representative'];

  for (const group of groups) {
    // When a group is invoked without one of its subcommands.
    const result = await f.run([group]);

    // Then the error and group help go to stderr with a failing exit status.
    assert.equal(result.code, 1, group);
    assert.equal(result.stdout, '', group);
    assert.match(result.stderr, /subcommand/i);
    assert.match(result.stderr, new RegExp(`^Usage: atto ${group}\\b`, 'm'));
    assert.match(result.stderr, /Commands:/);
    await f.assertNoProfile();
  }
});

test('Unknown commands and options show nearest help without echoing supplied tokens', async t => {
  // Given unknown tokens that represent accidentally supplied recovery material.
  const f = await fixture(t);
  const cases = [
    { args: [privateToken], usage: /^Usage: atto \[/m, error: /unknown command/i },
    { args: ['wallet', privateToken], usage: /^Usage: atto wallet\b/m, error: /unknown command/i },
    { args: ['wallet', 'run'], usage: /^Usage: atto wallet\b/m, error: /unknown command/i },
    { args: [`--${privateToken}`], usage: /^Usage: atto \[/m, error: /unknown option/i },
    { args: ['wallet', 'status', `--${privateToken}=${privateToken}`], usage: /^Usage: atto wallet status\b/m, error: /unknown option/i },
    { args: ['wallet', 'import', `--mnemonic=${privateToken}`], usage: /^Usage: atto wallet import\b/m, error: /unknown option/i },
  ];

  for (const scenario of cases) {
    // When Commander rejects the unknown command or option.
    const result = await f.run(scenario.args);

    // Then the safe error identifies the problem and help uses only known command names.
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, scenario.error);
    assert.match(result.stderr, scenario.usage);
    assert.equal((result.stdout + result.stderr).includes(privateToken), false);
    await f.assertNoProfile();
  }
});

test('Missing, invalid, and excess inputs show the affected command help safely', async t => {
  // Given incomplete arguments and invalid values for parser-owned number and boolean options.
  const f = await fixture(t);
  const cases = [
    { args: ['transaction'], usage: /^Usage: atto transaction\b/m, error: /missing|required/i },
    { args: ['send', 'atto_test', '1', '--request-id'], usage: /^Usage: atto send\b/m, error: /missing|required/i },
    { args: ['limits', 'approve'], usage: /^Usage: atto limits approve\b/m, error: /missing|required/i },
    { args: ['address', 'derive', privateToken], usage: /^Usage: atto address derive\b/m, error: /invalid/i },
    { args: ['wallet', 'configure', '--network', privateToken], usage: /^Usage: atto wallet configure\b/m, error: /invalid/i },
    { args: ['pool', 'configure', '--indexes', `0,${privateToken}`], usage: /^Usage: atto pool configure\b/m, error: /invalid/i },
    { args: ['transaction', 'A'.repeat(64), privateToken], usage: /^Usage: atto transaction\b/m, error: /argument/i },
  ];

  for (const scenario of cases) {
    // When the parser cannot construct the requested command's inputs.
    const result = await f.run(scenario.args);

    // Then it prints a safe diagnosis and that command's help before opening a wallet.
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, scenario.error);
    assert.match(result.stderr, scenario.usage);
    assert.equal((result.stdout + result.stderr).includes(privateToken), false);
    await f.assertNoProfile();
  }
});

test('JSON parser errors remain one structured response without help or stderr', async t => {
  // Given machine-readable mode for missing commands and representative parser errors.
  const f = await fixture(t);
  const commands = [[], ['wallet'], [privateToken], ['wallet', 'status', `--${privateToken}`],
    ['transaction'], ['address', 'derive', privateToken], ['send', 'atto_test', '1', '--request-id'],
    ['transaction', 'A'.repeat(64), privateToken]];

  for (const command of commands) {
    // When the same parser failures are requested with --json.
    const result = await f.run(['--json', ...command], command.length === 0);

    // Then consumers get exactly one sanitized INVALID_INPUT object and no terminal help.
    assert.equal(result.code, 1);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.trim().split('\n').length, 1);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(payload), ['error']);
    assert.equal(payload.error.code, 'INVALID_INPUT');
    assert.equal(typeof payload.error.message, 'string');
    assert.ok(payload.error.message.length > 0);
    assert.doesNotMatch(result.stdout, /Usage:/);
    assert.equal(result.stdout.includes(privateToken), false);
    await f.assertNoProfile();
  }
});

test('Explicit help remains successful stdout output at every command level', async t => {
  // Given help requests at the root, group, and leaf command levels.
  const f = await fixture(t);
  const cases = [
    { args: ['--help'], usage: /^Usage: atto \[/m },
    { args: ['wallet', '--help'], usage: /^Usage: atto wallet\b/m },
    { args: ['wallet', 'receive', '--help'], usage: /^Usage: atto wallet receive\b/m },
    { args: ['send', '--help'], usage: /^Usage: atto send\b/m },
    { args: ['pool', 'configure', '--help'], usage: /^Usage: atto pool configure\b/m },
    { args: ['--json', 'wallet', '--help'], usage: /^Usage: atto wallet\b/m },
  ];

  for (const scenario of cases) {
    // When the user explicitly requests help.
    const result = await f.run(scenario.args);

    // Then it remains help on stdout with exit zero, including when --json is present.
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, scenario.usage);
    await f.assertNoProfile();
  }
});

test('Every command has a description and an example, and removed commands have no aliases', async t => {
  // Given the real command hierarchy, discovered from each group's own help.
  const f = await fixture(t);
  let leaves = 0;
  async function inspect(path) {
    const result = await f.run([...path, '--help']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Example:\n  atto /);
    const commands = result.stdout.split('Commands:\n')[1]?.split('\n\n')[0];
    if (!commands) { leaves++; return; }
    for (const line of commands.split('\n')) {
      const match = line.match(/^  (\S+)(.*?)\s{2,}(\S.*)$/);
      if (!match || match[1] === 'help') continue;
      assert.ok(match[3].length > 5, line);
      await inspect([...path, match[1]]);
    }
  }
  // When help is requested at each level, it must remain free of wallet side effects.
  await inspect([]);
  assert.ok(leaves >= 38, `Only discovered ${leaves} commands`);
  for (const command of [['price'], ['weight'], ['limits', 'get'], ['representative', 'atto_test']]) {
    const result = await f.run(command);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown command/);
  }
  const schema = await f.run(['--json', 'operations', 'send']);
  const input = JSON.parse(schema.stdout).result.inputSchema;
  assert.equal(input.properties.destinationIndex.type, 'integer');
  assert.ok(input.required.includes('requestId'));
  assert.equal(input.required.includes('unit'), false, 'Defaulted values are optional inputs.');
  for (const operation of ['watch_start', 'watch_list', 'watch_read', 'watch_stop']) {
    const result = await f.run(['--json', 'call', operation]);
    assert.equal(JSON.parse(result.stdout).error.code, 'SESSION_REQUIRED');
  }
  await f.assertNoProfile();
});
