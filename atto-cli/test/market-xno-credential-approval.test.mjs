import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {inspectMarketProofApproval} from '../dist/market/proof-approval.js';
import {formatMarketApprovalPreview} from '../dist/cli/cli.js';

const accountId='00000000-0000-4000-8000-000000000100';
const agentId='00000000-0000-4000-8000-000000000102';
const identityId='00000000-0000-4000-8000-000000000101';
const address='atto://'+'a'.repeat(61);
const origin='https://market.example';
const connection={version:1,apiUrl:origin+'/v1/agent/topups',audience:'market-agent',controllerIndex:0,
  controllerAddress:address,accountId,agentId,identityId,walletFingerprint:'fingerprint'};
const grants=[
  {applyXnoLimit:null,expectedHash:'18b6e7f5c4752aab453791029cf884181b9c6b1e9cab40bb52a7d0050e213d94'},
  {applyXnoLimit:'400',expectedHash:'61e6c9d73cc415c429576207b6042c174e9808f6c21aa3cd37b2a7b04f2b5e10'},
];

for(const grant of grants) {
  test('credential approval binds fixed V2 per-asset ceilings ' + JSON.stringify(grant),()=>{
    // Given the backend's V2 payload and the unchanged outer V1 credential hash envelope.
    const idempotencyKey='00000000-0000-4000-8000-000000000201';
    const credential={name:' Agent key ',expiresInDays:90,scopes:['tasks:publish','balances:read','applications:apply'],
      publishAttoLimit:'100',publishXnoLimit:'200',applyAttoLimit:'300',applyXnoLimit:grant.applyXnoLimit};
    const payload=['agent-credential-v2','Agent key','90','applications:apply,balances:read,tasks:publish',
      '100','200','300',grant.applyXnoLimit??''].join('\n');
    const binding=createHash('sha256').update(['agent-credential-v1',accountId,identityId,'CREATE','',idempotencyKey,payload].join('\n')).digest('hex');
    assert.equal(binding,grant.expectedHash);
    const challengeId='00000000-0000-4000-8000-000000000203';
    const issuedAt=new Date(Date.now()-1000).toISOString();
    const expiresAt=new Date(Date.now()+120000).toISOString();
    const message=[
      'Atto Market Agent Controller Proof v1',
      'Audience: market-agent',
      'Network: live',
      'Address: '+address,
      'Purpose: API-key creation',
      'Request ID: '+challengeId,
      'Binding Hash: '+binding,
      'Nonce: '+'ab'.repeat(32),
      'Issued At: '+issuedAt,
      'Expiration Time: '+expiresAt,
    ].join('\n');
    const request={version:1,type:'atto-market-controller-approval-request',profileId:'agent',handoffId:'a'.repeat(32),
      marketOrigin:origin,transport:'AGENT_API',proofOrigin:null,audience:'market-agent',accountId,identityId,
      controller:{network:'ATTO',address,index:0},purpose:'API-key creation',
      action:{kind:'credential',operation:'CREATE',command:{operation:'CREATE',idempotencyKey,credential}},
      challenge:{challengeId,message,issuedAt,expiresAt}};

    // When the wallet validates the action and creates the human approval summary.
    const {preview}=inspectMarketProofApproval(request,connection,()=>address);
    const summary=formatMarketApprovalPreview(preview);

    // Then each configured asset ceiling is visible, and changing any binding fails before signing.
    assert.ok(summary.includes('ATTO publish ceiling: 100 atomic units'));
    assert.ok(summary.includes('XNO publish ceiling: 200 atomic units'));
    assert.ok(summary.includes('ATTO application ceiling: 300 atomic units'));
    if(grant.applyXnoLimit!==null) assert.ok(summary.includes('XNO application ceiling: 400 atomic units'));
    const changed={...request,action:{...request.action,command:{...request.action.command,
      credential:{...credential,applyXnoLimit:'401'}}}};
    assert.throws(()=>inspectMarketProofApproval(changed,connection,()=>address),{code:'MARKET_APPROVAL_PROTOCOL'});
    const retiredScope=structuredClone(request);
    retiredScope.action.command.credential.scopes[0]='jobs:publish';
    assert.throws(()=>inspectMarketProofApproval(retiredScope,connection,()=>address),{code:'MARKET_APPROVAL_PROTOCOL'});

    // Omission and explicit null use the same empty V2 field when another grant remains valid.
    const omitted=structuredClone(request);
    delete omitted.action.command.credential.applyXnoLimit;
    if(grant.applyXnoLimit===null) assert.doesNotThrow(()=>inspectMarketProofApproval(omitted,connection,()=>address));
    else assert.throws(()=>inspectMarketProofApproval(omitted,connection,()=>address),{code:'MARKET_APPROVAL_PROTOCOL'});

    // Empty ceiling strings are malformed and cannot be normalized into the empty canonical slot.
    for(const field of ['publishAttoLimit','publishXnoLimit','applyAttoLimit','applyXnoLimit']) {
      const malformed=structuredClone(request);
      malformed.action.command.credential[field]='';
      assert.throws(()=>inspectMarketProofApproval(malformed,connection,()=>address),{code:'MARKET_APPROVAL_PROTOCOL'});
    }
  });
}

