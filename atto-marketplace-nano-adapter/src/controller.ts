import { addressPublicKey, canonicalAddress, hexBytes, offchainSign, offchainVerify, upperHex } from './protocol.js';
import { canonical, exactKeys, loadConfiguration, text, withPrivateKey, type NanoWalletConfiguration } from './configuration.js';
import { instant } from './handoff.js';
import { fail } from './errors.js';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const typedPurposes = new Set(['login', 'link authorizer', 'link new identity', 'unlink', 'API-key creation', 'API-key rotation', 'API-key revocation', 'payout address enrollment', 'payout address selection', 'payout address disablement', 'withdrawal creation', 'product purchase', 'product refund']);
const rawPurposes = new Set(['login', 'link authorizer', 'link new identity', 'unlink']);
export interface ControllerProofRequest {
    origin: string;
    network: string;
    address: string;
    index: number;
    audience: string;
    purpose: string;
    message: string;
}
/** Headless native proofs retain their explicit per-purpose grants. */
export function validateControllerProof(request: ControllerProofRequest, config: NanoWalletConfiguration, now: number): void {
    if (!rawPurposes.has(request.purpose) || !config.grants.controllerPurposes.includes(request.purpose as any)) fail('CONTROLLER_PROOF_INVALID');
    validateControllerFrame(request, config, now);
}
function validateTerminalControllerProof(request: ControllerProofRequest, config: NanoWalletConfiguration, now: number): void {
    if (!typedPurposes.has(request.purpose)) fail('CONTROLLER_PROOF_INVALID');
    validateControllerFrame(request, config, now);
}
function validateControllerFrame(request: ControllerProofRequest, config: NanoWalletConfiguration, now: number): void {
    exactKeys(request, ['origin', 'network', 'address', 'index', 'audience', 'purpose', 'message']);
    if (request.origin !== config.origin || request.network !== config.network || request.address !== config.sourceAddress
        || request.index !== config.derivationIndex || request.audience !== config.audience) fail('CONTROLLER_PROOF_INVALID');
    const message = text(request.message, 4096);
    if (Buffer.byteLength(message) > 4096 || /[\r\0]/.test(message))
        fail('CONTROLLER_PROOF_INVALID');
    const lines = message.split('\n');
    if (lines.length !== 10 ||
        lines[0] !== 'Nano Marketplace Agent Controller Proof v1' ||
        lines[1] !== `Audience: ${config.audience}` ||
        lines[2] !== `Network: ${config.network}` ||
        lines[3] !== `Address: ${config.sourceAddress}` ||
        lines[4] !== `Purpose: ${request.purpose}` ||
        !uuid.test((lines[5] ?? '').replace(/^Request ID: /, '')) ||
        !/^Request ID: /.test(lines[5] ?? '') ||
        !/^Binding Hash: [0-9a-f]{64}$/.test(lines[6] ?? '') ||
        !/^Nonce: [0-9a-f]{64}$/.test(lines[7] ?? '') ||
        !lines[8]?.startsWith('Issued At: ') ||
        !lines[9]?.startsWith('Expiration Time: '))
        fail('CONTROLLER_PROOF_INVALID');
    const issued = instant(lines[8].slice(11)), expires = instant(lines[9].slice(17));
    if (issued > now + 30000 || expires <= now || expires <= issued || expires - issued > 300000)
        fail('CONTROLLER_PROOF_INVALID');
}
export async function signControllerProof(request: ControllerProofRequest, config: NanoWalletConfiguration, now = Date.now(), latest?: () => {config:NanoWalletConfiguration;now:number}): Promise<string> {
    validateControllerProof(request, config, now);
    return withPrivateKey(config, key => {
        const current=latest?.()??{config,now:Date.now()};
        validateControllerProof(request,current.config,current.now);
        return upperHex(offchainSign(key, request.message));
    });
}
/** Only the terminal typed approval path calls this after validating the full
 * server-authored request and its action binding. Raw MCP signing stays narrow. */
export async function signMarketplaceNanoController(options: {
    dataDir: string;
    request: ControllerProofRequest;
    terminalConfirmed: true;
}): Promise<string> {
    if (options.terminalConfirmed !== true || !process.stdin.isTTY || !process.stderr.isTTY) fail('TERMINAL_REQUIRED');
    const config = loadConfiguration(options.dataDir);
    validateTerminalControllerProof(options.request, config, Date.now());
    return withPrivateKey(config, key => {
        const current = loadConfiguration(options.dataDir);
        if (canonical({ ...current, grants: null, limits: null }) !== canonical({ ...config, grants: null, limits: null })) fail('WALLET_CONFIGURATION_CHANGED');
        validateTerminalControllerProof(options.request, current, Date.now());
        return upperHex(offchainSign(key, options.request.message));
    });
}
/** Public verification intentionally has no configuration, seed or journal dependency. */
export function verifyNanoMessage(input: {
    address: string;
    message: string;
    signature: string;
}): boolean {
    try {
        exactKeys(input, ['address', 'message', 'signature']);
        if (canonicalAddress(input.address) !== input.address || Buffer.byteLength(input.message) > 4096 || !/^[A-Fa-f0-9]{128}$/.test(input.signature))
            return false;
        return offchainVerify(addressPublicKey(input.address), input.message, hexBytes(input.signature, 64));
    }
    catch {
        return false;
    }
}
