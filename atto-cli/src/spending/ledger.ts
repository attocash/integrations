import { validateDestinationBinding, type DestinationBinding } from './destination.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { amountRaw } from '../domain/amount.js';
import { AttoError } from '../domain/errors.js';
import type { StateStore } from '../storage/state.js';
import type { AccountPool, SpendingPolicy, SpendingRule } from '../wallet/types.js';
import { paymentMetadataSchema, validatePaymentPlan, type ConsolidationStep, type PaymentMetadata, type PaymentPlan } from './journal.js';

export type { ConsolidationStep, PaymentMetadata, PaymentPlan } from './journal.js';

export interface SendRecord {
  id: string;
  index: number;
  destination: string;
  destinationBinding?: DestinationBinding;
  raw: string;
  createdAt: number;
  status: 'reserved' | 'signed' | 'published' | 'unknown' | 'failed';
  hash?: string;
  blockJson?: string;
  result?: unknown;
  publishedAt?: number;
  sourceAddress?: string;
  network?: string;
  metadata?: PaymentMetadata;
  quote?: unknown;
  selection?: 'automatic' | 'explicit';
  plan?: PaymentPlan;
}

export type SendReservation = Pick<SendRecord, 'id' | 'index' | 'destination' | 'raw' | 'createdAt'>
  & Partial<Pick<SendRecord, 'sourceAddress' | 'network' | 'metadata' | 'quote' | 'selection' | 'plan' | 'destinationBinding'>>;

const DAY_MS = 86_400_000;
const POLICY_KEY = 'spending.policy';
const RECORDS_KEY = 'spending.records';
const REVISION_KEY = 'spending.policyRevision';
const ACCESS_KEY = 'spending.mcpAccess';
const PROPOSAL_KEY = 'spending.proposal';
const POOL_KEY = 'spending.pool';

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
}

export class SpendLedger {
  constructor(private readonly store: StateStore) {}

  policy(): SpendingPolicy {
    const policy = this.store.get<SpendingPolicy>(POLICY_KEY) ?? { perRequest: null, rolling: [] };
    this.validatePolicy(policy);
    return policy;
  }

  setPolicy(policy: SpendingPolicy): void {
    this.validatePolicy(policy);
    this.store.transaction(() => this.replacePolicy(policy));
  }

  mcpAccess(): McpAccess {
    const access = this.store.get<McpAccess>(ACCESS_KEY) ?? 'read-only';
    if (access !== 'read-only' && access !== 'spend') throw new AttoError('INVALID_STATE', 'The saved MCP access setting is invalid.');
    return access;
  }

  pool(): AccountPool {
    const pool = this.store.get<AccountPool>(POOL_KEY) ?? { indexes: [0], consolidate: false };
    this.validatePool(pool);
    return pool;
  }

