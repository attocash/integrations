import {
  AttoAccount, AttoBlock, AttoInstant, AttoWork, attoAccountChange, attoBlockWorkTarget,
} from '@attocash/commons-core';
import { requestWork } from '../network/work.js';
import { AttoError } from '../domain/errors.js';
import type { StateStore } from '../storage/state.js';
import type { WalletSettings } from './types.js';

export interface BlockWorker {
  workBlock(block: AttoBlock, signal?: AbortSignal): Promise<AttoWork>;
  close(): void;
}

interface StoredWork { target: string; height: string; work: string }
interface WorkJob { promise: Promise<AttoWork>; speculative: boolean }
const BACKGROUND_LIMIT = 2;
const QUEUE_LIMIT = 100;

/** Public work only: no signer, mnemonic, or seed enters this owner. */
export class WalletWork {
  private readonly queued = new Map<string, AttoBlock>();
  private readonly pending = new Map<string, WorkJob>();
  private readonly requests = new Set<AbortController>();
  private backgroundCount = 0;
  private closed = false;

  constructor(private readonly store: StateStore, private readonly settings: () => WalletSettings) {}

  isReady(account: AttoAccount): boolean {
    if (this.closed || account.network.name !== this.settings().network) return false;
    return this.read(this.nextBlock(account)) !== undefined;
  }

  prepare(accounts: readonly AttoAccount[]): void {
    if (this.closed) return;
    for (const account of accounts) {
      if (account.network.name !== this.settings().network) continue;
      const block = this.nextBlock(account);
      if (this.read(block)) continue;
      const key = this.key(block);
      if (this.queued.size < QUEUE_LIMIT || this.queued.has(key)) this.queued.set(key, block);
    }
    this.drain();
  }

  worker(): BlockWorker {
    // A signing operation borrows this cache; only the application closes it.
    return { workBlock: (block, signal) => this.obtain(block, false, signal), close() {} };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.queued.clear();
    for (const request of this.requests) request.abort();
    await Promise.allSettled([...this.pending.values()].map(job => job.promise));
  }

  private nextBlock(account: AttoAccount): AttoBlock {
    // Commons constructs the next-head target and validates its own work. This
    // unsigned block is only a work request; it is never signed or published.
    return attoAccountChange(account, account.representativeAddress, AttoInstant.Companion.now().toString()).block;
  }

  private key(block: AttoBlock): string { return `work.${block.network.name}.${block.publicKey.toString()}`; }

  private read(block: AttoBlock): AttoWork | undefined {
    try {
      const record = this.store.get<StoredWork>(this.key(block));
      if (!record || record.target !== attoBlockWorkTarget(block) || !/^[0-9a-f]{16}$/i.test(record.work)) return;
      const work = AttoWork.Companion.parse(record.work);
      return work.isValid(block) ? work : undefined;
    } catch { return undefined; }
  }

  private save(block: AttoBlock, work: AttoWork): void {
    if (this.closed || block.network.name !== this.settings().network) return;
    const key = this.key(block);
    this.store.transaction(() => {
      const prior = this.store.get<StoredWork>(key);
      // An older in-flight job must not displace work for a newer account head,
      // including work another CLI/MCP process has already persisted.
      if (prior && /^\d+$/.test(prior.height) && BigInt(prior.height) > BigInt(block.height.toString())) return;
      this.store.set(key, { target: attoBlockWorkTarget(block), height: block.height.toString(), work: work.toString() } satisfies StoredWork);
    });
  }

  private async obtain(block: AttoBlock, speculative = false, signal?: AbortSignal): Promise<AttoWork> {
    if (this.closed) throw new AttoError('WORK_CLOSED', 'The wallet work cache is closed.');
    const settings = this.settings();
    if (block.network.name !== settings.network) throw new AttoError('NETWORK_MISMATCH', 'Work must use the configured wallet network.');
    const ready = this.read(block);
    if (ready) return ready;
    const key = `${this.key(block)}.${attoBlockWorkTarget(block)}`;
    const existing = this.pending.get(key);
    if (existing) {
      try {
        const work = await existing.promise;
        // A job begun before a threshold change may no longer satisfy this block.
        if (work.isValid(block)) return work;
      } catch (error) {
        // Speculation has a shorter deadline. A real transaction retains the
        // normal worker budget if that earlier background attempt failed.
        if (speculative || !existing.speculative) throw error;
      }
    }
    if (this.closed) throw new AttoError('WORK_CLOSED', 'The wallet work cache is closed.');
    const job = { promise: this.compute(block, settings.workerUrl, speculative ? 10 : 60, signal), speculative };
    this.pending.set(key, job);
    try { return await job.promise; }
    finally { if (this.pending.get(key) === job) this.pending.delete(key); }
  }

  private async compute(block: AttoBlock, url: string, timeoutSeconds: number, signal?: AbortSignal): Promise<AttoWork> {
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    try {
      const work = await requestWork(block, url, AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]));
      this.save(block, work);
      return work;
    } catch (error) {
      if (signal?.aborted) throw new AttoError('CANCELLED', 'Send cancelled.');
      if (this.closed) throw new AttoError('WORK_CLOSED', 'The wallet work cache is closed.');
      if (controller.signal.aborted) throw new AttoError('WORK_TIMEOUT', 'Proof-of-work generation timed out.');
      if (error instanceof AttoError) throw error;
      throw new AttoError('WORK_FAILED', 'Proof-of-work generation failed. Check the worker endpoint.');
    } finally {
      clearTimeout(timer);
      this.requests.delete(controller);
    }
  }

  private drain(): void {
    while (!this.closed && this.backgroundCount < BACKGROUND_LIMIT && this.queued.size > 0) {
      const [key, block] = this.queued.entries().next().value!;
      this.queued.delete(key);
      this.backgroundCount++;
      void this.obtain(block, true).catch(() => {}).finally(() => {
        this.backgroundCount--;
        this.drain();
      });
    }
  }
}
