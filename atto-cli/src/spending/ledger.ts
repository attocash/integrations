import { isDeepStrictEqual } from 'node:util';
import { amountRaw } from '../domain/amount.js';
import { AttoError } from '../domain/errors.js';
import { parseDurableRelayRequest, parseRelayOffer, validateRelayOfferRefresh, type RelayRecord } from '../marketplace/relay.js';
import type { StateStore } from '../storage/state.js';
import type { AccountPool, SpendingPolicy, SpendingRule } from '../wallet/types.js';
import type { AttoPaymentNetwork } from './atto-x402.js';
import { DAY_MS, SpendingAuthority, type LimitsProposal, type McpAccess, type ProposalWallet } from './authority.js';
import { validateDestinationBinding, type DestinationBinding } from './destination.js';
import { paymentMetadataSchema, validateNativeCandidate, validatePaymentPlan, type ConsolidationStep, type PaymentMetadata, type PaymentPlan } from './journal.js';

export type { ConsolidationStep, PaymentMetadata, PaymentPlan } from './journal.js';
export type { LimitsProposal, McpAccess, ProposalWallet } from './authority.js';

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
  transactionJson?: string;
  candidateBinding?: string;
  result?: unknown;
  publishedAt?: number;
  sourceAddress?: string;
  network?: string;
  metadata?: PaymentMetadata;
  quote?: unknown;
  selection?: 'automatic' | 'explicit';
  plan?: PaymentPlan;
  external?: ExternalPaymentRecord | LegacyExternalPaymentRecord;
  relay?: RelayRecord;
}

/** Historical wallet accounting only; these records cannot authorize current Marketplace payments. */
export interface ExternalPaymentRecord {
  kind: 'marketplace-topup' | 'marketplace-intent';
  version: 1;
  paymentIdentifier: string;
  network: AttoPaymentNetwork;
  intentId: string;
  resourceUrl: string;
  requirementHash: string;
  intentExpiresAt: string;
  marketplaceState: 'ISSUED' | 'PENDING' | 'ACCEPTED' | 'PUBLISHING' | 'UNKNOWN' | 'PROCESSED' | 'SETTLED' | 'REJECTED' | 'CREDITED' | 'EXPIRED';
  paymentState: 'PREPARED' | 'ATTEMPTED' | 'PENDING' | 'ACCEPTED' | 'PUBLISHING' | 'UNKNOWN' | 'PROCESSED' | 'SETTLED' | 'REJECTED' | 'CONFIRMED' | 'FAILED' | null;
  nativeState: 'challenged' | 'unknown' | 'confirmed' | 'rejected';
  attemptedAt?: number;
  receivePending?: boolean | null;
  receiveStatus?: 'PENDING' | 'ACCEPTED' | 'SETTLED' | 'REJECTED' | null;
}

interface LegacyExternalPaymentRecord extends Omit<ExternalPaymentRecord, 'kind' | 'marketplaceState'> {
  kind: 'market-topup' | 'market-intent';
  marketState: ExternalPaymentRecord['marketplaceState'];
  marketplaceState?: never;
}

export type SendReservation = Pick<SendRecord, 'id' | 'index' | 'destination' | 'raw' | 'createdAt'>
  & Partial<Pick<SendRecord, 'sourceAddress' | 'network' | 'metadata' | 'quote' | 'selection' | 'plan' | 'destinationBinding' | 'relay'>>;

const RECORDS_KEY = 'spending.records';

export class SpendLedger {
  private readonly authority: SpendingAuthority;

  constructor(private readonly store: StateStore) {
    this.authority = new SpendingAuthority(store);
  }

  policy(): SpendingPolicy { return this.authority.policy(); }
  setPolicy(policy: SpendingPolicy): void { this.authority.setPolicy(policy); }
  mcpAccess(): McpAccess { return this.authority.mcpAccess(); }
  pool(): AccountPool { return this.authority.pool(); }
  messageSigningIndexes(): number[] { return this.authority.messageSigningIndexes(); }
  authorityRevision(): number { return this.authority.revision(); }

