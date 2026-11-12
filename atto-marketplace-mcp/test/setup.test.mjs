import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdtemp, rm, writeFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AttoPrivateKey } from '@attocash/commons-core';
import { hexBytes, offchainSign, upperHex } from '@attocash/atto-marketplace-nano-adapter/protocol';
const packageDirectory=process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR??join(import.meta.dirname,'..');
const { runSetup: runSetupCommand }=await import(pathToFileURL(join(packageDirectory,'dist/setup.js')).href);
const { MarketplaceProfileStore }=await import(pathToFileURL(join(packageDirectory,'dist/profile-store.js')).href);
const { approvalRequestDigest, writeApprovalRequest }=await import(pathToFileURL(join(packageDirectory,'dist/approval-files.js')).href);

const accountId='11111111-1111-4111-8111-111111111111';
const agentId='22222222-2222-4222-8222-222222222222';
const identityId='33333333-3333-4333-8333-333333333333';
const testAttoPrivateKey='01'.repeat(32);
const controllerSigner=await AttoPrivateKey.Companion.parse(testAttoPrivateKey).toSigner();
const controllerAddress=controllerSigner.address.toString();
const require=createRequire(import.meta.url);

/** Exercise setup's private typed request/response boundary with this test owner's key. */
async function runApprovedSetup(argv, env) {
  const home=argv[argv.indexOf('--home')+1], profileId=argv[argv.indexOf('--profile')+1];
  if(argv.includes('--complete') && env.MARKETPLACE_MCP_WALLET_HOST_COMMAND) {
    const store=await MarketplaceProfileStore.open(home);
    let pending;
    try{pending=store.getSetupState(profileId);}finally{store.close();}
    if(pending?.state==='LOGIN_APPROVAL') await approveFixtureLogin(home,JSON.parse(pending.privatePayload).request,env);
  }
  let output='';const originalWrite=process.stdout.write;
  process.stdout.write=chunk=>{output+=String(chunk);return true;};
  try{await runSetupCommand(argv,env);}finally{process.stdout.write=originalWrite;}
  const result=output.trim()?JSON.parse(output.trim()):undefined;
  if(result?.status==='approval_required') {
    const store=await MarketplaceProfileStore.open(home);let saved;
    try{saved=JSON.parse(store.getSetupState(profileId).privatePayload);}finally{store.close();}
    if(saved.request?.purpose==='login') {
      await approveFixtureLogin(home,saved.request,env);
      await runSetupCommand(['--profile',profileId,'--home',home,'--complete'],env);
      return;
    }
  }
  if(output)originalWrite.call(process.stdout,output);
}
async function approveFixtureLogin(home,request,env) {
  const message=env.COMMONS_TEST_BAD_SIGNATURE==='1'?`${request.challenge.message}\n`:request.challenge.message;
  const signature=request.controller.network==='ATTO'?await signAttoMessage(message)
    :upperHex(offchainSign(hexBytes('34F0A37AAD20F4A260F0A5B3CB3D7FB50673212263E58A380BC10474BB039CE4'),message));
  const response={version:1,type:'marketplace-controller-approval-response',profileId:request.profileId,handoffId:request.handoffId,
    requestDigest:approvalRequestDigest(request),challengeId:request.challenge.challengeId,message:request.challenge.message,
    signature,controllerAddress:request.controller.address,controllerIndex:request.controller.index};
  const path=join(home,'approvals',request.profileId,`${request.handoffId}.response.json`);
  await writeFile(path,`${JSON.stringify(response)}\n`,{mode:0o600});await chmod(path,0o600);
}

test('explicit setup prepares a typed login handoff without signing or submitting a session',async()=>{
  // Given a pinned Marketplace challenge and a raw wallet host that must never be called.
  const requests=[];
  const http=await listen(async(req,res)=>{await readBody(req);requests.push(req.url);return json(res,200,loginChallenge());});
  const home=await mkdtemp(join(tmpdir(),'marketplace-explicit-login-'));
  try{
    // When explicit setup begins, it only prepares an immutable typed approval.
    const output=await withoutSetupOutput(()=>runSetupCommand(['--profile','agent','--home',home,'--origin',http.origin,
      '--audience','marketplace','--controller-address',controllerAddress,'--controller-index','7','--mode','controller-session'],
      {MARKETPLACE_MCP_WALLET_HOST_COMMAND:'/never-run-a-raw-signer'}));
    const result=JSON.parse(output.trim());assert.equal(result.status,'approval_required');
    assert.match(result.walletCommand,/^atto-marketplace-mcp approve /);
    // Then no native key store or session endpoint has been reached and --status prints the same owner command.
    assert.deepEqual(requests,['/v1/agent/auth/challenges']);
    const status=JSON.parse((await withoutSetupOutput(()=>runSetupCommand(['--profile','agent','--home',home,'--status'],{}))).trim());
    assert.equal(status.status,'LOGIN_APPROVAL');assert.equal(status.walletCommand,result.walletCommand);
    const store=await MarketplaceProfileStore.open(home);
    try{assert.deepEqual(store.listProfileIds(),[]);}finally{store.close();}
  }finally{await stopSetupServer(http);await rm(home,{recursive:true,force:true});}
});

test('local setup consumes its exact typed login approval and stores only the selected controller-session profile', async () => {
  // Given a pinned loopback Marketplace origin and an explicit controller-session choice.
  const requests=[];
  const http=await listen(async(req,res)=>{
    const body=await readBody(req); requests.push({method:req.method,path:req.url,body,authorization:req.headers.authorization,origin:req.headers.origin});
    if(req.url==='/v1/agent/auth/challenges') return json(res,200,loginChallenge());
    if(req.url==='/v1/agent/auth/sessions') return json(res,200,sessionResponse());
    return json(res,404,{});
  });
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-setup-login-'));
  const signerEnv={...await fakeAttoSigner(home,true), DBUS_SESSION_BUS_ADDRESS:'unix:path=/tmp/fixture-keyring-session',
    XDG_RUNTIME_DIR:'/tmp/fixture-runtime', MARKETPLACE_MCP_BEARER_TOKEN:'never-forward-marketplace-credential'};
  let output='';
  const originalWrite=process.stdout.write;
  process.stdout.write=(chunk,...rest)=>{output+=String(chunk);return true;};
  try {
    // When setup first runs, its private local ATTO signer signs the exact challenge and creates a controller session.
    await runApprovedSetup(['--profile','agent','--home',home,'--origin',http.origin,'--audience','marketplace',
      '--controller-address',controllerAddress,'--controller-index','7','--mode','controller-session'],signerEnv);
    const ready=JSON.parse(output.trim());
    assert.equal(ready.status,'ready');
    assert.equal(ready.controllerNetwork,'ATTO');
    assert.equal(output.includes('access-session-token-secret'),false);
    output='';
    // Then the saved profile retains only the selected controller-session authority.
    await runApprovedSetup(['--profile','agent','--home',home,'--complete'],{});
    const recovered=JSON.parse(output.trim());
    assert.equal(recovered.status,'ready');
    assert.equal(recovered.authMode,'controller-session');
    assert.equal(recovered.accountId,accountId);
    const store=await MarketplaceProfileStore.open(home);
    try {
      const profile=store.getProfile('agent');
      assert.equal(profile.authMode,'controller-session');
      assert.equal(profile.controllerIndex,7);
      assert.equal(profile.accessToken,'access-session-token-secret');
      assert.equal(requests.length,2);
      assert.equal(requests[0].path,'/v1/agent/auth/challenges');
      assert.equal(requests[0].authorization,undefined);
      assert.equal(requests[1].path,'/v1/agent/auth/sessions');
      assert.equal(requests[1].authorization,undefined);
      assert.equal(requests[1].origin,undefined);
    } finally { store.close(); }
    assert.equal(output.includes('access-session-token-secret'),false);
  } finally {
    process.stdout.write=originalWrite;
    http.close(); await rm(home,{recursive:true,force:true});
  }
});

