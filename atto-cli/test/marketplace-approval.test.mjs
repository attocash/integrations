import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { AttoMnemonic } from '@attocash/commons-core';
import { derivedSigner } from '../dist/wallet/signing.js';
import { approvalRequestDigest } from '../dist/marketplace/proof-approval.js';
import { MarketplaceTopUpClient } from '../dist/marketplace/topups.js';
import { formatMarketplaceApprovalPreview } from '../dist/cli/cli.js';

const origin = 'https://marketplace.example';
const accountId = '00000000-0000-4000-8000-000000000100';
const agentId = '00000000-0000-4000-8000-000000000102';
const identityId = '00000000-0000-4000-8000-000000000101';
const buyerAgentId = '00000000-0000-4000-8000-000000000103';

test('typed withdrawal approval validates controller, audience, action binding, and signs exact server message', async t => {
  // Given one saved wallet, its configured Marketplace account, and an immutable XNO withdrawal challenge.
  const phrase = (await AttoMnemonic.generate()).phrase;
  const seed = await (await AttoMnemonic.fromPhrase(phrase)).toSeedAsync();
  const signer = await derivedSigner(seed, 0);
  const fingerprint = createHash('sha256').update(signer.publicKey.toString()).digest('hex');
  const saved = new Map([
    ['identity', { address: signer.address.value, fingerprint }],
    ['marketplace.topups.connection', { version:1, apiUrl:`${origin}/v1/agent/topups`, audience:'marketplace-agent',
      controllerIndex:0, controllerAddress:signer.address.value, accountId, agentId, identityId, walletFingerprint:fingerprint }],
  ]);
  const connection = saved.get('marketplace.topups.connection');
  const requestId = '00000000-0000-4000-8000-000000000201';
  const destinationId = '00000000-0000-4000-8000-000000000202';
  const challengeId = '00000000-0000-4000-8000-000000000203';
  const issuedAt = new Date(Date.now()-1000).toISOString();
  const expiresAt = new Date(Date.now()+120_000).toISOString();
  const action = { kind:'withdrawal', network:'xno:live', destinationAddress:'nano_1111111111111111111111111111111111111111111111111111hifc8npp',
    command:{asset:'XNO',atomicAmount:'25',destinationId,expectedSelectionVersion:2,idempotencyKey:requestId,network:'xno:live'} };
  const bindingHash = createHash('sha256').update(['withdrawal-create-v2',accountId,identityId,'XNO','25','xno:live',destinationId,
    action.destinationAddress,'2',requestId].join('\n')).digest('hex');
  const message = `Marketplace Agent Controller Proof v1\nAudience: marketplace-agent\nNetwork: live\nAddress: ${signer.address.value}\nPurpose: withdrawal creation\nRequest ID: ${challengeId}\nBinding Hash: ${bindingHash}\nNonce: ${'ab'.repeat(32)}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`;
  const request = {version:1,type:'marketplace-controller-approval-request',profileId:'agent',handoffId:'a'.repeat(32),
    marketplaceOrigin:origin,transport:'AGENT_API',proofOrigin:null,audience:'marketplace-agent',accountId,identityId,
    controller:{network:'ATTO',address:signer.address.value,index:0},purpose:'withdrawal creation',action,
    challenge:{challengeId,message,issuedAt,expiresAt}};
  t.after(() => seed.value.fill(0));
  const client = new MarketplaceTopUpClient({get:key=>saved.get(key),set:(key,value)=>saved.set(key,value)}, {
    settings:()=>({network:'LIVE'}), addresses:()=>[{index:0,address:signer.address.value,publicKey:signer.publicKey.toString(),active:true}],
    seed:async()=>(await AttoMnemonic.fromPhrase(phrase)).toSeedAsync(), mcp:false,
  });

  // When the local wallet reviews and signs, every displayed action field must reproduce the backend binding hash.
  const {preview} = client.inspectProofApproval(request);
  const response = await client.signProofApproval(request);

  // Then the signature covers the exact server message and the response binds to the full immutable request.
  assert.equal(preview.purpose,'withdrawal creation');
  assert.equal(preview.action.destinationAddress,action.destinationAddress);
  assert.equal(response.requestDigest,approvalRequestDigest(request));
  assert.equal(response.challengeId,challengeId);
  assert.equal(response.handoffId,request.handoffId);
  assert.equal(response.controllerAddress,signer.address.value);
  const expected = await signer.signMessage(new Int8Array(Buffer.from(message,'utf8')));
  assert.equal(response.signature,expected.toString());

  // A v1 challenge is not accepted as a fallback for the new immediate-debit withdrawal binding.
  const v1BindingHash = createHash('sha256').update(['withdrawal-create-v1',accountId,identityId,'XNO','25','xno:live',destinationId,
    action.destinationAddress,'2',requestId].join('\n')).digest('hex');
  assert.throws(()=>client.inspectProofApproval({...request,challenge:{...request.challenge,
    message:message.replace(bindingHash,v1BindingHash)}}), {code:'MARKETPLACE_APPROVAL_PROTOCOL'});

  // Any changed destination, amount, request ID, account, or authority audience fails before signing.
  assert.throws(()=>client.inspectProofApproval({...request,action:{...action,command:{...action.command,atomicAmount:'26'}}}), {code:'MARKETPLACE_APPROVAL_PROTOCOL'});
  assert.throws(()=>client.inspectProofApproval({...request,action:{...action,destinationAddress:'nano_3differentdestination'}}), {code:'MARKETPLACE_APPROVAL_PROTOCOL'});
  assert.throws(()=>client.inspectProofApproval({...request,action:{...action,command:{...action.command,idempotencyKey:'00000000-0000-4000-8000-000000000205'}}}), {code:'MARKETPLACE_APPROVAL_PROTOCOL'});
  assert.throws(()=>client.inspectProofApproval({...request,action:{...action,command:{...action.command,network:'xno:test'}}}), {code:'MARKETPLACE_APPROVAL_PROTOCOL'});
  assert.throws(()=>client.inspectProofApproval({...request,accountId:'00000000-0000-4000-8000-000000000206'}), {code:'MARKETPLACE_APPROVAL_MISMATCH'});
  assert.throws(()=>client.inspectProofApproval({...request,audience:'other-audience'}), {code:'MARKETPLACE_APPROVAL_MISMATCH'});
});

