import test from 'node:test';
import assert from 'node:assert/strict';

import {
	AttoMnemonic,
	AttoPrivateKey,
	toAttoIndex,
	toHex,
	toPrivateKey,
	toSeedAsync,
} from '@attocash/commons-core';

import { Atto } from '../dist/nodes/Atto/Atto.node.js';
import { AttoTrigger } from '../dist/nodes/AttoTrigger/AttoTrigger.node.js';
import { executeAttoOperation } from '../dist/nodes/Atto/operations.js';

test('derives address from mnemonic without returning the secret', async () => {
	const mnemonic = AttoMnemonic.generate();
	const result = await executeAttoOperation('deriveAddress', {
		secretSource: 'node',
		walletSecretType: 'mnemonic',
		walletSecret: mnemonic.phrase,
		keyIndex: 0,
	});

	assert.equal(result.secretType, 'mnemonic');
	assert.equal(result.keyIndex, 0);
	assert.match(result.address, /^atto:\/\//);
	assert.ok(result.publicKey);
	assert.doesNotMatch(JSON.stringify(result), new RegExp(mnemonic.phrase.split(' ')[0]));
});

test('keeps the derive account operation as a backward-compatible alias', async () => {
	const mnemonic = AttoMnemonic.generate();
	const result = await executeAttoOperation('deriveAccount', {
		secretSource: 'node',
		walletSecretType: 'mnemonic',
		walletSecret: mnemonic.phrase,
		keyIndex: 0,
	});

	assert.match(result.address, /^atto:\/\//);
	assert.ok(result.publicKey);
});

test('derives address from private key without returning the private key', async () => {
	const privateKey = AttoPrivateKey.Companion.generate();
	const privateKeyHex = toHex(privateKey.value);
	const result = await executeAttoOperation('deriveAddress', {
		secretSource: 'node',
		walletSecretType: 'privateKey',
		walletSecret: privateKeyHex,
	});

	assert.equal(result.secretType, 'privateKey');
	assert.match(result.address, /^atto:\/\//);
	assert.ok(result.publicKey);
	assert.doesNotMatch(JSON.stringify(result), new RegExp(privateKeyHex));
});

test('node execute passes resolved parameters to the operation', async () => {
	const mnemonic = AttoMnemonic.generate();
	const params = {
		resource: 'address',
		operation: 'deriveAddress',
		secretSource: 'node',
		walletSecretType: 'mnemonic',
		walletSecret: mnemonic.phrase,
		keyIndex: 0,
	};
	const requestedParameters = [];
	const node = new Atto();
	const ctx = {
		getInputData: () => [{ json: {} }],
		getCredentials: async () => ({}),
		getNodeParameter: (name) => {
			requestedParameters.push(name);
			if (!(name in params)) throw new Error(`Unexpected parameter ${name}`);
			return params[name];
		},
		getNode: () => ({ name: 'Atto', type: '@attocash/n8n-nodes-atto.atto', typeVersion: 1, parameters: params }),
		continueOnFail: () => false,
	};

	const output = await node.execute.call(ctx);

	assert.equal(output.length, 1);
	assert.equal(output[0].length, 1);
	assert.match(output[0][0].json.address, /^atto:\/\//);
	assert.deepEqual(output[0][0].pairedItem, { item: 0 });
	assert.deepEqual(requestedParameters, ['resource', 'operation', 'secretSource', 'walletSecretType', 'walletSecret', 'keyIndex']);
});

test('node execute falls back to the default operation when n8n has not persisted it', async () => {
	const mnemonic = AttoMnemonic.generate();
	const params = {
		resource: 'address',
		secretSource: 'node',
		walletSecretType: 'mnemonic',
		walletSecret: mnemonic.phrase,
		keyIndex: 0,
	};
	const requestedParameters = [];
	const node = new Atto();
	const ctx = {
		getInputData: () => [{ json: {} }],
		getCredentials: async () => ({}),
		getNodeParameter: (name, _itemIndex, fallbackValue) => {
			requestedParameters.push(name);
			if (name in params) return params[name];
			if (fallbackValue !== undefined) return fallbackValue;
			throw new Error(`Could not get parameter ${name}`);
		},
		getNode: () => ({ name: 'Atto', type: '@attocash/n8n-nodes-atto.atto', typeVersion: 1, parameters: params }),
		continueOnFail: () => false,
	};

	const output = await node.execute.call(ctx);

	assert.equal(output.length, 1);
	assert.equal(output[0].length, 1);
	assert.match(output[0][0].json.address, /^atto:\/\//);
	assert.deepEqual(requestedParameters, ['resource', 'operation', 'secretSource', 'walletSecretType', 'walletSecret', 'keyIndex']);
});

test('receive action reads only parameters needed for input receivables', async () => {
	const params = {
		resource: 'receivable',
		operation: 'receivePending',
		secretSource: 'credentials',
		representativeAddress: '',
		timeoutMs: 60000,
	};
	const requestedParameters = [];
	const node = new Atto();
	const ctx = {
		getInputData: () => [{ json: {} }],
		getCredentials: async () => ({}),
		getNodeParameter: (name, _itemIndex, fallbackValue) => {
			requestedParameters.push(name);
			if (name in params) return params[name];
			if (fallbackValue !== undefined) return fallbackValue;
			throw new Error(`Could not get parameter ${name}`);
		},
		getNode: () => ({ name: 'Atto', type: '@attocash/n8n-nodes-atto.atto', typeVersion: 1, parameters: params }),
		continueOnFail: () => false,
	};

	await assert.rejects(() => node.execute.call(ctx), /valid Atto receivable object/);
	assert.deepEqual(requestedParameters, [
		'resource',
		'operation',
		'secretSource',
		'walletSecretType',
		'walletSecret',
		'keyIndex',
		'representativeAddress',
		'timeoutMs',
	]);
});

test('send and receive expose a one minute publish timeout by default', () => {
	const node = new Atto();
	const publishTimeout = node.description.properties.find(
		(property) =>
			property.name === 'timeoutMs' &&
			Array.isArray(property.displayOptions?.show?.operation) &&
			property.displayOptions.show.operation.includes('sendTransaction'),
	);
	const streamTimeout = node.description.properties.find(
		(property) =>
			property.name === 'timeoutMs' &&
			Array.isArray(property.displayOptions?.show?.operation) &&
			property.displayOptions.show.operation.includes('getReceivables'),
	);
	const receivableSource = node.description.properties.find((property) => property.name === 'receivableSource');
	const minAmount = node.description.properties.find((property) => property.name === 'minAmount');

	assert.equal(publishTimeout.default, 60000);
	assert.deepEqual(publishTimeout.displayOptions.show.operation, ['sendTransaction', 'receivePending']);
	assert.equal(streamTimeout.default, 5000);
	assert.deepEqual(streamTimeout.displayOptions.show.operation, ['getReceivables', 'getTransactions', 'getAccountEntries']);
	assert.equal(receivableSource, undefined);
	assert.deepEqual(minAmount.displayOptions.show.operation, ['getReceivables']);
});

test('trigger execution falls back when n8n has not persisted hidden default parameters', async () => {
	const requestedParameters = [];
	const trigger = new AttoTrigger();
	const ctx = {
		getCredentials: async () => ({ nodeUrl: 'http://localhost' }),
		getNodeParameter: (name, fallbackValue) => {
			requestedParameters.push(name);
			if (fallbackValue !== undefined) return fallbackValue;
			throw new Error(`Could not get parameter ${name}`);
		},
		getNode: () => ({ name: 'Atto Trigger', type: '@attocash/n8n-nodes-atto.attoTrigger', typeVersion: 1, parameters: {} }),
		emit: () => {},
		emitError: () => {},
	};

	await assert.rejects(() => trigger.trigger.call(ctx), /Wallet Secret/);
	assert.deepEqual(requestedParameters, [
		'event',
		'addressSource',
		'addresses',
		'queryMode',
		'hash',
		'fromHeight',
		'toHeight',
		'minAmount',
		'minAmountUnit',
	]);
});

test('validates required credentials and input fields', async () => {
	await assert.rejects(
		() => executeAttoOperation('getAccount', { address: 'not-an-address' }, { nodeUrl: 'http://localhost' }),
		/valid Atto address/,
	);

	await assert.rejects(
		() => executeAttoOperation('getAccount', { address: '' }, {}),
		/Node Base URL/,
	);

	await assert.rejects(
		() =>
			executeAttoOperation(
				'sendTransaction',
				{
					destinationAddress: 'not-an-address',
					amount: '1',
					amountUnit: 'ATTO',
				},
				{},
			),
		/Destination Address must be a valid Atto address/,
	);

	await assert.rejects(
		() =>
			executeAttoOperation(
				'getTransactions',
				{
					queryMode: 'hash',
					hash: 'not-a-hash',
				},
				{ nodeUrl: 'http://localhost' },
			),
		/Hash must be a valid Atto hash/,
	);

	await assert.rejects(
		() => executeAttoOperation('receivePending', { inputItem: undefined }),
		/Input item must contain a receivable object/,
	);

	await assert.rejects(
		() => executeAttoOperation('receivePending', { inputItem: { receivable: { invalid: true } } }),
		/Input item must contain a valid Atto receivable object/,
	);
});

test('validates invalid amounts before connecting to the node', async () => {
	const mnemonic = AttoMnemonic.generate();
	const seed = await toSeedAsync(mnemonic);
	const privateKey = toPrivateKey(seed, toAttoIndex(0));
	const privateKeyHex = toHex(privateKey.value);
	const address = await executeAttoOperation('deriveAddress', {
		secretSource: 'node',
		walletSecretType: 'privateKey',
		walletSecret: privateKeyHex,
	});

	await assert.rejects(
		() =>
			executeAttoOperation(
				'sendTransaction',
				{
					secretSource: 'node',
					walletSecretType: 'privateKey',
					walletSecret: privateKeyHex,
					destinationAddress: address.address,
					amount: '0',
					amountUnit: 'ATTO',
				},
				{ nodeUrl: 'http://127.0.0.1:1', workerUrl: 'http://127.0.0.1:1' },
			),
		/positive Atto amount/,
	);
});
