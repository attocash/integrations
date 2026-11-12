import { assertPrivate, setPermissions } from './support/private-permissions.mjs';
import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from '../../test/support/temporary-directory.mjs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {promisify} from 'node:util';
import {once} from 'node:events';
import test from 'node:test';
const packageDirectory = process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR ?? join(import.meta.dirname,'..');
const moduleUrl = name => pathToFileURL(join(packageDirectory,'dist',name)).href;
const {MarketplaceProfileStore} = await import(moduleUrl('profile-store.js'));
const {readWalletSelection, saveWalletSelection} = await import(moduleUrl('wallet-preferences.js'));
const {managedWalletEnvironment} = await import(moduleUrl('wallet-home.js'));

const execute = promisify(execFile);
const setupError = error => error.code === 'WALLET_SETUP_REQUIRED';

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'marketplace-wallet-selection-'));
  t.after(() => rm(parent, {recursive: true, force: true}));
  const home = join(parent, 'home');
  const atto = join(parent, 'existing-atto');
  const nano = join(parent, 'existing-nano');
  const controller = join(parent, 'separate-controller');
  const handoffs = join(parent, 'existing-nano-handoffs');
  for (const path of [home, atto, nano, controller, handoffs]) await mkdir(path, {mode: 0o700});
  return {parent, home, atto, nano, controller, handoffs, database: join(home, 'profiles.sqlite')};
}

test('reading wallet preferences never creates a home, database, or preference table', async t => {
  const f = await fixture(t);
  const missing = join(f.parent, 'missing');
  assert.equal(readWalletSelection(missing), undefined);
  await assert.rejects(readdir(missing), {code: 'ENOENT'});
  assert.equal(readWalletSelection(f.home), undefined);
  assert.deepEqual(await readdir(f.home), []);
  const store = await MarketplaceProfileStore.open(f.home);
  store.close();
  const before = await readFile(f.database);
  assert.equal(readWalletSelection(f.home), undefined);
  assert.deepEqual(await readFile(f.database), before);
});

test('saved role selections survive process restart and a profiles.sqlite restore', async t => {
  const f = await fixture(t);
  await saveWalletSelection(f.home, {attoDirectory: f.atto});
  await saveWalletSelection(f.home, {nanoDirectory: f.nano, nanoControllerDirectory: f.controller, paymentHandoffDirectory: f.handoffs});
  await saveWalletSelection(f.home, {attoDirectory: f.atto});
  const expected = {attoDirectory: f.atto, nanoDirectory: f.nano, nanoControllerDirectory: f.controller, paymentHandoffDirectory: f.handoffs};
  const restarted = await execute(process.execPath, ['--input-type=module', '-e',
    `import {readWalletSelection} from ${JSON.stringify(moduleUrl('wallet-preferences.js'))}; process.stdout.write(JSON.stringify(readWalletSelection(process.argv[1])));`, f.home]);
  assert.deepEqual(JSON.parse(restarted.stdout), expected);
  const restored = join(f.parent, 'restored');
  await mkdir(restored, {mode: 0o700});
  await copyFile(f.database, join(restored, 'profiles.sqlite'));
  await setPermissions(join(restored, 'profiles.sqlite'), 0o600);
  assert.deepEqual(readWalletSelection(restored), expected);
  const env = managedWalletEnvironment(restored, {});
  assert.equal(env.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR, f.atto);
  assert.equal(env.MARKETPLACE_MCP_NANO_WALLET_DATA_DIR, f.nano);
  assert.equal(env.MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR, f.controller);
  assert.equal(env.MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR, f.handoffs);
});

