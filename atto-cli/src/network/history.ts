import { createHash } from 'node:crypto';
import { AttoAddress, toAttoHeight } from '@attocash/commons-core';
import { AccountHeightSearch } from '@attocash/commons-node';
import { AttoError } from '../domain/errors.js';
import type { ListRequest, StreamFilter } from '../wallet/types.js';

interface HistoryCursor {
  version: 1;
  scope: string;
  addressIndex: number;
  nextHeight: string;
  upper: Array<string | null>;
}

export interface HistoryPaginationContext<Model> {
  nodeUrl: string;
  network: string;
  batchSize: number;
  parseAddress: (value: string) => AttoAddress;
  parseHeight: (value: string, allowZero?: boolean) => string;
  eventPosition: (model: unknown) => { address: string; height: string } | undefined;
  publicModel: (model: unknown) => unknown;
  accounts: (addresses: string[], signal: AbortSignal) => Promise<Array<{ height: unknown } | null>>;
  subscribe: (filter: StreamFilter, onEvent: (model: Model) => void, signal: AbortSignal, ranges: AccountHeightSearch[]) => Promise<void>;
}

/** Deterministic, resumable multi-account history pagination with frozen per-account heights. */
export async function listPaginatedHistory<Model>(
  ctx: HistoryPaginationContext<Model>,
  filter: StreamFilter,
  request: ListRequest,
  limit: number,
  timeout: AbortSignal,
  signal?: AbortSignal,
): Promise<{ items: unknown[]; nextCursor?: string; timedOut: boolean }> {
  const done = new AbortController();
  const combined = AbortSignal.any([timeout, done.signal, ...(signal ? [signal] : [])]);
  const items: unknown[] = [];
  const last = request.last;
  const historyFilter = last === undefined ? filter : { ...filter, last };
  const scope = createHash('sha256').update(JSON.stringify([ctx.nodeUrl, ctx.network, historyFilter])).digest('hex');
  const addresses = filter.addresses!;
  let cursor: HistoryCursor = { version: 1, scope, addressIndex: 0, nextHeight: filter.fromHeight!, upper: addresses.map(() => null) };

  if (request.cursor) {
    try {
      if (request.cursor.length > 20_000) throw new Error();
      const parsed = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')) as HistoryCursor;
      if (parsed.version !== 1 || parsed.scope !== scope || !Number.isInteger(parsed.addressIndex)
        || parsed.addressIndex < 0 || parsed.addressIndex >= addresses.length
        || !Array.isArray(parsed.upper) || parsed.upper.length !== addresses.length) throw new Error();
      ctx.parseHeight(parsed.nextHeight);
      for (const upper of parsed.upper) if (upper !== null) ctx.parseHeight(upper, true);
      cursor = parsed;
    } catch { throw new AttoError('INVALID_CURSOR', 'The continuation cursor is invalid or belongs to a different query.'); }
  }

  try {
    const fromHeight = BigInt(filter.fromHeight!);
    const firstHeight = (upper: bigint) => {
      if (last === undefined) return fromHeight;
      const start = upper - BigInt(last) + 1n;
      return start > fromHeight ? start : fromHeight;
    };
    const advance = () => {
      while (cursor.addressIndex < addresses.length) {
        const upper = cursor.upper[cursor.addressIndex];
        if (upper == null) return;
        if (BigInt(cursor.nextHeight) <= BigInt(upper)) {
          const start = firstHeight(BigInt(upper));
          if (BigInt(cursor.nextHeight) < start) cursor.nextHeight = start.toString();
          return;
        }
        cursor.addressIndex++;
        cursor.nextHeight = filter.fromHeight!;
      }
    };
    advance();
    while (cursor.addressIndex < addresses.length && !combined.aborted) {
      if (cursor.upper[cursor.addressIndex] === null) {
        // Persist each nearby batch before requesting more heads. A small page
        // need not read every selected account, and a timeout keeps prior work.
        const unresolved = addresses.slice(cursor.addressIndex, cursor.addressIndex + ctx.batchSize)
          .map((address, offset) => ({ address, index: cursor.addressIndex + offset }))
          .filter(({ index }) => cursor.upper[index] === null);
        const heads = await ctx.accounts(unresolved.map(({ address }) => address), combined);
        heads.forEach((account, offset) => {
          const currentHeight = account ? BigInt(String(account.height)) : 0n;
          cursor.upper[unresolved[offset]!.index] = (filter.toHeight && BigInt(filter.toHeight) < currentHeight
            ? BigInt(filter.toHeight) : currentHeight).toString();
        });
        advance();
        if (cursor.addressIndex === addresses.length) break;
        if (cursor.upper[cursor.addressIndex] === null) continue;
      }
      let capacity = limit - items.length;
      const planned: Array<{ index: number; from: bigint; to: bigint; next: bigint; pending: Map<string, Model> }> = [];
      for (let index = cursor.addressIndex; index < addresses.length && capacity > 0 && planned.length < ctx.batchSize; index++) {
        if (cursor.upper[index] === null) break;
        const upper = BigInt(cursor.upper[index]!);
        const from = index === cursor.addressIndex ? BigInt(cursor.nextHeight) : firstHeight(upper);
        if (from > upper) continue;
        const count = upper - from + 1n < BigInt(capacity) ? upper - from + 1n : BigInt(capacity);
        planned.push({ index, from, to: from + count - 1n, next: from, pending: new Map() });
        capacity -= Number(count);
      }
      const ranges = planned.map(range => new AccountHeightSearch(
        ctx.parseAddress(addresses[range.index]!),
        toAttoHeight(range.from.toString()),
        toAttoHeight(range.to.toString()),
      ));
      await ctx.subscribe(filter, model => {
        const position = ctx.eventPosition(model);
        const range = position && planned.find(range => addresses[range.index] === position.address);
        if (!position || !range || BigInt(position.height) < range.from || BigInt(position.height) > range.to) {
          throw new AttoError('INVALID_NODE_RESPONSE', 'The node returned an event outside the requested account range.');
        }
        if (BigInt(position.height) < range.next) return;
        if (BigInt(position.height) !== range.next) {
          throw new AttoError('HISTORY_GAP', 'The node returned a gap in account history. Retry with a fully synchronized node.');
        }
        range.next++;
        range.pending.set(position.height, model);
        // Commit only the contiguous address-ordered prefix. Later-address
        // records remain uncommitted and are safely replayed after a timeout.
        while (cursor.addressIndex < addresses.length) {
          const current = planned.find(range => range.index === cursor.addressIndex);
          const next = current?.pending.get(cursor.nextHeight);
          if (!next) break;
          current!.pending.delete(cursor.nextHeight);
          items.push(ctx.publicModel(next));
          cursor.nextHeight = (BigInt(cursor.nextHeight) + 1n).toString();
          advance();
          if (items.length === limit) { done.abort(); break; }
        }
      }, combined, ranges);
      if (!combined.aborted && planned.some(range => range.next <= range.to)) {
        throw new AttoError('HISTORY_GAP', 'The node closed the stream before the requested history was complete.');
      }
    }
  } catch (error) {
    if (!combined.aborted) throw error;
  }
  if (signal?.aborted) throw new AttoError('CANCELLED', 'The network request was cancelled.');
  return {
    items,
    timedOut: timeout.aborted && !done.signal.aborted,
    ...(cursor.addressIndex < addresses.length ? { nextCursor: Buffer.from(JSON.stringify(cursor)).toString('base64url') } : {}),
  };
}
