import {
    parseRelayOffer, relayPaymentPayload, relayProofFromHeader, validateRelayProof,
    type RelayOffer, type RelayProof, type RelayRequest,
} from '@attocash/cli/internal-marketplace';
import type { NanoWalletConfiguration } from './configuration.js';
import { fail } from './errors.js';
import type { JournalRecord } from './journal.js';
import { offchainVerify, type NanoStateBlock } from './protocol.js';

export function walletRelayOffer(request: RelayRequest, config: NanoWalletConfiguration, allowExpired: boolean): RelayOffer {
    const offer = parseRelayOffer(request, allowExpired);
    const { terms } = offer;
    if (request.origin !== config.origin || request.audience !== config.audience || terms.asset !== 'XNO'
        || terms.network !== config.network || terms.senderAddress !== config.sourceAddress)
        fail('INVALID_REQUEST');
    return offer;
}

export function checkRelayCandidateTerms(request: RelayRequest, record: JournalRecord): void {
    const { terms } = parseRelayOffer(request, true);
    if (terms.senderAddress !== record.source || terms.network !== record.network || terms.recipientAddress !== record.destination
        || terms.amountAtomic !== record.amount || terms.asset !== 'XNO')
        fail('JOURNAL_CONFLICT');
}

export function verifyRelayHeader(request: RelayRequest, offer: RelayOffer, block: NanoStateBlock | undefined, header: string): void {
    const proof = relayProofFromHeader(header);
    if (!block)
        fail('JOURNAL_CONFLICT');
    validateRelayProof(offer, block.hash, request.audience, proof, true);
    if (!offchainVerify(block.account, proof.message, proof.signature)
        || relayPaymentPayload(offer, request.requestId, { block: block.toWire() }, proof) !== header)
        fail('JOURNAL_CONFLICT');
}

export function verifyRelayAuthorization(request: RelayRequest, offer: RelayOffer, block: NanoStateBlock, proof: RelayProof): void {
    validateRelayProof(offer, block.hash, request.audience, proof);
    if (!offchainVerify(block.account, proof.message, proof.signature))
        fail('INVALID_REQUEST');
}