test('setup rejects missing or inconsistent login enrollment metadata before signing', async () => {
  for (const mutate of [
    value => { delete value.accountId; },
    value => { value.controllerId = 'not-a-uuid'; },
    value => { value.accountId = '11111111-1111-4111-8111-111111111199'; },
    value => { value.message = value.message.replace(/Binding Hash: [0-9a-f]{64}\n/, ''); },
  ]) {
    const challenge=loginChallenge(); mutate(challenge);
    const requests=[];
    const http=await listen(async(req,res)=>{ requests.push(req.url); await readBody(req); return json(res,200,challenge); });
    const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-bound-login-reject-'));
    try {
      await assert.rejects(runApprovedSetup(['--profile','rejected','--home',home,'--origin',http.origin,'--audience','marketplace',
        '--controller-address',controllerAddress,'--controller-index','7','--mode','controller-session'],{}));
      assert.deepEqual(requests,['/v1/agent/auth/challenges']);
    } finally { http.close(); await rm(home,{recursive:true,force:true}); }
  }
});

test('definitive signer failures keep the exact login setup retryable without saving tokens', async () => {
  // Given a fresh native-signer LOGIN and a definitive signer failure.
  for (const [status,serverCode,expectedCode] of [
    [503,'signer_unavailable','SIGNER_UNAVAILABLE'],
    [403,'signer_request_rejected','SIGNER_REQUEST_REJECTED'],
  ]) {
    const requests=[];
    let available=false;
    const http=await listen(async(req,res)=>{
      const body=await readBody(req); requests.push({path:req.url,body});
      if(req.url==='/v1/agent/auth/challenges') return json(res,200,loginChallenge());
      if(req.url==='/v1/agent/auth/sessions') return available ? json(res,200,sessionResponse())
        : json(res,status,{error:serverCode,message:'private-signer-diagnostic',details:{proof:'private-proof'}});
      return json(res,404,{});
    });
    const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-setup-signer-retry-'));
    const env=await fakeAttoSigner(home);
    const originalWrite=process.stdout.write;
    let output=''; process.stdout.write=chunk=>{output+=String(chunk);return true;};
    try {
      // When the first LOGIN submission fails at the signer.
      await assert.rejects(runApprovedSetup(['--profile','retryable','--home',home,'--origin',http.origin,'--audience','marketplace',
        '--controller-address',controllerAddress,'--controller-index','7','--mode','controller-session'],env),error=>{
        assert.equal(error.code,expectedCode);
        assert.doesNotMatch(error.message,/private-/);
        return true;
      });
      // Then no profile is saved and the exact pending challenge remains retryable.
      const store=await MarketplaceProfileStore.open(home);
      try {
        assert.equal(store.getSetupState('retryable').state,'LOGIN_APPROVAL');
        assert.deepEqual(store.listProfileIds(),[]);
      } finally { store.close(); }
      available=true;
      await runApprovedSetup(['--profile','retryable','--home',home,'--complete'],env);
      assert.equal(JSON.parse(output.trim()).status,'ready');
      assert.deepEqual(requests.map(request=>request.path),[
        '/v1/agent/auth/challenges','/v1/agent/auth/sessions','/v1/agent/auth/sessions']);
      assert.deepEqual(requests[2].body,requests[1].body);
      assert.doesNotMatch(output,/access-session-token-secret|private-/);
    } finally {
      process.stdout.write=originalWrite;
      http.close(); await rm(home,{recursive:true,force:true});
    }
  }
});

test('stored login approval preserves its exact payload and signed response across definitive signer failure', async () => {
  // Given an existing private typed LOGIN approval that predates headless setup.
  for (const [status,serverCode,expectedCode] of [
    [503,'signer_unavailable','SIGNER_UNAVAILABLE'],
    [403,'signer_request_rejected','SIGNER_REQUEST_REJECTED'],
  ]) {
    const requests=[];
    let available=false;
    const http=await listen(async(req,res)=>{
      const body=await readBody(req); requests.push({path:req.url,body});
      return available ? json(res,200,sessionResponse()) : json(res,status,{error:serverCode});
    });
    const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-stored-login-'));
    const profileId='approved';
    const handoffId='a'.repeat(32);
    const challenge=loginChallenge();
    const request={version:1,type:'marketplace-controller-approval-request',profileId,handoffId,
      marketplaceOrigin:http.origin,transport:'AGENT_API',proofOrigin:null,audience:'marketplace',accountId,identityId,
      controller:{network:'ATTO',address:controllerAddress,index:7},purpose:'login',
      action:{kind:'login',network:'ATTO',address:controllerAddress},
      challenge:{challengeId:challenge.challengeId,message:challenge.message,issuedAt:challenge.issuedAt,expiresAt:challenge.expiresAt}};
    const payload=JSON.stringify({profileId,origin:http.origin,audience:'marketplace',controllerNetwork:'ATTO',
      controllerAddress,controllerIndex:7,mode:'controller-session',request});
    const initial=await MarketplaceProfileStore.open(home);
    try { initial.createSetupState(profileId,'LOGIN_APPROVAL',payload); } finally { initial.close(); }
    await writeApprovalRequest(home,profileId,handoffId,request);
    await writeSignedResponse(home,profileId,handoffId);
    const responsePath=join(home,'approvals',profileId,`${handoffId}.response.json`);
    const originalResponse=await readFile(responsePath,'utf8');
    const originalWrite=process.stdout.write;
    let output=''; process.stdout.write=chunk=>{output+=String(chunk);return true;};
    try {
      // When a definitively rejected submission is resumed with the original saved approval.
      await assert.rejects(runApprovedSetup(['--profile',profileId,'--home',home,'--complete'],{}),error=>error.code===expectedCode);
      const pending=await MarketplaceProfileStore.open(home);
      try {
        assert.equal(pending.getSetupState(profileId).state,'LOGIN_APPROVAL');
        assert.equal(pending.getSetupState(profileId).privatePayload,payload);
        assert.deepEqual(pending.listProfileIds(),[]);
      } finally { pending.close(); }
      available=true;
      await runApprovedSetup(['--profile',profileId,'--home',home,'--complete'],{});

      // Then neither the typed approval nor its exact signed proof changes, and only one profile is saved.
      assert.equal(JSON.parse(output.trim()).status,'ready');
      assert.deepEqual(requests.map(value=>value.path),['/v1/agent/auth/sessions','/v1/agent/auth/sessions']);
      assert.deepEqual(requests[1].body,requests[0].body);
      assert.equal(await readFile(responsePath,'utf8'),originalResponse);
      assert.doesNotMatch(output,/access-session-token-secret|refresh-session-token-secret/);
    } finally {
      process.stdout.write=originalWrite;
      http.close(); await rm(home,{recursive:true,force:true});
    }
  }
});

test('lost malformed and mismatched signer LOGIN responses remain unresolved without another submission', async () => {
  // Given a native-signer LOGIN whose response cannot prove whether a session was issued.
  for (const mode of ['lost','malformed','wrong-signer-pair']) {
    const requests=[];
    const http=await listen(async(req,res)=>{
      await readBody(req); requests.push(req.url);
      if(req.url==='/v1/agent/auth/challenges') return json(res,200,loginChallenge());
      if(mode==='lost') return res.destroy();
      if(mode==='wrong-signer-pair') return json(res,503,{error:'signer_request_rejected'});
      res.writeHead(200,{'content-type':'application/json'}); res.end('{');
    });
    const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-unknown-login-'));
    const env=await fakeAttoSigner(home);
    try {
      // When setup and a subsequent resume encounter that uncertain original request.
      await assert.rejects(runApprovedSetup(['--profile','unknown','--home',home,'--origin',http.origin,'--audience','marketplace',
        '--controller-address',controllerAddress,'--controller-index','7','--mode','controller-session'],env),error=>error.code==='SETUP_UNKNOWN');
      await assert.rejects(runApprovedSetup(['--profile','unknown','--home',home,'--complete'],env),error=>error.code==='SETUP_UNKNOWN');

      // Then no token/profile is stored and no automatic replay crosses the unknown-outcome fence.
      const store=await MarketplaceProfileStore.open(home);
      try {
        assert.equal(store.getSetupState('unknown').state,'LOGIN_UNKNOWN');
        assert.deepEqual(store.listProfileIds(),[]);
      } finally { store.close(); }
      assert.deepEqual(requests,['/v1/agent/auth/challenges','/v1/agent/auth/sessions']);
    } finally { http.close(); await rm(home,{recursive:true,force:true}); }
  }
});

