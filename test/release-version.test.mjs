import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { prepareRelease } from '../scripts/release-version.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const manifests = ['package.json', 'atto-cli/package.json', 'atto-mcp/package.json', 'package-lock.json'];
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'atto-release-version-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'atto-cli'));
  mkdirSync(join(directory, 'atto-mcp'));
  for (const file of manifests) cpSync(join(repository, file), join(directory, file));
  return directory;
}

function snapshot(directory) {
  return manifests.map(file => readFileSync(join(directory, file), 'utf8'));
}

test('Prepares matching package and lock versions', t => {
  // Given
  const directory = fixture(t);
  const before = snapshot(directory);
  const oldLock = readJson(join(directory, 'package-lock.json'));
  // A previous single-package root version must not become a workspace release version.
  oldLock.version = '0.0.8';
  oldLock.packages[''].version = '0.0.8';
  writeFileSync(join(directory, 'package-lock.json'), JSON.stringify(oldLock));

  // When
  prepareRelease('12.34.56', directory);

  // Then
  const cli = readJson(join(directory, 'atto-cli/package.json'));
  const mcp = readJson(join(directory, 'atto-mcp/package.json'));
  const lock = readJson(join(directory, 'package-lock.json'));
  assert.equal(cli.version, '12.34.56');
  assert.equal(mcp.version, '12.34.56');
  assert.equal(mcp.dependencies['@attocash/cli'], '12.34.56');
  assert.equal(lock.packages['atto-cli'].version, '12.34.56');
  assert.equal(lock.packages['atto-mcp'].version, '12.34.56');
  assert.equal(lock.packages['atto-mcp'].dependencies['@attocash/cli'], '12.34.56');
  assert.equal(lock.name, '@attocash/integrations');
  assert.equal(Object.hasOwn(lock, 'version'), false);
  assert.equal(Object.hasOwn(lock.packages[''], 'version'), false);
  assert.equal(readFileSync(join(directory, 'package.json'), 'utf8'), before[0]);
  assert.deepEqual(lock.packages['node_modules/ws'], oldLock.packages['node_modules/ws']);
  assert.deepEqual(lock.packages['node_modules/@attocash/cli'], oldLock.packages['node_modules/@attocash/cli']);
  assert.deepEqual(cli.dependencies, JSON.parse(before[1]).dependencies);
});

test('Repeating preparation preserves manifest bytes', t => {
  // Given
  const directory = fixture(t);
  prepareRelease('0.0.0', directory);
  const before = snapshot(directory);

  // When
  prepareRelease('0.0.0', directory);

  // Then
  assert.deepEqual(snapshot(directory), before);
});

test('Rejects invalid versions without changing manifests', t => {
  // Given
  const directory = fixture(t);
  const before = snapshot(directory);
  const invalid = [
    '', '1', '1.2', 'v1.2.3', '01.2.3', '1.02.3', '1.2.03',
    '1.2.3-beta.1', '1.2.3+build.1', '1.2.3.4', '1.2.3\n', ' 1.2.3', '1.2.3 ',
    '../1.2.3', '1.2.3/../../outside', '1.2.3; touch outside', '$(touch outside)',
    '1.2.9007199254740992', null, undefined, 123, [], {},
  ];

  for (const version of invalid) {
    // When
    assert.throws(() => prepareRelease(version, directory), /stable version/);
    // Then
    assert.deepEqual(snapshot(directory), before);
  }
});

test('Rejects malformed lock JSON without changing packages', t => {
  // Given
  const directory = fixture(t);
  writeFileSync(join(directory, 'package-lock.json'), '{');
  const before = snapshot(directory);

  // When
  assert.throws(() => prepareRelease('1.2.3', directory), /valid JSON from package-lock.json/);

  // Then
  assert.deepEqual(snapshot(directory), before);
});

test('Rejects incomplete workspace lock metadata without changes', t => {
  // Given
  const directory = fixture(t);
  const lock = readJson(join(directory, 'package-lock.json'));
  delete lock.packages['atto-mcp'];
  writeFileSync(join(directory, 'package-lock.json'), JSON.stringify(lock));
  const before = snapshot(directory);

  // When
  assert.throws(() => prepareRelease('1.2.3', directory), /private integrations workspace/);

  // Then
  assert.deepEqual(snapshot(directory), before);
});

test('Command targets its checkout through a symlink and rejects extra arguments', t => {
  // Given
  const directory = fixture(t);
  mkdirSync(join(directory, 'scripts'));
  const script = join(directory, 'scripts/release-version.mjs');
  cpSync(join(repository, 'scripts/release-version.mjs'), script);
  const linkedScripts = join(directory, 'linked-scripts');
  symlinkSync(join(directory, 'scripts'), linkedScripts, 'junction');
  const sourceBefore = snapshot(repository);

  // When
  const output = execFileSync(process.execPath, [join(linkedScripts, 'release-version.mjs'), '2.3.4'], { cwd: tmpdir(), encoding: 'utf8' });

  // Then
  assert.match(output, /Prepared CLI and MCP version 2\.3\.4/);
  assert.equal(readJson(join(directory, 'atto-cli/package.json')).version, '2.3.4');
  assert.deepEqual(snapshot(repository), sourceBefore);
  const before = snapshot(directory);
  // When
  const rejected = spawnSync(process.execPath, [script, '2.3.5', 'unexpected'], { encoding: 'utf8' });
  // Then
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Usage:/);
  assert.deepEqual(snapshot(directory), before);
});

test('Built CLI and MCP report their package versions', async t => {
  // Given
  const directory = fixture(t);
  for (const workspace of ['atto-cli', 'atto-mcp']) {
    cpSync(join(repository, workspace, 'dist'), join(directory, workspace, 'dist'), { recursive: true });
  }
  symlinkSync(join(repository, 'node_modules'), join(directory, 'node_modules'), 'junction');
  // When
  prepareRelease('3.4.5', directory);

  const cli = execFileSync(process.execPath, [join(directory, 'atto-cli/dist/cli/main.js'), '--version'], { encoding: 'utf8' });
  const mcp = execFileSync(process.execPath, [join(directory, 'atto-mcp/dist/main.js'), '--version'], { encoding: 'utf8' });

  const { createMcpServer } = await import(pathToFileURL(join(directory, 'atto-mcp/dist/server.js')).href);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'atto-release-version-test', version: '1.0.0' });
  const server = createMcpServer({ call: async () => null });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  // Then
  assert.equal(cli.trim(), '3.4.5');
  assert.equal(mcp.trim(), '3.4.5');
  assert.deepEqual(client.getServerVersion(), { name: 'atto', version: '3.4.5' });
});
