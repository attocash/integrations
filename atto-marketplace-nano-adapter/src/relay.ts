import { isDeepStrictEqual } from 'node:util';
import {
    parseDurableRelayRequest, parseRelayOffer, validateRetainedRelayPayload,
    type RelayOffer, type RelayRequest, type WalletRelayRequest,
} from '@attocash/cli/internal-marketplace';
import type { NanoWalletConfiguration } from './configuration.js';
import { fail } from './errors.js';
import type { JournalRecord } from './journal.js';
import { offchainVerify, type NanoStateBlock } from './protocol.js';

export function walletRelayTerms(request: WalletRelayRequest, config: NanoWalletConfiguration, retained: boolean) {
    const terms = request.mode === 'DURABLE_NATIVE' ? parseDurableRelayRequest(request) : parseRelayOffer(request, retained).terms;
    if (request.origin !== config.origin || request.audience !== config.audience || terms.asset !== 'XNO'
        || terms.network !== config.network || terms.senderAddress !== config.sourceAddress)
        fail('INVALID_REQUEST');
    return terms;
}

export function checkRelayCandidateTerms(request: WalletRelayRequest, record: JournalRecord, config: NanoWalletConfiguration): void {
    const terms = walletRelayTerms(request, config, true);
    if (terms.senderAddress !== record.source || terms.network !== record.network || terms.recipientAddress !== record.destination
        || terms.amountAtomic !== record.amount || terms.asset !== 'XNO')
        fail('JOURNAL_CONFLICT');
}

export function verifyRelayHeader(request: RelayRequest, offer: RelayOffer, block: NanoStateBlock | undefined, header: string): void {
    if (!block) fail('JOURNAL_CONFLICT');
    const { payload, proof } = validateRetainedRelayPayload(offer, request.requestId, header, block.hash);
    if (!isDeepStrictEqual(payload, { block: block.toWire() }) || (proof && !offchainVerify(block.account, proof.message, proof.signature)))
        fail('JOURNAL_CONFLICT');
}
