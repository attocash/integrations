import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { AttoAccount, AttoAccountEntry, AttoAddress, AttoAmount, AttoHash, AttoInstant, AttoReceivable, AttoTransaction, AttoUnit, toAttoHeight, type AttoJob } from '@attocash/commons-core';
import { AccountHeightSearch, HeightSearch } from '@attocash/commons-node';
import { AttoNodeClientAsyncBuilder } from '@attocash/commons-node-remote';
import { AttoError } from '../domain/errors.js';
import { amountRaw } from '../domain/amount.js';
import type { ListRequest, StreamFilter, WalletSettings } from '../wallet/types.js';

// Ktor's Node engine uses require while Commons is imported as ESM.
Object.assign(globalThis, { require: createRequire(import.meta.url) });

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_HEIGHT = 18446744073709551615n;
const numericStrings = new Set(['amount', 'balance', 'previousBalance', 'height', 'fromHeight', 'toHeight', 'weight']);
type Model = AttoAccount | AttoAccountEntry | AttoReceivable | AttoTransaction;
type HistoryCursor = { version: 1; scope: string; addressIndex: number; nextHeight: string; upper: Array<string | null> };

function jsonExact(text: string): unknown {
  return JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value === 'number' && (numericStrings.has(key) || !Number.isSafeInteger(value))) {
      if (!context?.source) throw new AttoError('UNSUPPORTED_RUNTIME', 'Exact JSON numbers require Node.js 24 or later.');
      return context.source;
    }
    return value;
  });
}