  proposePolicy(policy: SpendingPolicy, access: McpAccess, wallet: ProposalWallet, pool = this.pool(),
    messageSigningIndexes = this.messageSigningIndexes()): LimitsProposal {
    return this.authority.proposePolicy(policy, access, wallet, pool, messageSigningIndexes);
  }

  proposal(): LimitsProposal | null { return this.authority.proposal(); }
  reviewProposal(id: string, wallet: ProposalWallet): LimitsProposal { return this.authority.reviewProposal(id, wallet); }
  approveProposal(id: string, wallet: ProposalWallet): void { this.authority.approveProposal(id, wallet); }
  rejectProposal(id: string, wallet: ProposalWallet): void { this.authority.rejectProposal(id, wallet); }

  assertCanReserve(raw: string, now = Date.now()): void {
    this.assertAllowance(amountRaw(raw, 'RAW'), now, this.records());
  }

  /** Recheck the current policy before signing without charging this reservation twice. */
  assertReservationAllowed(id: string, now = Date.now()): void {
    const records = this.records();
    const record = records.find(value => value.id === id);
    if (!record) throw new AttoError('SEND_NOT_FOUND', 'The payment request was not found.');
    if (!['reserved', 'signed', 'unknown'].includes(record.status)
      && !(record.status === 'published' && record.relay?.mode === 'DURABLE_NATIVE')) {
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

  private validateReservationInput(request: SendReservation): string {
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
    return raw;
  }

  private matchesReservation(existing: SendRecord, request: SendReservation, raw: string): boolean {
    return existing.index === request.index && existing.destination === request.destination && existing.raw === raw
      && !['sourceAddress', 'network', 'metadata', 'quote', 'selection'].some(key => {
        const field = key as 'sourceAddress' | 'network' | 'metadata' | 'quote' | 'selection';
        return request[field] !== undefined && !isDeepStrictEqual(request[field], existing[field]);
      })
      && (request.relay === undefined || isDeepStrictEqual(
        { ...existing.relay, paymentSignature: undefined, nativePayloadJson: undefined },
        { ...request.relay, paymentSignature: undefined, nativePayloadJson: undefined }))
      && (request.plan === undefined || isDeepStrictEqual(this.planDefinition(request.plan), this.planDefinition(existing.plan)));
  }

  reserve(request: SendReservation): SendRecord {
    const raw = this.validateReservationInput(request);
    return this.store.transaction(() => {
      const records = this.records();
      const existing = records.find(record => record.id === request.id);
      if (existing) {
        if (!this.matchesReservation(existing, request, raw)) {
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

  /** Atomically reserve a new relay payment or refresh an unused x402 offer on its original reservation. */
  reserveRelay(request: SendReservation & { relay: RelayRecord }): SendRecord {
    const raw = this.validateReservationInput(request);
    return this.store.transaction(() => {
      const records = this.records();
      const position = records.findIndex(record => record.id === request.id);
      const existing = records[position];
      if (existing) {
        if (!existing.relay || existing.relay.mode !== request.relay.mode) {
          throw new AttoError('REQUEST_CONFLICT', 'This request ID belongs to another wallet operation or relay mode.');
        }
        let current = existing;
        if (request.relay.mode === undefined && current.relay!.mode === undefined
          && current.relay!.paymentRequired !== request.relay.paymentRequired) {
          if (current.status !== 'reserved' || current.hash !== undefined || current.blockJson !== undefined
            || current.transactionJson !== undefined || current.candidateBinding !== undefined
            || current.relay!.paymentSignature !== undefined
            || current.plan?.steps.some(step => step.hash !== undefined)) {
            throw new AttoError('REQUEST_CONFLICT', 'A retained native candidate can never accept another offer window.');
          }
          validateRelayOfferRefresh(current.relay!, request.relay);
          current = { ...current, relay: request.relay };
          this.validateDetails(current);
          records[position] = current;
          this.store.set(RECORDS_KEY, records);
        }
        if (!this.matchesReservation(current, request, raw)) {
          throw new AttoError('REQUEST_CONFLICT', 'This request ID already belongs to a different payment.');
        }
        return current;
      }
      this.assertAllowance(raw, request.createdAt, records);
      const record: SendRecord = { ...request, raw, status: 'reserved' };
      records.push(record);
      this.store.set(RECORDS_KEY, records);
      return record;
    });
  }

  get(id: string): SendRecord | undefined { return this.records().find(record => record.id === id); }

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

  signed(id: string, hash: string, blockJson: string, transactionJson?: string, candidateBinding?: string,
    authorization?: { paymentSignature: string } | { nativePayloadJson: string }): void {
    this.update(id, record => {
      if (record.status === 'published' || record.status === 'failed' || (record.hash && (record.hash !== hash || record.blockJson !== blockJson))
        || (record.transactionJson !== undefined && (record.transactionJson !== transactionJson || record.candidateBinding !== candidateBinding))) {
        throw new AttoError('SEND_STATE', 'This payment cannot be assigned a new block.');
      }
      if (!hash || !blockJson) throw new AttoError('SEND_STATE', 'A signed payment requires its block hash and block.');
      if (record.plan?.steps.some(step => step.status !== 'published')) throw new AttoError('SEND_STATE', 'Complete every consolidation step before signing the external payment.');
      let relay = record.relay;
      if (authorization) {
        if (!relay || !transactionJson) throw new AttoError('SEND_STATE', 'The relay authorization requires its original signed payment.');
        if (relay.mode === 'DURABLE_NATIVE' && 'nativePayloadJson' in authorization
          && (relay.nativePayloadJson === undefined || relay.nativePayloadJson === authorization.nativePayloadJson)) {
          relay = { ...relay, nativePayloadJson: authorization.nativePayloadJson };
        } else if (relay.mode === undefined && 'paymentSignature' in authorization
          && (relay.paymentSignature === undefined || relay.paymentSignature === authorization.paymentSignature)) {
          relay = { ...relay, paymentSignature: authorization.paymentSignature };
        } else throw new AttoError('SEND_STATE', 'The relay authorization must match its original payment mode and signed payload.');
      }
      return { ...record, ...(relay && { relay }), hash, blockJson, ...(transactionJson !== undefined ? { transactionJson, candidateBinding } : {}), status: 'signed' };
    });
  }

  /** The exact final header is immutable before any caller may submit it to Market. */
  authorizeRelay(id: string, paymentSignature: string): void {
    this.update(id, record => {
      if (!record.relay || record.relay.mode !== undefined || !record.transactionJson || !record.hash || record.status === 'failed'
        || (record.relay.paymentSignature !== undefined && record.relay.paymentSignature !== paymentSignature)) {
        throw new AttoError('REQUEST_CONFLICT', 'The original relay payment cannot be replaced.');
      }
      return { ...record, relay: { ...record.relay, paymentSignature } };
    });
  }

  complete(id: string, result: unknown, publishedAt: number): void {
    this.update(id, record => {
      if (record.status === 'published') return record;
      if (!record.hash || record.status === 'failed' || !Number.isSafeInteger(publishedAt) || publishedAt < 0) {
        throw new AttoError('SEND_STATE', 'Only a recorded block can complete a payment.');
      }
      return { ...record, status: 'published', result, publishedAt };
    });
  }

  uncertain(id: string): void {
    this.update(id, record => record.status === 'published' || record.status === 'failed' ? record : { ...record, status: 'unknown' });
  }

  fail(id: string): void {
    this.update(id, record => {
      if (record.hash || record.status === 'published' || record.plan?.steps.some(step => step.hash)) throw new AttoError('SEND_STATE', 'A payment with a recorded block must be reconciled before releasing its reservation.');
      return { ...record, status: 'failed' };
    });
  }

  /** Caller must first prove a different canonical block at this block's height. */
  reject(id: string): void {
    this.update(id, record => {
      if (!record.hash || record.status === 'published') throw new AttoError('SEND_STATE', 'Only an unpublished recorded block can be rejected after reconciliation.');
      return { ...record, status: 'failed' };
    });
  }

  stepSigned(id: string, stepId: string, hash: string, blockJson: string, transactionJson?: string, candidateBinding?: string): void {
    this.updateStep(id, stepId, (step, position, plan) => {
      if (step.status === 'published' || step.status === 'failed' || !hash || !blockJson
        || (step.hash !== undefined && (step.hash !== hash || step.blockJson !== blockJson))
        || (step.transactionJson !== undefined && (step.transactionJson !== transactionJson || step.candidateBinding !== candidateBinding))
        || plan.steps.slice(0, position).some(previous => previous.status !== 'published')) {
        throw new AttoError('SEND_STATE', 'This consolidation step cannot be assigned a new block.');
      }
      return { ...step, hash, blockJson, ...(transactionJson !== undefined ? { transactionJson, candidateBinding } : {}), status: 'signed' };
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

  /** Caller owns this account's lock; unresolved plans keep their accounts reserved. */
  assertAccountAvailable(index: number): void {
    const record = this.pending().find(record => (record.plan?.indexes ?? [record.index]).includes(index));
    if (record) throw new AttoError('ACCOUNT_RESERVED', 'This account belongs to an unfinished payment. Resume that request first.', { requestId: record.id });
  }

  pending(): SendRecord[] {
    return this.records().filter(record => ['reserved', 'signed', 'unknown'].includes(record.status));
  }

  usage(now = Date.now()) {
    const policy = this.policy();
    const records = this.records();
    return {
      policy,
      mcpAccess: this.mcpAccess(),
      pool: this.pool(),
      messageSigningIndexes: this.messageSigningIndexes(),
      proposal: this.proposal(),
      pendingRaw: this.pendingTotal(records).toString(),
      perRequest: policy.perRequest ? { ...policy.perRequest, limitRaw: amountRaw(policy.perRequest.amount, policy.perRequest.unit, true) } : null,
      rolling: policy.rolling.map(rule => this.ruleUsage(rule, records, now)),
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
        this.validateDetails(record, true);
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
      const index = records.findIndex(record => record.id === id);
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

  private validateDetails(record: Omit<SendRecord, 'status'>, historical = false): void {
    validateNativeCandidate(record);
    if (record.destinationBinding !== undefined) {
      validateDestinationBinding(record.destinationBinding);
      if (record.destinationBinding.address !== record.destination || record.destinationBinding.network !== record.network) throw new Error('Payment destination binding mismatch.');
    }
    if (record.sourceAddress !== undefined && (typeof record.sourceAddress !== 'string' || !record.sourceAddress || record.sourceAddress.length > 128)) throw new Error();
    if (record.network !== undefined && !['LIVE', 'BETA', 'DEV', 'LOCAL'].includes(record.network)) throw new Error();
    if (record.selection !== undefined && record.selection !== 'automatic' && record.selection !== 'explicit') throw new Error();
    if (record.metadata !== undefined && !paymentMetadataSchema.safeParse(record.metadata).success) throw new Error();
    if (record.plan !== undefined) validatePaymentPlan(record.plan, record);
    if (record.external !== undefined) {
      if (!historical) throw new Error('Legacy external payment records are read-only.');
      this.validateExternal(record.external);
    }
    if (record.relay !== undefined) {
      if (record.external || record.relay.version !== 1 || record.id !== record.relay.requestId || record.relay.index !== record.index || record.plan?.steps.length
        || record.sourceAddress !== record.relay.terms.senderAddress || record.destination !== record.relay.terms.recipientAddress
        || record.raw !== record.relay.terms.amountAtomic || record.relay.terms.asset !== 'ATTO'
        || `atto:${record.network?.toLowerCase()}` !== record.relay.terms.network) {
        throw new Error('Invalid relay payment.');
      }
      if (record.relay.mode === 'DURABLE_NATIVE') {
        const payload = record.relay.nativePayloadJson;
        if (record.relay.paymentSignature !== undefined || (record.hash === undefined ? payload !== undefined
          : !record.transactionJson || typeof payload !== 'string' || Buffer.byteLength(payload, 'utf8') > 65_536)) {
          throw new Error('Invalid native relay authorization.');
        }
        parseDurableRelayRequest(record.relay);
      } else {
        if (record.relay.nativePayloadJson !== undefined || (record.relay.paymentSignature !== undefined
          && (typeof record.relay.paymentSignature !== 'string' || record.relay.paymentSignature.length > 90_000))) {
          throw new Error('Invalid x402 relay authorization.');
        }
        parseRelayOffer(record.relay, true);
      }
    }
  }

  private validateExternal(value: NonNullable<SendRecord['external']>): void {
    if (!value || typeof value !== 'object') throw new Error('Invalid external payment record.');
    const external = value as unknown as Omit<Partial<ExternalPaymentRecord>, 'kind'> & { kind?: unknown; marketState?: unknown };
    const legacy = external.kind === 'market-topup' || external.kind === 'market-intent';
    const current = external.kind === 'marketplace-topup' || external.kind === 'marketplace-intent';
    const remoteState = legacy ? external.marketState : external.marketplaceState;
    if ((!current && !legacy) || (legacy && external.marketplaceState !== undefined) || (!legacy && external.marketState !== undefined)
      || external.version !== 1
      || typeof external.paymentIdentifier !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(external.paymentIdentifier)
      || !['atto:live', 'atto:beta', 'atto:dev', 'atto:local'].includes(external.network ?? '')
      || typeof external.intentId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(external.intentId)
      || typeof external.resourceUrl !== 'string' || external.resourceUrl.length > 2048
      || typeof external.requirementHash !== 'string' || !/^[a-f0-9]{64}$/.test(external.requirementHash)
      || typeof external.intentExpiresAt !== 'string' || !Number.isFinite(Date.parse(external.intentExpiresAt))
      || typeof remoteState !== 'string' || !['ISSUED', 'PENDING', 'ACCEPTED', 'PUBLISHING', 'UNKNOWN', 'PROCESSED', 'SETTLED', 'REJECTED', 'CREDITED', 'EXPIRED'].includes(remoteState)
      || (external.paymentState !== null && !['PREPARED', 'ATTEMPTED', 'PENDING', 'ACCEPTED', 'PUBLISHING', 'UNKNOWN', 'PROCESSED', 'SETTLED', 'REJECTED', 'CONFIRMED', 'FAILED'].includes(external.paymentState ?? ''))
      || !['challenged', 'unknown', 'confirmed', 'rejected'].includes(external.nativeState ?? '')
      || (external.attemptedAt !== undefined && (!Number.isSafeInteger(external.attemptedAt) || external.attemptedAt < 0))
      || (external.receivePending !== undefined && external.receivePending !== null && typeof external.receivePending !== 'boolean')
      || (external.receiveStatus !== undefined && external.receiveStatus !== null
        && !['PENDING', 'ACCEPTED', 'SETTLED', 'REJECTED'].includes(external.receiveStatus))) {
      throw new Error('Invalid external payment record.');
    }
    if (external.nativeState === 'challenged' && external.attemptedAt !== undefined) throw new Error('Invalid external attempt state.');
    if (['unknown', 'confirmed', 'rejected'].includes(external.nativeState!) && external.attemptedAt === undefined) throw new Error('Missing external attempt marker.');
  }

  private planDefinition(plan: PaymentPlan | undefined): unknown {
    if (!plan) return undefined;
    return { indexes: plan.indexes, steps: plan.steps.map(({ id, kind, index, sourceAddress, destination, raw, sourceStepId }) => ({
      id, kind, index, sourceAddress, destination, raw, ...(sourceStepId === undefined ? {} : { sourceStepId }),
    })) };
  }
}
