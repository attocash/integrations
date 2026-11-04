import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageDirectory=process.env.ATTO_TEST_CLI_PACKAGE_DIR??join(import.meta.dirname,'..');
const packageRequire=createRequire(join(packageDirectory,'package.json'));
const { AttoMnemonic }=await import(pathToFileURL(packageRequire.resolve('@attocash/commons-core')).href);
const { derivedSigner }=await import(pathToFileURL(join(packageDirectory,'dist/wallet/signing.js')).href);
const { MarketplaceTopUpClient, validateMarketplaceApiUrl }=await import(pathToFileURL(join(packageDirectory,'dist/marketplace/topups.js')).href);

const apiUrl = 'http://127.0.0.1:43210/v1/agent/topups';
const intentId = '00000000-0000-4000-8000-000000000079';
const accountId = '00000000-0000-4000-8000-000000000100';
const agentId = '00000000-0000-4000-8000-000000000102';
const identityId = '00000000-0000-4000-8000-000000000101';

function topUpStatus(changes = {}) {
  return { intentId, asset: 'ATTO', network: 'atto:local', amountAtomic: '10', state: 'PENDING',
    expiresAt: new Date(Date.now() + 300_000).toISOString(), sendHash: null, payer: null,
    paymentState: null, receivePending: null, discrepancy: null, receiveStatus: null, ...changes };
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

test('Marketplace URL validation keeps the fixed resource path and confines HTTP to loopback LOCAL', () => {
  // Given
  const validHttps = 'https://marketplace.example/v1/agent/topups';

  // When / Then
  assert.equal(validateMarketplaceApiUrl(validHttps, 'LIVE'), validHttps);
  assert.equal(validateMarketplaceApiUrl(apiUrl, 'LOCAL'), apiUrl);
  for (const value of ['http://marketplace.example/v1/agent/topups', 'http://127.0.0.1/v1/agent/topups/extra',
    'https://user:secret@marketplace.example/v1/agent/topups', 'https://marketplace.example/v1/agent/topups?redirect=https://evil.test']) {
    assert.throws(() => validateMarketplaceApiUrl(value, 'LOCAL'), { code: 'MARKETPLACE_CONFIGURATION' });
  }
  assert.throws(() => validateMarketplaceApiUrl(apiUrl, 'LIVE'), { code: 'MARKETPLACE_CONFIGURATION' });
});

test('configured Marketplace client signs its controller proof and sends a bodyless bound continuation', async t => {
  // Given a single configured local Marketplace origin, a saved controller, and a server returning the current handshake DTOs.
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
  const proofMessage = `Marketplace Agent Controller Proof v1\nAudience: marketplace-test\nNetwork: live\nAddress: ${controller.address.value}\nPurpose: login\nRequest ID: ${challengeId}\nBinding Hash: ${createHash('sha256').update(['signer-controller-enrollment-v1',accountId,identityId].join('\n')).digest('hex')}\nNonce: ${'ab'.repeat(32)}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`;
  const paymentIdentifier = 'account-scoped-payment-079';
  let sessionAgentId = agentId;
  const paymentSignature = Buffer.from('opaque exact signed payment bytes').toString('base64');
  let paymentResponse = Buffer.from(JSON.stringify({ success: false, transaction: 'A'.repeat(64),
    network: 'atto:local', payer: controller.address.value, errorReason: 'settlement_pending' })).toString('base64');
  let continuationStatus = topUpStatus({ state: 'PENDING', sendHash: 'A'.repeat(64),
    payer: controller.address.value, paymentState: 'PENDING' });
  let continuationHttpStatus = 202;
  let getStatus = topUpStatus({ state: 'ACCEPTED', sendHash: 'A'.repeat(64),
    payer: controller.address.value, paymentState: 'ACCEPTED' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    const call = { url, method: init.method, headers, body: init.body, redirect: init.redirect };
    calls.push(call);
    if (url.pathname === '/v1/agent/auth/challenges') {
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), { network: 'ATTO', address: controller.address.value });
      return new Response(JSON.stringify({ challengeId, accountId, controllerId: identityId, message: proofMessage, issuedAt, expiresAt }), { status: 200 });
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
      assert.equal(init.body, undefined, 'Marketplace continuation has no JSON request body.');
      assert.equal(headers.get('payment-signature'), paymentSignature);
      return new Response(JSON.stringify(continuationStatus), {
        status: continuationHttpStatus, headers: paymentResponse === null ? {} : { 'PAYMENT-RESPONSE': paymentResponse },
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
    throw new Error(`Unexpected Marketplace request ${init.method} ${url.pathname}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; seed.value.fill(0); });

  const wallet = { settings: () => ({ network: 'LOCAL' }),
    addresses: () => [{ index: 0, address: controller.address.value, publicKey: controller.publicKey.toString(), active: true }],
    seed: async () => (await AttoMnemonic.fromPhrase(phrase)).toSeedAsync(), mcp: false };
  const client = new MarketplaceTopUpClient(store, wallet);

  // When the local owner connects, requests the challenge, submits a payment, and reads its status.
  const connection = await client.connect({ apiUrl, audience: 'marketplace-test', controllerIndex: 0 });
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
  assert.equal(pending.paymentState, 'PENDING');
  assert.equal(credited.state, 'ACCEPTED');
  assert.equal(prepared, true);
  assert.deepEqual(order, ['persisted', 'continuation']);
  assert.equal(calls.filter(call => call.headers.has('origin')).length, 0);
  assert.ok(calls.every(call => call.url.origin === new URL(apiUrl).origin));
  assert.ok(calls.every(call => call.redirect === 'error'));
  assert.deepEqual([...saved.keys()].sort(), ['identity', 'marketplace.topups.connection']);
  assert.doesNotMatch(JSON.stringify([...saved.entries()]), /access-token-at-least-16|refresh-token-at-least-16|PAYMENT-SIGNATURE/);

  // An admitted payment may be pending before a native settlement receipt exists.
  paymentResponse = null;
  const retryClient = new MarketplaceTopUpClient(store, wallet);
  const expectedPayment = { hash: 'A'.repeat(64), network: 'atto:local', payer: controller.address.value };
  assert.equal((await retryClient.pay(connection, challenge.status, paymentIdentifier, paymentSignature,
    expectedPayment, async () => {})).state, 'PENDING');
  for (const changes of [
    { intentId: '00000000-0000-4000-8000-000000000105' }, { sendHash: 'B'.repeat(64) },
    { payer: recipient.address.value }, { sendHash: null }, { payer: null }, { amountAtomic: '11' },
    { asset: 'XNO' }, { network: 'atto:beta' }, { paymentState: null }, { paymentState: 'ACCEPTED' },
    { state: 'ACCEPTED', paymentState: 'ACCEPTED' }, { state: 'REJECTED', paymentState: 'REJECTED' },
  ]) {
    continuationStatus = topUpStatus({ sendHash: expectedPayment.hash, payer: expectedPayment.payer,
      paymentState: 'PENDING', ...changes });
    await assert.rejects(retryClient.pay(connection, challenge.status, paymentIdentifier, paymentSignature,
      expectedPayment, async () => {}), { code: 'MARKETPLACE_PROTOCOL' });
  }
  for (const [httpStatus, state] of [[200, 'PENDING'], [200, 'ACCEPTED'], [409, 'REJECTED']]) {
    continuationHttpStatus = httpStatus;
    continuationStatus = topUpStatus({ sendHash: expectedPayment.hash, payer: expectedPayment.payer,
      state, paymentState: state });
    await assert.rejects(retryClient.pay(connection, challenge.status, paymentIdentifier, paymentSignature,
      expectedPayment, async () => {}), { code: 'MARKETPLACE_PROTOCOL' });
  }

  // Both confirmed SEND and later RECEIVE states are successful; HTTP 200 must carry a matching successful receipt.
  continuationStatus = topUpStatus({ state: 'ACCEPTED', sendHash: 'A'.repeat(64),
    payer: controller.address.value, paymentState: 'ACCEPTED', receivePending: true });
  paymentResponse = Buffer.from(JSON.stringify({ success: true, transaction: 'A'.repeat(64),
    network: 'atto:local', payer: controller.address.value })).toString('base64');
  continuationHttpStatus = 200;
  assert.equal((await client.pay(connection, challenge.status, paymentIdentifier, paymentSignature,
    { hash: 'A'.repeat(64), network: 'atto:local', payer: controller.address.value }, async () => {})).state, 'ACCEPTED');
  getStatus = topUpStatus({ state: 'SETTLED', sendHash: 'A'.repeat(64),
    payer: controller.address.value, paymentState: 'SETTLED', receivePending: false, receiveStatus: 'SETTLED' });
  assert.equal((await client.status(connection, intentId, paymentIdentifier, '10', 'atto:local',
    { hash: 'A'.repeat(64), payer: controller.address.value })).state, 'SETTLED');
  continuationHttpStatus = 202;

  // A same-amount terminal status for another intent or SEND cannot bind to the saved payment.
  getStatus = topUpStatus({ intentId: '00000000-0000-4000-8000-000000000105', state: 'ACCEPTED',
    sendHash: 'A'.repeat(64), payer: controller.address.value, paymentState: 'ACCEPTED' });
  await assert.rejects(client.status(connection, intentId, paymentIdentifier, '10', 'atto:local',
    { hash: 'A'.repeat(64), payer: controller.address.value }), { code: 'MARKETPLACE_PROTOCOL' });
  getStatus = topUpStatus({ state: 'SETTLED', sendHash: 'B'.repeat(64), payer: controller.address.value,
    paymentState: 'SETTLED' });
  await assert.rejects(client.status(connection, intentId, paymentIdentifier, '10', 'atto:local',
    { hash: 'A'.repeat(64), payer: controller.address.value }), { code: 'MARKETPLACE_PROTOCOL' });
  getStatus = topUpStatus({ state: 'SETTLED', sendHash: 'A'.repeat(64), payer: recipient.address.value,
    paymentState: 'SETTLED' });
  await assert.rejects(client.status(connection, intentId, paymentIdentifier, '10', 'atto:local',
    { hash: 'A'.repeat(64), payer: controller.address.value }), { code: 'MARKETPLACE_PROTOCOL' });
  for (const terminal of [{ state: 'ACCEPTED' }, { paymentState: 'SETTLED' }]) {
    for (const missing of [
      { sendHash: null, payer: controller.address.value },
      { sendHash: 'A'.repeat(64), payer: null },
      { sendHash: null, payer: null },
    ]) {
      getStatus = topUpStatus({ state: 'PENDING', paymentState: 'PENDING', ...terminal, ...missing });
      await assert.rejects(client.status(connection, intentId, paymentIdentifier, '10', 'atto:local',
        { hash: 'A'.repeat(64), payer: controller.address.value }), { code: 'MARKETPLACE_PROTOCOL' });
    }
  }
  getStatus = topUpStatus();
  assert.equal((await client.status(connection, intentId, paymentIdentifier, '10', 'atto:local',
    { hash: 'A'.repeat(64), payer: controller.address.value })).state, 'PENDING');
  getStatus = topUpStatus({ state: 'PENDING', sendHash: 'A'.repeat(64), payer: controller.address.value,
    paymentState: 'PENDING' });
  await assert.rejects(client.status(connection, intentId, paymentIdentifier, '10', 'atto:local'),
    { code: 'MARKETPLACE_PROTOCOL' });

  // Paid-continuation body and PAYMENT-RESPONSE must agree with the assigned intent, hash, and payer.
  continuationStatus = topUpStatus({ intentId: '00000000-0000-4000-8000-000000000105', state: 'ACCEPTED',
    sendHash: 'A'.repeat(64), payer: controller.address.value, paymentState: 'ACCEPTED' });
  await assert.rejects(client.pay(connection, challenge.status, paymentIdentifier, paymentSignature,
    { hash: 'A'.repeat(64), network: 'atto:local', payer: controller.address.value }, async () => {}),
  { code: 'MARKETPLACE_PROTOCOL' });
  continuationStatus = topUpStatus({ state: 'PENDING', sendHash: 'B'.repeat(64),
    payer: controller.address.value, paymentState: 'PENDING' });
  await assert.rejects(client.pay(connection, challenge.status, paymentIdentifier, paymentSignature,
    { hash: 'A'.repeat(64), network: 'atto:local', payer: controller.address.value }, async () => {}),
  { code: 'MARKETPLACE_PROTOCOL' });
  continuationStatus = topUpStatus({ state: 'PENDING', sendHash: 'A'.repeat(64),
    payer: controller.address.value, paymentState: 'PENDING' });
  paymentResponse = Buffer.from(JSON.stringify({ success: false, transaction: 'A'.repeat(64),
    network: 'atto:local', payer: recipient.address.value, errorReason: 'settlement_pending' })).toString('base64');
  await assert.rejects(client.pay(connection, challenge.status, paymentIdentifier, paymentSignature,
    { hash: 'A'.repeat(64), network: 'atto:local', payer: controller.address.value }, async () => {}),
  { code: 'MARKETPLACE_PROTOCOL' });

  // If a later login resolves a different Marketplace agent for this controller, reject before reading payment status.
  sessionAgentId = '00000000-0000-4000-8000-000000000104';
  client.session.value.accessExpiresAt = 0;
  await assert.rejects(client.status(connection, intentId, paymentIdentifier, '10', 'atto:local'), { code: 'MARKETPLACE_IDENTITY_CHANGED' });
});

test('raw login rejects altered enrollment metadata before reading keys and mismatched sessions before saving', async t => {
  const phrase=(await AttoMnemonic.generate()).phrase;
  const seed=await (await AttoMnemonic.fromPhrase(phrase)).toSeedAsync();
  const signer=await derivedSigner(seed,0);
  const fingerprint=createHash('sha256').update(signer.publicKey.toString()).digest('hex');
  const challengeId='00000000-0000-4000-8000-000000000103';
  const issuedAt=new Date(Date.now()-1000).toISOString(), expiresAt=new Date(Date.now()+120_000).toISOString();
  const binding=createHash('sha256').update(['signer-controller-enrollment-v1',accountId,identityId].join('\n')).digest('hex');
  const message=`Marketplace Agent Controller Proof v1\nAudience: marketplace-test\nNetwork: live\nAddress: ${signer.address.value}\nPurpose: login\nRequest ID: ${challengeId}\nBinding Hash: ${binding}\nNonce: ${'a'.repeat(64)}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`;
  const valid={challengeId,accountId,controllerId:identityId,message,issuedAt,expiresAt};
  let challenge=valid, keyReads=0, sessions=0;
  const saved=new Map([['identity',{address:signer.address.value,fingerprint}]]);
  const previous=globalThis.fetch;
  globalThis.fetch=async input=>{
    if(new URL(input).pathname.endsWith('/challenges')) return new Response(JSON.stringify(challenge),{status:200});
    sessions++;
    return new Response(JSON.stringify({accountId,agentId,identityId:'00000000-0000-4000-8000-000000000999',accountState:'ACTIVE',
      accessToken:'access-token-at-least-16',accessExpiresAt:expiresAt,refreshToken:'refresh-token-at-least-16',
      refreshExpiresAt:new Date(Date.now()+600_000).toISOString()}),{status:200});
  };
  t.after(()=>{globalThis.fetch=previous;seed.value.fill(0);});
  const client=new MarketplaceTopUpClient({get:key=>saved.get(key),set:(key,value)=>saved.set(key,value)}, {
    settings:()=>({network:'LOCAL'}),addresses:()=>[{index:0,address:signer.address.value,publicKey:signer.publicKey.toString(),active:true}],
    seed:async()=>{keyReads++;return (await AttoMnemonic.fromPhrase(phrase)).toSeedAsync();},mcp:false});
  for(const mutated of [{...valid,accountId:undefined},{...valid,controllerId:'not-a-uuid'},
    {...valid,accountId:'00000000-0000-4000-8000-000000000999'},
    {...valid,message:message.replace(/Binding Hash: [0-9a-f]{64}\n/,'')}]) {
    challenge=mutated;
    await assert.rejects(client.connect({apiUrl,audience:'marketplace-test',controllerIndex:0}),{code:'MARKETPLACE_PROTOCOL'});
  }
  assert.equal(keyReads,0); assert.equal(sessions,0);
  challenge=valid;
  await assert.rejects(client.connect({apiUrl,audience:'marketplace-test',controllerIndex:0}),{code:'MARKETPLACE_PROTOCOL'});
  assert.equal(keyReads,1); assert.equal(sessions,1);
  assert.equal(saved.has('marketplace.topups.connection'),false);
});

test('MCP cannot reconfigure Marketplace origin or controller before network access', async t => {
  // Given a configured connection response with a different agent identity and an MCP-only client.
  const saved = new Map([['identity', { address: 'controller', fingerprint: 'a'.repeat(64) }]]);
  const store = { get: key => saved.get(key), set: (key, value) => saved.set(key, value) };
  const previousFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; return new Response(JSON.stringify({ challengeId: '00000000-0000-4000-8000-000000000103',
    message: 'unexpected', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }), { status: 200 }); };
  t.after(() => { globalThis.fetch = previousFetch; });
  const client = new MarketplaceTopUpClient(store, { settings: () => ({ network: 'LOCAL' }), addresses: () => [], seed: async () => { throw new Error('must not read seed'); }, mcp: true });

  // When MCP attempts to choose its own Marketplace origin, then the terminal-only guard rejects it before fetch or signing.
  await assert.rejects(client.connect({ apiUrl, audience: 'marketplace-test', controllerIndex: 0 }), { code: 'LOCAL_APPROVAL_REQUIRED' });

  // Then no remote request, key read, or public connection row is created.
  assert.equal(fetches, 0);
  assert.deepEqual([...saved.keys()], ['identity']);
});


test('controller login preserves signer failures and accepts the final session-family expiry window', async t => {
  // Given a local native wallet and signed controller enrollment challenge.
  const phrase=(await AttoMnemonic.generate()).phrase;
  const seed=await (await AttoMnemonic.fromPhrase(phrase)).toSeedAsync();
  const controller=await derivedSigner(seed,0);
  const saved=new Map([['identity',{address:controller.address.value,fingerprint:'test-fingerprint'}]]);
  const client=new MarketplaceTopUpClient({get:key=>saved.get(key),set:(key,value)=>saved.set(key,value)},
    {settings:()=>({network:'LOCAL'}),addresses:()=>[{index:0,address:controller.address.value}],
      seed:async()=>(await AttoMnemonic.fromPhrase(phrase)).toSeedAsync(),mcp:false});
  const challengeId='00000000-0000-4000-8000-000000000103';
  const issuedAt=new Date(Date.now()-1000).toISOString();
  const expiresAt=new Date(Date.now()+120_000).toISOString();
  const binding=createHash('sha256').update(['signer-controller-enrollment-v1',accountId,identityId].join('\n')).digest('hex');
  const message=`Marketplace Agent Controller Proof v1\nAudience: marketplace-test\nNetwork: live\nAddress: ${controller.address.value}\nPurpose: login\nRequest ID: ${challengeId}\nBinding Hash: ${binding}\nNonce: ${'ab'.repeat(32)}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`;
  let failure;
  let shortAccess=false;
  let refreshCount=0;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async input=>{
    const path=new URL(input).pathname;
    if(path.endsWith('/sessions/refresh')) {
      refreshCount++;
      return Response.json({accessToken:'rotated-access-token-secret',accessExpiresAt:expiresAt,
        refreshToken:'rotated-refresh-token-secret',refreshExpiresAt:expiresAt});
    }
    if(path.endsWith(`/topups/${intentId}`)) return Response.json(topUpStatus());
    if(new URL(input).pathname.endsWith('/challenges')) return Response.json({challengeId,accountId,controllerId:identityId,message,issuedAt,expiresAt});
    if(failure) return Response.json({error:failure.serverCode,message:'private-signer-diagnostic',details:{proof:'private-proof'}},{status:failure.status});
    return Response.json({accountId,agentId,identityId,accountState:'ACTIVE',accessToken:'access-token-at-least-16',
      accessExpiresAt:shortAccess?new Date(Date.now()+1000).toISOString():expiresAt,
      refreshToken:'refresh-token-at-least-16',refreshExpiresAt:expiresAt});
  };
  t.after(()=>{globalThis.fetch=originalFetch;seed.value.fill(0);});
  for(const scenario of [
    {status:403,serverCode:'signer_request_rejected',expected:'SIGNER_REQUEST_REJECTED'},
    {status:503,serverCode:'signer_unavailable',expected:'SIGNER_UNAVAILABLE'},
  ]) {
    // When LOGIN receives a definite signer rejection or availability failure.
    failure=scenario;
    await assert.rejects(client.connect({apiUrl,audience:'marketplace-test',controllerIndex:0}),error=>{
      assert.equal(error.code,scenario.expected);
      assert.equal(error.details.httpStatus,scenario.status);
      assert.equal(error.details.serverCode,scenario.serverCode);
      assert.doesNotMatch(error.message,/private-/);
      return true;
    });
    // Then the exact safe error survives without a connected profile.
    assert.equal(saved.has('marketplace.topups.connection'),false);
  }
  // When LOGIN and refresh return equal future access and refresh expiries.
  failure=undefined;
  const connection=await client.connect({apiUrl,audience:'marketplace-test',controllerIndex:0});
  assert.equal(connection.accountId,accountId);
  assert.equal(saved.get('marketplace.topups.connection').identityId,identityId);
  shortAccess=true;
  await client.connect({apiUrl,audience:'marketplace-test',controllerIndex:0});
  assert.equal((await client.status(connection,intentId,'stable-payment-id','10','atto:local')).intentId,intentId);
  // Then both final-window sessions remain usable without replacing the connection.
  assert.equal(refreshCount,1);
});