test('Shop credential approval uses V3 slots and displays explicit purchase ceilings',()=>{
  // Given a file-readable product buyer key with one asset-specific purchase ceiling.
  const idempotencyKey='00000000-0000-4000-8000-000000000301';
  const credential={name:' Shop buyer ',expiresInDays:90,scopes:['products:purchase','files:read'],
    purchaseAttoLimit:'900',purchaseXnoLimit:null};
  const payload=['agent-credential-v3','Shop buyer','90','files:read,products:purchase','','','','','900',''].join('\n');
  const binding=createHash('sha256').update(['agent-credential-v1',accountId,identityId,'CREATE','',idempotencyKey,payload].join('\n')).digest('hex');
  const challengeId='00000000-0000-4000-8000-000000000303';
  const issuedAt=new Date(Date.now()-1000).toISOString();
  const expiresAt=new Date(Date.now()+120000).toISOString();
  const message=[
    'Atto Market Agent Controller Proof v1','Audience: market-agent','Network: live','Address: '+address,
    'Purpose: API-key creation','Request ID: '+challengeId,'Binding Hash: '+binding,'Nonce: '+'cd'.repeat(32),
    'Issued At: '+issuedAt,'Expiration Time: '+expiresAt,
  ].join('\n');
  const request={version:1,type:'atto-market-controller-approval-request',profileId:'agent',handoffId:'b'.repeat(32),
    marketOrigin:origin,transport:'AGENT_API',proofOrigin:null,audience:'market-agent',accountId,identityId,
    controller:{network:'ATTO',address,index:0},purpose:'API-key creation',
    action:{kind:'credential',operation:'CREATE',command:{operation:'CREATE',idempotencyKey,credential}},
    challenge:{challengeId,message,issuedAt,expiresAt}};

  // When the controller approval parser verifies the new canonical payload and formats its summary.
  const {preview}=inspectMarketProofApproval(request,connection,()=>address);
  const summary=formatMarketApprovalPreview(preview);

  // Then the exact grant is reviewable and changed or missing ceilings fail before signing.
  assert.match(summary,/Scopes: products:purchase, files:read/);
  assert.match(summary,/ATTO product purchase ceiling: 900 atomic units/);
  assert.match(summary,/XNO product purchase ceiling: denied/);
  const changed=structuredClone(request);
  changed.action.command.credential.purchaseAttoLimit='901';
  assert.throws(()=>inspectMarketProofApproval(changed,connection,()=>address),{code:'MARKET_APPROVAL_PROTOCOL'});
  const missing=structuredClone(request);
  delete missing.action.command.credential.purchaseAttoLimit;
  assert.throws(()=>inspectMarketProofApproval(missing,connection,()=>address),{code:'MARKET_APPROVAL_PROTOCOL'});
});