  proposePolicy(policy: SpendingPolicy, access: McpAccess, wallet: ProposalWallet, pool = this.pool()): LimitsProposal {
    this.validatePolicy(policy);
    this.validatePool(pool);
    if (access !== 'read-only' && access !== 'spend') throw new AttoError('INVALID_POLICY', 'Choose read-only or spend access for MCP.');
    const createdAt = Date.now();
    const proposal: LimitsProposal = {
      ...wallet, id: randomUUID(), policy, access, pool, createdAt, expiresAt: createdAt + DAY_MS,
      baseRevision: this.revision(), status: 'pending',
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
      this.validatePolicy(proposal.policy);
      if (proposal.pool !== undefined) this.validatePool(proposal.pool);
      return proposal;
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

  private revision(): number {
    const revision = this.store.get<number>(REVISION_KEY) ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) throw new AttoError('INVALID_STATE', 'The saved spending-policy revision is invalid.');
    return revision;
  }

  private replacePolicy(policy: SpendingPolicy): void {
    const revision = this.revision();
    this.store.set(POLICY_KEY, policy);
    this.store.set(REVISION_KEY, revision + 1);
  }

  assertCanReserve(raw: string, now = Date.now()): void {
    this.assertAllowance(amountRaw(raw, 'RAW'), now, this.records());
  }

  /** Recheck the current policy before signing without charging this reservation twice. */
  assertReservationAllowed(id: string, now = Date.now()): void {
    const records = this.records();
    const record = records.find(value => value.id === id);
    if (!record) throw new AttoError('SEND_NOT_FOUND', 'The payment request was not found.');
    if (!['reserved', 'signed', 'unknown'].includes(record.status)) {
      throw new AttoError('SEND_STATE', 'Only a pending payment can use its spending reservation.');
    }
    this.assertAllowance(record.raw, now, records.filter(value => value.id !== id));
  }

  private assertAllowance(raw: string, now: number, records: SendRecord[]): void {
    if (!Number.isSafeInteger(now) || now < 0) throw new AttoError('INVALID_REQUEST', 'Spending checks require a valid timestamp.');
    const policy = this.policy();
    if (policy.perRequest && BigInt(raw) > BigInt(amountRaw(policy.perRequest.amount, policy.perRequest.unit, true))) {
      throw new AttoError('SPENDING_LIMIT', 'The payment exceeds the per-request spending limit.');
    }
    for (const rule of policy.rolling) {
      const usage = this.ruleUsage(rule, records, now);
      if (BigInt(usage.usedRaw) + BigInt(raw) > BigInt(usage.limitRaw)) {
        throw new AttoError('SPENDING_LIMIT', `The payment exceeds the ${rule.days}-day rolling spending limit.`, usage);
      }
    }
  }

  reserve(request: SendReservation): SendRecord {
    if (typeof request.id !== 'string' || request.id.length === 0 || request.id.length > 200
      || !Number.isSafeInteger(request.index) || request.index < 0 || request.index > 0x7fff_ffff
      || typeof request.destination !== 'string' || !request.destination
      || !Number.isSafeInteger(request.createdAt) || request.createdAt < 0) {
      throw new AttoError('INVALID_REQUEST', 'Send requests require an ID, address index, destination, and timestamp.');
    }
    const raw = amountRaw(request.raw, 'RAW');
    try {
      this.validateDetails(request);
      if (request.plan?.steps.some(step => step.status !== 'planned' || step.hash !== undefined)) throw new Error();
    } catch {
      throw new AttoError('INVALID_REQUEST', 'The payment metadata, source, or consolidation plan is invalid.');
    }
    return this.store.transaction(() => {
      const records = this.records();
      const existing = records.find((record) => record.id === request.id);
      if (existing) {
        if (existing.index !== request.index || existing.destination !== request.destination || existing.raw !== raw
          || ['sourceAddress', 'network', 'metadata', 'quote', 'selection'].some(key => {
            const field = key as 'sourceAddress' | 'network' | 'metadata' | 'quote' | 'selection';
            return request[field] !== undefined && !isDeepStrictEqual(request[field], existing[field]);
          }) || (request.plan !== undefined && !isDeepStrictEqual(this.planDefinition(request.plan), this.planDefinition(existing.plan)))) {
          throw new AttoError('REQUEST_CONFLICT', 'This request ID already belongs to a different payment.');
        }
        return existing;
      }
      this.assertAllowance(raw, request.createdAt, records);
      const record: SendRecord = { ...request, raw, status: 'reserved' };
      records.push(record);
      this.store.set(RECORDS_KEY, records);
      return record;
    });
  }

  get(id: string): SendRecord | undefined { return this.records().find((record) => record.id === id); }

  journalGet(requestId: string): SendRecord | undefined { return this.get(requestId); }

  journalList(options: { limit?: number; cursor?: string; status?: SendRecord['status'] } = {}): { items: SendRecord[]; nextCursor?: string } {
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || (options.status !== undefined && !['reserved', 'signed', 'published', 'unknown', 'failed'].includes(options.status))) {
      throw new AttoError('INVALID_INPUT', 'Journal pages require a limit from 1 to 100 and a valid payment status.');
    }
    const records = this.records();
    let before = records.length;
    if (options.cursor !== undefined) {
      try {
        if (typeof options.cursor !== 'string' || options.cursor.length > 2048) throw new Error();
        const cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')) as { version?: unknown; before?: unknown; status?: unknown };
        if (cursor.version !== 1 || typeof cursor.before !== 'string' || cursor.status !== (options.status ?? null)) throw new Error();
        before = records.findIndex(record => record.id === cursor.before);
        if (before < 0) throw new Error();
      } catch { throw new AttoError('INVALID_CURSOR', 'Use a journal cursor with the same status filter.'); }
    }
    const matching = records.slice(0, before).reverse().filter(record => options.status === undefined || record.status === options.status);
    const items = matching.slice(0, limit);
    return { items, ...(matching.length > limit ? {
      nextCursor: Buffer.from(JSON.stringify({ version: 1, before: items.at(-1)!.id, status: options.status ?? null })).toString('base64url'),
    } : {}) };
  }

  signed(id: string, hash: string, blockJson: string): void {
    this.update(id, (record) => {
      if (record.status === 'published' || record.status === 'failed' || (record.hash && record.hash !== hash)) {
        throw new AttoError('SEND_STATE', 'This payment cannot be assigned a new block.');
      }
      if (!hash || !blockJson) throw new AttoError('SEND_STATE', 'A signed payment requires its block hash and block.');
      if (record.plan?.steps.some(step => step.status !== 'published')) throw new AttoError('SEND_STATE', 'Complete every consolidation step before signing the external payment.');
      return { ...record, hash, blockJson, status: 'signed' };
    });
  }

