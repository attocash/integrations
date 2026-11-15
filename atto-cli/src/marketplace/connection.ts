import { createHash } from 'node:crypto';
import { derivedSigner } from '../wallet/signing.js';
import type { WalletAddress, WalletIdentity, WalletSettings } from '../wallet/types.js';
import type { StateStore } from '../storage/state.js';
import type { AttoSeed } from '@attocash/commons-core';
import { AttoError } from '../domain/errors.js';
import {
  createMarketplaceProofApprovalResponse, inspectMarketplaceProofApproval,
  type MarketplaceProofApprovalResponse,
} from './proof-approval.js';

const CONNECTION_KEY = 'marketplace.connection';
const RESPONSE_BYTES = 65_536;
const REQUEST_TIMEOUT_MS = 15_000;

export interface MarketplaceConnection {
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

export interface MarketplaceWalletAccess {
  settings(): WalletSettings;
  addresses(): WalletAddress[];
  seed(): Promise<AttoSeed>;
  mcp: boolean;
}

interface MarketplaceSession {
  accountId: string;
  agentId: string;
  identityId: string;
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
}

interface ProofChallenge {
  accountId: string;
  controllerId: string;
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
  if (typeof value !== 'string') throw new AttoError('MARKETPLACE_PROTOCOL', 'Marketplace returned an invalid session expiry.');
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new AttoError('MARKETPLACE_PROTOCOL', 'Marketplace returned an invalid session expiry.');
  return parsed;
}

function safeToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 16 && value.length <= 8192 && !/[\r\n\0]/.test(value);
}

export function validateMarketplaceApiUrl(value: string, network: WalletSettings['network']): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new AttoError('MARKETPLACE_CONFIGURATION', 'Use the absolute Marketplace /v1/agent/payments URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/, '') !== '/v1/agent/payments'
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && network === 'LOCAL' && loopback))) {
    throw new AttoError('MARKETPLACE_CONFIGURATION', 'Use an HTTPS Marketplace /v1/agent/payments URL; HTTP is allowed only for loopback on an isolated LOCAL wallet.');
  }
  return `${url.origin}/v1/agent/payments`;
}

function validateBrowserOrigins(value: unknown, network: WalletSettings['network']): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8
    || value.some(origin => typeof origin !== 'string')) {
    throw new AttoError('MARKETPLACE_CONFIGURATION', 'Configure between 1 and 8 exact browser origins.');
  }
  const origins = value.map(origin => {
    const text = origin as string;
    let parsed: URL;
    try { parsed = new URL(text); }
    catch { throw new AttoError('MARKETPLACE_CONFIGURATION', 'Browser origins must be canonical HTTPS origins or loopback HTTP for an isolated LOCAL wallet.'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase());
    if (parsed.origin !== text || parsed.hostname.includes('*') || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash
      || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && network === 'LOCAL' && loopback))) {
      throw new AttoError('MARKETPLACE_CONFIGURATION', 'Browser origins must be canonical HTTPS origins or loopback HTTP for an isolated LOCAL wallet.');
    }
    return text;
  });
  if (new Set(origins).size !== origins.length) {
    throw new AttoError('MARKETPLACE_CONFIGURATION', 'Browser origins must not contain duplicates.');
  }
  return origins;
}

export class MarketplaceConnectionClient {
  constructor(private readonly store: StateStore, private readonly wallet: MarketplaceWalletAccess) {}

  async connect(input: { apiUrl: string; audience: string; controllerIndex: number; browserOrigins?: string[] }): Promise<MarketplaceConnection> {
    if (this.wallet.mcp) throw new AttoError('LOCAL_APPROVAL_REQUIRED', 'Configure the Marketplace connection from a local terminal.');
    const apiUrl = validateMarketplaceApiUrl(input.apiUrl, this.wallet.settings().network);
    if (!Number.isSafeInteger(input.controllerIndex) || input.controllerIndex < 0 || input.controllerIndex > 0x7fff_ffff
      || typeof input.audience !== 'string' || input.audience.length < 1 || input.audience.length > 255
      || input.audience.trim() !== input.audience || /[\r\n\0]/.test(input.audience)) {
      throw new AttoError('MARKETPLACE_CONFIGURATION', 'Choose a saved controller index and a single-line API audience of at most 255 characters.');
    }
    const browserOrigins = input.browserOrigins === undefined
      ? undefined : validateBrowserOrigins(input.browserOrigins, this.wallet.settings().network);
    const controller = this.wallet.addresses().find(address => address.index === input.controllerIndex);
    const identity = this.store.get<WalletIdentity>('identity');
    if (!controller || !identity) throw new AttoError('ADDRESS_NOT_DERIVED', 'Derive the controller address in this wallet before connecting Marketplace.');
    const candidate = {
      version: 1 as const, apiUrl, audience: input.audience, controllerIndex: controller.index,
      controllerAddress: controller.address, walletFingerprint: identity.fingerprint,
      ...(browserOrigins ? { browserOrigins } : {}),
    };
    const session = await this.login(candidate);
    const connection: MarketplaceConnection = { ...candidate, accountId: session.accountId, agentId: session.agentId, identityId: session.identityId };
    this.store.set(CONNECTION_KEY, connection);
    return connection;
  }

