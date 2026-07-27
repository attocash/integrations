import {
	NodeApiError,
	type ICredentialDataDecryptedObject,
	type IDataObject,
	type IExecuteFunctions,
	type IHttpRequestOptions,
	type ITriggerFunctions,
	type JsonObject,
} from 'n8n-workflow';
import {
	accountEntryOutput,
	accountOutput,
	addressFromPublicKey,
	amountOutput,
	blockHash,
	createChangeBlock,
	createReceiveBlock,
	createSendBlock,
	deriveAddressFromSecret,
	parseAddress,
	parseAmount,
	parseAttoJson,
	parseHash,
	receivableOutput,
	signedTransaction,
	streamEventOutput,
	stringifyAttoJson,
	transactionOutput,
	workTarget,
	type AttoAddress,
	type AttoBlockModel,
	type AttoCredentials,
	type DerivedAddress,
	type AttoStreamEvent,
	type AttoStreamRequest,
} from './protocol';

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

export type AttoTriggerEvent = AttoStreamEvent;
export type AttoParameters = Record<string, unknown>;
export type AttoOperationResult = IDataObject | IDataObject[];

type AttoContext = IExecuteFunctions | ITriggerFunctions;
type AddressSource = 'credentials' | 'manual' | 'all';
type QueryMode = 'credentials' | 'manual' | 'all' | 'hash';

type StreamRequest = {
	method: 'GET' | 'POST';
	path: string;
	body?: IDataObject;
	maxItems: number;
	timeoutMs: number;
};

export type AttoHttpStreamRequest = {
	method: 'GET' | 'POST';
	path: string;
	body?: IDataObject;
};

const DEFAULT_STREAM_TIMEOUT_MS = 5000;
const DEFAULT_PUBLISH_TIMEOUT_MS = 60000;
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

export type AttoStreamRuntime = {
	open(
		context: AttoContext,
		value: AttoCredentials,
		request: AttoHttpStreamRequest,
		signal: AbortSignal,
	): Promise<AsyncIterable<unknown>>;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(timer: unknown): void;
};

export type AttoEventStream = {
	close(): Promise<void>;
};

function scheduleTimeout(callback: () => void, delayMs: number): AbortController {
	const controller = new AbortController();
	const timeout = AbortSignal.timeout(delayMs);
	const onTimeout = () => {
		if (!controller.signal.aborted) callback();
	};
	timeout.addEventListener('abort', onTimeout, { once: true });
	controller.signal.addEventListener(
		'abort',
		() => timeout.removeEventListener('abort', onTimeout),
		{ once: true },
	);
	return controller;
}

const DEFAULT_STREAM_RUNTIME: AttoStreamRuntime = {
	open: openAttoEventStream,
	setTimeout: scheduleTimeout,
	clearTimeout: (timer) => (timer as AbortController).abort(),
};

function credentials(value: ICredentialDataDecryptedObject | undefined): AttoCredentials {
	return (value ?? {}) as AttoCredentials;
}

function text(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function optionalText(value: unknown): string | undefined {
	const valueText = text(value);
	return valueText || undefined;
}

function nonNegativeInteger(value: unknown, fieldName: string): number {
	const numberValue = typeof value === 'number' ? value : Number(value);
	if (!Number.isSafeInteger(numberValue) || numberValue < 0) throw new Error(`${fieldName} must be a non-negative integer`);
	return numberValue;
}

function positiveInteger(value: unknown, fieldName: string): number {
	const numberValue = nonNegativeInteger(value, fieldName);
	if (numberValue < 1) throw new Error(`${fieldName} must be greater than zero`);
	return numberValue;
}

function positiveHeight(value: unknown, fieldName: string): string | undefined {
	const valueText = optionalText(value);
	if (!valueText) return undefined;
	if (!/^\d+$/.test(valueText) || BigInt(valueText) < 1n) throw new Error(`${fieldName} must be a positive integer`);
	return valueText;
}

function requireNodeUrl(value: AttoCredentials): string {
	const url = text(value.nodeUrl);
	if (!url) throw new Error('Atto credentials must include a Node Base URL');
	const parsed = URL.canParse(url) ? new URL(url) : undefined;
	if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
		throw new Error('Atto credentials must include a valid HTTP Node Base URL');
	}
	return url.replace(/\/+$/, '');
}

