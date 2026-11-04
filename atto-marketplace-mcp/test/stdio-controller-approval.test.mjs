import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AttoPrivateKey } from '@attocash/commons-core';
import { MarketplaceProfileStore } from '../dist/profile-store.js';
import { approvalRequestDigest } from '../dist/approval-files.js';
import { runSetup } from '../dist/setup.js';

const accountId='11111111-1111-4111-8111-111111111111';
const agentId='22222222-2222-4222-8222-222222222222';
const identityId='33333333-3333-4333-8333-333333333333';
const controllerSigner=await AttoPrivateKey.Companion.parse('01'.repeat(32)).toSigner();
const controllerAddress=controllerSigner.address.toString();
const serverMain=join(import.meta.dirname,'../dist/main.js');

test('payout enrollment uses an exact typed local approval and durable same-request recovery over MCP stdio', async () => {
  // Given an explicit controller-session profile and a payout challenge bound to the backend network and address.
  const requestId='44444444-4444-4444-8444-444444444444';
  const address=`atto://${'b'.repeat(61)}`;
  const challengeId='55555555-5555-4555-8555-555555555555';
  const requests=[];
  const http=await listen(async(req,res)=>{
    const body=await readBody(req);
    requests.push({method:req.method,path:req.url,body,authorization:req.headers.authorization});
    if(req.url==='/v1/agent/payout-addresses/ATTO/selection') return json(res,200,null);
    if(req.url==='/v1/agent/payout-addresses/challenges') {
      const command=body;
      const network='atto:dev';
      const binding=hash(['payout-address-v1',accountId,identityId,'ENROLL','ATTO',network,'',address,'',requestId]);
      return json(res,200,challenge(challengeId,'payout address enrollment',binding));
    }
    if(req.url==='/v1/agent/payout-addresses'&&req.method==='POST') return json(res,201,{destinationId:'66666666-6666-4666-8666-666666666666',selectionVersion:1,replayed:false});
    return json(res,404,{});
  });
  const fixture=await profileHome(http.origin);
  const client=await connect(fixture.home,'agent');
  const args={action:'ENROLL',asset:'ATTO',requestId,address};
  try {
    // When the AI client prepares the enrollment, the only approval boundary is one generated private file.
    const pending=await client.callTool({name:'marketplace_payout_address_mutate',arguments:args});
    const handoff=JSON.parse(contentText(pending)).result;
    assert.equal(handoff.status,'approval_required');
    assert.match(handoff.walletCommand,/^atto-marketplace-mcp approve /);
    assert.equal(requests.filter(r=>r.path==='/v1/agent/payout-addresses').length,0);
    assert.equal(requests.filter(r=>r.path==='/v1/agent/payout-addresses/challenges').length,1);
    assert.ok(requests.every(r=>r.authorization==='Bearer controller-session-token'));
    const requestPath=join(fixture.home,'approvals','agent',`${handoff.handoffId}.request.json`);
    const request=JSON.parse(await readFile(requestPath,'utf8'));
    assert.equal(request.action.network,'atto:dev');
    assert.equal(request.action.canonicalTargetAddress,address);
    assert.equal(request.action.command.idempotencyKey,requestId);
    assert.equal(request.purpose,'payout address enrollment');
    await writeApprovalResponse(requestPath,request);

    // Then the matching signed response is consumed once, never returned, and the same request ID recovers safely.
    const completed=await client.callTool({name:'marketplace_payout_address_mutate',arguments:args});
    const result=JSON.parse(contentText(completed)).result;
    assert.equal(result.destinationId,'66666666-6666-4666-8666-666666666666');
    assert.equal(result.selectionVersion,1);
    const post=requests.find(r=>r.path==='/v1/agent/payout-addresses'&&r.method==='POST');
    assert.equal(JSON.stringify(completed).includes(post.body.proof.signature),false);
    assert.deepEqual(post.body.command,{action:'ENROLL',asset:'ATTO',idempotencyKey:requestId,address});
    assert.equal(post.body.proof.challengeId,challengeId);
    assert.equal(post.body.proof.signature,await signAttoMessage(post.body.proof.message));
    const recovered=await client.callTool({name:'marketplace_payout_address_mutate',arguments:args});
    assert.equal(JSON.parse(contentText(recovered)).result.recovered,true);
    assert.equal(requests.filter(r=>r.path==='/v1/agent/payout-addresses'&&r.method==='POST').length,1);
    assert.equal(requests.filter(r=>r.path==='/v1/agent/payout-addresses/challenges').length,1);
  } finally {
    await client.close(); http.close(); fixture.store.close(); await rm(fixture.home,{recursive:true,force:true});
  }
});

test('invalid ATTO approval signature is rejected before HTTP submission and leaves the handoff retryable', async () => {
  const requestId='51515151-5151-4151-8151-515151515151';
  const address=`atto://${'c'.repeat(61)}`;
  const challengeId='52525252-5252-4252-8252-525252525252';
  const requests=[];
  const http=await listen(async(req,res)=>{
    const body=await readBody(req); requests.push({method:req.method,path:req.url,body});
    if(req.url==='/v1/agent/payout-addresses/ATTO/selection') return json(res,200,null);
    if(req.url==='/v1/agent/payout-addresses/challenges') {
      const binding=hash(['payout-address-v1',accountId,identityId,'ENROLL','ATTO','atto:dev','',address,'',requestId]);
      return json(res,200,challenge(challengeId,'payout address enrollment',binding));
    }
    if(req.url==='/v1/agent/payout-addresses'&&req.method==='POST')
      return json(res,201,{destinationId:'53535353-5353-4353-8353-535353535353',selectionVersion:1,replayed:false});
    return json(res,404,{});
  });
  const fixture=await profileHome(http.origin);
  const client=await connect(fixture.home,'agent');
  const args={action:'ENROLL',asset:'ATTO',requestId,address};
  try {
    const pending=JSON.parse(contentText(await client.callTool({name:'marketplace_payout_address_mutate',arguments:args}))).result;
    const requestPath=join(fixture.home,'approvals','agent',`${pending.handoffId}.request.json`);
    const request=JSON.parse(await readFile(requestPath,'utf8'));
    await writeApprovalResponse(requestPath,request);
    const responsePath=requestPath.replace(/\.request\.json$/,'.response.json');
    const invalid=JSON.parse(await readFile(responsePath,'utf8'));
    invalid.signature='d'.repeat(128);
    await writeFile(responsePath,`${JSON.stringify(invalid)}\n`,{mode:0o600});

    // Signature verification runs before claiming the handoff or sending the protected mutation.
    const rejected=await client.callTool({name:'marketplace_payout_address_mutate',arguments:args});
    assert.equal(rejected.isError,true);
    assert.equal(JSON.parse(contentText(rejected)).error.code,'APPROVAL_FILE');
    assert.equal(requests.filter(row=>row.path==='/v1/agent/payout-addresses'&&row.method==='POST').length,0);
    assert.equal(fixture.store.getHandoff('agent',pending.handoffId).state,'WAITING_APPROVAL');

    // Replacing only the bad signature lets the identical saved request proceed without fetching another challenge.
    await writeApprovalResponse(requestPath,request);
    const completed=await client.callTool({name:'marketplace_payout_address_mutate',arguments:args});
    assert.equal(JSON.parse(contentText(completed)).result.destinationId,'53535353-5353-4353-8353-535353535353');
    assert.equal(requests.filter(row=>row.path==='/v1/agent/payout-addresses/challenges').length,1);
    const post=requests.find(row=>row.path==='/v1/agent/payout-addresses'&&row.method==='POST');
    assert.equal(post.body.proof.signature,await signAttoMessage(request.challenge.message));
  } finally { await client.close();http.close();fixture.store.close();await rm(fixture.home,{recursive:true,force:true}); }
});

