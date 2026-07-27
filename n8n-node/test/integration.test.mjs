import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import {
	AttoMnemonic,
	toAttoIndex,
	toPrivateKey,
	toSeedAsync,
} from '@attocash/commons-core';
import { AttoNodeMockAsyncBuilder, AttoWorkerMockAsyncBuilder } from '@attocash/commons-test';

import {
	executeAttoOperation,
	startAttoEventStream,
} from '../dist/nodes/Atto/operations.js';

function configureContainerRuntime() {
	const docker = spawnSync('docker', ['version'], { stdio: 'ignore' });
	if (docker.status === 0) return true;

	const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
	const podmanSocket = uid === undefined ? undefined : `/run/user/${uid}/podman/podman.sock`;
	if (!podmanSocket || !existsSync(podmanSocket)) return false;

	process.env.DOCKER_HOST ??= `unix://${podmanSocket}`;
	process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';
	process.env.TESTCONTAINERS_CHECKS_DISABLE ??= 'true';
	return true;
}

function requestError(response, body) {
	const error = new Error(`HTTP ${response.status}: ${body}`);
	error.statusCode = response.status;
	error.response = { status: response.status, data: body };
	return error;
}

function createContext(mode = 'manual') {
	const staticData = {};
	return {
		getNode: () => ({ name: 'Atto test', type: '@attocash/n8n-nodes-atto.atto', typeVersion: 1, parameters: {} }),
		getMode: () => mode,
		getWorkflowStaticData: () => staticData,
		helpers: {
			httpRequest: async (options) => {
				const signals = [];
				if (options.abortSignal) signals.push(options.abortSignal);
				if (options.timeout) signals.push(AbortSignal.timeout(options.timeout));
				const response = await fetch(options.url, {
					method: options.method,
					headers: options.headers,
					body: options.body,
					signal: signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals),
				});

				if (options.encoding === 'stream') {
					if (!response.ok) throw requestError(response, await response.text());
					return response.body;
				}

				const body = await response.text();
				if (!response.ok && !options.ignoreHttpStatusErrors) throw requestError(response, body);
				return options.returnFullResponse ? { body, statusCode: response.status, headers: Object.fromEntries(response.headers) } : body;
			},
		},
	};
}

async function waitForEvent(items, predicate, description) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const item = items.find(predicate);
		if (item) return item;
		await delay(100);
	}
	throw new Error(`Timed out waiting for ${description}`);
}

const hasRuntime = configureContainerRuntime();
const requireIntegration = process.env.ATTO_TEST_INTEGRATION === '1';

