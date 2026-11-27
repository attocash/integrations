import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { AttoAddress } from '@attocash/commons-core';
import { requireTerminal } from '../cli/terminal.js';
import { AttoApplication } from '../application/app.js';
import { amountRaw } from '../domain/amount.js';
import { AttoError } from '../domain/errors.js';
import { formatRecipientAllowlist } from '../spending/destination.js';
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
  recipientAllowlist: string[] | null;
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
    messageSigningIndexes: ledger.messageSigningIndexes(), recipientAllowlist: ledger.recipientAllowlist(), authorityRevision, proposal: ledger.proposal(),
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

export function marketplacePaymentsUsable(value: MarketplaceWalletSetupSnapshot): boolean {
  return value.access === 'spend' && value.pool.indexes.includes(value.index);
}

export type MarketplacePaymentMode = 'login-only' | 'limited' | 'unlimited';

export interface MarketplacePaymentIntent {
  policy?: SpendingPolicy;
  resumeProposalId?: string;
  requiresPolicy: boolean;
}

export interface MarketplacePaymentPlan {
  review: string;
  validate(): Promise<void>;
  commit(): Promise<MarketplaceWalletSetupSnapshot>;
}

export function marketplaceSpendingPolicyBounded(policy: SpendingPolicy): boolean {
  return policy.perRequest !== null || policy.rolling.length > 0;
}

/** Keep terminal cap correction on the native owner's positive ATTO amount semantics. */
export function validateMarketplacePaymentCap(value: string): void { amountRaw(value); }

/** Pick existing intent before a caller asks for caps. This does not approve or replace a proposal. */
export function inspectMarketplacePaymentIntent(before: MarketplaceWalletSetupSnapshot, mode: MarketplacePaymentMode): MarketplacePaymentIntent {
  validatePaymentMode(mode);
  if (mode === 'login-only') return { policy: structuredClone(before.policy), requiresPolicy: false };
  if (before.access === 'spend' && before.pool.indexes.includes(before.index)
    && marketplaceSpendingPolicyBounded(before.policy) === (mode === 'limited')) {
    return { policy: structuredClone(before.policy), requiresPolicy: false };
  }
  const pending = before.proposal;
  if (pending?.status === 'pending' && proposalMatchesPaymentMode(before, pending, mode)) {
    return { policy: structuredClone(pending.policy), resumeProposalId: pending.id, requiresPolicy: false };
  }
  if (mode === 'unlimited') return { policy: { perRequest: null, rolling: [] }, requiresPolicy: false };
  return marketplaceSpendingPolicyBounded(before.policy)
    ? { policy: structuredClone(before.policy), requiresPolicy: false }
    : { requiresPolicy: true };
}

