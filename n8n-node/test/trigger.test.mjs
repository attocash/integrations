import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import {
	AttoMnemonic,
} from '@attocash/commons-core';

import { AttoTrigger } from '../dist/nodes/AttoTrigger/AttoTrigger.node.js';
import {
	attoHttpStreamRequest,
	attoStreamRequest,
	startAttoEventStream,
} from '../dist/nodes/Atto/operations.js';
import {
	addressFromPublicKey,
	streamEventOutput,
} from '../dist/nodes/Atto/protocol.js';

const PUBLIC_KEY = '45B3B58C26181580EEAFC1791046D54EEC2854BF550A211E2362761077D6590C';
const OTHER_PUBLIC_KEY = '99E439410A4DDD2A3A8D0B667C7A090286B8553378CF3C7AA806C3E60B6C4CBE';
const THIRD_PUBLIC_KEY = '0C400961629D759176F009249A33899440900ABCE275F6C5C01C6F7F37A2C59A';
const HASH = '70F9406609BCB2E3E18F22BD0839C95E5540E95489DC6F24DBF6A1F7CFD83A92';
const OTHER_HASH = '0AF0F63BFE4DBC588F95FC3B154DE848AA9A5DD5604BAC99AE9E21C5EA8B4F64';

const ACCOUNT = {
	publicKey: PUBLIC_KEY,
	network: 'LOCAL',
	version: 0,
	algorithm: 'V1',
	height: '1',
	balance: '18000000000000000000',
	lastTransactionHash: HASH,
	lastTransactionTimestamp: 1705517157478,
	representativeAlgorithm: 'V1',
	representativePublicKey: OTHER_PUBLIC_KEY,
};

const RECEIVABLE = {
	network: 'LOCAL',
	hash: OTHER_HASH,
	version: 0,
	algorithm: 'V1',
	publicKey: PUBLIC_KEY,
	timestamp: 1705517157478,
	receiverAlgorithm: 'V1',
	receiverPublicKey: THIRD_PUBLIC_KEY,
	amount: '18000000000000000000',
};

const ACCOUNT_ENTRY = {
	hash: OTHER_HASH,
	algorithm: 'V1',
	publicKey: PUBLIC_KEY,
	height: '1',
	blockType: 'RECEIVE',
	subjectAlgorithm: 'V1',
	subjectPublicKey: THIRD_PUBLIC_KEY,
	previousBalance: '0',
	balance: '100',
	timestamp: 1704616009211,
};

const TRANSACTION = {
	block: {
		network: 'LOCAL',
		version: 0,
		algorithm: 'V1',
		publicKey: PUBLIC_KEY,
		type: 'SEND',
		height: '2',
		balance: '12000000000',
		timestamp: 1705517157478,
		previous: HASH,
		receiverAlgorithm: 'V1',
		receiverPublicKey: THIRD_PUBLIC_KEY,
		amount: '1000000000',
	},
	signature: '00'.repeat(64),
	work: '00'.repeat(8),
};

function model(value) {
	return {
		toJson: () => JSON.stringify(value),
	};
}

function requestView(request) {
	return {
		event: request.event,
		route: request.route,
		addresses: request.addresses?.map((address) => address.value),
		hash: request.hash,
		fromHeight: request.fromHeight,
		toHeight: request.toHeight,
		minAmount: request.minAmount,
	};
}

