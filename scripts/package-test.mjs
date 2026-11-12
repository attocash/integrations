import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from '../test/support/temporary-directory.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { reportPlatformExclusions, selectPlatformTests } from './test-platform.mjs';

const execute = promisify(execFile);
// Test files own separate profiles, servers and credential fixtures. Cases within
// each file remain sequential, including same-wallet recovery assertions.
const testFileOptions = process.platform === 'win32'
  ? ['--test-concurrency=3', '--test-reporter=tap']
  : ['--test-concurrency=1'];
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
const marketplaceManifest = await manifest(join(root, 'atto-marketplace-mcp'));
const nanoManifest = await manifest(join(root, 'atto-marketplace-nano-adapter'));
const tarball = entry => join(artifacts, `${entry.name.replace(/^@/, '').replace('/', '-')}-${entry.version}.tgz`);
const cliArtifact = tarball(cliManifest);
const mcpArtifact = tarball(mcpManifest);
const marketplaceArtifact = tarball(marketplaceManifest);
await Promise.all([cliArtifact, mcpArtifact, marketplaceArtifact].map(async path => assert.ok((await stat(path)).isFile(), `Missing artifact: ${path}`)));
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
  for (const workspace of ['atto-cli', 'atto-mcp', 'atto-marketplace-mcp', 'atto-marketplace-nano-adapter']) {
    await mkdir(join(source, workspace));
    await cp(join(root, workspace, 'package.json'), join(source, workspace, 'package.json'));
  }
  // This checks the source lockfile independently of the working node_modules.
  await runNpm(['ci', '--prefer-offline', '--no-audit', '--no-fund'], source);
  for (const [packageName, directory] of [
    ['cli', 'atto-cli'],
    ['mcp', 'atto-mcp'],
    ['marketplace-mcp', 'atto-marketplace-mcp'],
    ['atto-marketplace-nano-adapter', 'atto-marketplace-nano-adapter'],
  ]) {
    assert.equal(await realpath(join(source, 'node_modules', '@attocash', packageName)), join(source, directory));
  }
  process.stdout.write('Clean source npm ci passed.\n');
}

async function verifyMarketplace(directory, cliDirectory) {
  const published = await manifest(directory);
  assert.equal(published.name, '@attocash/marketplace-mcp');
  assert.equal(published.dependencies['@attocash/cli'], cliManifest.version);
  assert.equal(published.dependencies['@attocash/atto-marketplace-nano-adapter'], nanoManifest.version);
  assert.equal(published.dependencies['@attocash/commons-core'], '8.0.2');
  assert.deepEqual(published.bin, { 'atto-marketplace-mcp': 'dist/main.js' });
  assert.equal(published.scripts, undefined);
  assert.equal(published.devDependencies, undefined);
  assert.deepEqual(published.bundleDependencies, [nanoManifest.name]);
  for (const [name, version] of Object.entries(nanoManifest.dependencies)) {
    assert.equal(published.dependencies[name], version, `Marketplace must declare the embedded adapter's external dependency ${name}.`);
  }
  assert.equal(Object.values(published.dependencies).some(value => /^(?:file:|workspace:|link:)/.test(value)), false);
  for (const file of ['dist/main.js', 'README.md', 'LICENSE']) await stat(join(directory, file));

  // Given a clean consumer install with no standalone Nano adapter artifact,
  // the Marketplace package must contain the exact compiled adapter itself.
  const adapterDirectory = join(directory, 'node_modules', nanoManifest.name);
  assert.ok((await lstat(adapterDirectory)).isDirectory(), 'The embedded adapter must be a directory, not a source workspace symlink.');
  assert.ok((await lstat(join(adapterDirectory, 'dist'))).isDirectory(), 'The embedded adapter must contain a regular dist directory.');
  const adapter = await manifest(adapterDirectory);
  assert.equal(adapter.name, nanoManifest.name);
  assert.equal(adapter.version, nanoManifest.version);
  assert.equal(adapter.dependencies, undefined, 'Marketplace must own the embedded adapter dependencies so npm installs them outside the bundle.');
  assert.deepEqual(adapter.exports, nanoManifest.exports);
  assert.equal(adapter.scripts, undefined);
  assert.equal(adapter.devDependencies, undefined);
  for (const file of ['package.json', 'dist/index.js', 'dist/index.d.ts', 'dist/protocol.js', 'dist/protocol.d.ts']) {
    assert.ok((await lstat(join(adapterDirectory, file))).isFile(), `The embedded adapter must include a regular ${file} file.`);
  }
  for (const parent of [directory, adapterDirectory]) {
    await assert.rejects(lstat(join(parent, 'node_modules', '@attocash', 'cli')), { code: 'ENOENT' },
      'The Marketplace package and its adapter must use the external shared CLI.');
  }

  // When the installed Marketplace package and embedded adapter import their
  // dependencies, both must load one CLI engine and the adapter's real runtime.
  const source = `
    import assert from 'node:assert/strict';
    import { NanoWallet } from '@attocash/atto-marketplace-nano-adapter';
    import { publicKey } from '@attocash/atto-marketplace-nano-adapter/protocol';
    import { createApplication } from '@attocash/cli/core';
    assert.equal(typeof NanoWallet, 'function');
    assert.equal(typeof publicKey, 'function');
    assert.equal(typeof createApplication, 'function');
    process.stdout.write(JSON.stringify({
      adapter: import.meta.resolve('@attocash/atto-marketplace-nano-adapter'),
      protocol: import.meta.resolve('@attocash/atto-marketplace-nano-adapter/protocol'),
      core: import.meta.resolve('@attocash/cli/core'),
      recovery: import.meta.resolve('@attocash/cli/internal-marketplace'),
    }));
  `;
  const resolutions = [];
  for (const cwd of [directory, adapterDirectory]) {
    const result = await execute(process.execPath, ['--input-type=module', '-e', source], { cwd, timeout: 15_000, maxBuffer: 1024 * 1024 });
    resolutions.push(JSON.parse(result.stdout));
  }
  // Then resolution stays inside the installed bundle and reaches the same CLI
  // artifact, without falling back to the checkout or an independently installed adapter.
  assert.deepEqual(resolutions[0], resolutions[1]);
  assert.equal(resolutions[0].adapter, pathToFileURL(join(adapterDirectory, 'dist/index.js')).href);
  assert.equal(resolutions[0].protocol, pathToFileURL(join(adapterDirectory, 'dist/protocol.js')).href);
  assert.equal(resolutions[0].core, pathToFileURL(join(cliDirectory, 'dist/core.js')).href);
  assert.equal(resolutions[0].recovery, pathToFileURL(join(cliDirectory, 'dist/internal-marketplace.js')).href);
}

