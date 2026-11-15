import { parseJsonObject } from './json.js';
import { NanoStateBlock, MAX_RAW, ZERO_HASH, addressPublicKey, canonicalAddress, canonicalHash, upperHex, validWork, offchainVerify, offchainSign, type NanoNetwork } from './protocol.js';
import { parseRelayOffer, relayPaymentPayload, relayProofFromHeader, validateRelayProof, type RelayRequest, type RelayProof } from '@attocash/cli/internal-marketplace';
import { NanoRpcClient, DEV_GENESIS_ACCOUNT, DEV_GENESIS_HASH, MAIN_GENESIS_ACCOUNT, MAIN_GENESIS_HASH, requireConfirmedFrontier, type NanoAccountSnapshot } from './rpc.js';
import { canonical, defaultDataDirectory, exactKeys, loadConfiguration, positiveRaw, sha256, text, withPrivateKey, type NanoWalletConfiguration } from './configuration.js';
import { signControllerProof, validateControllerProof, verifyNanoMessage, type ControllerProofRequest } from './controller.js';
import { NanoJournal, type JournalRecord } from './journal.js';
import { fail } from './errors.js';
export type NanoRpc = Pick<NanoRpcClient, 'requirePinnedNetwork' | 'accountSnapshot' | 'accountSnapshotOrNotFound' | 'blockInfo' | 'generateWork' | 'generateOpenWork' | 'process' | 'processDevOpen' | 'receivable' | 'receivableExists' | 'verifyFrontierState' | 'validSourceBlock' | 'validConfirmedBlock' | 'requireLoopbackDevelopmentEndpoint'>;
export interface NanoWalletOpenOptions {
    dataDir?: string;
    rpc?: NanoRpc;
    now?: () => number;
}
export interface NanoTransferRequest {
    network: NanoNetwork;
    destination: string;
    amountAtomic: string;
    requestId: string;
}
export type NanoWalletRequest = {
    operation: 'identity.list';
    args: Record<string, never>;
} | {
    operation: 'receivable.list';
    args: {network:NanoNetwork;limit?:number};
} | {
    operation: 'balance.get';
    args: {
        network: NanoNetwork;
    };
} | {
    operation: 'message.sign';
    args: ControllerProofRequest;
} | {
    operation: 'message.verify';
    args: {
        address: string;
        message: string;
        signature: string;
    };
} | {
    operation: 'transfer.send';
    args: NanoTransferRequest;
} | {
    operation: 'transfer.status';
    args: {
        requestId: string;
    };
} | {
    operation: 'receive';
    args: {
        network: NanoNetwork;
        hash: string;
    };
} | {
    operation: 'devsource.open';
    args: {
        fundingSendHash: string;
    };
};
export interface NanoOperationResult {
    requestId?: string;
    state: string;
    network: NanoNetwork;
    sourceAddress: string;
    candidateState: 'PRESENT' | 'ABSENT';
    sendHash: string | null;
    destination?: string;
    amountAtomic?: string;
    index?: number;
}
const active = new Set<string>();
export class NanoWallet {
    configuration: NanoWalletConfiguration;
    private readonly journal: NanoJournal;
    private readonly rpc: NanoRpc;
    private readonly now: () => number;
    readonly dataDir: string;
    private constructor(options: NanoWalletOpenOptions) {
        this.dataDir = options.dataDir ?? defaultDataDirectory();
        this.configuration = loadConfiguration(this.dataDir);
        this.rpc = options.rpc ?? new NanoRpcClient(this.configuration.rpcUrl, this.configuration.network, this.configuration.workUrl);
        this.now = options.now ?? Date.now;
        this.journal = new NanoJournal(this.dataDir);
    }
    static open(options: NanoWalletOpenOptions = {}): NanoWallet {
        return new NanoWallet(options);
    }
    close(): void {
        this.journal.close();
    }
    async execute(request: NanoWalletRequest): Promise<Record<string, unknown>> {
        return this.call(request.operation, request.args as unknown as Record<string, unknown>);
    }
    private refreshPolicy(): void {
        const current = loadConfiguration(this.dataDir);
        if (canonical({ ...current, grants: null, limits: null }) !== canonical({ ...this.configuration, grants: null, limits: null }))
            fail('WALLET_CONFIGURATION_CHANGED');
        this.configuration = current;
    }
    private requireSigningAuthority(amount: bigint): void {
        this.refreshPolicy();
        if (!this.configuration.grants.externalTransfers)
            fail('PERMISSION_DENIED');
        if (amount > positiveRaw(this.configuration.limits.maxPaymentAtomic, true))
            fail('SPEND_LIMIT');
        this.journal.checkLimit(this.configuration.sourceAddress, this.configuration.network, this.now(), positiveRaw(this.configuration.limits.rolling24hAtomic, true));
    }
    private requireReceiveAuthority(): void {
        this.refreshPolicy();
        if (!this.configuration.grants.externalTransfers)
            fail('PERMISSION_DENIED');
    }
    private async locked<T>(action: () => Promise<T>): Promise<T> {
        const key = `${this.dataDir}:${this.configuration.sourceAddress}`;
        if (active.has(key))
            fail('PAYMENT_IN_PROGRESS');
        active.add(key);
        try {
            return await action();
        }
        finally {
            active.delete(key);
        }
    }
    private async identity(): Promise<{
        address: string;
        index: number;
        network: NanoNetwork;
    }> {
        return { address: this.configuration.sourceAddress, index: this.configuration.derivationIndex, network: this.configuration.network };
    }
    async call(operation: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
        if (operation !== 'message.verify')
            this.refreshPolicy();
        switch (operation) {
            case 'identity.list':
                exactKeys(args, []);
                return { identities: [await this.identity()] };
            case 'receivable.list': {
                this.requireNetwork(args,args.limit===undefined?['network']:['network','limit']);
                const limit=args.limit??50;
                if(typeof limit!=='number'||!Number.isInteger(limit)||limit<1||limit>100)fail('INVALID_REQUEST');
                const identity=await this.identity();await this.rpc.requirePinnedNetwork();
                const incoming=await this.rpc.receivable(identity.address,limit);
                return {...identity,receivables:incoming.map(row=>({hash:row.hash,amountAtomic:row.amount.toString(),source:row.source}))};
            }
            case 'balance.get': {
                this.requireNetwork(args, ['network']);
                const identity = await this.identity();
                await this.rpc.requirePinnedNetwork();
                const snapshot = await this.rpc.accountSnapshotOrNotFound(identity.address);
                return { ...identity, balanceAtomic: snapshot?.confirmedBalance.toString() ?? '0', pending: !snapshot ? false : snapshot.frontier !== snapshot.confirmedFrontier };
            }
            case 'message.sign': {
                const request = args as unknown as ControllerProofRequest;
                // Validate all structured fields before contacting the node or reading the secret.
                validateControllerProof(request, this.configuration, this.now());
                await this.rpc.requirePinnedNetwork();
                this.refreshPolicy();
                const signature = await signControllerProof(request, this.configuration, this.now(), () => { this.refreshPolicy(); return { config: this.configuration, now: this.now() }; });
                return { signature };
            }
            case 'message.verify': return { valid: verifyNanoMessage(args as any) };
            case 'transfer.send': return await this.locked(() => this.transfer(args));
            case 'payment.prepare': return await this.locked(() => this.prepareRelay(args));
            case 'payment.authorize': return await this.locked(() => this.authorizeRelay(args));
            case 'payment.status': {
                exactKeys(args, ['requestId']);
                const id = `transfer:${this.requestId(args.requestId)}`, prior = this.journal.find(id);
                if (!prior) return { requestId: args.requestId, state: 'NOT_FOUND' };
                return await this.locked(async () => {
                    if (prior.state === 'PREPARING') return this.relayResult(prior);
                    await this.status(id);
                    return this.relayResult(this.journal.find(id)!);
                });
            }
            case 'transfer.status':
                exactKeys(args, ['requestId']);
                return await this.locked(() => this.status(`transfer:${this.requestId(args.requestId)}`));
            case 'receive':
                this.requireNetwork(args, ['network', 'hash']);
                return await this.locked(() => this.receive(canonicalHash(text(args.hash, 64))));
            case 'devsource.open':
                exactKeys(args, ['fundingSendHash']);
                return await this.locked(async () => {
                    if (this.configuration.network !== 'nano:dev')
                        fail('LOCAL_DEV_REQUIRED');
                    this.rpc.requireLoopbackDevelopmentEndpoint();
                    const hash = canonicalHash(text(args.fundingSendHash, 64));
                    const result = await this.receive(hash, true);
                    return { sourceAddress: this.configuration.sourceAddress, fundingSendHash: hash, amountAtomic: result.amountAtomic, openHash: result.sendHash, replayed: result.replayed, state: result.state };
                });
            default: return fail('UNSUPPORTED_OPERATION');
        }
    }
    private requireNetwork(args: Record<string, unknown>, keys: string[]): void {
        exactKeys(args, keys);
        if (args.network !== this.configuration.network)
            fail('NETWORK_MISMATCH');
    }
    private requestId(value: unknown): string {
        const id = text(value, 36);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
            fail('INVALID_REQUEST');
        return id;
    }
    private result(record: JournalRecord): NanoOperationResult {
        return { requestId: record.id.slice(record.kind.length + 1), state: record.state, network: this.configuration.network, sourceAddress: this.configuration.sourceAddress,
            ...(record.kind === 'transfer' ? { destination: record.destination, amountAtomic: record.amount } : {}),
            ...(record.kind === 'transfer' || record.kind === 'receive' ? { index: this.configuration.derivationIndex } : {}), candidateState: record.blockHash ? 'PRESENT' : 'ABSENT', sendHash: record.blockHash };
    }
    private configuredRecord(record: JournalRecord): void {
        if (record.source !== this.configuration.sourceAddress || record.network !== this.configuration.network || sha256(record.requestJson) !== record.digest)
            fail('JOURNAL_CONFLICT');
    }
    private savedBlock(record: JournalRecord): NanoStateBlock {
        this.configuredRecord(record);
        if (record.epoch === null || record.previous === null || record.previousBalance === null || record.representative === null || !record.blockJson || !record.blockHash)
            fail('JOURNAL_CONFLICT');
        const block = NanoStateBlock.parse(parseJsonObject(record.blockJson));
        if (block.hash !== record.blockHash ||
            block.account !== record.source ||
            block.previous !== record.previous ||
            block.representative !== record.representative ||
            !block.validSignature() ||
            !validWork(this.configuration.network, record.kind === 'receive' ? 0 : 2, record.kind === 'receive', block.workRoot(), block.work))
            fail('JOURNAL_CONFLICT');
        const previousBalance = positiveRaw(record.previousBalance, true), terms = parseJsonObject(record.requestJson);
        if (record.kind === 'transfer') {
            exactKeys(terms, terms.relay === undefined ? ['network', 'destination', 'amountAtomic', 'requestId'] : ['network', 'destination', 'amountAtomic', 'requestId', 'relay']);
            if (terms.relay !== undefined) {
                const offer = parseRelayOffer(terms.relay as RelayRequest, true);
                if (offer.terms.senderAddress !== record.source || offer.terms.network !== record.network || offer.terms.recipientAddress !== record.destination
                    || offer.terms.amountAtomic !== record.amount || offer.terms.asset !== 'XNO') fail('JOURNAL_CONFLICT');
            }
            if (terms.network !== record.network ||
                terms.destination !== record.destination ||
                terms.amountAtomic !== record.amount ||
                record.id !== `transfer:${terms.requestId}` ||
                record.uniqueId !== record.id ||
                block.balance !== previousBalance - positiveRaw(record.amount) ||
                block.link !== upperHex(addressPublicKey(record.destination)))
                fail('JOURNAL_CONFLICT');
        }
        else {
            exactKeys(terms, ['network', 'hash', 'amountAtomic']);
            if (terms.network !== record.network ||
                record.id !== `receive:${terms.hash}` ||
                record.uniqueId !== record.id ||
                record.destination !== terms.hash ||
                record.amount !== '0' ||
                block.link !== terms.hash ||
                block.balance !== previousBalance + positiveRaw(terms.amountAtomic))
                fail('JOURNAL_CONFLICT');
        }
        return block;
    }
    private async transfer(args: Record<string, unknown>, relay?: RelayRequest): Promise<Record<string, unknown>> {
        this.requireNetwork(args, ['network', 'destination', 'amountAtomic', 'requestId']);
        const id = `transfer:${this.requestId(args.requestId)}`, amount = positiveRaw(args.amountAtomic), destination = canonicalAddress(text(args.destination, 128));
        if (destination !== args.destination || destination === this.configuration.sourceAddress)
            fail('INVALID_REQUEST');
        const terms = relay ? { ...args, relay } : args;
        const input = { id, kind: 'transfer' as const, digest: sha256(canonical(terms)), requestJson: canonical(terms), uniqueId: id, source: this.configuration.sourceAddress, network: this.configuration.network, amount: String(amount), destination };
        const prior = this.journal.find(id);
        if (prior) {
            if (!(relay && prior.state === 'PREPARING')) this.journal.requireTerms(prior, input);
            if (prior.state !== 'PREPARING')
                return relay ? this.relayResult(prior) : await this.publishNative(prior, true);
        }
        if (!this.configuration.grants.externalTransfers)
            fail('PERMISSION_DENIED', 'External Nano transfers require their own local terminal grant.');
        if (amount > positiveRaw(this.configuration.limits.maxPaymentAtomic, true))
            fail('SPEND_LIMIT');
        await withPrivateKey(this.configuration, () => undefined);
        await this.rpc.requirePinnedNetwork();
        const reservation = this.journal.begin(input, this.now(), positiveRaw(this.configuration.limits.rolling24hAtomic, true));
        if (reservation.state !== 'PREPARING')
            return relay ? this.relayResult(reservation) : await this.publishNative(reservation, true);
        let durable = false;
        try {
            const account = requireConfirmedFrontier(await this.rpc.accountSnapshot(this.configuration.sourceAddress));
            await this.rpc.verifyFrontierState(account, this.configuration.sourceAddress);
            if (account.balance < amount)
                fail('INSUFFICIENT_FUNDS');
            const work = await this.rpc.generateWork(account.frontier, 2);
            this.requireSigningAuthority(amount);
            const block = await withPrivateKey(this.configuration, key => {
                this.requireSigningAuthority(amount);
                return NanoStateBlock.signed(key, account.frontier, account.representative, account.balance - amount, upperHex(addressPublicKey(destination)), work);
            });
            if (!validWork(this.configuration.network, 2, false, block.workRoot(), block.work))
                fail('RPC_UNAVAILABLE');
            if (relay) parseRelayOffer(relay);
            const record = this.journal.save(id, { epoch: account.epoch, previous: account.frontier, previousBalance: account.balance.toString(), representative: account.representative, blockJson: canonical(block.toWire()), blockHash: block.hash });
            durable = true;
            return relay ? this.relayResult(record) : await this.publishNative(record, false);
        }
        catch (error) {
            if (!durable)
                this.journal.abort(id);
            throw error;
        }
    }
    private async prepareRelay(args: Record<string, unknown>): Promise<Record<string, unknown>> {
        exactKeys(args, ['requestId', 'origin', 'audience', 'terms', 'paymentRequired']);
        const request = args as unknown as RelayRequest, prior = this.journal.find(`transfer:${this.requestId(request.requestId)}`);
        const offer = parseRelayOffer(request, Boolean(prior?.blockHash));
        if (request.origin !== this.configuration.origin || request.audience !== this.configuration.audience || offer.terms.asset !== 'XNO'
            || offer.terms.network !== this.configuration.network || offer.terms.senderAddress !== this.configuration.sourceAddress) fail('INVALID_REQUEST');
        const pending = this.journal.pendingForSource(this.configuration.sourceAddress);
        if (pending?.blockHash && pending.id !== `transfer:${request.requestId}`) {
            await this.rpc.requirePinnedNetwork();
            await this.reconcile(pending);
        }
        return this.transfer({ requestId: request.requestId, network: offer.terms.network, destination: offer.terms.recipientAddress, amountAtomic: offer.terms.amountAtomic }, request);
    }
    private relayResult(record: JournalRecord): Record<string, unknown> {
        this.configuredRecord(record);
        const terms = parseJsonObject(record.requestJson), request = terms.relay as RelayRequest;
        if (!request) fail('JOURNAL_CONFLICT');
        const offer = parseRelayOffer(request, true), block = record.blockHash ? this.savedBlock(record) : undefined, header = this.journal.relayHeader(record.id);
        if (header) {
            const proof = relayProofFromHeader(header);
            if (!block) fail('JOURNAL_CONFLICT');
            validateRelayProof(offer, block.hash, request.audience, proof, true);
            if (!offchainVerify(record.source, proof.message, proof.signature) || relayPaymentPayload(offer, request.requestId, { block: block.toWire() }, proof) !== header) fail('JOURNAL_CONFLICT');
        }
        return { requestId: request.requestId, network: record.network, sourceAddress: record.source, destination: record.destination,
            amountAtomic: record.amount, hash: record.blockHash, state: record.state, paymentRequired: request.paymentRequired, paymentSignature: header ?? null };
    }
    private async authorizeRelay(args: Record<string, unknown>): Promise<Record<string, unknown>> {
        exactKeys(args, ['requestId', 'proof']);
        const record = this.journal.find(`transfer:${this.requestId(args.requestId)}`);
        if (!record?.blockHash) fail('JOURNAL_CONFLICT');
        if (this.journal.relayHeader(record.id)) return this.relayResult(record);
        const request = parseJsonObject(record.requestJson).relay as RelayRequest, offer = parseRelayOffer(request), block = this.savedBlock(record);
        const supplied = args.proof as RelayProof;
        validateRelayProof(offer, block.hash, request.audience, { ...supplied, signature: supplied.signature ?? '0'.repeat(128) });
        let signature = supplied.signature;
        if (signature === undefined) {
            this.requireSigningAuthority(BigInt(record.amount));
            signature = await withPrivateKey(this.configuration, key => {
                this.requireSigningAuthority(BigInt(record.amount));
                return upperHex(offchainSign(key, supplied.message));
            });
        }
        const proof = { ...supplied, signature };
        validateRelayProof(offer, block.hash, request.audience, proof);
        if (!offchainVerify(record.source, proof.message, proof.signature)) fail('INVALID_REQUEST');
        this.requireSigningAuthority(BigInt(record.amount));
        this.journal.authorizeRelay(record.id, relayPaymentPayload(offer, request.requestId, { block: block.toWire() }, proof));
        return this.relayResult(record);
    }
    private async funding(hash: string, devOnly: boolean): Promise<bigint> {
        const send = await this.rpc.blockInfo(hash);
        if (!send ||
            send.subtype !== 'send' ||
            send.block.hash !== hash ||
            send.block.link !== upperHex(addressPublicKey(this.configuration.sourceAddress)) ||
            !this.rpc.validConfirmedBlock(send, send.blockAccount) ||
            (devOnly &&
            send.blockAccount !== DEV_GENESIS_ACCOUNT))
            fail('FUNDING_INVALID');
        let previousBalance: bigint;
        if (send.block.previous === (this.configuration.network === 'nano:dev' ? DEV_GENESIS_HASH : MAIN_GENESIS_HASH)) {
            if (send.blockAccount !== (this.configuration.network === 'nano:dev' ? DEV_GENESIS_ACCOUNT : MAIN_GENESIS_ACCOUNT))
                fail('FUNDING_INVALID');
            previousBalance = MAX_RAW;
        }
        else {
            const previous = await this.rpc.blockInfo(send.block.previous);
            if (!previous || previous.block.hash !== send.block.previous || !this.rpc.validConfirmedBlock(previous, send.blockAccount))
                fail('FUNDING_INVALID');
            previousBalance = previous.block.balance;
        }
        const amount = previousBalance - send.block.balance;
        if (amount <= 0n || amount > MAX_RAW)
            fail('FUNDING_INVALID');
        return amount;
    }
    private async receive(hash: string, devOnly = false): Promise<Record<string, unknown>> {
        const id = `receive:${hash}`;
        let prior = this.journal.find(id);
        if (prior?.state === 'PREPARING') {
            this.journal.clearAbandoned(id);
            prior = undefined;
        }
        if (prior) {
            const block = this.savedBlock(prior);
            if (devOnly && block.previous !== ZERO_HASH)
                fail('SOURCE_OPEN_CONFLICT');
            const result = await this.publishNative(prior, true);
            return { ...result, amountAtomic: parseJsonObject(prior.requestJson).amountAtomic, replayed: true };
        }
        if (!devOnly) this.requireReceiveAuthority();
        await withPrivateKey(this.configuration, () => undefined);
        await this.rpc.requirePinnedNetwork();
        const amount = await this.funding(hash, devOnly);
        if (!await this.rpc.receivableExists(hash))
            fail('FUNDING_NOT_RECEIVABLE');
        const terms = { network: this.configuration.network, hash, amountAtomic: String(amount) };
        const reservation = this.journal.begin({ id, kind: 'receive', digest: sha256(canonical(terms)), requestJson: canonical(terms), uniqueId: id, source: this.configuration.sourceAddress, network: this.configuration.network, amount: '0', destination: hash }, this.now(), positiveRaw(this.configuration.limits.rolling24hAtomic, true));
        if (reservation.state !== 'PREPARING') {
            const result = await this.publishNative(reservation, true);
            return { ...result, amountAtomic: String(amount), replayed: true };
        }
        let durable = false;
        try {
            const snapshot = await this.rpc.accountSnapshotOrNotFound(this.configuration.sourceAddress);
            if (devOnly && snapshot)
                fail('SOURCE_ALREADY_OPEN');
            const account = snapshot ? requireConfirmedFrontier(snapshot) : { frontier: ZERO_HASH, balance: 0n, representative: this.configuration.sourceAddress, epoch: 0 };
            if (snapshot)
                await this.rpc.verifyFrontierState(account, this.configuration.sourceAddress);
            if (account.balance + amount > MAX_RAW)
                fail('INVALID_AMOUNT');
            const root = account.frontier === ZERO_HASH ? upperHex(addressPublicKey(this.configuration.sourceAddress)) : account.frontier;
            const work = await this.rpc.generateOpenWork(root);
            const block = await withPrivateKey(this.configuration, key => {
                if (!devOnly) this.requireReceiveAuthority();
                return NanoStateBlock.signed(key, account.frontier, account.representative, account.balance + amount, hash, work);
            });
            if (!validWork(this.configuration.network, 0, true, root, work))
                fail('RPC_UNAVAILABLE');
            const record = this.journal.save(id, { epoch: account.epoch, previous: account.frontier, previousBalance: String(account.balance), representative: account.representative, blockJson: canonical(block.toWire()), blockHash: block.hash });
            durable = true;
            return { ...await this.publishNative(record, false), amountAtomic: String(amount), replayed: false };
        }
        catch (error) {
            if (!durable)
                this.journal.abort(id);
            throw error;
        }
    }
    private async publishNative(record: JournalRecord, replayed: boolean): Promise<Record<string, unknown>> {
        const block = this.savedBlock(record);
        if (['CONFIRMED', 'COMPETING'].includes(record.state))
            return { ...this.result(record), replayed };
        await this.rpc.requirePinnedNetwork();
        const recovered = await this.reconcile(record);
        if (['CONFIRMED', 'COMPETING'].includes(recovered.state))
            return { ...this.result(recovered), replayed };
        // Retrying only these exact durable bytes is safe even when a prior publication response was lost.
        const current = await this.rpc.accountSnapshotOrNotFound(record.source);
        if ((record.previous === ZERO_HASH && current !== null) || (record.previous !== ZERO_HASH && (!current || !this.matches(current, record))))
            return { ...this.result(this.journal.state(record.id, 'UNKNOWN', this.now())), replayed };
        const unknown = this.journal.state(record.id, 'UNKNOWN', this.now());
        try {
            await this.rpc.process(block, record.kind === 'transfer' ? 'send' : block.previous === ZERO_HASH ? 'open' : 'receive');
        }
        catch {
            return { ...this.result(unknown), replayed };
        }
        return { ...this.result(await this.reconcile(unknown)), replayed };
    }
    private matches(snapshot: NanoAccountSnapshot, record: JournalRecord): boolean {
        return snapshot.frontier === record.previous && snapshot.confirmedFrontier === record.previous && snapshot.balance.toString() === record.previousBalance && snapshot.confirmedBalance.toString() === record.previousBalance && snapshot.representative === record.representative && snapshot.confirmedRepresentative === record.representative && snapshot.epoch === record.epoch;
    }
    private async reconcile(record: JournalRecord): Promise<JournalRecord> {
        const block = this.savedBlock(record), own = await this.rpc.blockInfo(block.hash);
        if (own) {
            // Work is outside the signed hash. For our matching confirmed
            // candidate, require the network/kind envelope across supported
            // epochs; block_info does not establish the historical work epoch.
            // Unconfirmed evidence and our durable candidate retain their checks.
            const receive = record.kind === 'receive';
            const observedEpoch = own.confirmed ? (receive ? 2 : 0) : (receive ? 0 : record.epoch!);
            if (own.blockAccount !== record.source || own.block.account !== record.source ||
                own.block.hash !== block.hash || own.block.signature !== block.signature || !own.block.validSignature() ||
                !validWork(this.configuration.network, observedEpoch, receive, own.block.workRoot(), own.block.work) ||
                !(record.kind === 'receive' ? ['receive', 'open'].includes(own.subtype) : own.subtype === 'send'))
                fail('RPC_CONFLICT');
            if (own.confirmed)
                return this.journal.state(record.id, 'CONFIRMED', this.now());
        }
        const source = await this.rpc.accountSnapshotOrNotFound(record.source);
        if (record.state === 'PREPARED' && ((record.previous === ZERO_HASH && source === null) || (source && this.matches(source, record))))
            return record;
        if (record.previous !== ZERO_HASH && source && source.frontier === source.confirmedFrontier && source.frontier !== record.previous) {
            const predecessor = await this.rpc.blockInfo(record.previous!), successorHash = predecessor?.successor;
            if (successorHash && successorHash !== ZERO_HASH && successorHash !== block.hash) {
                const successor = await this.rpc.blockInfo(successorHash);
                if (successor?.confirmed &&
                    successor.block.hash === successorHash &&
                    successor.block.previous === record.previous &&
                    this.rpc.validSourceBlock(successor, record.source, BigInt(record.previousBalance!), record.representative!, record.epoch! + 1))
                    return this.journal.state(record.id, 'COMPETING', this.now());
            }
        }
        return this.journal.state(record.id, 'UNKNOWN', this.now());
    }
    private async status(id: string): Promise<Record<string, unknown>> {
        const record = this.journal.find(id);
        if (!record)
            fail('NOT_FOUND');
        this.configuredRecord(record);
        if (record.state === 'PREPARING') {
            if (this.journal.clearAbandoned(id))
                return { ...this.result(record), state: 'READY', candidateState: 'ABSENT', sendHash: null };
            fail('PAYMENT_IN_PROGRESS');
        }
        this.savedBlock(record);
        if (['CONFIRMED', 'COMPETING'].includes(record.state))
            return this.result(record) as unknown as Record<string, unknown>;
        await this.rpc.requirePinnedNetwork();
        return this.result(await this.reconcile(record)) as unknown as Record<string, unknown>;
    }
}
export async function dispatchNanoOperation(env: NodeJS.ProcessEnv, operation: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (operation === 'message.verify')
        return { valid: verifyNanoMessage(args as any) };
    const wallet = NanoWallet.open({ dataDir: defaultDataDirectory(env) });
    try {
        return await wallet.call(operation, args);
    }
    finally {
        wallet.close();
    }
}
