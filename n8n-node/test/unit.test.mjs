import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
	AttoAlgorithm,
	AttoMnemonic,
	AttoPrivateKey,
	toAttoIndex,
	toHex,
	toPrivateKey,
	toPublicKey,
	toSeedAsync,
} from '@attocash/commons-core';

const require = createRequire(import.meta.url);
const { NodeApiError, NodeOperationError } = require('n8n-workflow');

import { Atto } from '../dist/nodes/Atto/Atto.node.js';
import { AttoTrigger } from '../dist/nodes/AttoTrigger/AttoTrigger.node.js';
import { executeAttoOperation } from '../dist/nodes/Atto/operations.js';
import {
	addressFromPublicKey,
	blockHash,
	createSendBlock,
	deriveAddressFromSecret,
	parseAddress,
	parseAmount,
	parseAttoJson,
} from '../dist/nodes/Atto/protocol.js';

test('derives the same mnemonic key and address as Atto Commons', async () => {
	const phrase = 'edge defense waste choose enrich upon flee junk siren film clown finish luggage leader kid quick brick print evidence swap drill paddle truly occur';
	const mnemonic = await AttoMnemonic.fromPhrase(phrase);
	const seed = await toSeedAsync(mnemonic);
	const expectedPrivateKey = await toPrivateKey(seed, toAttoIndex(0));
	const expectedPublicKey = await toPublicKey(expectedPrivateKey);
	const expectedAddress = addressFromPublicKey(expectedPublicKey.toString());

	const result = await deriveAddressFromSecret({
		secretSource: 'node',
		walletSecretType: 'mnemonic',
		walletSecret: phrase,
		keyIndex: 0,
	});

	assert.equal(result.signer.publicKey.toString(), expectedPublicKey.toString());
	assert.equal(result.publicKey, expectedPublicKey.toString());
	assert.equal(result.value, expectedAddress.value);
	assert.equal(parseAddress(result.value).publicKey, result.publicKey);
	assert.equal('privateKey' in result, false);
});