test('setup refuses a session outside its signed enrollment and never saves the returned tokens', async () => {
  const http=await listen(async(req,res)=>{
    await readBody(req);
    if(req.url==='/v1/agent/auth/challenges') return json(res,200,loginChallenge());
    return json(res,200,{...sessionResponse(),identityId:'33333333-3333-4333-8333-333333333399'});
  });
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-bound-session-reject-'));
  try {
    const env=await fakeAttoSigner(home);
    await assert.rejects(runApprovedSetup(['--profile','rejected','--home',home,'--origin',http.origin,'--audience','marketplace',
      '--controller-address',controllerAddress,'--controller-index','7','--mode','controller-session'],env));
    const store=await MarketplaceProfileStore.open(home);
    try { assert.deepEqual(store.listProfileIds(),[]); } finally { store.close(); }
    await assert.rejects(runApprovedSetup(['--profile','rejected','--home',home,'--complete'],env),error=>error.code==='SETUP_UNKNOWN');
  } finally { http.close(); await rm(home,{recursive:true,force:true}); }
});

test('local Nano controller setup consumes the typed NOMS login handoff without calling a raw wallet signer', async () => {
  // Given a pinned Marketplace API and a configured private wallet host with a Nano adapter.
  const nanoAddress='nano_3e3j5tkog48pnny9dmfzj1r16pg8t1e76dz5tmac6iq689wyjfpiij4txtdo';
  const challenge=nanoLoginChallenge(nanoAddress);
  const requests=[];
  const http=await listen(async(req,res)=>{
    const body=await readBody(req); requests.push({path:req.url,body});
    if(req.url==='/v1/agent/auth/challenges') return json(res,200,challenge);
    if(req.url==='/v1/agent/auth/sessions') return json(res,200,sessionResponse());
    return json(res,404,{});
  });
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-setup-nano-'));
  const signerEnv=await fakeNanoSigner(home,{origin:http.origin,address:nanoAddress,index:19,message:challenge.message});
  let output=''; const originalWrite=process.stdout.write;
  process.stdout.write=(chunk,...rest)=>{output+=String(chunk);return true;};
  try {
    // When the profile selects NANO, the signer receives only the exact proof context and no private key material.
    await runApprovedSetup(['--profile','nano-agent','--home',home,'--origin',http.origin,'--audience','marketplace',
      '--controller-network','NANO','--controller-address',nanoAddress,'--controller-index','19','--mode','controller-session'],signerEnv);
    const ready=JSON.parse(output.trim());
    assert.equal(ready.status,'ready');
    assert.equal(ready.controllerNetwork,'NANO');
    assert.equal(requests[0].body.network,'NANO');
    assert.equal(requests[0].body.address,nanoAddress);
    assert.equal(requests[1].body.message,challenge.message);
    assert.equal(requests[1].body.signature,upperHex(offchainSign(hexBytes('34F0A37AAD20F4A260F0A5B3CB3D7FB50673212263E58A380BC10474BB039CE4'),challenge.message)));
    assert.equal((await readdir(home)).includes('approvals'),true);

    // Then the durable local profile remembers the selected Nano controller identity and index.
    const store=await MarketplaceProfileStore.open(home);
    try {
      const profile=store.getProfile('nano-agent');
      assert.equal(profile.controllerNetwork,'NANO');
      assert.equal(profile.controllerAddress,nanoAddress);
      assert.equal(profile.controllerIndex,19);
    } finally { store.close(); }
  } finally {
    process.stdout.write=originalWrite;
    http.close(); await rm(home,{recursive:true,force:true});
  }
});

for(const network of ['ATTO','NANO'])test(`${network} scoped setup signs a fresh credential grant and stores the one-time key without output`, async () => {
  const selectedAddress=network==='ATTO'?controllerAddress:'nano_3e3j5tkog48pnny9dmfzj1r16pg8t1e76dz5tmac6iq689wyjfpiij4txtdo';
  const nativeChallenge=(purpose,binding)=>{
    if(network==='ATTO')return agentChallenge(purpose,binding);
    const challenge=nanoLoginChallenge(selectedAddress);
    challenge.message=challenge.message.replace('Purpose: login',`Purpose: ${purpose}`).replace(hash(['signer-controller-enrollment-v1',accountId,identityId]),binding);
    return challenge;
  };
  // Given a first-time profile that explicitly selects one small scoped API grant.
  const apiKeyId='44444444-4444-4444-8444-444444444444';
  const requests=[];
  const http=await listen(async(req,res)=>{
    const body=await readBody(req); requests.push({method:req.method,path:req.url,body,authorization:req.headers.authorization,origin:req.headers.origin});
    if(req.url==='/v1/agent/auth/challenges') return json(res,200,network==='ATTO'?loginChallenge():nanoLoginChallenge(selectedAddress));
    if(req.url==='/v1/agent/auth/sessions') return json(res,200,sessionResponse());
    if(req.url==='/v1/agent/credentials/challenges') {
      const command=body;
      const value=command.credential;
      const payload=['agent-credential-v2',value.name,String(value.expiresInDays),[...value.scopes].sort().join(','),'','','',''].join('\n');
      const binding=hash(['agent-credential-v1',accountId,identityId,'CREATE','',command.idempotencyKey,payload]);
      return json(res,200,nativeChallenge('API-key creation',binding));
    }
    if(req.url==='/v1/agent/credentials'&&req.method==='POST') return json(res,201,{apiKeyId,result:'created',replayed:false,apiKey:'new-private-scoped-api-key'});
    return json(res,404,{});
  });
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-setup-scoped-'));
  const signerEnv=await fakeAttoSigner(home);
  let output='';
  const originalWrite=process.stdout.write;
  process.stdout.write=(chunk,...rest)=>{output+=String(chunk);return true;};
  try {
    await runApprovedSetup(['--profile','agent','--home',home,'--origin',http.origin,'--audience','marketplace',
      '--controller-network',network,'--controller-address',selectedAddress,'--controller-index','0','--mode','scoped-api-key',
      '--credential-name','minimal worker','--scope','tasks:read'],signerEnv);
    const keyApproval=JSON.parse(output.trim());
    assert.equal(keyApproval.status,'approval_required');
    assert.equal(output.includes('access-session-token-secret'),false);
    await writeSignedResponse(home,'agent',keyApproval.handoffId);
    output='';

    // When the second exact proof is submitted, setup stores a strict scoped profile with no session fallback.
    await runApprovedSetup(['--profile','agent','--home',home,'--complete'],{});
    const ready=JSON.parse(output.trim());
    assert.equal(ready.status,'ready');
    assert.equal(ready.authMode,'scoped-api-key');
    assert.equal(ready.apiKeyId,apiKeyId);
    assert.deepEqual(ready.scopes,['tasks:read']);
    assert.equal(output.includes('new-private-scoped-api-key'),false);
    assert.equal(output.includes('access-session-token-secret'),false);
    const store=await MarketplaceProfileStore.open(home);
    try {
      const profile=store.getProfile('agent');
      assert.equal(profile.authMode,'scoped-api-key');
      assert.equal(profile.apiKey,'new-private-scoped-api-key');
      assert.equal(profile.accessToken,null);
      assert.deepEqual(profile.apiScopes,['tasks:read']);
      assert.equal(requests.filter(r=>r.path==='/v1/agent/auth/sessions').length,1);
      assert.equal(requests.find(r=>r.path==='/v1/agent/credentials/challenges').authorization,'Bearer access-session-token-secret');
      const proof=requests.find(r=>r.path==='/v1/agent/credentials'&&r.method==='POST').body.proof;
      assert.equal(proof.signature,network==='ATTO'?await signAttoMessage(proof.message):upperHex(offchainSign(hexBytes('34F0A37AAD20F4A260F0A5B3CB3D7FB50673212263E58A380BC10474BB039CE4'),proof.message)));
      assert.equal(profile.controllerNetwork,network);
      assert.equal(requests.find(r=>r.path==='/v1/agent/credentials'&&r.method==='POST').origin,undefined);
    } finally { store.close(); }
  } finally {
    process.stdout.write=originalWrite;
    http.close(); await rm(home,{recursive:true,force:true});
  }
});