  complete(id: string, result: unknown, publishedAt: number): void {
    this.update(id, (record) => {
      if (record.status === 'published') return record;
      if (!record.hash || record.status === 'failed' || !Number.isSafeInteger(publishedAt) || publishedAt < 0) {
        throw new AttoError('SEND_STATE', 'Only a recorded block can complete a payment.');
      }
      return { ...record, status: 'published', result, publishedAt };
    });
  }

  uncertain(id: string): void {
    this.update(id, (record) => record.status === 'published' || record.status === 'failed' ? record : { ...record, status: 'unknown' });
  }

  fail(id: string): void {
    this.update(id, (record) => {
      if (record.hash || record.status === 'published' || record.plan?.steps.some(step => step.hash)) throw new AttoError('SEND_STATE', 'A payment with a recorded block must be reconciled before releasing its reservation.');
      return { ...record, status: 'failed' };
    });
  }

  /** Caller must first prove a different canonical block at this block's height. */
  reject(id: string): void {
    this.update(id, (record) => {
      if (!record.hash || record.status === 'published') throw new AttoError('SEND_STATE', 'Only an unpublished recorded block can be rejected after reconciliation.');
      return { ...record, status: 'failed' };
    });
  }

  stepSigned(id: string, stepId: string, hash: string, blockJson: string): void {
    this.updateStep(id, stepId, (step, position, plan) => {
      if (step.status === 'published' || step.status === 'failed' || !hash || !blockJson
        || (step.hash !== undefined && (step.hash !== hash || step.blockJson !== blockJson))
        || plan.steps.slice(0, position).some(previous => previous.status !== 'published')) {
        throw new AttoError('SEND_STATE', 'This consolidation step cannot be assigned a new block.');
      }
      return { ...step, hash, blockJson, status: 'signed' };
    });
  }

  stepComplete(id: string, stepId: string, result: unknown, publishedAt: number): void {
    this.updateStep(id, stepId, step => {
      if (step.status === 'published') return step;
      if (!step.hash || step.status === 'failed' || !Number.isSafeInteger(publishedAt) || publishedAt < 0) {
        throw new AttoError('SEND_STATE', 'Only a recorded consolidation block can complete a step.');
      }
      return { ...step, result, publishedAt, status: 'published' };
    });
  }

  stepUncertain(id: string, stepId: string): void {
    this.updateStep(id, stepId, step => {
      if (step.status === 'published' || step.status === 'failed') return step;
      if (!step.hash) throw new AttoError('SEND_STATE', 'An uncertain consolidation step requires its recorded block.');
      return { ...step, status: 'unknown' };
    });
  }

  /** Caller must prove this internal block conflicts with the canonical chain.
   * The pinned plan cannot complete; retain all step evidence in the failed parent. */
  stepReject(id: string, stepId: string): void {
    this.updateStep(id, stepId, step => {
      if (!step.hash || step.status === 'published') throw new AttoError('SEND_STATE', 'Only an unpublished recorded consolidation block can be rejected.');
      return { ...step, status: 'failed' };
    }, true);
  }

  private updateStep(id: string, stepId: string, change: (step: ConsolidationStep, index: number, plan: PaymentPlan) => ConsolidationStep, reject = false): void {
    this.update(id, record => {
      if (!record.plan || record.hash || record.status === 'published' || record.status === 'failed') {
        throw new AttoError('SEND_STATE', 'This payment no longer accepts consolidation changes.');
      }
      const position = record.plan.steps.findIndex(step => step.id === stepId);
      if (position < 0) throw new AttoError('SEND_NOT_FOUND', 'The consolidation step was not found.');
      const steps = [...record.plan.steps];
      steps[position] = change(steps[position]!, position, record.plan);
      return { ...record, ...(reject ? { status: 'failed' as const } : {}), plan: { ...record.plan, steps } };
    });
  }

  pending(): SendRecord[] {
    return this.records().filter((record) => ['reserved', 'signed', 'unknown'].includes(record.status));
  }

  usage(now = Date.now()) {
    const policy = this.policy();
    const records = this.records();
    return {
      policy,
      mcpAccess: this.mcpAccess(),
      pool: this.pool(),
      proposal: this.proposal(),
      pendingRaw: this.pendingTotal(records).toString(),
      perRequest: policy.perRequest ? { ...policy.perRequest, limitRaw: amountRaw(policy.perRequest.amount, policy.perRequest.unit, true) } : null,
      rolling: policy.rolling.map((rule) => this.ruleUsage(rule, records, now)),
    };
  }