export function publicModel(model: unknown): unknown {
  if (model === null || model === undefined) return null;
  if (typeof model === 'object' && 'toJson' in model && typeof model.toJson === 'function') {
    return jsonExact(model.toJson());
  }
  return jsonExact(JSON.stringify(model, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
}

export function parseAddress(value: string): AttoAddress {
  try { return AttoAddress.parse(value); }
  catch { throw new AttoError('INVALID_ADDRESS', 'Provide a valid Atto address.'); }
}

function parseHash(value: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new AttoError('INVALID_HASH', 'Provide a 64-character hexadecimal hash.');
  return value.toUpperCase();
}

function height(value: string, allowZero = false): string {
  if (!/^\d+$/.test(value) || BigInt(value) > MAX_HEIGHT || (!allowZero && BigInt(value) === 0n)) {
    throw new AttoError('INVALID_HEIGHT', 'Height must be a positive unsigned 64-bit integer string.');
  }
  return BigInt(value).toString();
}

export function normalizeFilter(filter: StreamFilter): StreamFilter {
  if (!['account', 'transaction', 'entry', 'receivable'].includes(filter.event)) {
    throw new AttoError('INVALID_FILTER', 'Unknown network event type.');
  }
  const addresses = filter.addresses?.length ? [...new Set(filter.addresses.map(value => parseAddress(value).value))] : undefined;
  if (addresses && addresses.length > 100) throw new AttoError('INVALID_FILTER', 'Use at most 100 addresses per request.');
  if (filter.hash && (addresses || !['transaction', 'entry'].includes(filter.event))) {
    throw new AttoError('INVALID_FILTER', 'Hash filters support transactions or entries and cannot include addresses.');
  }
  if ((filter.fromHeight || filter.toHeight) && (!addresses || !['transaction', 'entry'].includes(filter.event))) {
    throw new AttoError('INVALID_FILTER', 'Height ranges require address-specific transactions or entries.');
  }
  if (filter.event === 'receivable' && !addresses) throw new AttoError('INVALID_FILTER', 'Receivable streams require at least one address.');
  if (filter.minAmountRaw !== undefined && filter.event !== 'receivable') {
    throw new AttoError('INVALID_FILTER', 'Minimum amounts apply only to receivables.');
  }
  const fromHeight = addresses && ['transaction', 'entry'].includes(filter.event) ? height(filter.fromHeight ?? '1') : undefined;
  const toHeight = filter.toHeight !== undefined ? height(filter.toHeight) : undefined;
  if (fromHeight && toHeight && BigInt(fromHeight) > BigInt(toHeight)) throw new AttoError('INVALID_HEIGHT', 'From height must not exceed to height.');
  return {
    event: filter.event,
    ...(addresses ? { addresses } : {}),
    ...(filter.hash ? { hash: parseHash(filter.hash) } : {}),
    ...(fromHeight ? { fromHeight } : {}),
    ...(toHeight ? { toHeight } : {}),
    ...(filter.event === 'receivable' ? { minAmountRaw: amountRaw(filter.minAmountRaw ?? '0', 'RAW', true) } : {}),
  };
}

export function isReplayable(filter: StreamFilter): boolean {
  return Boolean(filter.addresses?.length && ['transaction', 'entry'].includes(filter.event));
}

export function eventPosition(model: unknown): { address: string; height: string } | undefined {
  if (typeof model !== 'object' || model === null || !('address' in model) || !('height' in model)) return;
  const address = model.address as AttoAddress;
  return { address: address.value, height: String(model.height) };
}

export class NodeReader {
  constructor(public readonly settings: WalletSettings, private readonly headers: Record<string, string> = {}) {}

  private async request(path: string, signal: AbortSignal, firstEvent: boolean): Promise<Response> {
    try {
      const response = await fetch(`${this.settings.nodeUrl.replace(/\/$/, '')}/${path}`, {
        redirect: 'error', signal,
        headers: { ...this.headers, accept: firstEvent ? 'application/x-ndjson' : 'application/json' },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new AttoError(response.status === 404 ? 'NOT_FOUND' : 'NODE_HTTP_ERROR', `The node returned HTTP ${response.status}.`, { httpStatus: response.status });
      }
      return response;
    } catch (error) {
      if (error instanceof AttoError) throw error;
      if (signal.aborted) throw new AttoError('CANCELLED', 'The network request was cancelled.');
      throw new AttoError('NODE_UNAVAILABLE', 'The node could not be reached.');
    }
  }

  // Commons' Promise reads do not expose cancellation or HTTP status; finite
  // lookups retain those caller contracts here.
  private async get<T>(path: string, parse: (text: string) => T, signal?: AbortSignal, firstEvent = false): Promise<T | null> {
    const timeout = AbortSignal.timeout(10_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.request(path, combined, firstEvent);
      let body = '';
      const decoder = new TextDecoder();
      let size = 0;
      if (!response.body) throw new AttoError('INVALID_NODE_RESPONSE', 'The node response has no body.');
      const reader = response.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_RESPONSE_BYTES) throw new AttoError('INVALID_NODE_RESPONSE', 'The node response exceeded the size limit.');
          body += decoder.decode(value, { stream: true });
          if (firstEvent && body.includes('\n')) { body = body.slice(0, body.indexOf('\n')); break; }
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      body += decoder.decode();
      if (firstEvent && !body.trim()) return null;
      try { return parse(body); }
      catch { throw new AttoError('INVALID_NODE_RESPONSE', 'The node returned an invalid response.'); }
    } catch (error) {
      if (error instanceof AttoError && error.code === 'NOT_FOUND') return null;
      if (signal?.aborted) throw new AttoError('CANCELLED', 'The network request was cancelled.');
      if (timeout.aborted) throw new AttoError('NODE_TIMEOUT', 'The node request timed out.');
      if (error instanceof AttoError) throw error;
      throw new AttoError('NODE_UNAVAILABLE', 'The node connection failed.');
    }
  }

  account(address: string, signal?: AbortSignal): Promise<AttoAccount | null> {
    return this.get(`accounts/${parseAddress(address).publicKey}`, AttoAccount.fromJson, signal);
  }

  async now(signal?: AbortSignal): Promise<AttoInstant> {
    const requested = AttoInstant.Companion.now().toString();
    const result = await this.get(`instants/${encodeURIComponent(requested)}`, text => {
      const value = JSON.parse(text) as { clientInstant?: unknown; serverInstant?: unknown };
      if (typeof value.clientInstant !== 'string' || typeof value.serverInstant !== 'string'
        || AttoInstant.Companion.fromIso(value.clientInstant).toEpochMilliseconds() !== AttoInstant.Companion.fromIso(requested).toEpochMilliseconds()) throw new Error();
      return AttoInstant.Companion.fromIso(value.serverInstant);
    }, signal);
    if (!result) throw new AttoError('NODE_TIME_UNAVAILABLE', 'The node time API is unavailable. Check the configured node URL.');
    return result;
  }

  transaction(hash: string, signal?: AbortSignal): Promise<AttoTransaction | null> {
    return this.get(`transactions/${parseHash(hash)}`, AttoTransaction.fromJson, signal);
  }

  entry(hash: string, signal?: AbortSignal): Promise<AttoAccountEntry | null> {
    return this.get(`accounts/entries/${parseHash(hash)}/stream`, AttoAccountEntry.fromJson, signal, true);
  }

  voterWeight(address: string): Promise<unknown> {
    return this.get(`vote-weights/${parseAddress(address).path}`, jsonExact);
  }

  async stream(filter: StreamFilter, onEvent: (model: Model) => void, signal: AbortSignal): Promise<void> {
    const normalized = normalizeFilter(filter);
    if (signal.aborted) return;
    const builder = new AttoNodeClientAsyncBuilder(this.settings.nodeUrl);
    for (const [name, value] of Object.entries(this.headers)) builder.header(name, value);
    const client = builder.build();
    const addresses = normalized.addresses?.map(parseAddress);
    const one = addresses?.length === 1 ? addresses[0] : undefined;
    const hash = normalized.hash ? AttoHash.Companion.parse(normalized.hash) : undefined;
    let job: AttoJob | undefined;
    let callbackFailure: { error: unknown } | undefined;
    let complete!: (error?: unknown) => void;
    const cancel = () => {
      // Cancellation before Commons starts its coroutine may omit onCancel.
      // Joining the job also settles that case and waits for transport cleanup.
      void job?.cancelAndJoin().then(() => complete(), complete);
    };
    const emit = (model: Model) => {
      if (signal.aborted || callbackFailure) return;
      // Commons catches Kotlin exceptions; a JS callback error must not escape
      // into its coroutine and leave the subscription promise unresolved.
      try { onEvent(model); }
      catch (error) { callbackFailure = { error }; cancel(); }
    };
    try {
      await new Promise<void>((resolve, reject) => {
        complete = (error?: unknown) => {
          if (callbackFailure) reject(callbackFailure.error);
          else if (error && !signal.aborted) reject(error);
          else resolve();
        };
        if (normalized.event === 'receivable') {
          const minimum = AttoAmount.from(AttoUnit.RAW, normalized.minAmountRaw!);
          job = one
            ? client.onReceivableByPublicKey(one.publicKey, minimum, emit, complete)
            : client.onReceivableByAddresses(addresses!, minimum, emit, complete);
        } else if (normalized.event === 'account') {
          job = one ? client.onAccountByPublicKey(one.publicKey, emit, complete)
            : addresses ? client.onAccountByAddresses(addresses, emit, complete)
            : client.onAccountAll(emit, complete);
        } else {
          const from = toAttoHeight(normalized.fromHeight ?? '1');
          const to = normalized.toHeight ? toAttoHeight(normalized.toHeight) : undefined;
          const search = addresses && !one ? HeightSearch.Companion.fromArray(addresses.map(address => new AccountHeightSearch(address, from, to))) : undefined;
          if (normalized.event === 'entry') {
            job = hash ? client.onAccountEntryByHash(hash, emit, complete)
              : one ? client.onAccountEntryByPublicKey(one.publicKey, from, to, emit, complete)
              : search ? client.onAccountEntryByHeightSearch(search, emit, complete)
              : client.onAccountEntryAll(emit, complete);
          } else {
            job = hash ? client.onTransactionByHash(hash, emit, complete)
              : one ? client.onTransactionByPublicKey(one.publicKey, from, to, emit, complete)
              : search ? client.onTransactionByHeightSearch(search, emit, complete)
              : client.onTransactionAll(emit, complete);
          }
        }
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      });
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof AttoError) throw error;
      // SDK errors may include URLs, headers, and response bodies. Keep them private.
      throw new AttoError('NODE_STREAM_ERROR', 'The node stream failed. Check endpoint availability and node responses.');
    } finally {
      signal.removeEventListener('abort', cancel);
      await job?.cancelAndJoin();
    }
  }

  async list(request: ListRequest, signal?: AbortSignal): Promise<{ items: unknown[]; nextCursor?: string; timedOut: boolean; limitReached?: boolean }> {
    const filter = normalizeFilter(request);
    const limit = request.limit ?? 100;
    const timeoutMs = request.timeoutMs ?? 3_000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new AttoError('INVALID_LIST', 'Use a limit from 1 to 1000 and timeoutMs from 1 to 60000.');
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    const done = new AbortController();
    const combined = AbortSignal.any([timeout, done.signal, ...(signal ? [signal] : [])]);
    const items: unknown[] = [];
    if (!isReplayable(filter)) {
      if (request.cursor) throw new AttoError('INVALID_CURSOR', 'Continuation cursors require address-specific transaction or entry history.');
      await this.stream(filter, model => { items.push(publicModel(model)); if (items.length === limit) done.abort(); }, combined);
      if (signal?.aborted) throw new AttoError('CANCELLED', 'The network request was cancelled.');
      return { items, timedOut: timeout.aborted && !done.signal.aborted, ...(done.signal.aborted ? { limitReached: true } : {}) };
    }
    const scope = createHash('sha256').update(JSON.stringify([this.settings.nodeUrl, this.settings.network, filter])).digest('hex');
    const addresses = filter.addresses!;
    let cursor: HistoryCursor = { version: 1, scope, addressIndex: 0, nextHeight: filter.fromHeight!, upper: addresses.map(() => null) };
    if (request.cursor) {
      try {
        if (request.cursor.length > 20_000) throw new Error();
        const parsed = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')) as HistoryCursor;
        if (parsed.version !== 1 || parsed.scope !== scope || !Number.isInteger(parsed.addressIndex) || parsed.addressIndex < 0 || parsed.addressIndex >= addresses.length || !Array.isArray(parsed.upper) || parsed.upper.length !== addresses.length) throw new Error();
        height(parsed.nextHeight);
        for (const upper of parsed.upper) if (upper !== null) height(upper, true);
        cursor = parsed;
      } catch { throw new AttoError('INVALID_CURSOR', 'The continuation cursor is invalid or belongs to a different query.'); }
    }
    try {
      while (cursor.addressIndex < addresses.length && !combined.aborted) {
        const index = cursor.addressIndex;
        const address = addresses[index]!;
        if (cursor.upper[index] === null) {
          const current = await this.account(address, combined);
          const currentHeight = current ? BigInt(String(current.height)) : 0n;
          cursor.upper[index] = (filter.toHeight && BigInt(filter.toHeight) < currentHeight ? BigInt(filter.toHeight) : currentHeight).toString();
        }
        const upper = cursor.upper[index]!;
        if (BigInt(cursor.nextHeight) <= BigInt(upper)) {
          await this.stream({ ...filter, addresses: [address], fromHeight: cursor.nextHeight, toHeight: upper }, model => {
            const position = eventPosition(model);
            if (!position || position.address !== address || BigInt(position.height) > BigInt(upper)) throw new AttoError('INVALID_NODE_RESPONSE', 'The node returned an event outside the requested account range.');
            if (BigInt(position.height) < BigInt(cursor.nextHeight)) return;
            // Each account stream is height ordered. Never advance over a missing block.
            if (position.height !== cursor.nextHeight) throw new AttoError('HISTORY_GAP', 'The node returned a gap in account history. Retry with a fully synchronized node.');
            items.push(publicModel(model));
            cursor.nextHeight = (BigInt(position.height) + 1n).toString();
            if (items.length === limit) done.abort();
          }, combined);
        }
        if (BigInt(cursor.nextHeight) > BigInt(upper)) {
          cursor.addressIndex++;
          cursor.nextHeight = filter.fromHeight!;
        } else if (!combined.aborted) {
          throw new AttoError('HISTORY_GAP', 'The node closed the stream before the requested history was complete.');
        }
      }
    } catch (error) {
      if (!combined.aborted) throw error;
    }
    if (signal?.aborted) throw new AttoError('CANCELLED', 'The network request was cancelled.');
    return {
      items, timedOut: timeout.aborted && !done.signal.aborted,
      ...(cursor.addressIndex < addresses.length ? { nextCursor: Buffer.from(JSON.stringify(cursor)).toString('base64url') } : {}),
    };
  }
}