test('scoped setup accepts and privately stores separate product publication reservation ceilings',async()=>{
  // Given a new scoped profile whose product-publish authority has explicit ATTO and XNO limits.
  const apiKeyId='55555555-aaaa-4aaa-8aaa-555555555555';
  const credential={name:'seller publisher',expiresInDays:90,scopes:['products:publish'],
    productPublishAttoLimit:'20',productPublishXnoLimit:'30'};
  const requests=[];
  const http=await listen(async(req,res)=>{
    const body=await readBody(req);requests.push({method:req.method,path:req.url,body,authorization:req.headers.authorization});
    if(req.url==='/v1/agent/auth/challenges') return json(res,200,loginChallenge());
    if(req.url==='/v1/agent/auth/sessions') return json(res,200,sessionResponse());
    if(req.url==='/v1/agent/credentials/challenges') {
      const value=body.credential;
      const payload=['agent-credential-v4',value.name,String(value.expiresInDays),[...value.scopes].sort().join(','),
        value.publishAttoLimit??'',value.publishXnoLimit??'',value.applyAttoLimit??'',value.applyXnoLimit??'',
        value.purchaseAttoLimit??'',value.purchaseXnoLimit??'',value.productPublishAttoLimit??'',
        value.productPublishXnoLimit??''].join('\n');
      const binding=hash(['agent-credential-v1',accountId,identityId,'CREATE','',body.idempotencyKey,payload]);
      return json(res,200,agentChallenge('API-key creation',binding));
    }
    if(req.url==='/v1/agent/credentials'&&req.method==='POST')
      return json(res,201,{apiKeyId,result:'created',replayed:false,apiKey:'private-setup-product-key'});
    return json(res,404,{});
  });
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-setup-product-publish-'));
  const signerEnv=await fakeAttoSigner(home);
  let output='';const originalWrite=process.stdout.write;
  process.stdout.write=(chunk,...rest)=>{output+=String(chunk);return true;};
  try {
    // When setup runs the typed challenge and completes in a separate profile-ready step.
    await runApprovedSetup(['--profile','seller-key','--home',home,'--origin',http.origin,'--audience','marketplace',
      '--controller-address',controllerAddress,'--controller-index','0','--mode','scoped-api-key',
      '--credential-name',credential.name,'--scope','products:publish','--product-publish-atto-limit','20',
      '--product-publish-xno-limit','30'],signerEnv);
    const approval=JSON.parse(output.trim());
    assert.equal(approval.status,'approval_required');
    const setupStore=await MarketplaceProfileStore.open(home);
    let pendingRequest;
    try {pendingRequest=JSON.parse(setupStore.getSetupState('seller-key').privatePayload).request;}
    finally {setupStore.close();}
    assert.deepEqual(pendingRequest.action.command.credential,credential);
    await writeSignedResponse(home,'seller-key',approval.handoffId);
    output='';
    await runApprovedSetup(['--profile','seller-key','--home',home,'--complete'],{});
    const ready=JSON.parse(output.trim());
    assert.equal(ready.status,'ready');
    assert.equal(ready.productPublishAttoLimit,'20');
    assert.equal(ready.productPublishXnoLimit,'30');
    assert.equal(output.includes('private-setup-product-key'),false);
    const profileStore=await MarketplaceProfileStore.open(home);
    try {
      const profile=profileStore.getProfile('seller-key');
      assert.equal(profile.productPublishAttoLimit,'20');
      assert.equal(profile.productPublishXnoLimit,'30');
      assert.equal(requests.find(row=>row.path==='/v1/agent/credentials/challenges').authorization,'Bearer access-session-token-secret');
      assert.deepEqual(requests.find(row=>row.path==='/v1/agent/credentials'&&row.method==='POST').body.credential,credential);
    } finally {profileStore.close();}
  } finally {
    process.stdout.write=originalWrite;http.close();await rm(home,{recursive:true,force:true});
  }
});

test('credential activation creates a separate explicit scoped profile and removes the one-time vault copy', async () => {
  // Given a controller-session profile that privately holds a newly issued one-time API key.
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-setup-activate-'));
  const store=await MarketplaceProfileStore.open(home);
  const apiKeyId='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  try {
    store.createProfile({id:'controller',origin:'https://marketplace.example',audience:'marketplace',accountId,agentId,identityId,
      controllerNetwork:'ATTO',controllerAddress,controllerIndex:9,authMode:'controller-session',
      accessToken:'controller-access-token',accessExpiresAt:Date.now()+60_000,refreshToken:'controller-refresh-token',refreshExpiresAt:Date.now()+120_000});
    store.putIssuedCredential('controller',{apiKeyId,apiKey:'private-scoped-key-value',scopes:['tasks:read'],publishAttoLimit:null,publishXnoLimit:null,applyAttoLimit:null,applyXnoLimit:null});
  } finally { store.close(); }
  let output=''; const originalWrite=process.stdout.write;
  process.stdout.write=(chunk,...rest)=>{output+=String(chunk);return true;};
  try {
    // When local setup activates the key, it creates a new scoped profile and never changes controller authority.
    await runApprovedSetup(['--profile','worker-key','--home',home,'--from-profile','controller','--credential-id',apiKeyId],{});
    const result=JSON.parse(output.trim());
    assert.equal(result.profileId,'worker-key');
    assert.equal(result.authMode,'scoped-api-key');
    assert.equal(output.includes('private-scoped-key-value'),false);
    const reopened=await MarketplaceProfileStore.open(home);
    try {
      assert.equal(reopened.getProfile('controller').authMode,'controller-session');
      assert.equal(reopened.getProfile('worker-key').authMode,'scoped-api-key');
      assert.equal(reopened.getProfile('worker-key').apiKey,'private-scoped-key-value');
      assert.equal(reopened.getProfile('worker-key').accessToken,null);
      assert.throws(()=>reopened.getIssuedCredential('controller',apiKeyId),error=>error.code==='CREDENTIAL_NOT_FOUND');
    } finally { reopened.close(); }
  } finally {
    process.stdout.write=originalWrite;
    await rm(home,{recursive:true,force:true});
  }
});

async function writeSignedResponse(home,profileId,handoffId) {
  const store=await MarketplaceProfileStore.open(home);
  let request;
  try { request=JSON.parse(store.getSetupState(profileId).privatePayload).request; }
  finally { store.close(); }
  const response={version:1,type:'marketplace-controller-approval-response',profileId,handoffId,
    requestDigest:approvalRequestDigest(request),challengeId:request.challenge.challengeId,message:request.challenge.message,
    signature:request.controller.network==='ATTO'?await signAttoMessage(request.challenge.message):upperHex(offchainSign(hexBytes('34F0A37AAD20F4A260F0A5B3CB3D7FB50673212263E58A380BC10474BB039CE4'),request.challenge.message)),controllerAddress:request.controller.address,controllerIndex:request.controller.index};
  const path=join(home,'approvals',profileId,`${handoffId}.response.json`);
  await writeFile(path,`${JSON.stringify(response)}\n`,{mode:0o600});
  await chmod(path,0o600);
}

