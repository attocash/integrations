import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AttoAmount, AttoBlock, AttoSeed, AttoSendBlock, AttoSignature, AttoTransaction, AttoUnit, toAttoIndex } from '@attocash/commons-core';
import { parseAddress } from '../domain/address.js';
import { AttoError } from '../domain/errors.js';
import { parseDurableRelayRequest, parseRelayOffer, relayPaymentPayload, validateRetainedRelayPayload, type WalletRelayRequest } from '../marketplace/relay.js';
import { parseJsonObject } from '../marketplace/strict-json.js';
import type { SendRetry } from '../network/retry.js';
import type { StateStore } from '../storage/state.js';
import { signingWallet } from '../wallet/signing.js';
import type { WalletAddress, WalletSettings } from '../wallet/types.js';
import type { WalletWork } from '../wallet/work.js';
import { wireTransaction } from './atto-x402.js';
import type { SpendLedger, SendRecord } from './ledger.js';

export interface RelayPaymentContext {
  store: StateStore;
  ledger: SpendLedger;
  wallet: {
    settings(): WalletSettings;
    addresses(): WalletAddress[];
    seed(): Promise<AttoSeed>;
    requireWrite(): void;
    requireAccountsAvailable?(indexes: number[]): void;
    mcp: boolean;
  };
  work: WalletWork;
  retry?: SendRetry;
  requireApproved(record: SendRecord, requireReservation?: boolean): void;
  checkBlock(record: SendRecord, block: AttoBlock): void;
  candidateBinding(record: SendRecord): string;
  retainedTransaction(record: SendRecord): Promise<AttoTransaction>;
  reconcile(): Promise<void>;
  reconcileRecord(record: SendRecord): Promise<void>;
}

const bindingSchema = z.strictObject({
  requestId: z.string().uuid(),
  origin: z.string(),
  audience: z.string(),
  terms: z.record(z.string(), z.unknown()),
  index: z.number().int().min(0).max(0x7fff_ffff),
});
const prepareRelaySchema = z.union([
  bindingSchema.extend({ paymentRequired: z.string() }),
  bindingSchema.extend({ mode: z.literal('DURABLE_NATIVE') }),
]);
const relayStatusSchema = z.strictObject({
  requestId: z.string().uuid(),
  index: z.number().int().min(0).max(0x7fff_ffff).optional(),
});
const durableCheckSchema = z.strictObject({
  requestId: z.string().uuid(),
  index: z.number().int().min(0).max(0x7fff_ffff),
  transactionHash: z.string().regex(/^[a-fA-F0-9]{64}$/),
});

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new AttoError('INVALID_INPUT', 'Invalid Marketplace relay payment input.');
  return parsed.data;
}

/** Owns Marketplace noncustodial relayed x402 and durable-native payment signing and recovery. */
export class RelayPayments {
  constructor(private readonly ctx: RelayPaymentContext) {}

