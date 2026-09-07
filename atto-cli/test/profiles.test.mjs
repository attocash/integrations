import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const { defaultCliDirectory, dedicatedMcpDirectory, resolveWalletProfile } = await import(pathToFileURL(join(cliDirectory, 'dist/storage/profiles.js')).href);
const { StateStore, defaultDataDirectory } = await import(pathToFileURL(join(cliDirectory, 'dist/storage/state.js')).href);
const { OsSecretStore } = await import(pathToFileURL(join(cliDirectory, 'dist/storage/secrets.js')).href);
const accountFor = directory => createHash('sha256').update(resolve(directory)).digest('hex');

function fixture(t) {
  const directory = mkdtempSync(join(os.tmpdir(), 'atto-profile-test-'));
  const previous = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, LOCALAPPDATA: process.env.LOCALAPPDATA };
  process.env.XDG_DATA_HOME = join(directory, 'data');
  process.env.LOCALAPPDATA = join(directory, 'local');
  t.mock.method(os, 'homedir', () => join(directory, 'home'));
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const standard = process.platform === 'win32' ? join(directory, 'local', 'Atto CLI')
    : process.platform === 'darwin' ? join(directory, 'home', 'Library', 'Application Support', 'Atto CLI')
      : join(directory, 'data', 'atto-cli');
  return { directory, standard, legacy: resolve(defaultDataDirectory()) };
}

test('a new CLI profile pins its service before state creation and keeps the same identity afterward', t => {
  // Given
  const { standard } = fixture(t);
  assert.equal(defaultCliDirectory(), standard);
  assert.equal(existsSync(standard), false);

  // When
  const profile = resolveWalletProfile();
  const store = new StateStore(profile.directory);
  store.set('identity', { address: 'synthetic-public-address' });
  store.close();
  const reopened = resolveWalletProfile(standard);

  // Then
  assert.deepEqual(profile, { directory: standard, credentialAccount: accountFor(standard), credentialService: 'Atto CLI' });
  assert.deepEqual(reopened, profile);
  const marker = join(standard, 'profile.json');
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), { version: 1, credentialService: 'Atto CLI', defaultCli: true });
  if (process.platform !== 'win32') assert.equal(statSync(marker).mode & 0o777, 0o600);
});

test('a new standard CLI default stays selected when legacy state is created later', t => {
  // Given
  const { standard, legacy } = fixture(t);
  const original = resolveWalletProfile();
  new StateStore(standard).close();

  // When
  new StateStore(legacy).close();

  // Then
  assert.equal(defaultCliDirectory(), standard);
  assert.deepEqual(resolveWalletProfile(), original);
  assert.equal(resolveWalletProfile(legacy).credentialAccount, 'default');
});

test('an explicitly created standard profile does not replace an existing legacy CLI default', t => {
  // Given
  const { standard, legacy } = fixture(t);
  new StateStore(legacy).close();
  const original = resolveWalletProfile();

  // When
  const explicit = resolveWalletProfile(standard);
  new StateStore(standard).close();

  // Then
  assert.equal(defaultCliDirectory(), legacy);
  assert.deepEqual(resolveWalletProfile(), original);
  assert.equal(explicit.credentialService, 'Atto CLI');
  assert.deepEqual(JSON.parse(readFileSync(join(standard, 'profile.json'), 'utf8')), {
    version: 1, credentialService: 'Atto CLI', defaultCli: false,
  });
});

