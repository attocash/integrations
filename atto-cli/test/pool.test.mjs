import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AttoAccount } from '@attocash/commons-core';

const packageDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const { planPayment } = await import(pathToFileURL(join(packageDirectory, 'dist/spending/pool.js')).href);

function candidate(index, balance, workReady = false) {
  const publicKey = (index + 1).toString(16).padStart(2, '0').repeat(32);
  const account = AttoAccount.fromJson(JSON.stringify({
    network: 'LOCAL', version: 0, algorithm: 'V1', publicKey,
    height: 3, balance, lastTransactionHash: '11'.repeat(32),
    lastTransactionTimestamp: 1704616009211, representativeAlgorithm: 'V1', representativePublicKey: publicKey,
  }));
  return { account, workReady, address: { index, publicKey, address: account.address.value, active: true } };
}

test('a sufficient ready account wins without splitting or consolidating a single payment', () => {
  // Given
  const accounts = [candidate(0, 1000), candidate(1, 80, true), candidate(2, 60, true)];

  // When
  const planned = planPayment(accounts, '70', true);

  // Then
  assert.equal(planned.source.address.index, 1);
  assert.deepEqual(planned.plan, { indexes: [1], steps: [] });
  assert.deepEqual(accounts.map(value => value.account.balance.toString()), ['1000', '80', '60']);
});

test('consolidation uses the fewest donors and transfers only the exact shortfall', () => {
  // Given: input order and prepared work must not cause unnecessary internal transfers.
  const accounts = [candidate(3, 1, true), candidate(2, 30, true), candidate(0, 40), candidate(1, 35)];

  // When
  const planned = planPayment(accounts, '80', true);
  const sends = planned.plan.steps.filter(step => step.kind === 'send');
  const receives = planned.plan.steps.filter(step => step.kind === 'receive');

  // Then
  assert.equal(planned.source.address.index, 0);
  assert.deepEqual(planned.plan.indexes, [0, 1, 2]);
  assert.deepEqual(sends.map(({ index, raw }) => ({ index, raw })), [{ index: 1, raw: '35' }, { index: 2, raw: '5' }]);
  assert.equal(sends.reduce((sum, step) => sum + BigInt(step.raw), 0n), 40n);
  assert.deepEqual(planned.plan.steps.map(step => step.kind), ['send', 'receive', 'send', 'receive']);
  for (let index = 0; index < sends.length; index++) {
    assert.equal(sends[index].destination, planned.source.address.address);
    assert.equal(receives[index].sourceStepId, sends[index].id);
    assert.equal(receives[index].index, planned.source.address.index);
    assert.equal(receives[index].raw, sends[index].raw);
  }
});

test('a pool cannot implicitly split external sends when consolidation is disabled', () => {
  // Given
  const accounts = [candidate(0, 40), candidate(1, 35)];

  // When / Then
  assert.throws(() => planPayment(accounts, '70', false), { code: 'CONSOLIDATION_REQUIRED' });
  assert.throws(() => planPayment(accounts, '76', false), { code: 'INSUFFICIENT_BALANCE' });
  assert.throws(() => planPayment(accounts, '76', true), { code: 'INSUFFICIENT_BALANCE' });
  assert.throws(() => planPayment([accounts[0]], '70', true), { code: 'INSUFFICIENT_BALANCE' });
});