test('selects every trigger stream route and preserves filter parameters', async () => {
	const mnemonic = await AttoMnemonic.generate();
	const credentials = {
		nodeUrl: 'http://localhost:8080',
		walletMaterialType: 'mnemonic',
		walletSecret: mnemonic.phrase,
		keyIndex: 0,
	};
	const address = addressFromPublicKey(PUBLIC_KEY).value;
	const otherAddress = addressFromPublicKey(OTHER_PUBLIC_KEY).value;
	const manualAddresses = `${address}\n${otherAddress}`;

	assert.deepEqual(
		requestView(await attoStreamRequest('account', { addressSource: 'all' }, credentials)),
		{
			event: 'account',
			route: 'all',
			addresses: undefined,
			hash: undefined,
			fromHeight: undefined,
			toHeight: undefined,
			minAmount: undefined,
		},
	);

	const accountCredentials = requestView(
		await attoStreamRequest('account', { addressSource: 'credentials' }, credentials),
	);
	assert.equal(accountCredentials.route, 'publicKey');
	assert.equal(accountCredentials.addresses.length, 1);

	assert.deepEqual(
		requestView(
			await attoStreamRequest(
				'account',
				{ addressSource: 'manual', addresses: manualAddresses },
				credentials,
			),
		),
		{
			event: 'account',
			route: 'addresses',
			addresses: [address, otherAddress],
			hash: undefined,
			fromHeight: undefined,
			toHeight: undefined,
			minAmount: undefined,
		},
	);

	const receivableCredentials = requestView(
		await attoStreamRequest(
			'receivable',
			{ addressSource: 'credentials', minAmount: '2', minAmountUnit: 'ATTO' },
			credentials,
		),
	);
	assert.equal(receivableCredentials.route, 'publicKey');
	assert.equal(receivableCredentials.addresses.length, 1);
	assert.equal(receivableCredentials.minAmount, '2000000000');

	assert.deepEqual(
		requestView(
			await attoStreamRequest(
				'receivable',
				{
					addressSource: 'manual',
					addresses: manualAddresses,
					minAmount: '7',
					minAmountUnit: 'RAW',
				},
				credentials,
			),
		),
		{
			event: 'receivable',
			route: 'addresses',
			addresses: [address, otherAddress],
			hash: undefined,
			fromHeight: undefined,
			toHeight: undefined,
			minAmount: '7',
		},
	);

	for (const event of ['transaction', 'accountEntry']) {
		assert.deepEqual(
			requestView(await attoStreamRequest(event, { queryMode: 'all' }, credentials)),
			{
				event,
				route: 'all',
				addresses: undefined,
				hash: undefined,
				fromHeight: undefined,
				toHeight: undefined,
				minAmount: undefined,
			},
		);

		assert.deepEqual(
			requestView(
				await attoStreamRequest(event, { queryMode: 'hash', hash: HASH }, credentials),
			),
			{
				event,
				route: 'hash',
				addresses: undefined,
				hash: HASH,
				fromHeight: undefined,
				toHeight: undefined,
				minAmount: undefined,
			},
		);

		const credentialsRequest = requestView(
			await attoStreamRequest(
				event,
				{ queryMode: 'credentials', fromHeight: '2', toHeight: '9' },
				credentials,
			),
		);
		assert.equal(credentialsRequest.route, 'publicKey');
		assert.equal(credentialsRequest.addresses.length, 1);
		assert.equal(credentialsRequest.fromHeight, '2');
		assert.equal(credentialsRequest.toHeight, '9');

		assert.deepEqual(
			requestView(
				await attoStreamRequest(
					event,
					{
						queryMode: 'manual',
						addresses: manualAddresses,
						fromHeight: '3',
						toHeight: '11',
					},
					credentials,
				),
			),
			{
				event,
				route: 'addresses',
				addresses: [address, otherAddress],
				hash: undefined,
				fromHeight: '3',
				toHeight: '11',
				minAmount: undefined,
			},
		);
	}
});

test('maps every trigger route to the Commons NDJSON endpoint contract', () => {
	const address = addressFromPublicKey(PUBLIC_KEY);
	const otherAddress = addressFromPublicKey(OTHER_PUBLIC_KEY);
	const addresses = [address, otherAddress];

	assert.deepEqual(
		attoHttpStreamRequest({ event: 'account', route: 'all' }),
		{ method: 'GET', path: 'accounts/stream' },
	);
	assert.deepEqual(
		attoHttpStreamRequest({ event: 'account', route: 'publicKey', addresses: [address] }),
		{ method: 'GET', path: `accounts/${PUBLIC_KEY}/stream` },
	);
	assert.deepEqual(
		attoHttpStreamRequest({ event: 'account', route: 'addresses', addresses }),
		{
			method: 'POST',
			path: 'accounts/stream',
			body: { addresses: addresses.map((item) => item.value) },
		},
	);

	assert.deepEqual(
		attoHttpStreamRequest({
			event: 'receivable',
			route: 'publicKey',
			addresses: [address],
			minAmount: '7',
		}),
		{
			method: 'GET',
			path: `accounts/${PUBLIC_KEY}/receivables/stream?minAmount=7`,
		},
	);
	assert.deepEqual(
		attoHttpStreamRequest({
			event: 'receivable',
			route: 'addresses',
			addresses,
			minAmount: '7',
		}),
		{
			method: 'POST',
			path: 'accounts/receivables/stream?minAmount=7',
			body: { addresses: addresses.map((item) => item.value) },
		},
	);

	for (const [event, allPath, hashPath, addressSuffix, multiPath] of [
		[
			'transaction',
			'transactions/stream',
			`transactions/${HASH}/stream`,
			'transactions',
			'accounts/transactions/stream',
		],
		[
			'accountEntry',
			'accounts/entries/stream',
			`accounts/entries/${HASH}/stream`,
			'entries',
			'accounts/entries/stream',
		],
	]) {
		assert.deepEqual(
			attoHttpStreamRequest({ event, route: 'all' }),
			{ method: 'GET', path: allPath },
		);
		assert.deepEqual(
			attoHttpStreamRequest({ event, route: 'hash', hash: HASH }),
			{ method: 'GET', path: hashPath },
		);
		assert.deepEqual(
			attoHttpStreamRequest({
				event,
				route: 'publicKey',
				addresses: [address],
				fromHeight: '2',
				toHeight: '9',
			}),
			{
				method: 'GET',
				path: `accounts/${PUBLIC_KEY}/${addressSuffix}/stream?fromHeight=2&toHeight=9`,
			},
		);
		assert.deepEqual(
			attoHttpStreamRequest({
				event,
				route: 'addresses',
				addresses,
				fromHeight: '3',
				toHeight: '11',
			}),
			{
				method: 'POST',
				path: multiPath,
				body: {
					search: addresses.map((item) => ({
						address: item.value,
						fromHeight: '3',
						toHeight: '11',
					})),
				},
			},
		);
	}
});

