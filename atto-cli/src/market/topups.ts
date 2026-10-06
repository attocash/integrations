import { derivedSigner } from '../wallet/signing.js';
import type { WalletAddress, WalletIdentity, WalletSettings } from '../wallet/types.js';
import type { StateStore } from '../storage/state.js';
import type { AttoSeed } from '@attocash/commons-core';
import { AttoError } from '../domain/errors.js';
import { parseAttoExactRequirement, type AttoExactRequirement } from '../spending/atto-x402.js';
import {
  createMarketProofApprovalResponse, inspectMarketProofApproval,
  type MarketProofApprovalResponse,
} from './proof-approval.js';

const CONNECTION_KEY = 'market.topups.connection';
const RESPONSE_BYTES = 65_536;
const REQUEST_TIMEOUT_MS = 15_000;

export interface MarketConnection {
  version: 1;
  apiUrl: string;
  audience: string;
  controllerIndex: number;
  controllerAddress: string;
  accountId: string;
  agentId: string;
  identityId: string;
  walletFingerprint: string;
  browserOrigins?: string[];
}

export interface MarketTopUpStatus {
  intentId: string;
  asset: string;
  network: string;
  amountAtomic: string;
  state: 'PENDING' | 'ACCEPTED' | 'SETTLED' | 'REJECTED';
  expiresAt: string;
  sendHash: string | null;
  payer: string | null;
  paymentState: 'PENDING' | 'ACCEPTED' | 'SETTLED' | 'REJECTED' | null;
  receivePending: boolean | null;
  discrepancy: string | null;
  receiveStatus: 'PENDING' | 'ACCEPTED' | 'SETTLED' | 'REJECTED' | null;
}

export interface TopUpChallenge {
  status: MarketTopUpStatus;
  requirementHeader: string;
  requirement: AttoExactRequirement;
}

interface ExpectedMarketPayment {
  intentId?: string;
  hash?: string;
  payer?: string;
  requirePayment?: boolean;
}

export interface MarketWalletAccess {
  settings(): WalletSettings;
  addresses(): WalletAddress[];
  seed(): Promise<AttoSeed>;
  mcp: boolean;
}

interface MarketSession {
  accountId: string;
  agentId: string;
  identityId: string;
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
}

interface ProofChallenge {
  challengeId: string;
  message: string;
  issuedAt: string;
  expiresAt: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

function instant(value: unknown): number {
  if (typeof value !== 'string') throw new AttoError('MARKET_PROTOCOL', 'Market returned an invalid session or intent expiry.');
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new AttoError('MARKET_PROTOCOL', 'Market returned an invalid session or intent expiry.');
  return parsed;
}

function safeToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 16 && value.length <= 8192 && !/[\r\n\0]/.test(value);
}

function networkFor(settings: WalletSettings): 'atto:live' | 'atto:local' {
  if (settings.network === 'LIVE') return 'atto:live';
  if (settings.network === 'LOCAL') return 'atto:local';
  throw new AttoError('MARKET_NETWORK', 'Market top-ups support the configured LIVE or isolated LOCAL ATTO network only.');
}

export function validateMarketApiUrl(value: string, network: WalletSettings['network']): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new AttoError('MARKET_CONFIGURATION', 'Use the absolute Market /v1/agent/topups URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/, '') !== '/v1/agent/topups'
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && network === 'LOCAL' && loopback))) {
    throw new AttoError('MARKET_CONFIGURATION', 'Use an HTTPS Market /v1/agent/topups URL; HTTP is allowed only for loopback on an isolated LOCAL wallet.');
  }
  return `${url.origin}/v1/agent/topups`;
}

function validateBrowserOrigins(value: unknown, network: WalletSettings['network']): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8
    || value.some(origin => typeof origin !== 'string')) {
    throw new AttoError('MARKET_CONFIGURATION', 'Configure between 1 and 8 exact browser origins.');
  }
  const origins = value.map(origin => {
    const text = origin as string;
    let parsed: URL;
    try { parsed = new URL(text); }
    catch { throw new AttoError('MARKET_CONFIGURATION', 'Browser origins must be canonical HTTPS origins or loopback HTTP for an isolated LOCAL wallet.'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase());
    if (parsed.origin !== text || parsed.hostname.includes('*') || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash
      || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && network === 'LOCAL' && loopback))) {
      throw new AttoError('MARKET_CONFIGURATION', 'Browser origins must be canonical HTTPS origins or loopback HTTP for an isolated LOCAL wallet.');
    }
    return text;
  });
  if (new Set(origins).size !== origins.length) {
    throw new AttoError('MARKET_CONFIGURATION', 'Browser origins must not contain duplicates.');
  }
  return origins;
}