test('an explicit payout route is part of its command and exact wallet approval', async () => {
  // Given an account enrolling an ATTO destination on one explicit native network.
  const requestId='45454545-4545-4454-8454-545454545454';
  const address=`atto://${'e'.repeat(61)}`;
  const network='atto:dev';
  const requests=[];
  const http=await listen(async(req,res)=>{
    const body=await readBody(req);
    requests.push({method:req.method,path:req.url,body});
    if(req.url==='/v1/agent/payout-addresses/ATTO/selection?network=atto%3Adev') return json(res,200,null);
    if(req.url==='/v1/agent/payout-addresses/challenges') {
      assert.equal(body.network,network);
      const binding=hash(['payout-address-v1',accountId,identityId,'ENROLL','ATTO',network,'',address,'',requestId]);
      return json(res,200,challenge('46464646-4646-4464-8464-646464646464','payout address enrollment',binding));
    }
    if(req.url==='/v1/agent/payout-addresses'&&req.method==='POST') {
      return json(res,201,{destinationId:'47474747-4747-4474-8474-747474747474',selectionVersion:1,network,replayed:false});
    }
    return json(res,404,{});
  });
  const fixture=await profileHome(http.origin);
  const client=await connect(fixture.home,'agent');
  const args={action:'ENROLL',asset:'ATTO',requestId,address,network};
  try {
    // When the address is prepared, the typed approval captures the requested route as well as the address.
    const pending=await client.callTool({name:'marketplace_payout_address_mutate',arguments:args});
    const handoff=JSON.parse(contentText(pending)).result;
    const requestPath=join(fixture.home,'approvals','agent',`${handoff.handoffId}.request.json`);
    const request=JSON.parse(await readFile(requestPath,'utf8'));
    assert.equal(request.action.network,network);
    assert.equal(request.action.command.network,network);
    const changed={...request,action:{...request.action,command:{...request.action.command,network:'atto:beta'}}};
    assert.notEqual(approvalRequestDigest(changed),approvalRequestDigest(request));
    await writeApprovalResponse(requestPath,request);

    // Then Marketplace receives that same explicitly routed command; changing its route under the same request ID conflicts.
    const completed=await client.callTool({name:'marketplace_payout_address_mutate',arguments:args});
    assert.equal(JSON.parse(contentText(completed)).result.network,network);
    assert.equal(requests.find(row=>row.path==='/v1/agent/payout-addresses'&&row.method==='POST').body.command.network,network);
    const changedRoute=await client.callTool({name:'marketplace_payout_address_mutate',arguments:{...args,network:'atto:beta'}});
    assert.equal(changedRoute.isError,true);
    assert.equal(JSON.parse(contentText(changedRoute)).error.code,'IDEMPOTENCY_CONFLICT');
    assert.equal(requests.filter(row=>row.path==='/v1/agent/payout-addresses/challenges').length,1);
    const selection=await client.callTool({name:'marketplace_payout_selection_get',arguments:{asset:'ATTO',network}});
    assert.equal(selection.isError,undefined);
    assert.ok(requests.some(row=>row.path==='/v1/agent/payout-addresses/ATTO/selection?network=atto%3Adev'));
  } finally { await client.close();http.close();fixture.store.close();await rm(fixture.home,{recursive:true,force:true}); }
});