function requireWorkerUrl(value: AttoCredentials): string {
	const url = text(value.workerUrl);
	if (!url) throw new Error('Atto credentials must include a Worker Base URL');
	return url.replace(/\/+$/, '');
}

function requestHeaders(value: AttoCredentials, accept = 'application/json'): IDataObject {
	const headers: IDataObject = { Accept: accept };
	const apiKey = text(value.apiKey);
	if (!apiKey) return headers;
	const headerName = text(value.authHeaderName || 'Authorization');
	if (!headerName) throw new Error('API Key Header is required when API Key is set');
	const prefix = text(value.authHeaderPrefix);
	headers[headerName] = prefix ? `${prefix} ${apiKey}` : apiKey;
	return headers;
}

function apiError(context: AttoContext, error: unknown, message: string): NodeApiError {
	const cause = error && typeof error === 'object' ? error : { message: String(error) };
	return new NodeApiError(context.getNode(), cause as JsonObject, { message });
}

function responseStatus(response: unknown): number | undefined {
	if (!response || typeof response !== 'object') return undefined;
	const value = response as { status?: unknown; statusCode?: unknown };
	const status = Number(value.statusCode ?? value.status);
	return Number.isFinite(status) ? status : undefined;
}

function responseBody(response: unknown): unknown {
	if (!response || typeof response !== 'object' || !('body' in response)) return response;
	return (response as { body: unknown }).body;
}

async function requestText(
	context: AttoContext,
	value: AttoCredentials,
	baseUrl: string,
	method: 'GET' | 'POST',
	path: string,
	options: { body?: IDataObject; timeoutMs?: number; allowNotFound?: boolean } = {},
): Promise<string | undefined> {
	const request: IHttpRequestOptions = {
		url: `${baseUrl}/${path}`,
		method,
		headers: {
			...requestHeaders(value),
			...(options.body ? { 'Content-Type': 'application/json' } : {}),
		},
		encoding: 'text',
		json: false,
		timeout: options.timeoutMs ?? 10_000,
		returnFullResponse: options.allowNotFound,
		ignoreHttpStatusErrors: options.allowNotFound,
		...(options.body ? { body: stringifyAttoJson(options.body) } : {}),
	};

	try {
		const response = await context.helpers.httpRequest(request);
		if (options.allowNotFound && responseStatus(response) === 404) return undefined;
		const status = responseStatus(response);
		if (status !== undefined && status >= 400) throw new Error(`Atto API returned HTTP ${status}`);
		const body = responseBody(response);
		return typeof body === 'string' ? body : JSON.stringify(body);
	} catch (error) {
		throw apiError(context, error, `Atto API request failed: ${method} /${path}`);
	}
}

async function requestJson(
	context: AttoContext,
	value: AttoCredentials,
	baseUrl: string,
	method: 'GET' | 'POST',
	path: string,
	options: { body?: IDataObject; timeoutMs?: number; allowNotFound?: boolean } = {},
): Promise<unknown | undefined> {
	const body = await requestText(context, value, baseUrl, method, path, options);
	if (body === undefined || !body.trim()) return undefined;
	try {
		return parseAttoJson(body);
	} catch (error) {
		throw apiError(context, error, `Atto API returned invalid JSON for ${method} /${path}`);
	}
}

function streamChunk(value: unknown): string {
	if (typeof value === 'string') return value;
	if (Buffer.isBuffer(value)) return value.toString('utf8');
	if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
	return String(value);
}

function isExpectedStreamEnd(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false;
	const value = error as { code?: unknown; message?: unknown; name?: unknown };
	const message = String(value.message ?? '').toLowerCase();
	return (
		value.code === 'ECONNABORTED' ||
		value.name === 'AbortError' ||
		message.includes('aborted') ||
		message.includes('timeout') ||
		message.includes('timed out')
	);
}

