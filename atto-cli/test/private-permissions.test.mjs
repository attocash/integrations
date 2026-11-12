import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const storage = process.env.ATTO_TEST_CLI_PACKAGE_DIR
  ? new URL('./dist/storage/', pathToFileURL(join(process.env.ATTO_TEST_CLI_PACKAGE_DIR, 'package.json')))
  : new URL('../dist/storage/', import.meta.url);
const { assertPrivatePermissions, securePrivatePermissions, assertPrivatePermissionsBatch, securePrivatePermissionsBatch, syncPrivateDirectory } = await import(new URL('private-permissions.js', storage));

function privateRoot(t) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'atto-private-permissions-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  securePrivatePermissions(directory, 'directory');
  return directory;
}

test('private paths reject broad POSIX permissions and preserve owner access when secured', { skip: process.platform === 'win32' }, t => {
  // Given
  const directory = privateRoot(t);
  const file = join(directory, 'private.json');
  writeFileSync(file, '', { mode: 0o644 });
  chmodSync(file, 0o644);

  // When
  assert.throws(() => assertPrivatePermissions(file, 'file'), { code: 'PRIVATE_PERMISSIONS' });
  securePrivatePermissions(file, 'file');

  // Then
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.doesNotThrow(() => assertPrivatePermissions(file, 'file'));
  assert.doesNotThrow(() => syncPrivateDirectory(directory));
  chmodSync(file, 0o400);
  assert.throws(() => assertPrivatePermissions(file, 'file'), { code: 'PRIVATE_PERMISSIONS' });
  securePrivatePermissions(file, 'file');
  chmodSync(directory, 0o755);
  assert.throws(() => assertPrivatePermissions(directory, 'directory'), { code: 'PRIVATE_PERMISSIONS' });
  securePrivatePermissions(directory, 'directory');
  assert.throws(() => assertPrivatePermissions(file, 'directory'), { code: 'PRIVATE_PERMISSIONS' });
});

test('private paths reject symbolic links and directory junction ancestors', t => {
  // Given
  const directory = privateRoot(t);
  const target = join(directory, 'target');
  const alias = join(directory, 'alias');
  mkdirSync(target, { mode: 0o700 });
  securePrivatePermissions(target, 'directory');
  const file = join(target, 'private.json');
  writeFileSync(file, '', { mode: 0o600 });
  securePrivatePermissions(file, 'file');
  symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');

  // When / Then
  assert.throws(() => assertPrivatePermissions(alias, 'directory'), { code: 'PRIVATE_PERMISSIONS' });
  assert.throws(() => securePrivatePermissions(alias, 'directory'), { code: 'PRIVATE_PERMISSIONS' });
  assert.throws(() => assertPrivatePermissions(join(alias, 'private.json'), 'file'), { code: 'PRIVATE_PERMISSIONS' });
  assert.throws(() => securePrivatePermissions(join(alias, 'private.json'), 'file'), { code: 'PRIVATE_PERMISSIONS' });
});

test('POSIX permission batches validate existing children and skip only optional absent paths', { skip: process.platform === 'win32' }, t => {
  // Given
  const directory = privateRoot(t);
  const first = join(directory, 'first.json'), second = join(directory, 'second.json');
  writeFileSync(first, '', { mode: 0o600 }); writeFileSync(second, '', { mode: 0o600 });
  chmodSync(second, 0o644);
  const paths = [{ path: directory, kind: 'directory' }, { path: first, kind: 'file' }, { path: second, kind: 'file' }, { path: join(directory, 'missing-wal'), kind: 'file', optional: true }];
  // When / Then
  assert.throws(() => assertPrivatePermissionsBatch(paths), { code: 'PRIVATE_PERMISSIONS' });
  securePrivatePermissionsBatch(paths);
  assert.doesNotThrow(() => assertPrivatePermissionsBatch(paths));
  chmodSync(first, 0o644);
  assert.throws(() => assertPrivatePermissionsBatch(paths), { code: 'PRIVATE_PERMISSIONS' });
  assert.throws(() => assertPrivatePermissionsBatch([{ path: join(directory, 'required-missing'), kind: 'file' }]), { code: 'ENOENT' });
});

test('Windows metadata checks use ordinary inherited directory permissions', { skip: process.platform !== 'win32' }, t => {
  const directory = privateRoot(t);
  const file = join(directory, "literal ' $([path-data]); [fixture].json");
  writeFileSync(file, 'synthetic fixture');
  assert.doesNotThrow(() => securePrivatePermissions(file, 'file'));
  assert.doesNotThrow(() => assertPrivatePermissions(file, 'file'));
  assert.doesNotThrow(() => assertPrivatePermissionsBatch([
    { path: directory, kind: 'directory' },
    { path: file, kind: 'file' },
    { path: join(directory, 'missing'), kind: 'file', optional: true },
  ]));
  assert.throws(() => assertPrivatePermissions(file, 'directory'), { code: 'PRIVATE_PERMISSIONS' });
  assert.doesNotThrow(() => syncPrivateDirectory(directory));
});
