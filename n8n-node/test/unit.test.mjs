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
import { executeAttoOperation } from '../dist/nodes/Atto/operations.js';

test('derives account from mnemonic without returning the secret', async () => {
	const mnemonic = AttoMnemonic.generate();
	const result = await executeAttoOperation('deriveAccount', {
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

test('derives account from private key without returning the private key', async () => {
	const privateKey = AttoPrivateKey.Companion.generate();
	const privateKeyHex = toHex(privateKey.value);
	const result = await executeAttoOperation('deriveAccount', {
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
		operation: 'deriveAccount',
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
		getNode: () => ({ name: 'Atto', type: 'n8n-nodes-atto.atto', typeVersion: 1, parameters: params }),
		continueOnFail: () => false,
	};

	const output = await node.execute.call(ctx);

	assert.equal(output.length, 1);
	assert.equal(output[0].length, 1);
	assert.match(output[0][0].json.address, /^atto:\/\//);
	assert.deepEqual(output[0][0].pairedItem, { item: 0 });
	assert.deepEqual(requestedParameters, ['operation', 'secretSource', 'walletSecretType', 'walletSecret', 'keyIndex']);
});

test('validates required credentials and input fields', async () => {
	await assert.rejects(
		() => executeAttoOperation('getAccount', { lookupAddress: 'not-an-address' }, { nodeUrl: 'http://localhost' }),
		/valid Atto address/,
	);

	await assert.rejects(
		() => executeAttoOperation('getAccount', { lookupAddress: '' }, {}),
		/Node Base URL/,
	);

	await assert.rejects(
		() =>
			executeAttoOperation(
				'sendTransaction',
				{
					fromAddress: 'not-an-address',
					destinationAddress: 'not-an-address',
					amount: '1',
					amountUnit: 'ATTO',
				},
				{},
			),
		/From Account must be a valid Atto address/,
	);
});

test('validates invalid amounts before connecting to the node', async () => {
	const mnemonic = AttoMnemonic.generate();
	const seed = await toSeedAsync(mnemonic);
	const privateKey = toPrivateKey(seed, toAttoIndex(0));
	const privateKeyHex = toHex(privateKey.value);
	const address = await executeAttoOperation('deriveAccount', {
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
					fromAddress: address.address,
					destinationAddress: address.address,
					amount: '0',
					amountUnit: 'ATTO',
				},
				{ nodeUrl: 'http://127.0.0.1:1', workerUrl: 'http://127.0.0.1:1' },
			),
		/positive Atto amount/,
	);
});