test('typed payout enrollment, selection, and disablement sign producer-shaped nested commands', async t => {
  const phrase=(await AttoMnemonic.generate()).phrase;
  const seed=await (await AttoMnemonic.fromPhrase(phrase)).toSeedAsync();
  const signer=await derivedSigner(seed,0);
  const target=(await derivedSigner(seed,1)).address.value;
  const fingerprint=createHash('sha256').update(signer.publicKey.toString()).digest('hex');
  const saved=new Map([['identity',{address:signer.address.value,fingerprint}],['marketplace.topups.connection',{version:1,
    apiUrl:`${origin}/v1/agent/topups`,audience:'marketplace-agent',controllerIndex:0,controllerAddress:signer.address.value,
    accountId,agentId,identityId,walletFingerprint:fingerprint}]]);
  const client=new MarketplaceTopUpClient({get:key=>saved.get(key),set:(key,value)=>saved.set(key,value)}, {
    settings:()=>({network:'LIVE'}),addresses:()=>[{index:0,address:signer.address.value,publicKey:signer.publicKey.toString(),active:true}],
    seed:async()=>(await AttoMnemonic.fromPhrase(phrase)).toSeedAsync(),mcp:false,
  });
  t.after(() => seed.value.fill(0));
  const destinationId='00000000-0000-4000-8000-000000000260';
  const purposes={ENROLL:'payout address enrollment',SELECT:'payout address selection',DISABLE:'payout address disablement'};
  for (const [index,actionName] of ['ENROLL','SELECT','DISABLE'].entries()) {
    const requestId=`00000000-0000-4000-8000-00000000026${index+1}`;
    const challengeId=`00000000-0000-4000-8000-00000000027${index+1}`;
    // Mirrors the current MCP producer: network is present in both the signed outer action and API command.
    const command={action:actionName,asset:'ATTO',idempotencyKey:requestId,network:'atto:dev',
      ...(actionName==='ENROLL'?{address:target}:{destinationId,expectedSelectionVersion:index})};
    const action={kind:'payout-address',command,network:'atto:dev',canonicalTargetAddress:target};
    const binding= createHash('sha256').update(['payout-address-v1',accountId,identityId,actionName,'ATTO',
      'atto:dev',actionName==='ENROLL'?'':destinationId,target,actionName==='ENROLL'?'':String(index),requestId].join('\n')).digest('hex');
    const issuedAt=new Date(Date.now()-1000).toISOString();
    const expiresAt=new Date(Date.now()+120_000).toISOString();
    const purpose=purposes[actionName];
    const message=`Marketplace Agent Controller Proof v1\nAudience: marketplace-agent\nNetwork: live\nAddress: ${signer.address.value}\nPurpose: ${purpose}\nRequest ID: ${challengeId}\nBinding Hash: ${binding}\nNonce: ${'ef'.repeat(32)}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`;
    const request={version:1,type:'marketplace-controller-approval-request',profileId:'agent',handoffId:String(index+1).repeat(32),
      marketplaceOrigin:origin,transport:'AGENT_API',proofOrigin:null,audience:'marketplace-agent',accountId,identityId,
      controller:{network:'ATTO',address:signer.address.value,index:0},purpose,action,
      challenge:{challengeId,message,issuedAt,expiresAt}};
    const {preview}=client.inspectProofApproval(request);
    const response=await client.signProofApproval(request);
    assert.equal(preview.purpose,purpose);
    assert.equal(preview.action.command.action,actionName);
    assert.equal(response.requestDigest,approvalRequestDigest(request));
    assert.equal(response.signature,(await signer.signMessage(new Int8Array(Buffer.from(message,'utf8')))).toString());
    assert.throws(()=>client.inspectProofApproval({...request,action:{...action,command:{...command,action:actionName==='DISABLE'?'SELECT':'DISABLE'}}}),
      {code:'MARKETPLACE_APPROVAL_PROTOCOL'});
    assert.throws(()=>client.inspectProofApproval({...request,action:{...action,command:{...command,network:'atto:live'}}}),
      {code:'MARKETPLACE_APPROVAL_PROTOCOL'});
  }
});