test('converts every Commons stream model to the stable n8n output shape', () => {
	const account = streamEventOutput('account', model(ACCOUNT));
	const receivable = streamEventOutput('receivable', model(RECEIVABLE));
	const transaction = streamEventOutput('transaction', model(TRANSACTION));
	const accountEntry = streamEventOutput('accountEntry', model(ACCOUNT_ENTRY));

	assert.deepEqual(account, {
		found: true,
		address: addressFromPublicKey(PUBLIC_KEY).value,
		publicKey: PUBLIC_KEY,
		balance: { raw: '18000000000000000000', atto: '18000000000' },
		representativeAddress: addressFromPublicKey(OTHER_PUBLIC_KEY).value,
		height: '1',
		frontier: HASH,
	});
	assert.deepEqual(receivable, {
		hash: OTHER_HASH,
		address: addressFromPublicKey(THIRD_PUBLIC_KEY).value,
		fromAddress: addressFromPublicKey(PUBLIC_KEY).value,
		amount: { raw: '18000000000000000000', atto: '18000000000' },
	});
	assert.deepEqual(Object.keys(transaction).sort(), ['address', 'hash', 'height']);
	assert.equal(transaction.address, addressFromPublicKey(PUBLIC_KEY).value);
	assert.equal(transaction.height, '2');
	assert.deepEqual(accountEntry, {
		hash: OTHER_HASH,
		address: addressFromPublicKey(PUBLIC_KEY).value,
		subjectAddress: addressFromPublicKey(THIRD_PUBLIC_KEY).value,
		height: '1',
		blockType: 'RECEIVE',
		previousBalance: { raw: '0', atto: '0' },
		balance: { raw: '100', atto: '0.0000001' },
	});
});

function fakeRuntime({ connectionFailures = 0 } = {}) {
	const subscriptions = [];
	const timers = [];
	const clearedTimers = [];
	let attempts = 0;

	function subscription(request, signal) {
		const values = [];
		const waiters = [];
		let ended = false;
		let failure;

		const settle = () => {
			while (waiters.length > 0 && (values.length > 0 || ended)) {
				const waiter = waiters.shift();
				if (values.length > 0) {
					waiter.resolve({ value: values.shift(), done: false });
				} else if (failure) {
					waiter.reject(failure);
				} else {
					waiter.resolve({ value: undefined, done: true });
				}
			}
		};
		const result = {
			request,
			signal,
			emit(value) {
				if (ended) return;
				values.push(`${JSON.stringify(value)}\n`);
				settle();
			},
			close(error) {
				if (ended) return;
				ended = true;
				failure = error;
				settle();
			},
			iterable: {
				[Symbol.asyncIterator]() {
					return this;
				},
				next() {
					if (values.length > 0) return Promise.resolve({ value: values.shift(), done: false });
					if (ended) {
						return failure
							? Promise.reject(failure)
							: Promise.resolve({ value: undefined, done: true });
					}
					return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
				},
			},
		};
		signal.addEventListener('abort', () => result.close(), { once: true });
		return result;
	}

	return {
		runtime: {
			async open(_context, _credentials, request, signal) {
				attempts++;
				if (attempts <= connectionFailures) throw new Error('connection failed');
				const result = subscription(request, signal);
				subscriptions.push(result);
				return result.iterable;
			},
			setTimeout(callback, delayMs) {
				const timer = { callback, delayMs, cleared: false };
				timers.push(timer);
				return timer;
			},
			clearTimeout(timer) {
				timer.cleared = true;
				clearedTimers.push(timer);
			},
		},
		subscriptions,
		timers,
		clearedTimers,
			get attempts() {
				return attempts;
			},
			runNextTimer() {
				const timer = timers.find((candidate) => !candidate.cleared && !candidate.ran);
				assert.ok(timer, 'expected a pending reconnect timer');
			timer.ran = true;
			timer.callback();
			return timer;
		},
	};
}

