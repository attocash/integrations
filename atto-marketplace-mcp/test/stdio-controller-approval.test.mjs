import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AttoPrivateKey } from '@attocash/commons-core';
import { MarketplaceProfileStore } from '../dist/profile-store.js';
import { approvalRequestDigest } from '../dist/approval-files.js';
import { runSetup } from '../dist/setup.js';
import { shellQuote } from '../dist/shell-quote.js';

const accountId='11111111-1111-4111-8111-111111111111';
const agentId='22222222-2222-4222-8222-222222222222';
const identityId='33333333-3333-4333-8333-333333333333';
const controllerSigner=await AttoPrivateKey.Companion.parse('01'.repeat(32)).toSigner();
const controllerAddress=controllerSigner.address.toString();
const serverMain=join(import.meta.dirname,'../dist/main.js');

test('direct application recovery retains its original payload across uncertainty', async () => {
  const tasks=['abababab-abab-4bab-8bab-abababababab','bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc'];
  const ids=['cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd','dededede-dede-4ede-8ede-dededededede'];
  const applications=['efefefef-efef-4fef-8fef-efefefefefef','fafafafa-fafa-4afa-8afa-fafafafafafa'];
  const committed=new Map();
  const requests=[];
  let dropSecond=true;
  const http=await listen(async(req,res)=>{
    const body=await readBody(req); requests.push({method:req.method,path:req.url,body,key:req.headers['idempotency-key']});
    const index=tasks.findIndex(task=>req.url===`/v1/agent/tasks/${task}/applications`);
    if(index>=0 && req.method==='POST') {
      assert.equal(req.headers['idempotency-key'],ids[index]);
      if(!committed.has(tasks[index])) committed.set(tasks[index],applications[index]);
      if(index===1&&dropSecond) {dropSecond=false;req.socket.destroy();return;}
      return json(res,201,{applicationId:committed.get(tasks[index]),taskId:tasks[index],asset:'ATTO',
        amountAtomic:'10',state:'PENDING',version:1,replayed:index===1});
    }
    return json(res,404,{});
  });
  const fixture=await profileHome(http.origin);
  let client=await connect(fixture.home,'agent');
  try {
    const args=index=>({taskId:tasks[index],requestId:ids[index],expectedTaskVersion:1,
      proposal:'Exact work proposal'});
    const created=await client.callTool({name:'marketplace_application_create',arguments:args(0)});
    assert.equal(JSON.parse(contentText(created)).result.applicationId,applications[0]);
    const before=requests.length;
    const replay=await client.callTool({name:'marketplace_application_create',arguments:args(0)});
    const replayResult=JSON.parse(contentText(replay)).result;
    assert.equal(replayResult.recovered,true);
    assert.equal(JSON.parse(replayResult.resultIdentity).applicationId,applications[0]);
    assert.equal(requests.length,before);
    const lost=await client.callTool({name:'marketplace_application_create',arguments:args(1)});
    assert.equal(lost.isError,true);
    assert.equal(committed.get(tasks[1]),applications[1]);
    await client.close();
    client=await connect(fixture.home,'agent');
    const recovered=await client.callTool({name:'marketplace_application_create',arguments:args(1)});
    assert.equal(JSON.parse(contentText(recovered)).result.applicationId,applications[1]);
    const changed=await client.callTool({name:'marketplace_application_create',arguments:{...args(1),proposal:'Changed'}});
    assert.equal(JSON.parse(contentText(changed)).error.code,'IDEMPOTENCY_CONFLICT');
    assert.equal(requests.filter(row=>row.path===`/v1/agent/tasks/${tasks[0]}/applications`).length,1);
    assert.equal(requests.filter(row=>row.path===`/v1/agent/tasks/${tasks[1]}/applications`).length,2);
    assert.equal(committed.size,2);
  } finally {
    await client.close(); http.close(); fixture.store.close(); await rm(fixture.home,{recursive:true,force:true});
  }
});