  private records(): SendRecord[] {
    const records = this.store.get<SendRecord[]>(RECORDS_KEY) ?? [];
    try {
      if (!Array.isArray(records)) throw new Error();
      const ids = new Set<string>();
      for (const record of records) {
        if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !record.id || ids.has(record.id)
          || !Number.isSafeInteger(record.index) || record.index < 0 || record.index > 0x7fff_ffff || typeof record.destination !== 'string' || !record.destination
          || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
          || !['reserved', 'signed', 'published', 'unknown', 'failed'].includes(record.status)) throw new Error();
        if (amountRaw(record.raw, 'RAW') !== record.raw) throw new Error();
        if (record.hash !== undefined && (typeof record.hash !== 'string' || !record.hash || typeof record.blockJson !== 'string' || !record.blockJson)) throw new Error();
        if (record.status === 'signed' && !record.hash) throw new Error();
        if (record.status === 'published' && (!record.hash || !Number.isSafeInteger(record.publishedAt) || (record.publishedAt ?? -1) < 0)) throw new Error();
        this.validateDetails(record);
        ids.add(record.id);
      }
      return records;
    } catch {
      throw new AttoError('INVALID_STATE', 'The spending history is invalid. Restore verified wallet state before making payments.');
    }
  }

  private update(id: string, change: (record: SendRecord) => SendRecord): void {
    this.store.transaction(() => {
      const records = this.records();
      const index = records.findIndex((record) => record.id === id);
      const record = records[index];
      if (!record) throw new AttoError('SEND_NOT_FOUND', 'The payment request was not found.');
      records[index] = change(record);
      this.validateDetails(records[index]!);
      this.store.set(RECORDS_KEY, records);
    });
  }

  private pendingTotal(records: SendRecord[]): bigint {
    return records.reduce((sum, record) => ['reserved', 'signed', 'unknown'].includes(record.status) ? sum + BigInt(record.raw) : sum, 0n);
  }

  private ruleUsage(rule: SpendingRule, records: SendRecord[], now: number) {
    const from = now - rule.days * DAY_MS;
    // Future timestamps remain counted if the system clock moves backwards.
    const published = records.reduce((sum, record) => record.status === 'published' && (record.publishedAt ?? record.createdAt) > from ? sum + BigInt(record.raw) : sum, 0n);
    const reserved = this.pendingTotal(records);
    const used = published + reserved;
    const limit = BigInt(amountRaw(rule.amount, rule.unit, true));
    return {
      ...rule,
      from,
      until: now,
      limitRaw: limit.toString(),
      publishedRaw: published.toString(),
      reservedRaw: reserved.toString(),
      usedRaw: used.toString(),
      remainingRaw: (limit > used ? limit - used : 0n).toString(),
    };
  }

  private validatePolicy(policy: SpendingPolicy): void {
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

  private validatePool(pool: AccountPool): void {
    if (!pool || !Array.isArray(pool.indexes) || pool.indexes.length < 1 || pool.indexes.length > 100
      || pool.indexes.some(index => !Number.isSafeInteger(index) || index < 0 || index > 0x7fff_ffff)
      || new Set(pool.indexes).size !== pool.indexes.length || typeof pool.consolidate !== 'boolean') {
      throw new AttoError('INVALID_POOL', 'Choose 1 to 100 distinct wallet indexes and an explicit consolidation setting.');
    }
  }

  private validateDetails(record: SendReservation): void {
    if (record.destinationBinding !== undefined) {
      validateDestinationBinding(record.destinationBinding);
      if (record.destinationBinding.address !== record.destination || record.destinationBinding.network !== record.network) throw new Error('Payment destination binding mismatch.');
    }
    if (record.sourceAddress !== undefined && (typeof record.sourceAddress !== 'string' || !record.sourceAddress || record.sourceAddress.length > 128)) throw new Error();
    if (record.network !== undefined && !['LIVE', 'BETA', 'DEV', 'LOCAL'].includes(record.network)) throw new Error();
    if (record.selection !== undefined && record.selection !== 'automatic' && record.selection !== 'explicit') throw new Error();
    if (record.metadata !== undefined) paymentMetadataSchema.parse(record.metadata);
    if (record.plan !== undefined) validatePaymentPlan(record.plan, record);
  }

  private planDefinition(plan: PaymentPlan | undefined): unknown {
    if (!plan) return undefined;
    return { indexes: plan.indexes, steps: plan.steps.map(({ id, kind, index, sourceAddress, destination, raw, sourceStepId }) => ({
      id, kind, index, sourceAddress, destination, raw, ...(sourceStepId === undefined ? {} : { sourceStepId }),
    })) };
  }
}
