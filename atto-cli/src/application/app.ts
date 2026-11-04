import { PersonalLabels } from '../labels/personal.js';
import { GlobalDirectory } from '../labels/directory.js';
import { AddressLabels } from '../labels/presentation.js';
import type { DestinationBinding } from '../spending/destination.js';
import { createHash } from 'node:crypto';
import {
  AttoMnemonic, AttoOpenBlock, AttoPublicKey, AttoReceivable, AttoReceiveBlock, AttoSignature, AttoTransaction, toAttoIndex,
} from '@attocash/commons-core';
import { amountOutput, amountRaw } from '../domain/amount.js';
import { AttoError } from '../domain/errors.js';
import { NodeReader, parseAddress, publicModel } from '../network/reader.js';
import { resolveNodeBatchSize } from '../network/batching.js';
import type { SendRetry } from '../network/retry.js';
import { OsSecretStore, type SecretStore } from '../storage/secrets.js';
import { StateStore } from '../storage/state.js';
import { resolveWalletProfile } from '../storage/profiles.js';
import { SpendLedger, type McpAccess } from '../spending/ledger.js';
import { approvalInstructions } from '../spending/approval.js';
import { Payments, type InternalMarketplacePaymentConfig } from '../spending/payments.js';
import { WalletWork, type WorkExecution } from '../wallet/work.js';
import { BackgroundReceiver } from '../wallet/background-receive.js';
import { WatchManager } from '../watches/manager.js';
import { AutoReceiver, type ReceiveProgress } from '../wallet/auto-receive.js';
import { defaultSettings } from '../wallet/defaults.js';
import { derivedSigner, mnemonicSeed, signingWallet } from '../wallet/signing.js';
import type { AccountPool, ListRequest, ReceiveRequest, SendRequest, SpendingPolicy, StreamFilter, WalletAddress, WalletIdentity, WalletSettings } from '../wallet/types.js';
import { operationFor, parseOperation } from './operations.js';
import { MarketData } from '../pricing/market.js';
import { marketTerms } from '../pricing/terms.js';
import { runDoctor } from '../doctor/doctor.js';
import { validateMarketplaceUserProofApproval, createMarketplaceProofApprovalResponse } from '../marketplace/proof-approval.js';
import { MarketplaceTopUpClient } from '../marketplace/topups.js';

interface ReceiveRecord { hash: string; index: number; blockHash: string; sourceAddress?: string; network?: string; result?: unknown }
const RESET_KEY = 'wallet.reset';