test('product publication grant uses the cross-language V4 approval vector and shows both reservation ceilings',()=>{
  // Given the backend golden vector for a product publisher with both asset limits.
  const idempotencyKey='00000000-0000-4000-8000-000000000201';
  const credential={name:' Seller ',expiresInDays:90,scopes:['products:publish'],
    productPublishAttoLimit:'20',productPublishXnoLimit:'30'};
  const payload=['agent-credential-v4','Seller','90','products:publish','','','','','','','20','30'].join('\n');
  const binding=createHash('sha256').update(['agent-credential-v1',accountId,identityId,'CREATE','',idempotencyKey,payload].join('\n')).digest('hex');
  assert.equal(binding,'ecae64f027b8bc34183f792a6802031cd5bda85ec8325a89c6bcebbc9ba3ada7');
  const challengeId='00000000-0000-4000-8000-000000000203';
  const issuedAt=new Date(Date.now()-1000).toISOString();
  const expiresAt=new Date(Date.now()+120000).toISOString();
  const message=['Atto Market Agent Controller Proof v1','Audience: market-agent','Network: live','Address: '+address,
    'Purpose: API-key creation','Request ID: '+challengeId,'Binding Hash: '+binding,'Nonce: '+'ef'.repeat(32),
    'Issued At: '+issuedAt,'Expiration Time: '+expiresAt].join('\n');
  const request={version:1,type:'atto-market-controller-approval-request',profileId:'agent',handoffId:'d'.repeat(32),
    marketOrigin:origin,transport:'AGENT_API',proofOrigin:null,audience:'market-agent',accountId,identityId,
    controller:{network:'ATTO',address,index:0},purpose:'API-key creation',
    action:{kind:'credential',operation:'CREATE',command:{operation:'CREATE',idempotencyKey,credential}},
    challenge:{challengeId,message,issuedAt,expiresAt}};

  // When the local controller parser binds the command to its typed challenge.
  const {preview}=inspectMarketProofApproval(request,connection,()=>address);
  const summary=formatMarketApprovalPreview(preview);

  // Then both new ceilings are visible and the published cross-language digest matches exactly.
  assert.match(summary,/Scopes: products:publish/);
  assert.match(summary,/ATTO product publication reservation ceiling: 20 atomic units/);
  assert.match(summary,/XNO product publication reservation ceiling: 30 atomic units/);
  const changed=structuredClone(request);
  changed.action.command.credential.productPublishXnoLimit='31';
  assert.throws(()=>inspectMarketProofApproval(changed,connection,()=>address),{code:'MARKET_APPROVAL_PROTOCOL'});
  const malformed=structuredClone(request);
  malformed.action.command.credential.productPublishAttoLimit='';
  assert.throws(()=>inspectMarketProofApproval(malformed,connection,()=>address),{code:'MARKET_APPROVAL_PROTOCOL'});
});

test('legacy products:publish grants without reservation ceilings retain the V3 payload',()=>{
  // Given a pre-V4 product publisher that may manage an existing hold but has no new-hold ceiling.
  const idempotencyKey='00000000-0000-4000-8000-000000000401';
  const credential={name:' Legacy publisher ',expiresInDays:90,scopes:['products:publish']};
  const payload=['agent-credential-v3','Legacy publisher','90','products:publish','','','','','',''].join('\n');
  const binding=createHash('sha256').update(['agent-credential-v1',accountId,identityId,'CREATE','',idempotencyKey,payload].join('\n')).digest('hex');
  assert.equal(binding,'417640bab1fa7329bcb0a83ccac4a560fa528ada4bf7d9eea15faaec6d90fc20');
  const challengeId='00000000-0000-4000-8000-000000000403';
  const issuedAt=new Date(Date.now()-1000).toISOString();
  const expiresAt=new Date(Date.now()+120000).toISOString();
  const message=['Atto Market Agent Controller Proof v1','Audience: market-agent','Network: live','Address: '+address,
    'Purpose: API-key creation','Request ID: '+challengeId,'Binding Hash: '+binding,'Nonce: '+'fa'.repeat(32),
    'Issued At: '+issuedAt,'Expiration Time: '+expiresAt].join('\n');
  const request={version:1,type:'atto-market-controller-approval-request',profileId:'agent',handoffId:'e'.repeat(32),
    marketOrigin:origin,transport:'AGENT_API',proofOrigin:null,audience:'market-agent',accountId,identityId,
    controller:{network:'ATTO',address,index:0},purpose:'API-key creation',
    action:{kind:'credential',operation:'CREATE',command:{operation:'CREATE',idempotencyKey,credential}},
    challenge:{challengeId,message,issuedAt,expiresAt}};

  // When the CLI checks the legacy command and the exact V3 challenge digest.
  const {preview}=inspectMarketProofApproval(request,connection,()=>address);
  const summary=formatMarketApprovalPreview(preview);

  // Then legacy product authority remains reviewable without acquiring any new-reservation ceiling.
  assert.match(summary,/ATTO product publication reservation ceiling: denied/);
  assert.match(summary,/XNO product publication reservation ceiling: denied/);
  const explicitNulls=structuredClone(request);
  explicitNulls.action.command.credential.productPublishAttoLimit=null;
  explicitNulls.action.command.credential.productPublishXnoLimit=null;
  assert.doesNotThrow(()=>inspectMarketProofApproval(explicitNulls,connection,()=>address));
  const changed=structuredClone(request);
  changed.action.command.credential.productPublishAttoLimit='20';
  assert.throws(()=>inspectMarketProofApproval(changed,connection,()=>address),{code:'MARKET_APPROVAL_PROTOCOL'});
});
