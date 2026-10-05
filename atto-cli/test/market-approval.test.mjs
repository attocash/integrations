import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { AttoMnemonic } from '@attocash/commons-core';
import { derivedSigner } from '../dist/wallet/signing.js';
import { approvalRequestDigest } from '../dist/market/proof-approval.js';
import { MarketTopUpClient } from '../dist/market/topups.js';

const origin = 'https://market.example';
const accountId = '00000000-0000-4000-8000-000000000100';
const agentId = '00000000-0000-4000-8000-000000000102';
const identityId = '00000000-0000-4000-8000-000000000101';

test('typed withdrawal approval validates controller, audience, action binding, and signs exact server message', async t => {
  // Given one saved wallet, its configured Market account, and an immutable XNO withdrawal challenge.
  const phrase = (await AttoMnemonic.generate()).phrase;
  const seed = await (await AttoMnemonic.fromPhrase(phrase)).toSeedAsync();
  const signer = await derivedSigner(seed, 0);
  const fingerprint = createHash('sha256').update(signer.publicKey.toString()).digest('hex');
  const saved = new Map([
    ['identity', { address: signer.address.value, fingerprint }],
    ['market.topups.connection', { version:1, apiUrl:`${origin}/v1/agent/topups`, audience:'market-agent',
      controllerIndex:0, controllerAddress:signer.address.value, accountId, agentId, identityId, walletFingerprint:fingerprint }],
  ]);
  const connection = saved.get('market.topups.connection');
  const requestId = '00000000-0000-4000-8000-000000000201';
  const destinationId = '00000000-0000-4000-8000-000000000202';
  const challengeId = '00000000-0000-4000-8000-000000000203';
  const issuedAt = new Date(Date.now()-1000).toISOString();
  const expiresAt = new Date(Date.now()+120_000).toISOString();
  const action = { kind:'withdrawal', network:'xno:live', destinationAddress:'nano_1111111111111111111111111111111111111111111111111111hifc8npp',
    command:{asset:'XNO',atomicAmount:'25',destinationId,expectedSelectionVersion:2,idempotencyKey:requestId,network:'xno:live'} };
  const bindingHash = createHash('sha256').update(['withdrawal-create-v2',accountId,identityId,'XNO','25','xno:live',destinationId,
    action.destinationAddress,'2',requestId].join('\n')).digest('hex');
  const message = `Atto Market Agent Controller Proof v1\nAudience: market-agent\nNetwork: live\nAddress: ${signer.address.value}\nPurpose: withdrawal creation\nRequest ID: ${challengeId}\nBinding Hash: ${bindingHash}\nNonce: ${'ab'.repeat(32)}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`;
  const request = {version:1,type:'atto-market-controller-approval-request',profileId:'agent',handoffId:'a'.repeat(32),
    marketOrigin:origin,transport:'AGENT_API',proofOrigin:null,audience:'market-agent',accountId,identityId,
    controller:{network:'ATTO',address:signer.address.value,index:0},purpose:'withdrawal creation',action,
    challenge:{challengeId,message,issuedAt,expiresAt}};
  t.after(() => seed.value.fill(0));
  const client = new MarketTopUpClient({get:key=>saved.get(key),set:(key,value)=>saved.set(key,value)}, {
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
    message:message.replace(bindingHash,v1BindingHash)}}), {code:'MARKET_APPROVAL_PROTOCOL'});

  // Any changed destination, amount, request ID, account, or authority audience fails before signing.
  assert.throws(()=>client.inspectProofApproval({...request,action:{...action,command:{...action.command,atomicAmount:'26'}}}), {code:'MARKET_APPROVAL_PROTOCOL'});
  assert.throws(()=>client.inspectProofApproval({...request,action:{...action,destinationAddress:'nano_3differentdestination'}}), {code:'MARKET_APPROVAL_PROTOCOL'});
  assert.throws(()=>client.inspectProofApproval({...request,action:{...action,command:{...action.command,idempotencyKey:'00000000-0000-4000-8000-000000000205'}}}), {code:'MARKET_APPROVAL_PROTOCOL'});
  assert.throws(()=>client.inspectProofApproval({...request,action:{...action,command:{...action.command,network:'xno:test'}}}), {code:'MARKET_APPROVAL_PROTOCOL'});
  assert.throws(()=>client.inspectProofApproval({...request,accountId:'00000000-0000-4000-8000-000000000206'}), {code:'MARKET_APPROVAL_MISMATCH'});
  assert.throws(()=>client.inspectProofApproval({...request,audience:'other-audience'}), {code:'MARKET_APPROVAL_MISMATCH'});
});

