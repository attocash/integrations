import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { AttoTransaction } from '@attocash/commons-core';
import { parseAttoExactRequirement, paymentPayload } from '../dist/spending/atto-x402.js';

test('Commons 8 signed SEND preserves raw unsigned integers above 2^53 inside x402 payment bytes', async () => {
  // Given a valid Commons 8 LOCAL SEND vector whose remaining balance is not a safe JS integer.
  const transactionJson = (await readFile(new URL('./fixtures/commons8-send-bigint.json', import.meta.url), 'utf8')).trim();
  const transaction = AttoTransaction.fromJson(transactionJson);
  assert.equal(await transaction.isValid(), true);
  assert.match(transactionJson, /"balance":9007199254740993/);

  const apiUrl = 'https://marketplace.example.test/v1/agent/topups';
  const intentId = '00000000-0000-4000-8000-000000000079';
  const requirementJson = JSON.stringify({ x402Version: 2,
    resource: { url: `${apiUrl}/${intentId}` },
    accepts: [{ scheme: 'exact', network: 'atto:local', amount: '10', asset: 'atto',
      payTo: transaction.block.receiverAddress.value, maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: 'native', paymentFlow: 'authorization' } }],
    extensions: { 'payment-identifier': { schema: { type: 'object', properties: { id: { type: 'string' } } }, info: { required: true } } },
  });
  const requirement = parseAttoExactRequirement({ header: Buffer.from(requirementJson).toString('base64'),
    apiUrl, intentId, network: 'atto:local', amountRaw: '10' });

  // When Commons bytes are embedded directly into the exact-v2 x402 payload.
  const payment = paymentPayload(requirement, 'mkt079-bigint-vector', transaction);
  const decoded = Buffer.from(payment.header, 'base64').toString('utf8');

  // Then the complete signed transaction and raw 64-bit balance survive byte-for-byte.
  assert.ok(decoded.includes(`"transaction":${transactionJson}`));
  assert.ok(decoded.includes('"balance":9007199254740993'));
  assert.doesNotMatch(decoded, /"balance":9007199254740992|"balance":9007199254740994/);
});

test('x402 challenges reject unsupported mechanism fields and resources outside the exact intent', async () => {
  // Given a valid immutable exact-v2 Marketplace challenge for the signed LOCAL vector.
  const transactionJson = (await readFile(new URL('./fixtures/commons8-send-bigint.json', import.meta.url), 'utf8')).trim();
  const transaction = AttoTransaction.fromJson(transactionJson);
  const apiUrl = 'https://marketplace.example.test/v1/agent/topups';
  const intentId = '00000000-0000-4000-8000-000000000079';
  const base = { x402Version: 2, resource: { url: `${apiUrl}/${intentId}` },
    accepts: [{ scheme: 'exact', network: 'atto:local', amount: '10', asset: 'atto',
      payTo: transaction.block.receiverAddress.value, maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: 'native', paymentFlow: 'authorization' } }],
    extensions: { 'payment-identifier': { schema: { type: 'object' }, info: { required: true } } },
  };
  const parse = value => parseAttoExactRequirement({ header: Buffer.from(JSON.stringify(value)).toString('base64'),
    apiUrl, intentId, network: 'atto:local', amountRaw: '10' });

  // When a challenge changes scheme, network, amount, asset, native flow, or required identifier.
  for (const candidate of [
    { ...base, x402Version: 1 },
    { ...base, accepts: [...base.accepts, base.accepts[0]] },
    { ...base, accepts: [{ ...base.accepts[0], scheme: 'upto' }] },
    { ...base, accepts: [{ ...base.accepts[0], network: 'atto:live' }] },
    { ...base, accepts: [{ ...base.accepts[0], amount: '11' }] },
    { ...base, accepts: [{ ...base.accepts[0], asset: 'xno' }] },
    { ...base, accepts: [{ ...base.accepts[0], extra: { assetTransferMethod: 'native-state', paymentFlow: 'upfront' } }] },
    { ...base, extensions: { 'payment-identifier': { schema: { type: 'object' }, info: { required: false } } } },
  ]) assert.throws(() => parse(candidate), { code: 'MARKETPLACE_PROTOCOL' });

  // Then resource origin, intent path, query, and fragment are checked separately from payment terms.
  assert.throws(() => parse({ ...base, resource: { url: 'https://other.example/v1/agent/topups/' + intentId } }), { code: 'MARKETPLACE_RESOURCE_MISMATCH' });
  assert.throws(() => parse({ ...base, resource: { url: `${apiUrl}/${intentId}?next=elsewhere` } }), { code: 'MARKETPLACE_RESOURCE_MISMATCH' });
});
