import { randomUUID } from 'node:crypto';
import { MarketplaceProfileStore, ProfileError, type MarketplaceProfile } from './profile-store.js';

const REQUEST_TIMEOUT_MS = 15_000;
const COMMAND_WAIT_TIMEOUT_MS = 30_000;
const COMMAND_POLL_INTERVAL_MS = 250;
const RESPONSE_LIMIT_BYTES = 1_048_576;
const TOKEN_LIMIT = 8192;

export interface MarketplaceCommandPointer {
  commandId: string;
  statusUrl: string;
}

interface CommandOrigin {
  operation: 'task-publish';
  target: string;
}

export interface ApiResponse {
  status: number;
  json: unknown;
  headers: Headers;
  command?: MarketplaceCommandPointer;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  auth?: 'required' | 'none';
  allowStatus?: number[];
}

export interface StreamRequestOptions {
  method: 'GET' | 'PUT';
  headers?: Record<string, string>;
  body?: Blob;
  timeoutMs?: number;
  allowStatus?: number[];
}

export class MarketplaceApiError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus?: number,
    readonly details?: Record<string, unknown>) { super(message); }
}

export class MarketplaceApiClient {
  constructor(private readonly profiles: MarketplaceProfileStore, private readonly profileId: string,
    private readonly commandWaitTimeoutMs = COMMAND_WAIT_TIMEOUT_MS,
    private readonly commandPollIntervalMs = COMMAND_POLL_INTERVAL_MS) {}

  async request(path: string, options: RequestOptions = {}): Promise<ApiResponse> {
    const profile = this.profiles.getProfile(this.profileId);
    const response = await this.fetchResponse(profile, path, options, REQUEST_TIMEOUT_MS);
    if (response.status !== 202) return response;
    const pointer = parseCommandPointer(response.json);
    return pointer ? { ...response, command: pointer } : response;
  }

  async resumeCommand(pointer: MarketplaceCommandPointer, origin?: CommandOrigin): Promise<ApiResponse> {
    const profile = this.profiles.getProfile(this.profileId);
    return this.resolveCommand(profile, validateCommandPointer(pointer), origin);
  }

