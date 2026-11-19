import { bindDestination, type DestinationBinding } from './destination.js';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  AttoAccount, AttoAmount, AttoBlock, AttoOpenBlock, AttoReceivable, AttoReceiveBlock,
  AttoSeed, AttoSendBlock, AttoSignature, AttoTransaction, AttoUnit, toAttoIndex,
} from '@attocash/commons-core';
import { amountOutput, amountRaw } from '../domain/amount.js';
import { AttoError } from '../domain/errors.js';
import { NodeReader, parseAddress, publicModel } from '../network/reader.js';
import { retryNetwork, type SendRetry } from '../network/retry.js';
import type { MarketData } from '../pricing/market.js';
import { marketTerms } from '../pricing/terms.js';
import type { StateStore } from '../storage/state.js';
import { derivedSigner, signingWallet, publishTransaction } from '../wallet/signing.js';
import type { SendRequest, WalletAddress, WalletSettings } from '../wallet/types.js';
import type { WalletWork } from '../wallet/work.js';
import { SpendLedger, type ConsolidationStep, type SendRecord } from './ledger.js';
import { planPayment, type PoolAccount } from './pool.js';
import { reconcileBlock, reconcileSend } from './reconcile.js';
import { wireTransaction } from './atto-x402.js';
import { parseRelayOffer, relayPaymentPayload, relayProofFromHeader, validateRelayChallenge, validateRelayProof, type RelayRequest } from '../marketplace/relay.js';

interface PaymentWallet {
  settings(): WalletSettings;
  addresses(): WalletAddress[];
  seed(): Promise<AttoSeed>;
  requireWrite(): void;
  requireAccountsAvailable?(indexes: number[]): void;
  mcp: boolean;
}
type Quote = Awaited<ReturnType<MarketData['quoteUsd']>>;

