import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { publishRelease } from '../scripts/publish-release.mjs';

const execute = promisify(execFile);
const version = '0.2.0';
const names = ['@attocash/cli', '@attocash/mcp'];
const oidc = { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/oidc', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-test-token' };

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'atto-publisher-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifacts = [];
  for (const name of names) {
    const short = name.split('/')[1];
    const stage = join(directory, short);
    await mkdir(join(stage, 'package'), { recursive: true });
    const manifest = { name, version, ...(short === 'mcp' ? { dependencies: { '@attocash/cli': version } } : {}), ...overrides[short] };
    await writeFile(join(stage, 'package/package.json'), JSON.stringify(manifest));
    const path = join(directory, `attocash-${short}-${version}.tgz`);
    await execute('tar', ['-czf', path, '-C', stage, 'package/package.json'], { timeout: 10_000 });
    const integrity = `sha512-${createHash('sha512').update(await readFile(path)).digest('base64')}`;
    artifacts.push({ name, path, metadata: { ...manifest, dist: { integrity } } });
  }

  const records = new Map();
  const latest = new Map();
  const modes = new Map();
  const publishErrors = new Map();
  const requests = [];
  const commands = [];
  const delayedReads = new Map();
  let npmVersion = '11.5.1';
  let registryFailure;
  const fetch = async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://registry.npmjs.org');
    const [encodedName, requested] = parsed.pathname.slice(1).split('/');
    const name = decodeURIComponent(encodedName);
    requests.push({ name, requested, options });
    if (registryFailure) return new Response('registry failure', { status: registryFailure });
    if (requested === 'latest') return latest.has(name) ? Response.json(latest.get(name)) : new Response(null, { status: 404 });
    assert.equal(decodeURIComponent(requested), version);
    if ((delayedReads.get(name) ?? 0) > 0) {
      delayedReads.set(name, delayedReads.get(name) - 1);
      return new Response(null, { status: 404 });
    }
    return records.has(name) ? Response.json(records.get(name)) : new Response(null, { status: 404 });
  };
  const runNpm = async args => {
    commands.push(args);
    if (args[0] === '--version') return { stdout: npmVersion };
    assert.equal(args[0], 'publish');
    const entry = artifacts.find(entry => entry.path === args[1]);
    assert.ok(entry, 'Only the exact local artifact can be published.');
    assert.equal(args[1], resolve(args[1]));
    assert.deepEqual(args.slice(2), ['--provenance', '--access', 'public', '--registry=https://registry.npmjs.org/']);
    const mode = modes.get(entry.name);
    if (mode !== 'not-accepted') {
      records.set(entry.name, entry.metadata);
      latest.set(entry.name, entry.metadata);
    }
    if (mode === 'delayed') delayedReads.set(entry.name, 1);
    if (mode === 'uncertain' || mode === 'not-accepted') throw publishErrors.get(entry.name) ?? new Error('Synthetic npm failure; no real publisher is called.');
    return { stdout: 'published' };
  };
  const options = { fetch, runNpm, env: oidc, propagationAttempts: 2, propagationDelayMs: 0 };
  return {
    directory, artifacts, records, latest, modes, publishErrors, requests, commands, options,
    publish: extra => publishRelease(version, directory, { ...options, ...extra }),
    publishedNames: () => commands.filter(args => args[0] === 'publish').map(args => artifacts.find(entry => entry.path === args[1]).name),
    setNpmVersion: value => { npmVersion = value; }, setRegistryFailure: value => { registryFailure = value; },
  };
}

test('publisher validates both artifacts, uses absolute paths, and publishes CLI before MCP', async t => {
  // Given
  const release = await fixture(t);

  // When
  const results = await release.publish();

  // Then
  assert.deepEqual(release.publishedNames(), names);
  assert.deepEqual(results.map(entry => entry.status), ['published', 'published']);
  for (const request of release.requests) {
    assert.equal(request.options.credentials, 'omit');
    assert.equal(request.options.redirect, 'error');
    assert.ok(request.options.signal instanceof AbortSignal);
  }
});

test('release versions reject trailing newlines and all surrounding whitespace', async t => {
  // Given
  const release = await fixture(t);

  // When / Then
  for (const invalid of ['0.2.0\n', '0.2.0\r\n', ' 0.2.0', '0.2.0 ', '0.2.0\t']) {
    await assert.rejects(publishRelease(invalid, release.directory, release.options), { code: 'INVALID_VERSION' });
  }
  assert.deepEqual(release.requests, []);
  assert.deepEqual(release.commands, []);
});

test('partial publication retry skips the matching CLI and publishes only MCP', async t => {
  // Given
  const release = await fixture(t);
  release.modes.set('@attocash/mcp', 'not-accepted');
  await assert.rejects(release.publish(), { code: 'PUBLICATION_UNCONFIRMED' });
  assert.deepEqual(release.publishedNames(), names);
  release.modes.delete('@attocash/mcp');

  // When
  const results = await release.publish();

  // Then
  assert.deepEqual(results.map(entry => entry.status), ['existing', 'published']);
  assert.deepEqual(release.publishedNames(), ['@attocash/cli', '@attocash/mcp', '@attocash/mcp']);
});

test('an uncertain npm command is confirmed by exact registry integrity without republishing', async t => {
  // Given
  const release = await fixture(t);
  release.modes.set('@attocash/cli', 'uncertain');
  release.publishErrors.set('@attocash/cli', Object.assign(new Error('synthetic command error'), { stderr: 'npm error code ECONNRESET\n' }));
  release.modes.set('@attocash/mcp', 'delayed');

  // When
  const results = await release.publish();

  // Then
  assert.deepEqual(results.map(entry => entry.status), ['published', 'published']);
  assert.deepEqual(release.publishedNames(), names);
});

