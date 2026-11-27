import { randomUUID } from 'node:crypto';
import { amountRaw } from '../domain/amount.js';
import { AttoError } from '../domain/errors.js';
import type { StateStore } from '../storage/state.js';
import type { AccountPool, SpendingPolicy } from '../wallet/types.js';

export const DAY_MS = 86_400_000;
const POLICY_KEY = 'spending.policy';
const REVISION_KEY = 'spending.policyRevision';
const ACCESS_KEY = 'spending.mcpAccess';
const PROPOSAL_KEY = 'spending.proposal';
const POOL_KEY = 'spending.pool';
const MESSAGE_SIGNING_INDEXES_KEY = 'signing.messageIndexes';

export type McpAccess = 'read-only' | 'spend';

export interface ProposalWallet {
  directory: string;
  walletFingerprint: string | null;
  network: string;
}

export interface LimitsProposal extends ProposalWallet {
  id: string;
  policy: SpendingPolicy;
  access: McpAccess;
  createdAt: number;
  expiresAt: number;
  baseRevision: number;
  status: 'pending' | 'approved' | 'rejected';
  decidedAt?: number;
  pool?: AccountPool;
  messageSigningIndexes?: number[];
}

export function formatSpendingPolicy(policy: SpendingPolicy): string {
  const perPayment = policy.perRequest ? `${policy.perRequest.amount} ${policy.perRequest.unit}` : 'Unlimited';
  const rolling = policy.rolling.length
    ? policy.rolling.map(rule => `${rule.amount} ${rule.unit} / ${rule.days} day${rule.days === 1 ? '' : 's'}`).join(', ')
    : 'Unlimited';
  return `Per payment: ${perPayment}; rolling: ${rolling}`;
}

export function validateSpendingPolicy(policy: SpendingPolicy): void {
  if (!policy || typeof policy !== 'object' || !Array.isArray(policy.rolling) || policy.perRequest === undefined) {
    throw new AttoError('INVALID_POLICY', 'Provide a per-request limit or null and an array of rolling limits.');
  }
  try {
    if (policy.perRequest !== null) {
      if (!['ATTO', 'RAW'].includes(policy.perRequest.unit)) throw new Error();
      amountRaw(policy.perRequest.amount, policy.perRequest.unit, true);
    }
    for (const rule of policy.rolling) {
      if (!rule || !Number.isSafeInteger(rule.days) || rule.days <= 0 || !Number.isSafeInteger(rule.days * DAY_MS)) throw new Error();
      if (!['ATTO', 'RAW'].includes(rule.unit)) throw new Error();
      amountRaw(rule.amount, rule.unit, true);
    }
  } catch {
    throw new AttoError('INVALID_POLICY', 'Limits require valid decimal amounts, explicit ATTO or RAW units, and positive whole days.');
  }
}

function validateAccountPool(pool: AccountPool): void {
  if (!pool || !Array.isArray(pool.indexes) || pool.indexes.length < 1 || pool.indexes.length > 100
    || pool.indexes.some(index => !Number.isSafeInteger(index) || index < 0 || index > 0x7fff_ffff)
    || new Set(pool.indexes).size !== pool.indexes.length || typeof pool.consolidate !== 'boolean') {
    throw new AttoError('INVALID_POOL', 'Choose 1 to 100 distinct wallet indexes and an explicit consolidation setting.');
  }
}

function validateMessageSigningIndexes(indexes: number[]): void {
  if (!Array.isArray(indexes) || indexes.length > 100
    || indexes.some(index => !Number.isSafeInteger(index) || index < 0 || index > 0x7fff_ffff)
    || new Set(indexes).size !== indexes.length) {
    throw new AttoError('INVALID_POLICY', 'Message-signing indexes must be unique account indexes, up to 100.');
  }
}

/** Owns persisted spending policy, MCP access, account pool, message-signing grants, and proposals. */
export class SpendingAuthority {
  constructor(private readonly store: StateStore) {}

  policy(): SpendingPolicy {
    const policy = this.store.get<SpendingPolicy>(POLICY_KEY) ?? { perRequest: null, rolling: [] };
    validateSpendingPolicy(policy);
    return policy;
  }

  setPolicy(policy: SpendingPolicy): void {
    validateSpendingPolicy(policy);
    this.store.transaction(() => this.replacePolicy(policy));
  }

  mcpAccess(): McpAccess {
    const access = this.store.get<McpAccess>(ACCESS_KEY) ?? 'read-only';
    if (access !== 'read-only' && access !== 'spend') throw new AttoError('INVALID_STATE', 'The saved MCP access setting is invalid.');
    return access;
  }

  pool(): AccountPool {
    const pool = this.store.get<AccountPool>(POOL_KEY) ?? { indexes: [0], consolidate: false };
    validateAccountPool(pool);
    return pool;
  }

  messageSigningIndexes(): number[] {
    const indexes = this.store.get<number[]>(MESSAGE_SIGNING_INDEXES_KEY) ?? [];
    validateMessageSigningIndexes(indexes);
    return indexes;
  }

