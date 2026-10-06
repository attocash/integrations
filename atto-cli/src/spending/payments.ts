import { bindDestination, type DestinationBinding } from './destination.js';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  AttoAccount, AttoAmount, AttoOpenBlock, AttoReceivable, AttoReceiveBlock,
  AttoSeed, AttoSendBlock, AttoTransaction, AttoUnit, toAttoIndex,
} from '@attocash/commons-core';
import { amountOutput, amountRaw } from '../domain/amount.js';
import { AttoError } from '../domain/errors.js';
import { NodeReader, parseAddress, publicModel } from '../network/reader.js';
import { retryNetwork, type SendRetry } from '../network/retry.js';
import type { MarketData } from '../pricing/market.js';
import { marketTerms } from '../pricing/terms.js';
import type { StateStore } from '../storage/state.js';
import { derivedSigner, signingWallet } from '../wallet/signing.js';
import type { SendRequest, WalletAddress, WalletIdentity, WalletSettings } from '../wallet/types.js';
import type { WalletWork } from '../wallet/work.js';
import { SpendLedger, type ConsolidationStep, type ExternalPaymentRecord, type ExternalPaymentSecrets, type SendRecord } from './ledger.js';
import { planPayment, type PoolAccount } from './pool.js';
import { reconcileBlock, reconcileSend } from './reconcile.js';
import { MarketTopUpClient, type MarketConnection, type MarketTopUpStatus, type TopUpChallenge } from '../market/topups.js';
import { parseAttoExactRequirement, paymentDeadline, paymentPayload, type AttoExactRequirement } from './atto-x402.js';

interface PaymentWallet {
  settings(): WalletSettings;
  addresses(): WalletAddress[];
  seed(): Promise<AttoSeed>;
  requireWrite(): void;
  mcp: boolean;
}
type Quote = Awaited<ReturnType<MarketData['quoteUsd']>>;

export interface MarketTopUpRequest {
  amount: string;
  unit: 'ATTO' | 'RAW';
  requestId: string;
  index?: number;
}

const MARKET_INTENT_SWEEP_TIMEOUT_MS = 1_000;
const MARKET_INTENT_SWEEP_CONCURRENCY = 16;

/** Owns payment selection, reservations, publication and recovery as one workflow. */
export class Payments {
  constructor(private readonly store: StateStore, private readonly ledger: SpendLedger,
    private readonly wallet: PaymentWallet, private readonly market: MarketData, private readonly work: WalletWork,
    private readonly retry?: SendRetry, private readonly onDestination?: (binding: DestinationBinding) => void,
    private readonly topUps?: MarketTopUpClient) {}

  private reader() { return new NodeReader(this.wallet.settings()); }
  private indexes(record: SendRecord) { return record.plan?.indexes ?? [record.index]; }
  private result(transaction: AttoTransaction) {
    return { status: 'published', hash: transaction.hash.toString(), transaction: publicModel(transaction) };
  }
  private paymentResult(record: SendRecord, transaction: AttoTransaction) {
    const quote = record.quote ?? this.store.get(`send.quote.${record.id}`);
    return { ...this.result(transaction), requestId: record.id, index: record.index,
      sourceAddress: record.sourceAddress ?? transaction.address.value, destination: record.destination,
      ...(record.destinationBinding ? { destinationBinding: record.destinationBinding } : {}),
      ...(quote ? { quote } : {}), ...(record.metadata ? { metadata: record.metadata } : {}),
      ...(record.plan?.steps.length ? { consolidation: record.plan.steps.map(({ id, kind, index, hash, raw }) => ({ id, kind, index, hash, raw })) } : {}) };
  }

  private checkRequest(record: SendRecord, request: SendRequest): void {
    const quote = (record.quote ?? this.store.get(`send.quote.${record.id}`)) as Quote | undefined;
    const raw = request.unit === 'USD' ? quote?.amount.raw : amountRaw(request.amount, request.unit);
    if (record.destination !== parseAddress(request.destination!).value || record.raw !== raw
      || (request.index !== undefined && request.index !== record.index)
      || (request.unit === 'USD' ? quote?.usd !== request.amount : Boolean(quote))
      || (request.metadata !== undefined && !isDeepStrictEqual(record.metadata, request.metadata))) {
      throw new AttoError('REQUEST_CONFLICT', 'This request ID belongs to a different payment. Keep the original destination, amount, source and metadata.');
    }
  }

  private requireApproved(record: SendRecord, requireReservation = true): void {
    this.wallet.requireWrite();
    if (requireReservation) this.ledger.assertReservationAllowed(record.id);
    if (record.network && record.network !== this.wallet.settings().network) throw new AttoError('NETWORK_MISMATCH', 'The payment belongs to a different network.');
    const pool = this.ledger.pool();
    if ((this.wallet.mcp || record.external?.kind === 'market-topup' || record.external?.kind === 'market-intent' || record.selection === 'automatic' || record.plan?.steps.length)
      && this.indexes(record).some(index => !pool.indexes.includes(index))) {
      throw new AttoError('POOL_APPROVAL_REQUIRED', 'The payment uses an account outside the approved pool. Review the pool in a local terminal.');
    }
    if (record.plan?.steps.length && !pool.consolidate) throw new AttoError('CONSOLIDATION_REQUIRED', 'Approve consolidation before continuing this payment.');
  }

  /** Caller owns this account's lock; unresolved plans keep their accounts reserved. */
  requireAvailable(index: number): void {
    const record = this.ledger.pending().find(record => this.indexes(record).includes(index));
    if (record) throw new AttoError('ACCOUNT_RESERVED', 'This account belongs to an unfinished payment. Resume that request first.', { requestId: record.id });
  }