test('scoped credential creation saves the one-time key privately and never returns its secret through MCP', async () => {
  // Given one controller session and a bounded read-only credential request.
  const requestId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const apiKeyId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const challengeId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const credential={name:'read-only worker',expiresInDays:90,scopes:['tasks:read','applications:read'],
    publishAttoLimit:null,publishXnoLimit:null,};
  const credentialPayload=['marketplace-credential-v1','read-only worker','90','applications:read,tasks:read','','','','','',''].join('\n');
  const binding=hash(['agent-credential-v1',accountId,identityId,'CREATE','',requestId,credentialPayload]);
  const requests=[];
  const http=await listen(async(req,res)=>{
    const body=await readBody(req);
    requests.push({method:req.method,path:req.url,body});
    if(req.url==='/v1/agent/credentials/challenges') return json(res,200,challenge(challengeId,'API-key creation',binding));
    if(req.url==='/v1/agent/credentials'&&req.method==='POST') return json(res,201,{apiKeyId,result:'created',replayed:false,apiKey:'one-time-secret-api-key-value'});
    return json(res,404,{});
  });
  const fixture=await profileHome(http.origin);
  const client=await connect(fixture.home,'agent');
  const args={requestId,credential};
  try {
    // Empty ceiling strings are rejected before challenge acquisition; explicit null keeps empty V2 slots.
    for(const field of ['publishAttoLimit','publishXnoLimit','applyAttoLimit','applyXnoLimit']) {
      const invalid=await client.callTool({name:'marketplace_credentials_create',arguments:{...args,
        credential:{...credential,[field]:''}}});
      assert.equal(invalid.isError,true);
    }
    assert.equal(requests.length,0);

    // When the AI client asks for creation, only the safe one-time approval request is returned.
    const pending=await client.callTool({name:'marketplace_credentials_create',arguments:args});
    const handoff=JSON.parse(contentText(pending)).result;
    const requestPath=join(fixture.home,'approvals','agent',`${handoff.handoffId}.request.json`);
    const request=JSON.parse(await readFile(requestPath,'utf8'));
    assert.equal(request.action.command.operation,'CREATE');
    assert.equal(request.action.command.credential.name,'read-only worker');
    await writeApprovalResponse(requestPath,request);

    // Then the secret is stored in the private profile vault while every MCP result remains redacted.
    const created=await client.callTool({name:'marketplace_credentials_create',arguments:args});
    const result=JSON.parse(contentText(created)).result;
    assert.equal(result.apiKeyId,apiKeyId);
    assert.equal(result.secretSaved,true);
    assert.equal(JSON.stringify(created).includes('one-time-secret-api-key-value'),false);
    assert.equal(fixture.store.getIssuedCredential('agent',apiKeyId).apiKey,'one-time-secret-api-key-value');
    assert.deepEqual(fixture.store.getIssuedCredential('agent',apiKeyId).scopes,['applications:read','tasks:read']);
    const mutation=requests.find(r=>r.path==='/v1/agent/credentials'&&r.method==='POST');
    assert.deepEqual(mutation.body.credential,credential);
    assert.equal(mutation.body.proof.signature,await signAttoMessage(mutation.body.proof.message));
    assert.equal(JSON.stringify(mutation).includes('one-time-secret-api-key-value'),false);
    assert.equal(requests.filter(r=>r.path==='/v1/agent/credentials').length,1);
  } finally {
    await client.close(); http.close(); fixture.store.close(); await rm(fixture.home,{recursive:true,force:true});
  }
});

test('Shop credential grant and purchase ceilings survive private-key storage and activation', async () => {
  // Given a Shop buyer grant with files:read and one explicit ATTO purchase ceiling.
  const requestId='abababab-abab-4bab-8bab-abababababab';
  const apiKeyId='bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc';
  const challengeId='cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
  const credential={name:'shop buyer',expiresInDays:90,scopes:['files:read','products:purchase'],
    purchaseAttoLimit:'900',purchaseXnoLimit:null};
  const payload=['marketplace-credential-v1','shop buyer','90','files:read,products:purchase','','','900','','',''].join('\n');
  const binding=hash(['agent-credential-v1',accountId,identityId,'CREATE','',requestId,payload]);
  const requests=[];
  const http=await listen(async(req,res)=>{
    const body=await readBody(req);
    requests.push({method:req.method,path:req.url,body});
    if(req.url==='/v1/agent/credentials/challenges') return json(res,200,challenge(challengeId,'API-key creation',binding));
    if(req.url==='/v1/agent/credentials'&&req.method==='POST')
      return json(res,201,{apiKeyId,result:'created',replayed:false,apiKey:'private-shop-api-key-value'});
    return json(res,404,{});
  });
  const fixture=await profileHome(http.origin);
  const client=await connect(fixture.home,'agent');
  const args={requestId,credential};
  try {
    // When the controller authorizes the request, the exact new grant is saved in its private credential journal.
    const pending=JSON.parse(contentText(await client.callTool({name:'marketplace_credentials_create',arguments:args}))).result;
    const requestPath=join(fixture.home,'approvals','agent',`${pending.handoffId}.request.json`);
    const request=JSON.parse(await readFile(requestPath,'utf8'));
    assert.deepEqual(request.action.command.credential,credential);
    await writeApprovalResponse(requestPath,request);
    const created=JSON.parse(contentText(await client.callTool({name:'marketplace_credentials_create',arguments:args}))).result;

    // Then both ceilings remain exact through key activation without exposing the one-time key.
    assert.equal(created.apiKeyId,apiKeyId);
    assert.equal(JSON.stringify(created).includes('private-shop-api-key-value'),false);
    const issued=fixture.store.getIssuedCredential('agent',apiKeyId);
    assert.equal(issued.purchaseAttoLimit,'900');
    assert.equal(issued.purchaseXnoLimit,null);
    const mutation=requests.find(row=>row.method==='POST'&&row.path==='/v1/agent/credentials');
    assert.deepEqual(mutation.body.credential,credential);
    assert.equal(mutation.body.proof.signature,await signAttoMessage(mutation.body.proof.message));
    await runSetup(['--profile','shop-worker','--home',fixture.home,'--from-profile','agent','--credential-id',apiKeyId],{});
    const profile=fixture.store.getProfile('shop-worker');
    assert.deepEqual(profile.apiScopes,['files:read','products:purchase']);
    assert.equal(profile.purchaseAttoLimit,'900');
    assert.equal(profile.purchaseXnoLimit,null);
  } finally {
    await client.close(); http.close(); fixture.store.close(); await rm(fixture.home,{recursive:true,force:true});
  }
});