async function verifyCli(directory, prefix, noMcp) {
  const published = await manifest(directory);
  assert.deepEqual(published.bin, { atto: 'dist/cli/main.js' });
  assert.equal(published.scripts, undefined);
  assert.equal(published.devDependencies, undefined);
  await assert.rejects(stat(join(directory, 'dist/storage/windows-private-filesystem')), { code: 'ENOENT' },
    'Windows support must not require a permission executable.');
  const require = createRequire(join(directory, 'package.json'));
  const expectedCommonsVersion = process.env.ATTO_COMMONS_LOCAL_VERSION ?? cliManifest.dependencies['@attocash/commons-core'];
  assert.equal(published.dependencies['@attocash/commons-core'], expectedCommonsVersion,
    'The packed CLI dependency must match its bundled Commons package version.');
  async function commonsManifests(nodeModules, copies = []) {
    let entries;
    try { entries = await readdir(nodeModules, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return copies; throw error; }
    for (const entry of entries) {
      const packageDirectory = entry.name.startsWith('@')
        ? join(nodeModules, entry.name)
        : join(nodeModules, entry.name);
      if (entry.name === '@attocash') {
        let scoped = [];
        try { scoped = await readdir(packageDirectory, { withFileTypes: true }); }
        catch {}
        for (const child of scoped) if (child.isDirectory()) {
          if (child.name.startsWith('commons-')) copies.push(await manifest(join(packageDirectory, child.name)));
          await commonsManifests(join(packageDirectory, child.name, 'node_modules'), copies);
        }
      } else if (entry.isDirectory()) {
        await commonsManifests(join(packageDirectory, 'node_modules'), copies);
      }
    }
    return copies;
  }
  const commons = await commonsManifests(join(directory, 'node_modules'));
  const commonsNames = commons.map(value => value.name).sort();
  assert.deepEqual(commonsNames, ['@attocash/commons-core', '@attocash/commons-node',
    '@attocash/commons-node-remote', '@attocash/commons-transport',
    '@attocash/commons-worker', '@attocash/commons-worker-remote'].sort(),
  'The installed CLI must retain one complete production Commons closure, with no nested 8.0.0 copy.');
  assert.ok(commons.every(value => value.version === expectedCommonsVersion), 'Every bundled Commons package must use the same exact version.');
  const coreModule = await import(pathToFileURL(require.resolve('@attocash/commons-core')).href);
  const zeroKey = coreModule.AttoPublicKey.Companion.parse('00'.repeat(32));
  const invalidSignature = coreModule.AttoSignature.Companion.parse('ff'.repeat(64));
  assert.equal(typeof invalidSignature.isValidMessage, 'function', 'The installed package must expose the JS verifier.');
  assert.equal(await invalidSignature.isValidMessage(zeroKey, new Int8Array(0)), false);
  if (noMcp) {
    assert.throws(() => require.resolve('@modelcontextprotocol/server'), { code: 'MODULE_NOT_FOUND' });
    await assert.rejects(stat(join(directory, 'dist', 'mcp')), { code: 'ENOENT' });
  }
  const commonsRequire = createRequire(require.resolve('@attocash/commons-node-remote'));
  const ws = JSON.parse(await readFile(commonsRequire.resolve('ws/package.json'), 'utf8'));
  assert.equal(ws.version, rootManifest.overrides.ws, 'Installed Commons must retain patched bundled ws.');
  const source = `
    import assert from 'node:assert/strict';
    const core = await import('@attocash/cli/core');
    assert.equal(core.operations.length, 40);
    assert.equal(core.operations.find(operation => operation.name === 'marketplace_topup')?.readOnly, false);
    assert.equal(core.operations.find(operation => operation.name === 'marketplace_topup_status')?.readOnly, true);
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
  const pairModules = await install(pairPrefix, [cliArtifact, mcpArtifact, marketplaceArtifact]);
  const cliDirectory = join(pairModules, '@attocash', 'cli');
  const mcpDirectory = join(pairModules, '@attocash', 'mcp');
  const marketplaceDirectory = join(pairModules, '@attocash', 'marketplace-mcp');
  await verifyCli(cliDirectory, pairPrefix, false);
  await verifyMarketplace(marketplaceDirectory, cliDirectory);
  const mcp = await manifest(mcpDirectory);
  assert.equal(mcp.dependencies['@attocash/cli'], cliManifest.version);
  assert.equal(mcp.bundleDependencies, undefined);
  assert.deepEqual(mcp.bin, { 'atto-mcp': 'dist/main.js' });
  assert.equal(Object.keys(mcp.dependencies).some(name => name.startsWith('@attocash/commons-')), false);
  assert.equal(Object.values(mcp.dependencies).some(value => /^(?:file:|workspace:|link:)/.test(value)), false);
  await assert.rejects(stat(join(mcpDirectory, 'dist', 'application')), { code: 'ENOENT' });
  const tests = await execute(process.execPath, ['--test', ...testFileOptions,
    join(root, 'atto-cli/test/cli.test.mjs'), join(root, 'atto-cli/test/core.test.mjs'), join(root, 'atto-cli/test/send-failure.test.mjs'),
    join(root, 'atto-cli/test/cli-help.test.mjs'), join(root, 'atto-cli/test/cli-output.test.mjs'), join(root, 'atto-cli/test/wallet-lifecycle.test.mjs'), join(root, 'atto-cli/test/wallet-reset.test.mjs'),
    join(root, 'atto-cli/test/usability.test.mjs'), join(root, 'atto-cli/test/labels.test.mjs'), join(root, 'atto-cli/test/approvals.test.mjs'),
    join(root, 'atto-cli/test/doctor.test.mjs'), join(root, 'atto-mcp/test/doctor.test.mjs'),
    join(root, 'atto-cli/test/message-signing.test.mjs'),
    join(root, 'atto-cli/test/private-permissions.test.mjs'),
    join(root, 'atto-cli/test/marketplace-wallet-setup.test.mjs'),
    join(root, 'atto-cli/test/marketplace-wallet-inspection.test.mjs'),
    join(root, 'atto-cli/test/marketplace-private-recovery.test.mjs'),
    join(root, 'atto-cli/test/internal-marketplace-wallet.test.mjs'),
    join(root, 'atto-cli/test/receive-amount-recovery.test.mjs'),
    join(root, 'atto-cli/test/auto-receive.test.mjs'), join(root, 'atto-cli/test/receive-lookup.test.mjs'), join(root, 'atto-cli/test/receive-progress.test.mjs'),
    join(root, 'atto-cli/test/work.test.mjs'), join(root, 'atto-cli/test/background-receive.test.mjs'),
    join(root, 'atto-cli/test/network.test.mjs'), join(root, 'atto-cli/test/stream-idle.test.mjs'),
    join(root, 'atto-cli/test/reconciliation.test.mjs'),
    join(root, 'atto-cli/test/payments.test.mjs'), join(root, 'atto-cli/test/marketplace-topups.test.mjs'), join(root, 'atto-mcp/test/interfaces.test.mjs'), join(root, 'atto-mcp/test/onboarding.test.mjs'),
    join(root, 'atto-mcp/test/stream-failure.test.mjs'), join(root, 'atto-mcp/test/configuration.test.mjs'),
    join(root, 'atto-mcp/test/representative.test.mjs'),
  ], {
    cwd: temporary, timeout: 600_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, ATTO_TEST_CLI_PACKAGE_DIR: cliDirectory, ATTO_TEST_MCP_PACKAGE_DIR: mcpDirectory },
  });
  process.stdout.write(tests.stdout);
  const marketplaceSelection = selectPlatformTests([
    join(root, 'atto-marketplace-mcp/test/platform-support.test.mjs'),
    join(root, 'atto-marketplace-mcp/test/approval-files.test.mjs'),
    join(root, 'atto-marketplace-mcp/test/approval-terminal-recovery.test.mjs'),
    join(root, 'atto-marketplace-mcp/test/payment-handoff-files.test.mjs'),
    join(root, 'atto-marketplace-mcp/test/wallet-preferences.test.mjs'),
    join(root, 'atto-marketplace-mcp/test/stdio-submission-files.test.mjs'),
    join(root, 'atto-marketplace-mcp/test/marketplace-api-signer.test.mjs'),
    join(root, 'atto-marketplace-mcp/test/node-wallet-host.test.mjs'),
    join(root, 'atto-marketplace-mcp/test/wallet-results.test.mjs'),
    join(root, 'atto-marketplace-mcp/test/receive-recovery-errors.test.mjs'),
    join(root, 'atto-marketplace-mcp/test/wallet-access.test.mjs'),
    join(root, 'atto-marketplace-mcp/test/compact-atto-setup.test.mjs'),
    join(root, 'atto-marketplace-mcp/test/nano-wallet-terminal.test.mjs'),
    join(root, 'atto-marketplace-mcp/test/setup.test.mjs'),
    join(root, 'atto-marketplace-mcp/test/guided-onboarding.integration.test.mjs'),
    join(root, 'atto-marketplace-mcp/test/atto-private-recovery.test.mjs'),
    join(root, 'atto-marketplace-mcp/test/stdio-profile.test.mjs'),
    join(root, 'atto-marketplace-mcp/test/unified-approval-native.integration.test.mjs'),
    join(root, 'atto-marketplace-mcp/test/shared-recovery-onboarding.integration.test.mjs'),
  ]);
  reportPlatformExclusions(marketplaceSelection.excluded);
  const marketplaceTests = await execute(process.execPath, ['--test', ...testFileOptions, ...marketplaceSelection.included], {
    cwd: temporary, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR: marketplaceDirectory, ATTO_TEST_CLI_PACKAGE_DIR: cliDirectory,
      ...(process.platform !== 'win32' ? { ATTO_TEST_MARKETPLACE_MCP_BIN: join(pairModules, '.bin', 'atto-marketplace-mcp') } : {}) },
  });
  process.stdout.write(marketplaceTests.stdout);
  process.stdout.write(process.platform === 'win32'
    ? 'Installed Atto pair and native Windows Marketplace workflows passed: private storage, credentials, recovery and stdio.\n'
    : 'Installed Atto pair and Marketplace MCP passed: stdio tools, controller setup, signer failures, refresh recovery, signing, and payment journals.\n');
  // npm exec is the npx runner. Exercise all three tested release artifacts.
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
  const marketplaceHelp = await runNpm(['exec', '--yes', '--prefer-offline', '--package', cliArtifact, '--package', mcpArtifact,
    '--package', marketplaceArtifact, '--', 'atto-marketplace-mcp', '--help'], temporary);
  assert.match(marketplaceHelp.stdout, /Usage: atto-marketplace-mcp/);
  process.stdout.write('npx runner passed: artifact setup and no noninteractive approval bypass.\n');
  if (process.env.ATTO_TEST_PACKAGE_INTEGRATION === '1') {
    const integration = await execute(process.execPath, ['--test', join(root, 'test/integration.test.mjs')], {
      cwd: temporary, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ATTO_TEST_INTEGRATION: '1', ATTO_TEST_CLI_PACKAGE_DIR: cliDirectory, ATTO_TEST_MCP_PACKAGE_DIR: mcpDirectory },
    });
    process.stdout.write(integration.stdout);
    process.stdout.write('Installed pair passed real Commons node/worker integration.\n');
  }

  const globalModules = await install(join(temporary, 'global'), [cliArtifact, mcpArtifact, marketplaceArtifact], true);
  await verifyMarketplace(join(globalModules, '@attocash', 'marketplace-mcp'), join(globalModules, '@attocash', 'cli'));
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
  const marketplaceHelpGlobal = await execute(process.execPath, [join(globalModules, '@attocash/marketplace-mcp/dist/main.js'), '--help'], { cwd: temporary, timeout: 15_000 });
  assert.match(marketplaceHelpGlobal.stdout, /Usage: atto-marketplace-mcp/);
  const detached = await execute(process.execPath, ['--test', ...testFileOptions, '--test-name-pattern=detached|background|stop retains|unavailable credentials|dead owner|real CLI send|lost receive|startup acknowledges',
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