  async marketTopUp(request: MarketTopUpRequest): Promise<unknown> {
    const previous = typeof request.requestId === 'string' ? this.ledger.get(request.requestId) : undefined;
    if (previous && this.isLegacyCreditedMarketTopUp(previous)) {
      const raw = amountRaw(request.amount, request.unit);
      if (raw !== previous.raw || (request.index !== undefined && request.index !== previous.index)) {
        throw new AttoError('REQUEST_CONFLICT', 'This request ID belongs to a different historical Market payment.');
      }
      return this.legacyMarketTopUpResult(previous);
    }
    this.wallet.requireWrite();
    if (!this.topUps) throw new AttoError('MARKET_NOT_CONNECTED', 'Connect this wallet to Market from a local terminal before using top-ups.');
    if (typeof request.requestId !== 'string' || !request.requestId || request.requestId.length > 128
      || (request.index !== undefined && (!Number.isSafeInteger(request.index) || request.index < 0 || request.index > 0x7fff_ffff))) {
      throw new AttoError('INVALID_INPUT', 'Market top-ups require a request ID and an optional valid wallet index.');
    }
    const raw = amountRaw(request.amount, request.unit);
    if (raw === '0') throw new AttoError('INVALID_INPUT', 'Market top-ups require a positive amount.');
    const connection = this.topUps.connection();
    const settings = this.wallet.settings();
    const network = this.topUpNetwork(settings);
    const paymentIdentifier = marketPaymentIdentifier(connection, request.requestId);
    await this.reconcileMarketIntents();
    const existing = this.ledger.get(request.requestId);
    if (existing) {
      this.checkMarketTopUpRequest(existing, request, raw, network, paymentIdentifier);
      return this.resumeMarketTopUp(existing, connection, paymentIdentifier);
    }
    await this.store.withWalletLock(async () => {
      this.wallet.requireWrite();
      this.ledger.assertCanReserve(raw);
    });
    const offered = await this.topUps.challenge(connection, paymentIdentifier, raw);
    const challenge = offered.challenge;
    if (!challenge) return this.unreservedMarketStatus(request.requestId, paymentIdentifier, offered.status);
    if (offered.status.state !== 'PENDING') return this.unreservedMarketStatus(request.requestId, paymentIdentifier, offered.status);
    const record = await this.reserveMarketTopUp(request, raw, paymentIdentifier, network, connection, challenge);
    return this.store.withAccountLocks([record.index], async () =>
      this.runMarketTopUp(record, connection, paymentIdentifier, challenge.requirement));
  }

  async marketTopUpStatus(requestId: string): Promise<unknown> {
    const record = this.ledger.get(requestId);
    if (!record) throw new AttoError('JOURNAL_NOT_FOUND', 'This payment request is not in the local journal.');
    if (record.external?.kind !== 'market-topup') throw new AttoError('REQUEST_CONFLICT', 'This request ID does not belong to a Market top-up.');
    if (this.isLegacyCreditedMarketTopUp(record)) return this.legacyMarketTopUpResult(record);
    if (!this.topUps) throw new AttoError('MARKET_NOT_CONNECTED', 'Connect this wallet to Market from a local terminal before reading top-up status.');
    const connection = this.topUps.connection();
    this.checkMarketOwner(record, connection);
    return this.store.withAccountLocks([record.index], async () => {
      await this.refreshMarketStatus(record.id, connection);
      await this.reconcileMarketSend(this.ledger.get(record.id)!);
      return this.marketTopUpResult(this.ledger.get(record.id)!);
    });
  }

  private topUpNetwork(settings: WalletSettings): 'atto:live' | 'atto:local' {
    if (settings.network === 'LIVE') return 'atto:live';
    if (settings.network === 'LOCAL') return 'atto:local';
    throw new AttoError('MARKET_NETWORK', 'Market top-ups support the configured LIVE or isolated LOCAL ATTO network only.');
  }