test('browser proof approval preserves an exact browser-origin audience', async t => {
  // Given a browser request whose audience is its approved Marketplace origin.
  const phrase=(await AttoMnemonic.generate()).phrase;
  const seed=await (await AttoMnemonic.fromPhrase(phrase)).toSeedAsync();
  const signer=await derivedSigner(seed,0);
  const fingerprint=createHash('sha256').update(signer.publicKey.toString()).digest('hex');
  const saved=new Map([['identity',{address:signer.address.value,fingerprint}],['marketplace.topups.connection',{version:1,
    apiUrl:`${origin}/v1/agent/topups`,audience:'marketplace-agent',controllerIndex:0,controllerAddress:signer.address.value,
    accountId,agentId,identityId,walletFingerprint:fingerprint}]]);
  const issuedAt=new Date(Date.now()-1000).toISOString();
  const expiresAt=new Date(Date.now()+120_000).toISOString();
  const challengeId='00000000-0000-4000-8000-000000000204';
  const message=`Marketplace Agent Controller Proof v1\nAudience: ${origin}\nNetwork: live\nAddress: ${signer.address.value}\nPurpose: login\nRequest ID: ${challengeId}\nBinding Hash: ${createHash('sha256').update(['signer-controller-enrollment-v1',accountId,identityId].join('\n')).digest('hex')}\nNonce: ${'cd'.repeat(32)}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`;
  const request={version:1,type:'marketplace-controller-approval-request',profileId:'agent',handoffId:'b'.repeat(32),
    marketplaceOrigin:origin,transport:'BROWSER',proofOrigin:origin,audience:origin,accountId,identityId,
    controller:{network:'ATTO',address:signer.address.value,index:0},purpose:'login',action:{kind:'login',network:'ATTO',address:signer.address.value},
    challenge:{challengeId,message,issuedAt,expiresAt}};
  t.after(()=>seed.value.fill(0));
  const client=new MarketplaceTopUpClient({get:key=>saved.get(key),set:(key,value)=>saved.set(key,value)}, {
    settings:()=>({network:'LIVE'}),addresses:()=>[{index:0,address:signer.address.value,publicKey:signer.publicKey.toString(),active:true}],
    seed:async()=>(await AttoMnemonic.fromPhrase(phrase)).toSeedAsync(),mcp:false,
  });

  // When the wallet inspects the request, it retains the BROWSER transport and audience exactly.
  const {preview}=client.inspectProofApproval(request);
  const response=await client.signProofApproval(request);

  // Then the exact browser-bound message is signed and no Agent API audience substitution occurs.
  assert.equal(preview.transport,'BROWSER');
  assert.equal(preview.proofOrigin,origin);
  assert.equal(preview.audience,origin);
  assert.equal(response.message,message);
  const attacker='https://attacker.example';
  assert.throws(()=>client.inspectProofApproval({...request,proofOrigin:attacker,audience:attacker,
    challenge:{...request.challenge,message:message.replace(`Audience: ${origin}`,`Audience: ${attacker}`)}}), {code:'MARKETPLACE_APPROVAL_MISMATCH'});
});