async function requestStream(
	context: AttoContext,
	value: AttoCredentials,
	request: StreamRequest,
): Promise<IDataObject[]> {
	const controller = new AbortController();
	const options: IHttpRequestOptions = {
		url: `${requireNodeUrl(value)}/${request.path}`,
		method: request.method,
		headers: {
			...requestHeaders(value, 'application/x-ndjson'),
			...(request.body ? { 'Content-Type': 'application/json' } : {}),
		},
		encoding: 'stream',
		json: false,
		timeout: request.timeoutMs,
		abortSignal: controller.signal,
		...(request.body ? { body: stringifyAttoJson(request.body) } : {}),
	};
	const items: IDataObject[] = [];
	let pending = '';

	try {
		const response = await context.helpers.httpRequest(options);
		if (!response || typeof response !== 'object' || !(Symbol.asyncIterator in response)) {
			throw new Error('Atto stream response is not readable');
		}
		for await (const chunk of response as AsyncIterable<unknown>) {
			pending += streamChunk(chunk);
			const lines = pending.split('\n');
			pending = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.trim()) continue;
				const parsed = parseAttoJson(line) as IDataObject;
				items.push(parsed);
				if (items.length >= request.maxItems) {
					controller.abort();
					return items;
				}
			}
		}
		if (pending.trim() && items.length < request.maxItems) items.push(parseAttoJson(pending) as IDataObject);
		return items;
	} catch (error) {
		if (controller.signal.aborted || isExpectedStreamEnd(error)) return items;
		throw apiError(context, error, `Atto API stream failed: ${request.method} /${request.path}`);
	}
}

async function openAttoEventStream(
	context: AttoContext,
	value: AttoCredentials,
	request: AttoHttpStreamRequest,
	signal: AbortSignal,
): Promise<AsyncIterable<unknown>> {
	const response = await context.helpers.httpRequest({
		url: `${requireNodeUrl(value)}/${request.path}`,
		method: request.method,
		headers: {
			...requestHeaders(value, 'application/x-ndjson'),
			...(request.body ? { 'Content-Type': 'application/json' } : {}),
		},
		encoding: 'stream',
		json: false,
		abortSignal: signal,
		...(request.body ? { body: stringifyAttoJson(request.body) } : {}),
	});
	if (!response || typeof response !== 'object' || !(Symbol.asyncIterator in response)) {
		throw new Error('Atto stream response is not readable');
	}
	return response as AsyncIterable<unknown>;
}

function contextRequired(context: AttoContext | undefined): AttoContext {
	if (!context) throw new Error('This Atto operation requires an n8n execution context');
	return context;
}

function addressSource(value: unknown, allowAll: boolean): AddressSource {
	const source = text(value || 'credentials');
	if (source === 'credentials' || source === 'manual') return source;
	if (allowAll && source === 'all') return source;
	throw new Error('Address Source must be credentials, manual, or all');
}

function queryMode(value: unknown): QueryMode {
	const mode = text(value || 'credentials');
	if (mode === 'credentials' || mode === 'manual' || mode === 'all' || mode === 'hash') return mode;
	throw new Error('Query Mode must be credentials, manual, all, or hash');
}

function parseAddresses(value: unknown, fieldName: string): AttoAddress[] {
	const source = typeof value === 'string' ? value : Array.isArray(value) ? value.join('\n') : '';
	const result = source
		.split(/[\n,]+/)
		.map((address) => address.trim())
		.filter(Boolean)
		.map((address) => parseAddress(address));
	if (result.length === 0) throw new Error(`${fieldName} is required`);
	return result;
}

async function derivedAddress(value: AttoCredentials): Promise<AttoAddress> {
	return await deriveAddressFromSecret({ secretSource: 'credentials' }, value);
}

async function addressesForSource(
	parameters: AttoParameters,
	value: AttoCredentials,
	allowAll = false,
): Promise<AttoAddress[] | undefined> {
	const source = addressSource(parameters.addressSource, allowAll);
	if (source === 'all') return undefined;
	if (source === 'manual') return parseAddresses(parameters.addresses ?? parameters.address, 'Address');
	return [await derivedAddress(value)];
}

