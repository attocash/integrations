import { createHash } from 'node:crypto';
import { AttoMnemonic, type AttoSeed } from '@attocash/commons-core';
import { parseAddress } from '../domain/address.js';
import { amountRaw } from '../domain/amount.js';
import { AttoError } from '../domain/errors.js';
import type { SpendLedger } from '../spending/ledger.js';
import type { SecretStore } from '../storage/secrets.js';
import type { StateStore } from '../storage/state.js';
import { defaultSettings } from './defaults.js';
import { derivedSigner, mnemonicSeed } from './signing.js';
import type { WalletAddress, WalletIdentity, WalletSettings } from './types.js';

const WALLET_RESET_KEY = 'wallet.reset';

export interface WalletLifecycleHooks {
  requireSession(): void;
  requireReady(): void;
  requireMcpWrite(): void;
  requireResetAvailable(): void;
  beforeReset(): Promise<void>;
  onNetworkChanged(): Promise<void>;
  /** Routed through AttoApplication.seed() so internal tests that override app.seed observe derivations. */
  loadSeed(): Promise<AttoSeed>;
}

/** Owns persisted wallet identity, settings, address derivation, backup reads, and reset. */
export class WalletLifecycle {
  private recoveryReads = 0;

  constructor(
    private readonly store: StateStore,
    private readonly secrets: SecretStore,
    private readonly ledger: SpendLedger,
    private readonly hooks: WalletLifecycleHooks,
  ) {}

  get readingRecovery(): boolean { return this.recoveryReads !== 0; }
  isResetPending(): boolean { return Boolean(this.store.get(WALLET_RESET_KEY)); }
  settings(): WalletSettings { return this.store.get<WalletSettings>('settings')!; }
  addresses(): WalletAddress[] { return this.store.get<WalletAddress[]>('addresses') ?? []; }
  identity(): WalletIdentity | undefined { return this.store.get<WalletIdentity>('identity'); }

  requireResetFinished(): void {
    if (this.isResetPending()) {
      throw new AttoError('WALLET_RESET_REQUIRED', 'Wallet reset was interrupted. Run atto wallet reset again to finish cleanup.');
    }
  }

  address(index = 0, requireActive = false): WalletAddress {
    const address = this.addresses().find(value => value.index === index);
    if (!address) throw new AttoError('ADDRESS_NOT_DERIVED', 'Derive or activate the key index first.');
    if (requireActive && !address.active) throw new AttoError('ADDRESS_INACTIVE', 'Activate this address before automatic receiving.');
    return address;
  }

  selectedAddresses(input: { index?: number; addresses?: string[]; all?: boolean }): string[] {
    const selected = input.addresses ?? (input.index !== undefined ? [this.address(input.index).address]
      : this.addresses().filter(address => input.all || address.active).map(address => address.address));
    return [...new Set(selected.map(address => parseAddress(address).value))];
  }

