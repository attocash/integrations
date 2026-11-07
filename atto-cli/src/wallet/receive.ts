import { AttoOpenBlock, AttoReceivable, AttoReceiveBlock, AttoSeed, AttoSendBlock, AttoTransaction, toAttoIndex } from '@attocash/commons-core';
import { amountOutput, amountRaw } from '../domain/amount.js';
import { AttoError } from '../domain/errors.js';
import { NodeReader, parseAddress, publicModel } from '../network/reader.js';
import type { StateStore } from '../storage/state.js';
import { signingWallet } from './signing.js';
import type { ReceiveRequest, WalletAddress, WalletSettings } from './types.js';
import type { WalletWork } from './work.js';

interface ReceiveRecord { hash: string; index: number; blockHash: string; sourceAddress?: string; network?: string; amountAtomic?: string; result?: unknown }

/** Owns receive candidates, recovery, and the account fence shared with payments. */
export class WalletReceiver {
  constructor(private readonly context: {
    store: StateStore;
    settings: () => WalletSettings;
    address: (index: number, requireActive?: boolean) => WalletAddress;
    reader: () => NodeReader;
    seed: () => Promise<AttoSeed>;
    requireMcpWrite: () => void;
    requireAccountAvailable: (index: number) => void;
    work: WalletWork;
    receivingAllowed: () => boolean;
    internalMarketplaceReceiveSafety: boolean;
  }) {}

  private result(transaction: AttoTransaction, status = 'published') {
    return { status, hash: transaction.hash.toString(), transaction: publicModel(transaction) };
  }

