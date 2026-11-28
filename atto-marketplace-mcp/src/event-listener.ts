import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { canSubscribeToEvent, readAccountEvents, readEventCatalog, RetryListener, type AccountEvent, type EventCatalogEntry } from './account-events.js';
import { defaultMarketplaceHome, defaultMarketplaceProfile, productionMarketplaceOrigin } from './defaults.js';
import { isEventType } from './marketplace-validation.js';
import { EventCheckpoint } from './event-checkpoint.js';
import { MarketplaceApiClient, MarketplaceApiError } from './marketplace-api.js';
import { MarketplaceProfileStore, ProfileError, type MarketplaceProfile } from './profile-store.js';

const usage = 'atto-marketplace-mcp listen [--profile <id>] [--home <directory>] [--enqueue-timeout-seconds <seconds>] [--list-types | --types <all|saved|comma-separated-types> -- /absolute/path/to/wake-worker [argument ...]]';

function parseOptions(argv: string[], env: NodeJS.ProcessEnv) {
  const separator = argv.indexOf('--');
  const optionEnd = separator < 0 ? argv.length : separator;
  let profile = env.MARKETPLACE_MCP_PROFILE ?? defaultMarketplaceProfile;
  let explicitProfile = Boolean(env.MARKETPLACE_MCP_PROFILE);
  let home = env.MARKETPLACE_MCP_HOME ?? defaultMarketplaceHome(env);
  let types = 'application.hired';
  let enqueueTimeoutMs = 60_000;
  let listTypes = false;
  for (let i = 0; i < optionEnd; i++) {
    const option = argv[i];
    if (option === '--list-types') { listTypes = true; continue; }
    const value = argv[++i];
    if (i >= optionEnd || !value || value.startsWith('--')) throw new Error(usage);
    if (option === '--home') home = value;
    else if (option === '--profile') { profile = value; explicitProfile = true; }
    else if (option === '--enqueue-timeout-seconds') {
      if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 2_147_483) throw new Error(usage);
      enqueueTimeoutMs = Number(value) * 1_000;
    } else if (option === '--types') {
      if (value !== 'all' && value !== 'saved' && !value.split(',').every(isEventType)) throw new Error(usage);
      types = value;
    } else throw new Error(usage);
  }
  const command = separator < 0 ? '' : argv[separator + 1] ?? '';
  if (listTypes ? separator !== -1 : !isAbsolute(command)) throw new Error(usage);
  return {profile, explicitProfile, home: resolve(home), types, listTypes, enqueueTimeoutMs, command, args: argv.slice(separator + 2)};
}

function workerEnvironment(env: NodeJS.ProcessEnv, profile?: MarketplaceProfile): NodeJS.ProcessEnv {
  // Existing wake commands may need their own queue address, host token or configuration.
  const secrets = [profile?.apiKey, profile?.accessToken, profile?.refreshToken];
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 16 && /MARKETPLACE.*(?:KEY|TOKEN|SECRET|AUTHORIZATION)/i.test(name)) secrets.push(value);
  }
  for (const [name, value] of Object.entries(env)) {
    if (/MARKETPLACE|^(?:ATTO|NANO|XNO)_/i.test(name) || secrets.some(secret => secret && value?.includes(secret))) continue;
    result[name] = value;
  }
  return result;
}

async function enqueue(command: string, args: string[], env: NodeJS.ProcessEnv, event: AccountEvent, stopped: AbortSignal, timeoutMs: number): Promise<void> {
  stopped.throwIfAborted();
  const workerArgs = event.type === 'application.hired' ? [...args, event.applicationId!, event.taskId!] : args;
  const worker = spawn(command, workerArgs, {shell: false, env, stdio: ['pipe', 'ignore', 'ignore']});
  const terminate = () => { worker.kill('SIGKILL'); };
  stopped.addEventListener('abort', terminate, {once: true});
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
  let inputFailed = false;
  worker.stdin.on('error', () => { inputFailed = true; });
  try {
    const result = await new Promise<number | null>((complete, reject) => {
      worker.once('error', () => reject(new Error('The wake command could not start. Check its absolute path and executable permissions.')));
      worker.once('close', complete);
      worker.stdin.end(JSON.stringify(event) + '\n');
    });
    if (timedOut) throw new RetryListener('The wake command exceeded its enqueue timeout.');
    // Existing hire handlers can use only the two positional IDs and close stdin.
    if (result !== 0 || (inputFailed && event.type !== 'application.hired') || stopped.aborted) {
      throw new RetryListener('The wake command did not acknowledge the enqueue.');
    }
  } finally {
    clearTimeout(deadline);
    stopped.removeEventListener('abort', terminate);
  }
}