  /** Stream a bounded private file through the pinned profile and normal auth refresh path. */
  async requestStream(path: string, options: StreamRequestOptions): Promise<Response> {
    const profile = this.profiles.getProfile(this.profileId);
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60 * 1000) {
      throw new MarketplaceApiError('MARKETPLACE_TIMEOUT', 'The private file transfer timeout is outside the supported bound.');
    }
    const url = new URL(apiUrl(profile.origin, path));
    const headers: Record<string, string> = { accept: '*/*', ...options.headers,
      authorization: `Bearer ${await this.authorization(profile)}` };
    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method, headers,
        ...(options.body !== undefined ? { body: options.body } : {}),
        redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new MarketplaceApiError('MARKETPLACE_UNAVAILABLE', 'The configured Marketplace endpoint could not complete the private file transfer. Retry the same upload request ID.');
    }
    if (response.url && new URL(response.url).origin !== profile.origin) {
      await response.body?.cancel().catch(() => undefined);
      throw new MarketplaceApiError('MARKETPLACE_ORIGIN', 'Marketplace redirected away from the pinned profile origin.');
    }
    if (!(options.allowStatus ?? [200]).includes(response.status)) {
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        throw new MarketplaceApiError('AUTHORIZATION_DENIED', `Marketplace denied this file operation (HTTP ${response.status}). This profile will not switch credentials or gain authority automatically.`, response.status);
      }
      let detail: Record<string, unknown> | undefined;
      try {
        const text = await readBounded(response);
        const parsed: unknown = text ? JSON.parse(text) : undefined;
        detail = objectRecord(parsed);
      } catch { /* The status remains authoritative when an error body is unreadable. */ }
      const errorCode = typeof detail?.error === 'string' ? detail.error : 'MARKETPLACE_HTTP';
      const message = typeof detail?.message === 'string' ? detail.message
        : `Marketplace returned HTTP ${response.status} for the private file operation.`;
      throw new MarketplaceApiError(errorCode, message, response.status);
    }
    return response;
  }

  private async fetchResponse(profile: MarketplaceProfile, path: string, options: RequestOptions,
    timeoutMs: number): Promise<ApiResponse> {
    const url = new URL(apiUrl(profile.origin, path));
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.auth !== 'none') headers.authorization = `Bearer ${await this.authorization(profile)}`;

    let response: Response;
    try {
        response = await fetch(url, {
        method: options.method ?? 'GET',
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      });
    } catch {
      throw new MarketplaceApiError('MARKETPLACE_UNAVAILABLE', 'The configured Marketplace endpoint could not be reached. For a mutation, retry with the same request ID.');
    }
    if (response.url && new URL(response.url).origin !== profile.origin) {
      await response.body?.cancel().catch(() => undefined);
      throw new MarketplaceApiError('MARKETPLACE_ORIGIN', 'Marketplace redirected away from the pinned profile origin.');
    }
    const publicHistoryPage = response.status === 200
      && (options.method ?? 'GET') === 'GET' && url.pathname === '/v1/discovery/task-history';
    const text = await readBounded(response, publicHistoryPage
      ? new MarketplaceApiError('PUBLIC_HISTORY_PAGE_TOO_LARGE',
        'The public history page exceeds the supported response size. Retry the same filters and cursor with limit:1, then continue using the returned cursor.',
        undefined, { recovery: { action: 'retry-page', scope: 'current-filters', limit: 1 } })
      : undefined);
    let json: unknown = null;
    if (text.length > 0) {
      try { json = JSON.parse(text); }
      catch { throw new MarketplaceApiError('MARKETPLACE_PROTOCOL', 'Marketplace returned a response that was not valid JSON.'); }
    }
    if (!(options.allowStatus ?? [200, 201, 202, 204]).includes(response.status)) {
      const signerError = signerApiError(response.status, json);
      if (signerError) throw signerError;
      if (response.status === 401 || response.status === 403) {
        throw new MarketplaceApiError('AUTHORIZATION_DENIED', `Marketplace denied this operation (HTTP ${response.status}). This profile will not switch credentials or gain authority automatically.`, response.status);
      }
      if (response.status === 400 && (options.method ?? 'GET') === 'GET'
        && url.pathname === '/v1/agent/engagements' && url.searchParams.has('cursor')
        && objectRecord(json)?.error === 'invalid_workspace_query') {
        throw new MarketplaceApiError('INVALID_WORKSPACE_QUERY',
          'Marketplace rejected the engagement history cursor. Restart pagination from the first page for the current account and continue with that page’s cursor.',
          response.status, { serverCode: 'invalid_workspace_query',
            recovery: { action: 'restart-pagination', scope: 'current-account' } });
      }
      if (response.status === 400 && (options.method ?? 'GET') === 'GET'
        && url.pathname === '/v1/discovery/task-history' && url.searchParams.has('cursor')
        && objectRecord(json)?.error === 'invalid_discovery_query') {
        throw new MarketplaceApiError('INVALID_PUBLIC_HISTORY_QUERY',
          'Marketplace rejected the public history cursor or filters. Restart from the first page with the current filters, then continue with that page’s cursor.',
          response.status, { serverCode: 'invalid_discovery_query',
            recovery: { action: 'restart-pagination', scope: 'current-filters' } });
      }
      if (response.status === 400 && (options.method ?? 'GET') === 'POST'
        && url.pathname === '/v1/agent/profile/publish') {
        const requiredFields = missingProfilePublicationFields(json);
        if (requiredFields) {
          const fields = requiredFields.map(field => '`' + field + '`').join(' and ');
          const fieldLabel = requiredFields.length === 1 ? 'field ' : 'fields ';
          throw new MarketplaceApiError('PROFILE_REQUIRED_FIELDS',
            'Marketplace requires profile ' + fieldLabel + fields + ' before publication. Call marketplace_profile_update to set '
              + fields + ', then retry marketplace_profile_publish with the same requestId. The rejected request did not '
              + 'publish the profile, so it remains safe to retry.',
            response.status, {
              serverCode: 'missing_profile_fields',
              requiredFields,
              recovery: { action: 'update-profile-and-retry', reuseRequestId: true },
            });
        }
      }
      if (response.status === 409 && (options.method ?? 'GET') === 'POST'
        && url.search === '' && isTaskActivityPath(url.pathname)) {
        const inactiveActivity = inactiveActivityError(json);
        if (inactiveActivity) throw inactiveActivity;
      }
      if (response.status === 409 && (options.method ?? 'GET') === 'POST'
        && url.search === '' && isTaskPublishPath(url.pathname)) {
        const minimumError = taskMinimumError(json);
        if (minimumError) throw minimumError;
      }
      if ((options.method ?? 'GET') === 'POST' && url.search === ''
        && /^\/v1\/(?:agent\/releases\/[0-9a-f-]+\/purchase|agent\/purchases\/[0-9a-f-]+\/refund)$/.test(url.pathname)) {
        const location=response.headers.get('Location');
        if (location) {
          const match=/^\/v1\/agent\/commands\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(location);
          if (!match) throw new MarketplaceApiError('COMMAND_PROTOCOL','Marketplace returned an unsafe Shop command pointer.');
          const detail=objectRecord(json);
          throw new MarketplaceApiError(typeof detail?.error==='string'?detail.error:'MARKETPLACE_HTTP',
            typeof detail?.message==='string'?detail.message:`Marketplace returned HTTP ${response.status} for the original Shop command.`,
            response.status,{commandId:match[1],statusUrl:location});
        }
      }
      throw new MarketplaceApiError('MARKETPLACE_HTTP', `Marketplace returned HTTP ${response.status} for the requested operation.`, response.status);
    }
    return { status: response.status, json, headers: response.headers };
  }

  private async resolveCommand(profile: MarketplaceProfile, pointer: MarketplaceCommandPointer,
    origin?: CommandOrigin): Promise<ApiResponse> {
    const deadline = Date.now() + this.commandWaitTimeoutMs;
    let lastTransientError: unknown;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      try {
        const response = await this.fetchResponse(profile, pointer.statusUrl,
          { method: 'GET', allowStatus: [200] }, Math.min(REQUEST_TIMEOUT_MS, remaining));
        const status = objectRecord(response.json);
        if (!status || status.commandId !== pointer.commandId || status.statusUrl !== pointer.statusUrl) {
          throw new MarketplaceApiError('COMMAND_PROTOCOL', 'Marketplace returned status for a different durable command.', undefined,
            { commandId: pointer.commandId, statusUrl: pointer.statusUrl });
        }
        if (status.status === 'SETTLED') {
          if (!Object.hasOwn(status, 'result')) {
            throw new MarketplaceApiError('COMMAND_PROTOCOL', 'Marketplace omitted the completed durable command result.', undefined,
              { commandId: pointer.commandId, statusUrl: pointer.statusUrl });
          }
          return { status: 200, json: status.result, headers: response.headers, command: pointer };
        }
        if (status.status === 'REJECTED') {
          const code = typeof status.errorCode === 'string' && /^[A-Z0-9_]{1,64}$/.test(status.errorCode)
            ? status.errorCode : 'COMMAND_REJECTED';
          const httpStatus = Number.isInteger(status.httpStatus) && Number(status.httpStatus) >= 400
            && Number(status.httpStatus) <= 599 ? Number(status.httpStatus) : undefined;
          if (origin?.operation === 'task-publish' && origin.target.length <= 64
            && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(origin.target)
            && pointer.statusUrl === `/v1/agent/commands/${pointer.commandId}`
            && status.errorCode === 'task_minimum' && httpStatus === 409) {
            const minimumError = taskMinimumError(status.result, pointer);
            if (minimumError) throw minimumError;
          }
          throw new MarketplaceApiError(code, 'Marketplace rejected this durable command.', httpStatus,
            { commandId: pointer.commandId, statusUrl: pointer.statusUrl, terminal: true });
        }
        if (status.status !== 'PENDING') {
          throw new MarketplaceApiError('COMMAND_PROTOCOL', 'Marketplace returned an unsupported durable command state.', undefined,
            { commandId: pointer.commandId, statusUrl: pointer.statusUrl });
        }
        lastTransientError = undefined;
      } catch (error) {
        if (error instanceof MarketplaceApiError && error.code !== 'MARKETPLACE_UNAVAILABLE') throw error;
        lastTransientError = error;
      }
      const waitMs = Math.min(this.commandPollIntervalMs, Math.max(0, deadline - Date.now()));
      if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    throw new MarketplaceApiError('COMMAND_PENDING', 'Marketplace accepted this command and it is still unresolved. Resume it with the same request ID; do not submit a replacement.',
      undefined, { commandId: pointer.commandId, statusUrl: pointer.statusUrl,
        ...(lastTransientError instanceof MarketplaceApiError ? { statusErrorCode: lastTransientError.code } : {}) });
  }

  private async authorization(profile: MarketplaceProfile): Promise<string> {
    if (profile.authMode === 'scoped-api-key') {
      if (!profile.apiKey) throw new ProfileError('SETUP_REQUIRED', 'This profile has no scoped API key. Reconfigure it in the local terminal.');
      return profile.apiKey;
    }
    if (profile.authMode !== 'controller-session') throw new ProfileError('AUTH_MODE', 'This profile has no supported authentication mode.');
    if (profile.accessToken && profile.accessExpiresAt && profile.accessExpiresAt > Date.now() + 30_000) return profile.accessToken;

    const attempt = this.profiles.beginRefresh(profile.id);
    if (attempt.kind === 'fresh') return attempt.accessToken;
    if (attempt.kind === 'busy') {
      throw new ProfileError('REFRESH_BUSY',
        'Another Marketplace MCP process is refreshing this profile. Retry after it completes. If the profile stays busy, resolve the existing refresh from the local terminal. This process sent no refresh request.');
    }
    try {
      const response = await fetch(`${profile.origin}/v1/agent/auth/sessions/refresh`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: attempt.refreshToken }),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.url && new URL(response.url).origin !== profile.origin) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('origin changed');
      }
      const body = await readBounded(response);
      if (response.status !== 200) throw new Error('refresh denied');
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { throw new Error('refresh response invalid'); }
      const tokens = parseRotatedTokens(payload);
      this.profiles.completeRefresh(profile.id, attempt.attemptId, tokens);
      return tokens.accessToken;
    } catch {
      this.profiles.failRefresh(profile.id, attempt.attemptId);
      throw new ProfileError('REAUTH_REQUIRED', 'The controller-token refresh outcome is unknown. Reauthenticate from the local terminal before retrying.');
    }
  }
}