export class MarketTopUpClient {
  private session?: { key: string; value: MarketSession };

  constructor(private readonly store: StateStore, private readonly wallet: MarketWalletAccess) {}

  async connect(input: { apiUrl: string; audience: string; controllerIndex: number; browserOrigins?: string[] }): Promise<MarketConnection> {
    if (this.wallet.mcp) throw new AttoError('LOCAL_APPROVAL_REQUIRED', 'Configure the Market connection from a local terminal.');
    const apiUrl = validateMarketApiUrl(input.apiUrl, this.wallet.settings().network);
    if (!Number.isSafeInteger(input.controllerIndex) || input.controllerIndex < 0 || input.controllerIndex > 0x7fff_ffff
      || typeof input.audience !== 'string' || input.audience.length < 1 || input.audience.length > 255
      || input.audience.trim() !== input.audience || /[\r\n\0]/.test(input.audience)) {
      throw new AttoError('MARKET_CONFIGURATION', 'Choose a saved controller index and a single-line API audience of at most 255 characters.');
    }
    const browserOrigins = input.browserOrigins === undefined
      ? undefined : validateBrowserOrigins(input.browserOrigins, this.wallet.settings().network);
    const controller = this.wallet.addresses().find(address => address.index === input.controllerIndex);
    const identity = this.store.get<WalletIdentity>('identity');
    if (!controller || !identity) throw new AttoError('ADDRESS_NOT_DERIVED', 'Derive the controller address in this wallet before connecting Market.');
    const candidate = {
      version: 1 as const, apiUrl, audience: input.audience, controllerIndex: controller.index,
      controllerAddress: controller.address, walletFingerprint: identity.fingerprint,
      ...(browserOrigins ? { browserOrigins } : {}),
    };
    const session = await this.login(candidate);
    const connection: MarketConnection = { ...candidate, accountId: session.accountId, agentId: session.agentId, identityId: session.identityId };
    this.store.set(CONNECTION_KEY, connection);
    this.session = { key: this.sessionKey(connection), value: session };
    return connection;
  }

  connection(): MarketConnection {
    const value = this.store.get<MarketConnection>(CONNECTION_KEY);
    try {
      if (!value || value.version !== 1 || !Number.isSafeInteger(value.controllerIndex) || value.controllerIndex < 0
        || !uuid(value.accountId) || !uuid(value.agentId) || !uuid(value.identityId) || typeof value.walletFingerprint !== 'string') throw new Error();
      const canonicalUrl = validateMarketApiUrl(value.apiUrl, this.wallet.settings().network);
      if (canonicalUrl !== value.apiUrl || typeof value.audience !== 'string' || !value.audience
        || value.audience.length > 255 || value.audience.trim() !== value.audience || /[\r\n\0]/.test(value.audience)) throw new Error();
      if (value.browserOrigins !== undefined) {
        const canonicalOrigins = validateBrowserOrigins(value.browserOrigins, this.wallet.settings().network);
        if (JSON.stringify(canonicalOrigins) !== JSON.stringify(value.browserOrigins)) throw new Error();
      }
      const identity = this.store.get<WalletIdentity>('identity');
      const controller = this.wallet.addresses().find(address => address.index === value.controllerIndex);
      if (!identity || identity.fingerprint !== value.walletFingerprint || !controller
        || controller.address !== value.controllerAddress) {
        throw new AttoError('MARKET_RECONNECT_REQUIRED', 'The wallet or configured controller changed. Reconnect Market from a local terminal.');
      }
      return value;
    } catch (error) {
      if (error instanceof AttoError) throw error;
      throw new AttoError('MARKET_NOT_CONNECTED', 'Connect this wallet to Market from a local terminal before using top-ups.');
    }
  }