interface Subscription {
  origin: string;
  accountId?: string;
  types: string;
}

function retryableHttpStatus(status: number | undefined): boolean {
  return status === 408 || status === 429 || (status !== undefined && status >= 500);
}

async function consume(subscription: Subscription, checkpoint: EventCheckpoint, api: MarketplaceApiClient,
  deliver: (event: AccountEvent) => Promise<boolean>, configurationCurrent: () => boolean, stopped: AbortSignal): Promise<void> {
  let backoffMs = 1_000;
  while (!stopped.aborted && configurationCurrent()) {
    const connection = new AbortController();
    const signal = AbortSignal.any([stopped, connection.signal]);
    const connectTimeout = setTimeout(() => connection.abort(), 15_000);
    let rotate: NodeJS.Timeout | undefined;
    let rotating = false;
    let handlingEvent = false;
    const started = Date.now();
    try {
      const response = await api.openEventStream(subscription, checkpoint.cursor, signal);
      clearTimeout(connectTimeout);
      if (!configurationCurrent()) {
        await response.body?.cancel();
        return;
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        const message = `Marketplace event subscription returned HTTP ${response.status}.`;
        if (retryableHttpStatus(response.status)) throw new RetryListener(message);
        throw new Error(message + ' Check the selected profile, its event read permissions and the API endpoint.');
      }
      if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream' || !response.body) {
        throw new Error('Marketplace did not return a text/event-stream response.');
      }
      rotate = setTimeout(() => {
        rotating = true;
        connection.abort();
      }, 5 * 60_000);
      process.stderr.write(`Marketplace listener connected for ${subscription.types}.\n`);
      for await (const event of readAccountEvents(response.body, subscription.accountId, subscription.types.split(','))) {
        handlingEvent = true;
        const needed = checkpoint.needsDelivery(event.type, event.id);
        if (needed && !await deliver(event)) return;
        checkpoint.advance(event.id, needed);
        handlingEvent = false;
        backoffMs = 1_000;
      }
      // The server periodically closes healthy subscriptions to renew authentication.
      if (Date.now() - started >= 60_000) backoffMs = 1_000;
      throw new RetryListener('Marketplace closed the event stream.');
    } catch (error) {
      // A stale refresh result can reject before an SSE response exists.
      if (stopped.aborted || !configurationCurrent()) return;
      if (rotating && !handlingEvent && error instanceof RetryListener) {
        backoffMs = 1_000;
        continue;
      }
      if (!(error instanceof RetryListener)
        && !(error instanceof MarketplaceApiError && error.code === 'MARKETPLACE_UNAVAILABLE')
        && !(error instanceof ProfileError && error.code === 'REFRESH_BUSY')) throw error;
      process.stderr.write(`${error.message} Reconnecting from the last acknowledged cursor.\n`);
    } finally {
      clearTimeout(connectTimeout);
      clearTimeout(rotate);
      connection.abort();
      checkpoint.flush();
    }
    try { await delay(backoffMs, undefined, {signal: stopped}); }
    catch (error) { if (!stopped.aborted) throw error; }
    backoffMs = Math.min(backoffMs * 2, 30_000);
  }
}

async function catalogForListener(origin: string, stopped: AbortSignal, retry: boolean): Promise<EventCatalogEntry[]> {
  let waitMs = 1_000;
  for (;;) {
    stopped.throwIfAborted();
    try { return await readEventCatalog(origin, stopped); }
    catch (error) {
      stopped.throwIfAborted();
      if (!retry || !(error instanceof MarketplaceApiError) ||
        !(error.code === 'MARKETPLACE_UNAVAILABLE' || (error.code === 'MARKETPLACE_HTTP' && retryableHttpStatus(error.httpStatus)))) throw error;
      process.stderr.write(`${error.message} Retrying discovery.\n`);
      await delay(waitMs, undefined, {signal: stopped});
      waitMs = Math.min(30_000, waitMs * 2);
    }
  }
}