test('Product publication basis ceilings survive private storage and scoped-profile activation',async()=>{
  // Given a product publisher with an explicit cap for both native assets.
  const requestId='cdcdcdcd-1111-4111-8111-cdcdcdcdcdcd';
  const apiKeyId='dededede-2222-4222-8222-dededededede';
  const challengeId='efefefef-3333-4333-8333-efefefefefef';
  const credential={name:'shop publisher',expiresInDays:90,scopes:['products:publish'],
    productPublishAttoLimit:'20',productPublishXnoLimit:'30'};
  const payload=['marketplace-credential-v1','shop publisher','90','products:publish','','','','','20','30'].join('\n');
  const binding=hash(['agent-credential-v1',accountId,identityId,'CREATE','',requestId,payload]);
  const requests=[];
  const http=await listen(async(req,res)=>{
    const body=await readBody(req);
    requests.push({method:req.method,path:req.url,body});
    if(req.url==='/v1/agent/credentials/challenges') return json(res,200,challenge(challengeId,'API-key creation',binding));
    if(req.url==='/v1/agent/credentials'&&req.method==='POST')
      return json(res,201,{apiKeyId,result:'created',replayed:false,apiKey:'private-product-publisher-key'});
    return json(res,404,{});
  });
  const fixture=await profileHome(http.origin);
  const client=await connect(fixture.home,'agent');
  const args={requestId,credential};
  let clientClosed=false;
  let storeClosed=false;
  try {
    // When the controller approves the typed grant and activation copies only the saved authority.
    const pending=JSON.parse(contentText(await client.callTool({name:'marketplace_credentials_create',arguments:args}))).result;
    const requestPath=join(fixture.home,'approvals','agent',`${pending.handoffId}.request.json`);
    const request=JSON.parse(await readFile(requestPath,'utf8'));
    assert.deepEqual(request.action.command.credential,credential);
    await writeApprovalResponse(requestPath,request);
    const created=JSON.parse(contentText(await client.callTool({name:'marketplace_credentials_create',arguments:args}))).result;
    assert.equal(created.apiKeyId,apiKeyId);
    assert.equal(JSON.stringify(created).includes('private-product-publisher-key'),false);
    const issued=fixture.store.getIssuedCredential('agent',apiKeyId);
    assert.equal(issued.productPublishAttoLimit,'20');
    assert.equal(issued.productPublishXnoLimit,'30');
    const post=requests.find(row=>row.method==='POST'&&row.path==='/v1/agent/credentials');
    assert.deepEqual(post.body.credential,credential);
    assert.equal(post.body.proof.signature,await signAttoMessage(post.body.proof.message));

    await client.close();clientClosed=true;
    fixture.store.close();storeClosed=true;
    let activationOutput='';const originalWrite=process.stdout.write;
    process.stdout.write=(chunk,...rest)=>{activationOutput+=String(chunk);return true;};
    try {await runSetup(['--profile','shop-publisher','--home',fixture.home,'--from-profile','agent','--credential-id',apiKeyId],{});}
    finally {process.stdout.write=originalWrite;}
    assert.equal(JSON.stringify(activationOutput).includes('private-product-publisher-key'),false);
    const reopened=await MarketplaceProfileStore.open(fixture.home);storeClosed=false;
    try {
      const profile=reopened.getProfile('shop-publisher');
      assert.deepEqual(profile.apiScopes,['products:publish']);
      assert.equal(profile.productPublishAttoLimit,'20');
      assert.equal(profile.productPublishXnoLimit,'30');
    } finally {reopened.close();storeClosed=true;}
  } finally {
    if(!clientClosed) await client.close();
    if(!storeClosed) fixture.store.close();
    http.close();await rm(fixture.home,{recursive:true,force:true});
  }
});

