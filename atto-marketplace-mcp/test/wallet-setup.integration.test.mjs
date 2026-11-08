import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import test from 'node:test';
import { signAttoControllerProof } from '../dist/wallet-process.js';

const recoveryPhrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

// Replace only the native credential binding. OsSecretStore still selects the
// platform adapter, writes through it, and verifies the stored phrase itself.
const nativeKeyringFixtureUrl = 'data:text/javascript,' + encodeURIComponent(`
  const entries = new Map();
  export const operations = [];
  export class AsyncEntry {
    constructor(service, account) { this.service = service; this.account = account; }
    key() { return JSON.stringify([this.service, this.account]); }
    record(operation) { operations.push({ operation, service: this.service, account: this.account }); }
    async getPassword() { this.record('lookup'); return entries.get(this.key()) ?? null; }
    async setPassword(value) { this.record('store'); entries.set(this.key(), value); }
    async deleteCredential() { this.record('clear'); entries.delete(this.key()); }
  }
`);

function runTerminalHarness({ env, steps, timeoutMs = 30_000 }) {
  const harness = [
    "import os from 'node:os';",
    "import { registerHooks, syncBuiltinESMExports } from 'node:module';",
    "Object.defineProperty(process, 'platform', { value: process.env.ATTO_TEST_PLATFORM });",
    `registerHooks({ resolve(specifier, context, nextResolve) { return specifier === '@napi-rs/keyring' ? { url: ${JSON.stringify(nativeKeyringFixtureUrl)}, shortCircuit: true } : nextResolve(specifier, context); } });`,
    "import { writeFile } from 'node:fs/promises';",
    'os.homedir = () => process.env.ATTO_TEST_HOME;',
    'syncBuiltinESMExports();',
    "Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });",
    "Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });",
    'process.stdin.isRaw = false;',
    "process.stdin.on('resume', () => process.stdin.ref?.());",
    "process.stdin.on('pause', () => process.stdin.unref?.());",
    'process.stdin.setRawMode = value => { process.stdin.isRaw = value; return process.stdin; };',
    "const { run } = await import(process.env.ATTO_TEST_MAIN);",
    "await run(['wallet', 'setup', '--network', 'atto:local', '--node-url', 'http://127.0.0.1:7076', '--worker-url', 'http://127.0.0.1:7078'], {});",
    "const { createApplication } = await import('@attocash/cli/core');",
    'const application = createApplication({ directory: process.env.ATTO_TEST_WALLET });',
    'const firstStatus = await application.call(\'wallet_status\');',
    'const firstLimits = await application.call(\'limits_get\');',
    'await application.close();',
    'let reconfigurationCode = null;',
    "try { await run(['wallet', 'setup', '--network', 'atto:beta', '--node-url', 'http://127.0.0.1:8076', '--worker-url', 'http://127.0.0.1:8078'], {}); }",
    'catch (error) { reconfigurationCode = error.code ?? null; }',
    'const afterCancel = createApplication({ directory: process.env.ATTO_TEST_WALLET });',
    'const afterCancelStatus = await afterCancel.call(\'wallet_status\');',
    'const afterCancelLimits = await afterCancel.call(\'limits_get\');',
    'await afterCancel.close();',
    "const { inspectWalletProfile } = await import('@attocash/cli/profiles');",
    'const credentialProfile = inspectWalletProfile(process.env.ATTO_TEST_WALLET);',
    "const { operations } = await import('@napi-rs/keyring');",
    'await writeFile(process.env.ATTO_TEST_TRACE, JSON.stringify({ firstStatus, firstLimits, reconfigurationCode, afterCancelStatus, afterCancelLimits, credentialProfile, secretStoreOperations: operations }));',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '--eval', harness], {
    cwd: packageDirectory,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  let pending = '';
  let stepIndex = 0;
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => {
    stderr.push(chunk);
    pending += stripVTControlCharacters(chunk.toString());
    while (stepIndex < steps.length) {
      const step = steps[stepIndex];
      const match = pending.indexOf(step.prompt);
      if (match < 0) break;
      pending = pending.slice(match + step.prompt.length);
      stepIndex++;
      child.stdin.write(String(step.answer) + '\n');
    }
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Wallet setup wrapper did not finish.'));
    }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      resolve({ code, stepIndex, stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: stripVTControlCharacters(Buffer.concat(stderr).toString('utf8')) });
    });
  });
}