test('typed product purchase and refund approvals bind exact Shop terms and sign for either asset', async t => {
  // Given a connected ATTO controller and server-shaped product approval challenges for both Marketplace assets.
  const fixture = await approvalFixture(t);
  const largeGross = '9'.repeat(65);
  const challengeCases = [];
  for (const [index, asset] of ['ATTO', 'XNO'].entries()) {
    const feeAtomic = index === 0 ? '0' : '17';
    const netAtomic = (BigInt(largeGross) - BigInt(feeAtomic)).toString();
    challengeCases.push({
      authority: null,
      action: { kind:'productPurchase', releaseId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        expectedReleaseHash:'ab'.repeat(32), sellerAgentId:agentId, asset,
        grossAtomic:largeGross, feeAtomic, netAtomic, idempotencyKey:randomUUID() },
      purpose:'product purchase',
    });
    for (const authority of ['SELLER', 'ADMIN']) {
      challengeCases.push({
        authority,
        action: { kind:'productRefund', purchaseId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          expectedPurchaseVersion:7, authority, buyerAgentId, sellerAgentId:agentId, asset,
          grossAtomic:largeGross, feeAtomic, netAtomic, originalPurchaseReceiptHash:'cd'.repeat(32),
          idempotencyKey:randomUUID() },
        purpose:'product refund',
      });
    }
  }

  // When each action is checked and signed, it must match the contract's field order and preserve the request identity.
  for (const [index, item] of challengeCases.entries()) {
    const request = productApprovalRequest(fixture.signer, item.action, item.purpose, index);
    const { preview } = fixture.client.inspectProofApproval(request);
    const response = await fixture.client.signProofApproval(request);
    const summary = formatMarketplaceApprovalPreview(preview);

    // Then the real ATTO signature covers the exact challenge and the terminal preview exposes every decision term.
    assert.equal(response.signature,
      (await fixture.signer.signMessage(new Int8Array(Buffer.from(request.challenge.message, 'utf8')))).toString());
    assert.equal(response.requestDigest, approvalRequestDigest(request));
    assert.equal(response.challengeId, request.challenge.challengeId);
    assert.equal(response.handoffId, request.handoffId);
    assert.match(summary, new RegExp(`Proof-bound asset: ${item.action.asset}`));
    assert.match(summary, new RegExp(`Proof-bound gross: ${largeGross} atomic`));
    assert.match(summary, new RegExp(`Client-provided fee \\(not verified by this proof\\): ${item.action.feeAtomic} atomic`));
    assert.match(summary, new RegExp(`Client-provided net \\(not verified by this proof\\): ${item.action.netAtomic} atomic`));
    assert.match(summary, new RegExp(`Proof-bound idempotency key: ${item.action.idempotencyKey}`));
    assert.match(summary,/Items marked client-provided are not verified by this proof/);
    if (item.action.kind === 'productPurchase') {
      assert.match(summary, /Action: purchase digital product release/);
      assert.match(summary, new RegExp(`Client-provided seller \\(not verified by this proof\\): ${item.action.sellerAgentId}`));
      assert.match(summary, new RegExp(`Proof-bound release ID: ${item.action.releaseId}`));
      assert.match(summary, new RegExp(`Proof-bound release SHA-256: ${item.action.expectedReleaseHash}`));
    } else {
      assert.match(summary, new RegExp(`Proof-bound authority: ${item.authority}`));
      assert.match(summary, new RegExp(`Proof-bound purchase ID: ${item.action.purchaseId}`));
      assert.match(summary, new RegExp(`Proof-bound original purchase receipt SHA-256: ${item.action.originalPurchaseReceiptHash}`));
      assert.match(summary, new RegExp(`Proof-bound expected purchase version: ${item.action.expectedPurchaseVersion}`));
      assert.match(summary, new RegExp(`Client-provided buyer \\(not verified by this proof\\): ${item.action.buyerAgentId}`));
      assert.match(summary, new RegExp(`Client-provided seller \\(not verified by this proof\\): ${item.action.sellerAgentId}`));
      assert.match(summary, item.authority === 'SELLER' ? /Action: seller refund/ : /Action: administrator refund compensation/);
    }
  }
});

