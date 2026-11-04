import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NanoStateBlock, MAX_RAW, ZERO_HASH, addressPublicKey, canonicalAddress, canonicalHash, upperHex, validWork, type NanoNetwork } from './protocol.js';
import { NanoRpcClient, DEV_GENESIS_ACCOUNT, DEV_GENESIS_HASH, MAIN_GENESIS_ACCOUNT, MAIN_GENESIS_HASH, parseJsonObject, requireConfirmedFrontier, type NanoAccountSnapshot, type NanoConfirmedAccount } from './rpc.js';
import { canonical, defaultDataDirectory, exactKeys, loadConfiguration, object, positiveRaw, sha256, text, withPrivateKey, type NanoWalletConfiguration } from './configuration.js';
import { signControllerProof, validateControllerProof, verifyNanoMessage, type ControllerProofRequest } from './controller.js';
import { HANDLE, UUID, buildPaymentResponse, instant, parsePaymentRequest, validatePaymentResponse, type PaymentRequest } from './handoff.js';
import { NanoJournal, type JournalRecord } from './journal.js';
import { publishPrivate, readPrivate } from './private-files.js';
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
    operation: 'payment.prepare' | 'payment.status';
    args: {
        handoffId: string;
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
    handoffId?: string;
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
        this.rpc = options.rpc ?? new NanoRpcClient(this.configuration.rpcUrl, this.configuration.network);
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
    private requireSigningAuthority(kind: 'payment' | 'transfer', amount: bigint): void {
        this.refreshPolicy();
        if (!(kind === 'payment' ? this.configuration.grants.marketplaceFunding : this.configuration.grants.externalTransfers))
            fail('PERMISSION_DENIED');
        if (amount > positiveRaw(this.configuration.limits.maxPaymentAtomic, true))
            fail('SPEND_LIMIT');
        this.journal.checkLimit(this.configuration.sourceAddress, this.configuration.network, this.now(), positiveRaw(this.configuration.limits.rolling24hAtomic, true));
    }
    private requireReceiveAuthority(): void {
        this.refreshPolicy();
        if (!this.configuration.grants.marketplaceFunding && !this.configuration.grants.externalTransfers)
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
            case 'payment.prepare':
                exactKeys(args, ['handoffId']);
                return await this.locked(() => this.preparePayment(text(args.handoffId, 32)));
            case 'payment.status':
                exactKeys(args, ['handoffId']);
                return await this.locked(() => this.status(`payment:${this.handle(args.handoffId)}`));
            case 'transfer.send': return await this.locked(() => this.transfer(args));
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
    private handle(value: unknown): string {
        const handle = text(value, 32);
        if (!HANDLE.test(handle))
            fail('INVALID_REQUEST');
        return handle;
    }
    private requestId(value: unknown): string {
        const id = text(value, 36);
        if (!UUID.test(id))
            fail('INVALID_REQUEST');
        return id;
    }
    private result(record: JournalRecord): NanoOperationResult {
        return { ...(record.kind === 'payment' ? { handoffId: record.id.slice(8), requestSha256: parseJsonObject(record.requestJson).requestSha256 as string } : { requestId: record.id.slice(record.kind.length + 1) }), state: record.state, network: this.configuration.network, sourceAddress: this.configuration.sourceAddress,
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
        if (record.kind === 'payment') {
            const request = parsePaymentRequest(terms, this.configuration, this.now(), true, true);
            if (record.id !== `payment:${request.handoffId}` ||
                record.uniqueId !== `payment:${request.intentId}` ||
                record.amount !== request.raw.amountAtomic ||
                record.destination !== request.destination ||
                !record.responseJson)
                fail('JOURNAL_CONFLICT');
            const checked = validatePaymentResponse(parseJsonObject(record.responseJson), request, this.configuration, previousBalance, record.epoch);
            if (canonical(checked.toWire()) !== record.blockJson || record.deadline !== parseJsonObject(record.responseJson).signedDeadline)
                fail('JOURNAL_CONFLICT');
        }
        else if (record.kind === 'transfer') {
            exactKeys(terms, ['network', 'destination', 'amountAtomic', 'requestId']);
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
    private async preparePayment(handleValue: string): Promise<Record<string, unknown>> {
        const handoff = this.handle(handleValue), config = this.configuration, id = `payment:${handoff}`;
        const raw = parseJsonObject(readPrivate(join(config.handoffDirectory, `${handoff}.request.json`)).toString('utf8'));
        const request = parsePaymentRequest(raw, config, this.now(), true, true);
        if (request.handoffId !== handoff)
            fail('INVALID_REQUEST');
        const input = { id, kind: 'payment' as const, digest: sha256(canonical(raw)), requestJson: canonical(raw), uniqueId: `payment:${request.intentId}`, source: config.sourceAddress, network: config.network, amount: request.raw.amountAtomic as string, destination: request.destination };
        const prior = this.journal.find(id);
        if (prior) {
            this.journal.requireTerms(prior, input);
            if (prior.state !== 'PREPARING')
                return await this.resumePayment(prior, request);
        }
        if (!config.grants.marketplaceFunding)
            fail('PERMISSION_DENIED', 'Marketplace funding is not approved for this private Nano wallet.');
        parsePaymentRequest(raw, config, this.now());
        await withPrivateKey(config, () => undefined);
        await this.rpc.requirePinnedNetwork();
        const reservation = this.journal.begin(input, this.now(), positiveRaw(config.limits.rolling24hAtomic, true));
        if (reservation.state !== 'PREPARING')
            return await this.resumePayment(reservation, request);
        let durable = false;
        try {
            const snapshot = await this.rpc.accountSnapshot(config.sourceAddress), account = requireConfirmedFrontier(snapshot);
            await this.rpc.verifyFrontierState(account, config.sourceAddress);
            if (account.balance < request.amount)
                fail('INSUFFICIENT_FUNDS');
            const deadline = request.raw.expiresAt as string, work = await this.rpc.generateWork(account.frontier, 2);
            if (instant(deadline) <= this.now())
                fail('PAYMENT_EXPIRED');
            this.requireSigningAuthority('payment', request.amount);
            const { block, response } = await withPrivateKey(this.configuration, key => {
                this.requireSigningAuthority('payment', request.amount);
                if (instant(deadline) <= this.now()) fail('PAYMENT_EXPIRED');
                const block = NanoStateBlock.signed(key, account.frontier, account.representative, account.balance - request.amount, upperHex(addressPublicKey(request.destination)), work);
                if (!validWork(config.network, 2, false, block.workRoot(), block.work))
                    fail('RPC_UNAVAILABLE');
                const response = buildPaymentResponse(request, block, deadline, key);
                validatePaymentResponse(response, request, config, account.balance, account.epoch);
                return { block, response };
            });
            if (instant(deadline) <= this.now())
                fail('PAYMENT_EXPIRED');
            const record = this.journal.save(id, { epoch: account.epoch, previous: account.frontier, previousBalance: account.balance.toString(), representative: account.representative, blockJson: canonical(block.toWire()), blockHash: block.hash, responseJson: canonical(response), deadline });
            durable = true;
            const after = await this.rpc.accountSnapshot(config.sourceAddress);
            if (!this.matches(after, record) || instant(deadline) <= this.now())
                return this.result(this.journal.state(id, 'UNKNOWN', this.now())) as unknown as Record<string, unknown>;
            publishPrivate(join(config.handoffDirectory, `${handoff}.response.json`), Buffer.from(`${record.responseJson}\n`));
            return this.result(record) as unknown as Record<string, unknown>;
        }
        catch (error) {
            if (!durable)
                this.journal.abort(id);
            throw error;
        }
    }
    private async resumePayment(record: JournalRecord, request: PaymentRequest): Promise<Record<string, unknown>> {
        this.savedBlock(record);
        if (['CONFIRMED', 'COMPETING'].includes(record.state))
            return this.result(record) as unknown as Record<string, unknown>;
        await this.rpc.requirePinnedNetwork();
        if (record.state === 'UNKNOWN')
            return this.result(await this.reconcile(record)) as unknown as Record<string, unknown>;
        const current = await this.rpc.accountSnapshot(record.source);
        if (!this.matches(current, record) || !record.deadline || instant(record.deadline) <= this.now())
            return this.result(await this.reconcile(this.journal.state(record.id, 'UNKNOWN', this.now()))) as unknown as Record<string, unknown>;
        publishPrivate(join(this.configuration.handoffDirectory, `${request.handoffId}.response.json`), Buffer.from(`${record.responseJson}\n`));
        return this.result(record) as unknown as Record<string, unknown>;
    }
    private async transfer(args: Record<string, unknown>): Promise<Record<string, unknown>> {
        this.requireNetwork(args, ['network', 'destination', 'amountAtomic', 'requestId']);
        const id = `transfer:${this.requestId(args.requestId)}`, amount = positiveRaw(args.amountAtomic), destination = canonicalAddress(text(args.destination, 128));
        if (destination !== args.destination || destination === this.configuration.sourceAddress)
            fail('INVALID_REQUEST');
        const input = { id, kind: 'transfer' as const, digest: sha256(canonical(args)), requestJson: canonical(args), uniqueId: id, source: this.configuration.sourceAddress, network: this.configuration.network, amount: String(amount), destination };
        const prior = this.journal.find(id);
        if (prior) {
            this.journal.requireTerms(prior, input);
            if (prior.state !== 'PREPARING')
                return await this.publishNative(prior, true);
        }
        if (!this.configuration.grants.externalTransfers)
            fail('PERMISSION_DENIED', 'External Nano transfers require their own local terminal grant.');
        if (amount > positiveRaw(this.configuration.limits.maxPaymentAtomic, true))
            fail('SPEND_LIMIT');
        await withPrivateKey(this.configuration, () => undefined);
        await this.rpc.requirePinnedNetwork();
        const reservation = this.journal.begin(input, this.now(), positiveRaw(this.configuration.limits.rolling24hAtomic, true));
        if (reservation.state !== 'PREPARING')
            return await this.publishNative(reservation, true);
        let durable = false;
        try {
            const account = requireConfirmedFrontier(await this.rpc.accountSnapshot(this.configuration.sourceAddress));
            await this.rpc.verifyFrontierState(account, this.configuration.sourceAddress);
            if (account.balance < amount)
                fail('INSUFFICIENT_FUNDS');
            const work = await this.rpc.generateWork(account.frontier, 2);
            this.requireSigningAuthority('transfer', amount);
            const block = await withPrivateKey(this.configuration, key => {
                this.requireSigningAuthority('transfer', amount);
                return NanoStateBlock.signed(key, account.frontier, account.representative, account.balance - amount, upperHex(addressPublicKey(destination)), work);
            });
            if (!validWork(this.configuration.network, 2, false, block.workRoot(), block.work))
                fail('RPC_UNAVAILABLE');
            const record = this.journal.save(id, { epoch: account.epoch, previous: account.frontier, previousBalance: account.balance.toString(), representative: account.representative, blockJson: canonical(block.toWire()), blockHash: block.hash, responseJson: null, deadline: null });
            durable = true;
            return await this.publishNative(record, false);
        }
        catch (error) {
            if (!durable)
                this.journal.abort(id);
            throw error;
        }
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
            const record = this.journal.save(id, { epoch: account.epoch, previous: account.frontier, previousBalance: String(account.balance), representative: account.representative, blockJson: canonical(block.toWire()), blockHash: block.hash, responseJson: null, deadline: null });
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
