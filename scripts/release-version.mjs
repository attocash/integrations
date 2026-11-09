import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function readJson(directory, file) {
  try {
    return JSON.parse(readFileSync(resolve(directory, file), 'utf8'));
  } catch {
    throw new Error(`Could not read valid JSON from ${file}.`);
  }
}

export function prepareRelease(version, directory = repository) {
  if (typeof version !== 'string' || version !== version.trim() || !stableVersion.test(version)
      || !version.split('.').every(part => Number.isSafeInteger(Number(part)))) {
    throw new Error('Use a stable version in MAJOR.MINOR.PATCH form, without leading zeroes.');
  }

  const root = readJson(directory, 'package.json');
  const cli = readJson(directory, 'atto-cli/package.json');
  const mcp = readJson(directory, 'atto-mcp/package.json');
  const marketplace = readJson(directory, 'atto-marketplace-mcp/package.json');
  const nano = readJson(directory, 'atto-marketplace-nano-adapter/package.json');
  const lock = readJson(directory, 'package-lock.json');
  const cliLock = lock?.packages?.['atto-cli'];
  const mcpLock = lock?.packages?.['atto-mcp'];
  const marketplaceLock = lock?.packages?.['atto-marketplace-mcp'];
  const nanoLock = lock?.packages?.['atto-marketplace-nano-adapter'];
  const rootLock = lock?.packages?.[''];

  if (root?.name !== '@attocash/integrations' || root.private !== true || 'version' in root
      || cli?.name !== '@attocash/cli' || mcp?.name !== '@attocash/mcp'
      || typeof mcp.dependencies?.['@attocash/cli'] !== 'string'
      || marketplace?.name !== '@attocash/marketplace-mcp' || marketplace.dependencies?.['@attocash/cli'] !== cli.version
      || nano?.name !== '@attocash/atto-marketplace-nano-adapter' || nano.dependencies?.['@attocash/cli'] !== cli.version
      || nanoLock?.name !== nano.name || nanoLock.version !== nano.version
      || nanoLock.dependencies?.['@attocash/cli'] !== cli.version
      || lock?.lockfileVersion !== 3 || rootLock?.name !== root.name
      || cliLock?.name !== cli.name || mcpLock?.name !== mcp.name || marketplaceLock?.name !== marketplace.name
      || typeof mcpLock.dependencies?.['@attocash/cli'] !== 'string'
      || marketplaceLock.dependencies?.['@attocash/cli'] !== cli.version) {
    throw new Error('Expected the private integrations workspace and its version 3 package lock.');
  }

  cli.version = version;
  mcp.version = version;
  marketplace.version = version;
  mcp.dependencies['@attocash/cli'] = version;
  marketplace.dependencies['@attocash/cli'] = version;
  nano.dependencies['@attocash/cli'] = version;
  cliLock.version = version;
  mcpLock.version = version;
  marketplaceLock.version = version;
  mcpLock.dependencies['@attocash/cli'] = version;
  marketplaceLock.dependencies['@attocash/cli'] = version;
  nanoLock.dependencies['@attocash/cli'] = version;
  lock.name = root.name;
  delete lock.version;
  delete rootLock.version;

  // Validate every input before changing any file. Root workspace metadata and
  // unrelated dependency resolutions stay intact; this command never invokes Git.
  for (const [file, value] of [
    ['atto-cli/package.json', cli],
    ['atto-mcp/package.json', mcp],
    ['atto-marketplace-mcp/package.json', marketplace],
    ['atto-marketplace-nano-adapter/package.json', nano],
    ['package-lock.json', lock],
  ]) {
    writeFileSync(resolve(directory, file), `${JSON.stringify(value, null, 2)}\n`);
  }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/release-version.mjs <MAJOR.MINOR.PATCH>');
    prepareRelease(process.argv[2]);
    process.stdout.write(`Prepared CLI, wallet MCP, and Marketplace MCP version ${process.argv[2]} and aligned the private Nano adapter dependency pin.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Version preparation failed.'}\n`);
    process.exitCode = 1;
  }
}
