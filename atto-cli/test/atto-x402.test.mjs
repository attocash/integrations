import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { AttoTransaction } from '@attocash/commons-core';
import { parseAttoExactRequirement, paymentPayload, paymentTransactionMatches, savedPaymentMatches } from '../dist/spending/atto-x402.js';

test('Commons 8 signed SEND uses exact decimal strings on x402 wire and preserves native signed bytes', async () => {
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

  // When the draft x402 profile is read by an ordinary JSON parser.
  const payment = paymentPayload(requirement, 'mkt079-bigint-vector', transaction);
  const decoded = Buffer.from(payment.header, 'base64').toString('utf8');

  // Then the decimal strings survive and reconstruct the exact signed native transaction.
  const wire = JSON.parse(decoded).payload.transaction;
  for (const field of ['height', 'balance', 'timestamp', 'amount']) assert.equal(typeof wire.block[field], 'string');
  assert.equal(wire.block.balance, '9007199254740993');
  assert.equal(wire.signature, transaction.signature.toString());
  assert.equal(wire.work, transaction.work.toString());
  assert.equal(paymentTransactionMatches(decoded, transaction), true);
  const normalized = AttoTransaction.fromJson(JSON.stringify({ ...wire, block: { ...wire.block,
    publicKey: transaction.block.publicKey.toString(), receiverAlgorithm: transaction.block.receiverAlgorithm.name,
    receiverPublicKey: transaction.block.receiverPublicKey.toString() } }));
  assert.equal(normalized.hash.toString(), transaction.hash.toString());
  assert.deepEqual(normalized.toByteArray(), transaction.toByteArray());
  assert.equal(normalized.toJson(), transactionJson);
  assert.equal(await normalized.isValid(), true);
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
    ...[1, 2.5, '2', 4294967298].map(x402Version => ({ ...base, x402Version })),
    { ...base, accepts: [...base.accepts, base.accepts[0]] },
    { ...base, accepts: [{ ...base.accepts[0], scheme: 'upto' }] },
    { ...base, accepts: [{ ...base.accepts[0], network: 'atto:live' }] },
    { ...base, accepts: [{ ...base.accepts[0], amount: '11' }] },
    { ...base, accepts: [{ ...base.accepts[0], asset: 'xno' }] },
    ...[null, [], { assetTransferMethod: null }, { paymentFlow: null }, { assetTransferMethod: '' }, { paymentFlow: 'upfront' }, { assetTransferMethod: 'native-state' }].map(extra => ({ ...base, accepts: [{ ...base.accepts[0], extra }] })),
    { ...base, extensions: { 'payment-identifier': { schema: { type: 'object' }, info: { required: false } } } },
  ]) assert.throws(() => parse(candidate), { code: 'MARKETPLACE_PROTOCOL' });

  // Then resource origin, intent path, query, and fragment are checked separately from payment terms.
  assert.throws(() => parse({ ...base, resource: { url: 'https://other.example/v1/agent/topups/' + intentId } }), { code: 'MARKETPLACE_RESOURCE_MISMATCH' });
  assert.throws(() => parse({ ...base, resource: { url: `${apiUrl}/${intentId}?next=elsewhere` } }), { code: 'MARKETPLACE_RESOURCE_MISMATCH' });
});

async function challenge() {
  const transaction = AttoTransaction.fromJson((await readFile(new URL('./fixtures/commons8-send-bigint.json', import.meta.url), 'utf8')).trim());
  const apiUrl = 'https://marketplace.example.test/v1/agent/topups', intentId = '00000000-0000-4000-8000-000000000079';
  const value = { x402Version: 2, resource: { url: `${apiUrl}/${intentId}`, description: 'An exact top-up' },
    accepts: [{ scheme: 'exact', network: 'atto:local', amount: '10', asset: 'atto', payTo: transaction.block.receiverAddress.value,
      maxTimeoutSeconds: 300, extra: { assetTransferMethod: 'native', paymentFlow: 'authorization', merchant: 'unchanged' } }],
    extensions: { 'payment-identifier': { schema: { type: 'object' }, info: { required: true, merchantOrder: 'order-123' } },
      'merchant-data': { schema: { type: 'object' }, info: { nested: { order: 123 } } } } };
  const parse = value => parseAttoExactRequirement({ header: Buffer.from(JSON.stringify(value)).toString('base64'),
    apiUrl, intentId, network: value.accepts[0].network, amountRaw: '10' });
  return { transaction, value, parse };
}

