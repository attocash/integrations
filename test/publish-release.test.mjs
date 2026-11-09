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
const names = ['@attocash/cli', '@attocash/mcp', '@attocash/marketplace-mcp'];
const oidc = { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/oidc', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-test-token' };

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'atto-publisher-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifacts = [];
  for (const name of names) {
    const short = name.split('/')[1];
    const stage = join(directory, short);
    await mkdir(join(stage, 'package'), { recursive: true });
    const manifest = { name, version, ...(short !== 'cli' ? { dependencies: { '@attocash/cli': version } } : {}), ...overrides[short] };
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
  const propagationReads = new Map();
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
    if (mode === 'delayed') delayedReads.set(entry.name, propagationReads.get(entry.name) ?? 1);
    if (mode === 'uncertain' || mode === 'not-accepted') throw publishErrors.get(entry.name) ?? new Error('Synthetic npm failure; no real publisher is called.');
    return { stdout: 'published' };
  };
  const options = { fetch, runNpm, env: oidc, propagationAttempts: 2, propagationDelayMs: 0 };
  return {
    directory, artifacts, records, latest, modes, publishErrors, requests, commands, options, propagationReads,
    publish: extra => publishRelease(version, directory, { ...options, ...extra }),
    publishedNames: () => commands.filter(args => args[0] === 'publish').map(args => artifacts.find(entry => entry.path === args[1]).name),
    setNpmVersion: value => { npmVersion = value; }, setRegistryFailure: value => { registryFailure = value; },
  };
}

