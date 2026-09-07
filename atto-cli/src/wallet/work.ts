import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { AttoAccount, AttoBlock, AttoChangeBlock, AttoInstant, AttoWork, attoAccountChange, attoBlockWorkTarget, toAttoHeight } from '@attocash/commons-core';
import { requestWork } from '../network/work.js';
import { AttoError } from '../domain/errors.js';
import type { StateStore } from '../storage/state.js';
import type { WalletIdentity, WalletSettings } from './types.js';

export interface BlockWorker {
  workBlock(block: AttoBlock, signal?: AbortSignal): Promise<AttoWork>;
  close(): void;
}
export type WorkExecution = 'in-process' | 'detached';
interface Head { scope: string; target: string; height: string }
interface StoredWork extends Head { work: string }
interface WorkJob extends Head { id: string; key: string; block: string }
const QUEUE_KEY = 'work.queue';
const EPOCH_KEY = 'work.epoch';
const QUEUE_LIMIT = 100;
const CONCURRENCY = 2;
const SPECULATIVE_MS = 10_000;
const WORKER_MS = 60_000;

/** Public preparation, validation and caching. No credential or signer enters
 * this owner. Speculative failures never escape into completed transactions. */
export class WalletWork {
  private closed = false;
  private drainTask?: Promise<void>;
  private resumeRequested = false;
  private readonly active = new Set<Promise<unknown>>();
  private readonly computations = new Map<string, { promise: Promise<AttoWork>; speculative: boolean }>();
  private readonly requests = new Set<AbortController>();

  constructor(private readonly store: StateStore, private readonly settings: () => WalletSettings,
    private readonly execution: WorkExecution = 'in-process') {}

  private scope(): string {
    const { network, nodeUrl, workerUrl } = this.settings();
    return JSON.stringify([this.store.get(EPOCH_KEY) ?? null, this.store.get<WalletIdentity>('identity') ?? null, network, nodeUrl, workerUrl]);
  }

  private nextBlock(account: AttoAccount): AttoBlock {
    return attoAccountChange(account, account.representativeAddress, AttoInstant.Companion.now().toString()).block;
  }
  private key(block: AttoBlock): string { return `work.${block.network.name}.${block.publicKey}`; }
  private head(block: AttoBlock): Head { return { scope: this.scope(), target: attoBlockWorkTarget(block), height: block.height.toString() }; }
  private same(left: Head, right: Head): boolean { return left.scope === right.scope && left.target === right.target && left.height === right.height; }

  isReady(account: AttoAccount): boolean {
    try { return !this.closed && account.network.name === this.settings().network && Boolean(this.read(this.nextBlock(account))); }
    catch { return false; }
  }

  prepare(accounts: readonly AttoAccount[]): void {
    try { this.enqueue(accounts.map(account => this.nextBlock(account))); }
    catch { /* Public preparation must not change a completed payment's result. */ }
  }

  /** A confirmed block is sufficient to prepare its successor, including after
   * publication recovery. This unsigned change template is never published;
   * work depends on the head, height, network and time, not its representative. */
  prepareConfirmed(block: AttoBlock): void {
    try {
      this.enqueue([new AttoChangeBlock(block.network, block.version, block.algorithm, block.publicKey,
        toAttoHeight((BigInt(block.height.toString()) + 1n).toString()), block.balance, AttoInstant.Companion.now(),
        block.hash, block.algorithm, block.publicKey)]);
    } catch { /* Even template/storage failures are optional after confirmation. */ }
  }

  private enqueue(blocks: readonly AttoBlock[]): void {
    if (this.closed) return;
    try {
      this.store.transaction(() => {
        if (!this.store.get(EPOCH_KEY)) this.store.set(EPOCH_KEY, randomUUID());
        let queue = this.queue();
        for (const block of blocks) {
          if (block.network.name !== this.settings().network) continue;
          const key = this.key(block);
          const head = this.head(block);
          if (!this.observe(key, head)) continue;
          queue = queue.filter(job => job.scope === head.scope);
          const position = queue.findIndex(job => job.key === key);
          if (this.read(block)) {
            queue = queue.filter(job => job.key !== key || !this.same(job, head));
          } else if (position !== -1) {
            if (!this.same(queue[position]!, head)) queue[position] = { ...head, key, id: randomUUID(), block: block.toJson() };
          } else if (queue.length < QUEUE_LIMIT) queue.push({ ...head, key, id: randomUUID(), block: block.toJson() });
        }
        this.store.set(QUEUE_KEY, queue);
      });
      this.resume();
    } catch { /* A completed transaction survives speculative storage/launch failures. */ }
  }