test('environment overrides saved roles and a shared controller follows the primary wallet', async t => {
  const f = await fixture(t);
  await saveWalletSelection(f.home, {attoDirectory: f.atto, nanoDirectory: f.nano});
  const env = {MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR: join(f.parent, 'explicit-atto'),
    MARKETPLACE_MCP_NANO_WALLET_DATA_DIR: join(f.parent, 'explicit-nano')};
  const explicitController = join(f.parent, 'explicit-controller');
  const selected = managedWalletEnvironment(f.home, env);
  assert.equal(selected.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR, env.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR);
  assert.equal(selected.MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR, env.MARKETPLACE_MCP_NANO_WALLET_DATA_DIR);
  await saveWalletSelection(f.home, {nanoControllerDirectory: f.controller});
  assert.equal(managedWalletEnvironment(f.home, env).MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR, f.controller);
  assert.equal(managedWalletEnvironment(f.home, {...env, MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR: explicitController})
    .MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR, explicitController);
  await saveWalletSelection(f.home, {nanoControllerDirectory: f.nano});
  assert.deepEqual(readWalletSelection(f.home), {attoDirectory: f.atto, nanoDirectory: f.nano});
  assert.equal(managedWalletEnvironment(f.home, env).MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR, env.MARKETPLACE_MCP_NANO_WALLET_DATA_DIR);
});

test('simultaneous independent processes merge role updates even on the first database creation', async t => {
  const f = await fixture(t);
  const patches = [{attoDirectory: f.atto}, {nanoDirectory: f.nano}, {nanoControllerDirectory: f.controller},
    {paymentHandoffDirectory: f.handoffs}];
  await Promise.all(patches.map(patch => execute(process.execPath, ['--input-type=module', '-e',
    `import {saveWalletSelection} from ${JSON.stringify(moduleUrl('wallet-preferences.js'))}; await saveWalletSelection(process.argv[1], JSON.parse(process.argv[2]));`, f.home, JSON.stringify(patch)])));
  assert.deepEqual(readWalletSelection(f.home), {attoDirectory: f.atto, nanoDirectory: f.nano,
    nanoControllerDirectory: f.controller, paymentHandoffDirectory: f.handoffs});
});

test('read-only selection reads work during a concurrent SQLite WAL writer', async t => {
  const f = await fixture(t);
  await saveWalletSelection(f.home, {attoDirectory: f.atto});
  const db = new DatabaseSync(f.database);
  try {
    db.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE');
    assert.deepEqual(readWalletSelection(f.home), {attoDirectory: f.atto});
  } finally { db.exec('ROLLBACK'); db.close(); }
});

