import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { AttoAddress } from '@attocash/commons-core';
import { requireTerminal } from '../cli/terminal.js';
import { AttoError } from '../domain/errors.js';
import { SpendLedger, type LimitsProposal, type McpAccess } from '../spending/ledger.js';
import { inspectWalletProfile, type WalletProfile } from '../storage/profiles.js';
import { StateStore } from '../storage/state.js';
import { assertPrivatePermissionsBatch } from '../storage/private-permissions.js';
import type { AccountPool, NetworkName, SpendingPolicy, WalletAddress, WalletIdentity, WalletSettings } from '../wallet/types.js';

/** Public saved state only. Recovery credentials and payment journals never enter this snapshot. */
export interface MarketplaceWalletSetupSnapshot {
  directory: string;
  profile: WalletProfile;
  address: string;
  index: number;
  fingerprint: string;
  network: `atto:${Lowercase<NetworkName>}`;
  identity: WalletIdentity;
  settings: WalletSettings;
  addresses: WalletAddress[];
  access: McpAccess;
  policy: SpendingPolicy;
  pool: AccountPool;
  messageSigningIndexes: number[];
  authorityRevision: number;
  proposal: LimitsProposal | null;
  formattedLimits: string;
}

export function formatSpendingPolicy(policy: SpendingPolicy): string {
  const perPayment = policy.perRequest ? `${policy.perRequest.amount} ${policy.perRequest.unit}` : 'Unlimited';
  const rolling = policy.rolling.length
    ? policy.rolling.map(rule => `${rule.amount} ${rule.unit} / ${rule.days} day${rule.days === 1 ? '' : 's'}`).join(', ')
    : 'Unlimited';
  return `Per payment: ${perPayment}; rolling: ${rolling}`;
}

function snapshot(store: StateStore, index: number): MarketplaceWalletSetupSnapshot {
  if (store.get('wallet.reset')) throw new AttoError('WALLET_RESET_REQUIRED', 'Finish wallet reset before configuring Marketplace.');
  const identity = store.get<WalletIdentity>('identity');
  const settings = store.get<WalletSettings>('settings');
  if (!identity || typeof identity.address !== 'string' || typeof identity.fingerprint !== 'string' || !settings) {
    throw new AttoError('WALLET_NOT_INITIALIZED', 'Choose an initialized existing CLI wallet or use advanced wallet setup.');
  }
  if (!['LIVE', 'BETA', 'DEV', 'LOCAL'].includes(settings.network)) {
    throw new AttoError('INVALID_STATE', 'The selected wallet network is invalid. Review it in the Atto CLI before setup.');
  }
  const addresses = store.get<WalletAddress[]>('addresses') ?? [];
  if (!Array.isArray(addresses)) throw new AttoError('INVALID_STATE', 'The saved wallet addresses are invalid.');
  const address = addresses.find(value => value?.index === index);
  if (!address) {
    throw new AttoError('MARKETPLACE_ADVANCED_SETUP_REQUIRED', 'This account index has no saved wallet address. Derive it in advanced Atto CLI wallet setup before selecting it for Marketplace.');
  }
  try {
    if (!/^[0-9a-f]{64}$/.test(identity.fingerprint)
      || AttoAddress.parse(identity.address).value !== identity.address
      || AttoAddress.parse(address.address).value !== address.address) throw new Error();
  } catch {
    throw new AttoError('INVALID_STATE', 'The saved wallet identity or account address is invalid. Review it in the Atto CLI before setup.');
  }
  const ledger = new SpendLedger(store);
  const policy = ledger.policy();
  const authorityRevision = store.get<number>('spending.policyRevision') ?? 0;
  if (!Number.isSafeInteger(authorityRevision) || authorityRevision < 0 || authorityRevision === Number.MAX_SAFE_INTEGER) {
    throw new AttoError('INVALID_STATE', 'The saved spending-policy revision is invalid.');
  }
  return {
    directory: store.directory, profile: inspectWalletProfile(store.directory), address: address.address, index,
    fingerprint: identity.fingerprint, network: `atto:${settings.network.toLowerCase() as Lowercase<NetworkName>}`,
    identity, settings, addresses, policy, access: ledger.mcpAccess(), pool: ledger.pool(),
    messageSigningIndexes: ledger.messageSigningIndexes(), authorityRevision, proposal: ledger.proposal(),
    formattedLimits: formatSpendingPolicy(policy),
  };
}

async function withExistingWallet<T>(options: { directory: string; index: number }, action: (store: StateStore) => Promise<T>): Promise<T> {
  requireTerminal();
  if (!options.directory || !isAbsolute(options.directory)) {
    throw new AttoError('INVALID_INPUT', 'Marketplace setup requires an explicit absolute existing wallet directory.');
  }
  if (!Number.isSafeInteger(options.index) || options.index < 0 || options.index > 0x7fff_ffff) {
    throw new AttoError('INVALID_INPUT', 'The Marketplace account index must be a nonnegative integer.');
  }
  const profile = inspectWalletProfile(options.directory);
  if (!existsSync(join(profile.directory, 'state.sqlite'))) {
    throw new AttoError('WALLET_NOT_INITIALIZED', 'Choose an initialized existing CLI wallet or use advanced wallet setup.');
  }
  // Check the existing Windows database before even read-only schema inspection.
  // New wallet state is still opened only after the normal lifecycle lease.
  if (process.platform === 'win32') assertPrivatePermissionsBatch([
    { path: profile.directory, kind: 'directory' },
    ...['', '-journal', '-wal', '-shm'].map(suffix => ({
      path: join(profile.directory, `state.sqlite${suffix}`), kind: 'file' as const, optional: suffix !== '',
    })),
  ]);
  // Compact setup must not implicitly upgrade or repair an older profile.
  const inspection = new DatabaseSync(join(profile.directory, 'state.sqlite'), { readOnly: true });
  try {
    const version = inspection.prepare('PRAGMA user_version').get()?.user_version;
    const table = inspection.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'settings'").get();
    if (version !== 2 || !table) {
      throw new AttoError('STATE_VERSION', 'Open and review this wallet in the current Atto CLI before using compact Marketplace setup.');
    }
  } finally { inspection.close(); }
  // Reuse the normal wallet lifecycle lease and mutation lock. Unlike opening
  // AttoApplication, this never initializes settings, accesses credentials,
  // derives addresses, or reconciles financial records.
  const store = new StateStore(profile.directory);
  try { return await store.withWalletLock(() => action(store)); }
  finally { store.close(); }
}

/** Short saved-state inspection; the wallet lock is released before terminal questions. */
export function inspectMarketplaceWalletSetup(options: { directory: string; index: number }): Promise<MarketplaceWalletSetupSnapshot> {
  return withExistingWallet(options, async store => snapshot(store, options.index));
}

/** Persist Marketplace-owned selections only while the reviewed shared wallet remains unchanged. */
export async function withUnchangedMarketplaceWalletSetup<T>(
  options: { directory: string; index: number; expected: MarketplaceWalletSetupSnapshot; terminalConfirmed: true },
  action: () => Promise<T>,
): Promise<T> {
  requireTerminal();
  if (options.terminalConfirmed !== true) throw new AttoError('LOCAL_APPROVAL_REQUIRED', 'Local terminal approval is required.');
  return withExistingWallet(options, async store => {
    if (!isDeepStrictEqual(options.expected, snapshot(store, options.index))) {
      throw new AttoError('PROPOSAL_STALE', 'The shared wallet settings, identity, or authority changed during setup. Review it and run setup again.');
    }
    return action();
  });
}