  revision(): number {
    const revision = this.store.get<number>(REVISION_KEY) ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) {
      throw new AttoError('INVALID_STATE', 'The saved spending-policy revision is invalid.');
    }
    return revision;
  }

  proposePolicy(
    policy: SpendingPolicy,
    access: McpAccess,
    wallet: ProposalWallet,
    pool = this.pool(),
    messageSigningIndexes = this.messageSigningIndexes(),
  ): LimitsProposal {
    validateSpendingPolicy(policy);
    validateAccountPool(pool);
    validateMessageSigningIndexes(messageSigningIndexes);
    if (access !== 'read-only' && access !== 'spend') throw new AttoError('INVALID_POLICY', 'Choose read-only or spend access for MCP.');
    const createdAt = Date.now();
    const proposal: LimitsProposal = {
      ...wallet, id: randomUUID(), policy, access, pool, messageSigningIndexes: [...messageSigningIndexes],
      createdAt, expiresAt: createdAt + DAY_MS, baseRevision: this.revision(), status: 'pending',
    };
    // One immutable proposal is current per profile. A new request gets a new
    // ID, so an approval already displayed in another terminal cannot change it.
    this.store.set(PROPOSAL_KEY, proposal);
    return proposal;
  }

  proposal(): LimitsProposal | null {
    const proposal = this.store.get<LimitsProposal>(PROPOSAL_KEY);
    if (proposal === undefined) return null;
    try {
      if (!proposal || typeof proposal.id !== 'string' || !proposal.id || proposal.id.length > 128
        || !['pending', 'approved', 'rejected'].includes(proposal.status)
        || !['read-only', 'spend'].includes(proposal.access)
        || !Number.isSafeInteger(proposal.createdAt) || proposal.createdAt < 0
        || !Number.isSafeInteger(proposal.expiresAt) || proposal.expiresAt <= proposal.createdAt
        || !Number.isSafeInteger(proposal.baseRevision) || proposal.baseRevision < 0
        || typeof proposal.directory !== 'string' || typeof proposal.network !== 'string'
        || (proposal.walletFingerprint !== null && typeof proposal.walletFingerprint !== 'string')) throw new Error();
      validateSpendingPolicy(proposal.policy);
      if (proposal.pool !== undefined) validateAccountPool(proposal.pool);
      const messageSigningIndexes = proposal.messageSigningIndexes ?? [];
      validateMessageSigningIndexes(messageSigningIndexes);
      return { ...proposal, messageSigningIndexes };
    } catch {
      throw new AttoError('INVALID_STATE', 'The saved limit proposal is invalid.');
    }
  }

  reviewProposal(id: string, wallet: ProposalWallet): LimitsProposal {
    const proposal = this.proposal();
    if (!proposal || proposal.id !== id) throw new AttoError('PROPOSAL_NOT_FOUND', 'This proposal is unavailable or was replaced. Request the current limits before trying again.');
    if (proposal.directory !== wallet.directory || proposal.walletFingerprint !== wallet.walletFingerprint || proposal.network !== wallet.network) {
      throw new AttoError('PROPOSAL_STALE', 'The proposal belongs to a different wallet, profile, or network. Request a new proposal.');
    }
    if (proposal.status === 'pending') {
      if (Date.now() >= proposal.expiresAt) throw new AttoError('PROPOSAL_EXPIRED', 'This proposal expired. Request a new proposal.');
      if (proposal.baseRevision !== this.revision()) throw new AttoError('PROPOSAL_STALE', 'The policy changed after this proposal was created. Request a new proposal.');
    }
    return proposal;
  }

  approveProposal(id: string, wallet: ProposalWallet): void {
    this.store.transaction(() => {
      const proposal = this.reviewProposal(id, wallet);
      if (proposal.status === 'approved') return;
      if (proposal.status === 'rejected') throw new AttoError('PROPOSAL_REJECTED', 'This proposal was rejected. Request a new proposal.');
      this.replacePolicy(proposal.policy);
      this.store.set(ACCESS_KEY, proposal.access);
      if (proposal.pool !== undefined) this.store.set(POOL_KEY, proposal.pool);
      this.store.set(MESSAGE_SIGNING_INDEXES_KEY, proposal.messageSigningIndexes ?? []);
      this.store.set(PROPOSAL_KEY, { ...proposal, status: 'approved', decidedAt: Date.now() });
    });
  }

  rejectProposal(id: string, wallet: ProposalWallet): void {
    this.store.transaction(() => {
      const proposal = this.reviewProposal(id, wallet);
      if (proposal.status === 'approved') throw new AttoError('PROPOSAL_APPROVED', 'This proposal was already approved. Propose a new policy to change it.');
      if (proposal.status === 'rejected') return;
      this.store.set(PROPOSAL_KEY, { ...proposal, status: 'rejected', decidedAt: Date.now() });
    });
  }

  private replacePolicy(policy: SpendingPolicy): void {
    const revision = this.revision();
    this.store.set(POLICY_KEY, policy);
    this.store.set(REVISION_KEY, revision + 1);
  }
}