test('credential rotation preserves backend grants through explicit activation and scoped restart', async () => {
  const oldId='11111111-2222-4111-8111-111111111111';
  const newId='22222222-3333-4222-8222-222222222222';
  const requestId='33333333-4444-4333-8333-333333333333';
  const secret='rotated-private-api-key-secret';
  const grant={scopes:['tasks:read','tasks:publish','applications:apply'],publishAttoLimit:'100',
    publishXnoLimit:null,};
  const metadata={apiKeyId:oldId,agentId,name:'bounded worker',prefix:'safe-prefix',...grant,
    createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+90*86_400_000).toISOString(),revokedAt:null};
  const requests=[];
  const http=await listen(async(req,res)=>{
    const body=await readBody(req);
    requests.push({method:req.method,path:req.url,authorization:req.headers.authorization,body});
    if(req.url==='/v1/agent/credentials'&&req.method==='GET') return json(res,200,[metadata]);
    if(req.url==='/v1/agent/credentials/challenges') return json(res,200,challenge(
      '44444444-5555-4444-8444-444444444444','API-key rotation',
      hash(['agent-credential-v1',accountId,identityId,'ROTATE',oldId,requestId,''])));
    if(req.url===`/v1/agent/credentials/${oldId}/rotate`&&req.method==='POST')
      return json(res,201,{apiKeyId:newId,result:'rotated',replayed:false,apiKey:secret});
    if(req.url==='/v1/agent/tasks'&&req.method==='GET') return json(res,200,[]);
    if(req.url==='/v1/agent/tasks/55555555-6666-4555-8555-555555555555'&&req.method==='GET')
      return json(res,200,{asset:'ATTO',grossAtomic:'101'});
    if(req.url==='/v1/agent/tasks/99999999-aaaa-4999-8999-999999999999'&&req.method==='GET')
      return json(res,200,{asset:'ATTO',grossAtomic:'75'});
    if(req.url==='/v1/agent/tasks/99999999-aaaa-4999-8999-999999999999/publish'&&req.method==='POST')
      return json(res,200,{taskId:'99999999-aaaa-4999-8999-999999999999',state:'OPEN'});
    if(req.url==='/v1/agent/tasks/aaaaaaaa-bbbb-4aaa-8aaa-aaaaaaaaaaaa/applications'&&req.method==='POST')
      return json(res,201,{applicationId:'bbbbbbbb-cccc-4bbb-8bbb-bbbbbbbbbbbb',
        taskId:'aaaaaaaa-bbbb-4aaa-8aaa-aaaaaaaaaaaa',asset:'ATTO',amountAtomic:'30',state:'PENDING',version:1});
    if(req.url==='/v1/agent/tasks/77777777-8888-4777-8777-777777777777'&&req.method==='GET')
      return json(res,200,{asset:'ATTO',grossAtomic:'60'});
    if(req.url==='/v1/agent/tasks/77777777-8888-4777-8777-777777777777/applications'&&req.method==='POST')
      return json(res,201,{applicationId:'cccccccc-dddd-4ccc-8ccc-cccccccccccc',
        taskId:'77777777-8888-4777-8777-777777777777',asset:'ATTO',amountAtomic:'60',state:'PENDING',version:1});
    return json(res,404,{});
  });
  const fixture=await profileHome(http.origin);
  const controller=await connect(fixture.home,'agent');
  let controllerClosed=false;
  let storeClosed=false;
  try {
    const args={requestId,apiKeyId:oldId};
    const pending=JSON.parse(contentText(await controller.callTool({name:'marketplace_credentials_rotate',arguments:args}))).result;
    assert.equal(pending.status,'approval_required');
    const requestPath=join(fixture.home,'approvals','agent',`${pending.handoffId}.request.json`);
    await writeApprovalResponse(requestPath,JSON.parse(await readFile(requestPath,'utf8')));
    const rotated=await controller.callTool({name:'marketplace_credentials_rotate',arguments:args});
    assert.equal(JSON.parse(contentText(rotated)).result.apiKeyId,newId);
    assert.equal(JSON.stringify(rotated).includes(secret),false);
    assert.deepEqual(fixture.store.getIssuedCredential('agent',newId).scopes,[...grant.scopes].sort());
    assert.equal(fixture.store.getIssuedCredential('agent',newId).publishAttoLimit,'100');
    await controller.close(); controllerClosed=true;
    fixture.store.close(); storeClosed=true;
    let output='';
    const originalWrite=process.stdout.write;
    process.stdout.write=(chunk,...rest)=>{output+=String(chunk);return true;};
    try { await runSetup(['--profile','worker-rotated','--home',fixture.home,'--from-profile','agent','--credential-id',newId],{}); }
    finally { process.stdout.write=originalWrite; }
    assert.equal(JSON.stringify(output).includes(secret),false);
    const reopened=await MarketplaceProfileStore.open(fixture.home);
    try {
      const profile=reopened.getProfile('worker-rotated');
      assert.deepEqual(profile.apiScopes,[...grant.scopes].sort());
      assert.equal(profile.publishAttoLimit,'100');
      assert.equal(profile.apiKey,secret);
      const worker=await connect(fixture.home,'worker-rotated');
      try {
        const allowed=await worker.callTool({name:'marketplace_tasks_list',arguments:{}});
        assert.deepEqual(JSON.parse(contentText(allowed)).result,[]);
        const allowedPublish=await worker.callTool({name:'marketplace_task_publish',arguments:{
          taskId:'99999999-aaaa-4999-8999-999999999999',requestId:'cccccccc-dddd-4ccc-8ccc-cccccccccccc',expectedVersion:0}});
        assert.equal(JSON.parse(contentText(allowedPublish)).result.state,'OPEN');
        const allowedApply=await worker.callTool({name:'marketplace_application_create',arguments:{
          taskId:'aaaaaaaa-bbbb-4aaa-8aaa-aaaaaaaaaaaa',requestId:'dddddddd-eeee-4ddd-8ddd-dddddddddddd',
          expectedTaskVersion:0,proposal:'Within retained grant'}});
        assert.equal(JSON.parse(contentText(allowedApply)).result.taskId,'aaaaaaaa-bbbb-4aaa-8aaa-aaaaaaaaaaaa');
        const publish=await worker.callTool({name:'marketplace_task_publish',arguments:{
          taskId:'55555555-6666-4555-8555-555555555555',requestId:'66666666-7777-4666-8666-666666666666',expectedVersion:0}});
        assert.equal(JSON.parse(contentText(publish)).error.code,'CEILING_EXCEEDED');
        const apply=await worker.callTool({name:'marketplace_application_create',arguments:{
          taskId:'77777777-8888-4777-8777-777777777777',requestId:'dddddddd-eeee-4ddd-8ddd-ddddddddddde',
          expectedTaskVersion:0,proposal:'Free application'}});
        assert.equal(JSON.parse(contentText(apply)).result.taskId,'77777777-8888-4777-8777-777777777777');
        assert.equal(requests.filter(row=>row.method==='POST'&&row.path.includes('/publish')).length,1);
        assert.equal(requests.filter(row=>row.method==='POST'&&row.path.includes('/applications')).length,2);
        assert.ok(requests.some(row=>row.path==='/v1/agent/tasks'&&row.authorization===`Bearer ${secret}`));
      } finally { await worker.close(); }
    } finally { reopened.close(); }
  } finally {
    if(!controllerClosed) await controller.close();
    if(!storeClosed) fixture.store.close();
    http.close(); await rm(fixture.home,{recursive:true,force:true});
  }
});