/** Native authority stays unchanged until the caller commits its final, locally approved review. */
export async function prepareMarketplacePayments(options: {
  expected: MarketplaceWalletSetupSnapshot;
  mode: MarketplacePaymentMode;
  policy?: SpendingPolicy;
  resumeProposalId?: string;
  previousProposal?: { id: string; expiresAt: number };
}): Promise<MarketplacePaymentPlan> {
  validatePaymentMode(options.mode);
  if (options.resumeProposalId !== undefined && (typeof options.resumeProposalId !== 'string' || !options.resumeProposalId)) {
    throw new AttoError('INVALID_INPUT', 'A pending native proposal requires its exact nonempty proposal ID.');
  }
  if (options.previousProposal !== undefined && (!options.previousProposal || typeof options.previousProposal.id !== 'string'
    || !options.previousProposal.id || !Number.isSafeInteger(options.previousProposal.expiresAt) || options.previousProposal.expiresAt < 0)) {
    throw new AttoError('INVALID_INPUT', 'The previous pending native proposal reference is invalid.');
  }
  const before = structuredClone(options.expected), mode = options.mode;
  const previousChanged = Boolean(options.previousProposal && (before.proposal?.status !== 'pending'
    || before.proposal.id !== options.previousProposal.id || before.proposal.expiresAt !== options.previousProposal.expiresAt
    || Date.now() >= options.previousProposal.expiresAt));
  const intent = inspectMarketplacePaymentIntent(before, mode);
  if (mode === 'login-only' && (options.policy !== undefined || options.resumeProposalId !== undefined)) {
    throw new AttoError('INVALID_POLICY', 'Login-only setup does not change native payment settings.');
  }
  const policy = structuredClone(options.policy !== undefined ? options.policy : intent.policy);
  if (!policy) throw new AttoError('INVALID_POLICY', 'Limited spending requires a bounded policy.');
  validateRequestedPolicy(policy);
  if (mode === 'limited' && !marketplaceSpendingPolicyBounded(policy)) {
    throw new AttoError('INVALID_POLICY', 'Limited spending requires a bounded policy.');
  }
  if (mode === 'unlimited' && marketplaceSpendingPolicyBounded(policy)) {
    throw new AttoError('INVALID_POLICY', 'Unlimited spending requires an explicitly unbounded policy.');
  }
  const resumeId = options.resumeProposalId ?? (isDeepStrictEqual(policy, intent.policy) ? intent.resumeProposalId : undefined);
  const resume = resumeId ? before.proposal : null;
  if (resumeId && (!resume || resume.id !== resumeId || !proposalMatchesPaymentMode(before, resume, mode)
    || !isDeepStrictEqual(policy, resume.policy))) {
    throw new AttoError('PROPOSAL_STALE', 'The pending native settings do not match the selected spending mode and exact policy. Review setup again.');
  }
  const requested = mode === 'login-only' ? {
    policy: before.policy, access: before.access, pool: before.pool, messageSigningIndexes: before.messageSigningIndexes,
  } : resume ? {
    policy, access: resume.access, pool: resume.pool ?? before.pool, messageSigningIndexes: resume.messageSigningIndexes ?? [],
  } : {
    policy, access: 'spend' as const,
    pool: before.pool.indexes.includes(before.index) ? before.pool
      : { ...before.pool, indexes: [...before.pool.indexes, before.index].sort((a, b) => a - b) },
    messageSigningIndexes: before.messageSigningIndexes,
  };
  if(requested.pool.indexes.length>100)throw new AttoError('INVALID_POOL','The native payment pool already has 100 accounts. Review its pool in advanced wallet setup before adding this selected account.');
  const changesAuthority = !isDeepStrictEqual(requested, {
    policy: before.policy, access: before.access, pool: before.pool, messageSigningIndexes: before.messageSigningIndexes,
  });
  if (requested.pool.indexes.length > 100) throw new AttoError('INVALID_POOL', 'The shared native payment pool already contains the maximum of 100 accounts. Review its pool in the Atto CLI before adding this account.');
  const check = (store: StateStore): void => {
    assertSnapshot(store, before);
    if (resume) new SpendLedger(store).reviewProposal(resume.id, proposalWallet(before));
  };
  // Inspection uses only the existing public state owner, never application startup or credentials.
  await withExistingWallet(before, async store => { check(store); });
  let committed: MarketplaceWalletSetupSnapshot | undefined;
  return {
    review: marketplacePaymentReview(before, requested, mode, resume, changesAuthority, previousChanged),
    async validate() {
      await withExistingWallet(before, async store => {
        if (committed) assertSnapshot(store, committed);
        else check(store);
      });
    },
    async commit() {
      if (committed) return withExistingWallet(before, async store => {
        assertSnapshot(store, committed!);
        return structuredClone(committed!);
      });
      // Login-only and already-effective authority preserve any unrelated pending proposal.
      if (!resume && !changesAuthority) return withExistingWallet(before, async store => { check(store); return snapshot(store, before.index); });
      await withExistingWallet(before, async store => { check(store); });
      const application = new AttoApplication({ directory: before.directory });
      try {
        let approvalSnapshot = before;
        const proposal = resume ?? await application.store.withWalletLock(async () => {
          check(application.store);
          const proposed = application.ledger.proposePolicy(policy, 'spend', proposalWallet(before), requested.pool, requested.messageSigningIndexes);
          approvalSnapshot = snapshot(application.store, before.index);
          return proposed;
        });
        await application.reviewLimitsProposal(proposal.id);
        await application.approveLimitsProposal(proposal.id, () => assertSnapshot(application.store, approvalSnapshot), () => {
          committed = snapshot(application.store, before.index);
        });
        return structuredClone(committed!);
      } finally { await application.close(); }
    },
  };
}

