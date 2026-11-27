import { parseJsonObject } from '@attocash/cli/internal-marketplace';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createApprovalRequest } from './approval-files.js';
import { approveBrowserSignInGrant } from './approval-terminal.js';
import { MarketplaceApiClient, requireLiveController } from './marketplace-api.js';
import { uuid } from './marketplace-results.js';
import { parseChallengeEnvelope } from './marketplace-validation.js';
import { MarketplaceProfileStore, ProfileError } from './profile-store.js';
import { requireSetupTerminal } from './terminal-input.js';
import { managedWalletEnvironment } from './wallet-home.js';

export const browserOrigin = 'https://atto.market';
const pairLifetimeMs = 45_000;
const loopbackScript = `(async () => {
  const params = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', '/');
  const keys = ['nonce', 'handoffId', 'verifierHash'];
  if (params.size !== 3 || keys.some(key => params.getAll(key).length !== 1)) return;
  const result = await fetch('/pair', {method: 'POST', credentials: 'omit', redirect: 'error',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify(Object.fromEntries(params))});
  if (result.status === 204) location.replace('https://atto.market/workspace/connect/finish');
})().catch(() => {});`;
const pagePolicy = `default-src 'none'; script-src 'sha256-${createHash('sha256').update(loopbackScript).digest('base64')}'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'`;
const loopbackPage = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Marketplace browser sign-in</title><main>Connecting to Marketplace. If this page stays open, return to your assistant for the sign-in link.</main><script>${loopbackScript}</script></html>`;

export function browserDestination(path = '/workspace'): string {
  const invalid = () => new ProfileError('INVALID_BROWSER_PATH','Use a root-relative Marketplace destination outside the browser sign-in routes.');
  const pathname = path.split(/[?#]/, 1)[0]!;
  if (path.length > 2048 || !path.startsWith('/') || /[\\\x00-\x20\x7f]/u.test(path)
    || /%(?![a-f0-9]{2})/i.test(path) || pathname.includes('//') || /%(?:2f|5c|25)/i.test(pathname)) throw invalid();
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { throw invalid(); }
  if (/[\x00-\x1f\x7f]/u.test(decoded) || decoded.split('/').some(segment => segment === '.' || segment === '..')
    || /^\/workspace\/connect(?:\/|$)/i.test(decoded)) throw invalid();
  return path;
}

type BrowserLauncher = (url: string) => Promise<void>;

function openSystemBrowser(url: string): Promise<void> {
  const platform = process.platform;
  if (!['darwin','linux','win32'].includes(platform)) return Promise.reject(new Error('No system browser launcher.'));
  const command = platform === 'darwin' ? '/usr/bin/open' : platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {shell:false, stdio:'ignore', detached:true, windowsHide:true});
    child.once('error', () => reject(new Error('Browser launch failed.')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Browser launch failed.')));
    child.unref();
  });
}

export async function browserSignIn(profiles: MarketplaceProfileStore, profileId: string, path: string | undefined,
  signal: AbortSignal, launch: BrowserLauncher = openSystemBrowser) {
  const destination = browserDestination(path);
  const manual = (reason: string) => ({status:'manual_sign_in', url:browserOrigin + destination, reason});
  const profile = profiles.getProfile(profileId);
  try { requireLiveController(profile); } catch { return manual('Automatic sign-in requires a live Marketplace controller session.'); }
  const grant = profiles.browserSignInGrant(profileId);
  if (grant?.state !== 'enabled') return manual('Browser sign-in is disabled for this profile.');
  const api = new MarketplaceApiClient(profiles, profileId);
  const paired = await pairBrowser(launch, signal, async (handoffId, verifierHash, active) => {
    await api.request('/v1/agent/auth/browser-sign-in/handoffs/' + handoffId, {method:'POST', auth:'live-controller',
      signal:active, requiredBrowserGrant:grant.secret, allowStatus:[204], body:{browserOrigin, grantSecret:grant.secret, verifierHash, path:destination}});
  });
  return paired ? {status:'paired'} : manual('The system browser could not complete pairing. Open the link and sign in normally.');
}

async function readPair(request: IncomingMessage, nonce: Buffer): Promise<{handoffId:string; verifierHash:string} | undefined> {
  const length = request.headers['content-length'];
  if (!length || !/^[1-9]\d{0,2}$/.test(length) || Number(length) > 512 || request.headers['transfer-encoding']
    || request.headers['content-encoding']) return;
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > Number(length)) return;
    chunks.push(chunk as Buffer);
  }
  if (size !== Number(length)) return;
  const body = parseJsonObject(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  if (Object.keys(body).length !== 3 || typeof body.nonce !== 'string' || !/^[\w-]{43}$/.test(body.nonce)
    || !timingSafeEqual(Buffer.from(body.nonce,'ascii'), nonce) || !uuid.safeParse(body.handoffId).success
    || typeof body.verifierHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.verifierHash)) return;
  return {handoffId:body.handoffId as string, verifierHash:body.verifierHash};
}

// No cross-origin requests enter this listener. The official page navigates here, then this page posts its own fragment.
export async function pairBrowser(launch: BrowserLauncher, signal: AbortSignal,
  authorize: (handoffId:string, verifierHash:string, signal:AbortSignal) => Promise<void>): Promise<boolean> {
  if (signal.aborted) return false;
  const nonce = Buffer.from(randomBytes(32).toString('base64url'), 'ascii');
  const lifetime = new AbortController();
  let finish!: (paired: boolean) => void;
  const result = new Promise<boolean>(resolve => { finish = resolve; });
  let host: string;
  let claimed = false;
  const server = createServer({maxHeaderSize:4096, headersTimeout:5000, requestTimeout:5000}, (request, response) => {
    void handle(request, response).catch(() => { response.writeHead(400).end(); });
  });
  server.maxConnections = 8;
  server.maxRequestsPerSocket = 1;
  server.on('error', () => finish(false));
  const cancelled = () => finish(false);
  signal.addEventListener('abort', cancelled, {once:true});
  const timer = setTimeout(cancelled, pairLifetimeMs);
  try {
    server.listen({host:'127.0.0.1', port:0, signal:lifetime.signal}, () => {
      const address = server.address();
      if (!address || typeof address === 'string') return cancelled();
      host = '127.0.0.1:' + address.port;
      const fragment = new URLSearchParams({port:String(address.port), nonce:nonce.toString('ascii')});
      void Promise.resolve().then(() => launch(browserOrigin + '/workspace/connect#' + fragment)).catch(cancelled);
    });
    return await result;
  } finally {
    claimed = true;
    nonce.fill(0);
    signal.removeEventListener('abort', cancelled);
    clearTimeout(timer);
    lifetime.abort();
    server.closeAllConnections();
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control','no-store');
    response.setHeader('Referrer-Policy','no-referrer');
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('X-Frame-Options','DENY');
    response.setHeader('Content-Security-Policy',pagePolicy);
    response.setHeader('Connection','close');
    if (request.headersDistinct.host?.length !== 1 || request.headers.host !== host || request.socket.remoteAddress !== '127.0.0.1') {
      response.writeHead(403).end(); return;
    }
    if (request.method === 'GET' && request.url === '/') {
      if (request.headers.origin && request.headers.origin !== 'http://' + host) { response.writeHead(403).end(); return; }
      response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}).end(loopbackPage); return;
    }
    if (request.method !== 'POST' || request.url !== '/pair') { response.writeHead(404).end(); return; }
    if (request.headersDistinct.origin?.length !== 1 || request.headers.origin !== 'http://' + host
      || request.headersDistinct['content-type']?.length !== 1 || request.headers['content-type'] !== 'application/json') {
      response.writeHead(403).end(); return;
    }
    const pair = await readPair(request, nonce);
    if (!pair || claimed || lifetime.signal.aborted) { response.writeHead(403).end(); return; }
    claimed = true;
    let approved = false;
    response.once('close', () => finish(approved && response.writableFinished));
    try { await authorize(pair.handoffId, pair.verifierHash, lifetime.signal); approved = true; } catch { /* Safe manual fallback. */ }
    if (response.destroyed) return;
    response.writeHead(approved ? 204 : 403).end();
  }
}

export async function configureBrowserSignIn(
  store: MarketplaceProfileStore,
  id: string,
  operation: 'enable' | 'disable' | 'status',
  env: NodeJS.ProcessEnv,
  print: (value: unknown) => void,
): Promise<void> {
  const profile = store.getProfile(id);
  const grant = store.browserSignInGrant(id);
  if (operation === 'status') {
    print({ profileId: id, browserSignIn: grant?.state ?? 'disabled' });
    return;
  }
  requireSetupTerminal();
  const api = new MarketplaceApiClient(store, id);
  const prefix = '/v1/agent/auth/browser-sign-in/grants';
  if (operation === 'disable') {
    const secret = store.disableBrowserSignInGrant(id);
    if (secret) {
      try {
        await api.request(prefix + '/revoke', { method: 'POST', auth: 'live-controller', allowStatus: [204], body: { grantSecret: secret } });
      } catch {
        throw new ProfileError('BROWSER_REVOCATION_PENDING', 'Browser sign-in is disabled locally. Server revocation is pending. Retry --browser-sign-in disable with this controller session.');
      }
      store.forgetBrowserSignInGrant(id, secret, 'revocation_pending');
    }
    print({ profileId: id, browserSignIn: 'disabled' });
    return;
  }
  requireLiveController(profile);
  if (grant?.state === 'enabled') {
    print({ profileId: id, browserSignIn: 'enabled' });
    return;
  }
  if (grant) throw new ProfileError('BROWSER_GRANT_PENDING', 'A grant change is pending. Use --browser-sign-in disable to revoke the previous enrollment before enabling a new grant.');
  const secret = randomBytes(32).toString('base64url');
  const grantHash = createHash('sha256').update(secret, 'utf8').digest('hex');
  store.startBrowserSignInGrant(id, secret);
  let submitting = false;
  const setupProtocolFailure = (): never => {
    throw new ProfileError('SETUP_PROTOCOL', 'Marketplace setup returned an invalid response. Check the pinned origin and repeat only after confirming the previous action had no effect.');
  };
  try {
    const challenge = parseChallengeEnvelope((await api.request(prefix + '/challenges', {
      method: 'POST', auth: 'live-controller', allowStatus: [200, 201], body: { browserOrigin, grantHash },
    })).json, setupProtocolFailure);
    const request = createApprovalRequest({
      profileId: id, handoffId: randomBytes(16).toString('hex'), origin: profile.origin,
      audience: profile.audience, controllerNetwork: profile.controllerNetwork, controllerAddress: profile.controllerAddress,
      controllerIndex: profile.controllerIndex, accountId: profile.accountId, identityId: profile.identityId,
      purpose: 'browser sign-in grant', action: { kind: 'browser-sign-in-grant', browserOrigin, grantHash }, challenge,
    });
    if ((challenge.accountId !== undefined && challenge.accountId !== profile.accountId)
      || (challenge.controllerId !== undefined && challenge.controllerId !== profile.identityId)) setupProtocolFailure();
    const signature = await approveBrowserSignInGrant(request, managedWalletEnvironment(store.home, env));
    const current = store.browserSignInGrant(id);
    if (current?.state !== 'enrolling' || current.secret !== secret) throw new ProfileError('BROWSER_GRANT_CHANGED', 'Browser sign-in changed during approval.');
    submitting = true;
    await api.request(prefix, {
      method: 'POST', auth: 'live-controller', allowStatus: [204],
      body: { browserOrigin, grantHash, challengeId: challenge.challengeId, message: challenge.message, signature },
    });
    store.activateBrowserSignInGrant(id, secret);
  } catch (error) {
    if (!submitting) store.forgetBrowserSignInGrant(id, secret, 'enrolling');
    if (error instanceof ProfileError) throw error;
    throw new ProfileError('BROWSER_GRANT_FAILED', submitting
      ? 'Marketplace enrollment could not be confirmed. Use --browser-sign-in disable to revoke it before enabling again.'
      : 'Marketplace could not prepare browser sign-in. Check the controller session and its native wallet.');
  }
  print({ profileId: id, browserSignIn: 'enabled' });
}
