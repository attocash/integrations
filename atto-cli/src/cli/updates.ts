import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gt, prerelease, valid } from 'semver';

const checkInterval = 24 * 60 * 60 * 1000;
const maxCacheBytes = 4096;

interface UpdateCache {
  checkedAt: number;
  latest?: string;
}

function stableVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const version = valid(value);
  return version && prerelease(version) === null ? version : undefined;
}

function readCache(file: string): UpdateCache | undefined {
  try {
    if (statSync(file).size > maxCacheBytes) return undefined;
    const cache = JSON.parse(readFileSync(file, 'utf8')) as Partial<UpdateCache> | null;
    if (!cache || typeof cache.checkedAt !== 'number' || !Number.isFinite(cache.checkedAt) || cache.checkedAt < 0) return undefined;
    return { checkedAt: cache.checkedAt, latest: stableVersion(cache.latest) };
  } catch {
    return undefined;
  }
}

function writeCache(file: string, cache: UpdateCache): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify(cache), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

// Only the CLI calls this module; shared wallet operations and MCP have no
// update-check side effects. Network work runs in an independent, short-lived child.
export function notifyUpdate(currentVersion: string): void {
  try {
    if (!process.stdout.isTTY || !process.stderr.isTTY ||
      (process.env.CI && process.env.CI !== 'false') || process.env.NODE_ENV === 'test' ||
      process.env.NO_UPDATE_NOTIFIER !== undefined || !valid(currentVersion)) return;

    const directory = process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'atto-cli', 'Cache')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Caches', 'atto-cli')
        : join(process.env.XDG_CACHE_HOME && isAbsolute(process.env.XDG_CACHE_HOME)
          ? process.env.XDG_CACHE_HOME : join(homedir(), '.cache'), 'atto-cli');
    const file = join(directory, 'update.json');
    const cache = readCache(file);
    if (cache?.latest && gt(cache.latest, currentVersion)) {
      process.stderr.write(`Atto CLI update available: ${currentVersion} → ${cache.latest}\nUpdate: npm install --global @attocash/cli@${cache.latest}\n`);
    }

    const now = Date.now();
    const age = cache ? now - cache.checkedAt : undefined;
    if (age !== undefined && age >= 0 && age < checkInterval) return;

    // Reserve the attempt before spawning, so an unavailable registry or a
    // failed child does not cause a new request on every command invocation.
    writeCache(file, { checkedAt: now, latest: cache?.latest });
    const child = spawn(process.execPath, [fileURLToPath(new URL('./update-check.js', import.meta.url)), file], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Update notices are optional, including when the cache cannot be written.
  }
}

export async function refreshUpdateCache(file: string): Promise<void> {
  try {
    const cache = readCache(file);
    if (!cache) return;
    const response = await fetch('https://registry.npmjs.org/@attocash%2fcli/latest', {
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return;
    const metadata = await response.json() as { name?: unknown; version?: unknown } | null;
    const latest = metadata?.name === '@attocash/cli' ? stableVersion(metadata.version) : undefined;
    if (latest) writeCache(file, { checkedAt: cache.checkedAt, latest });
  } catch {
    // Keep the last known version and attempt timestamp after any failure.
  }
}
