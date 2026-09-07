import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run package verification through npm run test:package.');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--artifacts')) throw new Error('Use --artifacts <directory> to select another tarball directory.');
const artifacts = resolve(args[1] ?? root);
const manifest = async directory => JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
const rootManifest = await manifest(root);
const cliManifest = await manifest(join(root, 'atto-cli'));
const mcpManifest = await manifest(join(root, 'atto-mcp'));
const tarball = entry => join(artifacts, `${entry.name.replace(/^@/, '').replace('/', '-')}-${entry.version}.tgz`);
const cliArtifact = tarball(cliManifest);
const mcpArtifact = tarball(mcpManifest);
await Promise.all([cliArtifact, mcpArtifact].map(async path => assert.ok((await stat(path)).isFile(), `Missing artifact: ${path}`)));
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'atto package verification-')));

async function runNpm(args, cwd) {
  return execute(process.execPath, [npm, ...args], { cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
}

async function install(prefix, artifacts, global = false) {
  await mkdir(prefix, { recursive: true });
  await runNpm(['install', '--prefix', prefix, ...(global ? ['--global'] : []), '--ignore-scripts', '--prefer-offline', '--omit=dev', '--no-audit', '--no-fund', ...artifacts], temporary);
  if (global) return (await runNpm(['root', '--global', '--prefix', prefix], temporary)).stdout.trim();
  return join(prefix, 'node_modules');
}

async function verifySourceInstall() {
  const source = join(temporary, 'source');
  await mkdir(source);
  for (const file of ['package.json', 'package-lock.json']) await cp(join(root, file), join(source, file));
  for (const workspace of ['atto-cli', 'atto-mcp']) {
    await mkdir(join(source, workspace));
    await cp(join(root, workspace, 'package.json'), join(source, workspace, 'package.json'));
  }
  // This checks the source lockfile independently of the working node_modules.
  await runNpm(['ci', '--prefer-offline', '--no-audit', '--no-fund'], source);
  for (const workspace of ['cli', 'mcp']) {
    assert.equal(await realpath(join(source, 'node_modules', '@attocash', workspace)), join(source, `atto-${workspace}`));
  }
  process.stdout.write('Clean source npm ci passed.\n');
}

async function verifyCli(directory, prefix, noMcp) {
  const published = await manifest(directory);
  assert.deepEqual(published.bin, { atto: 'dist/cli/main.js' });
  assert.equal(published.scripts, undefined);
  assert.equal(published.devDependencies, undefined);
  const require = createRequire(join(directory, 'package.json'));
  if (noMcp) {
    assert.throws(() => require.resolve('@modelcontextprotocol/server'), { code: 'MODULE_NOT_FOUND' });
    await assert.rejects(stat(join(directory, 'dist', 'mcp')), { code: 'ENOENT' });
  }
  const commons = createRequire(require.resolve('@attocash/commons-node-remote'));
  const ws = JSON.parse(await readFile(commons.resolve('ws/package.json'), 'utf8'));
  assert.equal(ws.version, rootManifest.overrides.ws, 'Installed Commons must retain patched bundled ws.');
  const source = `
    import assert from 'node:assert/strict';
    const core = await import('@attocash/cli/core');
    assert.equal(core.operations.length, 36);
    assert.equal(typeof core.errorResult, 'function');
    const app = core.createApplication({ directory: process.argv[1] });
    assert.deepEqual(Object.keys(app).sort(), ['call', 'close', 'start']);
    try {
      const status = await app.call('wallet_status');
      assert.equal(status.initialized, false);
      assert.equal('mnemonic' in status, false);
    } finally { await app.close(); }
  `;
  await execute(process.execPath, ['--input-type=module', '-e', source, join(prefix, 'public-engine-state')], { cwd: prefix, timeout: 15_000, maxBuffer: 1024 * 1024 });
}

try {
  await verifySourceInstall();
  const cliPrefix = join(temporary, 'cli-only');
  const cliModules = await install(cliPrefix, [cliArtifact]);
  await verifyCli(join(cliModules, '@attocash', 'cli'), cliPrefix, true);
  await execute(process.execPath, ['--test', join(root, 'atto-cli/test/core.test.mjs')], {
    cwd: temporary, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ATTO_TEST_CLI_PACKAGE_DIR: join(cliModules, '@attocash', 'cli') },
  });
  process.stdout.write('CLI-only artifact passed: isolated public engine and no MCP SDK.\n');

  const pairPrefix = join(temporary, 'pair');
  const pairModules = await install(pairPrefix, [cliArtifact, mcpArtifact]);
  const cliDirectory = join(pairModules, '@attocash', 'cli');
  const mcpDirectory = join(pairModules, '@attocash', 'mcp');
  await verifyCli(cliDirectory, pairPrefix, false);
  const mcp = await manifest(mcpDirectory);
  assert.equal(mcp.dependencies['@attocash/cli'], cliManifest.version);
  assert.equal(mcp.bundleDependencies, undefined);
  assert.deepEqual(mcp.bin, { 'atto-mcp': 'dist/main.js' });
  assert.equal(Object.keys(mcp.dependencies).some(name => name.startsWith('@attocash/commons-')), false);
  assert.equal(Object.values(mcp.dependencies).some(value => /^(?:file:|workspace:|link:)/.test(value)), false);
  await assert.rejects(stat(join(mcpDirectory, 'dist', 'application')), { code: 'ENOENT' });
  const tests = await execute(process.execPath, ['--test',
    join(root, 'atto-cli/test/cli.test.mjs'), join(root, 'atto-cli/test/core.test.mjs'), join(root, 'atto-cli/test/send-failure.test.mjs'),
    join(root, 'atto-cli/test/cli-help.test.mjs'), join(root, 'atto-cli/test/cli-output.test.mjs'), join(root, 'atto-cli/test/wallet-lifecycle.test.mjs'), join(root, 'atto-cli/test/wallet-reset.test.mjs'),
    join(root, 'atto-cli/test/usability.test.mjs'), join(root, 'atto-cli/test/labels.test.mjs'),
    join(root, 'atto-cli/test/doctor.test.mjs'), join(root, 'atto-mcp/test/doctor.test.mjs'),
    join(root, 'atto-cli/test/auto-receive.test.mjs'), join(root, 'atto-cli/test/receive-lookup.test.mjs'), join(root, 'atto-cli/test/receive-progress.test.mjs'),
    join(root, 'atto-cli/test/work.test.mjs'), join(root, 'atto-cli/test/background-receive.test.mjs'),
    join(root, 'atto-cli/test/network.test.mjs'), join(root, 'atto-cli/test/stream-idle.test.mjs'),
    join(root, 'atto-cli/test/reconciliation.test.mjs'),
    join(root, 'atto-cli/test/payments.test.mjs'), join(root, 'atto-mcp/test/interfaces.test.mjs'), join(root, 'atto-mcp/test/onboarding.test.mjs'),
  ], {
    cwd: temporary, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, ATTO_TEST_CLI_PACKAGE_DIR: cliDirectory, ATTO_TEST_MCP_PACKAGE_DIR: mcpDirectory },
  });
  process.stdout.write(tests.stdout);
  process.stdout.write('Installed pair passed: stdio tools, CLI parity, signing and payment journal.\n');
  // npm exec is the npx runner. Both unpublished artifacts are supplied together
  // here; after publication users only need the MCP package and its exact dependency.
  const npxHelp = await runNpm(['exec', '--yes', '--prefer-offline', '--package', cliArtifact, '--package', mcpArtifact, '--', 'atto-mcp', 'setup', '--help'], temporary);
  assert.match(npxHelp.stdout, /Choose a wallet and approve MCP access/);
  const doctorHelp = await runNpm(['exec', '--yes', '--prefer-offline', '--package', cliArtifact, '--package', mcpArtifact, '--', 'atto-mcp', 'doctor', '--help'], temporary);
  assert.match(doctorHelp.stdout, /keyring, node, and worker without\s+repairs/);
  await assert.rejects(runNpm(['exec', '--yes', '--prefer-offline', '--package', cliArtifact, '--package', mcpArtifact, '--', 'atto-mcp', 'limits', 'approve', 'synthetic-proposal'], temporary), error => {
    assert.match(error.stderr, /interactive terminal/);
    return true;
  });
  const labelsHelp = await runNpm(['exec', '--yes', '--prefer-offline', '--package', cliArtifact, '--package', mcpArtifact, '--', 'atto', 'labels', 'list', '--help'], temporary);
  assert.match(labelsHelp.stdout, /--search/);
  const nameSchema = await runNpm(['exec', '--yes', '--prefer-offline', '--package', cliArtifact, '--package', mcpArtifact, '--', 'atto', '--json', 'operations', 'send'], temporary);
  assert.equal(JSON.parse(nameSchema.stdout).result.inputSchema.properties.destinationLabel.type, 'string');
  process.stdout.write('npx runner passed: artifact setup and no noninteractive approval bypass.\n');
  if (process.env.ATTO_TEST_PACKAGE_INTEGRATION === '1') {
    const integration = await execute(process.execPath, ['--test', join(root, 'test/integration.test.mjs')], {
      cwd: temporary, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ATTO_TEST_INTEGRATION: '1', ATTO_TEST_CLI_PACKAGE_DIR: cliDirectory, ATTO_TEST_MCP_PACKAGE_DIR: mcpDirectory },
    });
    process.stdout.write(integration.stdout);
    process.stdout.write('Installed pair passed real Commons node/worker integration.\n');
  }

  const globalModules = await install(join(temporary, 'global'), [cliArtifact, mcpArtifact], true);
  const resolution = await execute(process.execPath, ['--input-type=module', '-e', `
    import { fileURLToPath } from 'node:url';
    const core = await import('@attocash/cli/core');
    if (typeof core.createApplication !== 'function') throw new Error('Missing CLI engine export');
    process.stdout.write(fileURLToPath(import.meta.resolve('@attocash/cli/core')));
  `], { cwd: join(globalModules, '@attocash/mcp'), timeout: 15_000 });
  assert.ok(resolution.stdout.startsWith(temporary), 'Global test must resolve the local CLI artifact inside its isolated prefix.');
  const cli = await execute(process.execPath, [join(globalModules, '@attocash/cli/dist/cli/main.js'), '--version'], { cwd: temporary, timeout: 15_000 });
  const mcpVersion = await execute(process.execPath, [join(globalModules, '@attocash/mcp/dist/main.js'), '--version'], { cwd: temporary, timeout: 15_000 });
  assert.equal(cli.stdout.trim(), cliManifest.version);
  assert.equal(mcpVersion.stdout.trim(), mcpManifest.version);
  const detached = await execute(process.execPath, ['--test', '--test-name-pattern=detached|background|stop retains|unavailable credentials|dead owner|real CLI send|lost receive|startup acknowledges',
    join(root, 'atto-cli/test/work.test.mjs'), join(root, 'atto-cli/test/background-receive.test.mjs'), join(root, 'atto-cli/test/payments.test.mjs'),
  ], { cwd: temporary, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ATTO_TEST_CLI_PACKAGE_DIR: join(globalModules, '@attocash/cli') } });
  process.stdout.write(detached.stdout);
  process.stdout.write('Combined global artifact installation passed in an isolated prefix.\n');
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