test('local setup rejects an invalid ATTO signature before session submission and keeps the exact login retryable', async () => {
  const challenge=loginChallenge();
  const requests=[];
  const http=await listen(async(req,res)=>{
    const body=await readBody(req); requests.push({path:req.url,body});
    if(req.url==='/v1/agent/auth/challenges') return json(res,200,challenge);
    if(req.url==='/v1/agent/auth/sessions') return json(res,200,sessionResponse());
    return json(res,404,{});
  });
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-setup-invalid-signature-'));
  const signerEnv=await fakeAttoSigner(home);
  let output=''; const originalWrite=process.stdout.write;
  process.stdout.write=(chunk,...rest)=>{output+=String(chunk);return true;};
  try {
    const args=['--profile','retryable','--home',home,'--origin',http.origin,'--audience','marketplace',
      '--controller-address',controllerAddress,'--controller-index','7','--mode','controller-session'];
    await assert.rejects(runApprovedSetup(args,{...signerEnv,COMMONS_TEST_BAD_SIGNATURE:'1'}),error=>error.code==='APPROVAL_FILE');
    assert.deepEqual(requests.map(value=>value.path),['/v1/agent/auth/challenges']);
    const pending=await MarketplaceProfileStore.open(home);
    try { assert.equal(pending.getSetupState('retryable').state,'LOGIN_APPROVAL'); }
    finally { pending.close(); }

    // The corrected signer retries the same saved challenge without requesting or submitting a replacement proof.
    await runApprovedSetup(['--profile','retryable','--home',home,'--complete'],signerEnv);
    assert.equal(JSON.parse(output.trim()).status,'ready');
    assert.deepEqual(requests.map(value=>value.path),['/v1/agent/auth/challenges','/v1/agent/auth/sessions']);
    assert.equal(requests[1].body.message,challenge.message);
    assert.equal(requests[1].body.signature,await signAttoMessage(challenge.message));
  } finally {
    process.stdout.write=originalWrite;
    http.close(); await rm(home,{recursive:true,force:true});
  }
});

function loginChallenge() { return agentChallenge('login',hash(['signer-controller-enrollment-v1',accountId,identityId])); }
function nanoLoginChallenge(address) {
  const challengeId='55555555-5555-4555-8555-555555555555';
  const issuedAt=new Date(Date.now()-1000).toISOString(); const expiresAt=new Date(Date.now()+120_000).toISOString();
  const message=`Nano Marketplace Agent Controller Proof v1\nAudience: marketplace\nNetwork: nano:dev\nAddress: ${address}\nPurpose: login\nRequest ID: ${challengeId}\nBinding Hash: ${hash(['signer-controller-enrollment-v1',accountId,identityId])}\nNonce: ${'b'.repeat(64)}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`;
  return {challengeId,message,issuedAt,expiresAt,accountId,controllerId:identityId};
}
function agentChallenge(purpose,bindingHash) {
  const id=purpose==='login'?'22222222-2222-4222-8222-222222222223':'33333333-3333-4333-8333-333333333334';
  const issuedAt=new Date(Date.now()-1000).toISOString(); const expiresAt=new Date(Date.now()+120_000).toISOString();
  const message=`Marketplace Agent Controller Proof v1\nAudience: marketplace\nNetwork: live\nAddress: ${controllerAddress}\nPurpose: ${purpose}\nRequest ID: ${id}\n${bindingHash?`Binding Hash: ${bindingHash}\n`:''}Nonce: ${'a'.repeat(64)}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`;
  return {challengeId:id,message,issuedAt,expiresAt,...(purpose==='login'?{accountId,controllerId:identityId}:{})};
}
function sessionResponse() {return {accountId,agentId,identityId,accessToken:'access-session-token-secret',accessExpiresAt:new Date(Date.now()+120_000).toISOString(),
  refreshToken:'refresh-session-token-secret',refreshExpiresAt:new Date(Date.now()+240_000).toISOString()};}
function hash(lines){return createHash('sha256').update(lines.join('\n'),'utf8').digest('hex');}
async function signAttoMessage(message) {
  return (await controllerSigner.signMessage(Int8Array.from(Buffer.from(message,'utf8')))).toString();
}
async function listen(handler) {
  const server=createServer((req,res)=>{void Promise.resolve(handler(req,res)).catch(()=>{if(!res.destroyed)json(res,500,{});});});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  return Object.assign(server,{origin:`http://127.0.0.1:${server.address().port}`});
}
async function readBody(request){let value='';for await(const chunk of request)value+=chunk;return value?JSON.parse(value):null;}
function json(res,status,body){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));}

