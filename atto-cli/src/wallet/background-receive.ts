import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AttoError, errorResult } from '../domain/errors.js';
import type { StateStore } from '../storage/state.js';
import type { WalletAddress, WalletIdentity, WalletSettings } from './types.js';
import type { ReceiveProgress } from './auto-receive.js';

const KEY = 'receive.background';
interface ReceiverRecord {
  token: string;
  desired: boolean;
  state: 'starting' | 'running' | 'stopping' | 'stopped';
  lastError: ReturnType<typeof errorResult> | null;
}
export interface BackgroundReceiveStatus {
  state: 'running' | 'stopping' | 'stopped';
  lastError: ReturnType<typeof errorResult> | null;
}

export function requireReceivingProfile(store: StateStore): void {
  if (store.get('wallet.reset')) throw new AttoError('WALLET_RESET_REQUIRED', 'Finish wallet reset before starting receiving.');
  if (!store.get<WalletIdentity>('identity')) throw new AttoError('WALLET_NOT_INITIALIZED', 'Create or import a wallet before receiving: atto wallet create or atto wallet import.');
  if (!store.get<WalletSettings>('settings')?.autoReceive) throw new AttoError('AUTO_RECEIVE_DISABLED', 'Automatic receiving is disabled. Enable it with atto wallet configure --auto-receive.');
  if (!store.get<WalletAddress[]>('addresses')?.some(address => address.active)) throw new AttoError('NO_ACTIVE_ACCOUNTS', 'Add or activate a wallet address before receiving.');
}

/** Profile control and observable process ownership. Persisted intent alone
 * cannot make a receiver live or restart it after restoring a backup. */
export class BackgroundReceiver {
  constructor(private readonly store: StateStore) {}

  status(): BackgroundReceiveStatus {
    const record = this.store.get<ReceiverRecord>(KEY);
    if (!record) return { state: 'stopped', lastError: null };
    const release = this.store.tryProcessLock('receive-daemon');
    const live = !release;
    release?.();
    const lastError = record.lastError ?? (!live && record.state !== 'stopped'
      ? errorResult(new AttoError('RECEIVER_EXITED', 'The background receiver exited. Start it again with atto wallet receive --background.')) : null);
    return { state: live ? record.desired ? 'running' : 'stopping' : 'stopped', lastError };
  }

  async start(): Promise<BackgroundReceiveStatus> {
    // Serialize launch/stop decisions, including startup acknowledgment. The
    // child performs only local initialization before acknowledging this call.
    return this.store.withWalletLock(async () => {
      const status = this.status();
      if (status.state !== 'stopped') return status;
      requireReceivingProfile(this.store);
      const token = randomUUID();
      this.store.set(KEY, { token, desired: true, state: 'starting', lastError: null } satisfies ReceiverRecord);
      try { await this.launch(token); }
      catch (error) {
        this.update(token, { desired: false, state: 'stopping', lastError: errorResult(error) });
        throw error;
      }
      return this.status();
    });
  }

  async stop(): Promise<BackgroundReceiveStatus> {
    return this.store.withWalletLock(async () => {
      const status = this.status();
      const record = this.store.get<ReceiverRecord>(KEY);
      if (record) this.store.set(KEY, { ...record, desired: false, state: status.state === 'stopped' ? 'stopped' : 'stopping', lastError: status.lastError });
      return { ...status, state: status.state === 'stopped' ? 'stopped' : 'stopping' };
    });
  }

  private launch(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./receive-daemon.js', import.meta.url)), this.store.directory, token], {
        detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
      });
      let settled = false;
      const finish = (error?: AttoError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child.connected) child.disconnect();
        child.unref();
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new AttoError('RECEIVER_START_TIMEOUT', 'Background receiver initialization timed out. Check wallet receive status before retrying.')), 5000);
      child.on('error', () => finish(new AttoError('RECEIVER_START_FAILED', 'The background receiver could not start. Check the installed CLI and profile permissions.')));
      child.once('exit', () => finish(new AttoError('RECEIVER_START_FAILED', 'The background receiver exited before initialization completed. Check wallet receive status.')));
      child.on('message', (message: unknown) => {
        if (message && typeof message === 'object' && 'ready' in message && message.ready === token) finish();
      });
      child.unref();
    });
  }

  /** A stale launch token cannot restart a stopped/reset/restored profile. */
  claim(token: string): (() => void) | undefined {
    return this.store.transaction(() => {
      if (this.stopping(token)) return;
      return this.store.tryProcessLock('receive-daemon');
    });
  }

  stopping(token: string): boolean {
    const record = this.store.get<ReceiverRecord>(KEY);
    return record?.token !== token || !record.desired;
  }

  update(token: string, update: Partial<Omit<ReceiverRecord, 'token'>>): void {
    this.store.transaction(() => {
      const record = this.store.get<ReceiverRecord>(KEY);
      if (record?.token === token) this.store.set(KEY, { ...record, ...update });
    });
  }

  progress(token: string, event: ReceiveProgress): void {
    if (event.event === 'retry' || event.event === 'reconnecting') this.update(token, { lastError: event.error });
    else if (event.event === 'received') this.update(token, { lastError: null });
  }
}
