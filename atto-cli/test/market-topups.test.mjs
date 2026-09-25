import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { AttoMnemonic } from '@attocash/commons-core';
import { derivedSigner } from '../dist/wallet/signing.js';
import { MarketTopUpClient, validateMarketApiUrl } from '../dist/market/topups.js';

const apiUrl = 'http://127.0.0.1:43210/v1/agent/topups';
const intentId = '00000000-0000-4000-8000-000000000079';
const accountId = '00000000-0000-4000-8000-000000000100';
const agentId = '00000000-0000-4000-8000-000000000102';
const identityId = '00000000-0000-4000-8000-000000000101';

function topUpStatus(changes = {}) {
  return { intentId, asset: 'ATTO', network: 'atto:local', amountAtomic: '10', state: 'ISSUED',
    expiresAt: new Date(Date.now() + 300_000).toISOString(), sendHash: null, payer: null,
    paymentState: 'PREPARED', receivePending: null, discrepancy: null, ...changes };
}

function requirementHeader(payTo) {
  const value = { x402Version: 2, resource: { url: `${apiUrl}/${intentId}` }, accepts: [{ scheme: 'exact',
    network: 'atto:local', amount: '10', asset: 'atto', payTo, maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: 'native', paymentFlow: 'authorization' } }],
  extensions: { 'payment-identifier': { info: { required: true }, schema: { type: 'object', required: ['required'], properties: {
    required: { type: 'boolean' }, id: { type: 'string', minLength: 16, maxLength: 128 },
  } } } } };
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

test('Market URL validation keeps the fixed resource path and confines HTTP to loopback LOCAL', () => {
  // Given
  const validHttps = 'https://market.example/v1/agent/topups';

  // When / Then
  assert.equal(validateMarketApiUrl(validHttps, 'LIVE'), validHttps);
  assert.equal(validateMarketApiUrl(apiUrl, 'LOCAL'), apiUrl);
  for (const value of ['http://market.example/v1/agent/topups', 'http://127.0.0.1/v1/agent/topups/extra',
    'https://user:secret@market.example/v1/agent/topups', 'https://market.example/v1/agent/topups?redirect=https://evil.test']) {
    assert.throws(() => validateMarketApiUrl(value, 'LOCAL'), { code: 'MARKET_CONFIGURATION' });
  }
  assert.throws(() => validateMarketApiUrl(apiUrl, 'LIVE'), { code: 'MARKET_CONFIGURATION' });
});