  private async reserveMarketTopUp(request: MarketTopUpRequest, raw: string, paymentIdentifier: string,
    network: 'atto:live' | 'atto:local', connection: MarketConnection, challenge: TopUpChallenge): Promise<SendRecord> {
    const releases = new Map<number, () => void>();
    try {
      const snapshot = await this.store.withWalletLock(async () => {
        this.wallet.requireWrite();
        const prior = this.ledger.get(request.requestId);
        if (prior) return { prior };
        const settings = this.wallet.settings();
        if (this.topUpNetwork(settings) !== network) throw new AttoError('NETWORK_MISMATCH', 'The wallet network changed during Market top-up setup.');
        const pool = this.ledger.pool();
        const indexes = request.index === undefined ? pool.indexes : [request.index];
        if (request.index !== undefined && !pool.indexes.includes(request.index)) {
          throw new AttoError('POOL_APPROVAL_REQUIRED', 'The selected account is outside the approved payment pool.');
        }
        this.ledger.assertCanReserve(raw);
        const pending = new Set(this.ledger.pending().flatMap(record => this.indexes(record)));
        let busy = false;
        let reserved = false;
        for (const index of indexes) {
          const address = this.wallet.addresses().find(value => value.index === index);
          if (!address) throw new AttoError('ADDRESS_NOT_DERIVED', 'Derive or approve the selected wallet account before paying.');
          if (pending.has(index)) { reserved = true; continue; }
          const release = this.store.tryAccountLocks([index]);
          if (!release) { busy = true; continue; }
          releases.set(index, release);
        }
        return { settings, pool, indexes, busy, reserved };
      });
      if ('prior' in snapshot) {
        this.checkMarketTopUpRequest(snapshot.prior!, request, raw, network, paymentIdentifier);
        return snapshot.prior!;
      }
      const addresses = snapshot.indexes.map(index => this.wallet.addresses().find(value => value.index === index)!)
        .filter(address => releases.has(address.index));
      const reader = new NodeReader(snapshot.settings);
      const candidates: PoolAccount[] = [];
      for (const address of addresses) {
        const account = await retryNetwork(() => reader.account(address.address, this.retry?.signal), this.retry);
        if (!account) continue;
        this.checkAccount(address, account, snapshot.settings);
        candidates.push({ address, account, workReady: this.work.isReady(account) });
      }
      let chosen: ReturnType<typeof planPayment>;
      try {
        if (request.index !== undefined && !candidates.length && !snapshot.busy && !snapshot.reserved) {
          throw new AttoError('ACCOUNT_NOT_OPEN', 'Receive funds to open this account before sending.');
        }
        chosen = planPayment(candidates, raw, false);
      } catch (error) {
        if (snapshot.busy || snapshot.reserved) throw new AttoError('POOL_BUSY', 'Eligible accounts are busy or reserved by unfinished payments. Retry after those payments settle.');
        throw error;
      }
      const record = await this.store.withWalletLock(async () => {
        this.wallet.requireWrite();
        if (!isDeepStrictEqual(snapshot.settings, this.wallet.settings()) || !isDeepStrictEqual(snapshot.pool, this.ledger.pool())) {
          throw new AttoError('POOL_CHANGED', 'Wallet settings or the approved pool changed during account selection. Retry this request.');
        }
        const prior = this.ledger.get(request.requestId);
        if (prior) return prior;
        this.ledger.assertCanReserve(raw);
        const external: ExternalPaymentRecord = {
          kind: 'market-topup', version: 1, paymentIdentifier, network, intentId: challenge.status.intentId,
          resourceUrl: challenge.requirement.resourceUrl, requirementHash: challenge.requirement.fingerprint,
          intentExpiresAt: challenge.status.expiresAt, marketState: challenge.status.state,
          paymentState: challenge.status.paymentState, nativeState: 'challenged', receivePending: challenge.status.receivePending,
          receiveStatus: challenge.status.receiveStatus,
        };
        const reserved = this.ledger.reserve({ id: request.requestId, index: chosen.source.address.index,
          destination: challenge.requirement.payTo, raw, sourceAddress: chosen.source.address.address,
          network: snapshot.settings.network, selection: request.index === undefined ? 'automatic' : 'explicit',
          plan: { indexes: [chosen.source.address.index], steps: [] }, createdAt: Date.now(), external });
        this.ledger.externalChallenge(request.requestId, challenge.requirement.rawJson, {
          version: 1, apiUrl: connection.apiUrl, audience: connection.audience, accountId: connection.accountId, agentId: connection.agentId,
          identityId: connection.identityId, walletFingerprint: connection.walletFingerprint,
          controllerIndex: connection.controllerIndex, controllerAddress: connection.controllerAddress,
        });
        return reserved;
      });
      this.checkMarketTopUpRequest(record, request, raw, network, paymentIdentifier);
      return record;
    } finally {
      for (const release of releases.values()) release();
    }
  }

  private async resumeMarketTopUp(record: SendRecord, connection: MarketConnection, paymentIdentifier: string): Promise<unknown> {
    if (this.isLegacyCreditedMarketTopUp(record)) return this.legacyMarketTopUpResult(record);
    const network = this.topUpNetwork(this.wallet.settings());
    this.checkMarketTopUpRequest(record, { requestId: record.id, amount: record.raw, unit: 'RAW' }, record.raw, network, paymentIdentifier);
    this.checkMarketOwner(record, connection);
    if (!this.topUps || !record.external) throw new AttoError('INVALID_STATE', 'The saved Market top-up is incomplete.');
    const secrets = this.ledger.externalSecretsFor(record.id);
    if (record.hash && (!secrets?.transactionJson || !secrets.paymentSignature)) {
      throw new AttoError('INVALID_STATE', 'The exact signed Market payment is unavailable; its account remains reserved for reconciliation.');
    }
    let requirement: AttoExactRequirement | undefined;
    if (secrets?.requirementJson) {
      requirement = parseAttoExactRequirement({ header: Buffer.from(secrets.requirementJson, 'utf8').toString('base64'),
        apiUrl: connection.apiUrl, intentId: record.external.intentId, network, amountRaw: record.raw });
    } else if (!record.hash && record.status !== 'failed') {
      const offered = await this.topUps.challenge(connection, paymentIdentifier, record.raw);
      if (!offered.challenge) return this.marketTopUpResult(record);
      if (offered.challenge.requirement.fingerprint !== record.external.requirementHash) {
        throw new AttoError('REQUEST_CONFLICT', 'Market returned a different challenge for this payment ID.');
      }
      requirement = offered.challenge.requirement;
      await this.store.withWalletLock(async () => this.ledger.externalChallenge(record.id, requirement!.rawJson, {
        version: 1, apiUrl: connection.apiUrl, audience: connection.audience, accountId: connection.accountId, agentId: connection.agentId,
        identityId: connection.identityId, walletFingerprint: connection.walletFingerprint,
        controllerIndex: connection.controllerIndex, controllerAddress: connection.controllerAddress,
      }));
    }
    return this.store.withAccountLocks([record.index], async () =>
      this.runMarketTopUp(this.ledger.get(record.id)!, connection, paymentIdentifier, requirement));
  }