function isTaskPublishPath(pathname: string): boolean {
  return /^\/v1\/agent\/tasks\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/publish$/.test(pathname);
}

function isTaskActivityPath(pathname: string): boolean {
  return /^\/v1\/agent\/tasks\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/activity$/.test(pathname);
}

function inactiveActivityError(value: unknown): MarketplaceApiError | undefined {
  const response = objectRecord(value);
  if (response?.error !== 'task_conflict'
    || response.message !== 'Engagement is no longer active.') return undefined;
  return new MarketplaceApiError('ENGAGEMENT_INACTIVE',
    'This new activity was not appended because the task or engagement is no longer active. Read marketplace_engagement_get and marketplace_activity_list. New activity requires IN_PROGRESS/ACTIVE; for future work, send feedback before acceptance or dispute. Do not replace the request or try to reopen the contract.',
    409, { serverCode: 'task_conflict', terminal: true,
      recovery: { action: 'read-engagement-and-activity', replaceRequestAllowed: false } });
}

function taskMinimumError(value: unknown, pointer?: MarketplaceCommandPointer): MarketplaceApiError | undefined {
  const response = objectRecord(value);
  if (response?.error !== 'task_minimum') return undefined;
  const pointerDetails = pointer ? { commandId: pointer.commandId, statusUrl: pointer.statusUrl, terminal: true } : {};
  const recovery = { action: 'reconcile-rejected-publish-then-correct-draft', newRequestIdRequired: true };
  const details = objectRecord(response.details);
  if (!Object.hasOwn(response, 'details') || response.details === null
    || (details !== undefined && Object.keys(details).length === 0)) {
    return new MarketplaceApiError('TASK_MINIMUM',
      'Marketplace rejected this publication because its gross is below the configured asset minimum. First reconcile the terminal rejection for the original request. Then read the private draft’s current version, determine the configured minimum for its asset, update grossAtomic to that amount or higher, and publish the corrected draft with a new requestId. Never retry the rejected requestId with changed arguments.',
      409, { serverCode: 'task_minimum', recovery, ...pointerDetails });
  }
  if (!details) return undefined;
  const keys = Object.keys(details).sort();
  if (keys.length !== 2 || keys[0] !== 'asset' || keys[1] !== 'minimumAtomic'
    || (details.asset !== 'ATTO' && details.asset !== 'XNO')
    || typeof details.minimumAtomic !== 'string'
    || !/^[1-9][0-9]{0,64}$/.test(details.minimumAtomic)) return undefined;

  const asset = details.asset;
  const minimumAtomic = details.minimumAtomic;
  return new MarketplaceApiError('TASK_MINIMUM',
    `Marketplace rejected this publication because the ${asset} gross is below its minimum of ${minimumAtomic} atomic units. First reconcile the terminal rejection for the original request. Then read the private draft’s current version, update grossAtomic to at least ${minimumAtomic}, and publish the corrected draft with a new requestId. Never retry the rejected requestId with changed arguments.`,
    409, { serverCode: 'task_minimum', asset, minimumAtomic, recovery, ...pointerDetails });
}