test('payout ENROLL SELECT and DISABLE replay after their own selection changes', async () => {
  const firstId='10101010-1010-4010-8010-101010101010';
  const secondId='20202020-2020-4020-8020-202020202020';
  const firstAddress=`atto://${'b'.repeat(61)}`;
  const secondAddress=`atto://${'c'.repeat(61)}`;
  const addresses=[{destinationId:secondId,asset:'ATTO',network:'atto:dev',address:secondAddress,state:'ACTIVE'}];
  let selection=null;
  const requests=[];
  const http=await listen(async(req,res)=>{
    const body=await readBody(req);
    requests.push({method:req.method,path:req.url,body});
    if(req.url==='/v1/agent/payout-addresses/ATTO/selection') return json(res,200,selection);
    if(req.url==='/v1/agent/payout-addresses'&&req.method==='GET') return json(res,200,addresses);
    if(req.url==='/v1/agent/payout-addresses/challenges') {
      const target=body.action==='ENROLL'?body.address:addresses.find(row=>row.destinationId===body.destinationId)?.address;
      const purpose={ENROLL:'payout address enrollment',SELECT:'payout address selection',DISABLE:'payout address disablement'}[body.action];
      const binding=hash(['payout-address-v1',accountId,identityId,body.action,'ATTO','atto:dev',
        body.destinationId??'',target,body.expectedSelectionVersion===undefined?'':String(body.expectedSelectionVersion),body.idempotencyKey]);
      return json(res,200,challenge('30303030-3030-4030-8030-303030303030',purpose,binding));
    }
    if(req.url==='/v1/agent/payout-addresses'&&req.method==='POST') {
      const command=body.command;
      if(command.action==='ENROLL') {
        addresses.push({destinationId:firstId,asset:'ATTO',network:'atto:dev',address:firstAddress,state:'ACTIVE'});
        selection={asset:'ATTO',destinationId:firstId,version:1};
      } else if(command.action==='SELECT') selection={asset:'ATTO',destinationId:secondId,version:2};
      else addresses.find(row=>row.destinationId===firstId).state='DISABLED';
      return json(res,201,{destinationId:command.destinationId??firstId,selectionVersion:selection.version,replayed:false});
    }
    return json(res,404,{});
  });
  const fixture=await profileHome(http.origin);
  const client=await connect(fixture.home,'agent');
  try {
    for(const args of [
      {action:'ENROLL',asset:'ATTO',requestId:'40404040-4040-4040-8040-404040404040',address:firstAddress},
      {action:'SELECT',asset:'ATTO',requestId:'50505050-5050-4050-8050-505050505050',destinationId:secondId,expectedSelectionVersion:1},
      {action:'DISABLE',asset:'ATTO',requestId:'60606060-6060-4060-8060-606060606060',destinationId:firstId,expectedSelectionVersion:2},
    ]) {
      const pending=JSON.parse(contentText(await client.callTool({name:'marketplace_payout_address_mutate',arguments:args}))).result;
      assert.equal(pending.status,'approval_required');
      const requestPath=join(fixture.home,'approvals','agent',`${pending.handoffId}.request.json`);
      await writeApprovalResponse(requestPath,JSON.parse(await readFile(requestPath,'utf8')));
      const completed=await client.callTool({name:'marketplace_payout_address_mutate',arguments:args});
      assert.equal(completed.isError,undefined);
      const before=requests.length;
      const replay=await client.callTool({name:'marketplace_payout_address_mutate',arguments:args});
      assert.equal(JSON.parse(contentText(replay)).result.recovered,true);
      assert.equal(requests.length,before);
    }
    assert.equal(requests.filter(row=>row.path==='/v1/agent/payout-addresses'&&row.method==='POST').length,3);
    assert.equal(requests.filter(row=>row.path==='/v1/agent/payout-addresses/challenges').length,3);
  } finally {
    await client.close(); http.close(); fixture.store.close(); await rm(fixture.home,{recursive:true,force:true});
  }
});

test('withdrawal proof binds the selected Nano network, address, exact atomic amount, and selection version', async () => {
  // Given a controller with one selected XNO payout address outside its cooldown.
  const requestId='77777777-7777-4777-8777-777777777777';
  const destinationId='88888888-8888-4888-8888-888888888888';
  const withdrawalId='99999999-9999-4999-8999-999999999999';
  const amount='123456789012345678901234567890';
  const address=`nano_${'1'.repeat(60)}`;
  const requests=[];
  const http=await listen(async(req,res)=>{
    const body=await readBody(req);
    requests.push({method:req.method,path:req.url,body});
    if(req.url?.startsWith('/v1/agent/payout-addresses/XNO/selection')) return json(res,200,{asset:'XNO',destinationId,version:3,usableAfter:new Date(Date.now()-1000).toISOString()});
    if(req.url==='/v1/agent/payout-addresses') return json(res,200,[{destinationId,asset:'XNO',network:'nano:dev',address,state:'ACTIVE'}]);
    if(req.url==='/v1/agent/withdrawals/challenges') {
      const binding=hash(['withdrawal-create-v2',accountId,identityId,'XNO',amount,'nano:dev',destinationId,address,'3',requestId]);
      return json(res,200,challenge('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','withdrawal creation',binding));
    }
    if(req.url==='/v1/agent/withdrawals'&&req.method==='POST') return json(res,201,{withdrawalId,requestId,asset:'XNO',network:'nano:dev',atomicAmount:amount,destinationId,destinationVersion:3,destinationAddress:address,state:'PENDING',nativeSend:null,createdAt:'2026-09-26T12:00:00Z',updatedAt:'2026-09-26T12:00:00Z',replayed:false});
    return json(res,404,{});
  });
  const fixture=await profileHome(http.origin);
  const client=await connect(fixture.home,'agent');
  const args={asset:'XNO',atomicAmount:amount,destinationId,expectedSelectionVersion:3,requestId,network:'nano:dev'};
  try {
    // When one exact maximum-precision withdrawal is authorized, the server challenge must reproduce its binding hash.
    const pending=await client.callTool({name:'marketplace_withdrawal_create',arguments:args});
    const handoff=JSON.parse(contentText(pending)).result;
    const requestPath=join(fixture.home,'approvals','agent',`${handoff.handoffId}.request.json`);
    const request=JSON.parse(await readFile(requestPath,'utf8'));
    assert.equal(request.action.network,'nano:dev');
    assert.equal(request.action.destinationAddress,address);
    assert.equal(request.action.command.atomicAmount,amount);
    assert.equal(request.action.command.expectedSelectionVersion,3);
    assert.equal(request.action.command.network,'nano:dev');
    const changed={...request,action:{...request.action,command:{...request.action.command,network:'nano:mainnet'}}};
    assert.notEqual(approvalRequestDigest(changed),approvalRequestDigest(request));
    await writeApprovalResponse(requestPath,request);

    // Then Marketplace receives exactly the signed command and the returned private resource state is safe to expose.
    const completed=await client.callTool({name:'marketplace_withdrawal_create',arguments:args});
    const result=JSON.parse(contentText(completed)).result;
    assert.equal(result.withdrawalId,withdrawalId);
    assert.equal(result.requestId,requestId);
    assert.equal(result.state,'PENDING');
    assert.equal(result.nativeSend,null);
    assert.equal(result.atomicAmount,amount);
    const post=requests.find(r=>r.path==='/v1/agent/withdrawals'&&r.method==='POST');
    assert.equal(post.body.command.atomicAmount,amount);
    assert.equal(post.body.command.network,'nano:dev');
    assert.equal(post.body.proof.message,request.challenge.message);
    assert.equal(requests.filter(r=>r.path==='/v1/agent/withdrawals/challenges').length,1);
  } finally {
    await client.close(); http.close(); fixture.store.close(); await rm(fixture.home,{recursive:true,force:true});
  }
});

