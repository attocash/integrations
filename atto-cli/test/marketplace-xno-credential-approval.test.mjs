import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {inspectMarketplaceProofApproval} from '../dist/marketplace/proof-approval.js';
import {formatMarketplaceApprovalPreview} from '../dist/cli/cli.js';

const accountId='00000000-0000-4000-8000-000000000100';
const identityId='00000000-0000-4000-8000-000000000101';
const address='atto://'+'a'.repeat(61);
const origin='https://marketplace.example';
const connection={version:1,apiUrl:origin+'/v1/agent/payments',audience:'marketplace-agent',controllerIndex:0,
  controllerAddress:address,accountId,agentId:'00000000-0000-4000-8000-000000000102',identityId,walletFingerprint:'fingerprint'};
const idempotencyKey='00000000-0000-4000-8000-000000000201';
function approval(credential) {
  const payload=['marketplace-credential-v1',credential.name.trim(),String(credential.expiresInDays),
    [...credential.scopes].sort().join(','),...['publishAttoLimit','publishXnoLimit','purchaseAttoLimit',
      'purchaseXnoLimit','productPublishAttoLimit','productPublishXnoLimit'].map(field=>credential[field]??'')].join('\n');
  const binding=createHash('sha256').update(['agent-credential-v1',accountId,identityId,'CREATE','',idempotencyKey,payload].join('\n')).digest('hex');
  const challengeId='00000000-0000-4000-8000-000000000203';
  const issuedAt=new Date(Date.now()-1000).toISOString(),expiresAt=new Date(Date.now()+120000).toISOString();
  const message=['Marketplace Agent Controller Proof v1','Audience: marketplace-agent','Network: live','Address: '+address,
    'Purpose: API-key creation','Request ID: '+challengeId,'Binding Hash: '+binding,'Nonce: '+'ab'.repeat(32),
    'Issued At: '+issuedAt,'Expiration Time: '+expiresAt].join('\n');
  return {binding,request:{version:1,type:'marketplace-controller-approval-request',profileId:'agent',handoffId:'a'.repeat(32),
    marketplaceOrigin:origin,transport:'AGENT_API',proofOrigin:null,audience:'marketplace-agent',accountId,identityId,
    controller:{network:'ATTO',address,index:0},purpose:'API-key creation',
    action:{kind:'credential',operation:'CREATE',command:{operation:'CREATE',idempotencyKey,credential}},
    challenge:{challengeId,message,issuedAt,expiresAt}}};
}
test('credential approval matches the Kotlin canonical publication and purchase vector',()=>{
  // Given
  const credential={name:'Shop key',expiresInDays:90,scopes:['products:purchase','products:publish'],purchaseAttoLimit:'900',productPublishAttoLimit:'10000'};
  const {binding,request}=approval(credential);
  // When
  const preview=inspectMarketplaceProofApproval(request,connection,()=>address).preview;
  // Then
  assert.equal(binding,'4b1206545669be0d371b7f5aed4296eb04457f4528c8e00933c0e40e660193c1');
  const text=formatMarketplaceApprovalPreview(preview);
  assert.match(text,/900/);assert.match(text,/10000/);
  const changed=structuredClone(request);changed.action.command.credential.productPublishAttoLimit='10001';
  assert.throws(()=>inspectMarketplaceProofApproval(changed,connection,()=>address),{code:'MARKETPLACE_APPROVAL_PROTOCOL'});
});
test('free application and payment grants have no customer funding ceilings',()=>{
  // Given
  const {request}=approval({name:'Worker',expiresInDays:90,scopes:['applications:apply','payments:read','payments:write']});
  // When / Then
  assert.doesNotThrow(()=>inspectMarketplaceProofApproval(request,connection,()=>address));
  for(const change of [{applyAttoLimit:'1'},{applyXnoLimit:'1'},{scopes:['balances:read']}]) {
    const malformed=structuredClone(request);Object.assign(malformed.action.command.credential,change);
    assert.throws(()=>inspectMarketplaceProofApproval(malformed,connection,()=>address),{code:'MARKETPLACE_APPROVAL_PROTOCOL'});
  }
});
test('all current asset ceilings bind exactly and malformed atoms fail before signing',()=>{
  // Given
  const credential={name:'Agent',expiresInDays:90,scopes:['tasks:publish','products:publish','products:purchase'],
    publishAttoLimit:'100',publishXnoLimit:'200',purchaseAttoLimit:'300',purchaseXnoLimit:'400',productPublishAttoLimit:'500',productPublishXnoLimit:'600'};
  const {request}=approval(credential);
  // When / Then
  assert.doesNotThrow(()=>inspectMarketplaceProofApproval(request,connection,()=>address));
  for(const field of Object.keys(credential).filter(field=>field.endsWith('Limit'))) {
    const changed=structuredClone(request);changed.action.command.credential[field]='601';
    assert.throws(()=>inspectMarketplaceProofApproval(changed,connection,()=>address),{code:'MARKETPLACE_APPROVAL_PROTOCOL'});
    for(const invalid of ['', '01','1e3','-1','0']) {
      changed.action.command.credential[field]=invalid;
      assert.throws(()=>inspectMarketplaceProofApproval(changed,connection,()=>address),{code:'MARKETPLACE_APPROVAL_PROTOCOL'});
    }
  }
});
