import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { AttoError } from '../domain/errors.js';
import { defaultDataDirectory } from './state.js';

export interface WalletProfile {
  directory: string;
  credentialAccount: string;
  credentialService: 'Atto CLI' | 'Atto MCP';
}

interface ProfileMetadata {
  version: 1;
  credentialService: WalletProfile['credentialService'];
  defaultCli?: boolean;
}

function standardCliDirectory(): string {
  if (process.platform === 'win32') return resolve(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Atto CLI');
  if (process.platform === 'darwin') return resolve(homedir(), 'Library', 'Application Support', 'Atto CLI');
  return resolve(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'atto-cli');
}

/** Existing installations keep their original wallet directory. */
export function defaultCliDirectory(): string {
  const legacy = resolve(defaultDataDirectory());
  const standard = standardCliDirectory();
  if (readProfile(join(standard, 'profile.json'))?.defaultCli === true) return standard;
  return existsSync(join(legacy, 'state.sqlite')) ? legacy : standard;
}

export function dedicatedMcpDirectory(): string {
  return resolve(defaultDataDirectory(), 'profiles', 'mcp');
}

function readProfile(file: string): ProfileMetadata | undefined {
  try {
    const info = statSync(file);
    if (!info.isFile() || info.size > 4096) throw new Error();
    const profile = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown; credentialService?: unknown; defaultCli?: unknown } | null;
    if (profile?.version !== 1 || (profile.credentialService !== 'Atto CLI' && profile.credentialService !== 'Atto MCP')
      || (profile.defaultCli !== undefined && typeof profile.defaultCli !== 'boolean')) throw new Error();
    return { version: 1, credentialService: profile.credentialService,
      ...(profile.defaultCli === undefined ? {} : { defaultCli: profile.defaultCli }) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new AttoError('PROFILE_METADATA', 'The wallet profile metadata is invalid or unavailable. Restore it before opening this wallet.');
  }
}

function cliCredentialService(directory: string, initialize: boolean): WalletProfile['credentialService'] {
  const file = join(directory, 'profile.json');
  const existing = readProfile(file);
  if (existing) return existing.credentialService;
  // An older --data-dir may already equal the new CLI default. Its credential
  // remains under the original service; never infer a migration from its path.
  if (existsSync(join(directory, 'state.sqlite'))) return 'Atto MCP';
  if (!initialize) return 'Atto CLI';
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const defaultCli = !existsSync(join(defaultDataDirectory(), 'state.sqlite'));
    writeFileSync(file, JSON.stringify({ version: 1, credentialService: 'Atto CLI', defaultCli }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new AttoError('PROFILE_METADATA', 'The wallet profile metadata could not be saved. Check directory access before opening this wallet.');
    }
  }
  const profile = readProfile(file);
  if (!profile) throw new AttoError('PROFILE_METADATA', 'The wallet profile metadata disappeared before this wallet could be opened.');
  return profile.credentialService;
}

/** Resolve one shared identity for CLI and MCP. A fresh standard CLI profile
 * receives public metadata before StateStore creates its database. No keys move. */
export function resolveWalletProfile(directory = defaultCliDirectory()): WalletProfile {
  return walletProfile(directory, true);
}

/** Inspect the same profile selection without creating metadata or wallet state. */
export function inspectWalletProfile(directory = defaultCliDirectory()): WalletProfile {
  return walletProfile(directory, false);
}

function walletProfile(directory: string, initialize: boolean): WalletProfile {
  const absolute = resolve(directory);
  return {
    directory: absolute,
    credentialAccount: absolute === resolve(defaultDataDirectory())
      ? 'default' : createHash('sha256').update(absolute).digest('hex'),
    credentialService: absolute === standardCliDirectory() ? cliCredentialService(absolute, initialize) : 'Atto MCP',
  };
}
