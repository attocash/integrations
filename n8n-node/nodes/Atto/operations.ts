/* eslint-disable @n8n/community-nodes/no-restricted-globals */
/* eslint-disable @n8n/community-nodes/no-restricted-imports */
/* eslint-disable @n8n/community-nodes/require-node-api-error */
import { createHash } from 'node:crypto';
import {
	AttoAddress,
	AttoAlgorithm,
	AttoAmount,
	AttoHash,
	AttoMnemonic,
	AttoPrivateKey,
	AttoUnit,
	privateKeyToSigner,
	toAttoHeight,
	toAttoIndex,
	toPrivateKey,
	toPublicKey,
	toSeedAsync,
	type AttoAccount,
	type AttoAccountEntry,
	type AttoHeight,
	type AttoReceivable,
	type AttoTransaction,
} from '@attocash/commons-core';
import {
	AccountHeightSearch,
	HeightSearch,
	accountEntryToJson,
	accountToJson,
	receivableFromJson,
	receivableToJson,
	transactionToJson,
} from '@attocash/commons-node';
import { AttoNodeClientAsyncBuilder, type AttoNodeClientAsync } from '@attocash/commons-node-remote';
import { AttoWalletAsyncBuilder } from '@attocash/commons-wallet';
import { AttoWorkerAsyncBuilder, type AttoWorkerAsync } from '@attocash/commons-worker-remote';
import type { ICredentialDataDecryptedObject, IDataObject } from 'n8n-workflow';

export type AttoOperation =
	| 'deriveAddress'
	| 'deriveAccount'
	| 'getAccount'
	| 'getReceivables'
	| 'getTransactions'
	| 'sendTransaction'
	| 'receivePending'
	| 'getAccountEntries'
	| 'changeRepresentative';

export type AttoTriggerEvent = 'receivable' | 'account' | 'transaction' | 'accountEntry';

type SecretType = 'mnemonic' | 'privateKey';
type AddressSource = 'credentials' | 'manual' | 'all';
type StreamQueryMode = 'credentials' | 'manual' | 'all' | 'hash';

export type AttoParameters = Record<string, unknown>;
export type AttoOperationResult = IDataObject | IDataObject[];

const DEFAULT_STREAM_TIMEOUT_MS = 5000;
const DEFAULT_PUBLISH_TIMEOUT_MS = 60000;
const MAX_WORKER_CLIENT_CACHE_SIZE = 32;

const workerClientCache = new Map<string, AttoWorkerAsync>();

type AttoCredentials = {
	nodeUrl?: string;
	workerUrl?: string;
	apiKey?: string;
	authHeaderName?: string;
	authHeaderPrefix?: string;
	walletMaterialType?: SecretType;
	walletSecret?: string;
	keyIndex?: number | string;
};

type DerivedAddress = {
	secretType: SecretType;
	keyIndex: number;
	privateKey: AttoPrivateKey;
	publicKey: ReturnType<typeof toPublicKey>;
	address: AttoAddress;
	seed?: Awaited<ReturnType<typeof toSeedAsync>>;
};

type AttoJob = {
	cancel?: () => void;
	close?: () => void;
};

type StreamStarter<T> = (onItem: (item: T) => void, onCancel: (error?: Error | null) => void) => AttoJob;

export type AttoTriggerSubscription = {
	close: () => void;
};

function normalizeCredentials(credentials: ICredentialDataDecryptedObject | undefined): AttoCredentials {
	return (credentials ?? {}) as AttoCredentials;
}

