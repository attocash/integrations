import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execute = promisify(execFile);
test('npm-style executable symlink runs the CLI instead of exiting silently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atto-marketplace-mcp-bin-'));
  try {
    const bin = join(directory, 'atto-marketplace-mcp');
    await symlink(fileURLToPath(new URL('../dist/main.js', import.meta.url)), bin);
    const result = await execute(process.execPath, [bin, '--help'], { timeout: 10_000 });
    assert.match(result.stdout, /Usage: atto-marketplace-mcp --profile/);
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