test('lost credential-create response reconciles metadata without activating an unrecoverable one-time key', async () => {
  // Given a protected credential create whose committed response is lost after Marketplace stores only metadata.
  const requestId='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const apiKeyId='ffffffff-ffff-4fff-8fff-ffffffffffff';
  const challengeId='12121212-1212-4212-8212-121212121212';
  const oneTimeKey='one-time-key-lost-with-response';
  const credential={name:'lost-response worker',expiresInDays:90,scopes:['tasks:read']};
  const credentialPayload=['marketplace-credential-v1','lost-response worker','90','tasks:read','','','','','',''].join('\n');
  const binding=hash(['agent-credential-v1',accountId,identityId,'CREATE','',requestId,credentialPayload]);
  const requests=[];
  let committedKey=null;
  const metadata={apiKeyId,agentId,name:credential.name,prefix:'safe-prefix',scopes:['tasks:read'],publishAttoLimit:null,
    publishXnoLimit:null,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+90*86_400_000).toISOString(),revokedAt:null};
  const http=await listen(async(req,res)=>{
    const body=await readBody(req);
    requests.push({method:req.method,path:req.url,body});
    if(req.url==='/v1/agent/credentials/challenges') return json(res,200,challenge(challengeId,'API-key creation',binding));
    if(req.url==='/v1/agent/credentials'&&req.method==='POST') {
      assert.equal(body.credential.name,credential.name);
      // The fixture models Marketplace committing before the response connection is lost.
      committedKey=oneTimeKey;
      res.destroy();
      return;
    }
    if(req.url==='/v1/agent/credentials'&&req.method==='GET') return json(res,200,[metadata]);
    return json(res,404,{});
  });
  const fixture=await profileHome(http.origin);
  const client=await connect(fixture.home,'agent');
  const args={requestId,credential};
  try {
    // When the first approved create loses its response, MCP records an unknown outcome and never claims the key was saved.
    const pending=await client.callTool({name:'marketplace_credentials_create',arguments:args});
    const handoff=JSON.parse(contentText(pending)).result;
    const requestPath=join(fixture.home,'approvals','agent',`${handoff.handoffId}.request.json`);
    const request=JSON.parse(await readFile(requestPath,'utf8'));
    await writeApprovalResponse(requestPath,request);
    const lost=await client.callTool({name:'marketplace_credentials_create',arguments:args});
    assert.equal(lost.isError,true);
    assert.equal(JSON.parse(contentText(lost)).error.code,'MUTATION_UNKNOWN');
    assert.equal(committedKey,oneTimeKey);
    assert.equal(JSON.stringify(lost).includes(oneTimeKey),false);

    // Then same-request recovery points only to metadata; the key is absent from the local vault and cannot be activated.
    const recovery=await client.callTool({name:'marketplace_credentials_create',arguments:args});
    const state=JSON.parse(contentText(recovery)).result;
    assert.equal(state.status,'unknown');
    assert.equal(state.reconciliationTool,'marketplace_credentials_list');
    assert.equal(state.credentialName,credential.name);
    assert.match(state.next,/cannot be retrieved or activated from metadata/);
    assert.equal(JSON.stringify(recovery).includes(oneTimeKey),false);
    const listed=await client.callTool({name:'marketplace_credentials_list',arguments:{}});
    const keys=JSON.parse(contentText(listed)).result;
    assert.equal(keys[0].apiKeyId,apiKeyId);
    assert.equal(JSON.stringify(listed).includes(oneTimeKey),false);
    assert.throws(()=>fixture.store.getIssuedCredential('agent',apiKeyId),error=>error.code==='CREDENTIAL_NOT_FOUND');
    assert.equal(requests.filter(value=>value.method==='POST'&&value.path==='/v1/agent/credentials').length,1);
    assert.equal(requests.filter(value=>value.path==='/v1/agent/credentials/challenges').length,1);
  } finally {
    await client.close(); http.close(); fixture.store.close(); await rm(fixture.home,{recursive:true,force:true});
  }
});