test('an existing legacy wallet remains the default with unchanged state and credential identity', t => {
  // Given
  const { legacy, standard } = fixture(t);
  const store = new StateStore(legacy);
  store.set('identity', { address: 'existing-synthetic-address' });
  store.set('spending.records', [{ id: 'pending', raw: '42', status: 'signed', hash: 'synthetic-hash' }]);
  store.set('market.terms', { version: '2026-09-05' });
  store.close();
  const before = readFileSync(join(legacy, 'state.sqlite'));

  // When
  const implicit = resolveWalletProfile();
  const explicit = resolveWalletProfile(legacy);

  // Then
  assert.equal(defaultCliDirectory(), legacy);
  assert.deepEqual(implicit, { directory: legacy, credentialAccount: 'default', credentialService: 'Atto MCP' });
  assert.deepEqual(explicit, implicit);
  assert.deepEqual(readFileSync(join(legacy, 'state.sqlite')), before);
  assert.equal(existsSync(join(legacy, 'profile.json')), false);
  assert.equal(existsSync(standard), false);
});

test('dedicated MCP and custom profiles retain path-based legacy accounts without touching existing state', t => {
  // Given
  const { directory, legacy } = fixture(t);
  const custom = join(directory, 'existing-custom-wallet');
  const store = new StateStore(custom);
  store.set('settings', { synthetic: true });
  store.close();
  const before = readFileSync(join(custom, 'state.sqlite'));

  // When
  const dedicated = resolveWalletProfile(dedicatedMcpDirectory());
  const shared = resolveWalletProfile(join(custom, 'unused', '..'));

  // Then
  assert.equal(dedicated.directory, join(legacy, 'profiles', 'mcp'));
  assert.deepEqual(dedicated, {
    directory: join(legacy, 'profiles', 'mcp'), credentialAccount: accountFor(dedicated.directory), credentialService: 'Atto MCP',
  });
  assert.deepEqual(shared, { directory: custom, credentialAccount: accountFor(custom), credentialService: 'Atto MCP' });
  assert.notEqual(dedicated.credentialAccount, shared.credentialAccount);
  assert.equal(existsSync(dedicated.directory), false);
  assert.equal(existsSync(join(custom, 'profile.json')), false);
  assert.deepEqual(readFileSync(join(custom, 'state.sqlite')), before);
});

test('an older custom wallet at the new standard CLI path keeps its original keyring service', t => {
  // Given
  const { standard } = fixture(t);
  const store = new StateStore(standard);
  store.set('identity', { address: 'old-custom-synthetic-address' });
  store.close();
  const before = readFileSync(join(standard, 'state.sqlite'));

  // When
  const implicit = resolveWalletProfile();
  const explicit = resolveWalletProfile(standard);

  // Then
  assert.deepEqual(implicit, { directory: standard, credentialAccount: accountFor(standard), credentialService: 'Atto MCP' });
  assert.deepEqual(explicit, implicit);
  assert.equal(existsSync(join(standard, 'profile.json')), false);
  assert.deepEqual(readFileSync(join(standard, 'state.sqlite')), before);
});

test('invalid profile metadata fails closed without rewriting it or opening a database', t => {
  // Given
  const { standard } = fixture(t);
  mkdirSync(standard, { recursive: true });
  const marker = join(standard, 'profile.json');

  // When / Then
  for (const value of [{ version: 2, credentialService: 'Atto CLI' }, { version: 1, credentialService: 'another-wallet' },
    { version: 1, credentialService: 'Atto CLI', defaultCli: 'true' }, null]) {
    const bytes = JSON.stringify(value);
    writeFileSync(marker, bytes);
    assert.throws(() => resolveWalletProfile(standard), { code: 'PROFILE_METADATA' });
    assert.equal(readFileSync(marker, 'utf8'), bytes);
    assert.equal(existsSync(join(standard, 'state.sqlite')), false);
  }
});

test('keyring service selection is restricted without accessing any credentials', () => {
  // Given / When / Then
  assert.doesNotThrow(() => new OsSecretStore());
  assert.doesNotThrow(() => new OsSecretStore('synthetic-account', 'Atto CLI'));
  assert.doesNotThrow(() => new OsSecretStore('synthetic-account', 'Atto MCP'));
  assert.throws(() => new OsSecretStore('synthetic-account', 'another-wallet'), { code: 'INVALID_SERVICE' });
});