test('selection updates wait for a concurrent writer and retain its committed other role', async t => {
  const f = await fixture(t);
  await saveWalletSelection(f.home, {attoDirectory: f.atto});
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    import {DatabaseSync} from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE wallet_selection SET nano_directory=? WHERE singleton=1').run(process.argv[2]);
    process.stdout.write('locked');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, 600);
  `, f.database, f.nano], {stdio: ['ignore', 'pipe', 'pipe']});
  const completed = once(holder, 'exit');
  holder.stderr.resume();
  t.after(() => { if (holder.exitCode === null) holder.kill(); });
  const [locked] = await once(holder.stdout, 'data');
  assert.equal(locked.toString(), 'locked');
  await saveWalletSelection(f.home, {nanoControllerDirectory: f.controller});
  assert.deepEqual(await completed, [0, null]);
  assert.deepEqual(readWalletSelection(f.home), {attoDirectory: f.atto, nanoDirectory: f.nano, nanoControllerDirectory: f.controller});
});

test('missing selected wallets fail closed and selected paths are validated on every read', async t => {
  // Given a saved path whose wallet has disappeared.
  const f = await fixture(t);
  await saveWalletSelection(f.home, {attoDirectory: f.atto});
  await rm(f.atto, {recursive: true});
  assert.throws(() => readWalletSelection(f.home), setupError);
  assert.throws(() => managedWalletEnvironment(f.home, {}), setupError);
  await assert.rejects(readdir(join(f.home, 'wallets')), {code: 'ENOENT'});
  // When the same public path returns with broader permissions.
  await mkdir(f.atto, {mode: 0o755});
  await setPermissions(f.atto, 0o755, 'directory');
  // Then normal Windows permissions are accepted and Unix retains its owner-only mode check.
  if (process.platform === 'win32') assert.deepEqual(readWalletSelection(f.home), {attoDirectory: f.atto});
  else assert.throws(() => readWalletSelection(f.home), setupError);
  if (process.platform !== 'win32') await assert.rejects(saveWalletSelection(f.home, {attoDirectory: f.atto}), setupError);
  await setPermissions(f.atto, 0o700, 'directory');
  assert.deepEqual(readWalletSelection(f.home), {attoDirectory: f.atto});
});

test('preferences reject symbolic links in every path component and directory/file substitution', async t => {
  const f = await fixture(t);
  const alias = join(f.parent, 'alias');
  await symlink(f.atto, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(saveWalletSelection(f.home, {attoDirectory: alias}), setupError);
  const parentAlias = join(f.parent, 'parent-alias');
  await symlink(f.parent, parentAlias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(saveWalletSelection(f.home, {attoDirectory: join(parentAlias, 'existing-atto')}), setupError);
  const walletFile = join(f.parent, 'wallet.json');
  await writeFile(walletFile, '{}', {mode: 0o600});
  await assert.rejects(saveWalletSelection(f.home, {nanoDirectory: walletFile}), setupError);
  await saveWalletSelection(f.home, {attoDirectory: f.atto});
  const aliasHome = join(f.parent, 'alias-home');
  await symlink(f.home, aliasHome, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readWalletSelection(aliasHome), setupError);
  await rm(f.database);
  // Windows standard users can create hardlinks; the private database rejects this unknown alias too.
  if (process.platform === 'win32') await link(walletFile, f.database);
  else await symlink(walletFile, f.database);
  assert.throws(() => readWalletSelection(f.home), setupError);
});

test('preferences reject foreign owners and permissive POSIX storage without changing permissions', {skip:process.platform === 'win32'}, async t => {
  const f = await fixture(t);
  await saveWalletSelection(f.home, {attoDirectory: f.atto});
  const getuid = process.getuid;
  try {
    if (getuid) {
      process.getuid = () => getuid() + 1;
      assert.throws(() => readWalletSelection(f.home), setupError);
      await assert.rejects(saveWalletSelection(f.home, {attoDirectory: f.atto}), setupError);
    }
  } finally { process.getuid = getuid; }
  await setPermissions(f.database, 0o644);
  assert.throws(() => readWalletSelection(f.home), setupError);
  await assert.rejects(saveWalletSelection(f.home, {attoDirectory: f.atto}), setupError);
  if (process.platform !== 'win32') assert.equal((await stat(f.database)).mode & 0o777, 0o644);
  assert.throws(() => assertPrivate(f.database, 'file'));
  await setPermissions(f.database, 0o600);
  await setPermissions(f.home, 0o755, 'directory');
  assert.throws(() => readWalletSelection(f.home), setupError);
  if (process.platform !== 'win32') assert.equal((await stat(f.home)).mode & 0o777, 0o755);
  assert.throws(() => assertPrivate(f.home, 'directory'));
});

test('malformed patches, path traversal, and control characters cannot change a selection', async t => {
  const f = await fixture(t);
  await saveWalletSelection(f.home, {attoDirectory: f.atto});
  for (const patch of [{}, null, [], {attoDirectory: undefined}, {attoDirectory: null}, {unknown: f.atto},
    {attoDirectory: 'relative/wallet'}, {attoDirectory: f.atto + '/..'}, {attoDirectory: f.atto + '/inode\n'},
    {attoDirectory: f.atto + '/inode\t'}, {paymentHandoffDirectory: 'relative/handoffs'}]) {
    await assert.rejects(saveWalletSelection(f.home, patch), setupError);
  }
  assert.deepEqual(readWalletSelection(f.home), {attoDirectory: f.atto});
});

test('wallet preferences do not migrate or change existing profile, journal, or schema-version data', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.database);
  db.exec(`PRAGMA user_version=17;
    CREATE TABLE profiles(id TEXT PRIMARY KEY, api_key TEXT, refresh_token TEXT);
    CREATE TABLE mutations(id TEXT PRIMARY KEY, state TEXT);
    INSERT INTO profiles VALUES('existing', 'retained-api-key', 'retained-refresh-token');
    INSERT INTO mutations VALUES('journal-entry', 'COMPLETE');`);
  db.close();
  await setPermissions(f.database, 0o600);
  await saveWalletSelection(f.home, {attoDirectory: f.atto});
  const verify = new DatabaseSync(f.database);
  try {
    assert.deepEqual({...verify.prepare('SELECT * FROM profiles').get()}, {id: 'existing', api_key: 'retained-api-key', refresh_token: 'retained-refresh-token'});
    assert.deepEqual({...verify.prepare('SELECT * FROM mutations').get()}, {id: 'journal-entry', state: 'COMPLETE'});
    assert.equal(verify.prepare('PRAGMA user_version').get().user_version, 17);
    assert.equal(verify.prepare('PRAGMA table_info(profiles)').all().length, 3);
  } finally { verify.close(); }
});

test('protected tables cannot be read through a forged preference view or modified by triggers', async t => {
  const f = await fixture(t);
  await saveWalletSelection(f.home, {attoDirectory: f.atto});
  let db = new DatabaseSync(f.database);
  db.exec(`CREATE TABLE protected_data(secret TEXT); INSERT INTO protected_data VALUES('retained');
    CREATE TRIGGER poison_selection AFTER UPDATE ON wallet_selection BEGIN DELETE FROM protected_data; END;`);
  db.close();
  assert.throws(() => readWalletSelection(f.home), setupError);
  await assert.rejects(saveWalletSelection(f.home, {nanoDirectory: f.nano}), setupError);
  db = new DatabaseSync(f.database);
  assert.equal(db.prepare('SELECT secret FROM protected_data').get().secret, 'retained');
  db.exec(`DROP TRIGGER poison_selection; DROP TABLE wallet_selection;
    CREATE VIEW wallet_selection AS SELECT 1 AS singleton, 1 AS version, secret AS atto_directory,
      NULL AS nano_directory, NULL AS nano_controller_directory FROM protected_data;`);
  db.close();
  assert.throws(() => readWalletSelection(f.home), setupError);
  await assert.rejects(saveWalletSelection(f.home, {attoDirectory: f.atto}), setupError);
});

test('malformed stored schema, future row versions, and unsafe row paths fail closed', async t => {
  const f = await fixture(t);
  await saveWalletSelection(f.home, {attoDirectory: f.atto});
  let db = new DatabaseSync(f.database);
  db.exec('PRAGMA ignore_check_constraints=ON; UPDATE wallet_selection SET version=2');
  db.close();
  assert.throws(() => readWalletSelection(f.home), setupError);
  await assert.rejects(saveWalletSelection(f.home, {nanoDirectory: f.nano}), setupError);
  db = new DatabaseSync(f.database);
  db.exec("UPDATE wallet_selection SET version=1, atto_directory='relative/wallet'");
  db.close();
  assert.throws(() => readWalletSelection(f.home), setupError);
  db = new DatabaseSync(f.database);
  db.exec('ALTER TABLE wallet_selection ADD COLUMN private_payload TEXT');
  db.close();
  assert.throws(() => readWalletSelection(f.home), setupError);
});

test('a corrupt profile database fails with a sanitized wallet-selection error', async t => {
  const f = await fixture(t);
  await writeFile(f.database, 'corrupt-private-database-content', {mode: 0o600});
  const before = await readFile(f.database);
  assert.throws(() => readWalletSelection(f.home), error => setupError(error)
    && !error.message.includes('corrupt-private-database-content'));
  await assert.rejects(saveWalletSelection(f.home, {attoDirectory: f.atto}), setupError);
  assert.deepEqual(await readFile(f.database), before);
});

test('existing explicit environment selections reject unsafe directories while absent setup targets stay usable', async t => {
  const f = await fixture(t);
  const alias = join(f.parent, 'explicit-alias');
  await symlink(f.atto, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => managedWalletEnvironment(f.home, {MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR: alias}), setupError);
  const missingThroughAlias = join(alias,'missing-wallet');
  assert.throws(() => managedWalletEnvironment(f.home, {MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR: missingThroughAlias}),
    setupError, JSON.stringify(missingThroughAlias));
  await setPermissions(f.atto, 0o755, 'directory');
  if (process.platform !== 'win32') assert.throws(() => managedWalletEnvironment(f.home, {MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR: f.atto}), setupError);
  const missing = join(f.parent, 'new-setup-target');
  assert.equal(managedWalletEnvironment(f.home, {MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR: missing})
    .MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR, missing);
  await assert.rejects(readdir(missing), {code: 'ENOENT'});
  if (process.platform === 'win32') {
    for (const path of [missing + ':stream', '\\\\localhost\\share\\missing-wallet']) {
      assert.throws(() => managedWalletEnvironment(f.home, {MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR:path}),
        setupError, JSON.stringify(path));
    }
  }
});

test('saved Nano handoff selections survive ATTO-only changes and follow argument/environment precedence', async t => {
  const f = await fixture(t);
  await saveWalletSelection(f.home, {nanoDirectory: f.nano, paymentHandoffDirectory: f.handoffs});
  await saveWalletSelection(f.home, {attoDirectory: f.atto});
  assert.deepEqual(readWalletSelection(f.home), {attoDirectory: f.atto, nanoDirectory: f.nano, paymentHandoffDirectory: f.handoffs});
  assert.equal(managedWalletEnvironment(f.home, {}).MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR, f.handoffs);
  const env = {MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR: join(f.parent, 'explicit-environment-handoffs')};
  assert.equal(managedWalletEnvironment(f.home, env).MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR, env.MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR);
  assert.equal(managedWalletEnvironment(f.home, env, join(f.parent, 'explicit-argument-handoffs'))
    .MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR, join(f.parent, 'explicit-argument-handoffs'));
  const otherHome = join(f.parent, 'new-default-home');
  assert.equal(managedWalletEnvironment(otherHome, {}).MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR, join(otherHome, 'payment-handoffs'));
});

test('saved Nano handoff paths must be private real directories and never fall back when missing', async t => {
  const f = await fixture(t);
  const alias = join(f.parent, 'handoff-alias');
  await symlink(f.handoffs, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(saveWalletSelection(f.home, {paymentHandoffDirectory: alias}), setupError);
  await setPermissions(f.handoffs, 0o755, 'directory');
  if (process.platform !== 'win32') await assert.rejects(saveWalletSelection(f.home, {paymentHandoffDirectory: f.handoffs}), setupError);
  await setPermissions(f.handoffs, 0o700, 'directory');
  await saveWalletSelection(f.home, {paymentHandoffDirectory: f.handoffs});
  await rm(f.handoffs, {recursive: true});
  assert.throws(() => readWalletSelection(f.home), setupError);
  assert.throws(() => managedWalletEnvironment(f.home, {}), setupError);
  await assert.rejects(readdir(join(f.home, 'payment-handoffs')), {code: 'ENOENT'});
});


test('saved path metadata rejects substituted symlinks and malformed persisted paths on every read', async t => {
  // Given a valid saved wallet selection.
  const f = await fixture(t);
  await saveWalletSelection(f.home, {attoDirectory:f.atto});
  const alias = join(f.parent, 'saved-wallet-alias');
  await symlink(f.atto, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const db = new DatabaseSync(f.database);
  try {
    // When persisted public paths are replaced outside the supported save API.
    for (const path of [alias, 'relative/wallet', f.atto + '/..', f.atto + '/bad\npath',
      ...(process.platform === 'win32' ? ['\\\\localhost\\share', f.atto + ':stream'] : [])]) {
      db.prepare('UPDATE wallet_selection SET atto_directory=?').run(path);
      // Then each new read rejects the unsafe path without opening the selected wallet.
      assert.throws(() => readWalletSelection(f.home), setupError, JSON.stringify(path));
    }
  } finally { db.close(); }
  assert.deepEqual(await readdir(f.atto), []);
});

test('saving one role revalidates every selected POSIX directory before committing the patch', {skip:process.platform === 'win32'}, async t => {
  // Given a complete selection whose separate controller later loses privacy.
  const f = await fixture(t);
  await saveWalletSelection(f.home, {attoDirectory:f.atto, nanoDirectory:f.nano,
    nanoControllerDirectory:f.controller, paymentHandoffDirectory:f.handoffs});
  await setPermissions(f.controller, 0o755, 'directory');
  // When an unrelated role update would otherwise retain that unsafe selected directory.
  await assert.rejects(saveWalletSelection(f.home, {attoDirectory:f.atto}), setupError);
  // Then the original row survives unchanged and the unsafe directory is not repaired.
  const db = new DatabaseSync(f.database);
  try { assert.equal(db.prepare('SELECT nano_controller_directory FROM wallet_selection').get().nano_controller_directory, f.controller); }
  finally { db.close(); }
  assert.throws(() => assertPrivate(f.controller, 'directory'));
});