  async createWallet(mnemonic?: string): Promise<{ identity: WalletIdentity; addresses: WalletAddress[] }> {
    this.hooks.requireReady();
    return this.store.withWalletLock(async () => {
      this.hooks.requireReady();
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
    this.hooks.requireSession();
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

  async loadSeed(): Promise<AttoSeed> {
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

  /** The caller owns the wallet lock, including terminal pool approval. */
  async deriveAddress(index: number, active?: boolean): Promise<WalletAddress> {
    const addresses = this.addresses();
    let address = addresses.find(value => value.index === index);
    if (active === true && !address?.active && addresses.filter(value => value.active).length >= 100) {
      throw new AttoError('ACTIVE_ADDRESS_LIMIT', 'At most 100 addresses can be active. Deactivate an address before activating another.');
    }
    if (!address) {
      const seed = await this.hooks.loadSeed();
      try {
        const signer = await derivedSigner(seed, index);
        address = { index, address: signer.address.value, publicKey: signer.publicKey.toString(), active: active ?? false };
        addresses.push(address);
      } finally { seed.value.fill(0); }
    }
    if (active !== undefined) address.active = active;
    this.store.set('addresses', addresses.sort((left, right) => left.index - right.index));
    return address;
  }

  async derive(index: number, active?: boolean): Promise<WalletAddress> {
    return this.store.withWalletLock(async () => {
      this.hooks.requireMcpWrite();
      return this.deriveAddress(index, active);
    });
  }

  async addAddress(): Promise<WalletAddress> {
    return this.store.withWalletLock(async () => {
      this.hooks.requireMcpWrite();
      const next = this.addresses().reduce((highest, address) => Math.max(highest, address.index), -1) + 1;
      if (next > 2_147_483_647) throw new AttoError('INDEX_LIMIT', 'The wallet has reached its last account index.');
      return this.deriveAddress(next, true);
    });
  }

  async deactivateAddress(index: number): Promise<WalletAddress> {
    return this.store.withWalletLock(async () => {
      this.hooks.requireMcpWrite();
      this.address(index);
      this.store.set('addresses', this.addresses().map(address => address.index === index ? { ...address, active: false } : address));
      return this.address(index);
    });
  }

  async configure(input: Partial<WalletSettings>): Promise<WalletSettings> {
    return this.store.withWalletLock(async () => {
      this.hooks.requireMcpWrite();
      const settings = { ...this.settings(), ...input };
      settings.representative = parseAddress(settings.representative).value;
      settings.minReceiveRaw = amountRaw(settings.minReceiveRaw, 'RAW');
      const changesNetwork = settings.nodeUrl !== this.settings().nodeUrl || settings.network !== this.settings().network;
      if (this.ledger.pending().length && changesNetwork) {
        throw new AttoError('PUBLICATION_UNCERTAIN', 'Resolve pending sends before changing the node or network.');
      }
      const release = changesNetwork ? this.store.tryAllAccountLocks(this.addresses().map(address => address.index)) : undefined;
      if (changesNetwork && !release) {
        throw new AttoError('WALLET_BUSY', 'Wait for account operations before changing the node or network.');
      }
      try {
        this.store.set('settings', settings);
      } finally { release?.(); }
      await this.hooks.onNetworkChanged();
      return settings;
    });
  }

  async reviewReset(): Promise<{ directory: string; identity: WalletIdentity | null; network: WalletSettings['network'] }> {
    this.hooks.requireResetAvailable();
    return this.store.withWalletLock(async () => {
      this.requireNoPendingPayments();
      return { directory: this.store.directory, identity: this.identity() ?? null, network: this.settings().network };
    });
  }

  async resetWallet(expectedFingerprint: string | null): Promise<{ reset: true }> {
    await this.hooks.beforeReset();
    await this.store.withExclusiveReset(() => this.store.withWalletLock(async () => {
      if ((this.identity()?.fingerprint ?? null) !== expectedFingerprint) {
        throw new AttoError('WALLET_CHANGED', 'The wallet changed after confirmation. Review it before resetting again.');
      }
      this.requireNoPendingPayments();
      const release = this.store.tryAllAccountLocks(this.addresses().map(address => address.index));
      if (!release) throw new AttoError('WALLET_BUSY', 'Wait for account operations before resetting this wallet.');
      try {
        // Keyring and SQLite cannot share a transaction. Preserve the old
        // public state behind a durable marker until credential deletion is
        // verified, so interruption always resumes through this same path.
        if (!this.isResetPending()) this.store.transaction(() => this.store.set(WALLET_RESET_KEY, { startedAt: new Date().toISOString() }));
        if (await this.secrets.get() !== null) await this.secrets.remove!();
        if (await this.secrets.get() !== null) throw new AttoError('SECRET_STORE_UNAVAILABLE', 'The password store did not remove the wallet credential. Unlock it and run wallet reset again.');
        this.store.transaction(() => {
          this.store.clearForReset();
          this.store.set('settings', defaultSettings());
        });
      } finally { release(); }
    }));
    return { reset: true };
  }

  private requireNoPendingPayments(): void {
    if (this.ledger.pending().length) {
      throw new AttoError('PUBLICATION_UNCERTAIN', 'Resolve unfinished payments before resetting this wallet. Check the journal and resume their original request IDs.');
    }
  }
}
