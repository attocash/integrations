import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseAddress } from '../network/reader.js';

export const DIRECTORY_URL = 'https://gatekeeper.live.application.atto.cash/projections/addresses';
const FRESH_MS = 3_600_000;
const RETRY_MS = 300_000;
const MAX_BYTES = 2 * 1024 * 1024;
const string = z.string().max(4096);
const address = z.string().max(128).refine(value => { try { return parseAddress(value).value === value; } catch { return false; } });
const entity = z.object({ entity: string, organization: string, label: string, website: string, tags: z.array(string).max(100), addedAt: string, description: string });
const entry = z.object({ address, label: string, entity: string, addedAt: string, description: string });
const voter = entry.extend({ payToAddress: address.nullable(), sharePercentage: z.number().min(0).max(100), voteWeight: z.string().regex(/^\d+$/).max(40), lastVotedAt: string });
export const directorySchema = z.object({ entities: z.array(entity).max(10_000), addresses: z.array(entry).max(10_000), voters: z.array(voter).max(10_000) })
  .superRefine((snapshot, context) => {
    const entities = new Set(snapshot.entities.map(value => value.entity));
    if (entities.size !== snapshot.entities.length || [...snapshot.addresses, ...snapshot.voters].some(value => !entities.has(value.entity))) {
      context.addIssue({ code: 'custom', message: 'Invalid directory entity references.' });
    }
  });
export type DirectorySnapshot = z.infer<typeof directorySchema>;
interface Cache { snapshot?: DirectorySnapshot; fetchedAt?: number; failedAt?: number }

/** Fetches only the public URL, with no wallet addresses or personal labels. */
export async function fetchDirectory(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<DirectorySnapshot> {
  const response = await fetcher(DIRECTORY_URL, { signal: AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])]), redirect: 'error', headers: { accept: 'application/json' } });
  try {
    if (!response.ok || !response.body || !/^application\/json\b/i.test(response.headers.get('content-type') ?? '')
      || Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('Invalid directory response.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) throw new Error('Directory response too large.');
        chunks.push(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    return directorySchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally { if (!response.body?.locked) await response.body?.cancel(); }
}

/** Disposable public cache, kept outside the profile's durable SQLite state. */
export class GlobalDirectory {
  private pending?: Promise<void>;
  private memory: Cache = {};
  private readonly path: string;
  constructor(private readonly directory: string, private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now) {
    this.path = join(directory, 'cache', 'global-addresses.json');
  }
  private read(): Cache {
    try {
      if (statSync(this.path).size > MAX_BYTES + 1024) throw new Error();
      const bytes = readFileSync(this.path);
      if (bytes.length > MAX_BYTES + 1024) throw new Error();
      const cache = JSON.parse(bytes.toString('utf8')) as Cache;
      for (const time of [cache.fetchedAt, cache.failedAt]) if (time !== undefined && (!Number.isSafeInteger(time) || time < 0 || time > 8_640_000_000_000_000 - RETRY_MS)) throw new Error();
      if (cache.snapshot) { cache.snapshot = directorySchema.parse(cache.snapshot); if (cache.fetchedAt === undefined) throw new Error(); }
      return this.memory = cache;
    } catch { return this.memory; }
  }
  private save(cache: Cache): void {
    this.memory = cache;
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      mkdirSync(join(this.directory, 'cache'), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify(cache), { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch { /* Public-cache storage failures must not break wallet operations. */ }
    finally { try { rmSync(temporary, { force: true }); } catch { /* Best effort. */ } }
  }
  cached() {
    const cache = this.read();
    return { snapshot: cache.snapshot, status: { source: DIRECTORY_URL, network: 'LIVE',
      available: Boolean(cache.snapshot), stale: !cache.snapshot || this.now() - cache.fetchedAt! >= FRESH_MS,
      ...(cache.fetchedAt !== undefined ? { fetchedAt: new Date(cache.fetchedAt).toISOString() } : {}),
      ...(cache.failedAt !== undefined ? { lastError: 'DIRECTORY_UNAVAILABLE', retryAt: new Date(cache.failedAt + RETRY_MS).toISOString() } : {}) } };
  }
  async refresh(force = false): Promise<void> {
    if (this.pending) return this.pending;
    const cache = this.read();
    if (!force && ((cache.fetchedAt !== undefined && this.now() - cache.fetchedAt < FRESH_MS)
      || (cache.failedAt !== undefined && this.now() - cache.failedAt < RETRY_MS))) return;
    this.pending = (async () => {
      try { this.save({ snapshot: await fetchDirectory(this.fetcher), fetchedAt: this.now() }); }
      catch { this.save({ ...cache, failedAt: this.now() }); }
    })();
    try { await this.pending; } finally { this.pending = undefined; }
  }
}