function text(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function optionalText(value: unknown): string | undefined {
	const normalized = text(value);
	return normalized ? normalized : undefined;
}

function positiveInteger(value: unknown, fieldName: string): number {
	const numberValue = typeof value === 'number' ? value : Number(value);

	if (!Number.isInteger(numberValue) || numberValue < 0) {
		throw new Error(`${fieldName} must be a non-negative integer`);
	}

	return numberValue;
}

function positiveTimeout(value: unknown, fieldName: string): number {
	const timeoutMs = positiveInteger(value, fieldName);
	if (timeoutMs < 1) throw new Error(`${fieldName} must be greater than zero`);
	return timeoutMs;
}

function parseSecretType(value: unknown, fieldName: string): SecretType {
	if (value === 'mnemonic' || value === 'privateKey') return value;
	throw new Error(`${fieldName} must be either mnemonic or privateKey`);
}

function secretInput(
	parameters: AttoParameters,
	credentials: AttoCredentials,
): { secretType: SecretType; walletSecret: string; keyIndex: number } {
	const source = text(parameters.secretSource || 'credentials');

	if (source === 'node') {
		const walletSecret = text(parameters.walletSecret);
		if (!walletSecret) throw new Error('Wallet Secret is required');

		return {
			secretType: parseSecretType(parameters.walletSecretType ?? 'mnemonic', 'Wallet Secret Type'),
			walletSecret,
			keyIndex: positiveInteger(parameters.keyIndex ?? 0, 'Key Index'),
		};
	}

	const walletSecret = text(credentials.walletSecret);
	if (!walletSecret) throw new Error('Atto credentials must include a Wallet Secret');

	return {
		secretType: parseSecretType(credentials.walletMaterialType ?? 'mnemonic', 'Credential Wallet Secret Type'),
		walletSecret,
		keyIndex: positiveInteger(credentials.keyIndex ?? 0, 'Credential Key Index'),
	};
}

export async function deriveAddressFromSecret(
	parameters: AttoParameters,
	credentials?: ICredentialDataDecryptedObject,
): Promise<DerivedAddress> {
	const input = secretInput(parameters, normalizeCredentials(credentials));
	const index = toAttoIndex(input.keyIndex);

	if (input.secretType === 'mnemonic') {
		const mnemonic = AttoMnemonic.fromPhrase(input.walletSecret);
		const seed = await toSeedAsync(mnemonic);
		const privateKey = toPrivateKey(seed, index);
		const publicKey = toPublicKey(privateKey);
		const address = new AttoAddress(AttoAlgorithm.V1, publicKey);

		return {
			secretType: input.secretType,
			keyIndex: input.keyIndex,
			privateKey,
			publicKey,
			address,
			seed,
		};
	}

	const privateKey = AttoPrivateKey.Companion.parse(input.walletSecret);
	const publicKey = toPublicKey(privateKey);
	const address = new AttoAddress(AttoAlgorithm.V1, publicKey);

	return {
		secretType: input.secretType,
		keyIndex: input.keyIndex,
		privateKey,
		publicKey,
		address,
	};
}

export const deriveAccountFromSecret = deriveAddressFromSecret;

function requireNodeUrl(credentials: AttoCredentials): string {
	const nodeUrl = text(credentials.nodeUrl);
	if (!nodeUrl) throw new Error('Atto credentials must include a Node Base URL');
	return nodeUrl.replace(/\/+$/, '');
}

function requireWorkerUrl(credentials: AttoCredentials): string {
	const workerUrl = text(credentials.workerUrl);
	if (!workerUrl) throw new Error('Atto credentials must include a Worker Base URL');
	return workerUrl.replace(/\/+$/, '');
}

function applyHeaders<T extends { header(name: string, value: string): T }>(
	builder: T,
	credentials: AttoCredentials,
): T {
	const apiKey = text(credentials.apiKey);
	if (!apiKey) return builder;

	const header = text(credentials.authHeaderName || 'Authorization');
	if (!header) throw new Error('API Key Header is required when API Key is set');

	const prefix = text(credentials.authHeaderPrefix);
	return builder.header(header, prefix ? `${prefix} ${apiKey}` : apiKey);
}

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function workerClientCacheKey(credentials: AttoCredentials): string {
	const workerUrl = requireWorkerUrl(credentials);
	const apiKey = text(credentials.apiKey);

	if (!apiKey) {
		return JSON.stringify({
			workerUrl,
			auth: 'none',
		});
	}

	const header = text(credentials.authHeaderName || 'Authorization');
	if (!header) throw new Error('API Key Header is required when API Key is set');

	const prefix = text(credentials.authHeaderPrefix);
	const headerValue = prefix ? `${prefix} ${apiKey}` : apiKey;

	return JSON.stringify({
		workerUrl,
		header,
		headerValueHash: sha256(headerValue),
	});
}

export function createNodeClient(credentials: ICredentialDataDecryptedObject | AttoCredentials | undefined): AttoNodeClientAsync {
	const attoCredentials = normalizeCredentials(credentials as ICredentialDataDecryptedObject | undefined);
	return applyHeaders(new AttoNodeClientAsyncBuilder(requireNodeUrl(attoCredentials)), attoCredentials).build();
}

export function createWorkerClient(credentials: ICredentialDataDecryptedObject | AttoCredentials | undefined): AttoWorkerAsync {
	const attoCredentials = normalizeCredentials(credentials as ICredentialDataDecryptedObject | undefined);
	const cacheKey = workerClientCacheKey(attoCredentials);
	const cachedWorker = workerClientCache.get(cacheKey);
	if (cachedWorker) return cachedWorker;

	const worker = applyHeaders(new AttoWorkerAsyncBuilder(requireWorkerUrl(attoCredentials)), attoCredentials)
		.cached(true)
		.build();

	if (workerClientCache.size >= MAX_WORKER_CLIENT_CACHE_SIZE) {
		const oldestKey = workerClientCache.keys().next().value;
		if (typeof oldestKey === 'string') workerClientCache.delete(oldestKey);
	}

	workerClientCache.set(cacheKey, worker);
	return worker;
}

export function clearWorkerClientCache(): void {
	for (const worker of workerClientCache.values()) {
		try {
			(worker as { close?: () => void }).close?.();
		} catch {
			// The remote worker close hook is best-effort and currently a no-op in Atto Commons.
		}
	}

	workerClientCache.clear();
}

async function createWalletRuntime(
	parameters: AttoParameters,
	credentials: AttoCredentials,
): Promise<{
	node: AttoNodeClientAsync;
	derived: DerivedAddress;
	wallet: ReturnType<AttoWalletAsyncBuilder['build']>;
}> {
	const derived = await deriveAddressFromSecret(parameters, credentials as ICredentialDataDecryptedObject);
	const node = createNodeClient(credentials);
	const worker = createWorkerClient(credentials);

	const builder = new AttoWalletAsyncBuilder(node as never, worker as never);
	if (derived.seed) {
		builder.signerProviderSeed(derived.seed as never);
	} else {
		builder.signerProviderFunction({
			get: async () => privateKeyToSigner(derived.privateKey) as never,
		} as never);
	}

	const wallet = builder.build();
	await wallet.openAccount(toAttoIndex(derived.keyIndex) as never);

	return { node, derived, wallet };
}

function parseAddress(value: unknown, fieldName: string): AttoAddress {
	const raw = text(value);
	if (!raw) throw new Error(`${fieldName} is required`);

	try {
		return AttoAddress.parse(raw);
	} catch {
		throw new Error(`${fieldName} must be a valid Atto address`);
	}
}

function parseOptionalAddress(value: unknown, fieldName: string): AttoAddress | undefined {
	const raw = optionalText(value);
	return raw ? parseAddress(raw, fieldName) : undefined;
}

function parseAddressList(value: unknown, fieldName: string): AttoAddress[] {
	const raw =
		typeof value === 'string'
			? value
			: Array.isArray(value)
				? value.join('\n')
				: '';
	const addresses = raw
		.split(/[\n,]+/)
		.map((address) => address.trim())
		.filter(Boolean)
		.map((address) => parseAddress(address, fieldName));

	if (addresses.length === 0) throw new Error(`${fieldName} is required`);
	return addresses;
}

function parseAddressSource(value: unknown, allowAll: boolean): AddressSource {
	const source = text(value || 'credentials');
	if (source === 'credentials' || source === 'manual') return source;
	if (allowAll && source === 'all') return source;
	throw new Error('Address Source must be credentials, manual, or all');
}

function parseQueryMode(value: unknown): StreamQueryMode {
	const mode = text(value || 'credentials');
	if (mode === 'credentials' || mode === 'manual' || mode === 'all' || mode === 'hash') return mode;
	throw new Error('Query Mode must be credentials, manual, all, or hash');
}

async function addressesFromSource(
	parameters: AttoParameters,
	credentials: AttoCredentials,
	allowAll = false,
): Promise<AttoAddress[] | undefined> {
	const source = parseAddressSource(parameters.addressSource, allowAll);
	if (source === 'all') return undefined;
	if (source === 'manual') return parseAddressList(parameters.addresses ?? parameters.address, 'Address');

	const derived = await deriveAddressFromSecret({ secretSource: 'credentials' }, credentials as ICredentialDataDecryptedObject);
	return [derived.address];
}

async function addressForCredentials(credentials: AttoCredentials): Promise<AttoAddress> {
	const derived = await deriveAddressFromSecret({ secretSource: 'credentials' }, credentials as ICredentialDataDecryptedObject);
	return derived.address;
}

function parseAmount(amount: unknown, unit: unknown, fieldName: string): AttoAmount {
	const raw = text(amount);
	if (!raw) throw new Error(`${fieldName} is required`);

	try {
		const amountValue =
			text(unit).toUpperCase() === 'RAW'
				? AttoAmount.from(AttoUnit.RAW, raw)
				: AttoAmount.from(AttoUnit.ATTO, raw);

		if (amountValue.toString() === '0') {
			throw new Error('zero');
		}

		return amountValue;
	} catch {
		throw new Error(`${fieldName} must be a positive Atto amount`);
	}
}

function parseOptionalAmount(amount: unknown, unit: unknown, fieldName: string): AttoAmount | undefined {
	const raw = optionalText(amount);
	return raw ? parseAmount(raw, unit, fieldName) : undefined;
}

function parseHash(value: unknown, fieldName: string): AttoHash {
	const raw = text(value);
	if (!raw) throw new Error(`${fieldName} is required`);

	try {
		return AttoHash.Companion.parse(raw);
	} catch {
		throw new Error(`${fieldName} must be a valid Atto hash`);
	}
}

function parseOptionalHeight(value: unknown, fieldName: string): AttoHeight | undefined {
	const raw = optionalText(value);
	if (!raw) return undefined;

	try {
		return toAttoHeight(raw);
	} catch {
		throw new Error(`${fieldName} must be a valid Atto height`);
	}
}

function parseRequiredHeight(value: unknown, fieldName: string): AttoHeight {
	return parseOptionalHeight(value, fieldName) ?? toAttoHeight('1');
}

function assertSameAddress(expected: AttoAddress, actual: AttoAddress, fieldName: string) {
	if (!expected.equals(actual)) {
		throw new Error(`${fieldName} must match the address derived from the wallet secret`);
	}
}

function assertOptionalSameAddress(expected: AttoAddress, actual: AttoAddress | undefined, fieldName: string) {
	if (actual) assertSameAddress(expected, actual, fieldName);
}

function parseJsonObject(value: string): IDataObject {
	return JSON.parse(value) as IDataObject;
}

function amountOutput(amount: AttoAmount): IDataObject {
	return {
		raw: amount.toString(),
		atto: amount.toFormattedString(AttoUnit.ATTO),
	};
}

function accountOutput(account: AttoAccount): IDataObject {
	return {
		found: true,
		address: account.address.value,
		publicKey: account.publicKey.toString(),
		balance: amountOutput(account.balance),
		representativeAddress: account.representativeAddress.value,
		height: account.height.toString(),
		frontier: account.lastTransactionHash.toString(),
		account: parseJsonObject(accountToJson(account as never)),
	};
}

function receivableOutput(receivable: AttoReceivable): IDataObject {
	return {
		hash: receivable.hash.toString(),
		address: receivable.receiverAddress.value,
		fromAddress: receivable.address.value,
		amount: amountOutput(receivable.amount),
		receivable: parseJsonObject(receivableToJson(receivable as never)),
	};
}

function transactionOutput(transaction: AttoTransaction, status?: string): IDataObject {
	return {
		...(status ? { status } : {}),
		hash: transaction.hash.toString(),
		address: transaction.address.value,
		height: transaction.height.toString(),
		transaction: parseJsonObject(transactionToJson(transaction as never)),
	};
}

function accountEntryOutput(accountEntry: AttoAccountEntry): IDataObject {
	return {
		hash: accountEntry.hash.toString(),
		address: accountEntry.address.value,
		subjectAddress: accountEntry.subjectAddress.value,
		height: accountEntry.height.toString(),
		blockType: accountEntry.blockType.name,
		previousBalance: amountOutput(accountEntry.previousBalance),
		balance: amountOutput(accountEntry.balance),
		accountEntry: parseJsonObject(accountEntryToJson(accountEntry as never)),
	};
}

function streamOptions(parameters: AttoParameters): { maxItems: number; timeoutMs: number } {
	return {
		maxItems: positiveInteger(parameters.maxItems ?? 25, 'Max Items') || 1,
		timeoutMs: positiveTimeout(parameters.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS, 'Timeout'),
	};
}

function cancelJob(job: AttoJob | undefined) {
	try {
		job?.cancel?.();
		job?.close?.();
	} catch {
		// Stream cleanup is best effort after collection completes.
	}
}

function errorFromUnknown(error: unknown, fallback: string): Error {
	if (!error) return new Error(fallback);
	if (error instanceof Error) return error;
	return new Error(String(error));
}

async function collectStream<T>(start: StreamStarter<T>, options: { maxItems: number; timeoutMs: number }): Promise<T[]> {
	return await new Promise((resolve, reject) => {
		const items: T[] = [];
		let settled = false;
		const state: { job?: AttoJob } = {};

		const finish = (error?: Error | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			cancelJob(state.job);

			if (error) {
				reject(error);
				return;
			}

			resolve(items);
		};

		const timer = setTimeout(() => finish(), options.timeoutMs);

		state.job = start(
			(item) => {
				if (settled) return;
				items.push(item);
				if (items.length >= options.maxItems) finish();
			},
			(error) => {
				if (settled) return;
				finish(error ? errorFromUnknown(error, 'Atto stream stopped') : undefined);
			},
		);
	});
}

function inputItem(parameters: AttoParameters): IDataObject {
	const item = parameters.inputItem;
	if (!item || typeof item !== 'object' || Array.isArray(item)) {
		throw new Error('Input item must contain a receivable object from Atto Trigger or Get Receivables');
	}

	return item as IDataObject;
}

function parseInputReceivable(parameters: AttoParameters): AttoReceivable {
	const item = inputItem(parameters);
	const value = item.receivable ?? item;
	const json = typeof value === 'string' ? value : JSON.stringify(value);

	try {
		return receivableFromJson(json) as never;
	} catch {
		throw new Error('Input item must contain a valid Atto receivable object');
	}
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operationName: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;

	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${operationName} timed out after ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function heightSearch(addresses: AttoAddress[], parameters: AttoParameters): HeightSearch {
	const fromHeight = parseRequiredHeight(parameters.fromHeight, 'From Height');
	const toHeight = parseOptionalHeight(parameters.toHeight, 'To Height');
	const searches = addresses.map(
		(address) => new AccountHeightSearch(address as never, fromHeight as never, toHeight as never),
	);

	return HeightSearch.Companion.fromArray(searches as never);
}

async function collectReceivables(
	node: AttoNodeClientAsync,
	parameters: AttoParameters,
	credentials: AttoCredentials,
): Promise<IDataObject[]> {
	const addresses = await addressesFromSource(parameters, credentials);
	const minAmount = parseOptionalAmount(parameters.minAmount, parameters.minAmountUnit ?? 'RAW', 'Minimum Amount');
	const options = streamOptions(parameters);
	const receivables = await collectStream<AttoReceivable>(
		(onItem, onCancel) =>
			node.onReceivableByAddresses(addresses as never, minAmount as never, onItem as never, onCancel as never) as AttoJob,
		options,
	);

	return receivables.map(receivableOutput);
}

async function collectTransactionsForMode(
	node: AttoNodeClientAsync,
	parameters: AttoParameters,
	credentials: AttoCredentials,
): Promise<IDataObject[]> {
	const mode = parseQueryMode(parameters.queryMode);

	if (mode === 'hash') {
		const transaction = await node.transaction(parseHash(parameters.hash, 'Hash') as never);
		return [transactionOutput(transaction as never)];
	}

	const addresses = mode === 'credentials' ? [await addressForCredentials(credentials)] : mode === 'manual' ? parseAddressList(parameters.addresses ?? parameters.address, 'Address') : undefined;
	const fromHeight = parseOptionalHeight(parameters.fromHeight, 'From Height');
	const toHeight = parseOptionalHeight(parameters.toHeight, 'To Height');
	const options = streamOptions(parameters);
	const transactions = await collectStream<AttoTransaction>(
		(onItem, onCancel) =>
			subscribeToTransactionAddresses(node, addresses, fromHeight, toHeight, parameters, onItem, onCancel),
		options,
	);

	return transactions.map((transaction) => transactionOutput(transaction));
}

async function collectAccountEntries(
	node: AttoNodeClientAsync,
	parameters: AttoParameters,
	credentials: AttoCredentials,
): Promise<IDataObject[]> {
	const mode = parseQueryMode(parameters.queryMode);

	if (mode === 'hash') {
		const accountEntry = await node.accountEntry(parseHash(parameters.hash, 'Hash') as never);
		return [accountEntryOutput(accountEntry as never)];
	}

	const addresses = mode === 'credentials' ? [await addressForCredentials(credentials)] : mode === 'manual' ? parseAddressList(parameters.addresses ?? parameters.address, 'Address') : undefined;
	const fromHeight = parseOptionalHeight(parameters.fromHeight, 'From Height');
	const toHeight = parseOptionalHeight(parameters.toHeight, 'To Height');
	const options = streamOptions(parameters);
	const accountEntries = await collectStream<AttoAccountEntry>(
		(onItem, onCancel) =>
			subscribeToAccountEntryAddresses(node, addresses, fromHeight, toHeight, parameters, onItem, onCancel),
		options,
	);

	return accountEntries.map((accountEntry) => accountEntryOutput(accountEntry));
}

function subscribeToTransactionAddresses(
	node: AttoNodeClientAsync,
	addresses: AttoAddress[] | undefined,
	fromHeight: AttoHeight | undefined,
	toHeight: AttoHeight | undefined,
	parameters: AttoParameters,
	onItem: (item: AttoTransaction) => void,
	onCancel: (error?: Error | null) => void,
): AttoJob {
	if (!addresses) return node.onTransactionAll(onItem as never, onCancel as never) as AttoJob;
	if (addresses.length === 1) {
		return node.onTransactionByPublicKey(
			addresses[0].publicKey as never,
			fromHeight as never,
			toHeight as never,
			onItem as never,
			onCancel as never,
		) as AttoJob;
	}

	return node.onTransactionByHeightSearch(
		heightSearch(addresses, parameters) as never,
		onItem as never,
		onCancel as never,
	) as AttoJob;
}

function subscribeToAccountEntryAddresses(
	node: AttoNodeClientAsync,
	addresses: AttoAddress[] | undefined,
	fromHeight: AttoHeight | undefined,
	toHeight: AttoHeight | undefined,
	parameters: AttoParameters,
	onItem: (item: AttoAccountEntry) => void,
	onCancel: (error?: Error | null) => void,
): AttoJob {
	if (!addresses) return node.onAccountEntryAll(onItem as never, onCancel as never) as AttoJob;
	if (addresses.length === 1) {
		return node.onAccountEntryByPublicKey(
			addresses[0].publicKey as never,
			fromHeight as never,
			toHeight as never,
			onItem as never,
			onCancel as never,
		) as AttoJob;
	}

	return node.onAccountEntryByHeightSearch(
		heightSearch(addresses, parameters) as never,
		onItem as never,
		onCancel as never,
	) as AttoJob;
}

export async function executeAttoOperation(
	operation: AttoOperation,
	parameters: AttoParameters,
	credentials?: ICredentialDataDecryptedObject,
): Promise<AttoOperationResult> {
	const attoCredentials = normalizeCredentials(credentials);

	if (operation === 'deriveAddress' || operation === 'deriveAccount') {
		const derived = await deriveAddressFromSecret(parameters, credentials);
		return {
			address: derived.address.value,
			publicKey: derived.publicKey.toString(),
			keyIndex: derived.keyIndex,
			secretType: derived.secretType,
		};
	}

	if (operation === 'getAccount') {
		const node = createNodeClient(attoCredentials);
		const address = parseAddress(parameters.address ?? parameters.lookupAddress, 'Address');
		const account = await node.accountByPublicKey(address.publicKey as never);

		if (!account) {
			return {
				found: false,
				address: address.value,
			};
		}

		return accountOutput(account as never);
	}

	if (operation === 'getReceivables') {
		const node = createNodeClient(attoCredentials);
		return await collectReceivables(node, parameters, attoCredentials);
	}

	if (operation === 'getTransactions') {
		const node = createNodeClient(attoCredentials);
		return await collectTransactionsForMode(node, parameters, attoCredentials);
	}

	if (operation === 'getAccountEntries') {
		const node = createNodeClient(attoCredentials);
		return await collectAccountEntries(node, parameters, attoCredentials);
	}

	if (operation === 'sendTransaction') {
		const destinationAddress = parseAddress(parameters.destinationAddress, 'Destination Address');
		const amount = parseAmount(parameters.amount, parameters.amountUnit, 'Amount');
		const timeoutMs = positiveTimeout(parameters.timeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS, 'Timeout');
		const runtime = await createWalletRuntime(parameters, attoCredentials);
		assertOptionalSameAddress(runtime.derived.address, parseOptionalAddress(parameters.fromAddress, 'From Address'), 'From Address');
		const transaction = await withTimeout(
			Promise.resolve(
				runtime.wallet.sendByAddress(
					runtime.derived.address as never,
					destinationAddress as never,
					amount as never,
					null,
				),
			),
			timeoutMs,
			'Send transaction',
		);

		return {
			...transactionOutput(transaction as never, 'published'),
			fromAddress: runtime.derived.address.value,
			destinationAddress: destinationAddress.value,
			amount: amountOutput(amount),
		};
	}

	if (operation === 'receivePending') {
		const timeoutMs = positiveTimeout(parameters.timeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS, 'Timeout');
		const receivable = parseInputReceivable(parameters);
		const requestedRepresentative = parseOptionalAddress(
			parameters.receiveRepresentativeAddress ?? parameters.representativeAddress,
			'Representative Address',
		);
		const runtime = await createWalletRuntime(parameters, attoCredentials);
		assertOptionalSameAddress(runtime.derived.address, parseOptionalAddress(parameters.receiveAddress, 'Address'), 'Address');
		assertSameAddress(runtime.derived.address, receivable.receiverAddress, 'Receivable Address');

		const representative = requestedRepresentative ?? runtime.derived.address;
		const transaction = await withTimeout(
			Promise.resolve(runtime.wallet.receive(receivable as never, representative as never, null)),
			timeoutMs,
			'Receive transaction',
		);

		return {
			...transactionOutput(transaction as never, 'received'),
			address: runtime.derived.address.value,
			representativeAddress: representative.value,
			amount: amountOutput(receivable.amount),
			receivable: parseJsonObject(receivableToJson(receivable as never)),
		};
	}

	if (operation === 'changeRepresentative') {
		const representativeAddress = parseAddress(parameters.representativeAddress, 'Representative Address');
		const runtime = await createWalletRuntime(parameters, attoCredentials);
		assertOptionalSameAddress(runtime.derived.address, parseOptionalAddress(parameters.changeAddress, 'Address'), 'Address');
		const transaction = await runtime.wallet.change(
			toAttoIndex(runtime.derived.keyIndex) as never,
			representativeAddress as never,
			null,
		);

		return {
			...transactionOutput(transaction as never, 'representative_changed'),
			address: runtime.derived.address.value,
			representativeAddress: representativeAddress.value,
		};
	}

	throw new Error(`Unsupported Atto operation: ${operation}`);
}

export async function createAttoTriggerSubscription(
	event: AttoTriggerEvent,
	parameters: AttoParameters,
	credentials: ICredentialDataDecryptedObject | undefined,
	emit: (data: IDataObject) => void,
	emitError: (error: Error) => void,
): Promise<AttoTriggerSubscription> {
	const attoCredentials = normalizeCredentials(credentials);
	const node = createNodeClient(attoCredentials);
	let closing = false;

	const onCancel = (error?: Error | null) => {
		if (closing || !error) return;
		emitError(errorFromUnknown(error, 'Atto trigger stream stopped'));
	};

	const closeJob = (job: AttoJob) => {
		closing = true;
		cancelJob(job);
	};

	if (event === 'receivable') {
		const addresses = await addressesFromSource(parameters, attoCredentials);
		const minAmount = parseOptionalAmount(parameters.minAmount, parameters.minAmountUnit ?? 'RAW', 'Minimum Amount');
		const job = node.onReceivableByAddresses(
			addresses as never,
			minAmount as never,
			(receivable) => emit(receivableOutput(receivable as never)),
			onCancel as never,
		) as AttoJob;

		return { close: () => closeJob(job) };
	}

	if (event === 'account') {
		const addresses = await addressesFromSource(parameters, attoCredentials, true);
		const job = addresses
			? node.onAccountByAddresses(
					addresses as never,
					(account) => emit(accountOutput(account as never)),
					onCancel as never,
				)
			: node.onAccountAll((account) => emit(accountOutput(account as never)), onCancel as never);

		return { close: () => closeJob(job as AttoJob) };
	}

	if (event === 'transaction') {
		const mode = parseQueryMode(parameters.queryMode);
		const hash = mode === 'hash' ? parseHash(parameters.hash, 'Hash') : undefined;
		const addresses = mode === 'credentials' ? [await addressForCredentials(attoCredentials)] : mode === 'manual' ? parseAddressList(parameters.addresses ?? parameters.address, 'Address') : undefined;
		const fromHeight = parseOptionalHeight(parameters.fromHeight, 'From Height');
		const toHeight = parseOptionalHeight(parameters.toHeight, 'To Height');
		const job = hash
			? node.onTransactionByHash(
					hash as never,
					(transaction) => emit(transactionOutput(transaction as never)),
					onCancel as never,
				)
			: subscribeToTransactionAddresses(
					node,
					addresses,
					fromHeight,
					toHeight,
					parameters,
					(transaction) => emit(transactionOutput(transaction)),
					onCancel,
				);

		return { close: () => closeJob(job as AttoJob) };
	}

	if (event === 'accountEntry') {
		const mode = parseQueryMode(parameters.queryMode);
		const hash = mode === 'hash' ? parseHash(parameters.hash, 'Hash') : undefined;
		const addresses = mode === 'credentials' ? [await addressForCredentials(attoCredentials)] : mode === 'manual' ? parseAddressList(parameters.addresses ?? parameters.address, 'Address') : undefined;
		const fromHeight = parseOptionalHeight(parameters.fromHeight, 'From Height');
		const toHeight = parseOptionalHeight(parameters.toHeight, 'To Height');
		const job = hash
			? node.onAccountEntryByHash(
					hash as never,
					(accountEntry) => emit(accountEntryOutput(accountEntry as never)),
					onCancel as never,
				)
			: subscribeToAccountEntryAddresses(
					node,
					addresses,
					fromHeight,
					toHeight,
					parameters,
					(accountEntry) => emit(accountEntryOutput(accountEntry)),
					onCancel,
				);

		return { close: () => closeJob(job as AttoJob) };
	}

	throw new Error(`Unsupported Atto trigger event: ${event}`);
}
