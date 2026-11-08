import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const directory = process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR ?? join(import.meta.dirname, '..');
// Resolve and import on every platform, including when Windows storage tests skip.
const adapterManifestPath = findPackageJSON('@attocash/atto-marketplace-nano-adapter', pathToFileURL(join(directory, 'package.json')));
const adapterManifest = JSON.parse(await readFile(adapterManifestPath, 'utf8'));
const adapterUrl = new URL(adapterManifest.exports['.'].import, pathToFileURL(adapterManifestPath)).href;
const { provisionNanoWallet } = await import(adapterUrl);

test('Marketplace loads the Nano adapter through its public import export', () => {
  // Given the selected source or installed Marketplace package and its adapter dependency.
  // When its declared public import export is resolved and imported above.
  // Then provisioning is available without relying on a CommonJS export condition.
  assert.equal(adapterManifest.name, '@attocash/atto-marketplace-nano-adapter');
  assert.equal(typeof provisionNanoWallet, 'function');
});

test('Windows profile and wallet selection guards reject before creating private storage', async t => {
  // Given an absent Marketplace home and the Windows platform guard.
  const parent = await mkdtemp(join(tmpdir(), 'marketplace-windows-guard-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const home = join(parent, 'untouched');
  // Exercise the platform guard on POSIX too, in an isolated process. Windows
  // CI uses its native process.platform and filesystem without substitution.
  const source = `
    import assert from 'node:assert/strict';
    if (process.platform !== 'win32') Object.defineProperty(process, 'platform', { value: 'win32' });
    const { MarketplaceProfileStore } = await import(${JSON.stringify(pathToFileURL(join(directory, 'dist/profile-store.js')).href)});
    const { readWalletSelection, saveWalletSelection } = await import(${JSON.stringify(pathToFileURL(join(directory, 'dist/wallet-preferences.js')).href)});
    const home = process.argv[1];
    await assert.rejects(MarketplaceProfileStore.open(home), error => {
      assert.equal(error.code, 'PROFILE_PERMISSIONS');
      assert.match(error.message, /POSIX 0700 directory and 0600 file permissions/);
      return true;
    });
    assert.throws(() => readWalletSelection(home), { code: 'WALLET_SETUP_REQUIRED' });
    await assert.rejects(saveWalletSelection(home, {}), { code: 'WALLET_SETUP_REQUIRED' });
  `;
  // When profile and wallet preference access is attempted in an isolated process.
  await execute(process.execPath, ['--input-type=module', '-e', source, home], { timeout: 10_000 });
  // Then all access fails closed and the private home remains absent.
  await assert.rejects(readdir(home), { code: 'ENOENT' });
});

test('native Windows Marketplace startup fails closed with the supported-platform explanation', { skip: process.platform !== 'win32' }, async t => {
  // Given native Windows and an absent Marketplace profile home.
  const parent = await mkdtemp(join(tmpdir(), 'marketplace-windows-startup-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const home = join(parent, 'untouched');
  // When the real Marketplace executable starts with that home.
  await assert.rejects(execute(process.execPath, [join(directory, 'dist/main.js'), '--profile', 'unsupported', '--home', home],
    { timeout: 10_000 }), error => {
    // Then startup exits with the platform explanation before producing protocol output.
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /Marketplace MCP profiles currently require POSIX 0700 directory and 0600 file permissions/);
    return true;
  });
  await assert.rejects(readdir(home), { code: 'ENOENT' });
});

test('native Windows Nano provisioning refuses storage without POSIX privacy guarantees', { skip: process.platform !== 'win32' }, async t => {
  // Given a synthetic Nano seed on native Windows and absent wallet storage.
  const parent = await mkdtemp(join(tmpdir(), 'nano-windows-storage-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const seedFile = join(parent, 'synthetic-seed.hex');
  const dataDir = join(parent, 'untouched');
  const handoffDirectory = join(parent, 'untouched-handoffs');
  await writeFile(seedFile, '01'.repeat(32) + '\n', { mode: 0o600 });
  // When provisioning requires POSIX privacy guarantees from that filesystem.
  await assert.rejects(provisionNanoWallet({ dataDir, seedFile, derivationIndex: 0,
    network: 'nano:dev', rpcUrl: 'http://localhost:1', origin: 'https://marketplace.example',
    audience: 'windows-storage-contract', handoffDirectory, terminalConfirmed: true }), { code: 'PRIVATE_FILE' });
  // Then provisioning is refused before creating wallet or handoff state.
  await assert.rejects(readdir(dataDir), { code: 'ENOENT' });
  await assert.rejects(readdir(handoffDirectory), { code: 'ENOENT' });
});