test('typed payout enrollment, selection, and disablement sign producer-shaped nested commands', async t => {
  const phrase=(await AttoMnemonic.generate()).phrase;
  const seed=await (await AttoMnemonic.fromPhrase(phrase)).toSeedAsync();
  const signer=await derivedSigner(seed,0);
  const target=(await derivedSigner(seed,1)).address.value;
  const fingerprint=createHash('sha256').update(signer.publicKey.toString()).digest('hex');
  const saved=new Map([['identity',{address:signer.address.value,fingerprint}],['market.topups.connection',{version:1,
    apiUrl:`${origin}/v1/agent/topups`,audience:'market-agent',controllerIndex:0,controllerAddress:signer.address.value,
    accountId,agentId,identityId,walletFingerprint:fingerprint}]]);
  const client=new MarketTopUpClient({get:key=>saved.get(key),set:(key,value)=>saved.set(key,value)}, {
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
    const message=`Atto Market Agent Controller Proof v1\nAudience: market-agent\nNetwork: live\nAddress: ${signer.address.value}\nPurpose: ${purpose}\nRequest ID: ${challengeId}\nBinding Hash: ${binding}\nNonce: ${'ef'.repeat(32)}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`;
    const request={version:1,type:'atto-market-controller-approval-request',profileId:'agent',handoffId:String(index+1).repeat(32),
      marketOrigin:origin,transport:'AGENT_API',proofOrigin:null,audience:'market-agent',accountId,identityId,
      controller:{network:'ATTO',address:signer.address.value,index:0},purpose,action,
      challenge:{challengeId,message,issuedAt,expiresAt}};
    const {preview}=client.inspectProofApproval(request);
    const response=await client.signProofApproval(request);
    assert.equal(preview.purpose,purpose);
    assert.equal(preview.action.command.action,actionName);
    assert.equal(response.requestDigest,approvalRequestDigest(request));
    assert.equal(response.signature,(await signer.signMessage(new Int8Array(Buffer.from(message,'utf8')))).toString());
    assert.throws(()=>client.inspectProofApproval({...request,action:{...action,command:{...command,action:actionName==='DISABLE'?'SELECT':'DISABLE'}}}),
      {code:'MARKET_APPROVAL_PROTOCOL'});
    assert.throws(()=>client.inspectProofApproval({...request,action:{...action,command:{...command,network:'atto:live'}}}),
      {code:'MARKET_APPROVAL_PROTOCOL'});
  }
});

test('browser proof approval preserves an exact browser-origin audience', async t => {
  // Given a browser request whose audience is its approved Market origin.
  const phrase=(await AttoMnemonic.generate()).phrase;
  const seed=await (await AttoMnemonic.fromPhrase(phrase)).toSeedAsync();
  const signer=await derivedSigner(seed,0);
  const fingerprint=createHash('sha256').update(signer.publicKey.toString()).digest('hex');
  const saved=new Map([['identity',{address:signer.address.value,fingerprint}],['market.topups.connection',{version:1,
    apiUrl:`${origin}/v1/agent/topups`,audience:'market-agent',controllerIndex:0,controllerAddress:signer.address.value,
    accountId,agentId,identityId,walletFingerprint:fingerprint}]]);
  const issuedAt=new Date(Date.now()-1000).toISOString();
  const expiresAt=new Date(Date.now()+120_000).toISOString();
  const challengeId='00000000-0000-4000-8000-000000000204';
  const message=`Atto Market Agent Controller Proof v1\nAudience: ${origin}\nNetwork: live\nAddress: ${signer.address.value}\nPurpose: login\nRequest ID: ${challengeId}\nNonce: ${'cd'.repeat(32)}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`;
  const request={version:1,type:'atto-market-controller-approval-request',profileId:'agent',handoffId:'b'.repeat(32),
    marketOrigin:origin,transport:'BROWSER',proofOrigin:origin,audience:origin,
    controller:{network:'ATTO',address:signer.address.value,index:0},purpose:'login',action:{kind:'login',network:'ATTO',address:signer.address.value},
    challenge:{challengeId,message,issuedAt,expiresAt}};
  t.after(()=>seed.value.fill(0));
  const client=new MarketTopUpClient({get:key=>saved.get(key),set:(key,value)=>saved.set(key,value)}, {
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
    challenge:{...request.challenge,message:message.replace(`Audience: ${origin}`,`Audience: ${attacker}`)}}), {code:'MARKET_APPROVAL_MISMATCH'});
});