  /** Resume only after successful CLI input validation/operation, never in the constructor. */
  resume(): void {
    if (this.closed) return;
    try {
      if (!this.queue().length) return;
      if (this.execution === 'detached') {
        // Always launch a candidate after enqueueing. The child checks ownership
        // in the same state transaction used by the draining owner's exit.
        const child = spawn(process.execPath, [fileURLToPath(new URL('./work-daemon.js', import.meta.url)), this.store.directory, this.store.get<string>(EPOCH_KEY) ?? ''], {
          detached: true, stdio: 'ignore', windowsHide: true,
        });
        child.on('error', () => {});
        child.unref();
      } else if (this.drainTask) this.resumeRequested = true;
      else {
        this.resumeRequested = false;
        this.drainTask = this.drain().catch(() => {}).finally(() => {
          this.drainTask = undefined;
          if (this.resumeRequested) this.resume();
        });
      }
    } catch { /* Pending jobs remain eligible on a later invocation. */ }
  }

  worker(): BlockWorker {
    return { workBlock: (block, signal) => this.obtain(block, false, signal), close() {} };
  }

  private queue(): WorkJob[] {
    const value = this.store.get<unknown>(QUEUE_KEY);
    if (!Array.isArray(value)) return [];
    return value.filter((job): job is WorkJob => job !== null && typeof job === 'object'
      && ['id', 'key', 'scope', 'target', 'block'].every(key => typeof job[key] === 'string')
      && typeof job.height === 'string' && /^\d+$/.test(job.height)).slice(0, QUEUE_LIMIT);
  }

  /** Caller owns the short state transaction. Lower observations cannot undo
   * newer heads; an equal-height replacement invalidates the previous fork. */
  private observe(key: string, head: Head): boolean {
    const prior = this.store.get<Head>('head.' + key);
    if (prior?.scope === head.scope && /^\d+$/.test(prior.height) && BigInt(prior.height) > BigInt(head.height)) return false;
    this.store.set('head.' + key, head);
    return true;
  }

  private read(block: AttoBlock): AttoWork | undefined {
    try {
      const record = this.store.get<StoredWork>(this.key(block));
      if (!record || !this.same(record, this.head(block)) || !/^[0-9a-f]{16}$/i.test(record.work)) return;
      const work = AttoWork.Companion.parse(record.work);
      return work.isValid(block) ? work : undefined;
    } catch { return undefined; }
  }

  private save(block: AttoBlock, head: Head, work: AttoWork): void {
    if (this.closed || this.scope() !== head.scope) return;
    this.store.transaction(() => {
      const observed = this.store.get<Head>('head.' + this.key(block));
      if (observed && !this.same(observed, head)) return;
      this.store.set(this.key(block), { scope: head.scope, target: head.target, height: head.height, work: work.toString() } satisfies StoredWork);
      this.store.set(QUEUE_KEY, this.queue().filter(job => job.key !== this.key(block) || !this.same(job, head)));
    });
  }

  private async obtain(block: AttoBlock, speculative: boolean, signal?: AbortSignal): Promise<AttoWork> {
    // Establish the shared generation before any computation takes its lock.
    // Otherwise a first enqueue could change its scope while foreground work
    // was already running under an uninitialized generation.
    if (!this.store.get(EPOCH_KEY)) {
      try {
        this.store.transaction(() => { if (!this.store.get(EPOCH_KEY)) this.store.set(EPOCH_KEY, randomUUID()); });
      } catch { /* Foreground work can still use its ordinary uncached fallback. */ }
    }
    const key = this.scope() + ':' + this.key(block) + ':' + attoBlockWorkTarget(block);
    const existing = this.computations.get(key);
    if (existing) {
      let cancel: (() => void) | undefined;
      try {
        const cancelled = new Promise<never>((_, reject) => {
          cancel = () => reject(new AttoError('CANCELLED', 'Send cancelled.'));
          if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
        });
        const work = await Promise.race([existing.promise, cancelled]);
        if (work.isValid(block)) return work;
      } catch (error) {
        if (signal?.aborted || speculative || !existing.speculative) throw error;
      } finally { if (cancel) signal?.removeEventListener('abort', cancel); }
    }
    const operation = this.compute(block, speculative, signal);
    this.active.add(operation);
    const computation = { promise: operation, speculative };
    this.computations.set(key, computation);
    try { return await operation; }
    finally {
      this.active.delete(operation);
      if (this.computations.get(key) === computation) this.computations.delete(key);
    }
  }

