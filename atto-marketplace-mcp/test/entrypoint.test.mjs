import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execute = promisify(execFile);
test('npm-style executable symlink runs the CLI instead of exiting silently', { skip: process.platform === 'win32' }, async () => {
  // Given an installed executable symlink.
  const directory = await mkdtemp(join(tmpdir(), 'atto-marketplace-mcp-bin-'));
  try {
    const bin = join(directory, 'atto-marketplace-mcp');
    await symlink(fileURLToPath(new URL('../dist/main.js', import.meta.url)), bin);
    // When help and bare setup run through the installed entrypoint.
    const result = await execute(process.execPath, [bin, '--help'], { timeout: 10_000 });
    // Then help describes optional profiles and setup requires a local terminal.
    assert.match(result.stdout, /Usage: atto-marketplace-mcp \[--profile/);
    await assert.rejects(execute(process.execPath, [bin, 'setup'], { timeout: 10_000 }), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /requires an interactive local terminal/);
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('removed wallet approve alias fails before opening a home or requesting consent', async () => {
  // Given a nonexistent private Marketplace home and the removed nested command.
  const directory=await mkdtemp(join(tmpdir(),'atto-marketplace-removed-approve-'));
  const home=join(directory,'untouched');
  try {
    // When the command is invoked with its former arguments.
    await assert.rejects(execute(process.execPath,[fileURLToPath(new URL('../dist/main.js',import.meta.url)),
      'wallet','approve',join(directory,'missing.request.json'),'--home',home],{timeout:10000}),error=>{
      // Then argument rejection happens before terminal approval or state creation.
      assert.equal(error.code,1);
      assert.match(error.stderr,/Usage: atto-marketplace-mcp wallet setup/);
      assert.doesNotMatch(error.stderr,/Type APPROVE|TERMINAL_REQUIRED/);
      return true;
    });
    await assert.rejects(readdir(home),{code:'ENOENT'});
  } finally {await rm(directory,{recursive:true,force:true});}
});

for (const help of ['--help', '-h']) {
  test(`setup ${help} exits successfully without a terminal or home side effects`, async () => {
    // Given a nonexistent private home and piped stdio.
    const directory = await mkdtemp(join(tmpdir(), 'atto-marketplace-setup-help-'));
    const home = join(directory, 'untouched');
    try {
      // When help is requested before either guided or explicit setup dispatch.
      const result = await execute(process.execPath, [fileURLToPath(new URL('../dist/main.js', import.meta.url)),
        'setup', help, '--home', home], { timeout: 10_000,
        env: { ...process.env, MARKETPLACE_MCP_HOME: home, HOME: home } });
      // Then usage is useful and no approval, network setup or profile creation occurs.
      for (const option of ['--advanced', '--controller-network', '--mode', '--complete', '--reauthenticate', '--from-profile', '--credential-id']) {
        assert.ok(result.stdout.includes(option), option);
      }
      assert.match(result.stdout, /Guided setup: atto-marketplace-mcp setup/);
      assert.match(result.stdout, /#preauthorize-login-only-for-a-dedicated-atto-wallet/);
      assert.doesNotMatch(result.stderr, /requires an interactive|TERMINAL_REQUIRED|Type APPROVE/);
      await assert.rejects(readdir(home), { code: 'ENOENT' });
      const wallet = await execute(process.execPath, [fileURLToPath(new URL('../dist/main.js', import.meta.url)),
        'wallet', 'setup', '--help', '--home', home], { timeout: 10_000 });
      assert.match(wallet.stdout + wallet.stderr, /Usage: atto-marketplace-mcp wallet setup/);
      await assert.rejects(readdir(home), { code: 'ENOENT' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test('approve help points headless operators to deployment instructions', async () => {
  const main = fileURLToPath(new URL('../dist/main.js', import.meta.url));
  const { stdout } = await execute(process.execPath, [main, 'approve', '--help'], { timeout: 10_000 });

  assert.match(stdout, /--login-authorization <deployment-file>/);
  assert.match(stdout, /#preauthorize-login-only-for-a-dedicated-atto-wallet/);
  assert.match(stdout, /unlocked Secret Service/);
});

for(const args of [['--json','setup'],['setup','--json'],['--json','wallet','setup'],['wallet','setup','--json']]){
  test(`explicit JSON does not bypass guided terminal approval: ${args.join(' ')}`,async()=>{
    // Given piped stdio and a command that normally requires a person's terminal.
    const main=fileURLToPath(new URL('../dist/main.js',import.meta.url));
    // When JSON is selected on either side of the command.
    await assert.rejects(execute(process.execPath,[main,...args],{timeout:10000}),error=>{
      // Then the command reaches the same terminal gate, without falling into MCP server dispatch.
      assert.equal(error.code,1);assert.match(error.stderr,/requires an interactive local terminal/);
      assert.doesNotMatch(error.stderr,/Unknown.*option/);return true;
    });
  });
}