test('omitted native and authorization defaults preserve the exact offered requirements and extension metadata', async () => {
  // Given each draft-permitted omission and unknown server extension metadata.
  const { transaction, value, parse } = await challenge();
  for (const extra of [undefined, {}, { assetTransferMethod: 'native' }, { paymentFlow: 'authorization' }]) {
    const accepted = { ...value.accepts[0], extra };
    // When the client selects the default native authorization method.
    const requirement = parse({ ...value, accepts: [accepted] });
    const payment = JSON.parse(paymentPayload(requirement, 'payment-identifier-123', transaction).json);
    // Then the original terms, schema and every offered info value survive unchanged.
    assert.deepEqual(payment.accepted, JSON.parse(JSON.stringify(accepted)));
    assert.deepEqual(payment.resource, value.resource);
    assert.deepEqual(payment.extensions, { ...value.extensions, 'payment-identifier': {
      ...value.extensions['payment-identifier'], info: { ...value.extensions['payment-identifier'].info, id: 'payment-identifier-123' } } });
  }
});

test('offered payment identifiers may be retained but cannot be overwritten', async () => {
  // Given the server has already supplied its identifier.
  const { transaction, value, parse } = await challenge();
  value.extensions['payment-identifier'].info.id = 'original-payment-123';
  const requirement = parse(value);
  // When the client retains it or attempts to substitute a different value.
  const payment = paymentPayload(requirement, 'original-payment-123', transaction);
  // Then original metadata survives and conflicting identifiers fail before a payload is returned.
  assert.equal(JSON.parse(payment.json).extensions['payment-identifier'].info.id, 'original-payment-123');
  assert.throws(() => paymentPayload(requirement, 'different-payment-123', transaction), { code: 'MARKETPLACE_PROTOCOL' });
});

test('native envelope binding rejects changed fields, signatures, work and noncanonical decimal profiles', async () => {
  // Given an exact address-only wire transaction and its retained native transaction.
  const { transaction, value, parse } = await challenge();
  const original = JSON.parse(paymentPayload(parse(value), 'binding-identifier-123', transaction).json);
  const matches = change => { const payment = structuredClone(original); change(payment); return paymentTransactionMatches(JSON.stringify(payment), transaction); };
  // When equivalent redundant fields are included, then the complete native byte identity remains valid.
  assert.equal(matches(payment => Object.assign(payment.payload.transaction.block, { publicKey: transaction.block.publicKey.toString(),
    receiverAlgorithm: transaction.block.receiverAlgorithm.name, receiverPublicKey: transaction.block.receiverPublicKey.toString() })), true);
  // When signed fields or profile encodings are changed, then none can match the journal's native SEND.
  for (const [field, values] of Object.entries({ height: ['3', '02', 2, '0', '18446744073709551616'],
    balance: ['9007199254740992', '09007199254740993', 9007199254740992],
    timestamp: ['1704616009212', '-0', '+1704616009211', '1e3', ' 1704616009211'],
    amount: ['11', '10.0', '0', '-10'] })) {
    for (const candidate of values) assert.equal(matches(payment => { payment.payload.transaction.block[field] = candidate; }), false, `${field}=${candidate}`);
  }
  for (const field of ['signature', 'work']) assert.equal(matches(payment => { payment.payload.transaction[field] = '00'.repeat(field === 'signature' ? 64 : 8); }), false);
  for (const field of ['address', 'receiverAddress', 'publicKey', 'receiverAlgorithm', 'receiverPublicKey']) {
    assert.equal(matches(payment => { payment.payload.transaction.block[field] = 'changed'; }), false, field);
  }
  assert.equal(matches(payment => { payment.payload.transaction.block.version = '0'; }), false);
});

test('retained numeric payment envelopes recover their original exact bytes without regenerating signatures', async () => {
  // Given a previously issued envelope containing the original native numeric JSON.
  const { transaction, value, parse } = await challenge();
  const requirement = parse(value), identifier = 'retained-payment-123';
  const legacy = `{"x402Version":2,"resource":${JSON.stringify(requirement.resource)},"accepted":${JSON.stringify(requirement.accepted)},"payload":{"transaction":${transaction.toJson()}},"extensions":{"payment-identifier":{"schema":${JSON.stringify(requirement.identifierSchema)},"info":{"required":true,"id":${JSON.stringify(identifier)}}}}}`;
  // When recovery validates the retained bytes, then they remain accepted only with their matching header.
  assert.equal(savedPaymentMatches(requirement, identifier, transaction, legacy, Buffer.from(legacy).toString('base64')), true);
  assert.equal(savedPaymentMatches(requirement, identifier, transaction, legacy.replace('9007199254740993', '9007199254740992'), Buffer.from(legacy).toString('base64')), false);
  assert.equal(savedPaymentMatches(requirement, identifier, transaction, legacy, Buffer.from(legacy + ' ').toString('base64')), false);
});