/** Preserve only the signer's exact public status/code pairs, never upstream diagnostics. */
export function signerApiError(status: number, value: unknown): MarketplaceApiError | undefined {
  const code = objectRecord(value)?.error;
  if (status === 403 && code === 'signer_request_rejected') {
    return new MarketplaceApiError('SIGNER_REQUEST_REJECTED',
      'The Marketplace signer rejected this request. Check the exact controller approval and signer configuration before retrying.',
      403, { serverCode: code });
  }
  if (status === 503 && code === 'signer_unavailable') {
    return new MarketplaceApiError('SIGNER_UNAVAILABLE',
      'The Marketplace signer is temporarily unavailable. Retry the original request with its arguments unchanged.',
      503, { serverCode: code });
  }
  return undefined;
}

export function apiUrl(origin: string, path: string): string {
  if (!path.startsWith('/v1/') || path.startsWith('//') || /[?#\\]/.test(path)) {
    throw new MarketplaceApiError('MARKETPLACE_ROUTE', 'The requested Marketplace route is not in the fixed API allowlist.');
  }
  const result = new URL(path, `${origin}/`);
  if (result.origin !== origin || result.username || result.password || result.hash) {
    throw new MarketplaceApiError('MARKETPLACE_ROUTE', 'The requested Marketplace route escaped the pinned origin.');
  }
  return result.toString();
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function missingProfilePublicationFields(value: unknown): Array<'handle' | 'displayName'> | undefined {
  const response = objectRecord(value);
  if (response?.error !== 'missing_profile_fields') return undefined;
  const details = objectRecord(response.details);
  if (!details) return undefined;
  const supported = ['handle', 'displayName'] as const;
  const keys = Object.keys(details);
  if (keys.length === 0 || keys.length > supported.length
    || keys.some(key => !supported.some(field => field === key))
    || keys.some(key => details[key] !== 'required')) return undefined;
  return supported.filter(field => Object.hasOwn(details, field));
}

export function parseCommandPointer(value: unknown): MarketplaceCommandPointer | undefined {
  const record = objectRecord(value);
  if (!record || !Object.hasOwn(record, 'commandId')) return undefined;
  // Top-up status DTOs also expose commandId/statusUrl, but their status URL is the
  // payment lookup itself and the endpoint has its own x402 receipt semantics.
  if (record.intentId === record.commandId && record.statusUrl === `/v1/agent/topups/${record.intentId}`) return undefined;
  return validateCommandPointer({ commandId: record.commandId as string, statusUrl: record.statusUrl as string });
}

function validateCommandPointer(value: MarketplaceCommandPointer): MarketplaceCommandPointer {
  const commandIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!value || typeof value.commandId !== 'string' || !commandIdPattern.test(value.commandId)
    || value.statusUrl !== `/v1/agent/commands/${value.commandId}`) {
    throw new MarketplaceApiError('COMMAND_PROTOCOL', 'Marketplace returned an invalid durable command pointer.');
  }
  return { commandId: value.commandId, statusUrl: value.statusUrl };
}

export function newRequestId(): string { return randomUUID(); }

async function readBounded(response: Response, overflowError?: MarketplaceApiError): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT_BYTES) {
        throw overflowError ?? new MarketplaceApiError('MARKETPLACE_PROTOCOL', 'Marketplace returned a response larger than the supported limit.');
      }
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof MarketplaceApiError) throw error;
    throw new MarketplaceApiError('MARKETPLACE_PROTOCOL', 'Marketplace returned an invalid or oversized response.');
  } finally {
    reader.releaseLock();
  }
}

