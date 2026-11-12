import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { managedWalletEnvironment, defaultMarketplaceHome as walletHomeDefault } from '../dist/wallet-home.js';
import { defaultMarketplaceHome } from '../dist/defaults.js';
import { homedir } from 'node:os';

const execute = promisify(execFile);

test('Marketplace MCP home selects dedicated native wallets without modifying caller environment', async t => {
  // Given
  const parent = await mkdtemp(join(tmpdir(), 'marketplace-wallet-home-'));
  t.after(() => rm(parent, {recursive:true,force:true}));
  const home = join(parent, 'private-home');
  const env = { PATH: '/usr/bin' };
  // When
  const selected = managedWalletEnvironment(home, env);
  // Then
  assert.equal(selected.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR, join(home, 'wallets/atto'));
  assert.equal(selected.MARKETPLACE_MCP_NANO_WALLET_DATA_DIR, join(home, 'wallets/nano'));
  assert.equal(selected.MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR,selected.MARKETPLACE_MCP_NANO_WALLET_DATA_DIR);
  assert.equal(selected.MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR, join(home, 'payment-handoffs'));
  assert.equal(selected.MARKETPLACE_MCP_HOME, home);
  assert.deepEqual(env, { PATH: '/usr/bin' });
  assert.notEqual(managedWalletEnvironment(join(parent, 'other-home'), env).MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR,
    selected.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR);
});

test('explicit existing wallet selections remain stable and relative paths fail closed', async t => {
  // Given
  const parent = await mkdtemp(join(tmpdir(), 'marketplace-explicit-wallets-'));
  t.after(() => rm(parent, {recursive:true,force:true}));
  const home = join(parent, 'home');
  const handoffs = join(parent, 'selected-handoffs');
  const env = { MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR: join(parent, 'explicit-atto'),
    MARKETPLACE_MCP_NANO_WALLET_DATA_DIR: join(parent, 'explicit-nano'), MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR: join(parent, 'old-handoffs') };
  await mkdir(env.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR, {mode:0o700});
  await mkdir(env.MARKETPLACE_MCP_NANO_WALLET_DATA_DIR, {mode:0o700});
  // When
  const selected = managedWalletEnvironment(home, env, handoffs);
  // Then
  assert.equal(selected.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR, env.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR);
  assert.equal(selected.MARKETPLACE_MCP_NANO_WALLET_DATA_DIR, env.MARKETPLACE_MCP_NANO_WALLET_DATA_DIR);
  assert.equal(selected.MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR, handoffs);
  for (const key of ['MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR', 'MARKETPLACE_MCP_NANO_WALLET_DATA_DIR','MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR',
    'MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR']) {
    assert.throws(() => managedWalletEnvironment(home, { [key]: 'relative/wallet' }),
      error => error.code === 'WALLET_SETUP_REQUIRED');
  }
});

test('dedicated wallet creation requires a terminal before opening wallet storage', async t => {
  // Given
  const parent = await mkdtemp(join(tmpdir(), 'atto-marketplace-mcp-terminal-guard-'));
  t.after(() => rm(parent, {recursive:true,force:true}));
  const home = join(parent, 'untouched-home');
  const main = fileURLToPath(new URL('../dist/main.js', import.meta.url));
  // When
  await assert.rejects(execute(process.execPath, [main, 'wallet', 'setup', '--home', home]), error => {
    // Then
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /interactive local terminal/);
    return true;
  });
  await assert.rejects(readdir(home), {code:'ENOENT'});
  const help = await execute(process.execPath, [main, 'wallet', 'setup', '--help']);
  assert.match(help.stdout, /--network <atto:live\|atto:beta\|atto:dev\|atto:local>/);
  assert.doesNotMatch(help.stdout, /recovery phrase|signature/);
});


test('Marketplace defaults use local per-user Windows data and preserve the exact Unix home', () => {
  // Given an explicit local application-data base for the current operating system.
  const env = {LOCALAPPDATA:join(homedir(), 'synthetic-local-data')};
  // When both public default imports resolve the home.
  const expected = process.platform === 'win32'
    ? join(env.LOCALAPPDATA, 'Atto Marketplace MCP')
    : join(homedir(), '.config', 'atto', 'marketplace-mcp');
  // Then one resolver owns the same path and its missing-environment fallback.
  assert.equal(defaultMarketplaceHome(env), expected);
  assert.equal(walletHomeDefault(env), expected);
  assert.equal(defaultMarketplaceHome({}), process.platform === 'win32'
    ? join(homedir(), 'AppData', 'Local', 'Atto Marketplace MCP')
    : join(homedir(), '.config', 'atto', 'marketplace-mcp'));
});

test('explicit Marketplace home overrides its environment home without opening the other path', async t => {
  // Given distinct explicit and environment homes and a nonexistent profile.
  const parent = await mkdtemp(join(tmpdir(), 'marketplace-home-precedence-'));
  t.after(() => rm(parent, {recursive:true,force:true}));
  const explicitHome = join(parent, 'explicit'), environmentHome = join(parent, 'environment');
  const main = fileURLToPath(new URL('../dist/main.js', import.meta.url));
  const env = {...process.env, MARKETPLACE_MCP_HOME:environmentHome};
  // When the entrypoint receives --home, the ordinary missing-profile error follows storage setup.
  await assert.rejects(execute(process.execPath, [main, '--home', explicitHome, '--profile', 'missing'], {env}), error => {
    assert.match(error.stderr, /Configure a Marketplace MCP profile/);return true;
  });
  // Then only the explicitly selected directory was opened.
  assert.equal((await stat(join(explicitHome, 'profiles.sqlite'))).isFile(), true);
  await assert.rejects(stat(environmentHome), {code:'ENOENT'});
});
