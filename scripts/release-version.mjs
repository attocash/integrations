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
  const lock = readJson(directory, 'package-lock.json');
  const cliLock = lock?.packages?.['atto-cli'];
  const mcpLock = lock?.packages?.['atto-mcp'];
  const rootLock = lock?.packages?.[''];

  if (root?.name !== '@attocash/integrations' || root.private !== true || 'version' in root
      || cli?.name !== '@attocash/cli' || mcp?.name !== '@attocash/mcp'
      || typeof mcp.dependencies?.['@attocash/cli'] !== 'string'
      || lock?.lockfileVersion !== 3 || rootLock?.name !== root.name
      || cliLock?.name !== cli.name || mcpLock?.name !== mcp.name
      || typeof mcpLock.dependencies?.['@attocash/cli'] !== 'string') {
    throw new Error('Expected the private integrations workspace and its version 3 package lock.');
  }

  cli.version = version;
  mcp.version = version;
  mcp.dependencies['@attocash/cli'] = version;
  cliLock.version = version;
  mcpLock.version = version;
  mcpLock.dependencies['@attocash/cli'] = version;
  lock.name = root.name;
  delete lock.version;
  delete rootLock.version;

  // Validate every input before changing any file. Root workspace metadata and
  // unrelated dependency resolutions stay intact; this command never invokes Git.
  for (const [file, value] of [
    ['atto-cli/package.json', cli],
    ['atto-mcp/package.json', mcp],
    ['package-lock.json', lock],
  ]) {
    writeFileSync(resolve(directory, file), `${JSON.stringify(value, null, 2)}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/release-version.mjs <MAJOR.MINOR.PATCH>');
    prepareRelease(process.argv[2]);
    process.stdout.write(`Prepared CLI and MCP version ${process.argv[2]}.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Version preparation failed.'}\n`);
    process.exitCode = 1;
  }
}