function parseRotatedTokens(input: unknown): { accessToken: string; accessExpiresAt: number; refreshToken: string; refreshExpiresAt: number } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('bad refresh');
  const value = input as Record<string, unknown>;
  const token = (raw: unknown): raw is string => typeof raw === 'string' && raw.length >= 16 && raw.length <= TOKEN_LIMIT && !/[\r\n\0]/.test(raw);
  const accessExpiresAt = dateMillis(value.accessExpiresAt);
  const refreshExpiresAt = dateMillis(value.refreshExpiresAt);
  if (!token(value.accessToken) || !token(value.refreshToken) || accessExpiresAt <= Date.now() || refreshExpiresAt < accessExpiresAt) {
    throw new Error('bad refresh');
  }
  return { accessToken: value.accessToken, accessExpiresAt, refreshToken: value.refreshToken, refreshExpiresAt };
}

function dateMillis(value: unknown): number {
  if (typeof value !== 'string') throw new Error('bad date');
  const timestamp = Date.parse(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error('bad date');
  return timestamp;
}

export function commandPointerFromError(error:unknown):MarketplaceCommandPointer|undefined {
  if (!(error instanceof MarketplaceApiError) || !error.details) return undefined;
  try { return parseCommandPointer(error.details); }
  catch { return undefined; }
}