if (!hasRuntime && !requireIntegration) {
	test('integration skipped because Docker/Podman is unavailable', () => {
		assert.ok(true);
	});
} else if (!hasRuntime) {
	test('integration requires Docker or Podman', () => {
		assert.fail('Docker or a Podman socket is required for AttoNodeMock integration tests');
	});
} else {
	const mnemonic = await AttoMnemonic.generate();
	const seed = await toSeedAsync(mnemonic);
	const privateKey0 = await toPrivateKey(seed, toAttoIndex(0));

	const nodeMock = await new AttoNodeMockAsyncBuilder(privateKey0)
		.image(process.env.ATTO_NODE_MOCK_IMAGE || 'ghcr.io/attocash/node:live')
		.mysqlImage(process.env.ATTO_NODE_MYSQL_IMAGE || 'mysql:8.4')
		.build();
	const workerMock = await new AttoWorkerMockAsyncBuilder()
		.image(process.env.ATTO_WORK_MOCK_IMAGE || 'ghcr.io/attocash/work-server:cpu')
		.build();

	test.before(async () => {
		await nodeMock.start();
		await workerMock.start();
	});

	test.after(async () => {
		await nodeMock.close();
		await workerMock.close();
	});

	function credentials(keyIndex = 0) {
		return {
			nodeUrl: nodeMock.baseUrl,
			workerUrl: workerMock.baseUrl,
			walletMaterialType: 'mnemonic',
			walletSecret: mnemonic.phrase,
			keyIndex,
		};
	}

	async function derive(context, keyIndex) {
		return await executeAttoOperation(context, 'deriveAddress', { secretSource: 'credentials' }, credentials(keyIndex));
	}

	test('uses n8n HTTP helpers for actions and every trigger stream', async () => {
		const context = createContext();
		const account0 = await derive(context, 0);
		const account1 = await derive(context, 1);

		assert.match(account0.address, /^atto:\/\//);
		assert.match(account1.address, /^atto:\/\//);
		assert.notEqual(account0.address, account1.address);

		const send = await executeAttoOperation(
			context,
			'sendTransaction',
			{
				secretSource: 'credentials',
				destinationAddress: account1.address,
				amount: '1',
				amountUnit: 'ATTO',
			},
			credentials(0),
		);

		assert.equal(send.status, 'published');
		assert.ok(send.hash);
		assert.equal(send.fromAddress, account0.address);
		assert.equal(send.destinationAddress, account1.address);

		const accountInfo = await executeAttoOperation(
			context,
			'getAccount',
			{ address: account0.address, simplify: true },
			credentials(0),
		);

		assert.equal(accountInfo.found, true);
		assert.equal(accountInfo.address, account0.address);
		assert.ok(accountInfo.balance.raw);
		assert.ok(accountInfo.frontier);

		const receivables = await executeAttoOperation(
			context,
			'getReceivables',
			{
				addressSource: 'credentials',
				minAmount: '1',
				minAmountUnit: 'RAW',
				maxItems: 1,
				timeoutMs: 10000,
				simplify: true,
			},
			credentials(1),
		);

		assert.equal(receivables.length, 1);
		assert.equal(receivables[0].address, account1.address);
		assert.ok(receivables[0].hash);

		const transactions = await executeAttoOperation(
			context,
			'getTransactions',
			{ queryMode: 'hash', hash: send.hash, simplify: true },
			credentials(0),
		);

		assert.equal(transactions.length, 1);
		assert.equal(transactions[0].hash, send.hash);

		const accountEntries = await executeAttoOperation(
			context,
			'getAccountEntries',
			{
				queryMode: 'credentials',
				fromHeight: '1',
				maxItems: 1,
				timeoutMs: 10000,
				simplify: true,
			},
			credentials(0),
		);

		assert.equal(accountEntries.length, 1);
		assert.equal(accountEntries[0].address, account0.address);
		assert.ok(accountEntries[0].hash);

		const streamed = {
			receivable: [],
			account: [],
			transaction: [],
			accountEntry: [],
		};
		const triggerStreams = await Promise.all([
			startAttoEventStream(
				context,
				'receivable',
				{ addressSource: 'credentials', minAmount: '1', minAmountUnit: 'RAW' },
				credentials(1),
				(item) => streamed.receivable.push(item),
			),
			startAttoEventStream(
				context,
				'account',
				{ addressSource: 'credentials' },
				credentials(0),
				(item) => streamed.account.push(item),
			),
			startAttoEventStream(
				context,
				'transaction',
				{ queryMode: 'credentials', fromHeight: '1' },
				credentials(0),
				(item) => streamed.transaction.push(item),
			),
			startAttoEventStream(
				context,
				'accountEntry',
				{ queryMode: 'credentials', fromHeight: '1' },
				credentials(0),
				(item) => streamed.accountEntry.push(item),
			),
		]);

		let streamedSend;
		try {
			await delay(1000);
			streamedSend = await executeAttoOperation(
				context,
				'sendTransaction',
				{
					secretSource: 'credentials',
					destinationAddress: account1.address,
					amount: '1',
					amountUnit: 'RAW',
				},
				credentials(0),
			);

			const [streamedReceivable, streamedAccount, streamedTransaction, streamedAccountEntry] =
				await Promise.all([
					waitForEvent(
						streamed.receivable,
						(item) => item.hash === streamedSend.hash,
						'a receivable emitted after subscription',
					),
					waitForEvent(
						streamed.account,
						(item) => item.frontier === streamedSend.hash,
						'an account update emitted after subscription',
					),
					waitForEvent(
						streamed.transaction,
						(item) => item.hash === streamedSend.hash,
						'a transaction emitted after subscription',
					),
					waitForEvent(
						streamed.accountEntry,
						(item) => item.hash === streamedSend.hash,
						'an account entry emitted after subscription',
					),
				]);

			assert.equal(streamedReceivable.address, account1.address);
			assert.equal(streamedAccount.address, account0.address);
			assert.equal(streamedTransaction.address, account0.address);
			assert.equal(streamedAccountEntry.address, account0.address);
		} finally {
			await Promise.all(triggerStreams.map((stream) => stream.close()));
		}

		await assert.rejects(
			() => executeAttoOperation(
				context,
				'receivePending',
				{ secretSource: 'credentials', inputItem: receivables[0] },
				credentials(0),
			),
			/Receivable Address must match/,
		);

		const receive = await executeAttoOperation(
			context,
			'receivePending',
			{
				secretSource: 'credentials',
				inputItem: receivables[0],
				representativeAddress: account1.address,
			},
			credentials(1),
		);

		assert.equal(receive.status, 'received');
		assert.ok(receive.hash);
		assert.equal(receive.address, account1.address);
		assert.ok(receive.amount.raw);

		const change = await executeAttoOperation(
			context,
			'changeRepresentative',
			{ secretSource: 'credentials', representativeAddress: account1.address },
			credentials(0),
		);

		assert.equal(change.status, 'representative_changed');
		assert.ok(change.hash);
		assert.equal(change.address, account0.address);
		assert.equal(change.representativeAddress, account1.address);
	});
}
