import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
const REGISTRY = 'https://registry.npmjs.org';
const PACKAGES = ['@attocash/cli', '@attocash/mcp'];

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function stableVersion(value) {
  if (typeof value !== 'string' || value.length > 128 || value.trim() !== value
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw failure('INVALID_VERSION', 'Release versions must use stable X.Y.Z format.');
  }
  return value.split('.').map(BigInt);
}

function newer(candidate, requested) {
  const left = stableVersion(candidate);
  const right = stableVersion(requested);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

async function artifact(name, version, directory) {
  const path = resolve(directory, `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`);
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error();
    // The release job runs on Ubuntu with system tar. Read only this manifest;
    // never extract artifact-controlled paths to the filesystem.
    const { stdout } = await execute('tar', ['-xOf', path, 'package/package.json'], { timeout: 10_000, maxBuffer: 64 * 1024 });
    const manifest = JSON.parse(stdout);
    if (manifest.name !== name || manifest.version !== version) throw new Error();
    if (name === '@attocash/mcp' && manifest.dependencies?.['@attocash/cli'] !== version) throw new Error();
    const hash = createHash('sha512');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return { name, version, path, integrity: `sha512-${hash.digest('base64')}` };
  } catch {
    throw failure('INVALID_ARTIFACT', `${name} must contain the expected name/version and, for MCP, the exact CLI dependency.`);
  }
}

async function registryMetadata(fetchImpl, name, version) {
  let response;
  try {
    response = await fetchImpl(`${REGISTRY}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
      signal: AbortSignal.timeout(10_000), redirect: 'error', credentials: 'omit', headers: { Accept: 'application/json' },
    });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok || !response.body) throw new Error();
    if (Number(response.headers.get('content-length') ?? 0) > 1024 * 1024) throw new Error();
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) throw new Error();
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const metadata = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error();
    return metadata;
  } catch {
    await response?.body?.cancel().catch(() => undefined);
    throw failure('REGISTRY_UNAVAILABLE', `Could not verify ${name}@${version} against the public npm registry.`);
  }
}

function matchingMetadata(metadata, expected) {
  if (metadata?.name !== expected.name || metadata.version !== expected.version
    || metadata.dist?.integrity !== expected.integrity
    || (expected.name === '@attocash/mcp' && metadata.dependencies?.['@attocash/cli'] !== expected.version)) {
    throw failure('RELEASE_CONFLICT', `${expected.name}@${expected.version} already exists with different metadata or artifact bytes.`);
  }
}

function trustedPublishing(env) {
  if (env.GITHUB_ACTIONS !== 'true' || !env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw failure('OIDC_REQUIRED', 'Publishing requires GitHub Actions with id-token: write and npm trusted publishing configured.');
  }
  if (env.NPM_TOKEN || env.NODE_AUTH_TOKEN) throw failure('TOKEN_NOT_ALLOWED', 'Clear NPM_TOKEN and NODE_AUTH_TOKEN; this release uses trusted publishing only.');
}

async function supportedNpm(runNpm) {
  let version;
  try { version = (await runNpm(['--version'])).stdout.trim(); }
  catch { throw failure('NPM_UNAVAILABLE', 'Could not determine the publishing npm version.'); }
  const parts = stableVersion(version);
  if (!newer(version, '11.5.0') || parts[0] < 11n) {
    throw failure('NPM_VERSION', 'Trusted publishing requires npm 11.5.1 or newer.');
  }
}

function npmErrorCode(error) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
  const reported = /^npm (?:error|ERR!) code (E[A-Z0-9_]{1,39})\r?$/m.exec(stderr)?.[1];
  return reported ?? (typeof error?.code === 'string' && error.code.trim() === error.code
    && /^E[A-Z0-9_]{1,39}$/.test(error.code) ? error.code : undefined);
}

/** Publish already-validated artifacts. Runner/fetch injection is for offline tests. */
export async function publishRelease(version, artifactDirectory, options = {}) {
  stableVersion(version);
  const directory = resolve(artifactDirectory);
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const runNpm = options.runNpm ?? (args => execute('npm', args, { cwd: directory, env, timeout: 120_000, maxBuffer: 1024 * 1024 }));
  const attempts = options.propagationAttempts ?? 12;
  const delayMs = options.propagationDelayMs ?? 5000;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 60 || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 30_000) {
    throw failure('INVALID_OPTIONS', 'Registry propagation attempts and delay must be bounded.');
  }

  const artifacts = await Promise.all(PACKAGES.map(name => artifact(name, version, directory)));
  const existing = await Promise.all(artifacts.map(entry => registryMetadata(fetchImpl, entry.name, version)));
  for (let index = 0; index < artifacts.length; index++) {
    if (existing[index]) matchingMetadata(existing[index], artifacts[index]);
  }
  const missing = artifacts.filter((_entry, index) => !existing[index]);
  const checkLatest = async entry => {
    const latest = await registryMetadata(fetchImpl, entry.name, 'latest');
    if (latest && (latest.name !== entry.name || newer(latest.version, version))) {
      throw failure('LATEST_CONFLICT', `Publishing ${entry.name}@${version} could move npm latest backwards.`);
    }
  };
  // Check the complete pair before the first mutation, including a newer MCP
  // release that would otherwise be noticed only after publishing the CLI.
  await Promise.all(missing.map(checkLatest));
  if (missing.length) { trustedPublishing(env); await supportedNpm(runNpm); }

  const results = [];
  for (let index = 0; index < artifacts.length; index++) {
    const entry = artifacts[index];
    if (existing[index]) { results.push({ name: entry.name, version, status: 'existing' }); continue; }
    await checkLatest(entry);
    let publishCode;
    try {
      await runNpm(['publish', entry.path, '--provenance', '--access', 'public', `--registry=${REGISTRY}/`]);
    } catch (error) {
      // The process may fail after registry acceptance. Confirm exact bytes;
      // never issue a second publish command in response to an uncertain result.
      publishCode = npmErrorCode(error);
    }
    try {
      let confirmed = false;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const metadata = await registryMetadata(fetchImpl, entry.name, version);
        if (metadata) { matchingMetadata(metadata, entry); confirmed = true; break; }
        if (attempt + 1 < attempts) await delay(delayMs);
      }
      if (!confirmed) throw failure('PUBLICATION_UNCONFIRMED', `${entry.name}@${version} is not yet confirmed. Retry the workflow to recheck its artifact integrity.`);
    } catch (error) {
      if (publishCode) {
        error.npmCode = publishCode;
        error.message += ` npm publish reported ${publishCode}.`;
      }
      throw error;
    }
    results.push({ name: entry.name, version, status: 'published' });
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw failure('USAGE', 'Usage: node scripts/publish-release.mjs <version> <artifact-directory>');
    const results = await publishRelease(process.argv[2], process.argv[3]);
    for (const entry of results) process.stdout.write(`${entry.name}@${entry.version}: ${entry.status}\n`);
  } catch (error) {
    process.stderr.write(`${error.code ?? 'RELEASE_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
