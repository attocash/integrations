import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { setPermissions } from './support/private-permissions.mjs';

const execute = promisify(execFile);
const directory = process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR ?? join(import.meta.dirname, '..');
const packageUrl = pathToFileURL(join(directory, 'package.json'));
const adapterManifestPath = findPackageJSON('@attocash/atto-marketplace-nano-adapter', packageUrl);
const adapterManifest = JSON.parse(await readFile(adapterManifestPath, 'utf8'));
const adapterUrl = new URL(adapterManifest.exports['.'].import, pathToFileURL(adapterManifestPath)).href;
const { provisionNanoWallet, inspectNanoWallet } = await import(adapterUrl);
const cliManifestPath = findPackageJSON('@attocash/cli', packageUrl);
const cliManifest = JSON.parse(await readFile(cliManifestPath, 'utf8'));
const privateUrl = new URL(cliManifest.exports['./internal-marketplace'].import, pathToFileURL(cliManifestPath)).href;
const { assertPrivatePermissions } = await import(privateUrl);
const moduleUrl = name => pathToFileURL(join(directory, 'dist', name)).href;
const { MarketplaceProfileStore } = await import(moduleUrl('profile-store.js'));
const { readWalletSelection, saveWalletSelection } = await import(moduleUrl('wallet-preferences.js'));
const { callWallet } = await import(moduleUrl('wallet-process.js'));
const controllerAddress = 'nano_3igf8hd4sjshoibbbkeitmgkp1o6ug4xads43j6e4gqkj5xk5o83j8ja9php';
const profile = { id:'native', origin:'http://localhost:8080', audience:'native-platform-test',
  accountId:'11111111-1111-4111-8111-111111111111', agentId:'22222222-2222-4222-8222-222222222222',
  identityId:'33333333-3333-4333-8333-333333333333', controllerNetwork:'NANO', controllerAddress,
  controllerIndex:1, authMode:'scoped-api-key', apiKey:'synthetic-native-scoped-credential', apiScopes:['tasks:read'] };

// Each test uses its real OS. Substituting process.platform cannot establish
// SQLite, filesystem or child-process behavior.
test('Marketplace imports the embedded Nano adapter through its public export', () => {
  // Given the selected checkout or installed Marketplace package.
  // When its embedded adapter's declared public import is resolved above.
  // Then provisioning is available without requiring a CommonJS export condition.
  assert.equal(adapterManifest.name, '@attocash/atto-marketplace-nano-adapter');
  assert.equal(typeof provisionNanoWallet, 'function');
});

test('native profile setup preserves private credentials, selected wallets and pending recovery across a process restart', {timeout:120_000}, async t => {
  // Given an explicit home and original wallet paths containing spaces and apostrophes.
  const parent = await mkdtemp(join(tmpdir(), "Marketplace O'Brien native-"));
  t.after(() => rm(parent, {recursive:true,force:true}));
  const home = join(parent, 'private profile'), originalWallet = join(parent, 'original wallet');
  await mkdir(originalWallet, {mode:0o700});
  const mutation = {profileId:profile.id, requestId:'44444444-4444-4444-8444-444444444444',
    operation:'marketplace-fund', target:profile.accountId, requestHash:'a'.repeat(64)};
  let store = await MarketplaceProfileStore.open(home);
  try {
    store.createProfile(profile);
    store.beginMutation(mutation, '55555555-5555-4555-8555-555555555555');
  } finally { store.close(); }
  await saveWalletSelection(home, {attoDirectory:originalWallet});
  assertPrivatePermissions(home, 'directory');
  assertPrivatePermissions(join(home, 'profiles.sqlite'), 'file');
  const source = `
    import assert from 'node:assert/strict';
    const {MarketplaceProfileStore} = await import(${JSON.stringify(moduleUrl('profile-store.js'))});
    const {readWalletSelection} = await import(${JSON.stringify(moduleUrl('wallet-preferences.js'))});
    const store = await MarketplaceProfileStore.open(process.argv[1]);
    try {
      assert.equal(store.getProfile('native').apiKey, ${JSON.stringify(profile.apiKey)});
      assert.equal(store.beginMutation(${JSON.stringify(mutation)}).state, 'PENDING');
      assert.equal(readWalletSelection(process.argv[1]).attoDirectory, process.argv[2]);
      process.stdout.write('original credential and pending request retained');
    } finally { store.close(); }
  `;
  // When a new real Node process reopens the same profile and request ID.
  const result = await execute(process.execPath, ['--input-type=module','-e',source,home,originalWallet], {timeout:90_000});
  // Then recovery keeps its original wallet and journal without printing credential bytes or creating a replacement wallet.
  assert.equal(result.stdout, 'original credential and pending request retained');
  assert.deepEqual(readWalletSelection(home), {attoDirectory:originalWallet});
  await assert.rejects(readdir(join(home, 'wallets')), {code:'ENOENT'});
  store = await MarketplaceProfileStore.open(home);
  try {
    assert.deepEqual(store.getMutation(mutation), {state:'PENDING',resultIdentity:'55555555-5555-4555-8555-555555555555'});
    assert.throws(() => store.beginMutation({...mutation,requestHash:'b'.repeat(64)}), {code:'IDEMPOTENCY_CONFLICT'});
  } finally { store.close(); }
});