async function addressesForQuery(
	parameters: AttoParameters,
	value: AttoCredentials,
): Promise<AttoAddress[] | undefined> {
	const mode = queryMode(parameters.queryMode);
	if (mode === 'all' || mode === 'hash') return undefined;
	return mode === 'manual'
		? parseAddresses(parameters.addresses ?? parameters.address, 'Address')
		: [await derivedAddress(value)];
}

function streamLimits(parameters: AttoParameters): { maxItems: number; timeoutMs: number } {
	return {
		maxItems: positiveInteger(parameters.maxItems ?? 25, 'Max Items'),
		timeoutMs: positiveInteger(parameters.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS, 'Timeout'),
	};
}

function heightQuery(parameters: AttoParameters): string {
	const fromHeight = positiveHeight(parameters.fromHeight, 'From Height') ?? '1';
	const toHeight = positiveHeight(parameters.toHeight, 'To Height');
	return `fromHeight=${encodeURIComponent(fromHeight)}${toHeight ? `&toHeight=${encodeURIComponent(toHeight)}` : ''}`;
}

function heightSearch(addresses: AttoAddress[], parameters: AttoParameters): IDataObject {
	const fromHeight = positiveHeight(parameters.fromHeight, 'From Height') ?? '1';
	const toHeight = positiveHeight(parameters.toHeight, 'To Height');
	return {
		search: addresses.map((address) => ({
			address: address.value,
			fromHeight,
			...(toHeight ? { toHeight } : {}),
		})),
	};
}

async function receivableStreamRequest(
	parameters: AttoParameters,
	value: AttoCredentials,
	maxItems?: number,
	timeoutMs?: number,
): Promise<StreamRequest> {
	const addresses = (await addressesForSource(parameters, value)) ?? [];
	const minimum = optionalText(parameters.minAmount)
		? parseAmount(parameters.minAmount, parameters.minAmountUnit ?? 'RAW', 'Minimum Amount').toString()
		: '0';
	const limits = streamLimits(parameters);
	return {
		method: 'POST',
		path: `accounts/receivables/stream?minAmount=${minimum}`,
		body: { addresses: addresses.map((address) => address.value) },
		maxItems: maxItems ?? limits.maxItems,
		timeoutMs: timeoutMs ?? limits.timeoutMs,
	};
}

async function transactionStreamRequest(
	parameters: AttoParameters,
	value: AttoCredentials,
	maxItems?: number,
	timeoutMs?: number,
): Promise<StreamRequest> {
	const mode = queryMode(parameters.queryMode);
	const limits = streamLimits(parameters);
	if (mode === 'hash') {
		return {
			method: 'GET',
			path: `transactions/${parseHash(parameters.hash)}/stream`,
			maxItems: maxItems ?? 1,
			timeoutMs: timeoutMs ?? limits.timeoutMs,
		};
	}
	const addresses = await addressesForQuery(parameters, value);
	if (!addresses) {
		return { method: 'GET', path: 'transactions/stream', maxItems: maxItems ?? limits.maxItems, timeoutMs: timeoutMs ?? limits.timeoutMs };
	}
	if (addresses.length === 1) {
		return {
			method: 'GET',
			path: `accounts/${addresses[0].publicKey}/transactions/stream?${heightQuery(parameters)}`,
			maxItems: maxItems ?? limits.maxItems,
			timeoutMs: timeoutMs ?? limits.timeoutMs,
		};
	}
	return {
		method: 'POST',
		path: 'accounts/transactions/stream',
		body: heightSearch(addresses, parameters),
		maxItems: maxItems ?? limits.maxItems,
		timeoutMs: timeoutMs ?? limits.timeoutMs,
	};
}

