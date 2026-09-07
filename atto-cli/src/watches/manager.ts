import { createHash, randomUUID } from 'node:crypto';
import { AttoError, errorResult } from '../domain/errors.js';
import { eventPosition, isReplayable, NodeReader, normalizeFilter, publicModel } from '../network/reader.js';
import type { StreamFilter } from '../wallet/types.js';

interface Checkpoints { get<T>(key: string): T | undefined; set(key: string, value: unknown): void }
interface WatchOptions { backoffMs?: number; maxBackoffMs?: number; retention?: number; maxWatches?: number }
interface QueuedEvent { cursor: number; data: unknown; position?: { address: string; height: string }; gap?: boolean }
interface Watch {
  id: string;
  filter: StreamFilter;
  status: 'running' | 'reconnecting' | 'stopped' | 'completed';
  createdAt: string;
  reconnects: number;
  lastError?: { code: string; message: string };
  controller: AbortController;
  task: Promise<void>;
  events: QueuedEvent[];
  sequence: number;
  acknowledged: Record<string, string>;
  observed: Record<string, string>;
  checkpointKey: string;
  seen: Set<string>;
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** Session watches retain events until read; acknowledged heights survive process restarts. */
export class WatchManager {
  private readonly watches = new Map<string, Watch>();
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly retention: number;
  private readonly maxWatches: number;
  private closed = false;

  constructor(private readonly reader: NodeReader, private readonly checkpoints?: Checkpoints, options: WatchOptions = {}) {
    this.backoffMs = options.backoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.retention = options.retention ?? 1000;
    this.maxWatches = options.maxWatches ?? 32;
    if (![this.backoffMs, this.maxBackoffMs, this.retention, this.maxWatches].every(value => Number.isInteger(value) && value > 0)) {
      throw new AttoError('INVALID_WATCH_OPTIONS', 'Watch limits and backoff values must be positive integers.');
    }
  }

  start(input: StreamFilter) {
    if (this.closed) throw new AttoError('WATCH_MANAGER_CLOSED', 'This watch session has closed.');
    if (this.watches.size >= this.maxWatches) {
      const finished = [...this.watches.values()].find(watch => watch.status === 'stopped' || watch.status === 'completed');
      if (finished) this.watches.delete(finished.id);
      else throw new AttoError('WATCH_LIMIT', 'The session watch limit has been reached.');
    }
    const filter = normalizeFilter(input);
    const checkpointKey = `watch:${createHash('sha256').update(JSON.stringify([this.reader.settings.nodeUrl, this.reader.settings.network, filter])).digest('hex')}`;
    const stored = isReplayable(filter) ? this.checkpoints?.get<Record<string, string>>(checkpointKey) : undefined;
    const acknowledged: Record<string, string> = {};
    for (const address of filter.addresses ?? []) {
      const value = stored?.[address];
      if (typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) < 18446744073709551616n) acknowledged[address] = value;
    }
    const watch: Watch = {
      id: randomUUID(), filter, status: 'running', createdAt: new Date().toISOString(), reconnects: 0,
      controller: new AbortController(), task: Promise.resolve(), events: [], sequence: 0,
      acknowledged, observed: { ...acknowledged }, checkpointKey, seen: new Set(),
    };
    this.watches.set(watch.id, watch);
    const filters = isReplayable(filter) ? filter.addresses!.map(address => ({ ...filter, addresses: [address] })) : [filter];
    watch.task = Promise.all(filters.map(part => this.run(watch, part))).then(() => {
      if (!watch.controller.signal.aborted) watch.status = 'completed';
    });
    return this.describe(watch);
  }

  list() { return [...this.watches.values()].map(watch => this.describe(watch)); }