  private async runMarketTopUp(record: SendRecord, connection: MarketConnection, paymentIdentifier: string,
    requirement?: AttoExactRequirement): Promise<unknown> {
    if (!this.topUps || !record.external) throw new AttoError('INVALID_STATE', 'The saved Market top-up is incomplete.');
    this.checkMarketOwner(record, connection);
    await this.refreshMarketStatus(record.id, connection);
    await this.reconcileMarketSend(this.ledger.get(record.id)!);
    let current = this.ledger.get(record.id)!;
    if (current.status === 'failed' || current.external!.nativeState === 'rejected'
      || this.marketFundingUsable(current.external!.marketState, current.external!.paymentState)) {
      return this.marketTopUpResult(current);
    }
    if (current.status === 'published' && !this.hasUnconfirmedMarketPayment(current)) return this.marketTopUpResult(current);

    const secrets = this.ledger.externalSecretsFor(current.id);
    if (current.hash) {
      if (!secrets?.transactionJson || !secrets.paymentSignature) {
        throw new AttoError('INVALID_STATE', 'The exact signed Market payment is unavailable; its account remains reserved for reconciliation.');
      }
      const transaction = AttoTransaction.fromJson(secrets.transactionJson);
      if (transaction.hash.toString().toUpperCase() !== current.hash.toUpperCase()) {
        throw new AttoError('INVALID_STATE', 'The saved signed payment does not match its recorded native hash.');
      }
      requirement ??= parseAttoExactRequirement({ header: Buffer.from(secrets.requirementJson, 'utf8').toString('base64'),
        apiUrl: connection.apiUrl, intentId: current.external!.intentId, network: current.external!.network, amountRaw: current.raw });
      if (BigInt(Date.now()) >= paymentDeadline(transaction, requirement.maxTimeoutSeconds, current.external!.intentExpiresAt)) {
        return this.marketTopUpResult(current);
      }
      const status = this.marketStatusProjection(current);
      const updated = await this.topUps.pay(connection, status, paymentIdentifier, secrets.paymentSignature, {
        hash: current.hash, network: current.external!.network, payer: current.sourceAddress!,
      }, async () => this.store.withWalletLock(async () => {
        this.requireApproved(current, current.status !== 'published');
      }));
      await this.saveMarketStatus(current.id, updated);
    } else {
      if (current.external!.marketState === 'REJECTED') return this.marketTopUpResult(current);
      if (!requirement) throw new AttoError('INVALID_STATE', 'The original Market challenge is unavailable; no replacement payment will be signed.');
      current = await this.prepareAndSubmitMarketTopUp(current, connection, paymentIdentifier, requirement);
    }
    await this.reconcileMarketSend(this.ledger.get(record.id)!);
    return this.marketTopUpResult(this.ledger.get(record.id)!);
  }

  private async prepareAndSubmitMarketTopUp(record: SendRecord, connection: MarketConnection, paymentIdentifier: string,
    requirement: AttoExactRequirement): Promise<SendRecord> {
    const secrets = this.ledger.externalSecretsFor(record.id);
    if (!record.external || !secrets || secrets.requirementJson !== requirement.rawJson
      || record.external.requirementHash !== requirement.fingerprint) {
      throw new AttoError('INVALID_STATE', 'The original Market challenge is unavailable; no replacement payment will be signed.');
    }
    const seed = await this.wallet.seed();
    const settings = this.wallet.settings();
    let execution: Awaited<ReturnType<typeof signingWallet>> | undefined;
    try {
      await this.store.withWalletLock(async () => this.requireApproved(record));
      const signer = await derivedSigner(seed, record.index);
      if (signer.address.value !== record.sourceAddress) throw new AttoError('WALLET_MISMATCH', 'The saved Market top-up source does not match its wallet key.');
      execution = await signingWallet(seed, record.index, settings, async block => {
        await this.store.withWalletLock(async () => {
          this.requireApproved(record);
          if (!(block instanceof AttoSendBlock) || block.address.value !== record.sourceAddress
            || block.receiverAddress.value !== requirement.payTo || block.amount.toString() !== record.raw
            || block.network.name !== settings.network) {
            throw new AttoError('TRANSACTION_MISMATCH', 'The prepared transaction differs from the offered Market top-up.');
          }
        });
      }, this.work.worker(), this.retry);
      const transaction = await execution.wallet.prepareSendByIndex(toAttoIndex(record.index), parseAddress(requirement.payTo),
        AttoAmount.from(AttoUnit.RAW, record.raw), null);
      const payment = paymentPayload(requirement, paymentIdentifier, transaction);
      const deadline = paymentDeadline(transaction, requirement.maxTimeoutSeconds, record.external.intentExpiresAt);
      const status = this.marketStatusProjection(record);
      const updated = await this.topUps!.pay(connection, status, paymentIdentifier, payment.header, {
        hash: transaction.hash.toString(), network: record.external.network, payer: record.sourceAddress!,
      }, async () => this.store.withWalletLock(async () => {
        const current = this.ledger.get(record.id)!;
        this.requireApproved(current);
        if (!current.external || current.hash || current.status !== 'reserved'
          || current.external.requirementHash !== requirement.fingerprint
          || BigInt(Date.now()) >= deadline) {
          throw new AttoError('MARKET_CHALLENGE_EXPIRED', 'The Market payment deadline expired or its challenge changed before submission.');
        }
        this.ledger.externalAttempt(record.id, {
          hash: transaction.hash.toString(), blockJson: transaction.block.toJson(), transactionJson: transaction.toJson(),
          paymentJson: payment.json, paymentSignature: payment.header, attemptedAt: Date.now(),
        });
      }));
      await this.saveMarketStatus(record.id, updated);
      return this.ledger.get(record.id)!;
    } finally {
      execution?.wallet.close();
      seed.value.fill(0);
    }
  }

  private async refreshMarketStatus(requestId: string, connection: MarketConnection): Promise<void> {
    const record = this.ledger.get(requestId);
    if (!record?.external || !this.topUps) return;
    this.checkMarketOwner(record, connection);
    const expected = record.hash
      ? { hash: record.hash, payer: record.sourceAddress ?? '' }
      : undefined;
    if (record.hash && !expected?.payer) {
      throw new AttoError('INVALID_STATE', 'The saved Market payment has no source address; its account remains reserved for reconciliation.');
    }
    const status = await this.topUps.status(connection, record.external.intentId, record.external.paymentIdentifier,
      record.raw, record.external.network, expected);
    await this.saveMarketStatus(requestId, status);
    const current = this.ledger.get(requestId)!;
    if (!current.hash && current.status === 'reserved' && status.state === 'REJECTED') {
      await this.store.withWalletLock(async () => this.ledger.fail(requestId));
    }
  }