async function accountEntryStreamRequest(
	parameters: AttoParameters,
	value: AttoCredentials,
	maxItems?: number,
	timeoutMs?: number,
): Promise<StreamRequest> {
	const mode = queryMode(parameters.queryMode);
	const limits = streamLimits(parameters);
	if (mode === 'hash') {
		return {
			method: 'GET',
			path: `accounts/entries/${parseHash(parameters.hash)}/stream`,
			maxItems: maxItems ?? 1,
			timeoutMs: timeoutMs ?? limits.timeoutMs,
		};
	}
	const addresses = await addressesForQuery(parameters, value);
	if (!addresses) {
		return { method: 'GET', path: 'accounts/entries/stream', maxItems: maxItems ?? limits.maxItems, timeoutMs: timeoutMs ?? limits.timeoutMs };
	}
	if (addresses.length === 1) {
		return {
			method: 'GET',
			path: `accounts/${addresses[0].publicKey}/entries/stream?${heightQuery(parameters)}`,
			maxItems: maxItems ?? limits.maxItems,
			timeoutMs: timeoutMs ?? limits.timeoutMs,
		};
	}
	return {
		method: 'POST',
		path: 'accounts/entries/stream',
		body: heightSearch(addresses, parameters),
		maxItems: maxItems ?? limits.maxItems,
		timeoutMs: timeoutMs ?? limits.timeoutMs,
	};
}

async function accountByAddress(
	context: AttoContext,
	value: AttoCredentials,
	address: AttoAddress,
): Promise<IDataObject | undefined> {
	return (await requestJson(context, value, requireNodeUrl(value), 'GET', `accounts/${address.publicKey}`, {
		allowNotFound: true,
		timeoutMs: 3000,
	})) as IDataObject | undefined;
}

async function nodeTimestamp(context: AttoContext, value: AttoCredentials): Promise<number> {
	const localTimestamp = Date.now();
	const response = (await requestJson(
		context,
		value,
		requireNodeUrl(value),
		'GET',
		`instants/${encodeURIComponent(new Date(localTimestamp).toISOString())}`,
	)) as IDataObject | undefined;
	const difference = Number(response?.differenceMillis ?? 0);
	if (!Number.isSafeInteger(difference)) throw new Error('Atto node returned an invalid clock difference');
	return Date.now() + difference;
}

async function workForBlock(
	context: AttoContext,
	value: AttoCredentials,
	block: AttoBlockModel,
	timeoutMs: number,
): Promise<string> {
	const response = (await requestJson(context, value, requireWorkerUrl(value), 'POST', 'works', {
		body: {
			network: block.network.name,
			timestamp: Number(block.timestamp.toEpochMilliseconds()),
			target: workTarget(block),
		},
		timeoutMs,
	})) as IDataObject | undefined;
	const work = text(response?.work);
	if (!work) throw new Error('Atto worker response is missing work');
	return work;
}

async function publishBlock(
	context: AttoContext,
	value: AttoCredentials,
	block: AttoBlockModel,
	signer: DerivedAddress['signer'],
	timeoutMs: number,
): Promise<IDataObject> {
	const transaction = await signedTransaction(
		block,
		signer,
		await workForBlock(context, value, block, timeoutMs),
	);
	const accepted = await requestStream(context, value, {
		method: 'POST',
		path: 'transactions/stream',
		body: transaction.raw,
		maxItems: 1,
		timeoutMs,
	});
	if (accepted.length === 0) throw new Error('Atto node did not acknowledge the transaction before timeout');
	if (blockHash((accepted[0].block ?? {}) as IDataObject) !== transaction.model.hash.toString()) {
		throw new Error('Atto node acknowledged a different transaction');
	}
	return transaction.raw;
}