/** Owns payment selection, reservations, publication and recovery as one workflow. */
export class Payments {
  constructor(private readonly store: StateStore, private readonly ledger: SpendLedger,
    private readonly wallet: PaymentWallet, private readonly market: MarketData, private readonly work: WalletWork,
    private readonly retry?: SendRetry, private readonly onDestination?: (binding: DestinationBinding) => void,
) {}

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
    this.wallet.requireAccountsAvailable?.(this.indexes(record));
    if (requireReservation) this.ledger.assertReservationAllowed(record.id);
    if (record.network && record.network !== this.wallet.settings().network) throw new AttoError('NETWORK_MISMATCH', 'The payment belongs to a different network.');
    const pool = this.ledger.pool();
    if ((this.wallet.mcp || record.external?.kind === 'marketplace-topup' || record.external?.kind === 'marketplace-intent' || record.selection === 'automatic' || record.plan?.steps.length)
      && this.indexes(record).some(index => !pool.indexes.includes(index))) {
      throw new AttoError('POOL_APPROVAL_REQUIRED', 'The payment uses an account outside the approved pool. Review the pool in a local terminal.');
    }
    if (record.plan?.steps.length && !pool.consolidate) throw new AttoError('CONSOLIDATION_REQUIRED', 'Approve consolidation before continuing this payment.');
  }

  async send(request: SendRequest): Promise<unknown> {
    const binding = bindDestination(this.store, this.ledger, this.wallet.settings().network, request);
    request = { ...request, destination: binding.address };
    this.onDestination?.(binding);
    const existing = this.ledger.get(request.requestId);
    if (existing?.external || existing?.relay) throw new AttoError('REQUEST_CONFLICT', 'This request ID belongs to a different saved payment and cannot authorize a new send.');
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
          this.wallet.requireAccountsAvailable?.(chosen.plan.indexes);
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
    if (record.external || record.relay) throw new AttoError('REQUEST_CONFLICT', 'This request ID belongs to a different saved payment and cannot authorize a new send.');
    this.checkRequest(record, request);
    if (record.status === 'published') return record.result;
    if (record.status === 'failed') throw new AttoError('REQUEST_FAILED', 'This payment failed. Inspect its journal before creating a new payment request.');
    return this.store.withAccountLocks(this.indexes(record), async () => {
      await this.reconcileRecord(this.ledger.get(record.id)!);
      const current = this.ledger.get(record.id)!;
      if (current.status === 'published') return current.result;
      if (current.status === 'failed') throw new AttoError('REQUEST_FAILED', 'The payment was excluded from the account chain. Inspect its journal before creating a new request.');
      if (!current.plan && !current.hash) this.uncertain(current);
      return this.execute(current);
    });
  }

  private uncertain(record: SendRecord): never {
    const missing = [record, ...(record.plan?.steps ?? [])].some(value => value.hash && value.status !== 'published' && !value.transactionJson);
    throw new AttoError('PUBLICATION_UNCERTAIN', missing
      ? 'Publication is unresolved. This historical journal lacks the original signed transaction and work, so exact replay is unavailable. Reuse this request ID for canonical reconciliation; preserve the journal.'
      : 'Publication is unresolved. Reuse this request ID to reconcile or replay the retained payment.',
      { requestId: record.id, hash: record.hash, steps: record.plan?.steps.map(({ id, hash, status }) => ({ id, hash, status })) });
  }

  private async execute(record: SendRecord): Promise<unknown> {
    let seed: AttoSeed | undefined;
    try {
      await this.store.withWalletLock(async () => this.requireApproved(record));
      const prepareSeed = async () => {
        if (seed) return seed;
        seed = await this.wallet.seed();
        // Derive only for fresh preparation; replay never needs keys or new work.
        for (const index of this.indexes(record)) {
          const signer = await derivedSigner(seed, index);
          const expected = index === record.index ? record.sourceAddress : record.plan?.steps.find(step => step.index === index)?.sourceAddress;
          if (expected && signer.address.value !== expected) throw new AttoError('WALLET_MISMATCH', 'A planned source does not match its wallet key.');
        }
        return seed;
      };
      for (const planned of record.plan?.steps ?? []) {
        const current = this.ledger.get(record.id)!;
        const step = current.plan!.steps.find(value => value.id === planned.id)!;
        if (step.status === 'published') continue;
        await this.executeStep(current, step, step.hash ? undefined : await prepareSeed());
      }
      const current = this.ledger.get(record.id)!;
      const transaction = current.hash ? await this.replay(current) : await this.publish(current, current.index, await prepareSeed());
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

  private async executeStep(record: SendRecord, step: ConsolidationStep, seed?: AttoSeed): Promise<void> {
    try {
      const transaction = step.hash ? await this.replay(record, step) : await this.publish(record, step.index, seed!, step);
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
        this.requireApproved(this.ledger.get(record.id)!);
        this.checkBlock(record, block, step);
      });
    }, this.work.worker(), this.retry, async transaction => {
      if (!await transaction.isValid()) throw new AttoError('INVALID_TRANSACTION', 'The signed transaction is invalid.');
      await this.store.withWalletLock(async () => {
        const current = this.ledger.get(record.id)!;
        this.requireApproved(current);
        const currentStep = step && current.plan!.steps.find(value => value.id === step.id)!;
        this.checkBlock(current, transaction.block, currentStep);
        const args = [transaction.hash.toString(), transaction.block.toJson(), transaction.toJson(), this.candidateBinding(current, currentStep)] as const;
        if (currentStep) this.ledger.stepSigned(record.id, currentStep.id, ...args);
        else this.ledger.signed(record.id, ...args);
      });
    });
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

  private candidateBinding(record: SendRecord, step?: ConsolidationStep): string {
    // Bind retained bytes to the original request, quote and already-selected plan.
    return createHash('sha256').update(JSON.stringify({ id: record.id, index: record.index,
      sourceAddress: record.sourceAddress, network: record.network, destination: record.destination, raw: record.raw,
      createdAt: record.createdAt, metadata: record.metadata, quote: record.quote,
      destinationBinding: record.destinationBinding, selection: record.selection,
      plan: record.plan && { indexes: record.plan.indexes, steps: record.plan.steps.map(({ id, kind, index, sourceAddress, destination, raw, sourceStepId }) =>
        ({ id, kind, index, sourceAddress, destination, raw, sourceStepId })) },
      stepId: step?.id, sourceHash: step?.kind === 'receive' ? record.plan!.steps.find(value => value.id === step.sourceStepId)?.hash : undefined,
      ...(record.relay ? { relay: { ...record.relay, paymentSignature: undefined } } : {}),
    })).digest('hex');
  }

  private checkBlock(record: SendRecord, block: AttoBlock, step?: ConsolidationStep): void {
    const source = step?.sourceAddress ?? record.sourceAddress;
    const index = step?.index ?? record.index;
    if (!block.isValid() || block.network.name !== record.network || !source || block.address.value !== source
      || this.wallet.addresses().find(value => value.index === index)?.address !== source) {
      throw new AttoError('TRANSACTION_MISMATCH', 'The transaction source or network differs from the payment plan.');
    }
    if (step && record.plan!.steps.slice(0, record.plan!.steps.findIndex(value => value.id === step.id)).some(value => value.status !== 'published')) {
      throw new AttoError('SEND_STATE', 'Complete the previous consolidation steps first.');
    }
    if (step?.kind === 'receive') {
      const send = record.plan!.steps.find(value => value.id === step.sourceStepId);
      if (!send?.hash || send.status !== 'published' || send.raw !== step.raw
        || !(block instanceof AttoReceiveBlock || block instanceof AttoOpenBlock) || block.sendHash.toString() !== send.hash) {
        throw new AttoError('TRANSACTION_MISMATCH', 'The receive differs from the planned consolidation transfer.');
      }
    } else if (!(block instanceof AttoSendBlock) || block.amount.toString() !== (step?.raw ?? record.raw)
      || block.receiverAddress.value !== (step?.destination ?? record.destination)) {
      throw new AttoError('TRANSACTION_MISMATCH', 'The transaction differs from the payment plan.');
    }
  }

  private async retainedTransaction(record: SendRecord, step?: ConsolidationStep): Promise<AttoTransaction> {
    const retained = step ?? record;
    if (!retained.transactionJson) this.uncertain(record);
    let transaction: AttoTransaction;
    try {
      transaction = AttoTransaction.fromJson(retained.transactionJson);
      if (!await transaction.isValid() || transaction.toJson() !== retained.transactionJson
        || transaction.hash.toString() !== retained.hash || transaction.block.toJson() !== retained.blockJson
        || retained.candidateBinding !== this.candidateBinding(record, step)) throw new Error();
      this.checkBlock(record, transaction.block, step);
    } catch { throw new AttoError('INVALID_STATE', 'The retained native candidate is invalid or differs from its original payment. Preserve the journal; no replacement was signed.'); }
    return transaction;
  }

  private async replay(record: SendRecord, step?: ConsolidationStep): Promise<AttoTransaction> {
    const retained = step ?? record;
    const transaction = await this.retainedTransaction(record, step);
    await publishTransaction(transaction, this.wallet.settings(), async () => {
      await this.store.withWalletLock(async () => {
        const current = this.ledger.get(record.id)!;
        this.requireApproved(current);
        const currentRetained = step ? current.plan!.steps.find(value => value.id === step.id)! : current;
        if (currentRetained.transactionJson !== retained.transactionJson || currentRetained.candidateBinding !== retained.candidateBinding
          || this.candidateBinding(current, step ? currentRetained as ConsolidationStep : undefined) !== retained.candidateBinding) {
          throw new AttoError('INVALID_STATE', 'The retained payment changed before publication.');
        }
        this.checkBlock(current, transaction.block, step ? currentRetained as ConsolidationStep : undefined);
      });
    }, this.retry);
    this.work.prepareConfirmed(transaction.block);
    return transaction;
  }

  async prepareRelay(input: Record<string, unknown>): Promise<unknown> {
    const parsed = z.strictObject({ requestId: z.string().uuid(), origin: z.string(), audience: z.string(), terms: z.record(z.string(), z.unknown()),
      paymentRequired: z.string(), index: z.number().int().min(0).max(0x7fff_ffff) }).parse(input);
    const request = parsed as unknown as RelayRequest & { index: number };
    const prior = this.ledger.get(request.requestId);
    const offer = parseRelayOffer(request, Boolean(prior?.hash));
    if (offer.terms.asset !== 'ATTO' || offer.terms.network !== `atto:${this.wallet.settings().network.toLowerCase()}`
      || this.wallet.addresses().find(value => value.index === request.index)?.address !== offer.terms.senderAddress
      || parseAddress(offer.terms.recipientAddress).value !== offer.terms.recipientAddress
      || offer.terms.senderAddress === offer.terms.recipientAddress) throw new AttoError('NETWORK_MISMATCH', 'The relay sender, destination or network differs from the selected wallet.');
    // Market may have confirmed an older relay while this wallet process was offline.
    // Canonical observation releases only completed/competing candidates; it never publishes.
    await this.reconcile();
    return this.store.withAccountLocks([request.index], async () => {
      const record = await this.store.withWalletLock(async () => {
        this.wallet.requireWrite();
        const existing = this.ledger.get(request.requestId);
        if (existing && !existing.relay) throw new AttoError('REQUEST_CONFLICT', 'This request ID belongs to another native operation.');
        if (!existing) this.ledger.assertAccountAvailable(request.index);
        if (existing?.relay && existing.relay.paymentRequired !== request.paymentRequired) this.ledger.refreshUnusedRelay(existing.id, { ...request, version: 1 });
        const saved = this.ledger.reserve({ id: request.requestId, index: request.index, destination: offer.terms.recipientAddress,
          raw: offer.terms.amountAtomic, sourceAddress: offer.terms.senderAddress, network: this.wallet.settings().network,
          selection: 'explicit', createdAt: existing?.createdAt ?? Date.now(), relay: { ...request, version: 1 } });
        this.requireApproved(saved);
        return saved;
      });
      if (record.status === 'failed') throw new AttoError('REQUEST_FAILED', 'Recover this original rejected native payment; no replacement was prepared.');
      if (!record.hash) {
        const seed = await this.wallet.seed();
        let wallet: Awaited<ReturnType<typeof signingWallet>>['wallet'] | undefined;
        try {
          const execution = await signingWallet(seed, request.index, this.wallet.settings(), async block => {
            await this.store.withWalletLock(async () => {
              const current = this.ledger.get(record.id)!;
              this.requireApproved(current); this.checkBlock(current, block);
              if (!(block instanceof AttoSendBlock) || BigInt(block.height.toString()) <= BigInt(offer.terms.baselineHeight)
                || (BigInt(block.height.toString()) === BigInt(offer.terms.baselineHeight) + 1n
                  && offer.terms.baselineFrontier !== null && block instanceof AttoSendBlock
                  && block.previous.toString().toLowerCase() !== offer.terms.baselineFrontier.toLowerCase())) {
                throw new AttoError('TRANSACTION_MISMATCH', 'The candidate predates the frozen sender baseline.');
              }
            });
          }, this.work.worker(), this.retry);
          wallet = execution.wallet;
          const transaction = await wallet.prepareSendByIndex(toAttoIndex(request.index), parseAddress(record.destination), AttoAmount.from(AttoUnit.RAW, record.raw), null);
          await this.store.withWalletLock(async () => {
            const current = this.ledger.get(record.id)!;
            this.requireApproved(current); this.checkBlock(current, transaction.block);
            parseRelayOffer(current.relay!);
            this.ledger.signed(record.id, transaction.hash.toString(), transaction.block.toJson(), transaction.toJson(), this.candidateBinding(current));
          });
        } finally { wallet?.close(); seed.value.fill(0); }
      }
      return this.relayResult(this.ledger.get(record.id)!);
    });
  }

  private async relayResult(record: SendRecord): Promise<unknown> {
    if (!record.relay) throw new AttoError('REQUEST_CONFLICT', 'This request belongs to another wallet operation.');
    const transaction = record.hash ? await this.retainedTransaction(record) : undefined;
    if (record.relay.paymentSignature && transaction) {
      const offer = parseRelayOffer(record.relay, true), proof = relayProofFromHeader(record.relay.paymentSignature);
      validateRelayProof(offer, transaction.hash.toString(), record.relay.audience, proof, true);
      if (relayPaymentPayload(offer, record.id, { transaction: wireTransaction(transaction) }, proof) !== record.relay.paymentSignature
        || !await AttoSignature.Companion.parse(proof.signature).isValidMessage(transaction.address.publicKey, Int8Array.from(Buffer.from(proof.message)))) {
        throw new AttoError('INVALID_STATE', 'The retained relay payload differs from its original authorization.');
      }
    }
    return { requestId: record.id, network: record.relay.terms.network, sourceAddress: record.sourceAddress,
      destination: record.destination, amountAtomic: record.raw, hash: record.hash ?? null, state: record.status,
      paymentRequired: record.relay.paymentRequired, paymentSignature: record.relay.paymentSignature ?? null };
  }

  async relayStatus(input: Record<string, unknown>): Promise<unknown> {
    const { requestId, index } = z.strictObject({ requestId: z.string().uuid(), index: z.number().int().min(0).max(0x7fff_ffff).optional() }).parse(input), record = this.ledger.get(requestId);
    if (!record) return { requestId, state: 'NOT_FOUND' };
    if (index !== undefined && index !== record.index) throw new AttoError('REQUEST_CONFLICT', 'The original relay belongs to another selected wallet account.');
    return this.store.withAccountLocks([record.index], async () => {
      if (!record.relay) throw new AttoError('REQUEST_CONFLICT', 'This request ID belongs to another native operation.');
      await this.reconcileRecord(record);
      return this.relayResult(this.ledger.get(requestId)!);
    });
  }

  async authorizeRelay(input: Record<string, unknown>): Promise<unknown> {
    const { requestId, index, proof: suppliedProof } = z.strictObject({ requestId: z.string().uuid(), index: z.number().int().min(0).max(0x7fff_ffff).optional(), proof: z.strictObject({ challengeId: z.string().uuid(), message: z.string(), signature: z.string().optional() }) }).parse(input);
    const record = this.ledger.get(requestId);
    if (!record?.relay || !record.hash) throw new AttoError('REQUEST_CONFLICT', 'Prepare this original relay payment first.');
    if (index !== undefined && index !== record.index) throw new AttoError('REQUEST_CONFLICT', 'The original relay belongs to another selected wallet account.');
    return this.store.withAccountLocks([record.index], async () => {
      if (record.relay!.paymentSignature) return this.relayResult(record);
      const transaction = await this.retainedTransaction(record), offer = parseRelayOffer(record.relay!);
      // Validate the complete typed frame before key access. This authorizes no general message signing.
      validateRelayChallenge(offer.terms, record.hash!, record.relay!.audience, suppliedProof);
      let signature = suppliedProof.signature;
      if (!signature) {
        await this.store.withWalletLock(async () => this.requireApproved(this.ledger.get(record.id)!));
        const seed = await this.wallet.seed();
        try {
          const signer = await derivedSigner(seed, record.index);
          if (signer.address.value !== record.sourceAddress) throw new AttoError('WALLET_MISMATCH', 'The payment proof signer differs from its retained sender.');
          signature = (await signer.signMessage(Int8Array.from(Buffer.from(suppliedProof.message)))).toString();
        } finally { seed.value.fill(0); }
      }
      const proof = { ...suppliedProof, signature };
      validateRelayProof(offer, record.hash!, record.relay!.audience, proof);
      if (!await AttoSignature.Companion.parse(proof.signature).isValidMessage(transaction.address.publicKey, Int8Array.from(Buffer.from(proof.message)))) {
        throw new AttoError('PAYMENT_PROTOCOL', 'Invalid wallet proof for this payment.');
      }
      const paymentSignature = relayPaymentPayload(offer, record.id, { transaction: wireTransaction(transaction) }, proof);
      await this.store.withWalletLock(async () => { this.requireApproved(this.ledger.get(record.id)!); this.ledger.authorizeRelay(record.id, paymentSignature); });
      return this.relayResult(this.ledger.get(record.id)!);
    });
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
    if (record.relay && !record.hash) return;
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