test('task minimum rejection guides versioned correction and a fresh publish request without leaking backend text', async () => {
  // Given actual stdio clients for both supported assets and a fixture that persists terminal rejections.
  const cases=[
    {asset:'ATTO',minimum:'1000000000',taskId:'11111111-1111-4111-8111-111111111111',requestId:'77777777-7777-4777-8777-777777777777',updateRequestId:'13131313-1313-4131-8131-131313131313',mode:'http'},
    {asset:'XNO',minimum:'10000000000000000000000000000',taskId:'22222222-2222-4222-8222-222222222222',requestId:'88888888-8888-4888-8888-888888888888',updateRequestId:'24242424-2424-4242-8242-242424242424',mode:'http'},
  ];
  const privateMarker='backend-private-minimum-message';
  const tasks=new Map(cases.map(value=>[value.taskId.toLowerCase(),{taskId:value.taskId.toLowerCase(),asset:value.asset,
    grossAtomic:(BigInt(value.minimum)-1n).toString(),state:'DRAFT',version:0,
    legacyShape:value.mode.startsWith('legacy-')?value.mode.slice('legacy-'.length):undefined}]));
  for(const [taskId,asset] of [['44444444-4444-4444-8444-444444444444','ATTO'],
    ['55555555-5555-4555-8555-555555555555','ATTO']]) {
    tasks.set(taskId,{taskId,asset,grossAtomic:'1000000000',state:'DRAFT',version:0});
  }
  const rejected=new Map();
  const commands=new Map();
  const requests=[];
  const counts={oldPublish:0,status:0,holds:0};
  const http=await listen(async(req,res)=>{
    const body=await readBody(req);
    const url=new URL(req.url??'/', 'http://marketplace.test');
    requests.push({method:req.method,path:req.url,body,authorization:req.headers.authorization,
      idempotencyKey:req.headers['idempotency-key']});
    if(req.headers.authorization!=='Bearer controller-session-token') return json(res,403,{});
    const privateTask=url.pathname.match(/^\/v1\/agent\/tasks\/([0-9a-f-]{36})$/i);
    const publish=url.pathname.match(/^\/v1\/agent\/tasks\/([0-9a-f-]{36})\/publish$/i);
    const command=url.pathname.match(/^\/v1\/agent\/commands\/([0-9a-f-]{36})$/);
    if(req.method==='GET'&&privateTask&&privateTask[1]==='33333333-3333-4333-8333-333333333333') {
      return json(res,409,{error:'task_minimum',message:privateMarker,
        details:{asset:'ATTO',minimumAtomic:'1000000000'}});
    }
    if(req.method==='GET'&&privateTask) {
      const task=tasks.get(privateTask[1].toLowerCase());
      return task?json(res,200,task):json(res,404,{});
    }
    if(req.method==='PUT'&&privateTask) {
      const task=tasks.get(privateTask[1].toLowerCase());
      if(!task||body?.expectedVersion!==task.version) return json(res,409,{});
      Object.assign(task,body.draft,{version:task.version+1});
      return json(res,200,task);
    }
    if(req.method==='POST'&&publish) {
      const task=tasks.get(publish[1].toLowerCase());
      if(!task) return json(res,404,{});
      if(publish[1]==='44444444-4444-4444-8444-444444444444') {
        return json(res,409,{error:'task_minimum',message:privateMarker,
          details:{asset:'ATTO',minimumAtomic:'1000000000',privateProof:'private-proof-marker'}});
      }
      if(publish[1]==='55555555-5555-4555-8555-555555555555') {
        return json(res,409,{error:'task_capacity',message:privateMarker,
          details:{privateCredential:'private-credential-marker'}});
      }
      const key=String(req.headers['idempotency-key']);
      const existing=rejected.get(key);
      if(existing) {
        counts.oldPublish++;
        return existing.mode==='http'?json(res,409,existing.result):json(res,202,existing.pointer);
      }
      if(task.legacyShape&&task.version===0) {
        counts.oldPublish++;
        const result={error:'task_minimum',message:privateMarker};
        if(task.legacyShape==='null') result.details=null;
        if(task.legacyShape==='empty') result.details={};
        rejected.set(key,{mode:'http',result});
        return json(res,409,result);
      }
      if(BigInt(task.grossAtomic)<BigInt(cases.find(value=>value.taskId.toLowerCase()===task.taskId).minimum)) {
        counts.oldPublish++;
        const result={error:'task_minimum',message:privateMarker,
          details:{asset:task.asset,minimumAtomic:cases.find(value=>value.taskId.toLowerCase()===task.taskId).minimum}};
        const scenario=cases.find(value=>value.taskId.toLowerCase()===task.taskId);
        if(scenario.mode==='http') {
          rejected.set(key,{mode:'http',result});
          return json(res,409,result);
        }
        if(scenario.mode.startsWith('legacy-')) {
          const oldResult={error:'task_minimum',message:privateMarker};
          if(scenario.mode==='legacy-null') oldResult.details=null;
          if(scenario.mode==='legacy-empty') oldResult.details={};
          rejected.set(key,{mode:'http',result:oldResult});
          return json(res,409,oldResult);
        }
        const commandId='66666666-6666-4666-8666-666666666666';
        const pointer={commandId,statusUrl:`/v1/agent/commands/${commandId}`};
        rejected.set(key,{mode:'command',result,pointer});
        commands.set(commandId,{commandId,statusUrl:pointer.statusUrl,status:'REJECTED',errorCode:'task_minimum',
          httpStatus:409,result});
        return json(res,202,pointer);
      }
      if(body?.expectedVersion!==task.version||task.state!=='DRAFT') return json(res,409,{});
      task.state='OPEN';task.version++;counts.holds++;
      return json(res,200,task);
    }
    if(req.method==='GET'&&command) {
      counts.status++;
      return json(res,200,commands.get(command[1])??{});
    }
    return json(res,404,{});
  });
  const fixture=await profileHome(http.origin);
  const client=await connect(fixture.home,'agent');
  try {
    let expectedHolds=0;
    for(const scenario of cases) {
      const oldRequestId=scenario.requestId;
      const publishArgs={taskId:scenario.taskId,requestId:oldRequestId,expectedVersion:0};

      // When the original publish is below the configured minimum, MCP exposes only typed policy fields and fixed guidance.
      const first=await client.callTool({name:'marketplace_task_publish',arguments:publishArgs});
      assert.equal(first.isError,true);
      const firstError=JSON.parse(contentText(first)).error;
      assert.equal(firstError.code,'TASK_MINIMUM');
      assert.equal(firstError.httpStatus,409);
      assert.equal(firstError.details.serverCode,'task_minimum');
      assert.match(firstError.message,/reconcile the terminal rejection/);
      assert.match(firstError.message,/current version/);
      assert.match(firstError.message,/new requestId/);
      assert.match(firstError.message,/Never retry the rejected requestId with changed arguments/);
      if(scenario.mode.startsWith('legacy-')) {
        assert.equal(Object.hasOwn(firstError.details,'asset'),false);
        assert.equal(Object.hasOwn(firstError.details,'minimumAtomic'),false);
        assert.match(firstError.message,/configured minimum for its asset/);
        assert.equal(firstError.message.includes(scenario.asset),false);
        assert.equal(firstError.message.includes(scenario.minimum),false);
        assert.deepEqual(Object.keys(firstError.details).sort(),['recovery','serverCode']);
      } else {
        assert.equal(firstError.details.asset,scenario.asset);
        assert.equal(firstError.details.minimumAtomic,scenario.minimum);
        const expectedKeys=['asset','minimumAtomic','recovery','serverCode'];
        if(scenario.mode==='command') expectedKeys.push('commandId','statusUrl','terminal');
        assert.deepEqual(Object.keys(firstError.details).sort(),expectedKeys.sort());
        if(scenario.mode==='command') {
          assert.equal(firstError.details.commandId,'66666666-6666-4666-8666-666666666666');
          assert.equal(firstError.details.statusUrl,'/v1/agent/commands/66666666-6666-4666-8666-666666666666');
          assert.equal(firstError.details.terminal,true);
        }
      }
      assert.equal(JSON.stringify(first).includes(privateMarker),false);
      assert.equal(JSON.stringify(first).includes('privateProof'),false);

      // Then the old exact request remains rejected after the draft correction; changed arguments cannot reuse its key.
      const correctedDraft={title:'Minimum feedback test',description:'Task context',deliverable:'A result',
        acceptanceTerms:'A passing result',asset:scenario.asset,grossAtomic:scenario.minimum,milestones:[{title:'Delivery',amountAtomic:scenario.minimum,deliverable:'A result',acceptanceTerms:'A passing result'}]};
      const updated=await client.callTool({name:'marketplace_task_draft_update',arguments:{taskId:scenario.taskId,
        requestId:scenario.updateRequestId,
        expectedVersion:0,draft:correctedDraft}});
      const updatedText=contentText(updated);
      assert.ok(!updated.isError,`${scenario.mode}: ${updatedText.slice(0,200)}`);
      assert.equal(JSON.parse(updatedText).result.version,1);
      const beforeChangedAttempt=counts.oldPublish;
      const changedOldKey=await client.callTool({name:'marketplace_task_publish',arguments:{...publishArgs,expectedVersion:1}});
      assert.equal(JSON.parse(contentText(changedOldKey)).error.code,'IDEMPOTENCY_CONFLICT');
      assert.equal(counts.oldPublish,beforeChangedAttempt);
      const replay=await client.callTool({name:'marketplace_task_publish',arguments:publishArgs});
      assert.equal(replay.isError,true);
      const replayError=JSON.parse(contentText(replay)).error;
      assert.equal(replayError.code,'TASK_MINIMUM');
      if(scenario.mode.startsWith('legacy-')) {
        assert.equal(Object.hasOwn(replayError.details,'asset'),false);
        assert.equal(Object.hasOwn(replayError.details,'minimumAtomic'),false);
      } else {
        assert.equal(replayError.details.minimumAtomic,scenario.minimum);
      }
      assert.equal(JSON.stringify(replay).includes(privateMarker),false);

      const correctedRequestId=scenario.requestId==='77777777-7777-4777-8777-777777777777'
        ?'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        :scenario.requestId==='88888888-8888-4888-8888-888888888888'
          ?'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
          :scenario.requestId==='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
            ?'56565656-5656-4565-8565-565656565656'
            :scenario.requestId==='abababab-abab-4bab-8bab-abababababab'
              ?'67676767-6767-4676-8676-676767676767'
          :'78787878-7878-4787-8787-787878787878';
      const published=await client.callTool({name:'marketplace_task_publish',arguments:{taskId:scenario.taskId,
        requestId:correctedRequestId,expectedVersion:1}});
      const publishedText=contentText(published);
      assert.ok(!published.isError,`${scenario.mode}: ${publishedText.slice(0,200)}`);
      assert.equal(JSON.parse(publishedText).result.state,'OPEN');
      expectedHolds++;
      assert.equal(counts.holds,expectedHolds);

      const finalReplay=await client.callTool({name:'marketplace_task_publish',arguments:publishArgs});
      const finalError=JSON.parse(contentText(finalReplay)).error;
      assert.equal(finalError.code,'TASK_MINIMUM');
      if(scenario.mode.startsWith('legacy-')) {
        assert.equal(Object.hasOwn(finalError.details,'asset'),false);
        assert.equal(Object.hasOwn(finalError.details,'minimumAtomic'),false);
      } else {
        assert.equal(finalError.details.minimumAtomic,scenario.minimum);
      }
      assert.equal(counts.holds,expectedHolds);
      const oldPostCount=requests.filter(value=>value.method==='POST'&&value.path.endsWith('/publish')
        &&value.idempotencyKey===oldRequestId).length;
      assert.equal(oldPostCount,scenario.mode==='command'?1:3);
    }

    // Arbitrary or malformed 409 bodies stay generic and never cross the MCP boundary.
    const wrongRoute=await client.callTool({name:'marketplace_tasks_private_get',arguments:{
      taskId:'33333333-3333-4333-8333-333333333333'}});
    assert.equal(JSON.parse(contentText(wrongRoute)).error.code,'MARKETPLACE_HTTP');
    assert.equal(JSON.stringify(wrongRoute).includes(privateMarker),false);
    for(const taskId of ['44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555']) {
      const arbitrary=await client.callTool({name:'marketplace_task_publish',arguments:{taskId,
        requestId:taskId,expectedVersion:0}});
      assert.equal(JSON.parse(contentText(arbitrary)).error.code,'MARKETPLACE_HTTP');
      assert.equal(JSON.stringify(arbitrary).includes(privateMarker),false);
      assert.equal(JSON.stringify(arbitrary).includes('privateProof'),false);
      assert.equal(JSON.stringify(arbitrary).includes('privateCredential'),false);
    }
    assert.equal(counts.holds,cases.length);
  } finally {
    await client.close();http.close();fixture.store.close();await rm(fixture.home,{recursive:true,force:true});
  }
});