async function receivableFromInput(
	context: AttoContext,
	value: AttoCredentials,
	parameters: AttoParameters,
): Promise<IDataObject> {
	const item = parameters.inputItem;
	if (!item || typeof item !== 'object' || Array.isArray(item)) {
		throw new Error('Input item must contain a receivable from Atto Trigger or Get Receivables');
	}
	const input = item as IDataObject;
	const nested = input.receivable;
	if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested as IDataObject;
	if (input.network && input.receiverPublicKey && input.amount) return input;

	const hash = parseHash(input.hash);
	const transaction = (await requestJson(context, value, requireNodeUrl(value), 'GET', `transactions/${hash}`)) as IDataObject;
	const block = transaction.block as IDataObject | undefined;
	if (!block || block.type !== 'SEND') throw new Error('Input receivable hash does not identify an Atto send transaction');
	return {
		network: block.network,
		hash,
		version: block.version,
		algorithm: block.algorithm,
		publicKey: block.publicKey,
		timestamp: block.timestamp,
		receiverAlgorithm: block.receiverAlgorithm,
		receiverPublicKey: block.receiverPublicKey,
		amount: block.amount,
	};
}

export async function executeAttoOperation(
	context: AttoContext | undefined,
	operation: AttoOperation,
	parameters: AttoParameters,
	credentialData?: ICredentialDataDecryptedObject,
): Promise<AttoOperationResult> {
	const value = credentials(credentialData);

	if (operation === 'deriveAddress' || operation === 'deriveAccount') {
		const derived = await deriveAddressFromSecret(parameters, value);
		return { address: derived.value, publicKey: derived.publicKey, keyIndex: derived.keyIndex, secretType: derived.secretType };
	}

	const execution = contextRequired(context);
	if (operation === 'getAccount') {
		const address = parseAddress(parameters.address ?? parameters.lookupAddress);
		const account = await accountByAddress(execution, value, address);
		return account ? accountOutput(account) : { found: false, address: address.value };
	}
	if (operation === 'getReceivables') {
		return (await requestStream(execution, value, await receivableStreamRequest(parameters, value))).map((item) => receivableOutput(item));
	}
	if (operation === 'getTransactions') {
		if (queryMode(parameters.queryMode) === 'hash') {
			const hash = parseHash(parameters.hash);
			const transaction = (await requestJson(execution, value, requireNodeUrl(value), 'GET', `transactions/${hash}`)) as IDataObject;
			return [transactionOutput(transaction)];
		}
		return (await requestStream(execution, value, await transactionStreamRequest(parameters, value))).map((item) => transactionOutput(item));
	}
	if (operation === 'getAccountEntries') {
		return (await requestStream(execution, value, await accountEntryStreamRequest(parameters, value))).map((item) => accountEntryOutput(item));
	}

	const derived = await deriveAddressFromSecret(parameters, value);
	const account = await accountByAddress(execution, value, derived);
	const timestamp = await nodeTimestamp(execution, value);
	const timeoutMs = positiveInteger(parameters.timeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS, 'Timeout');

	if (operation === 'sendTransaction') {
		if (!account) throw new Error('The wallet account is not open yet');
		const destination = parseAddress(parameters.destinationAddress);
		const amount = parseAmount(parameters.amount, parameters.amountUnit, 'Amount');
		const block = createSendBlock(account, destination, amount, timestamp);
		const transaction = await publishBlock(execution, value, block, derived.signer, timeoutMs);
		return {
			...transactionOutput(transaction, 'published'),
			fromAddress: derived.value,
			destinationAddress: destination.value,
			amount: amountOutput(amount),
		};
	}
	if (operation === 'receivePending') {
		const receivable = await receivableFromInput(execution, value, parameters);
		const receiver = addressFromPublicKey(text(receivable.receiverPublicKey));
		if (receiver.value !== derived.value) throw new Error('Receivable Address must match the address derived from the wallet secret');
		const representative = optionalText(parameters.representativeAddress)
			? parseAddress(parameters.representativeAddress)
			: derived;
		const block = createReceiveBlock(account, receivable, representative, timestamp);
		const transaction = await publishBlock(execution, value, block, derived.signer, timeoutMs);
		return {
			...transactionOutput(transaction, 'received'),
			address: derived.value,
			representativeAddress: representative.value,
			amount: amountOutput(receivable.amount),
		};
	}
	if (operation === 'changeRepresentative') {
		if (!account) throw new Error('The wallet account is not open yet');
		const representative = parseAddress(parameters.representativeAddress);
		const block = createChangeBlock(account, representative, timestamp);
		const transaction = await publishBlock(execution, value, block, derived.signer, timeoutMs);
		return {
			...transactionOutput(transaction, 'representative_changed'),
			address: derived.value,
			representativeAddress: representative.value,
		};
	}

	throw new Error(`Unsupported Atto operation: ${operation}`);
}

