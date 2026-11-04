import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AttoPrivateKey } from '@attocash/commons-core';
import { addressFromPublicKey, hexBytes, publicKey } from '@attocash/atto-marketplace-nano-adapter/protocol';
import { validateTypedApproval } from '../dist/approval-validation.js';

const ids = Array.from({length:8},(_,index)=>`${String(index+1).repeat(8)}-${String(index+1).repeat(4)}-4${String(index+1).repeat(3)}-8${String(index+1).repeat(3)}-${String(index+1).repeat(12)}`);
const [accountId,identityId,destinationId,requestId,challengeId,targetId,linkId]=ids;
const atto = (await AttoPrivateKey.Companion.parse('01'.repeat(32)).toSigner()).address.toString();
const targetAtto = (await AttoPrivateKey.Companion.parse('02'.repeat(32)).toSigner()).address.toString();
const nano = addressFromPublicKey(publicKey(hexBytes('03'.repeat(32))));
const hash = fields => createHash('sha256').update(fields.join('\n')).digest('hex');

for (const network of ['ATTO','NANO']) {
  const address = network==='ATTO'?atto:nano;
  const nativeNetwork = network==='ATTO'?'live':'nano:dev';
  const cases = [
    ['login',{kind:'login',network,address},hash(['signer-controller-enrollment-v1',accountId,identityId])],
    ['unlink',{kind:'identity-unlink',targetIdentityId:targetId,authorizingIdentityId:identityId},hash(['unlink',accountId,targetId,identityId])],
    ...['ENROLL','SELECT','DISABLE'].map(operation=>[
      {ENROLL:'payout address enrollment',SELECT:'payout address selection',DISABLE:'payout address disablement'}[operation],
      {kind:'payout-address',network:'atto:dev',canonicalTargetAddress:targetAtto,command:{action:operation,asset:'ATTO',network:'atto:dev',idempotencyKey:requestId,
        ...(operation==='ENROLL'?{address:targetAtto}:{destinationId,expectedSelectionVersion:7})}},
      hash(['payout-address-v1',accountId,identityId,operation,'ATTO','atto:dev',operation==='ENROLL'?'':destinationId,targetAtto,operation==='ENROLL'?'':'7',requestId]),
    ]),
    ['withdrawal creation',{kind:'withdrawal',network:'nano:dev',destinationAddress:nano,command:{asset:'XNO',atomicAmount:'100',destinationId,
      expectedSelectionVersion:7,idempotencyKey:requestId,network:'nano:dev'}},
      hash(['withdrawal-create-v2',accountId,identityId,'XNO','100','nano:dev',destinationId,nano,'7',requestId])],
    ...['ROTATE','REVOKE'].map(operation=>[
      operation==='ROTATE'?'API-key rotation':'API-key revocation',
      {kind:'credential',operation,command:{operation,idempotencyKey:requestId,targetApiKeyId:targetId}},
      hash(['agent-credential-v1',accountId,identityId,operation,targetId,requestId,'']),
    ]),
    ...[
      [{name:'Reader',expiresInDays:30,scopes:['tasks:read']},['agent-credential-v2','Reader','30','tasks:read','','','','']],
      [{name:'Buyer',expiresInDays:30,scopes:['products:purchase'],purchaseXnoLimit:'5'},['agent-credential-v3','Buyer','30','products:purchase','','','','','','5']],
      [{name:'Seller',expiresInDays:30,scopes:['products:publish'],productPublishAttoLimit:'8'},['agent-credential-v4','Seller','30','products:publish','','','','','','','8','']],
    ].map(([credential,fields])=>['API-key creation',{kind:'credential',operation:'CREATE',command:{operation:'CREATE',idempotencyKey:requestId,credential}},
      hash(['agent-credential-v1',accountId,identityId,'CREATE','',requestId,fields.join('\n')])]),
  ];
  for (const [purpose,action,binding] of cases) {
    test(`${network} typed ${purpose} validates the exact action and immutable challenge`,()=>{
      // Given the backend's typed frame and independently specified binding fields.
      const request = envelope({network,address,nativeNetwork,purpose,action,binding});
      // When its network-specific public contract is inspected.
      assert.deepEqual(validateTypedApproval(request,{nativeNetwork}),request);
      // Then changed signatures domains, payloads, operation fields, and unsupported extra keys are rejected.
      for (const change of [
        {...request,accountId:targetId},
        {...request,identityId:targetId},
        {...request,controller:{...request.controller,address:network==='ATTO'?targetAtto:atto}},
        {...request,audience:'different audience'},
        {...request,challenge:{...request.challenge,message:request.challenge.message.replace(binding,'0'.repeat(64))}},
        {...request,action:{...action,arbitrarySigning:true}},
      ]) assert.throws(()=>validateTypedApproval(change,{nativeNetwork}),{code:'APPROVAL_BINDING'});
    });
  }
}