test('publisher validates all three artifacts and publishes absolute paths in CLI, MCP, Marketplace MCP order', async t => {
  // Given
  const release = await fixture(t);

  // When
  const results = await release.publish();

  // Then
  assert.deepEqual(release.publishedNames(), names);
  assert.deepEqual(results.map(entry => entry.status), ['published', 'published', 'published']);
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

test('partial publication retry skips the matching CLI and publishes both missing MCP packages', async t => {
  // Given
  const release = await fixture(t);
  release.modes.set('@attocash/mcp', 'not-accepted');
  await assert.rejects(release.publish(), { code: 'PUBLICATION_UNCONFIRMED' });
  assert.deepEqual(release.publishedNames(), ['@attocash/cli', '@attocash/mcp']);
  release.modes.delete('@attocash/mcp');

  // When
  const results = await release.publish();

  // Then
  assert.deepEqual(results.map(entry => entry.status), ['existing', 'published', 'published']);
  assert.deepEqual(release.publishedNames(), ['@attocash/cli', '@attocash/mcp', '@attocash/mcp', '@attocash/marketplace-mcp']);
});

test('partial publication retry skips the matching CLI and MCP and publishes only Marketplace MCP', async t => {
  // Given
  const release = await fixture(t);
  release.modes.set('@attocash/marketplace-mcp', 'not-accepted');
  await assert.rejects(release.publish(), { code: 'PUBLICATION_UNCONFIRMED' });
  assert.deepEqual(release.publishedNames(), names);
  release.modes.delete('@attocash/marketplace-mcp');

  // When
  const results = await release.publish();

  // Then
  assert.deepEqual(results.map(entry => entry.status), ['existing', 'existing', 'published']);
  assert.deepEqual(release.publishedNames(), [...names, '@attocash/marketplace-mcp']);
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
  assert.deepEqual(results.map(entry => entry.status), ['published', 'published', 'published']);
  assert.deepEqual(release.publishedNames(), names);
});

test('default confirmation window tolerates registry visibility after more than twelve reads without republishing', async t => {
  // Given
  const release = await fixture(t);
  release.modes.set('@attocash/cli', 'delayed');
  release.propagationReads.set('@attocash/cli', 28);

  // When
  const results = await release.publish({ propagationAttempts: undefined });

  // Then
  assert.deepEqual(results.map(entry => entry.status), ['published', 'published', 'published']);
  assert.deepEqual(release.publishedNames(), names);
  assert.equal(release.requests.filter(entry => entry.name === '@attocash/cli' && entry.requested === version).length, 30);
});

test('default confirmation window stops after sixty reads and never blindly republishes', async t => {
  // Given
  const release = await fixture(t);
  release.modes.set('@attocash/cli', 'not-accepted');

  // When
  const result = release.publish({ propagationAttempts: undefined });

  // Then
  await assert.rejects(result, { code: 'PUBLICATION_UNCONFIRMED' });
  assert.deepEqual(release.publishedNames(), ['@attocash/cli']);
  assert.equal(release.requests.filter(entry => entry.name === '@attocash/cli' && entry.requested === version).length, 61);
});

test('all three exact existing artifacts skip publishing without OIDC or npm access', async t => {
  // Given
  const release = await fixture(t);
  for (const entry of release.artifacts) release.records.set(entry.name, entry.metadata);
  for (const name of names) release.latest.set(name, { name, version: '0.3.0' });

  // When
  const results = await release.publish({ env: {} });

  // Then
  assert.deepEqual(results.map(entry => entry.status), ['existing', 'existing', 'existing']);
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

test('a conflicting Marketplace artifact blocks publishing either earlier package', async t => {
  // Given
  const release = await fixture(t);
  release.records.set('@attocash/marketplace-mcp', { ...release.artifacts[2].metadata, dist: { integrity: 'sha512-conflicting-bytes' } });

  // When
  const result = release.publish();

  // Then
  await assert.rejects(result, { code: 'RELEASE_CONFLICT' });
  assert.deepEqual(release.commands, []);
});

test('registry name, version, and exact CLI dependency mismatches conflict for both MCP packages', async t => {
  for (const name of names.slice(1)) {
    // Given
    const release = await fixture(t);
    const base = release.artifacts.find(entry => entry.name === name).metadata;

    for (const metadata of [{ ...base, name: '@attocash/other' }, { ...base, version: '0.1.9' },
      { ...base, dependencies: { '@attocash/cli': '^0.2.0' } }, { ...base, dependencies: {} }]) {
      release.records.set(name, metadata);

      // When
      const result = release.publish();

      // Then
      await assert.rejects(result, { code: 'RELEASE_CONFLICT' });
    }
    assert.deepEqual(release.commands, []);
  }
});

test('tarball name, version, or CLI dependency mismatch in either MCP blocks every registry mutation', async t => {
  for (const short of ['mcp', 'marketplace-mcp']) {
    for (const invalid of [{ name: '@attocash/other' }, { version: '0.1.0' },
      { dependencies: { '@attocash/cli': '^0.2.0' } }, { dependencies: {} }]) {
      // Given
      const release = await fixture(t, { [short]: invalid });

      // When
      const result = release.publish();

      // Then
      await assert.rejects(result, { code: 'INVALID_ARTIFACT' });
      assert.deepEqual(release.commands, []);
      assert.deepEqual(release.requests, []);
    }
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

test('an unavailable Marketplace version blocks publishing either earlier package', async t => {
  // Given
  const release = await fixture(t);
  const fetch = (url, options) => decodeURIComponent(new URL(url).pathname).includes('@attocash/marketplace-mcp/')
    ? new Response('synthetic registry failure', { status: 503 })
    : release.options.fetch(url, options);

  // When
  const result = release.publish({ fetch });

  // Then
  await assert.rejects(result, { code: 'REGISTRY_UNAVAILABLE' });
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

test('newer latest on either MCP package blocks an older workflow before publishing the CLI', async t => {
  for (const name of names.slice(1)) {
    // Given
    const release = await fixture(t);
    release.latest.set(name, { name, version: '0.10.0' });

    // When
    const result = release.publish();

    // Then
    await assert.rejects(result, { code: 'LATEST_CONFLICT' });
    assert.deepEqual(release.commands, []);
  }
});

test('Marketplace placeholder and same-core prerelease or build latest permit a stable release', async t => {
  for (const latestVersion of ['0.0.0-stage', '0.2.0-rc.1', '0.2.0-rc.1+build.01', '0.2.0+build.01']) {
    // Given
    const release = await fixture(t);
    release.latest.set('@attocash/marketplace-mcp', { name: '@attocash/marketplace-mcp', version: latestVersion });

    // When
    const results = await release.publish();

    // Then
    assert.deepEqual(results.map(entry => entry.status), ['published', 'published', 'published']);
    assert.deepEqual(release.publishedNames(), names);
  }
});

test('a greater-core Marketplace prerelease latest blocks an older stable release before any publication', async t => {
  // Given
  const release = await fixture(t);
  release.latest.set('@attocash/marketplace-mcp', { name: '@attocash/marketplace-mcp', version: '0.3.0-rc.1+build.01' });

  // When
  const result = release.publish();

  // Then
  await assert.rejects(result, { code: 'LATEST_CONFLICT' });
  assert.deepEqual(release.commands, []);
});

test('malformed Marketplace latest versions block publication including numeric prerelease leading zeros', async t => {
  for (const latestVersion of ['0.0.0-stage\n', '00.0.0-stage', '0.2.0-01', '0.2.0-rc.01',
    '0.2.0-', '0.2.0-rc..1', '0.2.0+', '0.2.0+build..1', 'v0.2.0']) {
    // Given
    const release = await fixture(t);
    release.latest.set('@attocash/marketplace-mcp', { name: '@attocash/marketplace-mcp', version: latestVersion });

    // When
    const result = release.publish();

    // Then
    await assert.rejects(result, { code: 'INVALID_VERSION' });
    assert.deepEqual(release.commands, []);
  }
});

test('requested releases remain stable even when registry latest accepts prerelease versions', async t => {
  // Given
  const release = await fixture(t);

  // When
  const result = publishRelease('0.2.0-rc.1', release.directory, release.options);

  // Then
  await assert.rejects(result, { code: 'INVALID_VERSION' });
  assert.deepEqual(release.requests, []);
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

test('unknown npm errors remain unconfirmed without leaking output or republishing', async t => {
  // Given
  const release = await fixture(t);
  release.modes.set('@attocash/marketplace-mcp', 'not-accepted');
  release.publishErrors.set('@attocash/marketplace-mcp', Object.assign(new Error('synthetic-secret-message'), {
    code: 1, stderr: 'synthetic-secret-stderr',
  }));

  // When
  const result = release.publish();

  // Then
  await assert.rejects(result, error => {
    assert.equal(error.code, 'PUBLICATION_UNCONFIRMED');
    assert.equal(error.npmCode, undefined);
    assert.doesNotMatch(error.message, /synthetic-secret/);
    assert.equal(error.stderr, undefined);
    return true;
  });
  assert.deepEqual(release.publishedNames(), names);
});
