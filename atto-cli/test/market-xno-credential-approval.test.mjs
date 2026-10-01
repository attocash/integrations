import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {inspectMarketProofApproval} from '../dist/market/proof-approval.js';
import {formatMarketApprovalPreview} from '../dist/cli/cli.js';

const accountId='00000000-0000-4000-8000-000000000100';
const agentId='00000000-0000-4000-8000-000000000102';
const identityId='00000000-0000-4000-8000-000000000101';
const address=`atto://${'a'.repeat(61)}`;
const origin='https://market.example';
const connection={version:1,apiUrl:`${origin}/v1/agent/topups`,audience:'market-agent',controllerIndex:0,
  controllerAddress:address,accountId,agentId,identityId,walletFingerprint:'fingerprint'};

for(const grant of [{applyAttoLimit:'50'},{applyXnoLimit:'9007199254740993123456789'},{applyAttoLimit:'50',applyXnoLimit:'70'}]) {
 test(`credential approval binds exact per-asset ceilings ${JSON.stringify(grant)}`,()=>{
  // Given the backend's canonical credential proof and an unchanged legacy hash when XNO is absent.
  const idempotencyKey='00000000-0000-4000-8000-000000000201';
  const credential={name:'bounded worker',expiresInDays:90,scopes:['applications:apply'],...grant};
  const legacy=['bounded worker','90','applications:apply','','',grant.applyAttoLimit??''];
  const payload=(grant.applyXnoLimit?['agent-credential-v2',...legacy,grant.applyXnoLimit]:legacy).join('\n');
  const binding=createHash('sha256').update(['agent-credential-v1',accountId,identityId,'CREATE','',idempotencyKey,payload].join('\n')).digest('hex');
  const challengeId='00000000-0000-4000-8000-000000000203';
  const issuedAt=new Date(Date.now()-1000).toISOString();
  const expiresAt=new Date(Date.now()+120000).toISOString();
  const message=`Atto Market Agent Controller Proof v1\nAudience: market-agent\nNetwork: live\nAddress: ${address}\nPurpose: API-key creation\nRequest ID: ${challengeId}\nBinding Hash: ${binding}\nNonce: ${'ab'.repeat(32)}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`;
  const request={version:1,type:'atto-market-controller-approval-request',profileId:'agent',handoffId:'a'.repeat(32),
   marketOrigin:origin,transport:'AGENT_API',proofOrigin:null,audience:'market-agent',accountId,identityId,
   controller:{network:'ATTO',address,index:0},purpose:'API-key creation',
   action:{kind:'credential',operation:'CREATE',command:{operation:'CREATE',idempotencyKey,credential}},
   challenge:{challengeId,message,issuedAt,expiresAt}};

  // When the wallet validates the action and creates the human approval summary.
  const {preview}=inspectMarketProofApproval(request,connection,()=>address);
  const summary=formatMarketApprovalPreview(preview);

  // Then every approved asset ceiling is visible, and changing XNO authority fails before signing.
  for(const [field,amount] of Object.entries(grant)) assert.ok(summary.includes(`${field==='applyXnoLimit'?'XNO':'ATTO'} application ceiling: ${amount} atomic units`));
  const changed={...request,action:{...request.action,command:{...request.action.command,credential:{...credential,applyXnoLimit:'71'}}}};
  assert.throws(()=>inspectMarketProofApproval(changed,connection,()=>address),{code:'MARKET_APPROVAL_PROTOCOL'});
 });
}