  async prepare(input: Record<string, unknown>): Promise<unknown> {
    const parsed = parseInput(prepareRelaySchema, input);
    const request = parsed as unknown as WalletRelayRequest & { index: number };
    const prior = this.ctx.ledger.get(request.requestId);
    const offer = request.mode === undefined ? parseRelayOffer(request, Boolean(prior?.hash)) : undefined;
    const terms = request.mode === 'DURABLE_NATIVE' ? parseDurableRelayRequest(request) : offer!.terms;
    if (terms.asset !== 'ATTO' || terms.network !== `atto:${this.ctx.wallet.settings().network.toLowerCase()}`
      || this.ctx.wallet.addresses().find(value => value.index === request.index)?.address !== terms.senderAddress
      || parseAddress(terms.recipientAddress).value !== terms.recipientAddress
      || terms.senderAddress === terms.recipientAddress) {
      throw new AttoError('NETWORK_MISMATCH', 'The relay sender, destination or network differs from the selected wallet.');
    }
    // Market may have confirmed an older relay while this wallet process was offline.
    // Canonical observation releases only completed/competing candidates; it never publishes.
    await this.ctx.reconcile();
    return this.ctx.store.withAccountLocks([request.index], async () => {
      const record = await this.ctx.store.withWalletLock(async () => {
        this.ctx.wallet.requireWrite();
        const existing = this.ctx.ledger.get(request.requestId);
        if (existing && (!existing.relay || existing.relay.mode !== request.mode)) {
          throw new AttoError('REQUEST_CONFLICT', 'This request ID belongs to another wallet operation or relay mode.');
        }
        if (!existing) {
          // Validate pool, account fencing, and availability before persisting a reservation.
          this.ctx.ledger.assertAccountAvailable(request.index);
          this.ctx.wallet.requireAccountsAvailable?.([request.index]);
          if (this.ctx.wallet.mcp && !this.ctx.ledger.pool().indexes.includes(request.index)) {
            throw new AttoError('POOL_APPROVAL_REQUIRED', 'The payment uses an account outside the approved pool. Review the pool in a local terminal.');
          }
        }
        const saved = this.ctx.ledger.reserveRelay({
          id: request.requestId, index: request.index, destination: terms.recipientAddress,
          raw: terms.amountAtomic, sourceAddress: terms.senderAddress, network: this.ctx.wallet.settings().network,
          selection: 'explicit', createdAt: existing?.createdAt ?? Date.now(), relay: { ...request, version: 1 },
        });
        this.ctx.requireApproved(saved, saved.status !== 'published');
        return saved;
      });
      if (record.status === 'failed') throw new AttoError('REQUEST_FAILED', 'Recover this original rejected native payment; no replacement was prepared.');
      if (!record.hash) {
        const seed = await this.ctx.wallet.seed();
        let wallet: Awaited<ReturnType<typeof signingWallet>>['wallet'] | undefined;
        try {
          const execution = await signingWallet(seed, request.index, this.ctx.wallet.settings(), async block => {
            await this.ctx.store.withWalletLock(async () => {
              const current = this.ctx.ledger.get(record.id)!;
              this.ctx.requireApproved(current);
              this.ctx.checkBlock(current, block);
              if (!(block instanceof AttoSendBlock) || BigInt(block.height.toString()) <= BigInt(terms.baselineHeight)
                || (BigInt(block.height.toString()) === BigInt(terms.baselineHeight) + 1n
                  && terms.baselineFrontier !== null
                  && block.previous.toString().toLowerCase() !== terms.baselineFrontier.toLowerCase())) {
                throw new AttoError('TRANSACTION_MISMATCH', 'The candidate predates the frozen sender baseline.');
              }
            });
          }, this.ctx.work.worker(), this.ctx.retry);
          wallet = execution.wallet;
          const transaction = await wallet.prepareSendByIndex(
            toAttoIndex(request.index), parseAddress(record.destination), AttoAmount.from(AttoUnit.RAW, record.raw), null,
          );
          await this.ctx.store.withWalletLock(async () => {
            const current = this.ctx.ledger.get(record.id)!;
            this.ctx.requireApproved(current);
            this.ctx.checkBlock(current, transaction.block);
            const payload = { transaction: wireTransaction(transaction) };
            const authorization = offer
              ? { paymentSignature: relayPaymentPayload(offer, record.id, payload) }
              : { nativePayloadJson: JSON.stringify(payload) };
            this.ctx.ledger.signed(
              record.id, transaction.hash.toString(), transaction.block.toJson(),
              transaction.toJson(), this.ctx.candidateBinding(current), authorization,
            );
          });
        } finally { wallet?.close(); seed.value.fill(0); }
      } else if (offer && !record.relay!.paymentSignature) {
        // Complete a pre-upgrade prepare using the original signed transaction.
        const transaction = await this.ctx.retainedTransaction(record);
        const header = relayPaymentPayload(offer, record.id, { transaction: wireTransaction(transaction) });
        await this.ctx.store.withWalletLock(async () => {
          const current = this.ctx.ledger.get(record.id)!;
          this.ctx.requireApproved(current, current.status !== 'published');
          this.ctx.ledger.authorizeRelay(record.id, header);
        });
      }
      return this.result(this.ctx.ledger.get(record.id)!);
    });
  }