test('expired exact typed terms can be inspected for response recovery but never authorize fresh signing',()=>{
  // Given a historical, otherwise valid login frame.
  const request=envelope({network:'NANO',address:nano,nativeNetwork:'nano:dev',purpose:'login',
    action:{kind:'login',network:'NANO',address:nano},binding:hash(['signer-controller-enrollment-v1',accountId,identityId]),now:Date.now()-600_000});
  // When the caller explicitly inspects saved terms for recovery.
  assert.deepEqual(validateTypedApproval(request,{allowExpired:true}),request);
  // Then fresh signing still rejects it and malformed historical lifetimes stay invalid.
  assert.throws(()=>validateTypedApproval(request),{code:'APPROVAL_EXPIRED'});
  const changed={...request,challenge:{...request.challenge,expiresAt:request.challenge.issuedAt}};
  assert.throws(()=>validateTypedApproval(changed,{allowExpired:true}),{code:'APPROVAL_BINDING'});
});

test('typed user approval cannot smuggle administrator, raw signing, credential operation or payout target authority',()=>{
  // Given a valid typed payout enrollment.
  const action={kind:'payout-address',network:'atto:dev',canonicalTargetAddress:targetAtto,
    command:{action:'ENROLL',asset:'ATTO',address:targetAtto,idempotencyKey:requestId,network:'atto:dev'}};
  const request=envelope({network:'ATTO',address:atto,nativeNetwork:'live',purpose:'payout address enrollment',action,
    binding:hash(['payout-address-v1',accountId,identityId,'ENROLL','ATTO','atto:dev','',targetAtto,'',requestId])});
  // When an action attempts to introduce unsigned authority or a different raw target.
  const changes=[
    {...request,purpose:'administrator public moderation',action:{kind:'adminModeration'}},
    {...request,purpose:'message signing',action:{kind:'message',message:'anything'}},
    {...request,action:{...action,command:{...action.command,address:atto}}},
    {...request,purpose:'API-key creation',action:{kind:'credential',operation:'CREATE',command:{operation:'REVOKE',idempotencyKey:requestId,targetApiKeyId:targetId}}},
  ];
  // Then the common trust boundary rejects every request before key access.
  for(const changed of changes)assert.throws(()=>validateTypedApproval(changed),{code:'APPROVAL_BINDING'});
});

function envelope({network,address,nativeNetwork,purpose,action,binding,now=Date.now()}) {
  const issuedAt=new Date(now-1000).toISOString(),expiresAt=new Date(now+120_000).toISOString();
  return {version:1,type:'marketplace-controller-approval-request',profileId:'agent',handoffId:'a'.repeat(32),
    marketplaceOrigin:'https://marketplace.example',transport:'AGENT_API',proofOrigin:null,audience:'marketplace',accountId,identityId,
    controller:{network,address,index:7},purpose,action,challenge:{challengeId,issuedAt,expiresAt,
      message:`${network==='ATTO'?'':'Nano '}Marketplace Agent Controller Proof v1\nAudience: marketplace\nNetwork: ${nativeNetwork}\nAddress: ${address}\nPurpose: ${purpose}\nRequest ID: ${challengeId}\nBinding Hash: ${binding}\nNonce: ${'a'.repeat(64)}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`}};
}