test('withdrawal SEND recovery stays safe through ATTO and XNO stdio create, get, and list', async () => {
  const routes=[
    {asset:'ATTO',network:'atto:dev',requestId:'41414141-4141-4141-8141-414141414141',
      destinationId:'42424242-4242-4242-8242-424242424242',withdrawalId:'43434343-4343-4343-8343-434343434343',
      amount:'25',address:'atto://'+'b'.repeat(61),transactionId:'44444444-4444-4444-8444-444444444444',hash:'a'.repeat(64)},
    {asset:'XNO',network:'nano:dev',requestId:'51515151-5151-4151-8151-515151515151',
      destinationId:'52525252-5252-4252-8252-525252525252',withdrawalId:'53535353-5353-4353-8353-535353535353',
      amount:'29',address:'nano_'+'1'.repeat(60),transactionId:'54545454-5454-4454-8454-545454545454',hash:'B'.repeat(64)},
  ];
  const assertSafeProjection=value=>{
    const text=JSON.stringify(value);
    for(const marker of ['withdrawal-proof-message','withdrawal-proof-signature','withdrawal-signed-payload',
      'withdrawal-private-payload','withdrawal-native-signed-payload','withdrawal-credential-secret']) {
      assert.equal(text.includes(marker),false,'MCP returned a private withdrawal field: '+marker);
    }
  };
  const expectedFields=['withdrawalId','requestId','asset','network','atomicAmount','destinationId','destinationVersion',
    'destinationAddress','state','nativeSend','createdAt','updatedAt','replayed'];
  for(const route of routes) {
    const requests=[];
    let withdrawal;
    const effects={debits:0,helpers:0,sends:0};
    const historyWithdrawal={withdrawalId:'76767676-7676-4676-8676-767676767676',requestId:'browser_request-17',
      asset:route.asset,network:route.network,atomicAmount:'7',destinationId:route.destinationId,destinationVersion:2,
      destinationAddress:route.address,state:'PENDING',nativeSend:null,createdAt:'2026-10-08T12:00:00Z',
      updatedAt:'2026-10-08T12:00:00Z'};
    const unicodeHistoryWithdrawal={...historyWithdrawal,withdrawalId:'78787878-7878-4787-8787-787878787878',
      requestId:'browser_café-١٧'};
    const privateResponse=(record,replayed)=>({
      ...record,replayed,
      ...(record.nativeSend?{nativeSend:{...record.nativeSend,signedPayload:'withdrawal-native-signed-payload'}}:{}),
      proof:{challengeId:'65656565-6565-4565-8565-656565656565',message:'withdrawal-proof-message',signature:'withdrawal-proof-signature'},
      signedPayload:'withdrawal-signed-payload',privatePayload:'withdrawal-private-payload',
      credentialValue:'withdrawal-credential-secret',recipientReceive:{state:'RECEIVED'},
    });
    const http=await listen(async(req,res)=>{
      const body=await readBody(req);
      const url=new URL(req.url??'/', 'http://marketplace.test');
      requests.push({method:req.method,path:req.url,body,authorization:req.headers.authorization});
      if(req.headers.authorization!=='Bearer controller-session-token') return json(res,403,{});
      if(req.method==='GET'&&url.pathname==='/v1/agent/payout-addresses/'+route.asset+'/selection') {
        assert.equal(url.searchParams.get('network'),route.network);
        return json(res,200,{asset:route.asset,destinationId:route.destinationId,version:3,
          usableAfter:new Date(Date.now()-1000).toISOString()});
      }
      if(req.method==='GET'&&url.pathname==='/v1/agent/payout-addresses') {
        return json(res,200,[{destinationId:route.destinationId,asset:route.asset,network:route.network,address:route.address,state:'ACTIVE'}]);
      }
      if(req.method==='POST'&&url.pathname==='/v1/agent/withdrawals/challenges') {
        const binding=hash(['withdrawal-create-v2',accountId,identityId,route.asset,route.amount,route.network,
          route.destinationId,route.address,'3',route.requestId]);
        return json(res,200,challenge('66666666-6666-4666-8666-666666666666','withdrawal creation',binding));
      }
      if(req.method==='POST'&&url.pathname==='/v1/agent/withdrawals') {
        if(body?.command?.idempotencyKey!==route.requestId) return json(res,409,{});
        const replayed=withdrawal!==undefined;
        if(!withdrawal) {
          effects.debits++;effects.helpers++;effects.sends++;
          withdrawal={withdrawalId:route.withdrawalId,requestId:route.requestId,asset:route.asset,network:route.network,
            atomicAmount:route.amount,destinationId:route.destinationId,destinationVersion:3,destinationAddress:route.address,
            state:'PENDING',nativeSend:null,createdAt:'2026-10-09T12:00:00Z',updatedAt:'2026-10-09T12:00:00Z'};
        }
        return json(res,replayed?200:201,privateResponse(withdrawal,replayed));
      }
      if(req.method==='GET'&&url.pathname==='/v1/agent/withdrawals') {
        return json(res,200,[...(withdrawal?[privateResponse(withdrawal,false)]:[]),
          privateResponse(historyWithdrawal,false),privateResponse(unicodeHistoryWithdrawal,false)]);
      }
      if(req.method==='GET'&&url.pathname==='/v1/agent/withdrawals/'+historyWithdrawal.withdrawalId) {
        return json(res,200,privateResponse(historyWithdrawal,false));
      }
      if(req.method==='GET'&&url.pathname==='/v1/agent/withdrawals/'+unicodeHistoryWithdrawal.withdrawalId) {
        return json(res,200,privateResponse(unicodeHistoryWithdrawal,false));
      }
      if(req.method==='GET'&&url.pathname==='/v1/agent/withdrawals/'+route.withdrawalId) {
        return withdrawal?json(res,200,privateResponse(withdrawal,false)):json(res,404,{});
      }
      return json(res,404,{});
    });
    const fixture=await profileHome(http.origin);
    fixture.store.createProfile({id:'agent-replay',origin:http.origin,audience:'marketplace',accountId,agentId,identityId,
      controllerNetwork:'ATTO',controllerAddress,controllerIndex:0,authMode:'controller-session',
      accessToken:'controller-session-token',accessExpiresAt:Date.now()+120_000,
      refreshToken:'controller-refresh-token',refreshExpiresAt:Date.now()+240_000});
    fixture.store.createProfile({id:'scoped',origin:http.origin,audience:'marketplace',accountId,agentId,identityId,
      controllerNetwork:'ATTO',controllerAddress,controllerIndex:0,authMode:'scoped-api-key',
      apiKey:'withdrawal-credential-secret',apiScopes:['tasks:read']});
    let client;
    let replayClient;
    let scopedClient;
    try {
      client=await connect(fixture.home,'agent');
      const args={asset:route.asset,atomicAmount:route.amount,destinationId:route.destinationId,
        expectedSelectionVersion:3,requestId:route.requestId,network:route.network};
      const callsBeforeInvalidKey=requests.length;
      const invalidUnicodeCreate=await client.callTool({name:'marketplace_withdrawal_create',
        arguments:{...args,requestId:unicodeHistoryWithdrawal.requestId}});
      assert.equal(invalidUnicodeCreate.isError,true);
      assert.equal(requests.length,callsBeforeInvalidKey,'withdrawal create input must remain UUID-only');
      const pending=JSON.parse(contentText(await client.callTool({name:'marketplace_withdrawal_create',arguments:args}))).result;
      const requestPath=join(fixture.home,'approvals','agent',pending.handoffId+'.request.json');
      await writeApprovalResponse(requestPath,JSON.parse(await readFile(requestPath,'utf8')));
      const createdCall=await client.callTool({name:'marketplace_withdrawal_create',arguments:args});
      assert.equal(createdCall.isError,undefined);
      const created=JSON.parse(contentText(createdCall)).result;
      assert.equal(created.withdrawalId,route.withdrawalId);
      assert.equal(created.requestId,route.requestId);
      assert.equal(created.state,'PENDING');
      assert.equal(created.nativeSend,null);
      assert.equal(Object.hasOwn(created,'nativeSend'),true);
      assert.equal(created.replayed,false);
      assert.deepEqual(Object.keys(created).sort(),[...expectedFields].sort());
      assertSafeProjection(created);

      const beforeCandidateGet=JSON.parse(contentText(await client.callTool({name:'marketplace_withdrawal_get',
        arguments:{withdrawalId:route.withdrawalId}}))).result;
      const beforeCandidateList=JSON.parse(contentText(await client.callTool({name:'marketplace_withdrawals_list',arguments:{}}))).result;
      const browserHistoryGet=JSON.parse(contentText(await client.callTool({name:'marketplace_withdrawal_get',
        arguments:{withdrawalId:historyWithdrawal.withdrawalId}}))).result;
      const unicodeHistoryGet=JSON.parse(contentText(await client.callTool({name:'marketplace_withdrawal_get',
        arguments:{withdrawalId:unicodeHistoryWithdrawal.withdrawalId}}))).result;
      assert.equal(beforeCandidateGet.requestId,route.requestId);
      assert.equal(beforeCandidateGet.nativeSend,null);
      assert.equal(beforeCandidateList.length,3);
      assert.equal(beforeCandidateList[0].nativeSend,null);
      const browserHistoryList=beforeCandidateList.find(value=>value.withdrawalId===historyWithdrawal.withdrawalId);
      const unicodeHistoryList=beforeCandidateList.find(value=>value.withdrawalId===unicodeHistoryWithdrawal.withdrawalId);
      assert.equal(browserHistoryGet.requestId,'browser_request-17');
      assert.equal(browserHistoryList.requestId,'browser_request-17');
      assert.equal(unicodeHistoryGet.requestId,'browser_café-١٧');
      assert.equal(unicodeHistoryList.requestId,'browser_café-١٧');
      assert.equal(unicodeHistoryGet.nativeSend,null);
      assert.equal(unicodeHistoryList.nativeSend,null);
      assertSafeProjection(beforeCandidateGet);
      assertSafeProjection(beforeCandidateList);
      assertSafeProjection(browserHistoryGet);
      assertSafeProjection(unicodeHistoryGet);
      assertSafeProjection(unicodeHistoryList);

      scopedClient=await connect(fixture.home,'scoped');
      const requestCountBeforeDeniedReads=requests.length;
      for(const [name,argsForRead] of [
        ['marketplace_withdrawal_get',{withdrawalId:route.withdrawalId}],
        ['marketplace_withdrawals_list',{}],
      ]) {
        const denied=await scopedClient.callTool({name,arguments:argsForRead});
        assert.equal(denied.isError,true);
        assert.equal(JSON.parse(contentText(denied)).error.code,'SETUP_REQUIRED');
        assertSafeProjection(denied);
      }
      assert.equal(requests.length,requestCountBeforeDeniedReads);
      await scopedClient.close();scopedClient=undefined;

      withdrawal={...withdrawal,nativeSend:{transactionId:route.transactionId,hash:route.hash,state:'CANDIDATE'},
        updatedAt:'2026-10-09T12:01:00Z'};
      const candidateGet=JSON.parse(contentText(await client.callTool({name:'marketplace_withdrawal_get',
        arguments:{withdrawalId:route.withdrawalId}}))).result;
      const candidateList=JSON.parse(contentText(await client.callTool({name:'marketplace_withdrawals_list',arguments:{}}))).result;
      for(const value of [candidateGet,candidateList[0]]) {
        assert.equal(value.requestId,route.requestId);
        assert.equal(value.withdrawalId,route.withdrawalId);
        assert.equal(value.state,'PENDING');
        assert.deepEqual(value.nativeSend,{transactionId:route.transactionId,hash:route.hash,state:'CANDIDATE'});
        assert.deepEqual(Object.keys(value).sort(),[...expectedFields].sort());
        assertSafeProjection(value);
      }

      // Restarting the same local profile refreshes the original withdrawal by ID without another create.
      await client.close();client=undefined;
      client=await connect(fixture.home,'agent');
      const postsBeforeLocalReplay=requests.filter(row=>row.path==='/v1/agent/withdrawals'&&row.method==='POST').length;
      const localReplayCall=await client.callTool({name:'marketplace_withdrawal_create',arguments:args});
      assert.equal(localReplayCall.isError,undefined);
      const localReplay=JSON.parse(contentText(localReplayCall)).result;
      assert.equal(localReplay.recovered,true);
      assert.equal(localReplay.withdrawalId,route.withdrawalId);
      assert.equal(localReplay.requestId,route.requestId);
      assert.deepEqual(localReplay.nativeSend,{transactionId:route.transactionId,hash:route.hash,state:'CANDIDATE'});
      assertSafeProjection(localReplay);
      assert.equal(requests.filter(row=>row.path==='/v1/agent/withdrawals'&&row.method==='POST').length,postsBeforeLocalReplay);

      // A fresh profile submits the exact original command to exercise Marketplace-side idempotent replay.
      replayClient=await connect(fixture.home,'agent-replay');
      const replayPending=JSON.parse(contentText(await replayClient.callTool({name:'marketplace_withdrawal_create',arguments:args}))).result;
      const replayRequestPath=join(fixture.home,'approvals','agent-replay',replayPending.handoffId+'.request.json');
      await writeApprovalResponse(replayRequestPath,JSON.parse(await readFile(replayRequestPath,'utf8')));
      const replayCall=await replayClient.callTool({name:'marketplace_withdrawal_create',arguments:args});
      assert.equal(replayCall.isError,undefined);
      const replayed=JSON.parse(contentText(replayCall)).result;
      assert.equal(replayed.withdrawalId,route.withdrawalId);
      assert.equal(replayed.requestId,route.requestId);
      assert.equal(replayed.state,'PENDING');
      assert.equal(replayed.replayed,true);
      assert.deepEqual(replayed.nativeSend,{transactionId:route.transactionId,hash:route.hash,state:'CANDIDATE'});
      assert.deepEqual(Object.keys(replayed).sort(),[...expectedFields].sort());
      assertSafeProjection(replayed);

      withdrawal={...withdrawal,state:'SETTLED',nativeSend:{...withdrawal.nativeSend,state:'CONFIRMED'},
        updatedAt:'2026-10-09T12:02:00Z'};
      const confirmedGet=JSON.parse(contentText(await client.callTool({name:'marketplace_withdrawal_get',
        arguments:{withdrawalId:route.withdrawalId}}))).result;
      const confirmedList=JSON.parse(contentText(await client.callTool({name:'marketplace_withdrawals_list',arguments:{}}))).result;
      for(const value of [confirmedGet,confirmedList[0]]) {
        assert.equal(value.state,'SETTLED');
        assert.deepEqual(value.nativeSend,{transactionId:route.transactionId,hash:route.hash,state:'CONFIRMED'});
        assert.equal(Object.hasOwn(value,'recipientReceive'),false);
        assertSafeProjection(value);
      }
      assert.deepEqual(effects,{debits:1,helpers:1,sends:1});
      assert.equal(requests.filter(row=>row.path==='/v1/agent/withdrawals'&&row.method==='POST').length,2);
      assert.ok(requests.every(row=>row.authorization==='Bearer controller-session-token'));
    } finally {
      if(scopedClient) await scopedClient.close();
      if(replayClient) await replayClient.close();
      if(client) await client.close();
      http.close();fixture.store.close();await rm(fixture.home,{recursive:true,force:true});
    }
  }
});