test('native startup creates private storage and reaches the profile-required boundary', {timeout:90_000}, async t => {
  // Given an absent home on the current operating system.
  const parent = await mkdtemp(join(tmpdir(), 'marketplace-native-startup-'));
  t.after(() => rm(parent, {recursive:true,force:true}));
  const home = join(parent, 'new profile');
  // When the actual package entrypoint starts without a configured profile.
  await assert.rejects(execute(process.execPath, [join(directory,'dist/main.js'),'--profile','missing','--home',home], {timeout:60_000}), error => {
    // Then private storage succeeds and only the normal missing-profile error is reported.
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /Configure a Marketplace MCP profile/);
    return true;
  });
  assertPrivatePermissions(home, 'directory');
  assertPrivatePermissions(join(home,'profiles.sqlite'), 'file');
});

test('native Nano provisioning and the private Node wallet child share the same selected identity', {timeout:150_000}, async t => {
  // Given synthetic import bytes in a private disposable directory and no live node.
  const parent = await mkdtemp(join(tmpdir(), "Nano O'Brien native-"));
  t.after(() => rm(parent, {recursive:true,force:true}));
  const seedFile = join(parent,'synthetic-seed.hex'), dataDir = join(parent,'selected Nano wallet'), handoffDirectory = join(parent,'private handoffs');
  await writeFile(seedFile, `${'01'.repeat(32)}\n`, {mode:0o600});
  const options = {dataDir,seedFile,derivationIndex:1,network:'nano:dev',rpcUrl:'http://localhost:1',
    origin:'http://localhost:8080',audience:'native-platform-test',handoffDirectory,terminalConfirmed:true};
  // When native provisioning publishes the configuration and the actual Node stdio child reads it.
  const wallet = await provisionNanoWallet(options);
  const identity = await callWallet({...process.env,MARKETPLACE_MCP_NANO_WALLET_DATA_DIR:dataDir,
    MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR:handoffDirectory}, {asset:'XNO',operation:'identity.list',input:{}});
  // Then the original identity and private native paths survive an exact setup retry without contacting RPC.
  assert.equal(identity.address, wallet.address);
  assert.equal((await provisionNanoWallet(options)).address, wallet.address);
  assert.equal((await inspectNanoWallet(dataDir)).sourceAddress, wallet.address);
  for (const path of [dataDir,handoffDirectory]) assertPrivatePermissions(path, 'directory');
  for (const path of [seedFile,wallet.configurationPath]) assertPrivatePermissions(path, 'file');
  assert.equal(await readFile(seedFile,'utf8'), `${'01'.repeat(32)}\n`);
});

test('primary profile open normalizes POSIX modes while preference reads remain nonmutating', {skip:process.platform === 'win32',timeout:90_000}, async t => {
  // Given existing credentials and profile storage with permissive POSIX modes.
  const home = await mkdtemp(join(tmpdir(), 'marketplace-native-private-file-'));
  t.after(() => rm(home, {recursive:true,force:true}));
  const store = await MarketplaceProfileStore.open(home);
  try { store.createProfile(profile); } finally { store.close(); }
  const database = join(home,'profiles.sqlite'), before = await readFile(database);
  await setPermissions(home,0o755,'directory');
  await setPermissions(database,0o644);
  // When preferences inspect the existing paths, they refuse without repairing them.
  assert.throws(() => readWalletSelection(home), {code:'WALLET_SETUP_REQUIRED'});
  assert.throws(() => assertPrivatePermissions(home, 'directory'));
  assert.throws(() => assertPrivatePermissions(database, 'file'));
  assert.deepEqual(await readFile(database), before);
  // Then the primary mutable open restores the original modes and retains the credential bytes.
  const reopened = await MarketplaceProfileStore.open(home);
  try { assert.equal(reopened.getProfile(profile.id).apiKey, profile.apiKey); } finally { reopened.close(); }
  assertPrivatePermissions(home, 'directory');
  assertPrivatePermissions(database, 'file');
  assert.deepEqual(await readFile(database), before);
});