  async status(input: Record<string, unknown>): Promise<unknown> {
    const { requestId, index } = parseInput(relayStatusSchema, input);
    const record = this.ctx.ledger.get(requestId);
    if (!record) return { requestId, state: 'NOT_FOUND' };
    if (index !== undefined && index !== record.index) {
      throw new AttoError('REQUEST_CONFLICT', 'The original relay belongs to another selected wallet account.');
    }
    return this.ctx.store.withAccountLocks([record.index], async () => {
      const current = this.ctx.ledger.get(requestId)!;
      if (!current.relay) throw new AttoError('REQUEST_CONFLICT', 'This request ID belongs to another native operation.');
      if (current.relay.mode !== 'DURABLE_NATIVE') await this.ctx.reconcileRecord(current);
      return this.result(this.ctx.ledger.get(requestId)!);
    });
  }

  async checkDurableAuthorization(input: Record<string, unknown>): Promise<unknown> {
    const { requestId, index, transactionHash } = parseInput(durableCheckSchema, input);
    return this.ctx.store.withAccountLocks([index], async () => {
      const record = this.ctx.ledger.get(requestId);
      if (record?.relay?.mode !== 'DURABLE_NATIVE' || record.index !== index || record.status === 'failed'
        || record.hash?.toLowerCase() !== transactionHash.toLowerCase()) {
        throw new AttoError('REQUEST_CONFLICT', 'This request has no matching signed durable relay authorization.');
      }
      const result = await this.result(record);
      await this.ctx.store.withWalletLock(async () => this.ctx.requireApproved(record));
      return result;
    });
  }

  private async result(record: SendRecord): Promise<unknown> {
    if (!record.relay) throw new AttoError('REQUEST_CONFLICT', 'This request belongs to another wallet operation.');
    const transaction = record.hash ? await this.ctx.retainedTransaction(record) : undefined;
    const base = {
      requestId: record.id, origin: record.relay.origin, audience: record.relay.audience, terms: record.relay.terms,
      network: record.relay.terms.network, sourceAddress: record.sourceAddress, destination: record.destination,
      amountAtomic: record.raw, hash: record.hash ?? null, state: record.status,
    };
    if (record.relay.mode === 'DURABLE_NATIVE') {
      const payload = record.relay.nativePayloadJson ? parseJsonObject(record.relay.nativePayloadJson) : null;
      if (transaction && !isDeepStrictEqual(payload, { transaction: wireTransaction(transaction) })) {
        throw new AttoError('INVALID_STATE', 'The retained native payload differs from its original relay authorization.');
      }
      return { ...base, mode: record.relay.mode, payload };
    }
    if (record.relay.paymentSignature) {
      if (!transaction) throw new AttoError('INVALID_STATE', 'Missing signed relay transaction.');
      const offer = parseRelayOffer(record.relay, true);
      const { payload, proof } = validateRetainedRelayPayload(offer, record.id, record.relay.paymentSignature, transaction.hash.toString());
      if (!isDeepStrictEqual(payload, { transaction: wireTransaction(transaction) })
        || (proof && !await AttoSignature.Companion.parse(proof.signature).isValidMessage(transaction.address.publicKey, Int8Array.from(Buffer.from(proof.message))))) {
        throw new AttoError('INVALID_STATE', 'The retained relay payload differs from its original authorization.');
      }
    }
    return { ...base, paymentRequired: record.relay.paymentRequired, paymentSignature: record.relay.paymentSignature ?? null };
  }
}