test('withdrawal rejects an explicit network that differs from the selected destination before challenge', async () => {
  // Given a selected XNO destination on nano:dev, while the request asks for nano:mainnet.
  const requestId='78787878-7878-4878-8878-787878787878';
  const destinationId='89898989-8989-4989-8989-898989898989';
  const address=`nano_${'2'.repeat(60)}`;
  let challengeCalls=0;
  const http=await listen(async(req,res)=>{
    if(req.url?.startsWith('/v1/agent/payout-addresses/XNO/selection')) return json(res,200,{asset:'XNO',destinationId,version:4,
      usableAfter:new Date(Date.now()-1000).toISOString()});
    if(req.url==='/v1/agent/payout-addresses') return json(res,200,[{destinationId,asset:'XNO',network:'nano:dev',address,state:'ACTIVE'}]);
    if(req.url==='/v1/agent/withdrawals/challenges') { challengeCalls++;return json(res,500,{}); }
    return json(res,404,{});
  });
  const fixture=await profileHome(http.origin);
  const client=await connect(fixture.home,'agent');
  try {
    // When the requested route does not match the selected payout destination, no challenge or approval is created.
    const result=await client.callTool({name:'marketplace_withdrawal_create',arguments:{asset:'XNO',atomicAmount:'25',destinationId,
      expectedSelectionVersion:4,requestId,network:'nano:mainnet'}});
    assert.equal(result.isError,true);
    assert.equal(JSON.parse(contentText(result)).error.code,'PAYOUT_NETWORK');
    assert.equal(challengeCalls,0);
  } finally { await client.close();http.close();fixture.store.close();await rm(fixture.home,{recursive:true,force:true}); }
});