test('retries normal and erroneous closures with capped backoff, resets on events, and never overlaps subscriptions', async () => {
	const fake = fakeRuntime();
	const output = [];
	const stream = await startAttoEventStream(
		{},
		'account',
		{ addressSource: 'all' },
		{ nodeUrl: 'http://localhost' },
		(item) => output.push(item),
		fake.runtime,
	);

	assert.equal(fake.subscriptions.length, 1);
	fake.subscriptions[0].close();
	fake.subscriptions[0].close(new Error('duplicate close'));
	await delay(0);
	assert.deepEqual(fake.timers.map((timer) => timer.delayMs), [1000]);

	for (const expectedDelay of [2000, 4000, 8000, 16000, 30000, 30000]) {
		fake.runNextTimer();
		await delay(0);
		const current = fake.subscriptions.at(-1);
		current.close(new Error('stream closed'));
		await delay(0);
		assert.equal(fake.timers.at(-1).delayMs, expectedDelay);
	}

	fake.runNextTimer();
	await delay(0);
	const current = fake.subscriptions.at(-1);
	current.emit(ACCOUNT);
	await delay(0);
	assert.equal(output.length, 1);
	current.close();
	await delay(0);
	assert.equal(fake.timers.at(-1).delayMs, 1000);

	fake.runNextTimer();
	await delay(0);
	const active = fake.subscriptions.at(-1);
	await stream.close();
	assert.equal(active.signal.aborted, true);
});

test('connection failures retry without failing startup and close cancels a pending reconnect', async () => {
	const fake = fakeRuntime({ connectionFailures: 1 });
	const stream = await startAttoEventStream(
		{},
		'account',
		{ addressSource: 'all' },
		{ nodeUrl: 'http://localhost' },
		() => {},
		fake.runtime,
	);

	await delay(0);
	assert.equal(fake.attempts, 1);
	assert.equal(fake.timers[0].delayMs, 1000);
	fake.runNextTimer();
	await delay(0);
	assert.equal(fake.attempts, 2);
	assert.equal(fake.subscriptions.length, 1);
	fake.subscriptions[0].close(new Error('disconnect'));
	await delay(0);

	const reconnect = fake.timers.at(-1);
	await stream.close();
	assert.equal(reconnect.cleared, true);
});

test('n8n trigger reconnects after forced NDJSON disconnection and emits the next account event', async () => {
	let requests = 0;
	const server = createServer((_request, response) => {
		requests++;
		if (requests === 1) {
			response.destroy();
			return;
		}
		response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
		response.end(`${JSON.stringify(ACCOUNT)}\n`);
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

	const address = server.address();
	assert.ok(address && typeof address === 'object');
	const emitted = [];
	let resolveEmission;
	const emission = new Promise((resolve) => {
		resolveEmission = resolve;
	});
	const params = { event: 'account', addressSource: 'all' };
	const context = {
		getCredentials: async () => ({ nodeUrl: `http://127.0.0.1:${address.port}` }),
		getNodeParameter: (name, fallbackValue) => params[name] ?? fallbackValue,
		getNode: () => ({
			name: 'Atto Trigger',
			type: '@attocash/n8n-nodes-atto.attoTrigger',
			typeVersion: 1,
			parameters: params,
		}),
		helpers: {
			httpRequest: async (options) => {
				const response = await fetch(options.url, {
					method: options.method,
					headers: options.headers,
					body: options.body,
					signal: options.abortSignal,
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return response.body;
			},
		},
		emit(data) {
			emitted.push(data);
			resolveEmission();
		},
	};

	const trigger = new AttoTrigger();
	const response = await trigger.trigger.call(context);
	try {
		await Promise.race([
			emission,
			delay(6000).then(() => {
				throw new Error('Timed out waiting for the reconnected Atto stream');
			}),
		]);
		assert.equal(requests, 2);
		assert.equal(emitted.length, 1);
		assert.equal(
			emitted[0][0][0].json.address,
			addressFromPublicKey(PUBLIC_KEY).value,
		);
	} finally {
		await response.closeFunction();
		await new Promise((resolve) => server.close(resolve));
	}
});
