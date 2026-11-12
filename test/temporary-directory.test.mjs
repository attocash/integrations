import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, rm, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {tmpdir} from './support/temporary-directory.mjs';

test('private fixture roots resolve operating-system temporary-directory aliases', async t => {
  // Given an operating-system temporary directory exposed through an alias.
  const root = await mkdtemp(join(tmpdir(), 'temporary-directory-alias-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const physical = join(root, 'physical'), alias = join(root, 'alias');
  await mkdir(physical);
  await symlink(physical, alias, 'junction');
  const helper = new URL('./support/temporary-directory.mjs', import.meta.url).href;
  const code = `import {tmpdir} from ${JSON.stringify(helper)}; process.stdout.write(tmpdir());`;
  // When a child resolves that temporary root before creating private fixtures.
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', code], {
    env: {...process.env, TMPDIR: alias, TEMP: alias, TMP: alias},
    timeout: 5000, encoding: 'utf8',
  });
  // Then every platform uses the resolved physical temporary directory.
  assert.equal(output, physical);
});