test('configured Market client signs its controller proof and sends a bodyless bound continuation', async t => {
  // Given a single configured local Market origin, a saved controller, and a server returning the current handshake DTOs.
  const phrase = (await AttoMnemonic.generate()).phrase;
  const seed = await (await AttoMnemonic.fromPhrase(phrase)).toSeedAsync();
  const controller = await derivedSigner(seed, 0);
  const recipient = await derivedSigner(seed, 1);
  const fingerprint = createHash('sha256').update(controller.publicKey.toString()).digest('hex');
  const saved = new Map([['identity', { address: controller.address.value, fingerprint }]]);
  const store = { get: key => saved.get(key), set: (key, value) => saved.set(key, value) };
  const calls = [];
  const order = [];
  const challengeId = '00000000-0000-4000-8000-000000000103';
  const issuedAt = new Date(Date.now() - 1000).toISOString();
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const proofMessage = `Atto Market Agent Controller Proof v1\nAudience: market-test\nNetwork: live\nAddress: ${controller.address.value}\nPurpose: login\nRequest ID: ${challengeId}\nNonce: ${'ab'.repeat(32)}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`;
  const paymentIdentifier = 'account-scoped-payment-079';
  let sessionAgentId = agentId;
  const paymentSignature = Buffer.from('opaque exact signed payment bytes').toString('base64');
  let paymentResponse = Buffer.from(JSON.stringify({ success: false, transaction: 'A'.repeat(64),
    network: 'atto:local', payer: controller.address.value, errorReason: 'settlement_pending' })).toString('base64');
  let continuationStatus = topUpStatus({ state: 'PENDING', sendHash: 'A'.repeat(64),
    payer: controller.address.value, paymentState: 'UNKNOWN' });
  let getStatus = topUpStatus({ state: 'CREDITED', sendHash: 'A'.repeat(64),
    payer: controller.address.value, paymentState: 'CONFIRMED' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    const call = { url, method: init.method, headers, body: init.body, redirect: init.redirect };
    calls.push(call);
    if (url.pathname === '/v1/agent/auth/challenges') {
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), { network: 'ATTO', address: controller.address.value });
      return new Response(JSON.stringify({ challengeId, message: proofMessage, issuedAt, expiresAt }), { status: 200 });
    }
    if (url.pathname === '/v1/agent/auth/sessions') {
      const body = JSON.parse(init.body);
      const expected = await controller.signMessage(new Int8Array(Buffer.from(proofMessage, 'utf8')));
      assert.deepEqual(body, { challengeId, message: proofMessage, signature: expected.toString() });
      return new Response(JSON.stringify({ accountId, agentId: sessionAgentId, accountState: 'ACTIVE', identityId,
        accessToken: 'access-token-at-least-16', accessExpiresAt: expiresAt,
        refreshToken: 'refresh-token-at-least-16', refreshExpiresAt: new Date(Date.now() + 600_000).toISOString() }), { status: 200 });
    }
    if (url.pathname === '/v1/agent/auth/sessions/refresh') {
      return new Response('{}', { status: 401 });
    }
    if (url.pathname === `/v1/agent/topups/${intentId}` && init.method === 'POST') {
      assert.equal(headers.get('authorization'), 'Bearer access-token-at-least-16');
      assert.equal(headers.get('origin'), null);
      assert.equal(call.redirect, 'error');
      order.push('continuation');
      assert.equal(init.body, undefined, 'Market continuation has no JSON request body.');
      assert.equal(headers.get('payment-signature'), paymentSignature);
      return new Response(JSON.stringify(continuationStatus), {
        status: 202, headers: { 'PAYMENT-RESPONSE': paymentResponse },
      });
    }
    if (url.pathname === '/v1/agent/topups' && init.method === 'POST') {
      assert.equal(headers.get('authorization'), 'Bearer access-token-at-least-16');
      assert.equal(headers.get('origin'), null);
      assert.equal(call.redirect, 'error');
      assert.deepEqual(JSON.parse(init.body), { asset: 'ATTO', amountAtomic: '10', paymentIdentifier });
      return new Response(JSON.stringify(topUpStatus()), {
        status: 402, headers: { 'PAYMENT-REQUIRED': requirementHeader(recipient.address.value) },
      });
    }
    if (url.pathname === `/v1/agent/topups/${intentId}` && init.method === 'GET') {
      return new Response(JSON.stringify(getStatus), { status: 200 });
    }
    throw new Error(`Unexpected Market request ${init.method} ${url.pathname}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; seed.value.fill(0); });

  const client = new MarketTopUpClient(store, { settings: () => ({ network: 'LOCAL' }),
    addresses: () => [{ index: 0, address: controller.address.value, publicKey: controller.publicKey.toString(), active: true }],
    seed: async () => (await AttoMnemonic.fromPhrase(phrase)).toSeedAsync(), mcp: false });

  // When the local owner connects, requests the challenge, submits a payment, and reads its status.
  const connection = await client.connect({ apiUrl, audience: 'market-test', controllerIndex: 0 });
  const challenge = await client.challenge(connection, paymentIdentifier, '10');
  let prepared = false;
  const pending = await client.pay(connection, challenge.status, paymentIdentifier, paymentSignature,
    { hash: 'A'.repeat(64), network: 'atto:local', payer: controller.address.value }, async () => {
      prepared = true;
      order.push('persisted');
    });
  const credited = await client.status(connection, intentId, paymentIdentifier, '10', 'atto:local',
    { hash: 'A'.repeat(64), payer: controller.address.value });

  // Then the exact auth/resource binding is used, continuation follows the offered path with no body, and tokens stay in memory.
  assert.equal(connection.agentId, agentId);
  assert.equal(challenge.status.intentId, intentId);
  assert.equal(pending.paymentState, 'UNKNOWN');
  assert.equal(credited.state, 'CREDITED');
  assert.equal(prepared, true);
  assert.deepEqual(order, ['persisted', 'continuation']);
  assert.equal(calls.filter(call => call.headers.has('origin')).length, 0);
  assert.ok(calls.every(call => call.url.origin === new URL(apiUrl).origin));
  assert.ok(calls.every(call => call.redirect === 'error'));
  assert.deepEqual([...saved.keys()].sort(), ['identity', 'market.topups.connection']);
  assert.doesNotMatch(JSON.stringify([...saved.entries()]), /access-token-at-least-16|refresh-token-at-least-16|PAYMENT-SIGNATURE/);

  // A same-amount terminal status for another intent or SEND cannot bind to the saved payment.
  getStatus = topUpStatus({ intentId: '00000000-0000-4000-8000-000000000105', state: 'CREDITED',
    sendHash: 'A'.repeat(64), payer: controller.address.value, paymentState: 'CONFIRMED' });
  await assert.rejects(client.status(connection, intentId, paymentIdentifier, '10', 'atto:local',
    { hash: 'A'.repeat(64), payer: controller.address.value }), { code: 'MARKET_PROTOCOL' });
  getStatus = topUpStatus({ state: 'CREDITED', sendHash: 'B'.repeat(64), payer: controller.address.value,
    paymentState: 'CONFIRMED' });
  await assert.rejects(client.status(connection, intentId, paymentIdentifier, '10', 'atto:local',
    { hash: 'A'.repeat(64), payer: controller.address.value }), { code: 'MARKET_PROTOCOL' });
  getStatus = topUpStatus({ state: 'CREDITED', sendHash: 'A'.repeat(64), payer: recipient.address.value,
    paymentState: 'CONFIRMED' });
  await assert.rejects(client.status(connection, intentId, paymentIdentifier, '10', 'atto:local',
    { hash: 'A'.repeat(64), payer: controller.address.value }), { code: 'MARKET_PROTOCOL' });
  for (const terminal of [{ state: 'CREDITED' }, { paymentState: 'CONFIRMED' }]) {
    for (const missing of [
      { sendHash: null, payer: controller.address.value },
      { sendHash: 'A'.repeat(64), payer: null },
      { sendHash: null, payer: null },
    ]) {
      getStatus = topUpStatus({ state: 'PENDING', paymentState: 'UNKNOWN', ...terminal, ...missing });
      await assert.rejects(client.status(connection, intentId, paymentIdentifier, '10', 'atto:local',
        { hash: 'A'.repeat(64), payer: controller.address.value }), { code: 'MARKET_PROTOCOL' });
    }
  }
  getStatus = topUpStatus();
  assert.equal((await client.status(connection, intentId, paymentIdentifier, '10', 'atto:local',
    { hash: 'A'.repeat(64), payer: controller.address.value })).state, 'ISSUED');
  getStatus = topUpStatus({ state: 'PENDING', sendHash: 'A'.repeat(64), payer: controller.address.value,
    paymentState: 'UNKNOWN' });
  await assert.rejects(client.status(connection, intentId, paymentIdentifier, '10', 'atto:local'),
    { code: 'MARKET_PROTOCOL' });

  // Paid-continuation body and PAYMENT-RESPONSE must agree with the assigned intent, hash, and payer.
  continuationStatus = topUpStatus({ intentId: '00000000-0000-4000-8000-000000000105', state: 'CREDITED',
    sendHash: 'A'.repeat(64), payer: controller.address.value, paymentState: 'CONFIRMED' });
  await assert.rejects(client.pay(connection, challenge.status, paymentIdentifier, paymentSignature,
    { hash: 'A'.repeat(64), network: 'atto:local', payer: controller.address.value }, async () => {}),
  { code: 'MARKET_PROTOCOL' });
  continuationStatus = topUpStatus({ state: 'PENDING', sendHash: 'B'.repeat(64),
    payer: controller.address.value, paymentState: 'UNKNOWN' });
  await assert.rejects(client.pay(connection, challenge.status, paymentIdentifier, paymentSignature,
    { hash: 'A'.repeat(64), network: 'atto:local', payer: controller.address.value }, async () => {}),
  { code: 'MARKET_PROTOCOL' });
  continuationStatus = topUpStatus({ state: 'PENDING', sendHash: 'A'.repeat(64),
    payer: controller.address.value, paymentState: 'UNKNOWN' });
  paymentResponse = Buffer.from(JSON.stringify({ success: false, transaction: 'A'.repeat(64),
    network: 'atto:local', payer: recipient.address.value, errorReason: 'settlement_pending' })).toString('base64');
  await assert.rejects(client.pay(connection, challenge.status, paymentIdentifier, paymentSignature,
    { hash: 'A'.repeat(64), network: 'atto:local', payer: controller.address.value }, async () => {}),
  { code: 'MARKET_PROTOCOL' });

  // If a later login resolves a different Market agent for this controller, reject before reading payment status.
  sessionAgentId = '00000000-0000-4000-8000-000000000104';
  client.session.value.accessExpiresAt = 0;
  await assert.rejects(client.status(connection, intentId, paymentIdentifier, '10', 'atto:local'), { code: 'MARKET_IDENTITY_CHANGED' });
});

test('MCP cannot reconfigure Market origin or controller before network access', async t => {
  // Given a configured connection response with a different agent identity and an MCP-only client.
  const saved = new Map([['identity', { address: 'controller', fingerprint: 'a'.repeat(64) }]]);
  const store = { get: key => saved.get(key), set: (key, value) => saved.set(key, value) };
  const previousFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; return new Response(JSON.stringify({ challengeId: '00000000-0000-4000-8000-000000000103',
    message: 'unexpected', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }), { status: 200 }); };
  t.after(() => { globalThis.fetch = previousFetch; });
  const client = new MarketTopUpClient(store, { settings: () => ({ network: 'LOCAL' }), addresses: () => [], seed: async () => { throw new Error('must not read seed'); }, mcp: true });

  // When MCP attempts to choose its own Market origin, then the terminal-only guard rejects it before fetch or signing.
  await assert.rejects(client.connect({ apiUrl, audience: 'market-test', controllerIndex: 0 }), { code: 'LOCAL_APPROVAL_REQUIRED' });

  // Then no remote request, key read, or public connection row is created.
  assert.equal(fetches, 0);
  assert.deepEqual([...saved.keys()], ['identity']);
});