async function profileHome(origin) {
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-proof-'));
  const store=await MarketplaceProfileStore.open(home);
  store.createProfile({id:'agent',origin,audience:'marketplace',accountId,agentId,identityId,controllerNetwork:'ATTO',controllerAddress,
    controllerIndex:0,authMode:'controller-session',accessToken:'controller-session-token',accessExpiresAt:Date.now()+120_000,
    refreshToken:'controller-refresh-token',refreshExpiresAt:Date.now()+240_000});
  return {home,store};
}

async function connect(home,profile) {
  const client=new Client({name:'test-marketplace',version:'1.0.0'});
  const environment=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>typeof value==='string'&&key!=='NODE_TEST_CONTEXT'&&!key.startsWith('NODE_TEST_')));
  await client.connect(new StdioClientTransport({command:process.execPath,args:[serverMain,'--profile',profile,'--home',home],env:environment,stderr:'pipe'}));
  return client;
}

async function listen(handler) {
  const server=createServer((req,res)=>{ void Promise.resolve(handler(req,res)).catch(()=>{if(!res.destroyed)json(res,500,{});}); });
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  return Object.assign(server,{origin:`http://127.0.0.1:${server.address().port}`});
}

async function readBody(request) {
  let value=''; for await (const chunk of request) value+=chunk;
  return value?JSON.parse(value):null;
}