async function listen(options: ReturnType<typeof parseOptions>, store: MarketplaceProfileStore,
  env: NodeJS.ProcessEnv, stopped: AbortSignal): Promise<void> {
  const pinned = options.explicitProfile || store.listProfileIds().includes(options.profile) ? store.getProfile(options.profile) : undefined;
  if (!pinned && options.types === 'saved') throw new Error('Saved subscriptions require a configured Marketplace profile.');
  const origin = pinned?.origin ?? productionMarketplaceOrigin;
  if (options.listTypes) {
    const catalog = await catalogForListener(origin, stopped, false);
    process.stdout.write(JSON.stringify({types: catalog}, null, 2) + '\n');
    return;
  }
  const api = new MarketplaceApiClient(store, options.profile);
  let workerEnv = workerEnvironment(env, pinned);

  function configuration() {
    const profile = pinned ? store.getProfile(options.profile) : undefined;
    if (profile?.origin !== pinned?.origin || profile?.accountId !== pinned?.accountId) {
      throw new ProfileError('PROFILE_CHANGED', 'The listener profile changed origin or account. Restart with the intended profile.');
    }
    const names = options.types === 'saved' ? store.readSavedEventTypes(profile!) : options.types.split(',');
    // Rotating access and refresh tokens preserve authority. A local controller-to-key
    // handoff changes which feeds may stay open even while the old session is valid.
    const authority = [profile?.authMode, ...(profile?.apiScopes ?? []).slice().sort()];
    return {profile, names, key: JSON.stringify([authority, [...new Set(names)].sort()])};
  }

  while (!stopped.aborted) {
    const current = configuration();
    const profile = current.profile;
    const catalog = await catalogForListener(origin, stopped, true);
    if (configuration().key !== current.key) continue;
    const names = options.types === 'all' ? catalog.filter(entry => canSubscribeToEvent(entry, profile)).map(entry => entry.type) : current.names;
    const selected = [...new Set(names)].sort().map(name => {
      const entry = catalog.find(item => item.type === name);
      if (!entry) throw new Error(`Unknown Marketplace event type: ${name}. Use listen --list-types.`);
      if (!canSubscribeToEvent(entry, profile)) throw new Error(`The selected profile cannot subscribe to ${name}. Requires ${entry.scope ?? 'a controller session'}.`);
      return entry;
    });
    workerEnv = workerEnvironment(workerEnv, profile);
    const changed = new AbortController();
    const fatal = new AbortController();
    const cancelWorker = AbortSignal.any([stopped, fatal.signal]);
    const cancelStream = AbortSignal.any([cancelWorker, changed.signal]);
    let preferenceError: unknown;
    const configurationCurrent = () => {
      if (cancelStream.aborted) return false;
      try { if (pinned && configuration().key !== current.key) changed.abort(); }
      catch (error) { preferenceError = error; changed.abort(); }
      return !cancelStream.aborted;
    };
    const poll = pinned ? setInterval(configurationCurrent, 1_000) : undefined;
    let previous = Promise.resolve();
    const deliver = (event: AccountEvent) => {
      const next = previous.then(async () => {
        if (!configurationCurrent()) return false;
        await enqueue(options.command, options.args, workerEnv, event, cancelWorker, options.enqueueTimeoutMs);
        return true;
      });
      previous = next.then(() => {}, () => {});
      return next;
    };
    const streams: {subscription: Subscription; checkpoint: EventCheckpoint}[] = [];
    const running: Promise<void>[] = [];
    try {
      for (const audience of ['ACCOUNT', 'PUBLIC'] as const) {
        const types = selected.filter(entry => entry.audience === audience).map(entry => entry.type).join(',');
        if (!types) continue;
        const accountId = audience === 'ACCOUNT' ? profile!.accountId : undefined;
        const partition = accountId ?? `public:${profile?.accountId ?? 'anonymous'}`;
        const checkpoint = new EventCheckpoint(store.home, origin, partition, types,
          options.types === 'saved' || options.types === 'all' ? {mode: options.types, profile: profile?.id ?? null} : undefined);
        streams.push({subscription: {origin, types, ...(accountId ? {accountId} : {})}, checkpoint});
      }
      // Acquire every checkpoint before starting either stream. Each stream has its own
      // cursor, but only one queue command may be active across the two streams.
      for (const {subscription, checkpoint} of streams) running.push(consume(subscription, checkpoint, api, deliver, configurationCurrent, cancelStream));
      if (running.length) await Promise.all(running);
      else {
        process.stderr.write('Marketplace listener is waiting for a saved event selection.\n');
        if (!cancelStream.aborted) await new Promise<void>(resolve => cancelStream.addEventListener('abort', () => resolve(), {once:true}));
      }
    } finally {
      clearInterval(poll);
      fatal.abort();
      await Promise.allSettled(running);
      for (const stream of streams) stream.checkpoint.close();
    }
    if (preferenceError) throw preferenceError;
  }
}

export async function runListener(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  if (argv.length === 1 && ['-h', '--help'].includes(argv[0]!)) {
    process.stdout.write(usage + '\nDefaults to application.hired. Use --list-types to discover available types and permissions.\n');
    return;
  }
  const options = parseOptions(argv, env);
  const stopped = new AbortController();
  const stop = () => stopped.abort();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    const store = await MarketplaceProfileStore.open(options.home);
    try { await listen(options, store, env, stopped.signal); }
    catch (error) { if (!stopped.signal.aborted) throw error; }
    finally { store.close(); }
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}
