import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import {
	AttoMnemonic,
	toAttoIndex,
	toPrivateKey,
	toSeedAsync,
} from '@attocash/commons-core';
import { AttoNodeMockAsyncBuilder, AttoWorkerMockAsyncBuilder } from '@attocash/commons-test';

import { executeAttoOperation } from '../dist/nodes/Atto/operations.js';

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
	const mnemonic = AttoMnemonic.generate();
	const seed = await toSeedAsync(mnemonic);
	const privateKey0 = toPrivateKey(seed, toAttoIndex(0));

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

	async function derive(keyIndex) {
		return await executeAttoOperation(
			'deriveAccount',
			{ secretSource: 'credentials' },
			credentials(keyIndex),
		);
	}

	test('uses AttoNodeMock for derive, send, account info, receive, and representative change', async () => {
		const account0 = await derive(0);
		const account1 = await derive(1);

		assert.match(account0.address, /^atto:\/\//);
		assert.match(account1.address, /^atto:\/\//);
		assert.notEqual(account0.address, account1.address);

		const send = await executeAttoOperation(
			'sendTransaction',
			{
				secretSource: 'credentials',
				fromAddress: account0.address,
				destinationAddress: account1.address,
				amount: '1',
				amountUnit: 'ATTO',
			},
			credentials(0),
		);

		assert.equal(send.status, 'published');
		assert.ok(send.hash);

		const accountInfo = await executeAttoOperation(
			'getAccount',
			{ lookupAddress: account0.address },
			credentials(0),
		);

		assert.equal(accountInfo.found, true);
		assert.equal(accountInfo.address, account0.address);
		assert.ok(accountInfo.balance.raw);
		assert.ok(accountInfo.frontier);

		const receive = await executeAttoOperation(
			'receivePending',
			{
				secretSource: 'credentials',
				receiveAddress: account1.address,
				receiveRepresentativeAddress: account1.address,
				minAmount: '1',
				minAmountUnit: 'RAW',
				timeoutMs: 10000,
			},
			credentials(1),
		);

		assert.equal(receive.status, 'received');
		assert.ok(receive.hash);
		assert.equal(receive.account, account1.address);
		assert.ok(receive.amount.raw);

		const change = await executeAttoOperation(
			'changeRepresentative',
			{
				secretSource: 'credentials',
				changeAddress: account0.address,
				representativeAddress: account1.address,
			},
			credentials(0),
		);

		assert.equal(change.status, 'representative_changed');
		assert.ok(change.hash);
		assert.equal(change.representative, account1.address);
	});
}