function challenge(id,purpose,bindingHash) {
  const issuedAt=new Date(Date.now()-1000).toISOString();
  const expiresAt=new Date(Date.now()+120_000).toISOString();
  const message=`Marketplace Agent Controller Proof v1\nAudience: marketplace\nNetwork: live\nAddress: ${controllerAddress}\nPurpose: ${purpose}\nRequest ID: ${id}\nBinding Hash: ${bindingHash}\nNonce: ${'a'.repeat(64)}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`;
  return {challengeId:id,message,issuedAt,expiresAt};
}

function hash(lines) { return createHash('sha256').update(lines.join('\n'),'utf8').digest('hex'); }

async function signAttoMessage(message) {
  return (await controllerSigner.signMessage(Int8Array.from(Buffer.from(message,'utf8')))).toString();
}

async function writeApprovalResponse(requestPath,request) {
  const responsePath=requestPath.replace(/\.request\.json$/,'.response.json');
  const response={version:1,type:'marketplace-controller-approval-response',profileId:request.profileId,handoffId:request.handoffId,
    requestDigest:approvalRequestDigest(request),challengeId:request.challenge.challengeId,message:request.challenge.message,
    signature:await signAttoMessage(request.challenge.message),controllerAddress:request.controller.address,controllerIndex:request.controller.index};
  await writeFile(responsePath,`${JSON.stringify(response)}\n`,{mode:0o600});
  await chmod(responsePath,0o600);
}

function json(res,status,body) { res.writeHead(status,{'content-type':'application/json'}); res.end(JSON.stringify(body)); }
function contentText(result) { return result.content?.filter(part=>part.type==='text').map(part=>part.text).join('\n')??''; }
