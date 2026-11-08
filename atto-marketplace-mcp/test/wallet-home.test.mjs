import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { managedWalletEnvironment } from '../dist/wallet-home.js';

const execute = promisify(execFile);

test('Marketplace MCP home selects dedicated native wallets without modifying caller environment', () => {
  // Given
  const home = '/tmp/marketplace-private-home';
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
  assert.notEqual(managedWalletEnvironment('/tmp/other-marketplace-home', env).MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR,
    selected.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR);
});

test('explicit existing wallet selections remain stable and relative paths fail closed', () => {
  // Given
  const env = { MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR: '/tmp/explicit-existing-wallet',
    MARKETPLACE_MCP_NANO_WALLET_DATA_DIR: '/tmp/explicit-payer.json', MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR: '/tmp/old-handoffs' };
  // When
  const selected = managedWalletEnvironment('/tmp/marketplace-home', env, '/tmp/selected-handoffs');
  // Then
  assert.equal(selected.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR, env.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR);
  assert.equal(selected.MARKETPLACE_MCP_NANO_WALLET_DATA_DIR, env.MARKETPLACE_MCP_NANO_WALLET_DATA_DIR);
  assert.equal(selected.MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR, '/tmp/selected-handoffs');
  for (const key of ['MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR', 'MARKETPLACE_MCP_NANO_WALLET_DATA_DIR','MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR',
    'MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR']) {
    assert.throws(() => managedWalletEnvironment('/tmp/marketplace-home', { [key]: 'relative/wallet' }),
      error => error.code === 'WALLET_SETUP_REQUIRED');
  }
});

test('dedicated wallet creation requires a terminal before opening wallet storage', async t => {
  // Given
  const parent = await mkdtemp(join(tmpdir(), 'atto-marketplace-mcp-terminal-guard-'));
  t.after(() => rm(parent, {recursive:true,force:true}));
  const home = join(parent, 'untouched-home');
  const main = new URL('../dist/main.js', import.meta.url);
  // When
  await assert.rejects(execute(process.execPath, [main.pathname, 'wallet', 'setup', '--home', home]), error => {
    // Then
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /interactive local terminal/);
    return true;
  });
  await assert.rejects(readdir(home), {code:'ENOENT'});
  const help = await execute(process.execPath, [main.pathname, 'wallet', 'setup', '--help']);
  assert.match(help.stdout, /--network <atto:live\|atto:beta\|atto:dev\|atto:local>/);
  assert.doesNotMatch(help.stdout, /recovery phrase|signature/);
});
