import { parseJsonObject } from './json.js';
import { isDeepStrictEqual } from 'node:util';
import { NanoStateBlock, MAX_RAW, ZERO_HASH, addressPublicKey, canonicalAddress, canonicalHash, upperHex, validWork, type NanoNetwork } from './protocol.js';
import { parseRelayOffer, relayPaymentPayload, type DurableRelayRequest, type RelayRequest, type RelayTerms, type WalletRelayRequest } from '@attocash/cli/internal-marketplace';
import { NanoRpcClient, DEV_GENESIS_ACCOUNT, DEV_GENESIS_HASH, MAIN_GENESIS_ACCOUNT, MAIN_GENESIS_HASH, requireConfirmedFrontier, type NanoAccountSnapshot, type NanoWorkProvider } from './rpc.js';
import { canonical, defaultDataDirectory, exactKeys, loadConfiguration, positiveRaw, sha256, text, withPrivateKey, type NanoWalletConfiguration } from './configuration.js';
import { signControllerProof, validateControllerProof, verifyNanoMessage, type ControllerProofRequest } from './controller.js';
import { NanoJournal, type JournalRecord } from './journal.js';
import { fail } from './errors.js';
import { checkRelayCandidateTerms, verifyRelayHeader, walletRelayTerms } from './relay.js';
export type NanoRpc = Pick<NanoRpcClient, 'requirePinnedNetwork' | 'accountSnapshot' | 'accountSnapshotOrNotFound' | 'blockInfo' | 'generateWork' | 'generateOpenWork' | 'process' | 'processDevOpen' | 'receivable' | 'receivableExists' | 'verifyFrontierState' | 'validSourceBlock' | 'validConfirmedBlock' | 'requireLoopbackDevelopmentEndpoint'>;
export interface NanoWalletOpenOptions {
    dataDir?: string;
    rpc?: NanoRpc;
    selectWorkProvider?: (configuration: NanoWalletConfiguration) => NanoWorkProvider | undefined;
    now?: () => number;
}
export type NanoRelayRequest = (Omit<RelayRequest, 'index'> & { index?: never }) | (Omit<DurableRelayRequest, 'index'> & { index?: never });
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
    operation: 'payment.prepare';
    args: NanoRelayRequest;
} | {
    operation: 'payment.status';
    args: {
        requestId: string;
    };
} | {
    operation: 'payment.relay.check';
    args: {
        requestId: string;
        transactionHash: string;
    };
} | {
    operation: 'payment.reauthorization.check';
    args: {
        requestId: string;
        transactionHash: string;
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
        this.rpc = options.rpc ?? new NanoRpcClient(this.configuration.rpcUrl, this.configuration.network, this.configuration.workUrl,
            options.selectWorkProvider?.(this.configuration));
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
        if (this.configuration.limits.maxPaymentAtomic !== null && amount > positiveRaw(this.configuration.limits.maxPaymentAtomic, true))
            fail('SPEND_LIMIT');
        this.journal.checkLimit(this.configuration.sourceAddress, this.configuration.network, this.now(), this.rollingLimit());
    }
    private rollingLimit(): bigint | null {
        return this.configuration.limits.rolling24hAtomic === null ? null : positiveRaw(this.configuration.limits.rolling24hAtomic, true);
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
            case 'message.verify': return { valid: verifyMessageArgs(args) };
            case 'transfer.send': return await this.locked(() => this.transfer(args));
            case 'payment.prepare': return await this.locked(() => this.prepareRelay(args));
            case 'payment.status': {
                exactKeys(args, ['requestId']);
                return this.relayStatus(this.requestId(args.requestId));
            }
            case 'payment.relay.check': {
                exactKeys(args, ['requestId', 'transactionHash']);
                const requestId = this.requestId(args.requestId);
                const record = this.journal.find(`transfer:${requestId}`);
                if (!record || record.blockHash !== canonicalHash(text(args.transactionHash, 64))
                    || record.state === 'COMPETING') fail('JOURNAL_CONFLICT');
                const retained = this.relayResult(record);
                if (retained.mode !== 'DURABLE_NATIVE') fail('JOURNAL_CONFLICT');
                // The journal already counts this reservation once in the rolling limit.
                this.requireSigningAuthority(BigInt(record.amount));
                return retained;
            }
            case 'payment.reauthorization.check': {
                exactKeys(args, ['requestId', 'transactionHash']);
                const requestId = this.requestId(args.requestId);
                const record = this.journal.find(`transfer:${requestId}`);
                if (!record || record.blockHash !== canonicalHash(text(args.transactionHash, 64))
                    || !['PREPARED', 'UNKNOWN'].includes(record.state)) fail('JOURNAL_CONFLICT');
                const retained = this.relayResult(record);
                if (!retained.paymentSignature) fail('JOURNAL_CONFLICT');
                this.requireSigningAuthority(BigInt(record.amount));
                return {requestId, origin: retained.origin, audience: retained.audience, terms: retained.terms, hash: record.blockHash};
            }
            case 'transfer.status':
                exactKeys(args, ['requestId']);
                return await this.locked(() => this.transferStatus(this.requestId(args.requestId)));
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
            if (terms.relay !== undefined)
                checkRelayCandidateTerms(terms.relay as WalletRelayRequest, record, this.configuration);
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
    private async transfer(args: Record<string, unknown>, relay?: WalletRelayRequest): Promise<Record<string, unknown>> {
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
                return relay ? this.preparedRelayResult(prior, relay) : await this.publishNative(prior, true);
        }
        if (!this.configuration.grants.externalTransfers)
            fail('PERMISSION_DENIED', 'External Nano transfers require their own local terminal grant.');
        if (this.configuration.limits.maxPaymentAtomic !== null && amount > positiveRaw(this.configuration.limits.maxPaymentAtomic, true))
            fail('SPEND_LIMIT');
        await withPrivateKey(this.configuration, () => undefined);
        await this.rpc.requirePinnedNetwork();
        if (!relay) await this.reconcileDurableLane(id);
        const reservation = this.journal.begin(input, this.now(), this.rollingLimit());
        if (reservation.state !== 'PREPARING')
            return relay ? this.preparedRelayResult(reservation, relay) : await this.publishNative(reservation, true);
        const record = await this.prepareCandidate(reservation, amount, {kind: 'transfer', destination, ...(relay && {relay})});
        return relay ? this.relayResult(record) : this.publishNative(record, false);
    }
    private async prepareRelay(args: Record<string, unknown>): Promise<Record<string, unknown>> {
        exactKeys(args, ['requestId', 'origin', 'audience', 'terms', args.mode === 'DURABLE_NATIVE' ? 'mode' : 'paymentRequired']);
        const request = args as unknown as WalletRelayRequest, prior = this.journal.find(`transfer:${this.requestId(request.requestId)}`);
        const terms = walletRelayTerms(request, this.configuration, Boolean(prior?.blockHash));
        const pending = this.journal.pendingForSource(this.configuration.sourceAddress);
        if (pending?.blockHash && pending.id !== `transfer:${request.requestId}`) {
            await this.rpc.requirePinnedNetwork();
            await this.reconcile(pending);
        }
        return this.transfer({ requestId: request.requestId, network: terms.network, destination: terms.recipientAddress, amountAtomic: terms.amountAtomic }, request);
    }
    private preparedRelayResult(record: JournalRecord, request: WalletRelayRequest): Record<string, unknown> {
        if (request.mode === undefined && !this.journal.relayHeader(record.id) && record.state !== 'COMPETING') {
            // A previous wallet version could stop after persisting the signed SEND.
            const block = this.savedBlock(record);
            this.requireSigningAuthority(BigInt(record.amount));
            this.journal.authorizeRelay(record.id, relayPaymentPayload(parseRelayOffer(request, true), request.requestId, { block: block.toWire() }));
        }
        return this.relayResult(record);
    }
    private relayResult(record: JournalRecord): Record<string, unknown> {
        this.configuredRecord(record);
        const terms = parseJsonObject(record.requestJson), request = terms.relay as WalletRelayRequest;
        if (!request) fail('JOURNAL_CONFLICT');
        walletRelayTerms(request, this.configuration, true);
        const block = record.blockHash ? this.savedBlock(record) : undefined, header = this.journal.relayHeader(record.id);
        const result = { requestId: request.requestId, origin: request.origin, audience: request.audience, terms: request.terms,
            network: record.network, sourceAddress: record.source, destination: record.destination,
            amountAtomic: record.amount, hash: record.blockHash, state: record.state };
        if (request.mode === 'DURABLE_NATIVE') {
            const wire = block ? parseJsonObject(record.blockJson!) : null;
            if (header || (block && !isDeepStrictEqual(wire, block.toWire()))) fail('JOURNAL_CONFLICT');
            return { ...result, mode: request.mode, payload: wire && { block: wire } };
        }
        if (header)
            verifyRelayHeader(request, parseRelayOffer(request, true), block, header);
        return { ...result, paymentRequired: request.paymentRequired, paymentSignature: header ?? null };
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
            this.journal.clearAbandoned(prior);
            prior = this.journal.find(id);
            if (prior?.state === 'PREPARING')
                fail('PAYMENT_IN_PROGRESS');
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
        await this.reconcileDurableLane(id);
        const reservation = this.journal.begin({ id, kind: 'receive', digest: sha256(canonical(terms)), requestJson: canonical(terms), uniqueId: id, source: this.configuration.sourceAddress, network: this.configuration.network, amount: '0', destination: hash }, this.now(), this.rollingLimit());
        if (reservation.state !== 'PREPARING') {
            const result = await this.publishNative(reservation, true);
            return { ...result, amountAtomic: String(amount), replayed: true };
        }
        const record = await this.prepareCandidate(reservation, amount, {kind: 'receive', hash, devOnly});
        return { ...await this.publishNative(record, false), amountAtomic: String(amount), replayed: false };
    }
    private async prepareCandidate(
        reservation: JournalRecord,
        amount: bigint,
        intent: {kind: 'transfer'; destination: string; relay?: WalletRelayRequest} | {kind: 'receive'; hash: string; devOnly: boolean},
    ): Promise<JournalRecord> {
        try {
            const {account, block} = intent.kind === 'transfer'
                ? await this.signTransferCandidate(amount, intent.destination, intent.relay?.mode === 'DURABLE_NATIVE' ? intent.relay.terms : undefined)
                : await this.signReceiveCandidate(amount, intent.hash, intent.devOnly);
            let header: string | undefined;
            if (intent.kind === 'transfer' && intent.relay) {
                this.requireSigningAuthority(amount);
                if (intent.relay.mode === undefined) {
                    header = relayPaymentPayload(parseRelayOffer(intent.relay), intent.relay.requestId, { block: block.toWire() });
                }
            }
            return this.journal.save(reservation.id, {
                epoch: account.epoch, previous: account.frontier, previousBalance: String(account.balance),
                representative: account.representative, blockJson: canonical(block.toWire()), blockHash: block.hash,
            }, header);
        }
        catch (error) {
            this.journal.abort(reservation.id);
            throw error;
        }
    }
    private async signTransferCandidate(amount: bigint, destination: string, terms?: RelayTerms) {
        const account = requireConfirmedFrontier(await this.rpc.accountSnapshot(this.configuration.sourceAddress));
        const prior = await this.rpc.verifyFrontierState(account, this.configuration.sourceAddress);
        if (terms) {
            const baseline = BigInt(terms.baselineHeight);
            if (prior.height === undefined || prior.height < baseline
                || (prior.height === baseline && terms.baselineFrontier !== null && account.frontier !== terms.baselineFrontier.toUpperCase())) {
                fail('NATIVE_BASELINE_UNAVAILABLE', 'The confirmed Nano frontier differs from the frozen payment baseline.');
            }
        }
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
        return {account, block};
    }
    private async signReceiveCandidate(amount: bigint, hash: string, devOnly: boolean) {
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
        return {account, block};
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
    private async relayStatus(requestId: string): Promise<Record<string, unknown>> {
        const id = `transfer:${requestId}`;
        if (!this.journal.find(id))
            return this.unsignedRelayStatus(id, requestId);
        return this.locked(async () => {
            const record = this.journal.find(id);
            if (!record)
                return this.unsignedRelayStatus(id, requestId);
            this.configuredRecord(record);
            const relay = parseJsonObject(record.requestJson).relay as WalletRelayRequest | undefined;
            if (!relay) fail('JOURNAL_CONFLICT');
            if (record.state === 'PREPARING' || relay.mode === 'DURABLE_NATIVE')
                return this.relayResult(record);
            await this.reconcileStatus(record);
            return this.relayResult(this.journal.find(id)!);
        });
    }
    private unsignedRelayStatus(id: string, requestId: string): Record<string, unknown> {
        const request = this.journal.relayIntent(id);
        if (!request) return { requestId, state: 'NOT_FOUND' };
        const terms = walletRelayTerms(request, this.configuration, true);
        const result = { requestId, origin:request.origin, audience:request.audience, terms, state:'PREPARING', hash:null };
        return request.mode === 'DURABLE_NATIVE' ? { ...result, mode:request.mode, payload:null }
            : { ...result, paymentRequired:request.paymentRequired, paymentSignature:null };
    }
    private async transferStatus(requestId: string): Promise<Record<string, unknown>> {
        const id = `transfer:${requestId}`;
        const record = this.journal.find(id);
        if (!record)
            fail('NOT_FOUND');
        this.configuredRecord(record);
        if (parseJsonObject(record.requestJson).relay !== undefined)
            fail('NOT_FOUND');
        if (record.state === 'PREPARING') {
            if (this.journal.clearAbandoned(record))
                return { ...this.result(record), state: 'READY', candidateState: 'ABSENT', sendHash: null };
            fail('PAYMENT_IN_PROGRESS');
        }
        return this.result(await this.reconcileStatus(record)) as unknown as Record<string, unknown>;
    }
    private async reconcileStatus(record: JournalRecord): Promise<JournalRecord> {
        this.savedBlock(record);
        if (['CONFIRMED', 'COMPETING'].includes(record.state))
            return record;
        await this.rpc.requirePinnedNetwork();
        return this.reconcile(record);
    }

    private async reconcileDurableLane(id: string): Promise<void> {
        // Durable status can return the saved candidate while native RPC is unavailable.
        // A new write still needs chain evidence before reusing that source lane.
        const pending = this.journal.pendingForSource(this.configuration.sourceAddress);
        if (!pending?.blockHash || pending.id === id) return;
        const relay = parseJsonObject(pending.requestJson).relay as WalletRelayRequest | undefined;
        if (relay?.mode === 'DURABLE_NATIVE') await this.reconcile(pending);
    }
}
export async function dispatchNanoOperation(env: NodeJS.ProcessEnv, operation: string, args: Record<string, unknown> = {},
    selectWorkProvider?: NanoWalletOpenOptions['selectWorkProvider']): Promise<Record<string, unknown>> {
    if (operation === 'message.verify')
        return { valid: verifyMessageArgs(args) };
    const wallet = NanoWallet.open({ dataDir: defaultDataDirectory(env), ...(selectWorkProvider && { selectWorkProvider }) });
    try {
        return await wallet.call(operation, args);
    }
    finally {
        wallet.close();
    }
}

function verifyMessageArgs(args: unknown): boolean {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
    const record = args as Record<string, unknown>;
    if (Object.keys(record).length !== 3 || typeof record.address !== 'string'
        || typeof record.message !== 'string' || typeof record.signature !== 'string') {
        return false;
    }
    return verifyNanoMessage({ address: record.address, message: record.message, signature: record.signature });
}