function validatePaymentMode(mode: MarketplacePaymentMode): void {
  if (!['login-only', 'limited', 'unlimited'].includes(mode)) throw new AttoError('INVALID_INPUT', 'Choose login-only, limited, or unlimited spending.');
}

function validateRequestedPolicy(policy: SpendingPolicy): void {
  if (!policy || typeof policy !== 'object' || policy.perRequest === undefined || !Array.isArray(policy.rolling)) {
    throw new AttoError('INVALID_POLICY', 'Provide a per-request limit or null and an array of rolling limits.');
  }
  try {
    if (policy.perRequest !== null) {
      if (!['ATTO', 'RAW'].includes(policy.perRequest.unit)) throw new Error();
      amountRaw(policy.perRequest.amount, policy.perRequest.unit, true);
    }
    for (const rule of policy.rolling) {
      if (!rule || !Number.isSafeInteger(rule.days) || rule.days <= 0 || !Number.isSafeInteger(rule.days * 86_400_000)) throw new Error();
      if (!['ATTO', 'RAW'].includes(rule.unit)) throw new Error();
      amountRaw(rule.amount, rule.unit, true);
    }
  } catch { throw new AttoError('INVALID_POLICY', 'Limits require valid decimal amounts, explicit ATTO or RAW units, and positive whole days.'); }
}

function proposalWallet(before: MarketplaceWalletSetupSnapshot) {
  return { directory: before.directory, walletFingerprint: before.fingerprint, network: before.settings.network };
}

function proposalMatchesPaymentMode(before: MarketplaceWalletSetupSnapshot, proposal: LimitsProposal, mode: MarketplacePaymentMode): boolean {
  return proposal.status === 'pending' && proposal.access === 'spend'
    && proposal.directory === before.directory && proposal.walletFingerprint === before.fingerprint && proposal.network === before.settings.network
    && proposal.baseRevision === before.authorityRevision && Date.now() < proposal.expiresAt
    && (mode === 'limited' ? marketplaceSpendingPolicyBounded(proposal.policy) : mode === 'unlimited' && !marketplaceSpendingPolicyBounded(proposal.policy))
    && (proposal.pool ?? before.pool).indexes.includes(before.index)
    && isDeepStrictEqual(proposal.messageSigningIndexes ?? [], before.messageSigningIndexes)
    && (proposal.recipientAllowlist === undefined || isDeepStrictEqual(proposal.recipientAllowlist, before.recipientAllowlist));
}

