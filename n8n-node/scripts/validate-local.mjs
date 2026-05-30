import assert from 'node:assert/strict';

import { AttoMnemonic } from '@attocash/commons-core';

import { executeAttoOperation } from '../dist/nodes/Atto/operations.js';

const mnemonic = AttoMnemonic.generate();
const result = await executeAttoOperation('deriveAccount', {
	secretSource: 'node',
	walletSecretType: 'mnemonic',
	walletSecret: mnemonic.phrase,
	keyIndex: 0,
});

assert.match(result.address, /^atto:\/\//);
assert.equal(result.secretType, 'mnemonic');
assert.equal(result.keyIndex, 0);
assert.ok(result.publicKey);

console.log('OK: Atto node package can derive an account through Atto Commons');
