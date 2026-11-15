import {createRequire} from 'node:module';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const cliDirectory=process.env.ATTO_TEST_CLI_PACKAGE_DIR??fileURLToPath(new URL('../',import.meta.url));
const {AttoMnemonic}=await import(pathToFileURL(createRequire(join(cliDirectory,'package.json')).resolve('@attocash/commons-core')).href);
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
const { derivedSigner }=await import(pathToFileURL(join(cliDirectory,'dist/wallet/signing.js')).href);
const { approvalRequestDigest }=await import(pathToFileURL(join(cliDirectory,'dist/marketplace/proof-approval.js')).href);
const { MarketplaceConnectionClient }=await import(pathToFileURL(join(cliDirectory,'dist/marketplace/connection.js')).href);
const { formatMarketplaceApprovalPreview }=await import(pathToFileURL(join(cliDirectory,'dist/cli/cli.js')).href);

const origin = 'https://marketplace.example';
const accountId = '00000000-0000-4000-8000-000000000100';
const agentId = '00000000-0000-4000-8000-000000000102';
const identityId = '00000000-0000-4000-8000-000000000101';
const buyerAgentId = '00000000-0000-4000-8000-000000000103';

test('browser proof approval preserves an exact browser-origin audience', async t => {
  // Given a browser request whose audience is its approved Marketplace origin.
  const phrase=(await AttoMnemonic.generate()).phrase;
  const seed=await (await AttoMnemonic.fromPhrase(phrase)).toSeedAsync();
  const signer=await derivedSigner(seed,0);
  const fingerprint=createHash('sha256').update(signer.publicKey.toString()).digest('hex');
  const saved=new Map([['identity',{address:signer.address.value,fingerprint}],['marketplace.connection',{version:1,
    apiUrl:`${origin}/v1/agent/payments`,audience:'marketplace-agent',controllerIndex:0,controllerAddress:signer.address.value,
    accountId,agentId,identityId,walletFingerprint:fingerprint}]]);
  const issuedAt=new Date(Date.now()-1000).toISOString();
  const expiresAt=new Date(Date.now()+120_000).toISOString();
  const challengeId='00000000-0000-4000-8000-000000000204';
  const message=`Marketplace Agent Controller Proof v1\nAudience: ${origin}\nNetwork: live\nAddress: ${signer.address.value}\nPurpose: login\nRequest ID: ${challengeId}\nBinding Hash: ${createHash('sha256').update(['marketplace-login-v1',accountId,identityId].join('\n')).digest('hex')}\nNonce: ${'cd'.repeat(32)}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`;
  const request={version:1,type:'marketplace-controller-approval-request',profileId:'agent',handoffId:'b'.repeat(32),
    marketplaceOrigin:origin,transport:'BROWSER',proofOrigin:origin,audience:origin,accountId,identityId,
    controller:{network:'ATTO',address:signer.address.value,index:0},purpose:'login',action:{kind:'login',network:'ATTO',address:signer.address.value},
    challenge:{challengeId,message,issuedAt,expiresAt}};
  t.after(()=>seed.value.fill(0));
  const client=new MarketplaceConnectionClient({get:key=>saved.get(key),set:(key,value)=>saved.set(key,value)}, {
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