  read(id: string, cursor = 0, limit = 100) {
    const watch = this.get(id);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > watch.sequence || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new AttoError('INVALID_WATCH_CURSOR', 'Use an existing nonnegative cursor and a limit from 1 to 1000.');
    }
    // A supplied cursor acknowledges a prior page. Saving on arrival would lose unread
    // events when a process exits between receiving an event and returning its page.
    let checkpointChanged = false;
    for (const event of watch.events) {
      if (event.cursor > cursor) break;
      const position = event.position;
      if (position && BigInt(position.height) > BigInt(watch.acknowledged[position.address] ?? '0')) {
        watch.acknowledged[position.address] = position.height;
        checkpointChanged = true;
      }
    }
    if (checkpointChanged) this.checkpoints?.set(watch.checkpointKey, { ...watch.acknowledged });
    const page = watch.events.filter(event => event.cursor > cursor).slice(0, limit);
    const oldestCursor = watch.events[0]?.cursor ?? watch.sequence + 1;
    return {
      ...this.describe(watch),
      events: page.map(({ cursor: eventCursor, data }) => ({ cursor: eventCursor, data })),
      nextCursor: page.at(-1)?.cursor ?? cursor,
      gapDetected: cursor < oldestCursor - 1 || page.some(event => event.gap),
      oldestCursor,
      latestCursor: watch.sequence,
    };
  }

  async stop(id: string): Promise<void> {
    const watch = this.get(id);
    watch.status = 'stopped';
    watch.controller.abort();
    await watch.task;
    // Keep buffered events readable after stopping; a new watch may replace the
    // oldest finished watch when the session reaches its retention limit.
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.watches.keys()].map(id => this.stop(id)));
    this.watches.clear();
  }

  private get(id: string): Watch {
    const watch = this.watches.get(id);
    if (!watch) throw new AttoError('WATCH_NOT_FOUND', 'The watch does not exist in this session.');
    return watch;
  }

  private describe(watch: Watch) {
    return {
      id: watch.id, filter: watch.filter, status: watch.status, createdAt: watch.createdAt,
      reconnects: watch.reconnects, replayable: isReplayable(watch.filter),
      ...(watch.lastError ? { lastError: watch.lastError } : {}),
    };
  }

  private append(watch: Watch, data: unknown, position?: QueuedEvent['position'], gap = false) {
    watch.events.push({ cursor: ++watch.sequence, data, ...(position ? { position } : {}), ...(gap ? { gap } : {}) });
    if (watch.events.length > this.retention) watch.events.splice(0, watch.events.length - this.retention);
  }

  private async run(watch: Watch, original: StreamFilter): Promise<void> {
    const signal = watch.controller.signal;
    const replayable = isReplayable(original);
    const address = original.addresses?.[0];
    let delay = this.backoffMs;
    while (!signal.aborted) {
      let filter = original;
      if (replayable && address) {
        const next = BigInt(watch.observed[address] ?? (BigInt(original.fromHeight ?? '1') - 1n).toString()) + 1n;
        const from = next < BigInt(original.fromHeight ?? '1') ? BigInt(original.fromHeight ?? '1') : next;
        if (from > BigInt(original.toHeight ?? '18446744073709551615')) return;
        filter = { ...original, fromHeight: from.toString() };
        watch.observed[address] = (from - 1n).toString();
      }
      try {
        watch.status = 'running';
        await this.reader.stream(filter, model => {
          if (signal.aborted) return;
          const position = replayable ? eventPosition(model) : undefined;
          if (replayable) {
            if (!position || position.address !== address) throw new AttoError('INVALID_NODE_RESPONSE', 'The node returned an event for a different watched account.');
            const last = BigInt(watch.observed[address!] ?? (BigInt(filter.fromHeight!) - 1n).toString());
            if (BigInt(position.height) <= last) return;
            if (BigInt(position.height) !== last + 1n || (filter.toHeight && BigInt(position.height) > BigInt(filter.toHeight))) {
              throw new AttoError('HISTORY_GAP', 'The node returned a gap in watched account history.');
            }
          }
          const data = publicModel(model);
          if (!replayable) {
            const identity = createHash('sha256').update(JSON.stringify(data)).digest('hex');
            if (watch.seen.has(identity)) return;
            watch.seen.add(identity);
            if (watch.seen.size > this.retention) watch.seen.delete(watch.seen.values().next().value!);
          }
          this.append(watch, data, position);
          if (position) watch.observed[position.address] = position.height;
          delay = this.backoffMs;
          watch.status = 'running';
          delete watch.lastError;
        }, signal);
        if (signal.aborted) return;
        if (replayable && address && original.toHeight && BigInt(watch.observed[address] ?? '0') >= BigInt(original.toHeight)) return;
        if (original.hash && watch.events.some(event => !event.gap)) return;
        watch.lastError = { code: 'STREAM_CLOSED', message: 'The node closed the stream; reconnecting.' };
      } catch (error) {
        if (signal.aborted) return;
        const safe = errorResult(error);
        watch.lastError = { code: safe.code, message: safe.message };
      }
      watch.status = 'reconnecting';
      watch.reconnects++;
      if (!replayable) this.append(watch, { type: 'gap', reason: 'disconnected', replayable: false }, undefined, true);
      await sleep(delay, signal);
      delay = Math.min(delay * 2, this.maxBackoffMs);
    }
  }
}