// Linux also exercises the macOS branch without loading a native Keychain binding.
for (const platform of new Set([process.platform, 'darwin'])) {
  test(`wallet setup uses its private default home, preserves its selected wallet on mismatched reconfiguration and uses the installed shared Atto wallet engine (${platform} credential adapter)`, t => verifyWalletSetup(t, platform));
}

async function verifyWalletSetup(t, platform) {
  const root = await mkdtemp(join(tmpdir(), 'marketplace-wallet-setup-wrapper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const fakeBin = join(root, 'fake-bin');
  await mkdir(fakeBin, { recursive: true, mode: 0o700 });
  const fakeSecretTool = join(fakeBin, 'secret-tool');
  await writeFile(fakeSecretTool, [
    '#!/bin/sh',
    'case "$1" in',
    '  store) cat >"$ATTO_TEST_CREDENTIAL"; exit 0 ;;',
    '  lookup) test -f "$ATTO_TEST_CREDENTIAL" || exit 1; cat "$ATTO_TEST_CREDENTIAL"; exit 0 ;;',
    '  clear) rm -f "$ATTO_TEST_CREDENTIAL"; exit 0 ;;',
    '  *) exit 2 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o700 });
  await chmod(fakeSecretTool, 0o700);
  const marketplaceHome = join(home, '.config', 'atto', 'marketplace-mcp');
  const walletDirectory = join(marketplaceHome, 'wallets', 'atto');
  const tracePath = join(root, 'trace.json');
  const env = {
    PATH: fakeBin + ':' + (process.env.PATH ?? ''),
    HOME: home,
    XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_RUNTIME_DIR: '',
    DBUS_SESSION_BUS_ADDRESS: '',
    ATTO_TEST_HOME: home,
    ATTO_TEST_CREDENTIAL: join(root, 'synthetic-credential'),
    ATTO_TEST_PLATFORM: platform,
    ATTO_TEST_MAIN: new URL('../dist/main.js', import.meta.url).href,
    ATTO_TEST_WALLET: walletDirectory,
    ATTO_TEST_TRACE: tracePath,
  };
  const steps = [
    { prompt: 'Wallet is not initialized. [1] Create a new wallet (default), [2] Import a recovery phrase: ', answer: '2' },
    { prompt: 'Type yes to store this wallet in the OS password store: ', answer: 'yes' },
    { prompt: 'Recovery phrase (hidden): ', answer: recoveryPhrase },
    { prompt: 'Account pool: [1] Keep current pool (default), [2] Configure account pool: ', answer: '1' },
    { prompt: 'Maximum ATTO per payment: ', answer: '3' },
    { prompt: 'Maximum ATTO across a rolling 24 hours: ', answer: '8' },
    { prompt: 'Type yes to approve this exact proposal: ', answer: 'yes' },
    { prompt: 'Allow Marketplace funding from this Atto wallet [y/N]: ', answer: 'yes' },
    { prompt: 'Allow external Atto transfers from this wallet [y/N]: ', answer: 'no' },
    { prompt: 'Type APPROVE to save this Marketplace wallet access: ', answer: 'APPROVE' },
  ];

  const terminal = await runTerminalHarness({ env, steps });
  assert.equal(terminal.code, 0, terminal.stderr.replaceAll(recoveryPhrase, '[test phrase]'));
  assert.equal(terminal.stepIndex, steps.length, terminal.stderr.replaceAll(recoveryPhrase, '[test phrase]'));
  assert.equal((terminal.stderr + terminal.stdout).includes(recoveryPhrase), false);
  const outputLines = terminal.stdout.trim().split(/\r?\n/);
  assert.equal(outputLines.length, 1);
  const result = JSON.parse(outputLines[0]);
  assert.deepEqual(Object.keys(result).sort(), ['address', 'directory', 'index', 'network', 'next', 'status'].sort());
  assert.equal(result.status, 'wallet-configured');
  assert.equal(result.network, 'atto:local');
  assert.equal(result.directory, walletDirectory);
  assert.match(result.next, /Configure only atto-marketplace-mcp/);
  assert.doesNotMatch(terminal.stdout, /mcpServers|@attocash\/mcp|"command"\s*:/);

  const trace = JSON.parse(await readFile(tracePath, 'utf8'));
  assert.equal(trace.reconfigurationCode, 'PROFILE_CONFLICT');
  if (platform === 'linux') {
    assert.deepEqual(trace.secretStoreOperations, []);
    assert.equal(await readFile(env.ATTO_TEST_CREDENTIAL, 'utf8'), recoveryPhrase);
  } else {
    assert.equal(trace.secretStoreOperations.filter(entry => entry.operation === 'store').length, 1);
    const stored = trace.secretStoreOperations.findIndex(entry => entry.operation === 'store');
    assert.ok(trace.secretStoreOperations.slice(stored + 1).some(entry => entry.operation === 'lookup'));
    for (const entry of trace.secretStoreOperations) {
      assert.equal(entry.service, trace.credentialProfile.credentialService);
      assert.equal(entry.account, trace.credentialProfile.credentialAccount);
    }
    await assert.rejects(access(env.ATTO_TEST_CREDENTIAL), {code: 'ENOENT'});
  }
  const savedAddress = trace.firstStatus.addresses.find(address => address.index === result.index);
  assert.ok(savedAddress);
  assert.equal(result.address, savedAddress.address);
  assert.equal(trace.firstStatus.identity.address, result.address);
  assert.equal(trace.firstStatus.settings.network, 'LOCAL');
  assert.equal(trace.firstStatus.settings.nodeUrl, 'http://127.0.0.1:7076');
  assert.equal(trace.firstStatus.settings.workerUrl, 'http://127.0.0.1:7078');
  assert.equal(trace.firstStatus.mcpAccess, 'spend');
  assert.deepEqual(trace.firstStatus.messageSigningIndexes, []);
  assert.deepEqual(trace.firstLimits.policy, {
    perRequest: { amount: '3', unit: 'ATTO' },
    rolling: [{ days: 1, amount: '8', unit: 'ATTO' }],
  });
  assert.deepEqual(trace.afterCancelLimits.policy, trace.firstLimits.policy);
  assert.equal(trace.afterCancelStatus.mcpAccess, trace.firstStatus.mcpAccess);
  assert.deepEqual(trace.afterCancelStatus.messageSigningIndexes, trace.firstStatus.messageSigningIndexes);
  assert.equal(trace.afterCancelStatus.settings.network, 'LOCAL');
  assert.equal(trace.afterCancelStatus.settings.nodeUrl, 'http://127.0.0.1:7076');
  assert.equal(trace.afterCancelStatus.settings.workerUrl, 'http://127.0.0.1:7078');

  const expectedDirectories = [marketplaceHome, join(marketplaceHome, 'wallets'), walletDirectory];
  for (const directory of expectedDirectories) assert.equal((await stat(directory)).mode & 0o777, 0o700, directory);
  for (const file of ['state.sqlite', 'lifecycle.sqlite', 'coordination.sqlite']) {
    assert.equal((await stat(join(walletDirectory, file))).mode & 0o777, 0o600, file);
  }

  const mcpPackagePath = require.resolve('@attocash/mcp/package.json');
  const mcpPackage = JSON.parse(await readFile(mcpPackagePath, 'utf8'));
  const marketplacePackage = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
  assert.equal(marketplacePackage.dependencies['@attocash/mcp'], undefined);
  assert.equal(marketplacePackage.dependencies['@attocash/cli'], mcpPackage.dependencies['@attocash/cli']);
  assert.equal(marketplacePackage.dependencies['@attocash/atto-marketplace-nano-adapter'], '0.1.0');
  assert.equal(mcpPackage.bin['atto-mcp'], 'dist/main.js');
  await access(join(dirname(mcpPackagePath), mcpPackage.bin['atto-mcp']));
  assert.equal(env.MARKETPLACE_MCP_ATTO_WALLET_COMMAND, undefined);

  const message = 'Marketplace local controller signing integration check.';
  // Given native spending was approved without granting generic message signing.
  // When an agent requests a raw signature.
  await assert.rejects(signAttoControllerProof({
    env: { ...env, MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR: walletDirectory },
    index: result.index,
    address: result.address,
    message,
  }));
  // Then the raw signing request cannot use one-off Marketplace approval authority.
}