  private async compute(block: AttoBlock, speculative: boolean, signal?: AbortSignal): Promise<AttoWork> {
    if (this.closed) throw new AttoError('WORK_CLOSED', 'The wallet work cache is closed.');
    const settings = this.settings();
    if (block.network.name !== settings.network) throw new AttoError('NETWORK_MISMATCH', 'Work must use the configured wallet network.');
    const head = this.head(block);
    const controller = new AbortController();
    this.requests.add(controller);
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    let timer = setTimeout(() => controller.abort(), speculative ? SPECULATIVE_MS : WORKER_MS);
    let release: (() => void) | undefined;
    let slot: (() => void) | undefined;
    try {
      if (!speculative) {
        try { this.store.transaction(() => this.observe(this.key(block), head)); }
        catch { /* Coordination/cache failure falls back to foreground generation. */ }
      }
      for (;;) {
        combined.throwIfAborted();
        if (this.scope() !== head.scope) throw new AttoError('WORK_OBSOLETE', 'Wallet configuration changed during work preparation.');
        const ready = this.read(block);
        if (ready) return ready;
        try { release = this.store.tryWorkLock(head.scope + ':' + this.key(block) + ':' + head.target); }
        catch (error) { if (speculative) throw error; break; }
        if (release) break;
        await delay(25, undefined, { signal: combined });
      }
      if (speculative) {
        while (!slot) {
          for (let index = 0; index < CONCURRENCY && !slot; index++) slot = this.store.tryWorkLock('speculative-slot-' + index);
          if (!slot) await delay(25, undefined, { signal: combined });
        }
      } else {
        // Waiting for speculation does not consume the normal generation budget.
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), WORKER_MS);
      }
      const ready = this.read(block);
      if (ready) return ready;
      const work = await requestWork(block, settings.workerUrl, combined);
      try { this.save(block, head, work); } catch { /* The validated nonce remains usable. */ }
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
      slot?.(); release?.();
    }
  }

  /** Release the singleton inside the final queue transaction. An enqueue is
   * either seen by this owner or its launch candidate can become the next owner. */
  async runDetached(epoch: string): Promise<void> {
    let release: (() => void) | undefined;
    this.store.transaction(() => {
      if (this.store.get(EPOCH_KEY) === epoch) release = this.store.tryProcessLock('work-daemon');
    });
    if (!release) return;
    const unlock = () => { release?.(); release = undefined; };
    try { await this.drain(epoch, unlock); }
    finally { await this.close(); unlock(); }
  }

  private async drain(epoch = this.store.get<string>(EPOCH_KEY), unlock?: () => void): Promise<void> {
    const attempted = new Set<string>();
    const pending = new Map<string, Promise<unknown>>();
    const started = performance.now();
    try {
      for (;;) {
        if (this.closed || this.store.get(EPOCH_KEY) !== epoch || (unlock && performance.now() - started >= WORKER_MS)) break;
        const jobs = this.store.transaction(() => {
          const queue = this.queue().filter(job => job.scope === this.scope());
          this.store.set(QUEUE_KEY, queue);
          const next = queue.filter(job => !attempted.has(job.id)).slice(0, CONCURRENCY - pending.size);
          if (!next.length && !pending.size) unlock?.();
          return next;
        });
        if (!jobs.length && !pending.size) return;
        for (const job of jobs) {
          attempted.add(job.id);
          const task = (async () => {
            const template = AttoBlock.fromJson(job.block);
            if (!(template instanceof AttoChangeBlock)) return;
            const block = new AttoChangeBlock(template.network, template.version, template.algorithm, template.publicKey,
              template.height, template.balance, AttoInstant.Companion.now(), template.previous,
              template.representativeAlgorithm, template.representativePublicKey);
            const observed = this.store.get<Head>('head.' + job.key);
            if (this.key(block) !== job.key || !this.same(this.head(block), job) || (observed && !this.same(observed, job))) return;
            const work = await this.obtain(block, true);
            // Cache hits also remove jobs left by interrupted owners.
            this.save(block, job, work);
          })().catch(() => {}).finally(() => pending.delete(job.id));
          pending.set(job.id, task);
        }
        await Promise.race([...pending.values(), delay(25)]);
      }
    } finally {
      if (unlock) for (const controller of this.requests) controller.abort();
      await Promise.allSettled([...pending.values()]);
    }
  }

  async cancel(): Promise<void> {
    this.store.transaction(() => { this.store.set(EPOCH_KEY, randomUUID()); this.store.set(QUEUE_KEY, []); });
    await this.close();
    const deadline = performance.now() + 5000;
    for (;;) {
      const release = this.store.tryProcessLock('work-daemon');
      if (release) { release(); return; }
      if (performance.now() >= deadline) throw new AttoError('WALLET_BUSY', 'Public work preparation is still stopping. Retry wallet reset.');
      await delay(25);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.requests) controller.abort();
    await Promise.allSettled([...this.active, ...(this.drainTask ? [this.drainTask] : [])]);
  }
}