function addressStreamRoute(
	event: AttoTriggerEvent,
	addresses: AttoAddress[] | undefined,
): AttoStreamRequest {
	if (!addresses) return { event, route: 'all' };
	return {
		event,
		route: addresses.length === 1 ? 'publicKey' : 'addresses',
		addresses,
	};
}

export async function attoStreamRequest(
	event: AttoTriggerEvent,
	parameters: AttoParameters,
	credentialData: ICredentialDataDecryptedObject | undefined,
): Promise<AttoStreamRequest> {
	const value = credentials(credentialData);
	if (event === 'receivable') {
		const request = addressStreamRoute(event, await addressesForSource(parameters, value));
		return {
			...request,
			minAmount: optionalText(parameters.minAmount)
				? parseAmount(
						parameters.minAmount,
						parameters.minAmountUnit ?? 'RAW',
						'Minimum Amount',
					).toString()
				: '0',
		};
	}

	if (event === 'account') {
		return addressStreamRoute(event, await addressesForSource(parameters, value, true));
	}

	const mode = queryMode(parameters.queryMode);
	if (mode === 'hash') {
		return {
			event,
			route: 'hash',
			hash: parseHash(parameters.hash),
		};
	}

	const request = addressStreamRoute(event, await addressesForQuery(parameters, value));
	if (request.route === 'all') return request;
	return {
		...request,
		fromHeight: positiveHeight(parameters.fromHeight, 'From Height') ?? '1',
		toHeight: positiveHeight(parameters.toHeight, 'To Height'),
	};
}

function requiredStreamAddresses(request: AttoStreamRequest): AttoAddress[] {
	const addresses = request.addresses ?? [];
	if (addresses.length === 0) throw new Error('Atto stream route requires at least one address');
	return addresses;
}

function streamHeightQuery(request: AttoStreamRequest): string {
	const fromHeight = request.fromHeight ?? '1';
	return `fromHeight=${encodeURIComponent(fromHeight)}${
		request.toHeight ? `&toHeight=${encodeURIComponent(request.toHeight)}` : ''
	}`;
}

function streamHeightSearch(request: AttoStreamRequest): IDataObject {
	return {
		search: requiredStreamAddresses(request).map((address) => ({
			address: address.value,
			fromHeight: request.fromHeight ?? '1',
			...(request.toHeight ? { toHeight: request.toHeight } : {}),
		})),
	};
}

export function attoHttpStreamRequest(request: AttoStreamRequest): AttoHttpStreamRequest {
	if (request.event === 'account') {
		if (request.route === 'all') return { method: 'GET', path: 'accounts/stream' };
		const addresses = requiredStreamAddresses(request);
		if (request.route === 'publicKey') {
			return { method: 'GET', path: `accounts/${addresses[0].publicKey}/stream` };
		}
		if (request.route === 'addresses') {
			return {
				method: 'POST',
				path: 'accounts/stream',
				body: { addresses: addresses.map((address) => address.value) },
			};
		}
	}

	if (request.event === 'receivable') {
		const addresses = requiredStreamAddresses(request);
		const path = `accounts/receivables/stream?minAmount=${encodeURIComponent(
			request.minAmount ?? '0',
		)}`;
		if (request.route === 'publicKey') {
			return {
				method: 'GET',
				path: `accounts/${addresses[0].publicKey}/receivables/stream?minAmount=${encodeURIComponent(
					request.minAmount ?? '0',
				)}`,
			};
		}
		if (request.route === 'addresses') {
			return {
				method: 'POST',
				path,
				body: { addresses: addresses.map((address) => address.value) },
			};
		}
	}

	if (request.event === 'transaction') {
		if (request.route === 'all') return { method: 'GET', path: 'transactions/stream' };
		if (request.route === 'hash' && request.hash) {
			return { method: 'GET', path: `transactions/${request.hash}/stream` };
		}
		const addresses = requiredStreamAddresses(request);
		if (request.route === 'publicKey') {
			return {
				method: 'GET',
				path: `accounts/${addresses[0].publicKey}/transactions/stream?${streamHeightQuery(request)}`,
			};
		}
		if (request.route === 'addresses') {
			return {
				method: 'POST',
				path: 'accounts/transactions/stream',
				body: streamHeightSearch(request),
			};
		}
	}

	if (request.event === 'accountEntry') {
		if (request.route === 'all') return { method: 'GET', path: 'accounts/entries/stream' };
		if (request.route === 'hash' && request.hash) {
			return { method: 'GET', path: `accounts/entries/${request.hash}/stream` };
		}
		const addresses = requiredStreamAddresses(request);
		if (request.route === 'publicKey') {
			return {
				method: 'GET',
				path: `accounts/${addresses[0].publicKey}/entries/stream?${streamHeightQuery(request)}`,
			};
		}
		if (request.route === 'addresses') {
			return {
				method: 'POST',
				path: 'accounts/entries/stream',
				body: streamHeightSearch(request),
			};
		}
	}

	throw new Error(`Unsupported Atto ${request.event} stream route: ${request.route}`);
}