function marketplacePaymentReview(before: MarketplaceWalletSetupSnapshot, requested: {
  policy: SpendingPolicy; access: McpAccess; pool: AccountPool; messageSigningIndexes: number[];
}, mode: MarketplacePaymentMode, resume: LimitsProposal | null, changesAuthority: boolean, previousChanged: boolean): string {
  const enablesSpend = before.access === 'read-only' && requested.access === 'spend';
  const pending = before.proposal?.status === 'pending' ? before.proposal : null;
  return `Atto wallet: ${before.address}\nAccount index: ${before.index} | Network: ${before.network}\n`
    + (previousChanged ? 'Previous pending native settings changed or expired; the current terms require fresh approval.\n' : '')
    + (mode === 'login-only' ? `Login only: native payment settings stay unchanged.\nCurrent limits: ${before.formattedLimits}\n`
      : `Native payment access: ${before.access} → ${requested.access}\nCurrent limits: ${before.formattedLimits}\nRequested limits: ${formatSpendingPolicy(requested.policy)}\n`)
    + (before.recipientAllowlist !== null ? `Approved ATTO recipients: ${formatRecipientAllowlist(before.recipientAllowlist)}\n` : '')
    + (mode === 'unlimited' ? 'Unlimited spending permits the available balance, including future deposits, to be spent.\n' : '')
    + (enablesSpend ? `Native payments become enabled for pool indexes ${requested.pool.indexes.join(', ')}; consolidation ${requested.pool.consolidate ? 'enabled' : 'disabled'}.\n`
      : !isDeepStrictEqual(before.policy,requested.policy) ? `Shared native spending limits apply to pool indexes ${requested.pool.indexes.join(', ')}; consolidation ${requested.pool.consolidate ? 'enabled' : 'disabled'}.\n` : '')
    + (enablesSpend && requested.messageSigningIndexes.length ? `Previously approved native generic message signing becomes available for account indexes ${requested.messageSigningIndexes.join(', ')}.\n` : '')
    + (!isDeepStrictEqual(before.pool, requested.pool) ? `Payment pool: indexes ${before.pool.indexes.join(', ')} → ${requested.pool.indexes.join(', ')}; consolidation ${before.pool.consolidate ? 'enabled' : 'disabled'} → ${requested.pool.consolidate ? 'enabled' : 'disabled'}\n` : '')
    + (resume ? `${previousChanged ? 'Approve the current pending native settings' : 'Resume the exact existing pending native settings'}, expiring ${new Date(resume.expiresAt).toISOString()}.\n` : '')
    + (pending && !resume && changesAuthority ? `This replaces the existing pending native settings only after approval.\n`
      + `Pending native settings to replace: access ${pending.access}; ${formatSpendingPolicy(pending.policy)}; payment pool indexes ${(pending.pool ?? before.pool).indexes.join(', ')}; consolidation ${(pending.pool ?? before.pool).consolidate ? 'enabled' : 'disabled'}; expires ${new Date(pending.expiresAt).toISOString()}.\n`
      + (pending.recipientAllowlist !== undefined && !isDeepStrictEqual(pending.recipientAllowlist, before.recipientAllowlist)
        ? `Pending ATTO recipients to replace: ${formatRecipientAllowlist(pending.recipientAllowlist)}\n` : '')
      + ((pending.messageSigningIndexes ?? []).length ? `Pending generic message signing indexes to replace: ${pending.messageSigningIndexes!.join(', ')}.\n` : '') : '')
    + (previousChanged && pending && !resume && !changesAuthority ? `Current pending native settings remain unchanged: access ${pending.access}; ${formatSpendingPolicy(pending.policy)}; payment pool indexes ${(pending.pool ?? before.pool).indexes.join(', ')}; consolidation ${(pending.pool ?? before.pool).consolidate ? 'enabled' : 'disabled'}; expires ${new Date(pending.expiresAt).toISOString()}.\n`
      + (pending.recipientAllowlist !== undefined && !isDeepStrictEqual(pending.recipientAllowlist, before.recipientAllowlist)
        ? `Current pending ATTO recipients: ${formatRecipientAllowlist(pending.recipientAllowlist)}\n` : '')
      + ((pending.messageSigningIndexes ?? []).length ? `Current pending generic message signing indexes: ${pending.messageSigningIndexes!.join(', ')}.\n` : '') : '')
    + (mode !== 'login-only' ? 'These limits and payment history are shared with CLI payments.\n' : '');
}

function assertSnapshot(store: StateStore, before: MarketplaceWalletSetupSnapshot): void {
  if (!isDeepStrictEqual(before, snapshot(store, before.index))) throw new AttoError('PROPOSAL_STALE', 'The shared wallet settings, identity, authority or pending proposal changed during review. Run setup again.');
}