function signedMessageBytes(args: Record<string, unknown>): Int8Array {
  const bytes = args.messageHex !== undefined
    ? Buffer.from(args.messageHex as string, 'hex')
    : Buffer.from(args.message as string, 'utf8');
  return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export class AttoApplication {
  readonly store: StateStore;
  readonly ledger: SpendLedger;
  private readonly secrets: SecretStore;
  private readonly market: MarketData;
  private readonly personal: PersonalLabels;
  private readonly labels: AddressLabels;
  private readonly auto: AutoReceiver;
  private readonly work: WalletWork;
  private readonly background: BackgroundReceiver;
  private readonly receivingAllowed: () => boolean;
  private preparation?: Promise<void>;
  private readonly preparationAbort = new AbortController();
  private readonly payments: Payments;
  private readonly topUps: MarketplaceTopUpClient;
  private watchManager?: WatchManager;
  private watchConfiguration = '';
  private watchQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private started = false;
  private resetting = false;
  private recoveryReads = 0;
  private readonly calls = new Set<Promise<unknown>>();
  private readonly mcp: boolean;
  private readonly internalMarketplacePayment?: InternalMarketplacePaymentConfig;
  private readonly internalMarketplaceAuthorizeWrite?: (status: unknown) => void;
  private readonly internalMarketplaceReceiveSafety: boolean;
  private readonly doctorAbort = new AbortController();

  constructor(options: { directory?: string; secrets?: SecretStore; market?: MarketData; access?: 'mcp'; internalMarketplaceReceiveSafety?: boolean; internalMarketplaceAuthorizeWrite?: (status: unknown) => void; internalMarketplacePayment?: InternalMarketplacePaymentConfig; onReceiveProgress?: (event: ReceiveProgress) => void; sendRetry?: SendRetry; globalDirectory?: GlobalDirectory; onDestination?: (binding: DestinationBinding) => void; workExecution?: WorkExecution; receivingAllowed?: () => boolean } = {}) {
    const profile = resolveWalletProfile(options.directory);
    this.store = new StateStore(profile.directory);
    try {
      this.secrets = options.secrets ?? new OsSecretStore(profile.credentialAccount, profile.credentialService);
      this.mcp = options.access === 'mcp';
      this.internalMarketplacePayment = options.internalMarketplacePayment;
      this.internalMarketplaceAuthorizeWrite = options.internalMarketplaceAuthorizeWrite;
      this.internalMarketplaceReceiveSafety = options.internalMarketplaceReceiveSafety === true;
      this.ledger = new SpendLedger(this.store);
      this.personal = new PersonalLabels(this.store);
      this.labels = new AddressLabels(this.personal, options.globalDirectory ?? new GlobalDirectory(this.store.directory));
      this.market = options.market ?? new MarketData();
      this.store.transaction(() => {
        if (!this.store.get('settings')) this.store.set('settings', defaultSettings());
      });
      this.work = new WalletWork(this.store, () => this.settings(), options.workExecution);
      this.background = new BackgroundReceiver(this.store);
      this.receivingAllowed = options.receivingAllowed ?? (() => true);
      this.topUps = new MarketplaceTopUpClient(this.store, {
        settings: () => this.settings(), addresses: () => this.addresses(), seed: () => this.seed(), mcp: this.mcp,
      });
      this.payments = new Payments(this.store, this.ledger, {
        settings: () => this.settings(), addresses: () => this.addresses(), seed: () => this.seed(),
        requireWrite: () => this.requireMcpWrite(), mcp: this.mcp,
        ...(this.internalMarketplaceReceiveSafety ? { requireAccountsAvailable: (indexes: number[]) => this.requireReceivesResolved(indexes) } : {}),
      }, this.market, this.work, options.sendRetry, options.onDestination, this.topUps, this.internalMarketplacePayment);
      this.auto = new AutoReceiver(() => ({
        settings: !this.receivingAllowed() || (this.mcp && this.ledger.mcpAccess() !== 'spend') ? { ...this.settings(), autoReceive: false } : this.settings(),
        addresses: this.addresses(),
      }),
        (index, hash) => this.receive({ index, hash }, true),
        event => options.onReceiveProgress?.(this.labels.decorate(event, this.settings().network) as ReceiveProgress));
    } catch (error) {
      this.store.close();
      throw error;
    }
  }

  private settings() { return this.store.get<WalletSettings>('settings')!; }
  private addresses() { return this.store.get<WalletAddress[]>('addresses') ?? []; }
  private selectedAddresses(input: { index?: number; addresses?: string[]; all?: boolean }): string[] {
    const selected = input.addresses ?? (input.index !== undefined ? [this.address(input.index).address]
      : this.addresses().filter(address => input.all || address.active).map(address => address.address));
    return [...new Set(selected.map(address => parseAddress(address).value))];
  }
  private identity() { return this.store.get<WalletIdentity>('identity'); }
  private reader() { return new NodeReader(this.settings()); }

  private requireSession(): void {
    if (this.closed) throw new AttoError('SESSION_CLOSED', 'This wallet session has closed.');
    if (this.resetting) throw new AttoError('WALLET_BUSY', 'Wallet reset is in progress.');
  }

  private requireReady(): void {
    this.requireSession();
    this.requireResetFinished();
  }

  private requireResetFinished(): void {
    if (this.store.get(RESET_KEY)) throw new AttoError('WALLET_RESET_REQUIRED', 'Wallet reset was interrupted. Run atto wallet reset again to finish cleanup.');
  }

  private requireMcpWrite(): void {
    this.requireResetFinished();
    if (this.mcp && this.ledger.mcpAccess() !== 'spend') {
      throw new AttoError('MCP_READ_ONLY', 'MCP has read-only access to this wallet. Propose limits and obtain local terminal approval to enable transactions.');
    }
    if (this.internalMarketplaceAuthorizeWrite) {
      this.internalMarketplaceAuthorizeWrite({ initialized: Boolean(this.identity()), identity: this.identity() ?? null,
        settings: this.settings(), addresses: this.addresses(), mcpAccess: this.ledger.mcpAccess(), pool: this.ledger.pool() });
    }
  }

  private proposalWallet() {
    return { directory: this.store.directory, walletFingerprint: this.identity()?.fingerprint ?? null, network: this.settings().network };
  }

  private requireLocalApproval(): void {
    this.requireReady();
    if (this.mcp) throw new AttoError('LOCAL_APPROVAL_REQUIRED', 'Limit changes require approval in a local terminal.');
  }

  async reviewLimitsProposal(id: string) {
    this.requireLocalApproval();
    return this.store.withWalletLock(async () => ({
      proposal: this.ledger.reviewProposal(id, this.proposalWallet()), directory: this.store.directory,
      identity: this.identity() ?? null, network: this.settings().network,
      policy: this.ledger.policy(), mcpAccess: this.ledger.mcpAccess(), pool: this.ledger.pool(),
      messageSigningIndexes: this.ledger.messageSigningIndexes(),
    }));
  }

  async approveLimitsProposal(id: string) {
    this.requireLocalApproval();
    return this.store.withWalletLock(async () => {
      const proposal = this.ledger.reviewProposal(id, this.proposalWallet());
      if (proposal.status === 'pending' && proposal.pool) {
        for (const index of proposal.pool.indexes) await this.deriveAddress(index);
      }
      this.ledger.approveProposal(id, this.proposalWallet());
      return this.ledger.usage();
    });
  }

  async rejectLimitsProposal(id: string) {
    this.requireLocalApproval();
    return this.store.withWalletLock(async () => {
      this.ledger.rejectProposal(id, this.proposalWallet());
      return this.ledger.usage();
    });
  }

  async createWallet(mnemonic?: string): Promise<unknown> {
    this.requireReady();
    return this.store.withWalletLock(async () => {
      this.requireReady();
      if (this.identity()) throw new AttoError('WALLET_EXISTS', 'This wallet is already initialized.');
      const existing = await this.secrets.get();
      if (existing && !mnemonic) throw new AttoError('WALLET_EXISTS', 'A credential already exists. Import its phrase to recover the public wallet state.');
      const phrase = (mnemonic ?? (await AttoMnemonic.generate()).phrase).normalize('NFKD').trim().replace(/\s+/g, ' ');
      const seed = await mnemonicSeed(phrase);
      try {
        if (existing && existing !== phrase) throw new AttoError('WALLET_EXISTS', 'The password-store entry belongs to a different mnemonic.');
        const signer = await derivedSigner(seed, 0);
        const address: WalletAddress = { index: 0, address: signer.address.value, publicKey: signer.publicKey.toString(), active: true };
        const identity = { address: address.address, fingerprint: createHash('sha256').update(address.publicKey).digest('hex') };
        if (!existing) await this.secrets.set(phrase);
        this.store.transaction(() => { this.store.set('identity', identity); this.store.set('addresses', [address]); });
        return { identity, addresses: [address] };
      } finally { seed.value.fill(0); }
    });
  }

  async backupMnemonic(): Promise<string> {
    this.requireSession();
    this.recoveryReads++;
    try {
      const phrase = await this.secrets.get();
      if (!phrase) {
        this.requireResetFinished();
        if (this.identity()) throw new AttoError('WALLET_CREDENTIAL_MISSING', 'The wallet is initialized, but the OS password store returned no recovery phrase for this profile. Run doctor in this session to check credential access. Do not reset or replace the wallet.');
        throw new AttoError('WALLET_NOT_INITIALIZED', 'Create or import a wallet through the CLI first.');
      }
      return phrase;
    } finally { this.recoveryReads--; }
  }

  private requireResetAvailable(): void {
    this.requireSession();
    if (this.mcp) throw new AttoError('LOCAL_APPROVAL_REQUIRED', 'Wallet reset requires approval in a local terminal.');
    if (this.background.status().state !== 'stopped') throw new AttoError('WALLET_BUSY', 'Stop the background receiver before resetting this wallet.');
    if (this.started || this.calls.size || this.recoveryReads || this.store.busy
      || this.watchManager?.list().some(watch => ['running', 'reconnecting'].includes(watch.status))) {
      throw new AttoError('WALLET_BUSY', 'Stop active wallet operations and reset from a new terminal command.');
    }
    if (!this.secrets.remove) throw new AttoError('SECRET_STORE_UNSUPPORTED', 'This password store does not support wallet reset.');
  }

  private requireNoPendingPayments(): void {
    if (this.ledger.pending().length) throw new AttoError('PUBLICATION_UNCERTAIN', 'Resolve unfinished payments before resetting this wallet. Check the journal and resume their original request IDs.');
  }

  async reviewWalletReset() {
    this.requireResetAvailable();
    return this.store.withWalletLock(async () => {
      this.requireNoPendingPayments();
      return { directory: this.store.directory, identity: this.identity() ?? null, network: this.settings().network };
    });
  }

  async resetWallet(expectedFingerprint: string | null): Promise<{ reset: true }> {
    this.requireResetAvailable();
    this.resetting = true;
    try {
      // A previous completed send may still have speculative public work queued.
      // Stop it before clearing state; normal calls cannot start during reset.
      await this.work.cancel();
      await this.store.withExclusiveReset(() => this.store.withWalletLock(async () => {
        if ((this.identity()?.fingerprint ?? null) !== expectedFingerprint) {
          throw new AttoError('WALLET_CHANGED', 'The wallet changed after confirmation. Review it before resetting again.');
        }
        this.requireNoPendingPayments();
        const releases: Array<() => void> = [];
        try {
          for (const address of this.addresses()) {
            const release = this.store.tryAccountLocks([address.index]);
            if (!release) throw new AttoError('WALLET_BUSY', 'Wait for account operations before resetting this wallet.');
            releases.push(release);
          }
          // Keyring and SQLite cannot share a transaction. Preserve the old
          // public state behind a durable marker until credential deletion is
          // verified, so interruption always resumes through this same path.
          if (!this.store.get(RESET_KEY)) this.store.transaction(() => this.store.set(RESET_KEY, { startedAt: new Date().toISOString() }));
          if (await this.secrets.get() !== null) await this.secrets.remove!();
          if (await this.secrets.get() !== null) throw new AttoError('SECRET_STORE_UNAVAILABLE', 'The password store did not remove the wallet credential. Unlock it and run wallet reset again.');
          this.store.transaction(() => {
            this.store.clearForReset();
            this.store.set('settings', defaultSettings());
          });
        } finally { for (const release of releases) release(); }
      }));
      return { reset: true };
    } finally {
      this.resetting = false;
      await this.close();
    }
  }

  private async seed() {
    this.requireResetFinished();
    const identity = this.identity();
    if (!identity) throw new AttoError('WALLET_NOT_INITIALIZED', 'Create or import a wallet through the CLI first.');
    const seed = await mnemonicSeed(await this.backupMnemonic());
    const signer = await derivedSigner(seed, 0);
    if (signer.address.value !== identity.address) {
      seed.value.fill(0);
      throw new AttoError('WALLET_MISMATCH', 'The credential does not match this wallet’s public state.');
    }
    return seed;
  }

  private address(index = 0, requireActive = false): WalletAddress {
    const address = this.addresses().find(address => address.index === index);
    if (!address) throw new AttoError('ADDRESS_NOT_DERIVED', 'Derive or activate the key index first.');
    if (requireActive && !address.active) throw new AttoError('ADDRESS_INACTIVE', 'Activate this address before automatic receiving.');
    return address;
  }

  private async derive(index: number, active?: boolean) {
    return this.store.withWalletLock(async () => {
      this.requireMcpWrite();
      return this.deriveAddress(index, active);
    });
  }

  /** The caller owns the wallet lock, including terminal pool approval. */
  private async deriveAddress(index: number, active?: boolean) {
    const addresses = this.addresses();
    let address = addresses.find(address => address.index === index);
    if (active === true && !address?.active && addresses.filter(address => address.active).length >= 100) {
      throw new AttoError('ACTIVE_ADDRESS_LIMIT', 'At most 100 addresses can be active. Deactivate an address before activating another.');
    }
    if (!address) {
      const seed = await this.seed();
      try {
        const signer = await derivedSigner(seed, index);
        address = { index, address: signer.address.value, publicKey: signer.publicKey.toString(), active: active ?? false };
        addresses.push(address);
      } finally { seed.value.fill(0); }
    }
    if (active !== undefined) address.active = active;
    this.store.set('addresses', addresses.sort((a, b) => a.index - b.index));
    return address;
  }

  private async configure(input: Partial<WalletSettings>) {
    return this.store.withWalletLock(async () => {
      this.requireMcpWrite();
      const settings = { ...this.settings(), ...input };
      settings.representative = parseAddress(settings.representative).value;
      settings.minReceiveRaw = amountRaw(settings.minReceiveRaw, 'RAW');
      const changesNetwork = settings.nodeUrl !== this.settings().nodeUrl || settings.network !== this.settings().network;
      if (this.ledger.pending().length && changesNetwork) {
        throw new AttoError('PUBLICATION_UNCERTAIN', 'Resolve pending sends before changing the node or network.');
      }
      const releases: Array<() => void> = [];
      try {
        if (changesNetwork) for (const address of this.addresses()) {
          const release = this.store.tryAccountLocks([address.index]);
          if (!release) throw new AttoError('WALLET_BUSY', 'Wait for account operations before changing the node or network.');
          releases.push(release);
        }
        this.store.set('settings', settings);
      } finally { for (const release of releases) release(); }
      await this.serializeWatches(async () => {
        await this.watchManager?.close();
        this.watchManager = undefined;
      });
      return settings;
    });
  }

  private result(transaction: AttoTransaction, status = 'published') {
    return { status, hash: transaction.hash.toString(), transaction: publicModel(transaction) };
  }

  private async pendingReceivable(address: string, hash: string): Promise<AttoReceivable | undefined> {
    let found: AttoReceivable | undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      await this.reader().stream({ event: 'receivable', addresses: [address], minAmountRaw: '1' }, model => {
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

  private requireReceivesResolved(indexes: number[], allowedHash?: string): void {
    if (!this.internalMarketplaceReceiveSafety) return;
    const prefix = `receive.${this.settings().network}.`;
    for (const { key, value } of this.store.entries<ReceiveRecord>(prefix)) {
      if (!value || !Number.isSafeInteger(value.index) || value.index < 0 || value.index > 0x7fff_ffff
        || !/^[A-F0-9]{64}$/.test(value.hash) || !/^[A-F0-9]{64}$/.test(value.blockHash) || key !== `${prefix}${value.hash}`) {
        throw new AttoError('INVALID_STATE', 'The saved receive candidate is invalid. Preserve and restore its original wallet state.');
      }
      if (indexes.includes(value.index) && !value.result && value.hash !== allowedHash) {
        throw new AttoError('SOURCE_FENCED', 'Recover the original pending RECEIVE before creating another native operation.');
      }
    }
  }

  private privateReceiveObservation(record: ReceiveRecord, index: number, hash: string) {
    const network = this.settings().network;
    const address = this.address(index).address;
    const hasPrivateBinding = record.sourceAddress !== undefined || record.network !== undefined;
    if (record.hash !== hash || record.index !== index || !/^[A-F0-9]{64}$/.test(record.blockHash)
      || hasPrivateBinding && (record.sourceAddress !== address || record.network !== network)) {
      throw new AttoError('INVALID_STATE', 'The saved receive candidate does not match this wallet account and network.');
    }
    return { status: 'unknown', hash: record.blockHash, index, sendHash: hash, sourceAddress: address, network, amountAtomic: null };
  }

  private async receive(request: ReceiveRequest, automatic = false) {
    if (automatic && !this.receivingAllowed()) throw new AttoError('AUTO_RECEIVE_DISABLED', 'Automatic receiving is stopping.');
    const index = request.index ?? 0;
    const operation = async () => {
      await this.store.withWalletLock(async () => {
        this.requireMcpWrite();
        this.payments.requireAvailable(index);
        this.requireReceivesResolved([index], request.hash.toUpperCase());
      });
      if (automatic && !this.settings().autoReceive) throw new AttoError('AUTO_RECEIVE_DISABLED', 'Automatic receiving is disabled.');
      const address = this.address(index, automatic);
      const hash = request.hash.toUpperCase();
      const key = `receive.${this.settings().network}.${hash}`;
      const prior = this.store.get<ReceiveRecord>(key);
      if (prior && prior.index !== index) throw new AttoError('WRONG_RECEIVER', 'This receivable belongs to a different address.');
      if (prior && this.internalMarketplaceReceiveSafety) {
        const observation = this.privateReceiveObservation(prior, index, hash);
        let transaction: AttoTransaction | null;
        if (prior.result) {
          try { transaction = AttoTransaction.fromJson(JSON.stringify((prior.result as { transaction?: unknown }).transaction)); }
          catch { throw new AttoError('TRANSACTION_MISMATCH', 'The saved transaction does not match the original receive candidate.'); }
        } else {
          try { transaction = await this.reader().transaction(prior.blockHash); }
          catch { return observation; }
        }
        if (!transaction) return observation;
        const block = transaction.block;
        if (transaction.hash.toString() !== prior.blockHash || !await transaction.isValid()
          || !(block instanceof AttoOpenBlock || block instanceof AttoReceiveBlock)
          || block.address.value !== address.address || block.network.name !== this.settings().network || block.sendHash.toString() !== hash) {
          throw new AttoError('TRANSACTION_MISMATCH', 'The observed transaction does not match the original receive candidate.');
        }
        if (prior.result) return prior.result;
        const result = { ...this.result(transaction, 'received'), index };
        this.store.set(key, { ...prior, result });
        this.work.prepareConfirmed(block);
        return result;
      }
      if (prior?.result) return prior.result;
      if (prior) {
        const transaction = await this.reader().transaction(prior.blockHash);
        if (transaction && transaction.hash.toString() === prior.blockHash && await transaction.isValid()) {
          const result = this.result(transaction, 'received');
          this.store.set(key, { ...prior, result });
          this.work.prepareConfirmed(transaction.block);
          return result;
        }
        // Refresh pending state below: an unconsumed send permits retrying receive
        // against the current frontier without risking a second debit.
      }
      const receivable = await this.pendingReceivable(address.address, hash);
      if (!receivable) throw new AttoError('RECEIVABLE_NOT_PENDING', 'The payment is not pending for this address; it may already have been received.');
      if (receivable.receiverAddress.value !== address.address) throw new AttoError('WRONG_RECEIVER', 'The payment belongs to a different address.');
      if (automatic && BigInt(receivable.amount.toString()) < BigInt(this.settings().minReceiveRaw)) {
        throw new AttoError('RECEIVABLE_BELOW_MINIMUM', 'The payment is below the current automatic receiving minimum.');
      }
      const seed = await this.seed();
      let wallet: Awaited<ReturnType<typeof signingWallet>>['wallet'] | undefined;
      try {
        const execution = await signingWallet(seed, index, this.settings(), async block => {
          await this.store.withWalletLock(async () => {
            this.requireMcpWrite();
            this.payments.requireAvailable(index);
            if (automatic && !this.settings().autoReceive) throw new AttoError('AUTO_RECEIVE_DISABLED', 'Automatic receiving is disabled.');
            this.store.set(key, { hash, index, blockHash: block.hash.toString(),
              ...(this.internalMarketplaceReceiveSafety ? { sourceAddress: address.address, network: this.settings().network } : {}) } satisfies ReceiveRecord);
          });
        }, this.work.worker());
        wallet = execution.wallet;
        const transaction = await wallet.receive(receivable, parseAddress(request.representative ?? this.settings().representative), null);
        const result = { ...this.result(transaction, 'received'), index, amount: amountOutput(receivable.amount.toString()) };
        this.store.set(key, { hash, index, blockHash: transaction.hash.toString(), result,
          ...(this.internalMarketplaceReceiveSafety ? { sourceAddress: address.address, network: this.settings().network } : {}) } satisfies ReceiveRecord);
        this.work.prepareConfirmed(transaction.block);
        return result;
      } catch (error) {
        if (this.internalMarketplaceReceiveSafety) {
          this.requireMcpWrite();
          const candidate = this.store.get<ReceiveRecord>(key);
          if (candidate && !candidate.result) return this.privateReceiveObservation(candidate, index, hash);
        }
        throw error;
      } finally { wallet?.close(); seed.value.fill(0); }
    };
    if (!automatic) return this.store.withAccountLocks([index], operation);
    // A busy account must not stall receiving for the rest of the wallet or
    // prevent this session from stopping. The receiver will retry this item.
    const release = this.store.tryAccountLocks([index]);
    if (!release) throw new AttoError('WALLET_BUSY', 'This account is busy. Automatic receiving will retry it.');
    try { return await operation(); }
    finally { release(); }
  }

  private async receiveAll(input: { index?: number; limit?: number; timeoutMs?: number; representative?: string }) {
    const index = input.index ?? 0;
    const address = this.address(index).address;
    const list = await this.reader().list({ event: 'receivable', addresses: [address], limit: input.limit ?? 100, timeoutMs: input.timeoutMs ?? 2000 });
    const results: unknown[] = [];
    for (const item of list.items) {
      results.push(await this.receive({ index, hash: (item as { hash: string }).hash, representative: input.representative }));
    }
    return { results, timedOut: list.timedOut, ...(list.limitReached ? { limitReached: true } : {}) };
  }

  private async changeRepresentative(index: number, representative: string) {
    return this.store.withAccountLocks([index], async () => {
      await this.store.withWalletLock(async () => {
        this.requireMcpWrite();
        this.payments.requireAvailable(index);
      });
      this.address(index);
      const seed = await this.seed();
      let wallet: Awaited<ReturnType<typeof signingWallet>>['wallet'] | undefined;
      try {
        const execution = await signingWallet(seed, index, this.settings(), async () => {
          await this.store.withWalletLock(async () => {
            this.requireMcpWrite();
            this.payments.requireAvailable(index);
          });
        }, this.work.worker());
        wallet = execution.wallet;
        const transaction = await wallet.change(toAttoIndex(index), parseAddress(representative), null);
        this.work.prepareConfirmed(transaction.block);
        return this.result(transaction, 'representative_changed');
      } finally { wallet?.close(); seed.value.fill(0); }
    });
  }

  private serializeWatches<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.watchQueue.then(operation);
    this.watchQueue = result.then(() => {}, () => {});
    return result;
  }

  private withWatches<T>(operation: (manager: WatchManager) => T | Promise<T>): Promise<T> {
    return this.serializeWatches(async () => {
      const configuration = JSON.stringify(this.settings());
      if (!this.watchManager || this.watchConfiguration !== configuration) {
        await this.watchManager?.close();
        this.watchManager = new WatchManager(this.reader(), this.store);
        this.watchConfiguration = configuration;
      }
      return operation(this.watchManager);
    });
  }

  private async invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    const reader = this.reader();
    switch (name) {
      case 'doctor': return runDoctor({ directory: this.store.directory, access: this.mcp ? 'mcp' : undefined, signal: this.doctorAbort.signal, globalDirectory: args.globalDirectory as boolean | undefined });
      case 'wallet_status': return { directory: this.store.directory, initialized: Boolean(this.identity()), identity: this.identity() ?? null, settings: this.settings(), effectiveNodeBatchSize: resolveNodeBatchSize(this.settings()), addresses: this.addresses(), autoReceive: this.auto.status(), backgroundReceive: this.background.status(), mcpAccess: this.ledger.mcpAccess(), pool: this.ledger.pool(), messageSigningIndexes: this.ledger.messageSigningIndexes(), pendingSends: this.ledger.pending().map(({ id, hash, status }) => ({ requestId: id, hash, status })), resetPending: Boolean(this.store.get(RESET_KEY)) };
      case 'message_sign': return this.store.withWalletLock(async () => {
        this.requireMcpWrite();
        const index = args.index as number;
        if (!this.ledger.messageSigningIndexes().includes(index)) {
          throw new AttoError('SIGNING_NOT_APPROVED', 'This profile has not locally approved message signing for that account index.');
        }
        const saved = this.address(index);
        const seed = await this.seed();
        try {
          const signer = await derivedSigner(seed, index);
          if (signer.address.value !== saved.address || signer.publicKey.toString() !== saved.publicKey) {
            throw new AttoError('WALLET_MISMATCH', 'The signing key does not match the saved account metadata.');
          }
          return { index, address: signer.address.value, publicKey: signer.publicKey.toString(),
            signature: (await signer.signMessage(signedMessageBytes(args))).toString() };
        } finally { seed.value.fill(0); }
      });
      case 'message_verify': {
        const publicKey = args.address !== undefined
          ? parseAddress(args.address as string).publicKey
          : AttoPublicKey.Companion.parse(args.publicKey as string);
        const signature = AttoSignature.Companion.parse(args.signature as string);
        return { valid: await signature.isValidMessage(publicKey, signedMessageBytes(args)) };
      }
      case 'wallet_configure': return this.configure(args as Partial<WalletSettings>);
      case 'address_list': return { addresses: this.addresses() };
      case 'address_add': return this.store.withWalletLock(async () => {
        this.requireMcpWrite();
        const next = this.addresses().reduce((highest, address) => Math.max(highest, address.index), -1) + 1;
        if (next > 2_147_483_647) throw new AttoError('INDEX_LIMIT', 'The wallet has reached its last account index.');
        return this.deriveAddress(next, true);
      });
      case 'address_derive': return this.derive(args.index as number);
      case 'address_activate': return this.derive(args.index as number, true);
      case 'address_deactivate': return this.store.withWalletLock(async () => {
        this.requireMcpWrite();
        const index = args.index as number;
        this.address(index);
        this.store.set('addresses', this.addresses().map(address => address.index === index ? { ...address, active: false } : address));
        return this.address(index);
      });
      case 'labels_set': {
        const address = args.address !== undefined ? parseAddress(args.address as string).value : this.address(args.index as number).address;
        return { network: this.settings().network, ...this.personal.set(this.settings().network, address, args.label as string) };
      }
      case 'labels_remove': {
        const address = args.address !== undefined ? parseAddress(args.address as string).value : this.address(args.index as number).address;
        this.personal.remove(this.settings().network, address);
        return { network: this.settings().network, address, removed: true };
      }
      case 'labels_get': {
        const address = args.address !== undefined ? parseAddress(args.address as string).value : this.address(args.index as number).address;
        if (this.settings().network === 'LIVE') await this.labels.global.refresh(args.refresh as boolean | undefined);
        return { network: this.settings().network, address, addressLabels: this.labels.dictionary(this.settings().network, [address]), globalDirectory: this.labels.status(this.settings().network) };
      }
      case 'labels_list': {
        if (this.settings().network === 'LIVE' && (args.all || args.refresh)) await this.labels.global.refresh(args.refresh as boolean | undefined);
        return this.labels.list(this.settings().network, args.all as boolean | undefined, args.search as string | undefined);
      }
      case 'account_get': {
        if (args.addresses !== undefined) {
          const addresses = this.selectedAddresses(args);
          const accounts = await reader.accounts(addresses);
          return { accounts: addresses.map((address, i) => ({ address, account: publicModel(accounts[i]) })) };
        }
        return { account: publicModel(await reader.account(args.address as string ?? this.address(args.index as number | undefined).address)) };
      }
      case 'balances_get': {
        const addresses = this.selectedAddresses(args);
        const accounts = await reader.accounts(addresses);
        const raw = accounts.reduce((sum, account) => sum + BigInt(account?.balance.toString() ?? '0'), 0n).toString();
        return { balances: addresses.map((address, i) => {
          const saved = this.addresses().find(value => value.address === address);
          return { address, ...(saved ? { index: saved.index, active: saved.active } : {}), found: Boolean(accounts[i]), balance: amountOutput(accounts[i]?.balance.toString() ?? '0') };
        }), total: amountOutput(raw) };
      }
      case 'transaction_get': return { transaction: publicModel(await reader.transaction(args.hash as string)) };
      case 'entry_get': return { entry: publicModel(await reader.entry(args.hash as string)) };
      case 'representative_weight': return reader.voterWeight(args.address as string);
      case 'history_list': {
        const addresses = this.selectedAddresses(args);
        if (!addresses.length) return { items: [], timedOut: false };
        return reader.list({ ...args, addresses } as unknown as ListRequest);
      }
      case 'receivables_list': {
        const addresses = this.selectedAddresses(args);
        if (!addresses.length) return { items: [], timedOut: false };
        return reader.list({ ...args, event: 'receivable', addresses } as ListRequest);
      }
      case 'send': return this.payments.send({ ...args,
        destination: args.destinationIndex !== undefined ? this.address(args.destinationIndex as number).address : args.destination,
      } as SendRequest);
      case 'marketplace_topup': return this.payments.marketplaceTopUp(args as { amount: string; unit: 'ATTO' | 'RAW'; requestId: string; index?: number });
      case 'marketplace_topup_status': return this.payments.marketplaceTopUpStatus(args.requestId as string);
      case 'marketplace_pay_intent': {
        if (!this.internalMarketplacePayment) throw new AttoError('INTERNAL_ONLY', 'This operation is available only to the configured private Marketplace wallet child.');
        return this.payments.marketplacePayIntent(args as unknown as import('../spending/payments.js').MarketplacePayIntentRequest);
      }
      case 'marketplace_pay_intent_status': {
        if (!this.internalMarketplacePayment) throw new AttoError('INTERNAL_ONLY', 'This operation is available only to the configured private Marketplace wallet child.');
        return this.payments.marketplacePayIntentStatus(args.requestId as string);
      }
      case 'receive': return this.receive(args as unknown as ReceiveRequest);
      case 'receive_all': return this.receiveAll(args);
      case 'representative_change': return this.changeRepresentative(args.index as number, args.representative as string);
      case 'limits_get': await this.payments.reconcile(); return this.store.withWalletLock(async () => this.ledger.usage());
      case 'pool_get': return this.payments.poolStatus();
      case 'journal_list': return this.ledger.journalList(args);
      case 'journal_get': {
        const record = this.ledger.journalGet(args.requestId as string);
        if (!record) throw new AttoError('JOURNAL_NOT_FOUND', 'This payment request is not in the local journal.');
        return { record };
      }
      case 'limits_propose': return this.store.withWalletLock(async () => {
        const current = { access: this.ledger.mcpAccess(), policy: this.ledger.policy(), pool: this.ledger.pool(),
          messageSigningIndexes: this.ledger.messageSigningIndexes() };
        const proposal = this.ledger.proposePolicy(args.policy as SpendingPolicy, args.access as McpAccess, this.proposalWallet(), args.pool as AccountPool | undefined,
          args.messageSigningIndexes as number[] | undefined);
        return { proposal, approval: approvalInstructions(proposal, current) };
      });
      case 'metrics_get': return this.market.metrics();
      case 'price_quote': return this.market.quoteUsd(args.amount as string);
      case 'terms_get': return { ...marketTerms, accepted: this.store.get<{ version: string }>('market.terms')?.version === marketTerms.version };
      case 'terms_accept': return this.store.withWalletLock(async () => {
        this.requireMcpWrite();
        if (args.version !== marketTerms.version || args.accepted !== true) throw new AttoError('TERMS_VERSION', 'Read and acknowledge the current market-data terms version.');
        const acceptance = { version: marketTerms.version, acceptedAt: new Date().toISOString() };
        this.store.set('market.terms', acceptance);
        return { ...acceptance, accepted: true };
      });
      case 'watch_start': {
        const filter = { ...args } as unknown as StreamFilter;
        if (!args.hash && !args.networkWide) {
          filter.addresses = this.selectedAddresses(args);
          if (!filter.addresses.length) throw new AttoError('NO_ACTIVE_ACCOUNTS', 'No active wallet accounts. Add or activate an address, specify addresses, or select a network-wide watch.');
        }
        return this.withWatches(manager => manager.start(filter));
      }
      case 'watch_list': return this.withWatches(manager => manager.list());
      case 'watch_read': return this.withWatches(manager => manager.read(args.id as string, args.cursor as number | undefined, args.limit as number | undefined));
      case 'watch_stop': await this.withWatches(manager => manager.stop(args.id as string)); return { stopped: true };
      default: throw new AttoError('UNKNOWN_OPERATION', 'Unknown Atto operation.');
    }
  }

  async call(name: string, input: Record<string, unknown> = {}): Promise<unknown> {
    if (name === 'wallet_status' || name === 'doctor') this.requireSession();
    else this.requireReady();
    const args = parseOperation(name, input);
    if (!operationFor(name)!.readOnly && name !== 'limits_propose' && !['labels_set', 'labels_remove'].includes(name) && !name.startsWith('watch_')) this.requireMcpWrite();
    const call = (async () => {
      const result = await this.invoke(name, args);
      if (this.internalMarketplaceReceiveSafety && name === 'receive' && (result as { status?: unknown } | null)?.status === 'unknown') return result;
      if (name === 'doctor' || ['labels_get', 'labels_list', 'message_sign', 'message_verify', 'marketplace_pay_intent', 'marketplace_pay_intent_status'].includes(name)) return result;
      if (this.settings().network === 'LIVE' && ['address_list', 'account_get', 'balances_get', 'transaction_get', 'entry_get', 'representative_weight', 'history_list', 'receivables_list'].includes(name)) await this.labels.global.refresh();
      return this.labels.decorate(result, this.settings().network);
    })();
    this.calls.add(call);
    try { return await call; } finally { this.calls.delete(call); }
  }

  /** Terminal-only Marketplace controller connection; session tokens remain in memory. */
  async connectMarketplace(input: { apiUrl: string; audience: string; controllerIndex: number; browserOrigins?: string[] }) {
    this.requireReady();
    const connection = await this.store.withWalletLock(() => this.topUps.connect(input));
    return { connected: true, apiUrl: connection.apiUrl, audience: connection.audience,
      controllerIndex: connection.controllerIndex, accountId: connection.accountId, identityId: connection.identityId,
      ...(connection.browserOrigins ? { browserOrigins: connection.browserOrigins } : {}) };
  }

  inspectMarketplaceProofApproval(input: unknown) {
    this.requireReady();
    return this.topUps.inspectProofApproval(input);
  }

  async approveMarketplaceProof(input: unknown) {
    this.requireReady();
    return this.store.withWalletLock(() => this.topUps.signProofApproval(input));
  }

  /** Private Marketplace terminal signing: no standalone connection is read or changed. */
  async approveMarketplaceOwnedProof(input: unknown) {
    this.requireReady();
    if (this.mcp || !process.stdin.isTTY || !process.stderr.isTTY) {
      throw new AttoError('LOCAL_APPROVAL_REQUIRED', 'Approve Marketplace controller actions in the local terminal.');
    }
    return this.store.withWalletLock(async () => {
      const request = validateMarketplaceUserProofApproval(input, { network: 'ATTO', nativeNetwork: 'live' });
      if (this.addresses().find(address => address.index === request.controller.index)?.address !== request.controller.address) {
        throw new AttoError('WALLET_MISMATCH', 'The Marketplace controller does not match this selected wallet and index.');
      }
      const seed = await this.seed();
      try {
        const signer = await derivedSigner(seed, request.controller.index);
        if (signer.address.value !== request.controller.address) throw new AttoError('WALLET_MISMATCH', 'The selected controller key changed.');
        validateMarketplaceUserProofApproval(input, { network: 'ATTO', nativeNetwork: 'live' });
        const signature = (await signer.signMessage(new Int8Array(Buffer.from(request.challenge.message, 'utf8')))).toString();
        return createMarketplaceProofApprovalResponse(request as import('../marketplace/proof-approval.js').MarketplaceProofApprovalRequest, signature);
      } finally { seed.value.fill(0); }
    });
  }

  // The receiver observes current MCP access on every snapshot, and receive()
  // rechecks it under the wallet lock before signing any queued payment.
  async start() {
    if (this.closed) return;
    this.requireReady();
    this.started = true;
    this.auto.start();
    this.preparation ??= this.preparePoolWork();
    await this.preparation;
  }

  /** Terminal-only detached receiver control; it never changes MCP approval. */
  async startBackgroundReceiver() {
    this.requireReady();
    if (this.mcp) throw new AttoError('LOCAL_APPROVAL_REQUIRED', 'Start background receiving through the CLI.');
    return this.background.start();
  }

  async stopBackgroundReceiver() {
    this.requireSession();
    if (this.mcp) throw new AttoError('LOCAL_APPROVAL_REQUIRED', 'Stop background receiving through the CLI.');
    return this.background.stop();
  }

  resumeWork(): void { this.work.resume(); }

  private async preparePoolWork() {
    if (this.mcp && this.ledger.mcpAccess() !== 'spend') return;
    const indexes = this.ledger.pool().indexes;
    await Promise.allSettled(this.addresses().filter(address => indexes.includes(address.index)).map(async address => {
      const account = await this.reader().account(address.address, this.preparationAbort.signal);
      if (account && !this.closed) this.work.prepare([account]);
    }));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.doctorAbort.abort();
    this.preparationAbort.abort();
    await this.auto.close();
    await this.preparation;
    await Promise.allSettled([...this.calls]);
    await this.watchManager?.close();
    await this.work.close();
    this.store.close();
  }
}