  connection(): MarketplaceConnection {
    const value = this.store.get<MarketplaceConnection>(CONNECTION_KEY);
    try {
      if (!value || value.version !== 1 || !Number.isSafeInteger(value.controllerIndex) || value.controllerIndex < 0
        || !uuid(value.accountId) || !uuid(value.agentId) || !uuid(value.identityId) || typeof value.walletFingerprint !== 'string') throw new Error();
      const canonicalUrl = validateMarketplaceApiUrl(value.apiUrl, this.wallet.settings().network);
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
        throw new AttoError('MARKETPLACE_RECONNECT_REQUIRED', 'The wallet or configured controller changed. Reconnect Marketplace from a local terminal.');
      }
      return value;
    } catch (error) {
      if (error instanceof AttoError) throw error;
      throw new AttoError('MARKETPLACE_NOT_CONNECTED', 'Connect this wallet to Marketplace from a local terminal before approving non-login proofs.');
    }
  }

  inspectProofApproval(input: unknown) {
    if (this.wallet.mcp) throw new AttoError('LOCAL_APPROVAL_REQUIRED', 'Approve Marketplace wallet proofs from the local terminal.');
    const candidate = input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>) : {};
    let connection: MarketplaceConnection | undefined;
    try { connection = this.connection(); }
    catch (error) {
      if (!(candidate.purpose === 'login' && error instanceof AttoError && error.code === 'MARKETPLACE_NOT_CONNECTED')) throw error;
    }
    return inspectMarketplaceProofApproval(input, connection, index => this.wallet.addresses().find(address => address.index === index)?.address);
  }

  async signProofApproval(input: unknown): Promise<MarketplaceProofApprovalResponse> {
    if (this.wallet.mcp) throw new AttoError('LOCAL_APPROVAL_REQUIRED', 'Approve Marketplace wallet proofs from the local terminal.');
    const { request } = this.inspectProofApproval(input);
    const seed = await this.wallet.seed();
    try {
      const signer = await derivedSigner(seed, request.controller.index);
      if (signer.address.value !== request.controller.address) throw new AttoError('WALLET_MISMATCH', 'The Marketplace approval controller does not match this wallet key.');
      const signature = (await signer.signMessage(new Int8Array(Buffer.from(request.challenge.message, 'utf8')))).toString();
      return createMarketplaceProofApprovalResponse(request, signature);
    } finally { seed.value.fill(0); }
  }

  private async login(connection: Pick<MarketplaceConnection, 'apiUrl' | 'audience' | 'controllerIndex' | 'controllerAddress'> & Partial<Pick<MarketplaceConnection, 'accountId' | 'identityId'>>): Promise<MarketplaceSession> {
    const networkForAddress = 'ATTO';
    const response = await this.postAuth(connection.apiUrl, 'challenges', { network: networkForAddress, address: connection.controllerAddress });
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
    const sessionResponse = await this.postAuth(connection.apiUrl, 'sessions', { challengeId: challenge.challengeId, message: challenge.message, signature });
    if (sessionResponse.status !== 200) throw this.httpFailure(sessionResponse.status);
    const value = parseSession(sessionResponse.json);
    if (value.accountId !== challenge.accountId || value.identityId !== challenge.controllerId) {
      throw new AttoError('MARKETPLACE_PROTOCOL', 'Marketplace returned a session outside the signed controller enrollment.');
    }
    if (value.accessExpiresAt <= Date.now() || value.refreshExpiresAt < value.accessExpiresAt) {
      throw new AttoError('MARKETPLACE_PROTOCOL', 'Marketplace returned an expired controller session.');
    }
    return value;
  }

  private async postAuth(apiUrl: string, action: 'challenges' | 'sessions',
    body: Record<string,string>): Promise<{ status: number; headers: Headers; json: unknown }> {
    const api = new URL(apiUrl);
    const url = new URL(`/v1/agent/auth/${action}`, api.origin);
    const headers = { accept: 'application/json', 'content-type': 'application/json' };
    let response: Response;
    try {
      response = await fetch(url, { method:'POST', headers, body:JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new AttoError('MARKETPLACE_UNAVAILABLE', 'The configured Marketplace authentication endpoint could not be reached. Retry connection from the local terminal.');
    }
    if (response.url && new URL(response.url).origin !== api.origin) {
      await response.body?.cancel();
      throw new AttoError('MARKETPLACE_RESOURCE_MISMATCH', 'Marketplace redirected away from the configured origin.');
    }
    let raw: string;
    try { raw = await readBounded(response, RESPONSE_BYTES); }
    catch {
      throw new AttoError('MARKETPLACE_PROTOCOL', 'Marketplace returned an invalid or oversized response.');
    }
    let json: unknown;
    try { json = raw ? JSON.parse(raw) : null; }
    catch { throw new AttoError('MARKETPLACE_PROTOCOL', 'Marketplace returned an invalid response.'); }
    const serverCode = object(json)?.error;
    if (response.status === 403 && serverCode === 'signer_request_rejected') {
      throw new AttoError('SIGNER_REQUEST_REJECTED',
        'The Marketplace signer rejected this request. Check the exact controller approval and signer configuration before retrying.',
        { httpStatus: 403, serverCode });
    }
    if (response.status === 503 && serverCode === 'signer_unavailable') {
      throw new AttoError('SIGNER_UNAVAILABLE',
        'The Marketplace signer is temporarily unavailable. Retry the original request with its arguments unchanged.',
        { httpStatus: 503, serverCode });
    }
    return { status: response.status, headers: response.headers, json };
  }

  private httpFailure(status: number): AttoError {
    return new AttoError('MARKETPLACE_HTTP', `Marketplace returned HTTP ${status}. Review the connection and retry from the local terminal.`, { httpStatus: status });
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

function parseProofChallenge(input: unknown, connection: Pick<MarketplaceConnection, 'audience' | 'controllerAddress'> & Partial<Pick<MarketplaceConnection, 'accountId' | 'identityId'>>): ProofChallenge {
  const value = object(input);
  if (!value || !uuid(value.challengeId) || !uuid(value.accountId) || !uuid(value.controllerId) || typeof value.message !== 'string'
    || typeof value.issuedAt !== 'string' || typeof value.expiresAt !== 'string') {
    throw new AttoError('MARKETPLACE_PROTOCOL', 'Marketplace returned an invalid controller proof challenge.');
  }
  const match = /^Marketplace Agent Controller Proof v1\nAudience: ([^\n]+)\nNetwork: live\nAddress: (atto:\/\/[a-z2-7]{61})\nPurpose: login\nRequest ID: ([0-9a-f-]{36})\nBinding Hash: ([0-9a-f]{64})\nNonce: ([0-9a-f]{64})\nIssued At: ([^\n]+)\nExpiration Time: ([^\n]+)$/.exec(value.message);
  if (!match || match[1] !== connection.audience || match[2] !== connection.controllerAddress
    || match[3] !== value.challengeId || match[4] !== createHash('sha256').update(['marketplace-login-v1', value.accountId, value.controllerId].join('\n'), 'utf8').digest('hex')
    || match[6] !== value.issuedAt || match[7] !== value.expiresAt
    || (connection.accountId !== undefined && value.accountId !== connection.accountId)
    || (connection.identityId !== undefined && value.controllerId !== connection.identityId)) {
    throw new AttoError('MARKETPLACE_PROTOCOL', 'Marketplace returned a controller proof outside the configured audience or identity.');
  }
  const issuedAt = instant(value.issuedAt);
  const expiresAt = instant(value.expiresAt);
  const now = Date.now();
  if (issuedAt > now + 30_000 || expiresAt <= now || expiresAt <= issuedAt || expiresAt - issuedAt > 300_000) {
    throw new AttoError('MARKETPLACE_PROTOCOL', 'Marketplace returned an expired or out-of-window controller proof.');
  }
  return value as unknown as ProofChallenge;
}

function parseSession(input: unknown): MarketplaceSession {
  const value = object(input);
  if (!value || !uuid(value.accountId) || !uuid(value.agentId) || !uuid(value.identityId)
    || typeof value.accountState !== 'string' || value.accountState === 'CLOSED'
    || !safeToken(value.accessToken) || !safeToken(value.refreshToken)) {
    throw new AttoError('MARKETPLACE_PROTOCOL', 'Marketplace returned an invalid controller session.');
  }
  return {
    accountId: value.accountId, agentId: value.agentId, identityId: value.identityId,
    accessToken: value.accessToken, accessExpiresAt: instant(value.accessExpiresAt),
    refreshToken: value.refreshToken, refreshExpiresAt: instant(value.refreshExpiresAt),
  };
}