test('product approvals reject changed, incomplete, or malformed terms before signing', async t => {
  // Given valid signed-challenge fixtures for purchase and administrator refund actions.
  const fixture = await approvalFixture(t);
  const grossAtomic = '9'.repeat(65);
  const purchase = { kind:'productPurchase', releaseId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    expectedReleaseHash:'ab'.repeat(32), sellerAgentId:agentId, asset:'ATTO', grossAtomic,
    feeAtomic:'0', netAtomic:grossAtomic, idempotencyKey:randomUUID() };
  const refund = { kind:'productRefund', purchaseId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    expectedPurchaseVersion:7, authority:'ADMIN', buyerAgentId, sellerAgentId:agentId, asset:'XNO',
    grossAtomic, feeAtomic:'0', netAtomic:grossAtomic, originalPurchaseReceiptHash:'cd'.repeat(32),
    idempotencyKey:randomUUID() };
  const purchaseRequest = productApprovalRequest(fixture.signer, purchase, 'product purchase', 40);
  const refundRequest = productApprovalRequest(fixture.signer, refund, 'product refund', 41);

  // When unknown keys, missing keys, invalid types, or any altered bound term is presented for approval.
  const invalidRequests = [
    { ...purchaseRequest, action:{ ...purchase, clientPrice:'1' } },
    { ...purchaseRequest, action:without(purchase, 'sellerAgentId') },
    { ...purchaseRequest, action:{ ...purchase, releaseId:purchase.releaseId.toUpperCase() } },
    { ...purchaseRequest, action:{ ...purchase, expectedReleaseHash:purchase.expectedReleaseHash.toUpperCase() } },
    { ...purchaseRequest, action:{ ...purchase, expectedReleaseHash:'ef'.repeat(32) } },
    { ...purchaseRequest, action:{ ...purchase, idempotencyKey:randomUUID() } },
    { ...purchaseRequest, action:{ ...purchase, asset:'NANO' } },
    { ...purchaseRequest, action:{ ...purchase, grossAtomic:'0' } },
    { ...purchaseRequest, action:{ ...purchase, grossAtomic:'0' + grossAtomic } },
    { ...purchaseRequest, action:{ ...purchase, grossAtomic:'1'.repeat(66), netAtomic:'1'.repeat(66) } },
    { ...purchaseRequest, action:{ ...purchase, grossAtomic:BigInt(grossAtomic) } },
    { ...purchaseRequest, action:{ ...purchase, feeAtomic:'-1' } },
    { ...purchaseRequest, action:{ ...purchase, feeAtomic:'1'.repeat(66) } },
    { ...purchaseRequest, action:{ ...purchase, netAtomic:'0' } },
    { ...purchaseRequest, action:{ ...purchase, netAtomic:'8'.repeat(65) } },
    { ...purchaseRequest, purpose:'product refund' },
    { ...purchaseRequest, challenge:{ ...purchaseRequest.challenge,
      message:purchaseRequest.challenge.message.replace(/Binding Hash: [0-9a-f]{64}/, `Binding Hash: ${'f'.repeat(64)}`) } },
    { ...refundRequest, action:{ ...refund, unexpected:true } },
    { ...refundRequest, action:without(refund, 'originalPurchaseReceiptHash') },
    { ...refundRequest, action:{ ...refund, authority:'OWNER' } },
    { ...refundRequest, action:{ ...refund, authority:'SELLER' } },
    { ...refundRequest, action:{ ...refund, idempotencyKey:randomUUID() } },
    { ...refundRequest, action:{ ...refund, expectedPurchaseVersion:Number.MAX_SAFE_INTEGER + 1 } },
    { ...refundRequest, action:{ ...refund, purchaseId:refund.purchaseId.toUpperCase() } },
    { ...refundRequest, action:{ ...refund, originalPurchaseReceiptHash:'CD'.repeat(32) } },
    { ...refundRequest, action:{ ...refund, netAtomic:'1'.repeat(66) } },
    { ...refundRequest, action:{ ...refund, asset:'ATTO', feeAtomic:'1' } },
  ];

  // Then every malformed or rebound approval is refused by the strict codec before a signature can be produced.
  for (const request of invalidRequests) {
    assert.throws(() => fixture.client.inspectProofApproval(request), { code:'MARKETPLACE_APPROVAL_PROTOCOL' });
  }
});

