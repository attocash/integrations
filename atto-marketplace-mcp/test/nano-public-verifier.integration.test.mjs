import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyApprovalSignature } from '../dist/approval-files.js';

const address='nano_3noms9a1zytox399kygpge6cc7hu1z79ms1cgzojodz8741qi7w5u3nzb8mn';
const message='Hej Nano!🥦';
const signature='535c745819d0f40056f3c46402b4fae4356b3a8897bde99c955d411920e740d781e6dddcbde228e8b86c4383a1003f9f315519ff73bd356f561d19865dc90f09';

test('the installed JavaScript verifier accepts the public NOMS vector and rejects changed proof bytes', async()=>{
  // Given the public ORIS NOMS vector and unusable private wallet configuration paths.
  const request={version:1,type:'marketplace-controller-approval-request',profileId:'nano-agent',handoffId:'a'.repeat(32),
    marketplaceOrigin:'https://marketplace.example',transport:'AGENT_API',proofOrigin:null,audience:'marketplace-agent',
    controller:{network:'NANO',address,index:0},purpose:'product purchase',action:{kind:'verification-fixture'},
    challenge:{challengeId:'11111111-1111-4111-8111-111111111111',message,
      issuedAt:'2026-10-17T10:00:00Z',expiresAt:'2026-10-17T10:02:00Z'}};
  const response={version:1,type:'marketplace-controller-approval-response',profileId:request.profileId,handoffId:request.handoffId,
    requestDigest:'0'.repeat(64),challengeId:request.challenge.challengeId,message,signature,controllerAddress:address,controllerIndex:0};
  const env={MARKETPLACE_MCP_WALLET_HOST_COMMAND:'/this-command-must-not-be-executed',
    MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR:'/this-path-must-not-be-opened',
    MARKETPLACE_MCP_NANO_WALLET_DATA_DIR:'/this-path-must-not-be-opened',
    MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR:'/this-path-must-not-be-opened'};

  // When public JavaScript verification checks the address, exact message, and signature locally.
  await verifyApprovalSignature(request,response,env);
  const firstNibble=signature[0]==='0'?'1':'0';
  await assert.rejects(verifyApprovalSignature(request,{...response,signature:firstNibble+signature.slice(1)},env),
    {code:'APPROVAL_FILE'});
  await assert.rejects(verifyApprovalSignature({...request,challenge:{...request.challenge,message:'Hej Nano?🥦'}},response,env),
    {code:'APPROVAL_FILE'});
});