  private async saveMarketStatus(requestId: string, status: MarketTopUpStatus): Promise<void> {
    await this.store.withWalletLock(async () => this.ledger.externalStatus(requestId, {
      marketState: status.state, paymentState: status.paymentState, receivePending: status.receivePending,
      receiveStatus: status.receiveStatus,
    }));
  }

  private async reconcileMarketSend(record: SendRecord, timeoutMs = 10_000): Promise<void> {
    if (!record.external || !record.hash || ['published', 'failed'].includes(record.status)) return;
    const outcome = await reconcileSend(this.reader(), record, timeoutMs);
    if (outcome.status === 'unresolved') return;
    await this.store.withWalletLock(async () => {
      const current = this.ledger.get(record.id)!;
      if (current.status === 'published' || current.status === 'failed') return;
      if (outcome.status === 'rejected') {
        this.ledger.rejectExternal(record.id, { status: 'rejected', hash: record.hash });
      } else {
        this.ledger.completeExternal(record.id, { status: 'published', hash: record.hash },
          Number(outcome.transaction.block.timestamp.toEpochMilliseconds()));
      }
    });
    if (outcome.status === 'published') this.work.prepareConfirmed(outcome.transaction.block);
  }

  private async reconcileMarketIntents(candidateIndexes = this.ledger.pool().indexes): Promise<void> {
    const candidates = new Set(candidateIndexes);
    const records = this.ledger.pending().filter(record => record.external?.kind === 'market-intent'
      && record.hash !== undefined && candidates.has(record.index));
    let cursor = 0;
    const worker = async () => {
      while (cursor < records.length) {
        const record = records[cursor++]!;
        const release = this.store.tryAccountLocks([record.index]);
        if (!release) continue;
        try {
          const current = this.ledger.get(record.id);
          if (current?.external?.kind === 'market-intent') {
            await this.reconcileMarketSend(current, MARKET_INTENT_SWEEP_TIMEOUT_MS);
          }
        } finally { release(); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MARKET_INTENT_SWEEP_CONCURRENCY, records.length) }, worker));
  }

  private hasUnconfirmedMarketPayment(record: SendRecord): boolean {
    return record.external !== undefined && !this.marketFundingUsable(record.external.marketState, record.external.paymentState);
  }

  private marketFundingUsable(marketState: string, paymentState: string | null): boolean {
    return ['ACCEPTED', 'SETTLED'].includes(marketState) || ['ACCEPTED', 'SETTLED'].includes(paymentState ?? '');
  }

  private marketStatusProjection(record: SendRecord): MarketTopUpStatus {
    const external = record.external;
    if (!external) throw new AttoError('INVALID_STATE', 'The payment is not a Market top-up.');
    const marketState = ['PENDING', 'ACCEPTED', 'SETTLED', 'REJECTED']
      .includes(external.marketState) ? external.marketState as MarketTopUpStatus['state'] : 'PENDING';
    const paymentState = ['PENDING', 'ACCEPTED', 'SETTLED', 'REJECTED']
      .includes(external.paymentState ?? '') ? external.paymentState as MarketTopUpStatus['paymentState'] : null;
    return { intentId: external.intentId, asset: 'ATTO', network: external.network, amountAtomic: record.raw,
      state: marketState, expiresAt: external.intentExpiresAt, sendHash: record.hash ?? null,
      payer: record.sourceAddress ?? null, paymentState,
      receivePending: external.receivePending ?? null, discrepancy: null, receiveStatus: external.receiveStatus ?? null };
  }

  private marketTopUpResult(record: SendRecord): Record<string, unknown> {
    const external = record.external;
    if (!external) throw new AttoError('REQUEST_CONFLICT', 'This request ID does not belong to a Market top-up.');
    const status = this.marketStatusProjection(record);
    return { requestId: record.id, status: record.status, nativeState: external.nativeState,
      marketState: status.state, paymentState: status.paymentState, receivePending: status.receivePending,
      receiveStatus: status.receiveStatus,
      intentId: external.intentId, network: external.network, amount: amountOutput(record.raw), index: record.index,
      sourceAddress: record.sourceAddress ?? null, destination: record.destination, hash: record.hash ?? null,
      sendHash: record.hash ?? null, payer: record.sourceAddress ?? null, expiresAt: external.intentExpiresAt };
  }

  private isLegacyCreditedMarketTopUp(record: SendRecord): boolean {
    return record.external?.kind === 'market-topup' && record.external.marketState === 'CREDITED';
  }

  private legacyMarketTopUpResult(record: SendRecord): Record<string, unknown> {
    return { ...this.marketTopUpResult(record), historicalOnly: true, currentMarketBalance: 'unverified',
      message: 'This wallet journal records a historical Market credit. It was not replayed and does not establish a balance in the current Market database.' };
  }

  private unreservedMarketStatus(requestId: string, paymentIdentifier: string, status: MarketTopUpStatus): Record<string, unknown> {
    return { requestId, status: 'not_submitted', nativeState: 'not_submitted', marketState: status.state,
      paymentState: status.paymentState, receivePending: status.receivePending, receiveStatus: status.receiveStatus,
      intentId: status.intentId,
      network: status.network, amount: amountOutput(status.amountAtomic), sendHash: status.sendHash, payer: status.payer,
      expiresAt: status.expiresAt, paymentIdentifier };
  }

  private checkMarketTopUpRequest(record: SendRecord, request: MarketTopUpRequest, raw: string,
    network: 'atto:live' | 'atto:local', paymentIdentifier: string): void {
    if (!record.external || record.external.kind !== 'market-topup' || record.raw !== raw || record.external.paymentIdentifier !== paymentIdentifier
      || record.external.network !== network || record.network !== this.wallet.settings().network
      || (request.index !== undefined && record.index !== request.index)) {
      throw new AttoError('REQUEST_CONFLICT', 'This request ID belongs to a different Market top-up. Keep its original amount, network, and source account.');
    }
  }

  private checkMarketOwner(record: SendRecord, connection: MarketConnection): void {
    const secrets: ExternalPaymentSecrets | undefined = this.ledger.externalSecretsFor(record.id);
    if (secrets && (secrets.apiUrl !== connection.apiUrl || secrets.audience !== connection.audience
      || secrets.accountId !== connection.accountId || secrets.agentId !== connection.agentId || secrets.identityId !== connection.identityId
      || secrets.walletFingerprint !== connection.walletFingerprint
      || secrets.controllerIndex !== connection.controllerIndex || secrets.controllerAddress !== connection.controllerAddress)) {
      throw new AttoError('MARKET_RECONNECT_REQUIRED', 'This payment belongs to a different Market account or controller. Reconnect using its original wallet profile.');
    }
  }

  async send(request: SendRequest): Promise<unknown> {
    const binding = bindDestination(this.store, this.ledger, this.wallet.settings().network, request);
    request = { ...request, destination: binding.address };
    this.onDestination?.(binding);
    const existing = this.ledger.get(request.requestId);
    if (existing?.external) throw new AttoError('REQUEST_CONFLICT', 'This request ID belongs to a Market top-up. Resume it with market_topup using the original request ID.');
    if (existing) return this.resume(existing, request);
    await this.reconcile();
    let quote: Quote | undefined;
    if (request.unit === 'USD') {
      if (this.wallet.settings().network !== 'LIVE') throw new AttoError('USD_NETWORK', 'The metrics USD price applies only to the LIVE network.');
      if (this.store.get<{ version: string }>('market.terms')?.version !== marketTerms.version) {
        throw new AttoError('TERMS_REQUIRED', 'Read and acknowledge the market-data terms before sending a USD-denominated amount.', marketTerms);
      }
      quote = await retryNetwork(() => this.market.quoteUsd(request.amount, this.retry?.signal), this.retry);
    }
    const raw = quote?.amount.raw ?? amountRaw(request.amount, request.unit === 'USD' ? 'RAW' : request.unit);
    const destination = parseAddress(request.destination!).value;
    const deadline = Date.now() + 60_000;
    for (;;) {
      const releases = new Map<number, () => void>();
      let busy = false;
      let reserved = false;
      let retry = false;
      try {
        const snapshot = await this.store.withWalletLock(async () => {
          this.wallet.requireWrite();
          if (binding.network !== this.wallet.settings().network) throw new AttoError('NETWORK_MISMATCH', 'The payment belongs to another network.');
          const prior = this.ledger.get(request.requestId);
          if (prior) return { prior };
          if (quote && this.wallet.settings().network !== 'LIVE') throw new AttoError('USD_NETWORK', 'The metrics USD price applies only to the LIVE network.');
          if (quote && this.store.get<{ version: string }>('market.terms')?.version !== marketTerms.version) {
            throw new AttoError('TERMS_REQUIRED', 'Acknowledge the current market-data terms before sending a USD-denominated amount.');
          }
          this.ledger.assertCanReserve(raw);
          const pool = this.ledger.pool();
          const indexes = request.index === undefined ? pool.indexes : [request.index];
          if (this.wallet.mcp && indexes.some(index => !pool.indexes.includes(index))) {
            throw new AttoError('POOL_APPROVAL_REQUIRED', 'The source is outside the approved account pool.');
          }
          const addresses = indexes.map(index => {
            const address = this.wallet.addresses().find(address => address.index === index);
            if (!address) throw new AttoError('ADDRESS_NOT_DERIVED', 'Derive the source index or approve the account pool first.');
            return address;
          }).filter(address => address.address !== destination);
          if (!addresses.length) throw new AttoError('SELF_SEND', 'Choose a destination different from the source address.');
          const pending = new Set(this.ledger.pending().flatMap(record => this.indexes(record)));
          for (const address of addresses) {
            const release = this.store.tryAccountLocks([address.index]);
            if (!release) { busy = true; continue; }
            if (pending.has(address.index)) { reserved = true; release(); continue; }
            releases.set(address.index, release);
          }
          return { settings: this.wallet.settings(), pool, addresses: addresses.filter(address => releases.has(address.index)) };
        });
        if ('prior' in snapshot) return this.resume(snapshot.prior!, request);
        const reader = new NodeReader(snapshot.settings);
        const candidates: PoolAccount[] = [];
        for (const address of snapshot.addresses) {
          const account = await retryNetwork(() => reader.account(address.address, this.retry?.signal), this.retry);
          if (!account) continue;
          this.checkAccount(address, account, snapshot.settings);
          candidates.push({ address, account, workReady: this.work.isReady(account) });
        }
        let chosen: ReturnType<typeof planPayment>;
        try {
          if (request.index !== undefined && !candidates.length && !busy && !reserved) throw new AttoError('ACCOUNT_NOT_OPEN', 'Receive funds to open this account before sending.');
          chosen = planPayment(candidates, raw, request.index === undefined && snapshot.pool.consolidate);
        } catch (error) {
          if (busy && Date.now() < deadline) { retry = true; continue; }
          if (busy || reserved) throw new AttoError('POOL_BUSY', 'Eligible funds are busy or reserved by unfinished payments. Retry after those payments settle.');
          throw error;
        }
        let raced = false;
        const record = await this.store.withWalletLock(async () => {
          this.wallet.requireWrite();
          if (binding.network !== this.wallet.settings().network) throw new AttoError('NETWORK_MISMATCH', 'The payment belongs to another network.');
          const prior = this.ledger.get(request.requestId);
          if (prior) { raced = true; return prior; }
          if (!isDeepStrictEqual(snapshot.settings, this.wallet.settings()) || !isDeepStrictEqual(snapshot.pool, this.ledger.pool())) {
            throw new AttoError('POOL_CHANGED', 'Wallet configuration changed during account selection. Retry this request.');
          }
          return this.ledger.reserve({ id: request.requestId, index: chosen.source.address.index, destination, raw,
            sourceAddress: chosen.source.address.address, network: snapshot.settings.network,
            selection: request.index === undefined ? 'automatic' : 'explicit', plan: chosen.plan,
            metadata: request.metadata, destinationBinding: binding, quote, createdAt: Date.now() });
        });
        if (raced) {
          for (const release of releases.values()) release();
          releases.clear();
          return this.resume(record, request);
        }
        this.checkRequest(record, request);
        // Release accounts that were considered but are not part of this payment.
        for (const [index, release] of releases) if (!this.indexes(record).includes(index)) { release(); releases.delete(index); }
        if (this.indexes(record).some(index => !releases.has(index))) {
          for (const release of releases.values()) release();
          releases.clear();
          return this.resume(record, request);
        }
        return await this.execute(record);
      } finally {
        for (const release of releases.values()) release();
        if (retry) await delay(25);
      }
    }
  }

  private checkAccount(address: WalletAddress, account: AttoAccount, settings: WalletSettings): void {
    if (account.address.value !== address.address || account.network.name !== settings.network) {
      throw new AttoError('INVALID_NODE_RESPONSE', 'The node account does not match the requested source and network.');
    }
  }

  private async resume(record: SendRecord, request: SendRequest): Promise<unknown> {
    if (record.external) throw new AttoError('REQUEST_CONFLICT', 'This request ID belongs to a Market top-up. Resume it with market_topup using the original request ID.');
    this.checkRequest(record, request);
    if (record.status === 'published') return record.result;
    if (record.status === 'failed') throw new AttoError('REQUEST_FAILED', 'This payment failed. Inspect its journal before creating a new payment request.');
    return this.store.withAccountLocks(this.indexes(record), async () => {
      await this.reconcileRecord(this.ledger.get(record.id)!);
      const current = this.ledger.get(record.id)!;
      if (current.status === 'published') return current.result;
      if (current.status === 'failed') throw new AttoError('REQUEST_FAILED', 'The payment was excluded from the account chain. Inspect its journal before creating a new request.');
      if (current.hash || !current.plan || current.plan.steps.some(step => step.status === 'signed' || step.status === 'unknown')) this.uncertain(current);
      return this.execute(current);
    });
  }

  private uncertain(record: SendRecord): never {
    throw new AttoError('PUBLICATION_UNCERTAIN', 'Publication is unresolved. Reuse this request ID to reconcile the existing payment.',
      { requestId: record.id, hash: record.hash, steps: record.plan?.steps.map(({ id, hash, status }) => ({ id, hash, status })) });
  }

  private async execute(record: SendRecord): Promise<unknown> {
    let seed: AttoSeed | undefined;
    try {
      await this.store.withWalletLock(async () => this.requireApproved(record));
      seed = await this.wallet.seed();
      // Internal-transfer exemptions require ownership derived from the key,
      // never metadata supplied by a caller or an address string alone.
      for (const index of this.indexes(record)) {
        const signer = await derivedSigner(seed, index);
        const expected = index === record.index ? record.sourceAddress : record.plan?.steps.find(step => step.index === index)?.sourceAddress;
        if (expected && signer.address.value !== expected) throw new AttoError('WALLET_MISMATCH', 'A planned source does not match its wallet key.');
      }
      for (const step of record.plan?.steps ?? []) {
        if (step.status === 'published') continue;
        if (step.hash) this.uncertain(record);
        await this.executeStep(record, step, seed);
      }
      const current = this.ledger.get(record.id)!;
      const transaction = await this.publish(current, current.index, seed, undefined);
      const result = this.paymentResult(this.ledger.get(record.id)!, transaction);
      await this.store.withWalletLock(async () => this.ledger.complete(record.id, result, Number(transaction.block.timestamp.toEpochMilliseconds())));
      return result;
    } catch (error) {
      const current = this.ledger.get(record.id)!;
      const recorded = Boolean(current.hash || current.plan?.steps.some(step => step.hash));
      await this.store.withWalletLock(async () => {
        if (recorded) this.ledger.uncertain(record.id);
        else this.ledger.fail(record.id);
      });
      if (current.hash || current.plan?.steps.some(step => step.status === 'signed' || step.status === 'unknown')) {
        if (this.retry && error instanceof AttoError) {
          throw new AttoError(error.code, `${error.message} Publication is unresolved; check the journal using this request ID.`,
            { ...error.details as object, requestId: record.id, hash: current.hash, publicationUncertain: true });
        }
        this.uncertain(this.ledger.get(record.id)!);
      }
      throw error;
    } finally { seed?.value.fill(0); }
  }

  private async executeStep(record: SendRecord, step: ConsolidationStep, seed: AttoSeed): Promise<void> {
    try {
      const transaction = await this.publish(record, step.index, seed, step);
      await this.store.withWalletLock(async () => this.ledger.stepComplete(record.id, step.id, this.result(transaction), Number(transaction.block.timestamp.toEpochMilliseconds())));
    } catch (error) {
      await this.store.withWalletLock(async () => {
        if (this.ledger.get(record.id)!.plan!.steps.find(value => value.id === step.id)!.hash) this.ledger.stepUncertain(record.id, step.id);
      });
      throw error;
    }
  }

  private async publish(record: SendRecord, index: number, seed: AttoSeed, step?: ConsolidationStep): Promise<AttoTransaction> {
    const settings = this.wallet.settings();
    let sendHash: string | undefined;
    if (step?.kind === 'receive') {
      sendHash = this.ledger.get(record.id)!.plan!.steps.find(value => value.id === step.sourceStepId)!.hash;
      if (!sendHash) throw new AttoError('SEND_STATE', 'The consolidation transfer has not been published.');
    }
    const execution = await signingWallet(seed, index, settings, async block => {
      await this.store.withWalletLock(async () => {
        this.requireApproved(record);
        const source = step?.sourceAddress ?? record.sourceAddress;
        if (source && block.address.value !== source) throw new AttoError('TRANSACTION_MISMATCH', 'The transaction source differs from the payment plan.');
        if (step?.kind === 'receive') {
          if (!(block instanceof AttoReceiveBlock || block instanceof AttoOpenBlock) || block.sendHash.toString() !== sendHash) {
            throw new AttoError('TRANSACTION_MISMATCH', 'The receive differs from the planned consolidation transfer.');
          }
        } else if (!(block instanceof AttoSendBlock) || block.amount.toString() !== (step?.raw ?? record.raw)
          || block.receiverAddress.value !== (step?.destination ?? record.destination)) {
          throw new AttoError('TRANSACTION_MISMATCH', 'The constructed transaction differs from the payment plan.');
        }
        if (step) this.ledger.stepSigned(record.id, step.id, block.hash.toString(), block.toJson());
        else this.ledger.signed(record.id, block.hash.toString(), block.toJson());
      });
    }, this.work.worker(), this.retry);
    try {
      if (step?.kind === 'receive') {
        const receivable = await this.pendingReceivable(step.destination, sendHash!);
        if (!receivable || receivable.amount.toString() !== step.raw || receivable.network.name !== settings.network) {
          throw new AttoError('RECEIVABLE_NOT_PENDING', 'The consolidation transfer is not available to receive yet. Resume this payment with the same request ID.');
        }
        const transaction = await execution.wallet.receive(receivable, parseAddress(settings.representative), null);
        this.work.prepareConfirmed(transaction.block);
        return transaction;
      }
      const transaction = await execution.wallet.sendByIndex(toAttoIndex(index), parseAddress(step?.destination ?? record.destination),
        AttoAmount.from(AttoUnit.RAW, step?.raw ?? record.raw), null);
      this.work.prepareConfirmed(transaction.block);
      return transaction;
    } finally { execution.wallet.close(); }
  }

  private async pendingReceivable(address: string, hash: string): Promise<AttoReceivable | undefined> {
    const done = new AbortController();
    let found: AttoReceivable | undefined;
    await this.reader().stream({ event: 'receivable', addresses: [address], minAmountRaw: '1' }, model => {
      const candidate = model as AttoReceivable;
      if (candidate.hash.toString() === hash && candidate.receiverAddress.value === address) { found = candidate; done.abort(); }
    }, AbortSignal.any([done.signal, AbortSignal.timeout(2000)]));
    return found;
  }

  async reconcile(candidateIndexes?: number[]): Promise<void> {
    await this.reconcileMarketIntents(candidateIndexes);
    for (const record of this.ledger.pending()) {
      if (record.external) continue;
      const release = this.store.tryAccountLocks(this.indexes(record));
      if (!release) continue;
      try { await this.reconcileRecord(this.ledger.get(record.id)!); }
      finally { release(); }
    }
  }

  private async reconcileRecord(record: SendRecord): Promise<void> {
    if (record.external) return;
    if (record.status === 'published' || record.status === 'failed') return;
    for (const step of record.plan?.steps ?? []) {
      if (!step.hash || step.status === 'published') continue;
      const outcome = await reconcileBlock(this.reader(), step);
      if (outcome.status === 'unresolved') return;
      await this.store.withWalletLock(async () => {
        if (outcome.status === 'rejected') this.ledger.stepReject(record.id, step.id);
        else this.ledger.stepComplete(record.id, step.id, this.result(outcome.transaction), Number(outcome.transaction.block.timestamp.toEpochMilliseconds()));
      });
      if (outcome.status === 'rejected') return;
      this.work.prepareConfirmed(outcome.transaction.block);
    }
    if (!record.hash) {
      if (!record.plan) await this.store.withWalletLock(async () => this.ledger.fail(record.id));
      return;
    }
    const outcome = await reconcileSend(this.reader(), record);
    await this.store.withWalletLock(async () => {
      if (outcome.status === 'published') this.ledger.complete(record.id, this.paymentResult(this.ledger.get(record.id)!, outcome.transaction), Number(outcome.transaction.block.timestamp.toEpochMilliseconds()));
      else if (outcome.status === 'rejected') this.ledger.reject(record.id);
    });
    if (outcome.status === 'published') this.work.prepareConfirmed(outcome.transaction.block);
  }

  async poolStatus() {
    const pool = this.ledger.pool();
    const pending = new Set(this.ledger.pending().flatMap(record => this.indexes(record)));
    const accounts = await Promise.all(pool.indexes.map(async index => {
      const address = this.wallet.addresses().find(address => address.index === index);
      const account = address ? await this.reader().account(address.address) : null;
      if (address && account) this.checkAccount(address, account, this.wallet.settings());
      const release = this.store.tryAccountLocks([index]);
      const busy = pending.has(index) || !release;
      release?.();
      return { index, address: address?.address ?? null, opened: Boolean(account), balance: amountOutput(account?.balance.toString() ?? '0'),
        workReady: Boolean(account && this.work.isReady(account)), busy };
    }));
    return { pool, accounts, total: amountOutput(accounts.reduce((sum, account) => sum + BigInt(account.balance.raw), 0n).toString()),
      available: amountOutput(accounts.reduce((sum, account) => sum + (account.busy ? 0n : BigInt(account.balance.raw)), 0n).toString()) };
  }
}

function marketPaymentIdentifier(connection: MarketConnection, requestId: string): string {
  return createHash('sha256').update(JSON.stringify([
    connection.apiUrl, connection.audience, connection.accountId, connection.agentId, connection.identityId,
    connection.walletFingerprint, requestId,
  ]), 'utf8').digest('base64url');
}