async function approvalFixture(t) {
  const phrase = (await AttoMnemonic.generate()).phrase;
  const seed = await (await AttoMnemonic.fromPhrase(phrase)).toSeedAsync();
  const signer = await derivedSigner(seed, 0);
  const fingerprint = createHash('sha256').update(signer.publicKey.toString()).digest('hex');
  const saved = new Map([
    ['identity', { address:signer.address.value, fingerprint }],
    ['marketplace.topups.connection', { version:1, apiUrl:`${origin}/v1/agent/topups`, audience:'marketplace-agent',
      controllerIndex:0, controllerAddress:signer.address.value, accountId, agentId, identityId,
      walletFingerprint:fingerprint }],
  ]);
  t.after(() => seed.value.fill(0));
  return {
    signer,
    client: new MarketplaceTopUpClient({ get:key=>saved.get(key), set:(key,value)=>saved.set(key,value) }, {
      settings:()=>({ network:'LIVE' }),
      addresses:()=>[{ index:0, address:signer.address.value, publicKey:signer.publicKey.toString(), active:true }],
      seed:async()=>(await AttoMnemonic.fromPhrase(phrase)).toSeedAsync(), mcp:false,
    }),
  };
}

function productApprovalRequest(signer, action, purpose, suffix) {
  const issuedAt = new Date(Date.now() - 1000).toISOString();
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const challengeId = randomUUID();
  const fields = action.kind === 'productPurchase'
    ? ['marketplace-product-purchase-approval-v1', accountId, identityId, action.releaseId, action.expectedReleaseHash,
      action.asset, action.grossAtomic, action.idempotencyKey]
    : ['marketplace-product-refund-approval-v1', action.authority, accountId, identityId, action.purchaseId,
      action.originalPurchaseReceiptHash, String(action.expectedPurchaseVersion), action.asset, action.grossAtomic,
      action.idempotencyKey];
  const bindingHash = lengthPrefixedApprovalHash(fields);
  const message = `Marketplace Agent Controller Proof v1\nAudience: marketplace-agent\nNetwork: live\nAddress: ${signer.address.value}`
    + `\nPurpose: ${purpose}\nRequest ID: ${challengeId}\nBinding Hash: ${bindingHash}\nNonce: ${String(suffix).padStart(2, '0').repeat(32)}`
    + `\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`;
  return { version:1, type:'marketplace-controller-approval-request', profileId:'agent',
    handoffId:randomUUID().replaceAll('-', ''), marketplaceOrigin:origin, transport:'AGENT_API', proofOrigin:null,
    audience:'marketplace-agent', accountId, identityId, controller:{ network:'ATTO', address:signer.address.value, index:0 },
    purpose, action, challenge:{ challengeId, message, issuedAt, expiresAt } };
}

function lengthPrefixedApprovalHash(fields) {
  const digest = createHash('sha256');
  for (const field of fields) {
    const bytes = Buffer.from(field, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    digest.update(length);
    digest.update(bytes);
  }
  return digest.digest('hex');
}

function without(value, key) {
  const copy = { ...value };
  delete copy[key];
  return copy;
}