  private async pendingReceivable(address: string, hash: string): Promise<AttoReceivable | undefined> {
    let found: AttoReceivable | undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      await this.context.reader().stream({ event: 'receivable', addresses: [address], minAmountRaw: '1' }, model => {
        const receivable = model as AttoReceivable;
        if (receivable.hash.toString().toUpperCase() === hash.toUpperCase()) { found = receivable; controller.abort(); }
      }, controller.signal);
    } catch (error) { if (!controller.signal.aborted) throw error; }
    finally { clearTimeout(timer); }
    if (!found && controller.signal.aborted) {
      throw new AttoError('RECEIVABLE_LOOKUP_TIMEOUT', 'Checking the pending payment timed out. Retry receiving it; its absence has not been confirmed.');
    }
    return found;
  }

  requireReceivesResolved(indexes: number[], allowedHash?: string): void {
    if (!this.context.internalMarketplaceReceiveSafety) return;
    const prefix = `receive.${this.context.settings().network}.`;
    for (const { key, value } of this.context.store.entries<ReceiveRecord>(prefix)) {
      if (!value || !Number.isSafeInteger(value.index) || value.index < 0 || value.index > 0x7fff_ffff
        || !/^[A-F0-9]{64}$/.test(value.hash) || !/^[A-F0-9]{64}$/.test(value.blockHash) || key !== `${prefix}${value.hash}`) {
        throw new AttoError('INVALID_STATE', 'The saved receive candidate is invalid. Preserve and restore its original wallet state.');
      }
      if (indexes.includes(value.index) && !value.result && value.hash !== allowedHash) {
        throw new AttoError('SOURCE_FENCED', 'Recover the original pending RECEIVE before creating another native operation.');
      }
    }
  }

  private privateReceiveBinding(record: ReceiveRecord, index: number, hash: string) {
    const network = this.context.settings().network;
    const address = this.context.address(index).address;
    const hasPrivateBinding = record.sourceAddress !== undefined || record.network !== undefined;
    if (record.hash !== hash || record.index !== index || !/^[A-F0-9]{64}$/.test(record.blockHash)
      || hasPrivateBinding && (record.sourceAddress !== address || record.network !== network)) {
      throw new AttoError('INVALID_STATE', 'The saved receive candidate does not match this wallet account and network.');
    }
    return { hash: record.blockHash, index, sendHash: hash, sourceAddress: address, network };
  }

  private savedReceiveAmount(record: ReceiveRecord): string | undefined {
    const checked = (value: unknown): string => {
      try {
        if (typeof value !== 'string' || amountRaw(value, 'RAW') !== value) throw new Error();
        return value;
      } catch { throw new AttoError('INVALID_STATE', 'The saved receive amount is invalid.'); }
    };
    const candidate = record.amountAtomic === undefined ? undefined : checked(record.amountAtomic);
    let completed: string | undefined;
    if (record.result !== undefined) {
      if (!record.result || typeof record.result !== 'object' || Array.isArray(record.result)) {
        throw new AttoError('INVALID_STATE', 'The saved receive result is invalid.');
      }
      const amount = (record.result as { amount?: unknown }).amount;
      if (amount !== undefined) {
        if (!amount || typeof amount !== 'object' || Array.isArray(amount)) {
          throw new AttoError('INVALID_STATE', 'The saved receive amount is invalid.');
        }
        completed = checked((amount as { raw?: unknown }).raw);
      }
    }
    if (candidate !== undefined && completed !== undefined && candidate !== completed) {
      throw new AttoError('INVALID_STATE', 'The saved receive amounts disagree.');
    }
    return candidate ?? completed;
  }

  /** Older standalone records retain their shape; signed SEND history supplies missing metadata. */
  private async recoverReceiveAmount(hash: string, address: string): Promise<string> {
    const unavailable = () => new AttoError('RECEIVE_RECOVERY_UNAVAILABLE',
      'The original SEND amount is unavailable. Retry receive with the same incoming SEND hash; its candidate is unchanged.');
    let source: AttoTransaction | null;
    try { source = await this.context.reader().transaction(hash); }
    catch (error) {
      if (error instanceof AttoError && error.code === 'INVALID_NODE_RESPONSE') {
        throw new AttoError('TRANSACTION_MISMATCH', 'The original SEND history is invalid.');
      }
      if (error instanceof AttoError && ['NODE_UNAVAILABLE', 'NODE_TIMEOUT', 'NODE_HTTP_ERROR', 'CANCELLED'].includes(error.code)) {
        throw unavailable();
      }
      throw error;
    }
    if (!source) throw unavailable();
    const block = source.block;
    if (source.hash.toString() !== hash || !await source.isValid() || !(block instanceof AttoSendBlock)
      || block.network.name !== this.context.settings().network || block.receiverAddress.value !== address) {
      throw new AttoError('TRANSACTION_MISMATCH', 'The original SEND does not match this receive.');
    }
    return amountRaw(block.amount.toString(), 'RAW');
  }

  async receive(request: ReceiveRequest, automatic = false) {
    if (automatic && !this.context.receivingAllowed()) throw new AttoError('AUTO_RECEIVE_DISABLED', 'Automatic receiving is stopping.');
    const index = request.index ?? 0;
    const operation = async () => {
      await this.context.store.withWalletLock(async () => {
        this.context.requireMcpWrite();
        this.context.requireAccountAvailable(index);
        this.requireReceivesResolved([index], request.hash.toUpperCase());
      });
      if (automatic && !this.context.settings().autoReceive) throw new AttoError('AUTO_RECEIVE_DISABLED', 'Automatic receiving is disabled.');
      const address = this.context.address(index, automatic);
      const hash = request.hash.toUpperCase();
      const key = `receive.${this.context.settings().network}.${hash}`;
      const prior = this.context.store.get<ReceiveRecord>(key);
      if (prior && prior.index !== index) throw new AttoError('WRONG_RECEIVER', 'This receivable belongs to a different address.');
      if (prior && this.context.internalMarketplaceReceiveSafety) {
        const binding = this.privateReceiveBinding(prior, index, hash);
        const savedAmount = this.savedReceiveAmount(prior);
        let transaction: AttoTransaction | null;
        if (prior.result) {
          try { transaction = AttoTransaction.fromJson(JSON.stringify((prior.result as { transaction?: unknown }).transaction)); }
          catch { throw new AttoError('TRANSACTION_MISMATCH', 'The saved transaction does not match the original receive candidate.'); }
        } else {
          try { transaction = await this.context.reader().transaction(prior.blockHash); }
          catch { transaction = null; }
        }
        if (transaction) {
          const block = transaction.block;
          if (transaction.hash.toString() !== prior.blockHash || !await transaction.isValid()
            || !(block instanceof AttoOpenBlock || block instanceof AttoReceiveBlock)
            || block.address.value !== address.address || block.network.name !== this.context.settings().network || block.sendHash.toString() !== hash
            || prior.result && (typeof (prior.result as { hash?: unknown }).hash !== 'string'
              || (prior.result as { hash: string }).hash.toUpperCase() !== prior.blockHash)) {
            throw new AttoError('TRANSACTION_MISMATCH', 'The observed transaction does not match the original receive candidate.');
          }
        }
        const amount = savedAmount ?? await this.recoverReceiveAmount(hash, address.address);
        if (!transaction) return { status: 'unknown', ...binding, amountAtomic: amount };
        if (prior.result) {
          return (prior.result as { amount?: unknown }).amount === undefined
            ? { ...(prior.result as Record<string, unknown>), amount: amountOutput(amount) } : prior.result;
        }
        const result = { ...this.result(transaction, 'received'), index, amount: amountOutput(amount) };
        this.context.store.set(key, { ...prior, result });
        this.context.work.prepareConfirmed(transaction.block);
        return result;
      }
      if (prior?.result) return prior.result;
      if (prior) {
        const transaction = await this.context.reader().transaction(prior.blockHash);
        if (transaction && transaction.hash.toString() === prior.blockHash && await transaction.isValid()) {
          const result = this.result(transaction, 'received');
          this.context.store.set(key, { ...prior, result });
          this.context.work.prepareConfirmed(transaction.block);
          return result;
        }
        // Refresh pending state below: an unconsumed send permits retrying receive
        // against the current frontier without risking a second debit.
      }
      const receivable = await this.pendingReceivable(address.address, hash);
      if (!receivable) throw new AttoError('RECEIVABLE_NOT_PENDING', 'The payment is not pending for this address; it may already have been received.');
      if (receivable.receiverAddress.value !== address.address) throw new AttoError('WRONG_RECEIVER', 'The payment belongs to a different address.');
      if (automatic && BigInt(receivable.amount.toString()) < BigInt(this.context.settings().minReceiveRaw)) {
        throw new AttoError('RECEIVABLE_BELOW_MINIMUM', 'The payment is below the current automatic receiving minimum.');
      }
      const seed = await this.context.seed();
      let wallet: Awaited<ReturnType<typeof signingWallet>>['wallet'] | undefined;
      try {
        const execution = await signingWallet(seed, index, this.context.settings(), async block => {
          await this.context.store.withWalletLock(async () => {
            this.context.requireMcpWrite();
            this.context.requireAccountAvailable(index);
            if (automatic && !this.context.settings().autoReceive) throw new AttoError('AUTO_RECEIVE_DISABLED', 'Automatic receiving is disabled.');
            this.context.store.set(key, { hash, index, blockHash: block.hash.toString(),
              ...(this.context.internalMarketplaceReceiveSafety ? { sourceAddress: address.address, network: this.context.settings().network,
                amountAtomic: receivable.amount.toString() } : {}) } satisfies ReceiveRecord);
          });
        }, this.context.work.worker());
        wallet = execution.wallet;
        const transaction = await wallet.receive(receivable, parseAddress(request.representative ?? this.context.settings().representative), null);
        const result = { ...this.result(transaction, 'received'), index, amount: amountOutput(receivable.amount.toString()) };
        this.context.store.set(key, { hash, index, blockHash: transaction.hash.toString(), result,
          ...(this.context.internalMarketplaceReceiveSafety ? { sourceAddress: address.address, network: this.context.settings().network,
            amountAtomic: receivable.amount.toString() } : {}) } satisfies ReceiveRecord);
        this.context.work.prepareConfirmed(transaction.block);
        return result;
      } catch (error) {
        if (this.context.internalMarketplaceReceiveSafety) {
          this.context.requireMcpWrite();
          const candidate = this.context.store.get<ReceiveRecord>(key);
          if (candidate && !candidate.result) {
            const binding = this.privateReceiveBinding(candidate, index, hash);
            const amount = this.savedReceiveAmount(candidate) ?? await this.recoverReceiveAmount(hash, address.address);
            return { status: 'unknown', ...binding, amountAtomic: amount };
          }
        }
        throw error;
      } finally { wallet?.close(); seed.value.fill(0); }
    };
    if (!automatic) return this.context.store.withAccountLocks([index], operation);
    // A busy account must not stall receiving for the rest of the wallet or
    // prevent this session from stopping. The receiver will retry this item.
    const release = this.context.store.tryAccountLocks([index]);
    if (!release) throw new AttoError('WALLET_BUSY', 'This account is busy. Automatic receiving will retry it.');
    try { return await operation(); }
    finally { release(); }
  }

  async receiveAll(input: { index?: number; limit?: number; timeoutMs?: number; representative?: string }) {
    const index = input.index ?? 0;
    const address = this.context.address(index).address;
    const list = await this.context.reader().list({ event: 'receivable', addresses: [address], limit: input.limit ?? 100, timeoutMs: input.timeoutMs ?? 2000 });
    const results: unknown[] = [];
    for (const item of list.items) {
      results.push(await this.receive({ index, hash: (item as { hash: string }).hash, representative: input.representative }));
    }
    return { results, timedOut: list.timedOut, ...(list.limitReached ? { limitReached: true } : {}) };
  }

}