test('lost withdrawal acknowledgement keeps the original request after selection changes and restart', async () => {
  const requestId='70707070-7070-4070-8070-707070707070';
  const destinationId='80808080-8080-4080-8080-808080808080';
  const address=`nano_${'1'.repeat(60)}`;
  const args={asset:'XNO',atomicAmount:'25',destinationId,expectedSelectionVersion:3,requestId};
  let selection={asset:'XNO',destinationId,version:3,usableAfter:new Date(Date.now()-1000).toISOString()};
  const requests=[];
  const http=await listen(async(req,res)=>{
    const body=await readBody(req); requests.push({method:req.method,path:req.url,body});
    if(req.url==='/v1/agent/payout-addresses/XNO/selection') return json(res,200,selection);
    if(req.url==='/v1/agent/payout-addresses') return json(res,200,[{destinationId,asset:'XNO',network:'nano:dev',address,state:'ACTIVE'}]);
    if(req.url==='/v1/agent/withdrawals/challenges') return json(res,200,challenge(
      '90909090-9090-4090-8090-909090909090','withdrawal creation',
      hash(['withdrawal-create-v2',accountId,identityId,'XNO','25','nano:dev',destinationId,address,'3',requestId])));
    if(req.url==='/v1/agent/withdrawals'&&req.method==='POST') { req.socket.destroy(); return; }
    return json(res,404,{});
  });
  const fixture=await profileHome(http.origin);
  const first=await connect(fixture.home,'agent');
  try {
    const pending=JSON.parse(contentText(await first.callTool({name:'marketplace_withdrawal_create',arguments:args}))).result;
    const requestPath=join(fixture.home,'approvals','agent',`${pending.handoffId}.request.json`);
    await writeApprovalResponse(requestPath,JSON.parse(await readFile(requestPath,'utf8')));
    const lost=await first.callTool({name:'marketplace_withdrawal_create',arguments:args});
    assert.equal(JSON.parse(contentText(lost)).error.code,'MUTATION_UNKNOWN');
  } finally { await first.close(); }
  selection={asset:'XNO',destinationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',version:4,
    usableAfter:new Date(Date.now()+60_000).toISOString()};
  const before=requests.length;
  const restarted=await connect(fixture.home,'agent');
  try {
    const recovered=await restarted.callTool({name:'marketplace_withdrawal_create',arguments:args});
    const result=JSON.parse(contentText(recovered)).result;
    assert.equal(result.status,'unknown');
    assert.equal(result.requestId,requestId);
    assert.equal(result.reconciliationTool,'marketplace_withdrawals_list');
    assert.match(result.next,/Do not create another request/);
    assert.equal(requests.length,before);
    assert.equal(requests.filter(row=>row.path==='/v1/agent/withdrawals/challenges').length,1);
    assert.equal(requests.filter(row=>row.path==='/v1/agent/withdrawals'&&row.method==='POST').length,1);
  } finally {
    await restarted.close(); http.close(); fixture.store.close(); await rm(fixture.home,{recursive:true,force:true});
  }
});

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
      proposal:'Exact work proposal',asset:'ATTO',callerMaxAtomic:'20'});
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
    publishAttoLimit:null,publishXnoLimit:null,applyAttoLimit:null,applyXnoLimit:null};
  const credentialPayload=['agent-credential-v2','read-only worker','90','applications:read,tasks:read','','','',''].join('\n');
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

