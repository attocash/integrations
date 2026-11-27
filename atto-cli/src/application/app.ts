import { isDeepStrictEqual } from 'node:util';
import {
  AttoPublicKey, AttoSignature, AttoTransaction, toAttoIndex,
} from '@attocash/commons-core';
import { runDoctor } from '../doctor/doctor.js';
import { parseAddress } from '../domain/address.js';
import { amountOutput } from '../domain/amount.js';
import { AttoError } from '../domain/errors.js';
import { GlobalDirectory } from '../labels/directory.js';
import { PersonalLabels } from '../labels/personal.js';
import { AddressLabels } from '../labels/presentation.js';
import { MarketplaceConnectionClient } from '../marketplace/connection.js';
import { requireMarketplaceLoginAuthorization } from '../marketplace/login-authorization.js';
import { createMarketplaceProofApprovalResponse, validateMarketplaceUserProofApproval } from '../marketplace/proof-approval.js';
import { resolveNodeBatchSize } from '../network/batching.js';
import { NodeReader, publicModel } from '../network/reader.js';
import type { SendRetry } from '../network/retry.js';
import { MarketData } from '../pricing/market.js';
import { marketTerms } from '../pricing/terms.js';
import { approvalInstructions } from '../spending/approval.js';
import type { DestinationBinding } from '../spending/destination.js';
import { SpendLedger, type McpAccess } from '../spending/ledger.js';
import { Payments } from '../spending/payments.js';
import { resolveWalletProfile } from '../storage/profiles.js';
import { OsSecretStore, type SecretStore } from '../storage/secrets.js';
import { StateStore } from '../storage/state.js';
import { AutoReceiver, type ReceiveProgress } from '../wallet/auto-receive.js';
import { BackgroundReceiver } from '../wallet/background-receive.js';
import { defaultSettings } from '../wallet/defaults.js';
import { WalletLifecycle } from '../wallet/lifecycle.js';
import { WalletReceiver } from '../wallet/receive.js';
import { derivedSigner, signingWallet } from '../wallet/signing.js';
import type { AccountPool, ListRequest, ReceiveRequest, SendRequest, SpendingPolicy, StreamFilter, WalletAddress, WalletIdentity, WalletSettings } from '../wallet/types.js';
import { WalletWork, type WorkExecution } from '../wallet/work.js';
import { WatchManager } from '../watches/manager.js';
import { findOperation, parseOperation } from './operations.js';

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
  private readonly lifecycle: WalletLifecycle;
  private readonly market: MarketData;
  private readonly personal: PersonalLabels;
  private readonly labels: AddressLabels;
  private readonly auto: AutoReceiver;
  private readonly receiver: WalletReceiver;
  private readonly work: WalletWork;
  private readonly background: BackgroundReceiver;
  private readonly receivingAllowed: () => boolean;
  private preparation?: Promise<void>;
  private readonly preparationAbort = new AbortController();
  private readonly payments: Payments;
  private readonly marketplaceConnection: MarketplaceConnectionClient;
  private watchManager?: WatchManager;
  private watchConfiguration = '';
  private watchQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private started = false;
  private resetting = false;
  private readonly calls = new Set<Promise<unknown>>();
  private readonly mcp: boolean;
  private readonly internalMarketplaceAuthorizeWrite?: (status: unknown) => void;
  private readonly internalMarketplaceReceiveSafety: boolean;
  private readonly doctorAbort = new AbortController();

  get directory(): string { return this.store.directory; }

  constructor(options: { directory?: string; secrets?: SecretStore; market?: MarketData; access?: 'mcp'; internalMarketplaceReceiveSafety?: boolean; internalMarketplaceAuthorizeWrite?: (status: unknown) => void; onReceiveProgress?: (event: ReceiveProgress) => void; sendRetry?: SendRetry; globalDirectory?: GlobalDirectory; onDestination?: (binding: DestinationBinding) => void; workExecution?: WorkExecution; receivingAllowed?: () => boolean } = {}) {
    const profile = resolveWalletProfile(options.directory);
    this.store = new StateStore(profile.directory);
    try {
      this.secrets = options.secrets ?? new OsSecretStore(profile.credentialAccount, profile.credentialService);
      this.mcp = options.access === 'mcp';
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
      this.lifecycle = new WalletLifecycle(this.store, this.secrets, this.ledger, {
        requireSession: () => this.requireSession(),
        requireReady: () => this.requireReady(),
        requireMcpWrite: () => this.requireMcpWrite(),
        requireResetAvailable: () => this.requireResetAvailable(),
        // A previous completed send may still have speculative public work queued.
        // Stop it before clearing state; normal calls cannot start during reset.
        beforeReset: () => this.work.cancel(),
        onNetworkChanged: () => this.serializeWatches(async () => {
          await this.watchManager?.close();
          this.watchManager = undefined;
        }),
        loadSeed: () => this.seed(),
      });
      this.marketplaceConnection = new MarketplaceConnectionClient(this.store, {
        settings: () => this.settings(), addresses: () => this.addresses(), seed: () => this.seed(), mcp: this.mcp,
      });
      this.receiver = new WalletReceiver({
        store: this.store, settings: () => this.settings(), address: (index, active) => this.address(index, active),
        reader: () => this.reader(), seed: () => this.seed(), requireMcpWrite: () => this.requireMcpWrite(),
        requireAccountAvailable: index => this.ledger.assertAccountAvailable(index), work: this.work, receivingAllowed: this.receivingAllowed,
        internalMarketplaceReceiveSafety: this.internalMarketplaceReceiveSafety,
      });
      this.payments = new Payments(this.store, this.ledger, {
        settings: () => this.settings(), addresses: () => this.addresses(), seed: () => this.seed(),
        requireWrite: () => this.requireMcpWrite(), mcp: this.mcp,
        ...(this.internalMarketplaceReceiveSafety ? { requireAccountsAvailable: (indexes: number[]) => this.receiver.requireReceivesResolved(indexes) } : {}),
      }, this.market, this.work, options.sendRetry, options.onDestination);
      this.auto = new AutoReceiver(() => ({
        settings: !this.receivingAllowed() || (this.mcp && this.ledger.mcpAccess() !== 'spend') ? { ...this.settings(), autoReceive: false } : this.settings(),
        addresses: this.addresses(),
      }),
        (index, hash) => this.receiver.receive({ index, hash }, true),
        event => options.onReceiveProgress?.(this.labels.decorate(event, this.settings().network) as ReceiveProgress));
    } catch (error) {
      this.store.close();
      throw error;
    }
  }

  private settings(): WalletSettings { return this.lifecycle.settings(); }
  private addresses(): WalletAddress[] { return this.lifecycle.addresses(); }
  private identity(): WalletIdentity | undefined { return this.lifecycle.identity(); }
  private address(index = 0, requireActive = false): WalletAddress { return this.lifecycle.address(index, requireActive); }
  private selectedAddresses(input: { index?: number; addresses?: string[]; all?: boolean }): string[] { return this.lifecycle.selectedAddresses(input); }
  private reader() { return new NodeReader(this.settings()); }
  private seed() { return this.lifecycle.loadSeed(); }
  private configure(input: Partial<WalletSettings>) { return this.lifecycle.configure(input); }

  private requireSession(): void {
    if (this.closed) throw new AttoError('SESSION_CLOSED', 'This wallet session has closed.');
    if (this.resetting) throw new AttoError('WALLET_BUSY', 'Wallet reset is in progress.');
  }

  private requireReady(): void {
    this.requireSession();
    this.lifecycle.requireResetFinished();
  }

  private requireMcpWrite(): void {
    this.lifecycle.requireResetFinished();
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

  authoritySnapshot(): { policy: SpendingPolicy; pool: AccountPool; access: McpAccess; messageSigningIndexes: number[] } {
    this.requireReady();
    return {
      policy: this.ledger.policy(),
      pool: this.ledger.pool(),
      access: this.ledger.mcpAccess(),
      messageSigningIndexes: this.ledger.messageSigningIndexes(),
    };
  }

  async proposeLimitsIfUnchanged(options: {
    expectedUsage: { policy: SpendingPolicy; pool: AccountPool; access: McpAccess; messageSigningIndexes: number[] };
    expectedSettings: WalletSettings;
    expectedIdentity: WalletIdentity | null;
    requested: { policy: SpendingPolicy; access: McpAccess; pool: AccountPool; messageSigningIndexes: number[] };
  }) {
    this.requireSession();
    if (this.mcp) throw new AttoError('LOCAL_APPROVAL_REQUIRED', 'Limit changes require approval in a local terminal.');
    return this.store.withWalletLock(async () => {
      if (this.lifecycle.isResetPending()) {
        throw new AttoError('WALLET_RESET_REQUIRED', 'Finish wallet reset before configuring Marketplace.');
      }
      if (!isDeepStrictEqual(options.expectedUsage, this.authoritySnapshot())
        || !isDeepStrictEqual(options.expectedSettings, this.settings())
        || !isDeepStrictEqual(options.expectedIdentity, this.identity() ?? null)) {
        throw new AttoError('PROPOSAL_STALE', 'The shared wallet settings or authority changed during setup. Review the current wallet and run setup again.');
      }
      if (isDeepStrictEqual(options.expectedUsage, options.requested)) return null;
      return this.ledger.proposePolicy(
        options.requested.policy, options.requested.access, this.proposalWallet(),
        options.requested.pool, options.requested.messageSigningIndexes,
      );
    });
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

  async approveLimitsProposal(id: string, validateReviewedState?: () => void, inspectApprovedState?: () => void) {
    this.requireLocalApproval();
    return this.store.withWalletLock(async () => {
      validateReviewedState?.();
      const proposal = this.ledger.reviewProposal(id, this.proposalWallet());
      if (proposal.status === 'pending' && proposal.pool) {
        for (const index of proposal.pool.indexes) await this.lifecycle.deriveAddress(index);
      }
      this.ledger.approveProposal(id, this.proposalWallet());
      inspectApprovedState?.();
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

  createWallet(mnemonic?: string): Promise<unknown> { return this.lifecycle.createWallet(mnemonic); }
  backupMnemonic(): Promise<string> { return this.lifecycle.backupMnemonic(); }
  reviewWalletReset() { return this.lifecycle.reviewReset(); }

  private requireResetAvailable(): void {
    this.requireSession();
    if (this.mcp) throw new AttoError('LOCAL_APPROVAL_REQUIRED', 'Wallet reset requires approval in a local terminal.');
    if (this.background.status().state !== 'stopped') throw new AttoError('WALLET_BUSY', 'Stop the background receiver before resetting this wallet.');
    if (this.started || this.calls.size || this.lifecycle.readingRecovery || this.store.busy
      || this.watchManager?.list().some(watch => ['running', 'reconnecting'].includes(watch.status))) {
      throw new AttoError('WALLET_BUSY', 'Stop active wallet operations and reset from a new terminal command.');
    }
    if (!this.secrets.remove) throw new AttoError('SECRET_STORE_UNSUPPORTED', 'This password store does not support wallet reset.');
  }

  async resetWallet(expectedFingerprint: string | null): Promise<{ reset: true }> {
    this.requireResetAvailable();
    this.resetting = true;
    try {
      return await this.lifecycle.resetWallet(expectedFingerprint);
    } finally {
      this.resetting = false;
      await this.close();
    }
  }

  private result(transaction: AttoTransaction, status = 'published') {
    return { status, hash: transaction.hash.toString(), transaction: publicModel(transaction) };
  }

  private async changeRepresentative(index: number, representative: string) {
    return this.store.withAccountLocks([index], async () => {
      await this.store.withWalletLock(async () => {
        this.requireMcpWrite();
        this.ledger.assertAccountAvailable(index);
      });
      this.address(index);
      const seed = await this.seed();
      let wallet: Awaited<ReturnType<typeof signingWallet>>['wallet'] | undefined;
      try {
        const execution = await signingWallet(seed, index, this.settings(), async () => {
          await this.store.withWalletLock(async () => {
            this.requireMcpWrite();
            this.ledger.assertAccountAvailable(index);
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
    switch (name) {
      case 'doctor': return runDoctor({ directory: this.store.directory, access: this.mcp ? 'mcp' : undefined, signal: this.doctorAbort.signal, globalDirectory: args.globalDirectory as boolean | undefined });
      case 'wallet_status': return { directory: this.store.directory, initialized: Boolean(this.identity()), identity: this.identity() ?? null, settings: this.settings(), effectiveNodeBatchSize: resolveNodeBatchSize(this.settings()), addresses: this.addresses(), autoReceive: this.auto.status(), backgroundReceive: this.background.status(), mcpAccess: this.ledger.mcpAccess(), pool: this.ledger.pool(), messageSigningIndexes: this.ledger.messageSigningIndexes(), pendingSends: this.ledger.pending().map(({ id, hash, status }) => ({ requestId: id, hash, status })), resetPending: this.lifecycle.isResetPending() };
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
      case 'wallet_configure': return this.lifecycle.configure(args as Partial<WalletSettings>);
      case 'address_list': return { addresses: this.addresses() };
      case 'address_add': return this.lifecycle.addAddress();
      case 'address_derive': return this.lifecycle.derive(args.index as number);
      case 'address_activate': return this.lifecycle.derive(args.index as number, true);
      case 'address_deactivate': return this.lifecycle.deactivateAddress(args.index as number);
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
        const reader = this.reader();
        if (args.addresses !== undefined) {
          const addresses = this.selectedAddresses(args);
          const accounts = await reader.accounts(addresses);
          return { accounts: addresses.map((address, i) => ({ address, account: publicModel(accounts[i]) })) };
        }
        return { account: publicModel(await reader.account(args.address as string ?? this.address(args.index as number | undefined).address)) };
      }
      case 'balances_get': {
        const addresses = this.selectedAddresses(args);
        const accounts = await this.reader().accounts(addresses);
        const raw = accounts.reduce((sum, account) => sum + BigInt(account?.balance.toString() ?? '0'), 0n).toString();
        return { balances: addresses.map((address, i) => {
          const saved = this.addresses().find(value => value.address === address);
          return { address, ...(saved ? { index: saved.index, active: saved.active } : {}), found: Boolean(accounts[i]), balance: amountOutput(accounts[i]?.balance.toString() ?? '0') };
        }), total: amountOutput(raw) };
      }
      case 'transaction_get': return { transaction: publicModel(await this.reader().transaction(args.hash as string)) };
      case 'entry_get': return { entry: publicModel(await this.reader().entry(args.hash as string)) };
      case 'representative_weight': return this.reader().voterWeight(args.address as string);
      case 'history_list': {
        const addresses = this.selectedAddresses(args);
        if (!addresses.length) return { items: [], timedOut: false };
        return this.reader().list({ ...args, addresses } as unknown as ListRequest);
      }
      case 'receivables_list': {
        const addresses = this.selectedAddresses(args);
        if (!addresses.length) return { items: [], timedOut: false };
        return this.reader().list({ ...args, event: 'receivable', addresses } as ListRequest);
      }
      case 'send': return this.payments.send({ ...args,
        destination: args.destinationIndex !== undefined ? this.address(args.destinationIndex as number).address : args.destination,
      } as SendRequest);
      case 'receive': return this.receiver.receive(args as unknown as ReceiveRequest);
      case 'receive_all': return this.receiver.receiveAll(args);
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
      case 'price_quote': return args.from === 'ATTO'
        ? this.market.quoteAtto(args.amount as string) : this.market.quoteUsd(args.amount as string);
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
    const operation = findOperation(name);
    if (operation?.allowDuringReset) this.requireSession();
    else this.requireReady();
    if (!operation) throw new AttoError('UNKNOWN_OPERATION', 'Unknown Atto operation.');
    const args = parseOperation(operation, input);
    if (operation.requiresWriteApproval) this.requireMcpWrite();
    const call = (async () => {
      const result = await this.invoke(name, args);
      if (this.internalMarketplaceReceiveSafety && name === 'receive' && (result as { status?: unknown } | null)?.status === 'unknown') return result;
      if (operation.skipLabelDecoration) return result;
      if (this.settings().network === 'LIVE' && operation.refreshGlobalDirectory) await this.labels.global.refresh();
      return this.labels.decorate(result, this.settings().network);
    })();
    this.calls.add(call);
    try { return await call; } finally { this.calls.delete(call); }
  }

  /** Private installed Marketplace adapter; absent from the public CLI/MCP operation catalog. */
  async marketplaceRelay(name: string, input: Record<string, unknown>): Promise<unknown> {
    this.requireReady();
    if (!this.internalMarketplaceAuthorizeWrite) throw new AttoError('UNKNOWN_OPERATION', 'Private wallet operation unavailable.');
    const call = name === 'payment_prepare' ? this.payments.prepareRelay(input)
      : name === 'payment_status' ? this.payments.relayStatus(input)
      : name === 'payment_relay_check' ? this.payments.checkDurableRelayAuthorization(input)
      : Promise.reject(new AttoError('UNKNOWN_OPERATION', 'Unknown private wallet operation.'));
    this.calls.add(call);
    try { return await call; } finally { this.calls.delete(call); }
  }

  /** Terminal-only Marketplace controller connection; session tokens remain in memory. */
  async connectMarketplace(input: { apiUrl: string; audience: string; controllerIndex: number; browserOrigins?: string[] }) {
    this.requireReady();
    const connection = await this.store.withWalletLock(() => this.marketplaceConnection.connect(input));
    return { connected: true, apiUrl: connection.apiUrl, audience: connection.audience,
      controllerIndex: connection.controllerIndex, accountId: connection.accountId, identityId: connection.identityId,
      ...(connection.browserOrigins ? { browserOrigins: connection.browserOrigins } : {}) };
  }

  inspectMarketplaceProofApproval(input: unknown) {
    this.requireReady();
    return this.marketplaceConnection.inspectProofApproval(input);
  }

  async approveMarketplaceProof(input: unknown) {
    this.requireReady();
    return this.store.withWalletLock(() => this.marketplaceConnection.signProofApproval(input));
  }

  /** Private Marketplace terminal signing: no standalone connection is read or changed. */
  async approveMarketplaceOwnedProof(input: unknown) {
    this.requireReady();
    if (this.mcp || !process.stdin.isTTY || !process.stderr.isTTY) {
      throw new AttoError('LOCAL_APPROVAL_REQUIRED', 'Approve Marketplace controller actions in the local terminal.');
    }
    return this.store.withWalletLock(async () => {
      const request = validateMarketplaceUserProofApproval(input, { network: 'ATTO', nativeNetwork: 'live' });
      return this.#signMarketplaceOwnedProof(request);
    });
  }

  async approvePreauthorizedMarketplaceLogin(input: unknown, marketplaceHome: string, authorizationFile: string) {
    this.requireReady();
    if (this.mcp) throw new AttoError('LOCAL_APPROVAL_REQUIRED', 'Use the deployment-provisioned Marketplace login command.');
    const snapshot = structuredClone(input);
    return this.store.withWalletLock(async () => {
      const request = validateMarketplaceUserProofApproval(snapshot, { network: 'ATTO', nativeNetwork: this.settings().network.toLowerCase() });
      requireMarketplaceLoginAuthorization(request, this.store.directory, marketplaceHome, authorizationFile);
      return this.#signMarketplaceOwnedProof(request);
    });
  }

  async #signMarketplaceOwnedProof(request: ReturnType<typeof validateMarketplaceUserProofApproval>) {
    if (this.addresses().find(address => address.index === request.controller.index)?.address !== request.controller.address) {
      throw new AttoError('WALLET_MISMATCH', 'The Marketplace controller does not match this selected wallet and index.');
    }
    const seed = await this.seed();
    try {
      const signer = await derivedSigner(seed, request.controller.index);
      if (signer.address.value !== request.controller.address) throw new AttoError('WALLET_MISMATCH', 'The selected controller key changed.');
      validateMarketplaceUserProofApproval(request, { network: 'ATTO', nativeNetwork: 'live' });
      const signature = (await signer.signMessage(new Int8Array(Buffer.from(request.challenge.message, 'utf8')))).toString();
      return createMarketplaceProofApprovalResponse(request, signature);
    } finally { seed.value.fill(0); }
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