export async function startAttoEventStream(
	context: AttoContext,
	event: AttoTriggerEvent,
	parameters: AttoParameters,
	credentialData: ICredentialDataDecryptedObject | undefined,
	onEvent: (item: IDataObject) => void,
	runtime: AttoStreamRuntime = DEFAULT_STREAM_RUNTIME,
): Promise<AttoEventStream> {
	const value = credentials(credentialData);
	requireNodeUrl(value);
	requestHeaders(value, 'application/x-ndjson');
	const request = attoHttpStreamRequest(
		await attoStreamRequest(event, parameters, credentialData),
	);
	let activeController: AbortController | undefined;
	let activeConnection: Promise<void> | undefined;
	let reconnectTimer: unknown;
	let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
	let generation = 0;
	let closed = false;

	const scheduleReconnect = () => {
		if (closed || activeController || reconnectTimer !== undefined) return;
		const delayMs = reconnectDelayMs;
		reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
		reconnectTimer = runtime.setTimeout(() => {
			reconnectTimer = undefined;
			connect();
		}, delayMs);
	};

	const connect = () => {
		if (closed || activeController) return;
		const streamGeneration = ++generation;
		const controller = new AbortController();
		activeController = controller;
		activeConnection = (async () => {
			try {
				const response = await runtime.open(context, value, request, controller.signal);
				let pending = '';
				for await (const chunk of response) {
					if (closed || streamGeneration !== generation) return;
					pending += streamChunk(chunk);
					const lines = pending.split('\n');
					pending = lines.pop() ?? '';
					for (const line of lines) {
						if (!line.trim()) continue;
						const parsed = parseAttoJson(line);
						if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
							throw new Error(`Atto ${event} stream item must contain a JSON object`);
						}
						onEvent(streamEventOutput(event, parsed as IDataObject));
						reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
					}
				}
				if (pending.trim() && !closed && streamGeneration === generation) {
					const parsed = parseAttoJson(pending);
					if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
						throw new Error(`Atto ${event} stream item must contain a JSON object`);
					}
					onEvent(streamEventOutput(event, parsed as IDataObject));
					reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
				}
			} catch {
				// Connection and stream failures are retried below.
			} finally {
				if (streamGeneration === generation) {
					activeController = undefined;
					activeConnection = undefined;
					scheduleReconnect();
				}
			}
		})();
	};

	connect();

	return {
		async close() {
			if (closed) return;
			closed = true;
			generation++;
			if (reconnectTimer !== undefined) {
				runtime.clearTimeout(reconnectTimer);
				reconnectTimer = undefined;
			}
			const connection = activeConnection;
			activeController?.abort();
			activeController = undefined;
			activeConnection = undefined;
			await connection;
		},
	};
}
