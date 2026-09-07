import type { AddressLabels } from '../labels/presentation.js';
import type { AttoReceivable } from '@attocash/commons-core';
import { NodeReader } from '../network/reader.js';
import { AttoError, errorResult } from '../domain/errors.js';
import { amountOutput } from '../domain/amount.js';
import type { WalletAddress, WalletSettings } from './types.js';

interface PendingPayment {
  index: number;
  address: string;
  sendHash: string;
  amount: ReturnType<typeof amountOutput>;
}

export type ReceiveProgress = (
  | (PendingPayment & { event: 'pending' | 'receiving' })
  | (PendingPayment & { event: 'received'; receiveHash?: string })
  | (PendingPayment & { event: 'retry'; error: ReturnType<typeof errorResult>; retryInMs: number })
  | (PendingPayment & { event: 'skipped'; error: ReturnType<typeof errorResult> })
  | { event: 'reconnecting'; error: ReturnType<typeof errorResult>; retryInMs: number })
  & { addressLabels?: ReturnType<AddressLabels['dictionary']>; globalDirectory?: ReturnType<AddressLabels['status']> };

/** Session-owned supervision; every receive goes through the shared mutation gate. */
export class AutoReceiver {
  private controller?: AbortController;
  private loop?: Promise<void>;
  private lastError: ReturnType<typeof errorResult> | null = null;
  private active = false;

  constructor(
    private readonly snapshot: () => { settings: WalletSettings; addresses: WalletAddress[] },
    private readonly receive: (index: number, hash: string) => Promise<unknown>,
    private readonly onProgress?: (event: ReceiveProgress) => void,
  ) {}

  status() { return { running: this.active, lastError: this.lastError }; }

  private report(event: ReceiveProgress) {
    // Output failures must never turn a completed payment into another attempt.
    try { this.onProgress?.(event); } catch { /* Receiving is independent of its observer. */ }
  }

  start() {
    if (this.loop) return;
    this.controller = new AbortController();
    this.loop = this.run(this.controller.signal).finally(() => { this.active = false; });
  }

  private async run(signal: AbortSignal) {
    let configuration = '';
    let subscription: AbortController | undefined;
    let stream: Promise<void> | undefined;
    const pending = new Map<string, { payment: PendingPayment; retryAt: number }>();
    let retryAt = 0;
    let delayMs = 1000;
    let connected = false;
    try {
      while (!signal.aborted) {
        const { settings, addresses } = this.snapshot();
        const active = addresses.filter(address => address.active);
        const next = JSON.stringify({ settings, active });
        if (configuration !== next) {
          subscription?.abort();
          await stream;
          pending.clear();
          configuration = next;
          retryAt = 0;
          delayMs = 1000;
          connected = false;
        }
        this.active = settings.autoReceive && active.length > 0;
        if (this.active && !connected && Date.now() >= retryAt) {
          subscription = new AbortController();
          const child = subscription;
          connected = true;
          let streamError: ReturnType<typeof errorResult> | undefined;
          const byAddress = new Map(active.map(address => [address.publicKey.toUpperCase(), address.index]));
          stream = new NodeReader(settings).stream(
            { event: 'receivable', addresses: active.map(address => address.address), minAmountRaw: settings.minReceiveRaw },
            model => {
              const receivable = model as AttoReceivable;
              const index = byAddress.get(receivable.receiverPublicKey.toString().toUpperCase());
              if (index === undefined) return;
              const hash = receivable.hash.toString();
              // A bounded queue; reconnecting replays outstanding receivables.
              if (pending.size >= 1000 && !pending.has(hash)) { child.abort(); return; }
              if (!pending.has(hash)) {
                const payment = { index, address: receivable.receiverAddress.value, sendHash: hash, amount: amountOutput(receivable.amount.toString()) };
                pending.set(hash, { payment, retryAt: 0 });
                this.report({ event: 'pending', ...payment });
              }
              delayMs = 1000;
            }, child.signal,
          ).catch(error => {
            if (!child.signal.aborted && !signal.aborted) this.lastError = streamError = errorResult(error);
          }).finally(() => {
            connected = false;
            retryAt = Date.now() + delayMs;
            if (!child.signal.aborted && !signal.aborted) this.report({
              event: 'reconnecting',
              error: streamError ?? errorResult(new AttoError('NODE_UNAVAILABLE', 'The node stream ended.')),
              retryInMs: delayMs,
            });
            delayMs = Math.min(delayMs * 2, 30_000);
          });
        }
        for (const [hash, item] of pending) {
          if (signal.aborted) break;
          if (Date.now() < item.retryAt) continue;
          this.report({ event: 'receiving', ...item.payment });
          try {
            const result = await this.receive(item.payment.index, hash);
            pending.delete(hash);
            this.lastError = null;
            const receiveHash = result && typeof result === 'object' && 'hash' in result && typeof result.hash === 'string' ? result.hash : undefined;
            this.report({ event: 'received', ...item.payment, ...(receiveHash ? { receiveHash } : {}) });
          } catch (error) {
            if (error instanceof AttoError && ['RECEIVABLE_NOT_PENDING', 'ADDRESS_INACTIVE', 'AUTO_RECEIVE_DISABLED', 'RECEIVABLE_BELOW_MINIMUM'].includes(error.code)) {
              pending.delete(hash);
              if (!signal.aborted) this.report({ event: 'skipped', ...item.payment, error: errorResult(error) });
            } else {
              item.retryAt = Date.now() + 10_000;
              this.lastError = errorResult(error);
              if (!signal.aborted) this.report({ event: 'retry', ...item.payment, error: this.lastError, retryInMs: 10_000 });
            }
          }
          // Return to the settings/cancellation check between mutations.
          break;
        }
        if (!signal.aborted) await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
          const timer = setTimeout(finish, 250);
          signal.addEventListener('abort', finish, { once: true });
        });
      }
    } finally {
      subscription?.abort();
      await stream;
    }
  }

  async close() {
    this.controller?.abort();
    await this.loop;
    this.loop = undefined;
  }
}