test('derives a private-key address without returning the secret', async () => {
	const privateKey = AttoPrivateKey.Companion.generate();
	const privateKeyHex = toHex(privateKey.value);
	const result = await executeAttoOperation(
		undefined,
		'deriveAddress',
		{
			secretSource: 'node',
			walletSecretType: 'privateKey',
			walletSecret: privateKeyHex,
		},
	);

	assert.equal(result.secretType, 'privateKey');
	assert.match(result.address, /^atto:\/\//);
	assert.equal(result.publicKey, (await toPublicKey(privateKey)).toString());
	assert.doesNotMatch(JSON.stringify(result), new RegExp(privateKeyHex));
});

test('serializes every Atto block type with hashes matching Atto Commons', () => {
	const common = {
		network: 'LOCAL',
		version: 0,
		algorithm: 'V1',
		publicKey: '9979705D9F9588F46667697329947688E5FFC4DF36F5D0C6A4E29D023E7BF2CE',
		balance: '12000000000',
		timestamp: 1705517157478,
	};
	const previous = '0AF0F63BFE4DBC588F95FC3B154DE848AA9A5DD5604BAC99AE9E21C5EA8B4F64';
	const otherPublicKey = '0C400961629D759176F009249A33899440900ABCE275F6C5C01C6F7F37A2C59A';
	const blocks = [
		{
			...common,
			type: 'OPEN',
			sendHashAlgorithm: 'V1',
			sendHash: previous,
			representativeAlgorithm: 'V1',
			representativePublicKey: otherPublicKey,
		},
		{
			...common,
			type: 'RECEIVE',
			height: '2',
			previous,
			sendHashAlgorithm: 'V1',
			sendHash: previous,
		},
		{
			...common,
			type: 'SEND',
			height: '2',
			previous,
			receiverAlgorithm: 'V1',
			receiverPublicKey: otherPublicKey,
			amount: '1000000000',
		},
		{
			...common,
			type: 'CHANGE',
			height: '2',
			previous,
			representativeAlgorithm: 'V1',
			representativePublicKey: otherPublicKey,
		},
	];

	const expectedHashes = [
		'0ECEF1E379CB300961966CF96DA4C95BD3AADEEED7DA109160BD3951695A37F0',
		'729C468816C5570A9C4D51150E24EFB5F4E8C440AEB7033CC0BE3086AAF54A98',
		'B3507515BD5399EE4788AD8396C070521BF6A767227AFF71DA679695A8FCA90C',
		'D8BE2F658BAA4B2E96C19915225F2264FFE7A0E48D263DF716E4765E5B6EA339',
	];
	assert.deepEqual(blocks.map(blockHash), expectedHashes);
});

test('preserves protocol-sized integers while parsing API JSON', () => {
	const parsed = parseAttoJson('{"height":18446744073709551615,"balance":18000000000000000000,"timestamp":1705517157478}');
	assert.equal(parsed.height, '18446744073709551615');
	assert.equal(parsed.balance, '18000000000000000000');
	assert.equal(parsed.timestamp, 1705517157478);
});

test('returns the stable account output without a raw-output option', async () => {
	const account = {
		publicKey: '9979705D9F9588F46667697329947688E5FFC4DF36F5D0C6A4E29D023E7BF2CE',
		network: 'LOCAL',
		version: 0,
		algorithm: 'V1',
		height: '2',
		balance: '12000000000',
		lastTransactionHash: '0AF0F63BFE4DBC588F95FC3B154DE848AA9A5DD5604BAC99AE9E21C5EA8B4F64',
		lastTransactionTimestamp: 1705517157478,
		representativeAlgorithm: 'V1',
		representativePublicKey: '0C400961629D759176F009249A33899440900ABCE275F6C5C01C6F7F37A2C59A',
		serverMetadata: 'preserved',
	};
	const address = addressFromPublicKey(account.publicKey).value;
	const context = {
		getNode: () => ({ name: 'Atto', type: '@attocash/n8n-nodes-atto.atto', typeVersion: 1, parameters: {} }),
		helpers: {
			httpRequest: async () => JSON.stringify(account),
		},
	};
	const credentials = { nodeUrl: 'http://localhost' };

	const result = await executeAttoOperation(context, 'getAccount', { address }, credentials);

	assert.deepEqual(result, {
		found: true,
		address,
		publicKey: account.publicKey,
		balance: { raw: '12000000000', atto: '12' },
		representativeAddress: addressFromPublicKey(account.representativePublicKey).value,
		height: '2',
		frontier: account.lastTransactionHash,
	});
	assert.equal('serverMetadata' in result, false);
});

test('keeps field-specific amount and send validation around Commons', () => {
	const account = {
		publicKey: '9979705D9F9588F46667697329947688E5FFC4DF36F5D0C6A4E29D023E7BF2CE',
		network: 'LOCAL',
		version: 0,
		algorithm: 'V1',
		height: '2',
		balance: '12000000000',
		lastTransactionHash: '0AF0F63BFE4DBC588F95FC3B154DE848AA9A5DD5604BAC99AE9E21C5EA8B4F64',
		lastTransactionTimestamp: 1705517157478,
		representativeAlgorithm: 'V1',
		representativePublicKey: '0C400961629D759176F009249A33899440900ABCE275F6C5C01C6F7F37A2C59A',
	};

	assert.throws(() => parseAmount('0', 'ATTO', 'Amount'), /positive Atto amount/);
	assert.throws(() => parseAmount('0.0000000001', 'ATTO', 'Amount'), /exceeds 9 decimal places/);
	assert.throws(
		() => createSendBlock(account, addressFromPublicKey(account.publicKey), parseAmount('1', 'ATTO', 'Amount'), 1705517158478),
		/Destination Address must differ/,
	);
	assert.throws(
		() => createSendBlock(account, addressFromPublicKey(account.representativePublicKey), parseAmount('13', 'ATTO', 'Amount'), 1705517158478),
		/Account balance 12000000000 is not enough to send 13000000000/,
	);
});

test('node execute passes resolved parameters and supports n8n defaults', async () => {
	const mnemonic = await AttoMnemonic.generate();
	const params = {
		resource: 'address',
		secretSource: 'node',
		walletSecretType: 'mnemonic',
		walletSecret: mnemonic.phrase,
		keyIndex: 0,
	};
	const requestedParameters = [];
	const node = new Atto();
	const context = {
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
		helpers: {},
	};

	const output = await node.execute.call(context);

	assert.match(output[0][0].json.address, /^atto:\/\//);
	assert.deepEqual(output[0][0].pairedItem, { item: 0 });
	assert.deepEqual(requestedParameters, ['resource', 'operation', 'secretSource', 'walletSecretType', 'walletSecret', 'keyIndex']);
});

test('node wraps Commons validation failures with the failing item index', async () => {
	const params = {
		resource: 'account',
		operation: 'getAccount',
		address: 'not-an-address',
	};
	const node = new Atto();
	const context = {
		getInputData: () => [{ json: {} }],
		getCredentials: async () => ({}),
		getNodeParameter: (name, _itemIndex, fallbackValue) => params[name] ?? fallbackValue,
		getNode: () => ({ name: 'Atto', type: '@attocash/n8n-nodes-atto.atto', typeVersion: 1, parameters: params }),
		continueOnFail: () => false,
		helpers: {},
	};

	await assert.rejects(
		() => node.execute.call(context),
		(error) => {
			assert.equal(error instanceof NodeOperationError, true);
			assert.equal(error.context.itemIndex, 0);
			assert.match(error.message, /invalid/);
			return true;
		},
	);
});

test('node preserves API errors and adds the failing item index', async () => {
	const publicKey = '9979705D9F9588F46667697329947688E5FFC4DF36F5D0C6A4E29D023E7BF2CE';
	const params = {
		resource: 'account',
		operation: 'getAccount',
		address: addressFromPublicKey(publicKey).value,
		simplify: true,
	};
	const nodeDescription = {
		name: 'Atto',
		type: '@attocash/n8n-nodes-atto.atto',
		typeVersion: 1,
		parameters: params,
	};
	const expectedError = new NodeApiError(nodeDescription, {
		message: 'Upstream request failed',
		statusCode: 503,
	});
	const node = new Atto();
	const context = {
		getInputData: () => [{ json: {} }],
		getCredentials: async () => ({ nodeUrl: 'http://localhost' }),
		getNodeParameter: (name, _itemIndex, fallbackValue) => params[name] ?? fallbackValue,
		getNode: () => nodeDescription,
		continueOnFail: () => false,
		helpers: {
			httpRequest: async () => {
				throw expectedError;
			},
		},
	};

	await assert.rejects(
		() => node.execute.call(context),
		(error) => {
			assert.equal(error, expectedError);
			assert.equal(error.context.itemIndex, 0);
			return true;
		},
	);
});

test('node continue-on-fail returns the original Commons message', async () => {
	const params = {
		resource: 'account',
		operation: 'getAccount',
		address: 'not-an-address',
	};
	const node = new Atto();
	const context = {
		getInputData: () => [{ json: {} }],
		getCredentials: async () => ({}),
		getNodeParameter: (name, _itemIndex, fallbackValue) => params[name] ?? fallbackValue,
		getNode: () => ({ name: 'Atto', type: '@attocash/n8n-nodes-atto.atto', typeVersion: 1, parameters: params }),
		continueOnFail: () => true,
		helpers: {},
	};

	const output = await node.execute.call(context);

	assert.match(output[0][0].json.error, /invalid/);
	assert.deepEqual(output[0][0].pairedItem, { item: 0 });
});

test('node descriptions expose streaming triggers without raw-output or polling controls', () => {
	const node = new Atto();
	const trigger = new AttoTrigger();
	const simplify = node.description.properties.find((property) => property.name === 'simplify');
	const pollTimes = trigger.description.properties.find((property) => property.name === 'pollTimes');

	assert.equal(node.description.usableAsTool, true);
	assert.equal(trigger.description.usableAsTool, true);
	assert.equal(simplify, undefined);
	assert.equal(trigger.description.polling, undefined);
	assert.equal(pollTimes, undefined);
	assert.equal(typeof trigger.trigger, 'function');
});

test('trigger startup supplies fallbacks for hidden parameters', async () => {
	const requestedParameters = [];
	const trigger = new AttoTrigger();
	const context = {
		getCredentials: async () => ({ nodeUrl: 'http://localhost' }),
		getNodeParameter: (name, fallbackValue) => {
			requestedParameters.push(name);
			if (fallbackValue !== undefined) return fallbackValue;
			throw new Error(`Could not get parameter ${name}`);
		},
		getNode: () => ({ name: 'Atto Trigger', type: '@attocash/n8n-nodes-atto.attoTrigger', typeVersion: 1, parameters: {} }),
		emit: () => {},
	};

	await assert.rejects(() => trigger.trigger.call(context), /Wallet Secret/);
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

test('trigger fails startup for invalid configuration', async () => {
	const params = {
		event: 'account',
		addressSource: 'all',
	};
	const nodeDescription = {
		name: 'Atto Trigger',
		type: '@attocash/n8n-nodes-atto.attoTrigger',
		typeVersion: 1,
		parameters: params,
	};
	const trigger = new AttoTrigger();
	const context = {
		getCredentials: async () => ({ nodeUrl: 'not-a-url' }),
		getNodeParameter: (name, fallbackValue) => params[name] ?? fallbackValue,
		getNode: () => nodeDescription,
		emit: () => {},
	};

	await assert.rejects(
		() => trigger.trigger.call(context),
		(error) => {
			assert.equal(error instanceof NodeOperationError, true);
			assert.match(error.message, /valid HTTP Node Base URL/);
			return true;
		},
	);
});

test('rejects malformed addresses and mnemonic input', async () => {
	assert.throws(() => parseAddress('not-an-address'), /invalid/);
	await assert.rejects(
		() => deriveAddressFromSecret({ secretSource: 'node', walletSecretType: 'mnemonic', walletSecret: 'too short', keyIndex: 0 }),
		/24 words/,
	);
	assert.equal(AttoAlgorithm.V1.name, 'V1');
});
