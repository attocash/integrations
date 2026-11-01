import assert from 'node:assert/strict';
import test from 'node:test';
import { AttoAlgorithm, AttoPublicKey } from '@attocash/commons-core';
import { publicEntry } from '../dist/network/entry.js';

const publicKey = '11'.repeat(32);
const subjectPublicKey = '22'.repeat(32);
const address = AttoPublicKey.Companion.parse(publicKey).toAddress(AttoAlgorithm.V1).value;
const subjectAddress = AttoPublicKey.Companion.parse(subjectPublicKey).toAddress(AttoAlgorithm.V1).value;
const entry = (blockType, previousBalance, balance) => ({
  hash: 'ab'.repeat(32), algorithm: 'V1', publicKey, height: '9007199254740993', blockType,
  subjectAlgorithm: 'V1', subjectPublicKey, previousBalance, balance, timestamp: 1704616009211,
});

for (const [action, role, previous, balance, raw, atto] of [
  ['SEND', 'receiver', '18446744073709551615', '9007199254740993', '18437736874454810622', '18437736874.454810622'],
  ['OPEN', 'sender', '0', '18446744073709551615', '18446744073709551615', '18446744073.709551615'],
  ['RECEIVE', 'sender', '9007199254740993', '18446744073709551615', '18437736874454810622', '18437736874.454810622'],
  ['CHANGE', 'representative', '18446744073709551615', '18446744073709551615'],
]) {
  test(`${action} presents the account owner and ${role} with exact action amounts`, () => {
    // Given a serialized entry whose balances exceed Number precision.
    const original = Object.freeze(entry(action, previous, balance));
    const snapshot = structuredClone(original);

    // When the entry is presented as an account action.
    const result = publicEntry(original);

    // Then all protocol fields survive and the subject follows the action semantics.
    for (const [key, value] of Object.entries(snapshot)) assert.deepEqual(result[key], value);
    assert.equal(result.address, address);
    assert.equal(result.subjectAddress, subjectAddress);
    assert.equal(result.subjectRole, role);
    if (action === 'CHANGE') assert.equal(Object.hasOwn(result, 'amount'), false);
    else assert.deepEqual(result.amount, { raw, atto });
    assert.deepEqual(original, snapshot);
    assert.notEqual(result, original);
    assert.deepEqual(publicEntry(result), result);
  });
}

test('Raw transactions, unrelated objects, and null retain their original representation', () => {
  // Given signed protocol data and values outside the account-entry contract.
  const transaction = { block: { type: 'SEND', algorithm: 'V1', publicKey, balance: '9007199254740993', receiverPublicKey: subjectPublicKey },
    signature: 'cd'.repeat(64), work: 'ef'.repeat(8) };
  const values = [null, transaction, { balance: '100' }, { blockType: 'SEND', subjectPublicKey }, [entry('OPEN', '0', '100')]];

  // When the presentation helper sees each value.
  const results = values.map(publicEntry);

  // Then only complete serialized account entries qualify for action presentation.
  results.forEach((result, index) => assert.equal(result, values[index]));
});

test('Existing entry properties remain unchanged when presentation details already exist', () => {
  // Given an entry already carrying caller-supplied presentation fields.
  const original = { ...entry('RECEIVE', '0', '100'), address, subjectAddress, subjectRole: 'sender', amount: { raw: '100', atto: '0.0000001' }, metadata: { note: 'saved' } };

  // When action presentation runs again.
  const result = publicEntry(original);

  // Then every original field, including nested metadata, is preserved.
  assert.deepEqual(result, original);
  assert.equal(result.metadata, original.metadata);
  assert.equal(result.amount, original.amount);
});