test('Unix configured JavaScript host paths preserve their executable interpreter options', {skip:process.platform==='win32'}, async t=>{
  // Given an executable .js host whose shebang supplies a required Node condition.
  const home=await mkdtemp(join(tmpdir(),'marketplace-executable-host-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const env=await fakeAttoSigner(home);
  const {callWallet}=await import(pathToFileURL(join(packageDirectory,'dist/wallet-process.js')).href);
  const message='Synthetic exact controller proof';
  // When the configured host is launched through the real private stdio boundary.
  const result=await callWallet(env,{asset:'ATTO',operation:'controller.sign',input:{index:7,message}});
  // Then its interpreter option is retained and the expected fixture key signs the exact request.
  assert.equal(result.address,controllerAddress);
  assert.equal(result.signature,await signAttoMessage(message));
});

async function fakeAttoSigner(home, requireKeyringSession=false) {
  const walletDir=join(home,'atto-wallet');
  await mkdir(walletDir,{mode:0o700});
  const serverFile=join(home,'fake-atto-wallet.mjs');
  const serverModule=pathToFileURL(require.resolve('@modelcontextprotocol/server')).href;
  const stdioModule=pathToFileURL(require.resolve('@modelcontextprotocol/server/stdio')).href;
  const zodModule=pathToFileURL(require.resolve('zod')).href;
  const commonsModule=pathToFileURL(require.resolve('@attocash/commons-core')).href;
  await writeFile(serverFile,`
    const [{McpServer},{StdioServerTransport},{z},{AttoPrivateKey}]=await Promise.all([
      import(${JSON.stringify(serverModule)}),import(${JSON.stringify(stdioModule)}),import(${JSON.stringify(zodModule)}),
      import(${JSON.stringify(commonsModule)})]);
    if (${requireKeyringSession} && (process.env.DBUS_SESSION_BUS_ADDRESS !== 'unix:path=/tmp/fixture-keyring-session'
      || process.env.XDG_RUNTIME_DIR !== '/tmp/fixture-runtime' || process.env.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR !== ${JSON.stringify(walletDir)} || process.env.MARKETPLACE_MCP_BEARER_TOKEN !== undefined)) process.exit(9);
    const signer=await AttoPrivateKey.Companion.parse(${JSON.stringify(testAttoPrivateKey)}).toSigner();
    const server=new McpServer({name:'test-atto-wallet',version:'1.0.0'});
    if(process.argv.slice(2).length!==0)process.exit(8);
    if(process.platform!=='win32'&&!process.execArgv.includes('--conditions=marketplace-fixture'))process.exit(7);
    server.registerTool('wallet_call',{inputSchema:{asset:z.literal('ATTO'),operation:z.literal('controller.sign'),
      input:z.strictObject({index:z.number().int(),message:z.string()})}},async ({input:{index,message}})=>{
      const messageToSign=process.env.COMMONS_TEST_BAD_SIGNATURE==='1'?message+String.fromCharCode(10):message;
      const signature=await signer.signMessage(Int8Array.from(Buffer.from(messageToSign,'utf8')));
      return {content:[{type:'text',text:'signed'}],structuredContent:{result:{index,address:${JSON.stringify(controllerAddress)},
        publicKey:signer.publicKey.toString(),signature:signature.toString()}}};
    });
    await server.connect(new StdioServerTransport());
  `,{mode:0o600});
  let command=serverFile;
  if(process.platform!=='win32') {
    command=join(home,'fake-atto-wallet-command.js');
    await writeFile(command,`#!/bin/sh\nexec '${process.execPath}' --conditions=marketplace-fixture '${serverFile}'\n`,{mode:0o700});
  }
  return {MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR:walletDir,MARKETPLACE_MCP_WALLET_HOST_COMMAND:command};
}

async function fakeNanoSigner(home,expected) {
  const script=join(home,'fake-nano-signer.mjs');
  const serverModule=pathToFileURL(require.resolve('@modelcontextprotocol/server')).href;
  const stdioModule=pathToFileURL(require.resolve('@modelcontextprotocol/server/stdio')).href;
  const zodModule=pathToFileURL(require.resolve('zod')).href;
  const protocolModule=import.meta.resolve('@attocash/atto-marketplace-nano-adapter/protocol');
  await writeFile(script,`
    const [{McpServer},{StdioServerTransport},{z},{hexBytes,offchainSign,upperHex}]=await Promise.all([
      import(${JSON.stringify(serverModule)}),import(${JSON.stringify(stdioModule)}),import(${JSON.stringify(zodModule)}),import(${JSON.stringify(protocolModule)})]);
    if(process.argv.slice(2).length!==0)process.exit(2);
    const server=new McpServer({name:'test-shared-nano-wallet',version:'1.0.0'});
    server.registerTool('wallet_call',{inputSchema:{asset:z.literal('XNO'),operation:z.literal('controller.sign'),input:z.record(z.string(),z.unknown())}},
      async ({input:request})=>{
        if(request.origin!==${JSON.stringify(expected.origin)}||request.network!=='nano:dev'||request.address!==${JSON.stringify(expected.address)}
          ||request.index!==${expected.index}||request.audience!=='marketplace'||request.purpose!=='login'
          ||request.message!==${JSON.stringify(expected.message)}
          ||Object.keys(request).sort().join(',')!=='address,audience,index,message,network,origin,purpose') process.exit(3);
        return {content:[{type:'text',text:'signed'}],structuredContent:{result:{signature:upperHex(offchainSign(hexBytes('34F0A37AAD20F4A260F0A5B3CB3D7FB50673212263E58A380BC10474BB039CE4'),request.message))}}};
      });
    await server.connect(new StdioServerTransport());
  `,{mode:0o600});
  let command=script;
  if(process.platform!=='win32') {
    command=join(home,'fake-nano-signer');
    await writeFile(command,`#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`,{mode:0o700});
  }
  return {MARKETPLACE_MCP_WALLET_HOST_COMMAND:command};
}

function reauthProfile(origin, extra={}) {
  return {id:'original',origin,audience:'marketplace',accountId,agentId,identityId,controllerNetwork:'ATTO',
    controllerAddress,controllerIndex:7,authMode:'controller-session',accessToken:'old-access-token-secret',
    accessExpiresAt:Date.now()-1000,refreshToken:'old-refresh-token-secret',refreshExpiresAt:Date.now()-500,...extra};
}
async function withoutSetupOutput(action) {
  let output='';const write=process.stdout.write;process.stdout.write=chunk=>{output+=String(chunk);return true;};
  try{await action();return output;}finally{process.stdout.write=write;}
}
async function stopSetupServer(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}

test('reauthentication preserves original financial recovery and wallet choices after expired or ambiguous refresh',async()=>{
  for(const state of ['expired','unknown']) {
    // Given the original profile with durable financial identity and unusable session credentials.
    const calls=[];const intentId='88888888-8888-4888-8888-888888888888';
    const http=await listen(async(req,res)=>{
      const body=await readBody(req);calls.push({path:req.url,body,bearer:req.headers.authorization});
      if(req.url==='/v1/agent/auth/challenges')return json(res,200,loginChallenge());
      if(req.url==='/v1/agent/auth/sessions')return json(res,200,sessionResponse());
      if(req.url===`/v1/agent/topups/${intentId}`)return json(res,200,{intentId,state:'ACCEPTED',sendHash:'A'.repeat(64)});
      return json(res,404,{});
    });
    const home=await mkdtemp(join(tmpdir(),'marketplace-reauth-preserved-'));
    const env=await fakeAttoSigner(home,true);
    const {saveWalletSelection,readWalletSelection}=await import(pathToFileURL(join(packageDirectory,'dist/wallet-preferences.js')).href);
    const {MarketplaceApiClient}=await import(pathToFileURL(join(packageDirectory,'dist/marketplace-api.js')).href);
    const selection={attoDirectory:env.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR};
    const mutation={profileId:'original',requestId:'77777777-7777-4777-8777-777777777777',operation:'marketplace-fund',target:accountId,requestHash:'retained-funding-terms'};
    let store=await MarketplaceProfileStore.open(home);
    try{
      store.createProfile(reauthProfile(http.origin,state==='unknown'?{refreshExpiresAt:Date.now()+240000}:{}));
      if(state==='unknown'){const attempt=store.beginRefresh('original');store.failRefresh('original',attempt.attemptId);}
      store.beginMutation(mutation,intentId);
      store.putHandoff('original','d'.repeat(32),'funding','retained-hash','PENDING','{"hash":"retained-native-candidate"}',Date.now()+100000);
      store.close();store=undefined;await saveWalletSelection(home,selection);
      // When a fresh login renews this same account/controller instead of creating an alias profile.
      const output=await withoutSetupOutput(()=>runApprovedSetup(['--profile','original','--home',home,'--reauthenticate'],{
        ...env,DBUS_SESSION_BUS_ADDRESS:'unix:path=/tmp/fixture-keyring-session',XDG_RUNTIME_DIR:'/tmp/fixture-runtime'}));
      assert.equal(JSON.parse(output.trim()).status,'ready');assert.doesNotMatch(output,/access-session-token-secret|refresh-session-token-secret/);
      // Then the original journal and wallet selection survive and the original API resource is readable with the new token.
      store=await MarketplaceProfileStore.open(home);
      assert.deepEqual(store.listProfileIds(),['original']);assert.equal(store.needsReauthentication('original'),false);
      assert.equal(store.getProfile('original').accessToken,'access-session-token-secret');
      assert.deepEqual(store.beginMutation(mutation),{state:'PENDING',resultIdentity:intentId});
      assert.equal(store.getHandoff('original','d'.repeat(32)).privatePayload,'{"hash":"retained-native-candidate"}');
      assert.deepEqual(readWalletSelection(home),selection);assert.equal(store.getSetupState('original'),undefined);
      const result=await new MarketplaceApiClient(store,'original').request(`/v1/agent/topups/${intentId}`);
      assert.equal(result.json.intentId,intentId);assert.equal(result.json.state,'ACCEPTED');
      assert.equal(calls.at(-1).bearer,'Bearer access-session-token-secret');
      assert.deepEqual(calls.map(call=>call.path),['/v1/agent/auth/challenges','/v1/agent/auth/sessions',`/v1/agent/topups/${intentId}`]);
    }finally{store?.close();await stopSetupServer(http);await rm(home,{recursive:true,force:true});}
  }
});

test('reauthentication rejects a changed challenge account or controller before requesting a signature',async()=>{
  for(const field of ['accountId','controllerId']){
    // Given a coherent enrollment proof for a different account/controller returned by the server.
    const challenge=loginChallenge();challenge[field]='99999999-9999-4999-8999-999999999999';
    challenge.message=challenge.message.replace(/Binding Hash: [0-9a-f]{64}/,`Binding Hash: ${hash(['signer-controller-enrollment-v1',challenge.accountId,challenge.controllerId])}`);
    const calls=[];const http=await listen(async(req,res)=>{await readBody(req);calls.push(req.url);return json(res,200,challenge);});
    const home=await mkdtemp(join(tmpdir(),'marketplace-reauth-binding-'));let store=await MarketplaceProfileStore.open(home);
    try{
      const original=reauthProfile(http.origin);store.createProfile(original);store.close();store=undefined;
      // When reauthentication obtains that challenge, it stops before invoking any wallet host.
      await assert.rejects(runApprovedSetup(['--profile','original','--home',home,'--reauthenticate'],{}),{code:'PROFILE_CONFLICT'});
      // Then the profile and its fencing state remain untouched.
      store=await MarketplaceProfileStore.open(home);assert.equal(store.getProfile('original').accessToken,original.accessToken);
      assert.equal(store.getProfile('original').refreshState,'READY');assert.equal(store.getSetupState('original'),undefined);
      assert.deepEqual(calls,['/v1/agent/auth/challenges']);
    }finally{store?.close();await stopSetupServer(http);await rm(home,{recursive:true,force:true});}
  }
});

test('reauthentication cannot replace the original identity with a mismatched session response',async()=>{
  // Given a valid challenge followed by a session for a different agent identity.
  const http=await listen(async(req,res)=>{await readBody(req);return json(res,200,req.url.endsWith('challenges')?loginChallenge():{...sessionResponse(),agentId:'99999999-9999-4999-8999-999999999999'});});
  const home=await mkdtemp(join(tmpdir(),'marketplace-reauth-session-binding-'));const env=await fakeAttoSigner(home);let store=await MarketplaceProfileStore.open(home);
  try{
    const original=reauthProfile(http.origin);store.createProfile(original);store.close();store=undefined;
    // When completion checks the immutable saved profile binding.
    await assert.rejects(runApprovedSetup(['--profile','original','--home',home,'--reauthenticate'],env),{code:'PROFILE_CONFLICT'});
    // Then no returned credentials or identity replace the original profile.
    store=await MarketplaceProfileStore.open(home);const profile=store.getProfile('original');
    assert.equal(profile.agentId,agentId);assert.equal(profile.accessToken,original.accessToken);assert.equal(profile.refreshState,'UNKNOWN');
  }finally{store?.close();await stopSetupServer(http);await rm(home,{recursive:true,force:true});}
});

test('lost reauthentication acknowledgement is recovered with a fresh proof in the original profile',async()=>{
  // Given an existing profile and a login session whose first acknowledgement is lost.
  let challenges=0,sessions=0;const messages=[];
  const http=await listen(async(req,res)=>{
    const body=await readBody(req);
    if(req.url.endsWith('challenges')){
      const challenge=loginChallenge();const oldId=challenge.challengeId;
      challenge.challengeId=`66666666-6666-4666-8666-${String(++challenges).padStart(12,'0')}`;
      challenge.message=challenge.message.replace(oldId,challenge.challengeId);return json(res,200,challenge);
    }
    messages.push(body.message);if(++sessions===1)return res.destroy();return json(res,200,sessionResponse());
  });
  const home=await mkdtemp(join(tmpdir(),'marketplace-reauth-lost-'));const env=await fakeAttoSigner(home);let store=await MarketplaceProfileStore.open(home);
  try{
    store.createProfile(reauthProfile(http.origin));store.close();store=undefined;
    const args=['--profile','original','--home',home,'--reauthenticate'];
    await assert.rejects(runApprovedSetup(args,env),{code:'SETUP_UNKNOWN'});
    await assert.rejects(runApprovedSetup(['--profile','original','--home',home,'--complete'],env),{code:'REAUTH_REQUIRED'});
    // When the user explicitly requests a new proof rather than replaying uncertain authentication.
    await withoutSetupOutput(()=>runApprovedSetup(args,env));
    // Then only session credentials change and the two proofs are distinct.
    store=await MarketplaceProfileStore.open(home);assert.deepEqual(store.listProfileIds(),['original']);assert.equal(store.needsReauthentication('original'),false);
    assert.equal(challenges,2);assert.equal(sessions,2);assert.notEqual(messages[0],messages[1]);
  }finally{store?.close();await stopSetupServer(http);await rm(home,{recursive:true,force:true});}
});

test('late refresh and superseded login responses cannot overwrite reauthenticated credentials',async()=>{
  // Given an in-flight old refresh and two explicit local reauthentication attempts.
  const home=await mkdtemp(join(tmpdir(),'marketplace-reauth-ownership-'));const store=await MarketplaceProfileStore.open(home);
  try{
    const original=reauthProfile('https://marketplace.example',{refreshExpiresAt:Date.now()+240000});store.createProfile(original);
    const refresh=store.beginRefresh('original');const first='{"reauthenticate":true,"attempt":"first"}',second='{"reauthenticate":true,"attempt":"second"}';
    store.startReauthentication('original',first,null);assert.equal(store.transitionSetupState('original','LOGIN_READY','LOGIN_SUBMITTING',first,first),true);
    store.startReauthentication('original',second,first);assert.equal(store.transitionSetupState('original','LOGIN_READY','LOGIN_SUBMITTING',second,second),true);
    // When stale failure/success callbacks try to claim the newer attempt.
    assert.equal(store.transitionSetupState('original','LOGIN_SUBMITTING','LOGIN_UNKNOWN',first,first),false);
    const fresh={...original,accessToken:'new-access-token-secret',refreshToken:'new-refresh-token-secret',accessExpiresAt:Date.now()+120000,refreshExpiresAt:Date.now()+240000};
    assert.throws(()=>store.completeReauthentication(fresh,first),{code:'SETUP_BUSY'});
    store.completeReauthentication(fresh,second);
    assert.throws(()=>store.completeRefresh('original',refresh.attemptId,{accessToken:'stale-access-token-secret',refreshToken:'stale-refresh-token-secret',accessExpiresAt:Date.now()+120000,refreshExpiresAt:Date.now()+240000}),{code:'REAUTH_REQUIRED'});
    // Then the new credentials remain intact and the refresh fence is cleared only by the successful login.
    assert.equal(store.getProfile('original').accessToken,fresh.accessToken);assert.equal(store.getProfile('original').refreshState,'READY');assert.equal(store.getSetupState('original'),undefined);
  }finally{store.close();await rm(home,{recursive:true,force:true});}
});

test('reauthentication rejects authority-changing flags and scoped-key profiles before network access',async()=>{
  // Given a scoped profile whose authority must not become a controller session.
  const home=await mkdtemp(join(tmpdir(),'marketplace-reauth-mode-'));const store=await MarketplaceProfileStore.open(home);
  try{
    store.createProfile(reauthProfile('https://marketplace.example',{authMode:'scoped-api-key',apiKey:'scoped-secret-api-key'}));
    // When either authority is changed or the wrong authentication mode is selected.
    await assert.rejects(runApprovedSetup(['--profile','original','--home',home,'--reauthenticate','--origin','https://other.example'],{}),{code:'SETUP_USAGE'});
    await assert.rejects(runApprovedSetup(['--profile','original','--home',home,'--reauthenticate'],{}),{code:'AUTH_MODE'});
    // Then the scoped credential and profile binding remain unchanged.
    assert.equal(store.getProfile('original').authMode,'scoped-api-key');assert.equal(store.getProfile('original').apiKey,'scoped-secret-api-key');assert.equal(store.getSetupState('original'),undefined);
  }finally{store.close();await rm(home,{recursive:true,force:true});}
});

test('a late completed login failure cannot replace a newer submitting reauthentication challenge',async()=>{
  // Given a real first HTTP failure whose completed response is delivered after a newer login starts.
  let challenges=0,sessions=0,releaseFirst,releaseSecond,firstBodyCompletedAt,firstCallbackReleasedAt;
  let firstEntered,secondEntered;const firstWaiting=new Promise(resolve=>firstEntered=resolve),secondWaiting=new Promise(resolve=>secondEntered=resolve);
  const firstCallbackWaiting=new Promise(resolve=>{releaseFirst=()=>{firstCallbackReleasedAt=performance.now();resolve();};});
  const http=await listen(async(req,res)=>{
    await readBody(req);
    if(req.url.endsWith('challenges')){
      const challenge=loginChallenge(),old=challenge.challengeId;
      challenge.challengeId=`55555555-5555-4555-8555-${String(++challenges).padStart(12,'0')}`;
      challenge.message=challenge.message.replace(old,challenge.challengeId);return json(res,200,challenge);
    }
    if(++sessions===1)return json(res,503,{error:'signer_unavailable'});
    releaseSecond=()=>{if(!res.writableEnded&&!res.destroyed)json(res,200,sessionResponse());};secondEntered();
  });
  const home=await mkdtemp(join(tmpdir(),'marketplace-reauth-concurrent-'));const env=await fakeAttoSigner(home);let store=await MarketplaceProfileStore.open(home);
  const originalFetch=globalThis.fetch;let firstResponse=true,first,second;
  globalThis.fetch=async(input,options)=>{
    const hold=firstResponse&&String(input)===`${http.origin}/v1/agent/auth/sessions`&&options?.method==='POST';
    if(hold)firstResponse=false;
    const response=await originalFetch(input,options);
    if(!hold)return response;
    // Finish the real network body within its normal deadline; hold only callback delivery.
    // Keeping the socket pending would make local approval work consume the first request's HTTP budget.
    const body=await response.arrayBuffer();
    assert.equal(response.status,503);assert.deepEqual(JSON.parse(Buffer.from(body).toString('utf8')),{error:'signer_unavailable'});
    firstBodyCompletedAt=performance.now();firstEntered();await firstCallbackWaiting;
    const completed=new Response(body,{status:response.status,statusText:response.statusText,headers:new Headers(response.headers)});
    Object.defineProperty(completed,'url',{value:response.url});return completed;
  };
  try{
    store.createProfile(reauthProfile(http.origin));store.close();store=undefined;
    const args=['--profile','original','--home',home,'--reauthenticate'];
    await withoutSetupOutput(async()=>{
      first=runApprovedSetup(args,env).then(()=>null,error=>error);await firstWaiting;
      assert.equal(Number.isFinite(firstBodyCompletedAt),true);assert.equal(firstCallbackReleasedAt,undefined);
      second=runApprovedSetup(args,env);await secondWaiting;
      store=await MarketplaceProfileStore.open(home);const newer=store.getSetupState('original');store.close();store=undefined;
      assert.equal(newer.state,'LOGIN_SUBMITTING');
      // When the superseded definitive failure is delivered while the newer login is still submitting.
      releaseFirst();assert.equal((await first).code,'SIGNER_UNAVAILABLE');
      assert.ok(firstBodyCompletedAt<=firstCallbackReleasedAt);
      store=await MarketplaceProfileStore.open(home);assert.deepEqual(store.getSetupState('original'),newer);store.close();store=undefined;
      releaseSecond();await second;
    });
    // Then the newer login completes without its challenge or session being overwritten.
    store=await MarketplaceProfileStore.open(home);assert.equal(store.getProfile('original').accessToken,'access-session-token-secret');assert.equal(store.getSetupState('original'),undefined);
  }finally{
    globalThis.fetch=originalFetch;releaseFirst?.();releaseSecond?.();
    await Promise.allSettled([first,second]);store?.close();await stopSetupServer(http);await rm(home,{recursive:true,force:true});
  }
});

test('guided reauthentication keeps the desktop keyring environment and original saved wallet',
  {skip:process.platform!=='linux' && 'Requires the isolated Linux secret-tool and D-Bus environment fixture.'},async()=>{
  // Given a real existing wallet, its original OS credential, and an expired matching Marketplace profile.
  const phrase='abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
  const home=await mkdtemp(join(tmpdir(),'marketplace-guided-reauth-'));
  const directory=join(home,'original-wallet'),stale=join(home,'stale-wallet'),bin=join(home,'bin');
  await mkdir(bin,{mode:0o700});await mkdir(stale,{mode:0o700});
  const {AttoApplication}=await import('../../atto-cli/dist/application/app.js');
  const application=new AttoApplication({directory,secrets:{get:async()=>phrase,set:async()=>{}}});
  let selectedAddress;
  try{
    await application.createWallet(phrase);await application.call('address_derive',{index:7});
    selectedAddress=(await application.call('wallet_status')).addresses.find(address=>address.index===7).address;
  }finally{await application.close();}
  await writeFile(join(bin,'secret-tool'),`#!/bin/sh\n[ "$DBUS_SESSION_BUS_ADDRESS" = 'unix:path=/tmp/fixture-keyring-session' ] || exit 9\n[ "$1" = lookup ] || exit 8\nprintf '%s\\n' '${phrase}'\n`,{mode:0o700});
  const http=await listen(async(req,res)=>{
    await readBody(req);
    const challenge=loginChallenge();challenge.message=challenge.message.replace(controllerAddress,selectedAddress);
    return json(res,200,req.url.endsWith('challenges')?challenge:sessionResponse());
  });
  const {saveWalletSelection,readWalletSelection}=await import(pathToFileURL(join(packageDirectory,'dist/wallet-preferences.js')).href);
  const {runGuidedSetup}=await import(pathToFileURL(join(packageDirectory,'dist/guided-setup.js')).href);
  const descriptors=[process.stdin,process.stderr].map(stream=>Object.getOwnPropertyDescriptor(stream,'isTTY'));
  const originalPath=process.env.PATH,originalBus=process.env.DBUS_SESSION_BUS_ADDRESS;
  process.env.PATH=`${bin}:${originalPath??''}`;process.env.DBUS_SESSION_BUS_ADDRESS='unix:path=/tmp/fixture-keyring-session';
  let store=await MarketplaceProfileStore.open(home);
  try{
    store.createProfile({...reauthProfile(http.origin),controllerAddress:selectedAddress});store.close();store=undefined;
    await saveWalletSelection(home,{attoDirectory:directory});
    for(const stream of [process.stdin,process.stderr])Object.defineProperty(stream,'isTTY',{configurable:true,value:true});
    const questions=[];
    // When reauthentication explicitly approves the exact typed login in the local terminal.
    const output=await withoutSetupOutput(()=>runGuidedSetup(['--home',home,'--profile','original'],{
      ...process.env,MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR:stale},async question=>{
        questions.push(question);return question.includes('Type APPROVE to confirm:')?'APPROVE':'';
      }));
    // Then the actual selected OS key signs the login and the original wallet selection survives.
    assert.match(questions.at(-1),/Type APPROVE to confirm:/);assert.doesNotMatch(output,/access-session-token-secret|refresh-session-token-secret/);
    const ready=JSON.parse(output.trim().split('\n').at(-1));assert.equal(ready.status,'ready');
    assert.equal(ready.mcpServers['atto-marketplace'].env.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR,directory);
    assert.deepEqual(readWalletSelection(home),{attoDirectory:directory});
    store=await MarketplaceProfileStore.open(home);assert.equal(store.needsReauthentication('original'),false);
  }finally{
    [process.stdin,process.stderr].forEach((stream,index)=>{if(descriptors[index])Object.defineProperty(stream,'isTTY',descriptors[index]);else delete stream.isTTY;});
    if(originalPath===undefined)delete process.env.PATH;else process.env.PATH=originalPath;
    if(originalBus===undefined)delete process.env.DBUS_SESSION_BUS_ADDRESS;else process.env.DBUS_SESSION_BUS_ADDRESS=originalBus;
    store?.close();await stopSetupServer(http);await rm(home,{recursive:true,force:true});
  }
});
