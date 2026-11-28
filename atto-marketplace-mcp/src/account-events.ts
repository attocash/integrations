import { apiUrl, MarketplaceApiError, readBounded } from './marketplace-api.js';
import type { MarketplaceProfile } from './profile-store.js';
import { isEventType, isUuid } from './marketplace-validation.js';

export interface EventCatalogEntry {
  type: string;
  audience: 'PUBLIC' | 'ACCOUNT';
  scope: string | null;
  controllerOnly: boolean;
}

export function canSubscribeToEvent(entry: EventCatalogEntry, profile?: MarketplaceProfile): boolean {
  if (entry.audience === 'PUBLIC') return true;
  if (profile?.authMode === 'controller-session') return true;
  return profile?.authMode === 'scoped-api-key' && !entry.controllerOnly && entry.scope !== null && profile.apiScopes.includes(entry.scope);
}

export async function readEventCatalog(origin: string, signal?: AbortSignal): Promise<EventCatalogEntry[]> {
  const timeout = AbortSignal.timeout(15_000);
  const url = apiUrl(origin, '/v1/discovery/event-types');
  let response: Response;
  try {
    response = await fetch(url, {headers: {accept: 'application/json'}, redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout});
  } catch { throw new MarketplaceApiError('MARKETPLACE_UNAVAILABLE', 'The Marketplace event catalog could not be reached.'); }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    const code = response.status === 401 || response.status === 403 ? 'AUTHORIZATION_DENIED' : 'MARKETPLACE_HTTP';
    throw new MarketplaceApiError(code, `Marketplace event catalog returned HTTP ${response.status}.`, response.status);
  }
  const invalidCatalog = () => new MarketplaceApiError('MARKETPLACE_PROTOCOL', 'Marketplace sent an invalid event catalog.', response.status);
  let value: unknown;
  try {
    const text = await readBounded(response, undefined, 256 * 1024,
      new MarketplaceApiError('MARKETPLACE_UNAVAILABLE', 'The Marketplace event catalog download was interrupted.', response.status));
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof MarketplaceApiError && error.code === 'MARKETPLACE_UNAVAILABLE') throw error;
    throw invalidCatalog();
  }
  if (!value || typeof value !== 'object' || !('types' in value) || !Array.isArray(value.types)
    || value.types.length === 0 || value.types.length > 1024) throw invalidCatalog();
  const seen = new Set<string>();
  return value.types.map(entry => {
    if (!entry || !isEventType(entry.type) || seen.has(entry.type)
      || !['PUBLIC', 'ACCOUNT'].includes(entry.audience)
      || (entry.controllerOnly !== undefined && typeof entry.controllerOnly !== 'boolean')
      || (entry.scope != null && (typeof entry.scope !== 'string' || !/^[a-z][a-z_-]*(?::[a-z_-]+)+$/.test(entry.scope)))
      || (entry.audience === 'PUBLIC' && (entry.scope || entry.controllerOnly))
      || (entry.audience === 'ACCOUNT' && Boolean(entry.scope) === Boolean(entry.controllerOnly))) {
      throw invalidCatalog();
    }
    seen.add(entry.type);
    return {type: entry.type, audience: entry.audience, scope: entry.scope ?? null, controllerOnly: entry.controllerOnly ?? false};
  });
}

export type AccountEvent = Record<string, string> & {id: string; type: string};

export function isCursor(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
}

function invalidEvent(): Error { return new Error('Marketplace sent an invalid event. The listener kept its last acknowledged cursor.'); }

function parseEvent(id: string, data: string, accountId: string | undefined, subscribed: string[]): AccountEvent {
  let value: Record<string, unknown>;
  try { value = JSON.parse(data); } catch { throw invalidEvent(); }
  if (!value || !isCursor(id) || value.id !== id || value.accountId !== accountId
    || !isEventType(value.type) || !subscribed.includes(value.type)) throw invalidEvent();
  const event: AccountEvent = {id, type: value.type};
  if (accountId) event.accountId = accountId;
  for (const [key, detail] of Object.entries(value)) {
    if (key === 'id' || key === 'type' || key === 'accountId') continue;
    const valid = /^[a-z][A-Za-z0-9]{0,49}Id$/.test(key) ? isUuid(detail)
      : /^(?:[a-z][A-Za-z0-9]{0,49}(?:Cursor|Version)|cursor|version|position|ordinal)$/.test(key)
        ? typeof detail === 'string' && (detail === '0' || isCursor(detail))
        : (key === 'status' || key === 'closeReason') && typeof detail === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(detail);
    if (!valid) throw invalidEvent();
    event[key] = detail as string;
  }
  if (event.type === 'application.hired' && (!accountId || !isUuid(event.applicationId) || !isUuid(event.taskId))) throw invalidEvent();
  return event;
}

export class RetryListener extends Error {}

/** SSE frames are separated by blank lines. Discard an unfinished frame on disconnect. */
export async function* readAccountEvents(body: ReadableStream<Uint8Array>, accountId: string | undefined,
  subscribed: string[]): AsyncGenerator<AccountEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const maxFrameBytes = 64 * 1024;
  let fragments: Uint8Array[] = [];
  let frameBytes = 0;
  let afterCR = false;
  let id = '', event = '';
  let data: string[] = [];
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); }
      catch { throw new RetryListener('Marketplace event connection interrupted.'); }
      if (chunk.done) return;
      const bytes = chunk.value;
      let start = 0;
      for (let index = 0; index < bytes.length; index++) {
        const byte = bytes[index];
        if (afterCR && byte === 10) { afterCR = false; start = index + 1; continue; }
        afterCR = byte === 13;
        if (++frameBytes > maxFrameBytes) throw invalidEvent();
        if (byte !== 10 && byte !== 13) continue;
        fragments.push(bytes.subarray(start, index));
        let line: string;
        try { line = decoder.decode(Buffer.concat(fragments)); } catch { throw invalidEvent(); }
        fragments = [];
        start = index + 1;
        if (!line) {
          if (event || data.length || id) {
            if (event !== 'marketplace' || !data.length) throw invalidEvent();
            yield parseEvent(id, data.join('\n'), accountId, subscribed);
          }
          frameBytes = 0;
          id = event = '';
          data = [];
        } else {
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'id') id = value;
          if (field === 'event') event = value;
          if (field === 'data') data.push(value);
        }
      }
      if (start < bytes.length) fragments.push(bytes.slice(start));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