  inspectProofApproval(input: unknown) {
    if (this.wallet.mcp) throw new AttoError('LOCAL_APPROVAL_REQUIRED', 'Approve Market wallet proofs from the local terminal.');
    const candidate = input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>) : {};
    let connection: MarketConnection | undefined;
    try { connection = this.connection(); }
    catch (error) {
      if (!(candidate.purpose === 'login' && error instanceof AttoError && error.code === 'MARKET_NOT_CONNECTED')) throw error;
    }
    return inspectMarketProofApproval(input, connection, index => this.wallet.addresses().find(address => address.index === index)?.address);
  }

  async signProofApproval(input: unknown): Promise<MarketProofApprovalResponse> {
    if (this.wallet.mcp) throw new AttoError('LOCAL_APPROVAL_REQUIRED', 'Approve Market wallet proofs from the local terminal.');
    const { request } = this.inspectProofApproval(input);
    const seed = await this.wallet.seed();
    try {
      const signer = await derivedSigner(seed, request.controller.index);
      if (signer.address.value !== request.controller.address) throw new AttoError('WALLET_MISMATCH', 'The Market approval controller does not match this wallet key.');
      const signature = (await signer.signMessage(new Int8Array(Buffer.from(request.challenge.message, 'utf8')))).toString();
      return createMarketProofApprovalResponse(request, signature);
    } finally { seed.value.fill(0); }
  }

  async challenge(connection: MarketConnection, paymentIdentifier: string, amountRaw: string): Promise<{ status: MarketTopUpStatus; challenge?: TopUpChallenge }> {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(paymentIdentifier) || !/^[1-9]\d*$/.test(amountRaw)) {
      throw new AttoError('INVALID_INPUT', 'Market top-ups require a positive RAW amount and a 16-128 character payment identifier.');
    }
    const network = networkFor(this.wallet.settings());
    const session = await this.authorize(connection);
    const response = await this.fetchJson(connection.apiUrl, connection.apiUrl, 'POST', session.accessToken, {
      asset: 'ATTO', amountAtomic: amountRaw, paymentIdentifier,
    });
    const status = parseTopUpStatus(response.json);
    this.assertStatusBinding(status, paymentIdentifier, amountRaw, network);
    if (response.status !== 402) return { status };
    const requirementHeader = response.headers.get('payment-required');
    if (!requirementHeader) throw new AttoError('MARKET_PROTOCOL', 'Market omitted the required ATTO payment challenge.');
    const requirement = parseAttoExactRequirement({ header: requirementHeader, apiUrl: connection.apiUrl,
      intentId: status.intentId, network, amountRaw });
    return { status, challenge: { status, requirementHeader, requirement } };
  }

  async pay(connection: MarketConnection, status: MarketTopUpStatus, paymentIdentifier: string,
    paymentHeader: string, expected: { hash: string; network: string; payer: string },
    beforeSubmit: () => Promise<void>): Promise<MarketTopUpStatus> {
    const session = await this.authorize(connection);
    const url = `${connection.apiUrl}/${status.intentId}`;
    await beforeSubmit();
    const response = await this.fetchJson(connection.apiUrl, url, 'POST', session.accessToken, undefined,
      { 'PAYMENT-SIGNATURE': paymentHeader });
    const updated = parseTopUpStatus(response.json);
    this.assertStatusBinding(updated, paymentIdentifier, status.amountAtomic, expected.network, {
      intentId: status.intentId, hash: expected.hash, payer: expected.payer, requirePayment: true,
    });
    if (![200, 202, 409].includes(response.status)) throw this.httpFailure(response.status);
    const paymentResponse = response.headers.get('payment-response');
    if (!paymentResponse) throw new AttoError('MARKET_PROTOCOL', 'Market omitted the payment receipt.');
    const receipt = this.decodeObject(paymentResponse);
    const paymentApplied = updated.state === 'ACCEPTED' || updated.state === 'SETTLED';
    const pending = updated.state === 'PENDING';
    const rejected = updated.state === 'REJECTED';
    const responseMatchesState = (response.status === 200 && paymentApplied)
      || (response.status === 202 && pending) || (response.status === 409 && rejected);
    if (!responseMatchesState || receipt.success !== paymentApplied || typeof receipt.transaction !== 'string'
      || receipt.transaction.toUpperCase() !== expected.hash.toUpperCase()
      || receipt.network !== expected.network || receipt.payer !== expected.payer
      || updated.sendHash?.toUpperCase() !== receipt.transaction.toUpperCase() || updated.payer !== receipt.payer
      || (receipt.errorReason !== undefined && typeof receipt.errorReason !== 'string')) {
      throw new AttoError('MARKET_PROTOCOL', 'Market returned a receipt for a different ATTO payment.');
    }
    return updated;
  }

  async status(connection: MarketConnection, intentId: string, paymentIdentifier: string,
    amountRaw: string, network: string, expected?: { hash: string; payer: string }): Promise<MarketTopUpStatus> {
    const session = await this.authorize(connection);
    if (!uuid(intentId)) throw new AttoError('MARKET_PROTOCOL', 'The saved Market intent ID is invalid.');
    const response = await this.fetchJson(connection.apiUrl, `${connection.apiUrl}/${intentId}`, 'GET', session.accessToken);
    if (response.status !== 200) throw this.httpFailure(response.status);
    const status = parseTopUpStatus(response.json);
    this.assertStatusBinding(status, paymentIdentifier, amountRaw, network, {
      intentId, hash: expected?.hash, payer: expected?.payer,
    });
    return status;
  }

  private async authorize(connection: MarketConnection): Promise<MarketSession> {
    const key = this.sessionKey(connection);
    const cached = this.session?.key === key ? this.session.value : undefined;
    if (cached && cached.accessExpiresAt > Date.now() + 30_000) return cached;
    if (cached && cached.refreshExpiresAt > Date.now() + 30_000) {
      try {
        const response = await this.fetchJson(connection.apiUrl, this.authUrl(connection.apiUrl, 'sessions/refresh'),
          'POST', undefined, { refreshToken: cached.refreshToken });
        if (response.status !== 200) throw this.httpFailure(response.status);
        const refresh = object(response.json);
        if (!refresh || !safeToken(refresh.accessToken) || !safeToken(refresh.refreshToken)) throw new Error();
        const value = { ...cached, accessToken: refresh.accessToken,
          accessExpiresAt: instant(refresh.accessExpiresAt), refreshToken: refresh.refreshToken,
          refreshExpiresAt: instant(refresh.refreshExpiresAt) };
        if (value.accessExpiresAt <= Date.now() || value.refreshExpiresAt <= value.accessExpiresAt) throw new Error();
        this.session = { key, value };
        return value;
      } catch (error) {
        if (!(error instanceof AttoError) || error.code !== 'MARKET_HTTP'
          || ![400, 401, 403].includes((error.details as { httpStatus?: number } | undefined)?.httpStatus ?? 0)) throw error;
        // A rejected rotating refresh token falls back to a new wallet proof.
      }
    }
    const value = await this.login(connection);
    if (value.accountId !== connection.accountId || value.agentId !== connection.agentId || value.identityId !== connection.identityId) {
      throw new AttoError('MARKET_IDENTITY_CHANGED', 'Market authenticated a different account or controller. Reconnect from a local terminal.');
    }
    this.session = { key, value };
    return value;
  }

  private async login(connection: Pick<MarketConnection, 'apiUrl' | 'audience' | 'controllerIndex' | 'controllerAddress'>): Promise<MarketSession> {
    const networkForAddress = 'ATTO';
    const response = await this.fetchJson(connection.apiUrl, this.authUrl(connection.apiUrl, 'challenges'),
      'POST', undefined, { network: networkForAddress, address: connection.controllerAddress });
    if (response.status !== 200) throw this.httpFailure(response.status);
    const challenge = parseProofChallenge(response.json, connection);
    const seed = await this.wallet.seed();
    let signature: string;
    try {
      const signer = await derivedSigner(seed, connection.controllerIndex);
      if (signer.address.value !== connection.controllerAddress) {
        throw new AttoError('WALLET_MISMATCH', 'The configured controller does not match its wallet key.');
      }
      signature = (await signer.signMessage(new Int8Array(Buffer.from(challenge.message, 'utf8')))).toString();
    } finally { seed.value.fill(0); }
    const sessionResponse = await this.fetchJson(connection.apiUrl, this.authUrl(connection.apiUrl, 'sessions'),
      'POST', undefined, { challengeId: challenge.challengeId, message: challenge.message, signature });
    if (sessionResponse.status !== 200) throw this.httpFailure(sessionResponse.status);
    const value = parseSession(sessionResponse.json);
    if (value.accessExpiresAt <= Date.now() || value.refreshExpiresAt <= value.accessExpiresAt) {
      throw new AttoError('MARKET_PROTOCOL', 'Market returned an expired controller session.');
    }
    return value;
  }

  private authUrl(apiUrl: string, suffix: string): string {
    const api = new URL(apiUrl);
    return `${api.origin}/v1/agent/auth/${suffix}`;
  }

  private async fetchJson(apiUrl: string, urlValue: string, method: 'GET' | 'POST', accessToken?: string,
    body?: Record<string, string>, extraHeaders: Record<string, string> = {}): Promise<{ status: number; headers: Headers; json: unknown }> {
    const api = new URL(apiUrl);
    let url: URL;
    try { url = new URL(urlValue); }
    catch { throw new AttoError('MARKET_RESOURCE_MISMATCH', 'Market request URL is invalid.'); }
    const topupsPath = api.pathname;
    const agentPath = topupsPath.replace(/\/topups$/, '');
    const allowed = new Set([topupsPath, `${agentPath}/auth/challenges`, `${agentPath}/auth/sessions`,
      `${agentPath}/auth/sessions/refresh`]);
    const intentPath = new RegExp(`^${topupsPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`);
    if (url.origin !== api.origin || url.username || url.password || url.search || url.hash
      || (!allowed.has(url.pathname) && !intentPath.test(url.pathname))) {
      throw new AttoError('MARKET_RESOURCE_MISMATCH', 'Market request escaped the configured HTTPS origin.');
    }
    const headers: Record<string, string> = { accept: 'application/json', ...extraHeaders };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    if (body) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await fetch(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new AttoError('MARKET_UNAVAILABLE', 'The configured Market endpoint could not be reached. Reuse the same request ID to recover an uncertain payment.');
    }
    if (response.url && new URL(response.url).origin !== api.origin) {
      await response.body?.cancel();
      throw new AttoError('MARKET_RESOURCE_MISMATCH', 'Market redirected away from the configured origin.');
    }
    let raw: string;
    try { raw = await readBounded(response, RESPONSE_BYTES); }
    catch {
      throw new AttoError('MARKET_PROTOCOL', 'Market returned an invalid or oversized response.');
    }
    let json: unknown;
    try { json = raw ? JSON.parse(raw) : null; }
    catch { throw new AttoError('MARKET_PROTOCOL', 'Market returned an invalid response.'); }
    return { status: response.status, headers: response.headers, json };
  }

  private decodeObject(header: string): Record<string, unknown> {
    if (header.length < 1 || header.length > 90_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(header)) {
      throw new AttoError('MARKET_PROTOCOL', 'Market returned an invalid payment receipt.');
    }
    const bytes = Buffer.from(header, 'base64');
    if (bytes.toString('base64') !== header || bytes.length < 1 || bytes.length > RESPONSE_BYTES) {
      throw new AttoError('MARKET_PROTOCOL', 'Market returned an invalid payment receipt.');
    }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new AttoError('MARKET_PROTOCOL', 'Market returned an invalid payment receipt.'); }
    const result = object(value);
    if (!result) throw new AttoError('MARKET_PROTOCOL', 'Market returned an invalid payment receipt.');
    return result;
  }

  private assertStatusBinding(status: MarketTopUpStatus, paymentIdentifier: string, amountRaw: string, network: string,
    expected?: ExpectedMarketPayment): void {
    const terminal = status.state === 'ACCEPTED' || status.state === 'SETTLED';
    if (status.asset !== 'ATTO' || status.network !== network || status.amountAtomic !== amountRaw
      || !uuid(status.intentId) || !/^[1-9]\d*$/.test(status.amountAtomic)
      || !paymentIdentifier || instant(status.expiresAt) < 0
      || (expected?.intentId !== undefined && status.intentId !== expected.intentId)
      || (expected?.hash !== undefined && status.sendHash !== null
        && status.sendHash.toUpperCase() !== expected.hash.toUpperCase())
      || (expected?.payer !== undefined && status.payer !== null && status.payer !== expected.payer)
      || (expected && !expected.hash && (status.sendHash !== null || status.payer !== null))
      || (expected && terminal && (!expected.hash || !expected.payer
        || status.sendHash?.toUpperCase() !== expected.hash.toUpperCase() || status.payer !== expected.payer))
      || (expected && status.paymentState !== null && (!expected.hash || !expected.payer
        || status.sendHash?.toUpperCase() !== expected.hash.toUpperCase() || status.payer !== expected.payer))
      || (expected?.requirePayment && (!expected.hash || !expected.payer
        || status.paymentState === null
        || status.sendHash?.toUpperCase() !== expected.hash.toUpperCase() || status.payer !== expected.payer))) {
      throw new AttoError('MARKET_PROTOCOL', 'Market returned a top-up status for a different payment.');
    }
  }

  private httpFailure(status: number): AttoError {
    return new AttoError('MARKET_HTTP', `Market returned HTTP ${status}. Reuse the same request ID to inspect or recover the payment.`, { httpStatus: status });
  }

  private sessionKey(connection: Pick<MarketConnection, 'apiUrl' | 'audience' | 'controllerAddress' | 'accountId' | 'agentId' | 'identityId'>): string {
    return JSON.stringify([connection.apiUrl, connection.audience, connection.controllerAddress,
      connection.accountId ?? null, connection.agentId ?? null, connection.identityId ?? null]);
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('response too large');
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function parseTopUpStatus(input: unknown): MarketTopUpStatus {
  const value = object(input);
  const states = ['PENDING', 'ACCEPTED', 'SETTLED', 'REJECTED'];
  const paymentStates = ['PENDING', 'ACCEPTED', 'SETTLED', 'REJECTED'];
  if (!value || !uuid(value.intentId) || typeof value.asset !== 'string' || typeof value.network !== 'string'
    || typeof value.amountAtomic !== 'string' || !states.includes(String(value.state))
    || typeof value.expiresAt !== 'string'
    || (value.sendHash !== null && typeof value.sendHash !== 'string')
    || (value.payer !== null && typeof value.payer !== 'string')
    || (value.paymentState !== null && !paymentStates.includes(String(value.paymentState)))
    || (value.receivePending !== null && typeof value.receivePending !== 'boolean')
    || (value.discrepancy !== null && typeof value.discrepancy !== 'string')
    || !(value.receiveStatus === null || ['PENDING', 'ACCEPTED', 'SETTLED', 'REJECTED'].includes(String(value.receiveStatus)))) {
    throw new AttoError('MARKET_PROTOCOL', 'Market returned an invalid top-up status.');
  }
  instant(value.expiresAt);
  return value as unknown as MarketTopUpStatus;
}

function parseProofChallenge(input: unknown, connection: Pick<MarketConnection, 'audience' | 'controllerAddress'>): ProofChallenge {
  const value = object(input);
  if (!value || !uuid(value.challengeId) || typeof value.message !== 'string'
    || typeof value.issuedAt !== 'string' || typeof value.expiresAt !== 'string') {
    throw new AttoError('MARKET_PROTOCOL', 'Market returned an invalid controller proof challenge.');
  }
  const match = /^Atto Market Agent Controller Proof v1\nAudience: ([^\n]+)\nNetwork: live\nAddress: (atto:\/\/[a-z2-7]{61})\nPurpose: login\nRequest ID: ([0-9a-f-]{36})\nNonce: ([0-9a-f]{64})\nIssued At: ([^\n]+)\nExpiration Time: ([^\n]+)$/.exec(value.message);
  if (!match || match[1] !== connection.audience || match[2] !== connection.controllerAddress
    || match[3] !== value.challengeId || match[5] !== value.issuedAt || match[6] !== value.expiresAt) {
    throw new AttoError('MARKET_PROTOCOL', 'Market returned a controller proof outside the configured audience or identity.');
  }
  const issuedAt = instant(value.issuedAt);
  const expiresAt = instant(value.expiresAt);
  const now = Date.now();
  if (issuedAt > now + 30_000 || expiresAt <= now || expiresAt <= issuedAt || expiresAt - issuedAt > 300_000) {
    throw new AttoError('MARKET_PROTOCOL', 'Market returned an expired or out-of-window controller proof.');
  }
  return value as unknown as ProofChallenge;
}

function parseSession(input: unknown): MarketSession {
  const value = object(input);
  if (!value || !uuid(value.accountId) || !uuid(value.agentId) || !uuid(value.identityId)
    || typeof value.accountState !== 'string' || value.accountState === 'CLOSED'
    || !safeToken(value.accessToken) || !safeToken(value.refreshToken)) {
    throw new AttoError('MARKET_PROTOCOL', 'Market returned an invalid controller session.');
  }
  return {
    accountId: value.accountId, agentId: value.agentId, identityId: value.identityId,
    accessToken: value.accessToken, accessExpiresAt: instant(value.accessExpiresAt),
    refreshToken: value.refreshToken, refreshExpiresAt: instant(value.refreshExpiresAt),
  };
}
