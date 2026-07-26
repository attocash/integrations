import assert from 'node:assert/strict';

import { AttoMnemonic } from '@attocash/commons-core';

import { executeAttoOperation } from '../dist/nodes/Atto/operations.js';

const mnemonic = await AttoMnemonic.generate();
const result = await executeAttoOperation(
	undefined,
	'deriveAddress',
	{
		secretSource: 'node',
		walletSecretType: 'mnemonic',
		walletSecret: mnemonic.phrase,
		keyIndex: 0,
	},
);

assert.match(result.address, /^atto:\/\//);
assert.equal(result.secretType, 'mnemonic');
assert.equal(result.keyIndex, 0);
assert.ok(result.publicKey);

console.log('OK: Atto node package can derive an address through Atto Commons');
