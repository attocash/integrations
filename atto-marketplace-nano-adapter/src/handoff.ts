import { NanoStateBlock, addressPublicKey, canonicalAddress, hexBytes, sign, upperHex, validWork, verify } from './protocol.js';
import { parseJsonObject } from './rpc.js';
import { canonical, canonicalOrigin, exactKeys, framedHash, object, positiveRaw, sha256, text, type NanoWalletConfiguration } from './configuration.js';
import { fail } from './errors.js';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const HANDLE = /^[0-9a-f]{32}$/;
export interface PaymentRequest {
    raw: Record<string, any>;
    handoffId: string;
    requestSha256: string;
    intentId: string;
    requestId: string;
    amount: bigint;
    destination: string;
    expiresAt: number;
    maxTimeoutSeconds: number;
    challenge: Record<string, any>;
    challengeText: string;
    accepted: Record<string, any>;
}
const requestKeys = ['version', 'type', 'handoffId', 'origin', 'audience', 'accountId', 'asset', 'network', 'amountAtomic', 'requestId', 'paymentIdentifier', 'intentId', 'resourceUrl', 'expiresAt', 'paymentRequired', 'paymentRequiredSha256', 'requestSha256'];
const responseKeys = ['version', 'type', 'handoffId', 'requestSha256', 'intentId', 'requestId', 'accountId', 'asset', 'network', 'amountAtomic', 'origin', 'paymentIdentifier', 'resourceUrl', 'paymentRequiredSha256', 'sendHash', 'payer', 'signedDeadline', 'paymentSignature'];
export function instant(value: unknown): number {
    const input = text(value, 128);
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(input))
        fail('INVALID_REQUEST');
    const time = Date.parse(input);
    if (!Number.isFinite(time))
        fail('INVALID_REQUEST');
    return time;
}
export function instantText(time: number): string {
    return new Date(time).toISOString().replace(/\.000Z$/, 'Z');
}
export function decodeBase64(value: unknown, maximum = 75000): Buffer {
    const encoded = text(value, 100000);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
        fail('INVALID_REQUEST');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > maximum || bytes.toString('base64') !== encoded)
        fail('INVALID_REQUEST');
    return bytes;
}
export function parsePaymentRequest(value: unknown, config: NanoWalletConfiguration, now: number, allowExpired = false, historical = false): PaymentRequest {
    const raw = exactKeys(value, requestKeys);
    if (raw.version !== 1 ||
        raw.type !== 'marketplace-x402-payment-request' ||
        !HANDLE.test(text(raw.handoffId, 32)) ||
        canonicalOrigin(raw.origin) !== config.origin ||
        raw.audience !== config.audience ||
        !UUID.test(text(raw.accountId, 36)) ||
        raw.asset !== 'XNO' ||
        raw.network !== config.network)
        fail('INVALID_REQUEST');
    const amount = positiveRaw(raw.amountAtomic);
    if (!historical && (amount > positiveRaw(config.limits.maxPaymentAtomic, true) || amount > positiveRaw(config.limits.rolling24hAtomic, true)))
        fail('SPEND_LIMIT');
    if (!UUID.test(text(raw.requestId, 36)) ||
        !UUID.test(text(raw.intentId, 36)) ||
        raw.paymentIdentifier !== raw.requestId ||
        raw.resourceUrl !== `${raw.origin}/v1/agent/topups/${raw.intentId}`)
        fail('INVALID_REQUEST');
    const expiresAt = instant(raw.expiresAt);
    if (!allowExpired && expiresAt <= now)
        fail('PAYMENT_EXPIRED');
    const challengeBytes = decodeBase64(raw.paymentRequired), challengeText = new TextDecoder('utf-8', { fatal: true }).decode(challengeBytes);
    if (raw.paymentRequiredSha256 !== sha256(challengeBytes))
        fail('INVALID_REQUEST');
    const challenge = parseJsonObject(challengeText);
    if (challenge.x402Version !== 2 || object(challenge.resource).url !== raw.resourceUrl || !Array.isArray(challenge.accepts) || challenge.accepts.length !== 1)
        fail('INVALID_REQUEST');
    const accepted = object(challenge.accepts[0]), extra = accepted.extra === undefined ? {} : object(accepted.extra);
    if (accepted.scheme !== 'exact' ||
        accepted.network !== config.network ||
        accepted.asset !== 'XNO' ||
        accepted.amount !== raw.amountAtomic ||
        (extra.assetTransferMethod !== undefined && extra.assetTransferMethod !== 'native-state') ||
        (extra.paymentFlow !== undefined && extra.paymentFlow !== 'upfront') ||
        (extra.workOptional !== undefined && typeof extra.workOptional !== 'boolean') ||
        !Number.isInteger(accepted.maxTimeoutSeconds) ||
        accepted.maxTimeoutSeconds < 1 ||
        accepted.maxTimeoutSeconds > 86400)
        fail('INVALID_REQUEST');
    validateExtensions(challenge, raw);
    const destination = canonicalAddress(text(accepted.payTo, 128));
    if (destination !== accepted.payTo)
        fail('INVALID_REQUEST');
    const unsigned = { ...raw };
    delete unsigned.requestSha256;
    if (raw.requestSha256 !== sha256(canonical(unsigned)))
        fail('INVALID_REQUEST');
    return { raw, handoffId: raw.handoffId, requestSha256: raw.requestSha256, intentId: raw.intentId, requestId: raw.requestId, amount, destination, expiresAt, maxTimeoutSeconds: accepted.maxTimeoutSeconds, challenge, challengeText, accepted };
}
export function paymentBinding(request: PaymentRequest, hash: string, deadline: string): Buffer {
    return framedHash(['marketplace.nano.exact.state.v1', request.challengeText, request.raw.paymentIdentifier, hash, deadline]);
}
export const ACCOUNT_BINDING = 'marketplace-account-binding';
function validateExtensions(challenge: Record<string, any>, raw: Record<string, any>): void {
    const extensions = challenge.extensions === undefined ? {} : object(challenge.extensions);
    if (Object.hasOwn(extensions, 'payment-identifier')) {
        const identifier = object(extensions['payment-identifier']), info = object(identifier.info);
        object(identifier.schema);
        if (typeof info.required !== 'boolean' || (Object.hasOwn(info, 'id') && info.id !== raw.paymentIdentifier))
            fail('INVALID_REQUEST');
    }
    if (Object.hasOwn(extensions, ACCOUNT_BINDING)) {
        const binding = object(extensions[ACCOUNT_BINDING]), info = object(binding.info);
        object(binding.schema);
        if (info.required !== true || info.version !== 1 || info.domain !== 'marketplace.nano.exact.state.v1' ||
            info.accountId !== raw.accountId || info.intentId !== raw.intentId ||
            info.paymentIdentifier !== raw.paymentIdentifier || info.intentExpiresAt !== raw.expiresAt ||
            Object.hasOwn(info, 'bindingSignature')) fail('INVALID_REQUEST');
    }
}
function echoedExtensions(request: PaymentRequest, signature?: string): Record<string, any> {
    const extensions = request.challenge.extensions === undefined ? {} : { ...object(request.challenge.extensions) };
    if (Object.hasOwn(extensions, 'payment-identifier')) {
        const identifier = object(extensions['payment-identifier']);
        extensions['payment-identifier'] = { ...identifier, info: { ...object(identifier.info), id: request.raw.paymentIdentifier } };
    }
    if (Object.hasOwn(extensions, ACCOUNT_BINDING)) {
        const binding = object(extensions[ACCOUNT_BINDING]);
        extensions[ACCOUNT_BINDING] = { ...binding, info: { ...object(binding.info), bindingSignature: signature } };
    }
    return extensions;
}
export function buildPaymentResponse(request: PaymentRequest, block: NanoStateBlock, deadline: string, key: Uint8Array): Record<string, any> {
    if (deadline !== request.raw.expiresAt) fail('INVALID_REQUEST');
    const bindingSignature = request.challenge.extensions?.[ACCOUNT_BINDING] === undefined ? undefined
        : upperHex(sign(key, paymentBinding(request, block.hash, request.raw.expiresAt)));
    const extensions = echoedExtensions(request, bindingSignature);
    const payment = { x402Version: 2, resource: request.challenge.resource, accepted: request.accepted, payload: { block: block.toWire() }, ...(Object.keys(extensions).length ? { extensions } : {}) };
    const response: Record<string, any> = { version: 1, type: 'marketplace-x402-payment-response' };
    for (const name of ['handoffId', 'requestSha256', 'intentId', 'requestId', 'accountId', 'asset', 'network', 'amountAtomic', 'origin', 'paymentIdentifier', 'resourceUrl', 'paymentRequiredSha256'])
        response[name] = request.raw[name];
    return { ...response, sendHash: block.hash, payer: block.account, signedDeadline: deadline, paymentSignature: Buffer.from(JSON.stringify(payment)).toString('base64') };
}
export function validatePaymentResponse(value: unknown, request: PaymentRequest, config: NanoWalletConfiguration, previousBalance: bigint, epoch: number): NanoStateBlock {
    const raw = exactKeys(value, responseKeys);
    if (raw.version !== 1 || raw.type !== 'marketplace-x402-payment-response')
        fail('JOURNAL_CONFLICT');
    for (const name of ['handoffId', 'requestSha256', 'intentId', 'requestId', 'accountId', 'asset', 'network', 'amountAtomic', 'origin', 'paymentIdentifier', 'resourceUrl', 'paymentRequiredSha256'])
        if (raw[name] !== request.raw[name])
            fail('JOURNAL_CONFLICT');
    const payment = parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(raw.paymentSignature, 65536))), payload = object(payment.payload);
    const block = NanoStateBlock.parse(object(payload.block));
    if (raw.payer !== config.sourceAddress ||
        raw.sendHash !== block.hash ||
        block.account !== config.sourceAddress ||
        block.balance !== previousBalance - request.amount ||
        block.link !== upperHex(addressPublicKey(request.destination)) ||
        !block.validSignature() ||
        !validWork(config.network, epoch, false, block.workRoot(), block.work) ||
        raw.signedDeadline !== request.raw.expiresAt ||
        object(payload.block).link_as_account !== request.destination)
        fail('JOURNAL_CONFLICT');
    if (payment.x402Version !== 2 ||
        canonical(payment.resource) !== canonical(request.challenge.resource) ||
        canonical(payment.accepted) !== canonical(request.accepted) ||
        Object.keys(payload).length !== 1)
        fail('JOURNAL_CONFLICT');
    const extensions = payment.extensions === undefined ? {} : object(payment.extensions);
    const binding = extensions[ACCOUNT_BINDING] === undefined ? undefined : object(extensions[ACCOUNT_BINDING]);
    const signature = binding === undefined ? undefined : text(object(binding.info).bindingSignature, 128);
    if (canonical(extensions) !== canonical(echoedExtensions(request, signature)) ||
        (request.challenge.extensions?.[ACCOUNT_BINDING] !== undefined &&
            (!signature || !/^[A-F0-9]{128}$/.test(signature) ||
            !verify(addressPublicKey(config.sourceAddress), paymentBinding(request, block.hash, request.raw.expiresAt), hexBytes(signature, 64)))))
        fail('JOURNAL_CONFLICT');
    return block;
}