test('V3 Shop credential grant and purchase ceilings survive private-key storage and activation', async () => {
  // Given a Shop buyer grant with files:read and one explicit ATTO purchase ceiling.
  const requestId='abababab-abab-4bab-8bab-abababababab';
  const apiKeyId='bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc';
  const challengeId='cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
  const credential={name:'shop buyer',expiresInDays:90,scopes:['files:read','products:purchase'],
    purchaseAttoLimit:'900',purchaseXnoLimit:null};
  const payload=['agent-credential-v3','shop buyer','90','files:read,products:purchase','','','','','900',''].join('\n');
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

test('V4 product publication reservation ceilings survive private storage and scoped-profile activation',async()=>{
  // Given a product publisher with an explicit cap for both native assets.
  const requestId='cdcdcdcd-1111-4111-8111-cdcdcdcdcdcd';
  const apiKeyId='dededede-2222-4222-8222-dededededede';
  const challengeId='efefefef-3333-4333-8333-efefefefefef';
  const credential={name:'shop publisher',expiresInDays:90,scopes:['products:publish'],
    productPublishAttoLimit:'20',productPublishXnoLimit:'30'};
  const payload=['agent-credential-v4','shop publisher','90','products:publish','','','','','','','20','30'].join('\n');
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

test('legacy waiting credential rotation resumes after MCP restart and saves the successor secret and grants', async () => {
  const oldId='13131313-2222-4111-8111-111111111111';
  const newId='24242424-3333-4222-8222-222222222222';
  const requestId='35353535-4444-4333-8333-333333333333';
  const secret='legacy-rotation-successor-secret';
  const grant={scopes:['tasks:read','tasks:publish','products:publish'],publishAttoLimit:'100',publishXnoLimit:null,
    applyAttoLimit:null,applyXnoLimit:null,purchaseAttoLimit:null,purchaseXnoLimit:null};
  const metadata={apiKeyId:oldId,agentId,name:'legacy worker',prefix:'legacy-prefix',...grant,
    createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+90*86_400_000).toISOString(),revokedAt:null};
  const requests=[];
  const http=await listen(async(req,res)=>{
    const body=await readBody(req);
    requests.push({method:req.method,path:req.url,authorization:req.headers.authorization,body});
    if(req.url==='/v1/agent/credentials'&&req.method==='GET') return json(res,200,[metadata]);
    if(req.url==='/v1/agent/credentials/challenges') return json(res,200,challenge(
      '46464646-5555-4444-8444-555555555555','API-key rotation',
      hash(['agent-credential-v1',accountId,identityId,'ROTATE',oldId,requestId,''])));
    if(req.url===`/v1/agent/credentials/${oldId}/rotate`&&req.method==='POST')
      return json(res,201,{apiKeyId:newId,result:'rotated',replayed:false,apiKey:secret});
    return json(res,404,{});
  });
  const fixture=await profileHome(http.origin);
  let controller=await connect(fixture.home,'agent');
  let controllerClosed=false;
  let storeClosed=false;
  try {
    const args={requestId,apiKeyId:oldId};
    const pending=JSON.parse(contentText(await controller.callTool({name:'marketplace_credentials_rotate',arguments:args}))).result;
    assert.equal(pending.status,'approval_required');
    const handoff=fixture.store.getHandoff('agent',pending.handoffId);
    assert.equal(handoff.state,'WAITING_APPROVAL');
    const handoffRequestHash=handoff.requestHash;
    const saved=JSON.parse(handoff.privatePayload);
    assert.equal(saved.context.purchaseAttoLimit,null);
    assert.equal(saved.context.purchaseXnoLimit,null);

    // Simulate a pending handoff written before Shop ceiling fields existed; keep the signed request intact.
    delete saved.context.productPublishAttoLimit;
    delete saved.context.productPublishXnoLimit;
    delete saved.context.purchaseAttoLimit;
    delete saved.context.purchaseXnoLimit;
    fixture.store.setHandoffState('agent',pending.handoffId,'WAITING_APPROVAL',JSON.stringify(saved));
    const requestPath=join(fixture.home,'approvals','agent',`${pending.handoffId}.request.json`);
    const signedRequestBytes=await readFile(requestPath,'utf8');
    const request=JSON.parse(signedRequestBytes);
    assert.equal(request.action.command.operation,'ROTATE');
    assert.equal(request.action.command.targetApiKeyId,oldId);
    await writeApprovalResponse(requestPath,request);

    // Restart the MCP process and profile store before submitting the already-approved exact operation.
    await controller.close(); controllerClosed=true;
    fixture.store.close(); storeClosed=true;
    fixture.store=await MarketplaceProfileStore.open(fixture.home); storeClosed=false;
    controller=await connect(fixture.home,'agent'); controllerClosed=false;
    const rotated=await controller.callTool({name:'marketplace_credentials_rotate',arguments:args});
    const result=JSON.parse(contentText(rotated)).result;

    // Then the original approval is submitted once and its successor secret and legacy grants persist privately.
    assert.equal(result.apiKeyId,newId);
    assert.equal(result.secretSaved,true);
    assert.equal(JSON.stringify(rotated).includes(secret),false);
    assert.equal(await readFile(requestPath,'utf8'),signedRequestBytes);
    assert.equal(fixture.store.getHandoff('agent',pending.handoffId).requestHash,handoffRequestHash);
    assert.equal(requests.filter(row=>row.method==='POST'&&row.path===`/v1/agent/credentials/${oldId}/rotate`).length,1);
    assert.equal(requests.filter(row=>row.path==='/v1/agent/credentials/challenges').length,1);
    assert.equal(requests.filter(row=>row.method==='GET'&&row.path==='/v1/agent/credentials').length,1);
    const issued=fixture.store.getIssuedCredential('agent',newId);
    assert.equal(issued.apiKey,secret);
    assert.deepEqual(issued.scopes,['products:publish','tasks:publish','tasks:read']);
    assert.equal(issued.publishAttoLimit,'100');
    assert.equal(issued.publishXnoLimit,null);
    assert.equal(issued.applyAttoLimit,null);
    assert.equal(issued.applyXnoLimit,null);
    assert.equal(issued.purchaseAttoLimit,null);
    assert.equal(issued.purchaseXnoLimit,null);
    assert.equal(issued.productPublishAttoLimit,null);
    assert.equal(issued.productPublishXnoLimit,null);
    const post=requests.find(row=>row.method==='POST'&&row.path===`/v1/agent/credentials/${oldId}/rotate`);
    assert.equal(post.body.proof.signature,await signAttoMessage(post.body.proof.message));
  } finally {
    if(!controllerClosed) await controller.close();
    if(!storeClosed) fixture.store.close();
    http.close(); await rm(fixture.home,{recursive:true,force:true});
  }
});

test('credential rotation preserves backend grants through explicit activation and scoped restart', async () => {
  const oldId='11111111-2222-4111-8111-111111111111';
  const newId='22222222-3333-4222-8222-222222222222';
  const requestId='33333333-4444-4333-8333-333333333333';
  const secret='rotated-private-api-key-secret';
  const grant={scopes:['tasks:read','tasks:publish','applications:apply'],publishAttoLimit:'100',
    publishXnoLimit:null,applyAttoLimit:'50',applyXnoLimit:'70'};
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
    assert.equal(fixture.store.getIssuedCredential('agent',newId).applyAttoLimit,'50');
    assert.equal(fixture.store.getIssuedCredential('agent',newId).applyXnoLimit,'70');
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
      assert.equal(profile.applyAttoLimit,'50');
      assert.equal(profile.applyXnoLimit,'70');
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
          expectedTaskVersion:0,proposal:'Within retained grant',asset:'ATTO',
          callerMaxAtomic:'50'}});
        assert.equal(JSON.parse(contentText(allowedApply)).result.amountAtomic,'30');
        const publish=await worker.callTool({name:'marketplace_task_publish',arguments:{
          taskId:'55555555-6666-4555-8555-555555555555',requestId:'66666666-7777-4666-8666-666666666666',expectedVersion:0}});
        assert.equal(JSON.parse(contentText(publish)).error.code,'CEILING_EXCEEDED');
        const apply=await worker.callTool({name:'marketplace_application_create',arguments:{
          taskId:'77777777-8888-4777-8777-777777777777',requestId:'dddddddd-eeee-4ddd-8ddd-ddddddddddde',
          expectedTaskVersion:0,proposal:'Over retained grant',asset:'ATTO'}});
        assert.equal(JSON.parse(contentText(apply)).error.code,'CEILING_EXCEEDED');
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
  const credentialPayload=['agent-credential-v2','lost-response worker','90','tasks:read','','','',''].join('\n');
  const binding=hash(['agent-credential-v1',accountId,identityId,'CREATE','',requestId,credentialPayload]);
  const requests=[];
  let committedKey=null;
  const metadata={apiKeyId,agentId,name:credential.name,prefix:'safe-prefix',scopes:['tasks:read'],publishAttoLimit:null,
    publishXnoLimit:null,applyAttoLimit:null,applyXnoLimit:null,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+90*86_400_000).toISOString(),revokedAt:null};
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
    {asset:'ATTO',minimum:'1000000000',taskId:'11111111-1111-4111-8111-111111111111',
      requestId:'77777777-7777-4777-8777-777777777777',updateRequestId:'13131313-1313-4131-8131-131313131313',mode:'http'},
    {asset:'XNO',minimum:'10000000000000000000000000000',taskId:'22222222-2222-4222-8222-222222222222',
      requestId:'88888888-8888-4888-8888-888888888888',updateRequestId:'24242424-2424-4242-8242-242424242424',mode:'command'},
    {asset:'XNO',minimum:'10000000000000000000000000000',taskId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      requestId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',updateRequestId:'35353535-3535-4353-8353-353535353535',mode:'legacy-missing'},
    {asset:'ATTO',minimum:'1000000000',taskId:'ffffffff-ffff-4fff-8fff-ffffffffffff',
      requestId:'abababab-abab-4bab-8bab-abababababab',updateRequestId:'46464646-4646-4464-8464-464646464646',mode:'legacy-null'},
    {asset:'XNO',minimum:'10000000000000000000000000000',taskId:'12121212-1212-4121-8121-121212121212',
      requestId:'23232323-2323-4232-8232-232323232323',updateRequestId:'57575757-5757-4575-8575-575757575757',mode:'legacy-empty'},
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
        acceptanceTerms:'A passing result',asset:scenario.asset,grossAtomic:scenario.minimum};
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