test('existing exact pair skips publishing without OIDC or npm access', async t => {
  // Given
  const release = await fixture(t);
  for (const entry of release.artifacts) release.records.set(entry.name, entry.metadata);
  release.latest.set('@attocash/cli', { name: '@attocash/cli', version: '0.3.0' });
  release.latest.set('@attocash/mcp', { name: '@attocash/mcp', version: '0.3.0' });

  // When
  const results = await release.publish({ env: {} });

  // Then
  assert.deepEqual(results.map(entry => entry.status), ['existing', 'existing']);
  assert.deepEqual(release.commands, []);
});

test('a conflicting second artifact blocks publishing the first package', async t => {
  // Given
  const release = await fixture(t);
  release.records.set('@attocash/mcp', { ...release.artifacts[1].metadata, dist: { integrity: 'sha512-conflicting-bytes' } });

  // When / Then
  await assert.rejects(release.publish(), { code: 'RELEASE_CONFLICT' });
  assert.deepEqual(release.commands, []);
});

test('registry name, version, and exact MCP dependency mismatches are conflicts', async t => {
  // Given
  const release = await fixture(t);
  const base = release.artifacts[1].metadata;

  // When / Then
  for (const metadata of [{ ...base, name: '@attocash/other' }, { ...base, version: '0.1.9' },
    { ...base, dependencies: { '@attocash/cli': '^0.2.0' } }]) {
    release.records.set('@attocash/mcp', metadata);
    await assert.rejects(release.publish(), { code: 'RELEASE_CONFLICT' });
  }
  assert.deepEqual(release.commands, []);
});

test('tarball name, version, or dependency mismatch blocks every registry mutation', async t => {
  // Given / When / Then
  for (const invalid of [{ mcp: { name: '@attocash/other' } }, { mcp: { version: '0.1.0' } },
    { mcp: { dependencies: { '@attocash/cli': '^0.2.0' } } }]) {
    const release = await fixture(t, invalid);
    await assert.rejects(release.publish(), { code: 'INVALID_ARTIFACT' });
    assert.deepEqual(release.commands, []);
    assert.deepEqual(release.requests, []);
  }
});

test('registry errors are never interpreted as unpublished versions', async t => {
  // Given
  const release = await fixture(t);
  release.setRegistryFailure(503);

  // When / Then
  await assert.rejects(release.publish(), { code: 'REGISTRY_UNAVAILABLE' });
  assert.deepEqual(release.commands, []);
  await assert.rejects(release.publish({ fetch: async () => { throw new Error('synthetic network error'); } }), { code: 'REGISTRY_UNAVAILABLE' });
  assert.deepEqual(release.commands, []);
});

test('malformed or oversized registry metadata is never interpreted as unpublished', async t => {
  // Given
  const release = await fixture(t);

  // When / Then
  for (const body of ['null', 'false', '[]', 'invalid-json', ' '.repeat(1024 * 1024 + 1)]) {
    await assert.rejects(release.publish({ fetch: async () => new Response(body) }), { code: 'REGISTRY_UNAVAILABLE' });
  }
  assert.deepEqual(release.commands, []);
});

test('older workflow retries cannot move latest backwards', async t => {
  // Given
  const release = await fixture(t);
  release.latest.set('@attocash/mcp', { name: '@attocash/mcp', version: '0.10.0' });

  // When / Then
  await assert.rejects(release.publish(), { code: 'LATEST_CONFLICT' });
  assert.deepEqual(release.commands, []);
});

test('actual publishing requires OIDC, no tokens, and npm 11.5.1 or newer', async t => {
  // Given
  const release = await fixture(t);

  // When / Then
  await assert.rejects(release.publish({ env: {} }), { code: 'OIDC_REQUIRED' });
  await assert.rejects(release.publish({ env: { ...oidc, NPM_TOKEN: 'synthetic-old-token' } }), { code: 'TOKEN_NOT_ALLOWED' });
  await assert.rejects(release.publish({ env: { ...oidc, NODE_AUTH_TOKEN: 'synthetic-placeholder' } }), { code: 'TOKEN_NOT_ALLOWED' });
  for (const oldVersion of ['10.9.9', '11.5.0']) {
    release.setNpmVersion(oldVersion);
    await assert.rejects(release.publish(), { code: 'NPM_VERSION' });
  }
  assert.deepEqual(release.publishedNames(), []);
});

test('unconfirmed publication stops before publishing the dependent package', async t => {
  // Given
  const release = await fixture(t);
  release.modes.set('@attocash/cli', 'not-accepted');

  // When / Then
  await assert.rejects(release.publish(), { code: 'PUBLICATION_UNCONFIRMED' });
  assert.deepEqual(release.publishedNames(), ['@attocash/cli']);
});

test('unconfirmed publication preserves only the diagnostic npm code', async t => {
  // Given
  const release = await fixture(t);
  release.modes.set('@attocash/cli', 'not-accepted');

  // When / Then
  for (const prefix of ['npm error', 'npm ERR!']) {
    release.publishErrors.set('@attocash/cli', Object.assign(new Error('synthetic-secret-message'), {
      stderr: `${prefix} code ENEEDAUTH\n${prefix} synthetic-secret-stderr\n`,
    }));
    await assert.rejects(release.publish(), error => {
      assert.equal(error.code, 'PUBLICATION_UNCONFIRMED');
      assert.equal(error.npmCode, 'ENEEDAUTH');
      assert.match(error.message, /npm publish reported ENEEDAUTH\./);
      assert.doesNotMatch(error.message, /synthetic-secret/);
      assert.equal(error.stderr, undefined);
      return true;
    });
  }
  assert.deepEqual(release.publishedNames(), ['@attocash/cli', '@attocash/cli']);
});
