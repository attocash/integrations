import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {chmod, mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {MarketplaceProfileStore} from '../dist/profile-store.js';

const accountId='11111111-1111-4111-8111-111111111111';
const agentId='22222222-2222-4222-8222-222222222222';
const identityId='33333333-3333-4333-8333-333333333333';
const requestId='44444444-4444-4444-8444-444444444444';
const intentId='55555555-5555-4555-8555-555555555555';
const payer='atto://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const nanoPayer='nano_3e3j5tkog48pnny9dmfzj1r16pg8t1e76dz5tmac6iq689wyjfpiij4txtdo';
const require=createRequire(import.meta.url);

test('unified ATTO funding accepts a matching browser context pair and preserves context-free exact retries', async () => {
  // Given a Nano-only controller-session profile with no linked Atto controller and a separate managed Atto payer.
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-unified-atto-'));
  const wallet=await fakeAttoWallet(home);
  let intent={asset:'ATTO',network:'atto:local',amountAtomic:'700',state:'PENDING',expiresAt:new Date(Date.now()+120_000).toISOString(),sendHash:null,payer:null,paymentState:null,receiveStatus:null};
  const calls={create:0,submit:0,paymentSignature:null,balances:0,statusReads:0,authorization:null};
  const http=await listen(async(req,res)=>{
    const body=await readBody(req);
    if(req.url==='/v1/agent/topups'&&req.method==='POST') {
      calls.create++;
      res.writeHead(402,{'content-type':'application/json','payment-required':'bWFya2V0LWNoYWxsZW5nZQ==' });
      return res.end(JSON.stringify({...intent,intentId}));
    }
    if(req.url===`/v1/agent/topups/${intentId}`&&req.method==='GET') { calls.statusReads++; return json(res,200,{...intent,intentId}); }
    if(req.url===`/v1/agent/topups/${intentId}`&&req.method==='POST') {
      calls.submit++;
      calls.paymentSignature=req.headers['payment-signature'];
      calls.authorization=req.headers.authorization;
      intent={...intent,state:'ACCEPTED',sendHash:'A'.repeat(64),payer,paymentState:'ACCEPTED'};
      if(calls.submit===1) return res.destroy();
      const receipt=Buffer.from(JSON.stringify({success:true,transaction:'A'.repeat(64),network:'atto:local',payer})).toString('base64');
      res.writeHead(200,{'content-type':'application/json','payment-response':receipt});
      return res.end(JSON.stringify({...intent,intentId}));
    }
    if(req.url==='/v1/agent/balances') { calls.balances++; return json(res,200,{atto:{availableAtomic:'700',reservedAtomic:'0'}}); }
    return json(res,404,{});
  });
  // The account's controller is Nano-only; an independent local Atto wallet can still pay its existing ATTO intent.
  await createProfile(home,http.origin,'controller-session','NANO');
  const env={...process.env,MARKETPLACE_MCP_WALLET_HOST_COMMAND:wallet.command,
    MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR:wallet.dataDirectory};
  let client=await openMarketplace(home,http.origin,env);
  try {
    // When the submit response is lost after Marketplace records the exact signed transaction, the durable journal retains it.
    const first=await client.callTool({name:'marketplace_fund',arguments:{asset:'ATTO',amountAtomic:'700',requestId,
      expectedMarketplaceOrigin:http.origin,expectedAccountId:accountId}});
    assert.equal(first.isError,true);
    assert.equal(first.structuredContent.error.code,'MARKETPLACE_UNAVAILABLE',JSON.stringify(first.structuredContent));
    assert.equal(calls.create,1);
    assert.equal(calls.submit,1);
    assert.equal(calls.authorization,'Bearer access-token-for-marketplace');
    assert.equal(calls.paymentSignature,'private-exact-atto-payment-signature');
    assert.equal(JSON.stringify(first).includes('private-exact-atto-payment-signature'),false);

    // Then a new Marketplace MCP process reconciles the same intent and never creates or submits a replacement payment.
    await client.close();
    client=await openMarketplace(home,http.origin,env);
    const status=await client.callTool({name:'marketplace_funding_status',arguments:{requestId,
      expectedMarketplaceOrigin:http.origin,expectedAccountId:accountId}});
    assert.equal(status.isError,undefined);
    assert.equal(status.structuredContent.result.status.state,'ACCEPTED');
    assert.equal(status.structuredContent.result.balances.atto.availableAtomic,'700');
    assert.equal(status.structuredContent.result.statusSource,'Fresh Marketplace API intent read');
    assert.equal(status.structuredContent.result.balancesSource,'Fresh Marketplace API account ledger read');
    assert.deepEqual(status.structuredContent.result.nativePayment,{state:'SETTLED',hash:'A'.repeat(64),failureReason:null});
    assert.equal(status.structuredContent.result.nativePaymentSource,'Managed wallet observation saved in the Marketplace MCP private journal');
    assert.equal(status.structuredContent.result.savedObservation.source,'Marketplace MCP private funding journal');
    assert.equal(status.structuredContent.result.savedObservation.journalState,'ACCEPTED');
    assert.deepEqual(Object.keys(status.structuredContent.result.savedObservation).sort(),['interpretation','journalState','source']);
    for(const field of ['localPaymentState','localPaymentStateSource','nativePaymentState','nativePaymentStateSource','nativePaymentStatus']) assert.equal(field in status.structuredContent.result,false);
    assert.equal(JSON.stringify(status).includes('paymentSignature'),false);
    const replay=await client.callTool({name:'marketplace_fund',arguments:{asset:'ATTO',amountAtomic:'700',requestId}});
    assert.equal(replay.structuredContent.result.status.state,'ACCEPTED');
    assert.equal(calls.create,1);
    assert.equal(calls.submit,1);
    assert.equal(calls.balances,2);

    const mismatch=await client.callTool({name:'marketplace_fund',arguments:{asset:'ATTO',amountAtomic:'701',requestId}});
    assert.equal(mismatch.isError,true);
    assert.equal(mismatch.structuredContent.error.code,'IDEMPOTENCY_CONFLICT');
  } finally {
    await client.close(); http.close(); await rm(home,{recursive:true,force:true});
  }

  // Given the same named funding tool under a scoped API-key profile, it refuses before any Marketplace request.
  const scopedHome=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-unified-scoped-'));
  let unauthorizedRequests=0;
  const scopedHttp=await listen(async(_req,res)=>{unauthorizedRequests++;return json(res,404,{});});
  await createProfile(scopedHome,scopedHttp.origin,'scoped-api-key');
  const scopedClient=await openMarketplace(scopedHome,scopedHttp.origin,process.env);
  try {
    const result=await scopedClient.callTool({name:'marketplace_fund',arguments:{asset:'ATTO',amountAtomic:'700',requestId}});
    assert.equal(result.isError,true);
    assert.equal(result.structuredContent.error.code,'SETUP_REQUIRED');
    assert.match(result.structuredContent.error.message,/controller-session/);
    assert.equal(unauthorizedRequests,0);
  } finally { await scopedClient.close(); scopedHttp.close(); await rm(scopedHome,{recursive:true,force:true}); }
});

test('browser funding context refuses mismatched or partial origin/account values before admission', async () => {
  // Given a controller-session profile pinned to one Marketplace account and origin.
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-browser-funding-context-'));
  let apiRequests=0;
  const http=await listen(async(_req,res)=>{apiRequests++;return json(res,404,{});});
  await createProfile(home,http.origin,'controller-session');
  const client=await openMarketplace(home,http.origin,process.env);
  try {
    const catalog=await client.listTools();
    for(const name of ['marketplace_fund','marketplace_funding_status']) {
      const tool=catalog.tools.find(value=>value.name===name);
      assert.ok(tool);
      assert.equal(tool.inputSchema.anyOf.length,2);
      const paired=tool.inputSchema.anyOf.find(branch=>branch.required?.includes('expectedMarketplaceOrigin'));
      const absent=tool.inputSchema.anyOf.find(branch=>!branch.required?.includes('expectedMarketplaceOrigin'));
      assert.ok(paired?.required?.includes('expectedAccountId'));
      assert.deepEqual(absent?.properties?.expectedMarketplaceOrigin?.not,{});
      assert.deepEqual(absent?.properties?.expectedAccountId?.not,{});
    }
    const contexts=[
      {expectedMarketplaceOrigin:'https://another-marketplace.example',expectedAccountId:accountId},
      {expectedMarketplaceOrigin:http.origin,expectedAccountId:'99999999-9999-4999-8999-999999999999'},
      {expectedMarketplaceOrigin:http.origin},
      {expectedAccountId:accountId},
    ];
    // When browser funding or recovery supplies a mismatched pair or only one context field.
    for(const name of ['marketplace_fund','marketplace_funding_status']) {
      for(const context of contexts) {
        const result=await client.callTool({name,arguments:{requestId,
          ...(name==='marketplace_fund'?{asset:'ATTO',amountAtomic:'700',network:'atto:local'}:{}),...context}});
        // Then it refuses with actionable pairing guidance before any mutation, API request, or wallet call.
        assert.equal(result.isError,true);
        if(context.expectedMarketplaceOrigin===undefined||context.expectedAccountId===undefined) {
          const visibleError=result.content.filter(item=>item.type==='text').map(item=>item.text).join('\n');
          assert.match(visibleError,/Provide both expectedMarketplaceOrigin and expectedAccountId, or omit both\./);
        } else {
          assert.equal(result.structuredContent.error.code,'FUNDING_CONTEXT_MISMATCH');
        }
        assert.equal(apiRequests,0);
      }
    }
    const store=await MarketplaceProfileStore.open(home);
    try { assert.equal(store.getMutationByRequestId('agent',requestId),null); }
    finally { store.close(); }
  } finally {await client.close();http.close();await rm(home,{recursive:true,force:true});}
});

test('a new profile alias is directed to the matching saved funding profile without touching its journal', async () => {
  // Given a saved funding journal and a second controller profile for the same Marketplace origin, account, and identity.
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-funding-profile-alias-'));
  let apiRequests=0;
  const http=await listen(async(_req,res)=>{apiRequests++;return json(res,404,{});});
  await createProfile(home,http.origin,'controller-session');
  await createProfile(home,http.origin,'controller-session','ATTO','new-controller');
  const handle='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  await seedFundingMutation(home,'agent',requestId,handle);
  const store=await MarketplaceProfileStore.open(home);
  const savedMutation=store.getMutationByRequestId('agent',requestId);
  const savedJournal=store.getHandoff('agent',handle);
  store.close();
  const client=await openMarketplace(home,http.origin,process.env,undefined,'new-controller');
  try {
    // When either tool is called from the new alias, it names only the matching old profile and stops before admission.
    for(const name of ['marketplace_fund','marketplace_funding_status']) {
      const result=await client.callTool({name,arguments:{requestId,
        ...(name==='marketplace_fund'?{asset:'ATTO',amountAtomic:'700'}:{})}});
      assert.equal(result.isError,true);
      assert.equal(result.structuredContent.error.code,'FUNDING_PROFILE_ALIAS');
      assert.match(result.structuredContent.error.message,/`agent`/);
      assert.match(result.structuredContent.error.message,/marketplace_funding_status/);
      assert.match(result.structuredContent.error.message,/no Marketplace or wallet request/i);
      assert.equal(apiRequests,0);
    }
    const after=await MarketplaceProfileStore.open(home);
    try {
      assert.equal(after.getMutationByRequestId('new-controller',requestId),null);
      assert.deepEqual(after.getMutationByRequestId('agent',requestId),savedMutation);
      assert.deepEqual(after.getHandoff('agent',handle),savedJournal);
    } finally { after.close(); }
  } finally {await client.close();http.close();await rm(home,{recursive:true,force:true});}
});

test('concurrent matching funding reservations admit one profile and leave the loser untouched', async () => {
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-funding-alias-race-'));
  let apiRequests=0;
  const http=await listen(async(_req,res)=>{apiRequests++;return json(res,404,{});});
  const wallet=await fakeAttoWallet(home);
  const raceRequestId='99999999-9999-4999-8999-999999999999';
  const unrelatedRequestId='88888888-8888-4888-8888-888888888888';
  await createProfile(home,http.origin,'controller-session','ATTO','racer-a');
  await createProfile(home,http.origin,'controller-session','ATTO','racer-b');
  await createProfile(home,'https://other-marketplace.example','controller-session','ATTO','other-origin');
  await createProfile(home,http.origin,'controller-session','ATTO','other-account',
    {accountId:'99999999-9999-4999-8999-999999999998'});
  await createProfile(home,http.origin,'controller-session','ATTO','other-identity',
    {identityId:'88888888-8888-4888-8888-888888888887'});
  await seedAttoFundingMutation(home,'other-origin',unrelatedRequestId);
  await seedAttoFundingMutation(home,'other-account',unrelatedRequestId);
  await seedAttoFundingMutation(home,'other-identity',unrelatedRequestId);

  // Separate Node processes enter BEGIN IMMEDIATE only after both are ready, exercising the cross-connection race.
  const workers=['racer-a','racer-b'].map(profileId=>startFundingReservationWorker(home,profileId,raceRequestId));
  try {
    await Promise.all(workers.map(worker=>worker.ready));
    workers.forEach(worker=>worker.release());
    const outcomes=await Promise.all(workers.map(worker=>worker.result));
    assert.equal(outcomes.filter(value=>value.ok).length,1,JSON.stringify(outcomes));
    assert.equal(outcomes.filter(value=>value.code==='FUNDING_PROFILE_ALIAS').length,1,JSON.stringify(outcomes));
    const winner=outcomes[0].ok?'racer-a':'racer-b';
    const loser=winner==='racer-a'?'racer-b':'racer-a';
    const store=await MarketplaceProfileStore.open(home);
    try {
      assert.ok(store.getMutationByRequestId(winner,raceRequestId));
      assert.equal(store.getMutationByRequestId(loser,raceRequestId),null);
      // Existing funding IDs from other origins, accounts, or identities do not block an independent reservation.
      const profile=store.getProfile('racer-a');
      assert.equal(store.beginMutation({profileId:'racer-a',requestId:unrelatedRequestId,
        operation:'marketplace-fund',target:profile.accountId,requestHash:'f'.repeat(64)},profile.accountId).state,'PENDING');
      assert.ok(store.getMutationByRequestId('racer-a',unrelatedRequestId));
    } finally {store.close();}

    const env={...process.env,MARKETPLACE_MCP_WALLET_HOST_COMMAND:wallet.command,
      MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR:wallet.dataDirectory};
    const client=await openMarketplace(home,http.origin,env,undefined,loser);
    try {
      const rejected=await client.callTool({name:'marketplace_fund',arguments:{asset:'ATTO',requestId:raceRequestId,
        amountAtomic:'700',network:'atto:local'}});
      assert.equal(rejected.isError,true);
      assert.equal(rejected.structuredContent.error.code,'FUNDING_PROFILE_ALIAS');
      assert.match(rejected.structuredContent.error.message,new RegExp(winner));
      assert.match(rejected.structuredContent.error.message,/marketplace_funding_status/);
      assert.equal(apiRequests,0);
      assert.deepEqual(await wallet.calls(),{statuses:0,payments:0});
      const after=await MarketplaceProfileStore.open(home);
      try {assert.equal(after.getMutationByRequestId(loser,raceRequestId),null);}
      finally {after.close();}
    } finally {await client.close();}
  } finally {
    for(const worker of workers) worker.release();
    http.close();
    await rm(home,{recursive:true,force:true});
  }
});

test('funding profile alias lookup does not reveal records from another origin, account, or identity', async () => {
  // Given otherwise matching saved request IDs under different Marketplace origins, accounts, and identities.
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-funding-profile-scope-'));
  let apiRequests=0;
  const origin='https://marketplace.example';
  const http=await listen(async(_req,res)=>{apiRequests++;return json(res,404,{});});
  await createProfile(home,origin,'controller-session');
  await createProfile(home,'https://other-marketplace.example','controller-session','ATTO','other-origin');
  await createProfile(home,origin,'controller-session','ATTO','other-account',
    {accountId:'99999999-9999-4999-8999-999999999999'});
  await createProfile(home,origin,'controller-session','ATTO','other-identity',
    {identityId:'88888888-8888-4888-8888-888888888888'});
  await seedFundingMutation(home,'other-origin',requestId,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  await seedFundingMutation(home,'other-account',requestId,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  await seedFundingMutation(home,'other-identity',requestId,'cccccccccccccccccccccccccccccccc');
  const client=await openMarketplace(home,origin,process.env);
  try {
    const result=await client.callTool({name:'marketplace_funding_status',arguments:{requestId}});
    assert.equal(result.isError,true);
    assert.equal(result.structuredContent.error.code,'FUNDING_NOT_FOUND');
    const message=JSON.stringify(result.structuredContent);
    assert.equal(message.includes('other-origin'),false);
    assert.equal(message.includes('other-account'),false);
    assert.equal(message.includes('other-identity'),false);
    assert.equal(apiRequests,0);
  } finally {await client.close();http.close();await rm(home,{recursive:true,force:true});}
});

test('unified XNO funding recovers a lost submit response from its saved payer handoff', async () => {
  // Given a controller-session account, shared private handoff directory, and one Marketplace-issued XNO challenge.
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-unified-xno-'));
  const handoffDirectory=join(home,'handoffs');
  await mkdir(handoffDirectory,{mode:0o700});
  const nanoCommand=await fakeNanoPayer(home);
  const calls={create:0,submit:0,signature:null,networks:[]};
  const amountAtomic='987654321';
  const expiry=new Date(Date.now()+120_000).toISOString();
  let intent={asset:'XNO',network:'nano:dev',amountAtomic,state:'PENDING',expiresAt:expiry,sendHash:null,payer:null,paymentState:null,receiveStatus:null};
  const http=await listen(async(req,res)=>{
    const body=await readBody(req);
    if(req.url==='/v1/agent/topups'&&req.method==='POST') {
      calls.create++; calls.networks.push(body.network);
      const challenge=xnoChallenge(`${http.origin}/v1/agent/topups/${intentId}`,amountAtomic,body.paymentIdentifier);
      res.writeHead(402,{'content-type':'application/json','payment-required':Buffer.from(JSON.stringify(challenge)).toString('base64')});
      return res.end(JSON.stringify({...intent,intentId}));
    }
    if(req.url===`/v1/agent/topups/${intentId}`&&req.method==='GET') return json(res,200,{...intent,intentId});
    if(req.url===`/v1/agent/topups/${intentId}`&&req.method==='POST') {
      calls.submit++;calls.signature=req.headers['payment-signature'];
      intent={...intent,state:'ACCEPTED',sendHash:'A'.repeat(64),payer:nanoPayer,paymentState:'ACCEPTED'};
      if(calls.submit===1) return res.destroy();
      const receipt=Buffer.from(JSON.stringify({success:true,transaction:'A'.repeat(64),network:'nano:dev',payer:nanoPayer})).toString('base64');
      res.writeHead(200,{'content-type':'application/json','payment-response':receipt});
      return res.end(JSON.stringify({...intent,intentId}));
    }
    if(req.url==='/v1/agent/balances') return json(res,200,{xno:{availableAtomic:amountAtomic,reservedAtomic:'0'}});
    return json(res,404,{});
  });
  await createProfile(home,http.origin,'controller-session');
  const env={...process.env,MARKETPLACE_MCP_WALLET_HOST_COMMAND:nanoCommand,MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR:handoffDirectory};
  let client=await openMarketplace(home,http.origin,env,handoffDirectory);
  try {
    // When the payer has saved the exact response but the Marketplace submit acknowledgement is lost, the journal remains bound.
    const first=await client.callTool({name:'marketplace_fund',arguments:{asset:'XNO',amountAtomic,requestId,network:'nano:dev'}});
    assert.equal(first.isError,true);
    assert.equal(first.structuredContent.error.code,'MARKETPLACE_UNAVAILABLE');
    assert.equal(calls.create,1);
    assert.equal(calls.submit,1);
    assert.deepEqual(calls.networks,['nano:dev']);
    assert.equal(typeof calls.signature,'string');
    assert.equal(JSON.stringify(first).includes('paymentSignature'),false);

    // Then a fresh Marketplace MCP process reconciles the original intent and does not create or submit a replacement payment.
    await client.close();
    client=await openMarketplace(home,http.origin,env,handoffDirectory);
    const status=await client.callTool({name:'marketplace_funding_status',arguments:{requestId}});
    assert.equal(status.structuredContent.result.status.state,'ACCEPTED');
    assert.equal(status.structuredContent.result.network,'nano:dev');
    assert.equal(JSON.stringify(status).includes(calls.signature),false);
    const replay=await client.callTool({name:'marketplace_fund',arguments:{asset:'XNO',amountAtomic,requestId,network:'nano:dev'}});
    assert.equal(replay.structuredContent.result.status.state,'ACCEPTED');
    assert.equal(calls.create,1);
    assert.equal(calls.submit,1);
    const changedRoute=await client.callTool({name:'marketplace_fund',arguments:{asset:'XNO',amountAtomic,requestId,network:'nano:mainnet'}});
    assert.equal(changedRoute.isError,true);
    assert.equal(changedRoute.structuredContent.error.code,'IDEMPOTENCY_CONFLICT');
    assert.equal(calls.create,1);
  } finally {
    await client.close();http.close();await rm(home,{recursive:true,force:true});
  }
});

for (const scenario of [
  { reason:'settlement_pending',state:'PENDING',httpStatus:202 },
  { reason:'error_block_awaiting_confirmation',state:'PENDING',httpStatus:202 },
  { reason:'error_timeout_expired',state:'PENDING',httpStatus:202 },
  { reason:'error_block_already_confirmed',state:'ACCEPTED',httpStatus:200 },
  { reason:'error_timeout_expired',state:'REJECTED',httpStatus:409,invalid:true },
  { reason:'error_block_already_confirmed',state:'PENDING',httpStatus:200,invalid:true },
  { reason:'error_block_awaiting_confirmation',state:'PENDING',httpStatus:202,wrongHash:true,invalid:true },
]) test(`Nano receipt ${scenario.reason} ${scenario.state}${scenario.wrongHash?' wrong hash':''} preserves exact funding recovery`, async () => {
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-nano-receipt-'));
  const directory=join(home,'handoffs'); await mkdir(directory,{mode:0o700});
  const command=await fakeNanoPayer(home), amountAtomic='40', expiry=new Date(Date.now()+120000).toISOString();
  let intent={intentId,asset:'XNO',network:'nano:dev',amountAtomic,state:'PENDING',expiresAt:expiry,
    sendHash:null,payer:null,paymentState:null,receiveStatus:null};
  const calls={create:0,submit:0,signature:null};
  const http=await listen(async(req,res)=>{
    await readBody(req);
    if(req.url==='/v1/agent/topups'&&req.method==='POST') {
      calls.create++;
      const challenge=xnoChallenge(`${http.origin}/v1/agent/topups/${intentId}`,amountAtomic,requestId);
      challenge.extensions['marketplace-account-binding']={schema:{type:'object'},info:{required:true,version:1,
        domain:'marketplace.nano.exact.state.v1',accountId,intentId,paymentIdentifier:requestId,intentExpiresAt:expiry}};
      res.writeHead(402,{'content-type':'application/json','payment-required':Buffer.from(JSON.stringify(challenge)).toString('base64')});
      return res.end(JSON.stringify(intent));
    }
    if(req.url===`/v1/agent/topups/${intentId}`&&req.method==='GET') return json(res,200,intent);
    if(req.url===`/v1/agent/topups/${intentId}`&&req.method==='POST') {
      calls.submit++; calls.signature=req.headers['payment-signature'];
      intent={...intent,state:scenario.state,paymentState:scenario.state,sendHash:'A'.repeat(64),payer:nanoPayer};
      const receipt={success:false,errorReason:scenario.reason,transaction:(scenario.wrongHash?'B':'A').repeat(64),network:'nano:dev',payer:nanoPayer};
      res.writeHead(scenario.httpStatus,{'content-type':'application/json','payment-response':Buffer.from(JSON.stringify(receipt)).toString('base64')});
      return res.end(JSON.stringify(intent));
    }
    if(req.url==='/v1/agent/balances') return json(res,200,{xno:{availableAtomic:scenario.state==='ACCEPTED'?amountAtomic:'0',reservedAtomic:'0'}});
    return json(res,404,{});
  });
  await createProfile(home,http.origin,'controller-session');
  const env={...process.env,MARKETPLACE_MCP_WALLET_HOST_COMMAND:command,MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR:directory};
  let client=await openMarketplace(home,http.origin,env,directory);
  try {
    const args={asset:'XNO',amountAtomic,requestId,network:'nano:dev'};
    const result=await client.callTool({name:'marketplace_fund',arguments:args});
    assert.equal(calls.create,1); assert.equal(calls.submit,1);
    if(scenario.invalid) {
      assert.equal(result.isError,true);
      assert.equal(result.structuredContent.error.code,'PAYMENT_BINDING');
    } else {
      assert.notEqual(result.isError,true,JSON.stringify(result.structuredContent));
      assert.equal(result.structuredContent.result.settlementState,scenario.state);
      await client.close(); client=await openMarketplace(home,http.origin,env,directory);
      const replay=await client.callTool({name:'marketplace_fund',arguments:args});
      assert.equal(replay.structuredContent.result.status.state,scenario.state);
      assert.equal(calls.create,1); assert.equal(calls.submit,1);
    }
    const payment=JSON.parse(Buffer.from(calls.signature,'base64'));
    assert.deepEqual(Object.keys(payment.payload),['block']);
    assert.equal(payment.extensions['marketplace-account-binding'].info.accountId,accountId);
    assert.equal(payment.extensions['marketplace-account-binding'].info.intentExpiresAt,expiry);
  } finally { await client.close(); http.close(); await rm(home,{recursive:true,force:true}); }
});

test('explicit ATTO funding network is sent to Marketplace, shown in status, and bound to requestId', async () => {
  // Given a Marketplace with one explicitly requested ATTO route and an intent that does not need payment.
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-funding-network-'));
  const expiry=new Date(Date.now()+120_000).toISOString();
  const requests=[];
  const intent={asset:'ATTO',network:'atto:local',amountAtomic:'700',state:'PENDING',expiresAt:expiry,
    sendHash:null,payer:null,paymentState:null,receiveStatus:null,intentId};
  const http=await listen(async(req,res)=>{
    const body=await readBody(req);
    requests.push({method:req.method,path:req.url,body});
    if(req.url==='/v1/agent/topups'&&req.method==='POST') return json(res,202,intent);
    if(req.url===`/v1/agent/topups/${intentId}`&&req.method==='GET') return json(res,200,intent);
    if(req.url==='/v1/agent/balances') return json(res,200,{atto:{availableAtomic:'0',reservedAtomic:'700'}});
    return json(res,404,{});
  });
  await createProfile(home,http.origin,'controller-session','NANO');
  let client=await openMarketplace(home,http.origin,process.env);
  try {
    // When an explicit route is requested, it is forwarded and becomes part of the durable request identity.
    const result=await client.callTool({name:'marketplace_fund',arguments:{asset:'ATTO',amountAtomic:'700',requestId,network:'atto:local'}});
    assert.equal(result.isError,undefined,JSON.stringify(result.structuredContent));
    assert.equal(result.structuredContent.result.network,'atto:local');
    assert.equal(requests.find(row=>row.path==='/v1/agent/topups'&&row.method==='POST').body.network,'atto:local');
    await client.close();
    client=await openMarketplace(home,http.origin,process.env);
    const status=await client.callTool({name:'marketplace_funding_status',arguments:{requestId}});
    assert.equal(status.structuredContent.result.network,'atto:local');

    // A different route with the same request ID is rejected before Marketplace can create another intent.
    const changed=await client.callTool({name:'marketplace_fund',arguments:{asset:'ATTO',amountAtomic:'700',requestId,network:'atto:dev'}});
    assert.equal(changed.isError,true);
    assert.equal(changed.structuredContent.error.code,'IDEMPOTENCY_CONFLICT');
    const invalidAssetRoute=await client.callTool({name:'marketplace_fund',arguments:{asset:'XNO',amountAtomic:'700',requestId:'66666666-6666-4666-8666-666666666666',network:'atto:local'}});
    assert.equal(invalidAssetRoute.isError,true);
    assert.equal(invalidAssetRoute.structuredContent.error.code,'NETWORK_ASSET_MISMATCH');
    assert.equal(requests.filter(row=>row.path==='/v1/agent/topups'&&row.method==='POST').length,1);
  } finally { await client.close();http.close();await rm(home,{recursive:true,force:true}); }
});

test('a definitively failed Marketplace intent stays terminal and does not create a replacement payment', async () => {
  // Given an exact funding request whose native payment has failed definitively at Marketplace.
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-funding-failed-'));
  const amountAtomic='700';
  const calls={create:0};
  const expiredAt=new Date(Date.now()+120_000).toISOString();
  const failed={asset:'ATTO',network:'atto:local',amountAtomic,state:'REJECTED',expiresAt:expiredAt,
    sendHash:'A'.repeat(64),payer,paymentState:'REJECTED',receiveStatus:null,intentId};
  const http=await listen(async(req,res)=>{
    if(req.url==='/v1/agent/topups'&&req.method==='POST') {
      calls.create++;
      res.writeHead(402,{'content-type':'application/json','payment-required':'bWFya2V0LWNoYWxsZW5nZQ=='});
      return res.end(JSON.stringify({...failed,state:'PENDING',sendHash:null,payer:null,paymentState:null,receiveStatus:null}));
    }
    if(req.url===`/v1/agent/topups/${intentId}`&&req.method==='GET') return json(res,200,failed);
    if(req.url==='/v1/agent/balances') return json(res,200,{atto:{availableAtomic:'0',reservedAtomic:'0'}});
    return json(res,404,{});
  });
  await createProfile(home,http.origin,'controller-session');
  const client=await openMarketplace(home,http.origin,process.env);
  try {
    // When Marketplace confirms terminal failure, Marketplace MCP reports it instead of replaying the same saved payment.
    const result=await client.callTool({name:'marketplace_fund',arguments:{asset:'ATTO',amountAtomic,requestId}});
    assert.equal(result.structuredContent.result.status.state,'REJECTED');
    assert.equal(result.structuredContent.result.status.paymentState,'REJECTED');
    assert.match(result.structuredContent.result.next,/before starting another funding request/);
    const status=await client.callTool({name:'marketplace_funding_status',arguments:{requestId}});
    assert.equal(status.structuredContent.result.status.paymentState,'REJECTED');
    assert.match(status.structuredContent.result.next,/before starting another funding request/);
    const replay=await client.callTool({name:'marketplace_fund',arguments:{asset:'ATTO',amountAtomic,requestId}});
    assert.equal(replay.structuredContent.result.status.paymentState,'REJECTED');
    assert.equal(calls.create,1);
  } finally { await client.close();http.close();await rm(home,{recursive:true,force:true}); }
});

test('a native ATTO rejection is journaled as terminal and the same request is never signed again', async () => {
  // Given a Marketplace intent with a published transaction and a managed wallet's terminal native rejection.
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-atto-native-rejected-'));
  const amountAtomic='700';
  const hash='A'.repeat(64);
  const wallet=await fakeAttoWallet(home);
  await wallet.setStatus(requestId,{requestId,intentId,paymentIdentifier:requestId,network:'atto:local',amountAtomic,
    payer,hash,paymentState:'FAILED',nativeState:'rejected',failureReason:'NATIVE_TRANSACTION_REJECTED'});
  const expiry=new Date(Date.now()+120_000).toISOString();
  const intent={asset:'ATTO',network:'atto:local',amountAtomic,state:'PENDING',expiresAt:expiry,
    sendHash:hash,payer,paymentState:'PENDING',receiveStatus:null};
  const calls={create:0,submit:0};
  const http=await listen(async(req,res)=>{
    if(req.url==='/v1/agent/topups'&&req.method==='POST') {
      calls.create++;
      res.writeHead(402,{'content-type':'application/json','payment-required':'bWFya2V0LWNoYWxsZW5nZQ=='});
      return res.end(JSON.stringify({...intent,state:'PENDING',sendHash:null,payer:null,paymentState:null,intentId}));
    }
    if(req.url===`/v1/agent/topups/${intentId}`&&req.method==='GET') return json(res,200,{...intent,intentId});
    if(req.url===`/v1/agent/topups/${intentId}`&&req.method==='POST') { calls.submit++;return json(res,500,{}); }
    if(req.url==='/v1/agent/balances') return json(res,200,{atto:{availableAtomic:'0',reservedAtomic:'700'}});
    return json(res,404,{});
  });
  await createProfile(home,http.origin,'controller-session','NANO');
  const env={...process.env,MARKETPLACE_MCP_WALLET_HOST_COMMAND:wallet.command,
    MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR:wallet.dataDirectory};
  let client=await openMarketplace(home,http.origin,env);
  try {
    // When native reconciliation rejects the saved transaction, Marketplace MCP saves a signature-free terminal journal.
    const first=await client.callTool({name:'marketplace_fund',arguments:{asset:'ATTO',amountAtomic,requestId}});
    assert.equal(first.isError,undefined,JSON.stringify(first.structuredContent));
    assert.deepEqual(first.structuredContent.result.nativePayment,{state:'REJECTED',hash,failureReason:'NATIVE_TRANSACTION_REJECTED'});
    assert.match(first.structuredContent.result.next,/will not be signed or submitted again/);
    assert.equal(JSON.stringify(first).includes('paymentSignature'),false);
    assert.equal(calls.submit,0);
    assert.equal((await wallet.calls()).payments,0);

    // After restart, a missing wallet status cannot erase the saved rejection or authorize a replacement signature.
    await wallet.clearStatus(requestId);
    await client.close();
    client=await openMarketplace(home,http.origin,env);
    const status=await client.callTool({name:'marketplace_funding_status',arguments:{requestId}});
    assert.equal(status.structuredContent.result.nativePayment.state,'REJECTED');
    assert.equal(status.structuredContent.result.nativePayment.failureReason,'NATIVE_TRANSACTION_REJECTED');
    const replay=await client.callTool({name:'marketplace_fund',arguments:{asset:'ATTO',amountAtomic,requestId}});
    assert.equal(replay.structuredContent.result.nativePayment.state,'REJECTED');
    assert.equal(calls.create,1);
    assert.equal(calls.submit,0);
    assert.equal((await wallet.calls()).payments,0);
  } finally { await client.close();http.close();await rm(home,{recursive:true,force:true}); }
});

for (const observedHash of [null, 'A'.repeat(64)]) {
  test(`unsigned ATTO expiry ${observedHash ? 'cannot replace an observed native transaction' : 'stays terminal after restart without claiming native rejection'}`, async () => {
    const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-unsigned-expiry-'));
    const amountAtomic='700',wallet=await fakeAttoWallet(home);
    const expiry={requestId,intentId,paymentIdentifier:requestId,network:'atto:local',amountAtomic,
      payer,hash:null,paymentState:'FAILED',nativeState:'challenged',failureReason:'MARKETPLACE_CHALLENGE_EXPIRED'};
    await wallet.setStatus(requestId,expiry);
    const intent={intentId,asset:'ATTO',network:'atto:local',amountAtomic,state:'PENDING',expiresAt:new Date(Date.now()+120000).toISOString(),
      sendHash:observedHash,payer:observedHash?payer:null,paymentState:observedHash?'PENDING':null,receiveStatus:null};
    const calls={create:0,submit:0};
    const http=await listen(async(req,res)=>{
      if(req.url==='/v1/agent/topups'&&req.method==='POST') {
        calls.create++;res.writeHead(402,{'content-type':'application/json','payment-required':'bWFya2V0LWNoYWxsZW5nZQ=='});
        return res.end(JSON.stringify({...intent,sendHash:null,payer:null,paymentState:null}));
      }
      if(req.url===`/v1/agent/topups/${intentId}`&&req.method==='GET')return json(res,200,intent);
      if(req.url===`/v1/agent/topups/${intentId}`&&req.method==='POST'){calls.submit++;return json(res,500,{});}
      if(req.url==='/v1/agent/balances')return json(res,200,{atto:{availableAtomic:'0',reservedAtomic:'0'}});
      return json(res,404,{});
    });
    await createProfile(home,http.origin,'controller-session','NANO');
    const env={...process.env,MARKETPLACE_MCP_WALLET_HOST_COMMAND:wallet.command,MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR:wallet.dataDirectory};
    let client=await openMarketplace(home,http.origin,env);
    try {
      const first=await client.callTool({name:'marketplace_fund',arguments:{asset:'ATTO',amountAtomic,requestId}});
      if(observedHash){assert.equal(first.isError,true);assert.equal(first.structuredContent.error.code,'FUNDING_BINDING');}
      else {
        assert.equal(first.isError,undefined,JSON.stringify(first.structuredContent));
        assert.deepEqual(first.structuredContent.result.nativePayment,{state:'REJECTED',hash:null,failureReason:'CHALLENGE_EXPIRED'});
        assert.match(first.structuredContent.result.next,/expired before signing/);
        await wallet.clearStatus(requestId);await client.close();client=await openMarketplace(home,http.origin,env);
        const status=await client.callTool({name:'marketplace_funding_status',arguments:{requestId}});
        assert.deepEqual(status.structuredContent.result.nativePayment,{state:'REJECTED',hash:null,failureReason:'CHALLENGE_EXPIRED'});
        const replay=await client.callTool({name:'marketplace_fund',arguments:{asset:'ATTO',amountAtomic,requestId}});
        assert.equal(replay.structuredContent.result.nativePayment.state,'REJECTED');
      }
      assert.equal(calls.create,1);assert.equal(calls.submit,0);assert.equal((await wallet.calls()).payments,0);
    } finally {await client.close();http.close();await rm(home,{recursive:true,force:true});}
  });
}

test('successful ATTO credit triggers best-effort wallet status reconciliation', async () => {
  // Given a fresh Marketplace intent and a managed wallet that reports native confirmation after payment.
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-atto-post-credit-'));
  const amountAtomic='700';
  const wallet=await fakeAttoWallet(home);
  const expiry=new Date(Date.now()+120_000).toISOString();
  let intent={asset:'ATTO',network:'atto:local',amountAtomic,state:'PENDING',expiresAt:expiry,
    sendHash:null,payer:null,paymentState:null,receiveStatus:null};
  const calls={create:0,submit:0};
  const http=await listen(async(req,res)=>{
    const body=await readBody(req);
    if(req.url==='/v1/agent/topups'&&req.method==='POST') {
      calls.create++;
      res.writeHead(402,{'content-type':'application/json','payment-required':'bWFya2V0LWNoYWxsZW5nZQ=='});
      return res.end(JSON.stringify({...intent,intentId}));
    }
    if(req.url===`/v1/agent/topups/${intentId}`&&req.method==='GET') return json(res,200,{...intent,intentId});
    if(req.url===`/v1/agent/topups/${intentId}`&&req.method==='POST') {
      calls.submit++;
      assert.equal(body,null);
      intent={...intent,state:'ACCEPTED',sendHash:'A'.repeat(64),payer,paymentState:'ACCEPTED'};
      const receipt=Buffer.from(JSON.stringify({success:true,transaction:'A'.repeat(64),network:'atto:local',payer})).toString('base64');
      res.writeHead(200,{'content-type':'application/json','payment-response':receipt});
      return res.end(JSON.stringify({...intent,intentId}));
    }
    if(req.url==='/v1/agent/balances') return json(res,200,{atto:{availableAtomic:amountAtomic,reservedAtomic:'0'}});
    return json(res,404,{});
  });
  await createProfile(home,http.origin,'controller-session','NANO');
  const env={...process.env,MARKETPLACE_MCP_WALLET_HOST_COMMAND:wallet.command,
    MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR:wallet.dataDirectory};
  const client=await openMarketplace(home,http.origin,env);
  try {
    // When Marketplace credits the payment, MCP performs one more native-status read and exposes only its state.
    const result=await client.callTool({name:'marketplace_fund',arguments:{asset:'ATTO',amountAtomic,requestId}});
    assert.equal(result.isError,undefined,JSON.stringify(result.structuredContent));
    assert.equal(result.structuredContent.result.status.state,'ACCEPTED');
    assert.equal(result.structuredContent.result.statusSource,'Marketplace API response to payment submission (POST)');
    assert.equal(result.structuredContent.result.balancesSource,'Fresh Marketplace API account ledger read');
    assert.deepEqual(result.structuredContent.result.nativePayment,{state:'SETTLED',hash:'A'.repeat(64),failureReason:null});
    assert.equal((await wallet.calls()).statuses,2);
    assert.equal((await wallet.calls()).payments,1);
    assert.equal(JSON.stringify(result).includes('paymentSignature'),false);
    assert.equal(calls.create,1);
    assert.equal(calls.submit,1);
  } finally { await client.close();http.close();await rm(home,{recursive:true,force:true}); }
});

for (const asset of ['ATTO','XNO']) {
  test(`${asset} submit handles Marketplace's immediate 409 native failure without replaying payment`, async () => {
    const home=await mkdtemp(join(tmpdir(),`atto-marketplace-mcp-submit-failed-${asset.toLowerCase()}-`));
    const amountAtomic='700';
    const network=asset==='ATTO'?'atto:local':'nano:dev';
    const paymentPayer=asset==='ATTO'?payer:nanoPayer;
    const handoffDirectory=join(home,'handoffs');
    await mkdir(handoffDirectory,{mode:0o700});
    const wallet=asset==='ATTO'?await fakeAttoWallet(home):undefined;
    const nanoCommand=asset==='XNO'?await fakeNanoPayer(home):undefined;
    const env={...process.env,MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR:handoffDirectory,
      ...(wallet?{MARKETPLACE_MCP_WALLET_HOST_COMMAND:wallet.command,MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR:wallet.dataDirectory}:{}),
      ...(nanoCommand?{MARKETPLACE_MCP_WALLET_HOST_COMMAND:nanoCommand}:{})};
    const expiry=new Date(Date.now()+120_000).toISOString();
    let intent={asset,network,amountAtomic,state:'PENDING',expiresAt:expiry,sendHash:null,payer:null,paymentState:null,receiveStatus:null};
    const calls={create:0,submit:0};
    const http=await listen(async(req,res)=>{
      const body=await readBody(req);
      if(req.url==='/v1/agent/topups'&&req.method==='POST') {
        calls.create++;
        const challenge=asset==='ATTO'?'bWFya2V0LWNoYWxsZW5nZQ=='
          :Buffer.from(JSON.stringify(xnoChallenge(`${http.origin}/v1/agent/topups/${intentId}`,amountAtomic,body.paymentIdentifier))).toString('base64');
        res.writeHead(402,{'content-type':'application/json','payment-required':challenge});
        return res.end(JSON.stringify({...intent,intentId}));
      }
      if(req.url===`/v1/agent/topups/${intentId}`&&req.method==='GET') return json(res,200,{...intent,intentId});
      if(req.url===`/v1/agent/topups/${intentId}`&&req.method==='POST') {
        calls.submit++;
        intent={...intent,state:'REJECTED',sendHash:'A'.repeat(64),payer:paymentPayer,paymentState:'REJECTED',receiveStatus:null};
        const receipt=Buffer.from(JSON.stringify({success:false,errorReason:asset==='XNO'?'error_previous_not_frontier':'invalid_transaction_state',
          transaction:'A'.repeat(64),network,payer:paymentPayer})).toString('base64');
        res.writeHead(409,{'content-type':'application/json','payment-response':receipt});
        return res.end(JSON.stringify({...intent,intentId}));
      }
      if(req.url==='/v1/agent/balances') return json(res,200,{[asset.toLowerCase()]:{availableAtomic:'0',reservedAtomic:'0'}});
      return json(res,404,{});
    });
    await createProfile(home,http.origin,'controller-session');
    const client=await openMarketplace(home,http.origin,env,handoffDirectory);
    try {
      const result=await client.callTool({name:'marketplace_fund',arguments:{asset,amountAtomic,requestId}});
      assert.equal(result.isError,undefined,JSON.stringify(result.structuredContent));
      assert.equal(result.structuredContent.result.settlementState,'REJECTED');
      assert.equal(result.structuredContent.result.statusSource,'Marketplace API response to payment submission (POST)');
      assert.equal(result.structuredContent.result.status.paymentState,'REJECTED');
      assert.match(result.structuredContent.result.next,/before starting another funding request/);
      const replay=await client.callTool({name:'marketplace_fund',arguments:{asset,amountAtomic,requestId}});
      assert.equal(replay.structuredContent.result.status.paymentState,'REJECTED');
      assert.equal(calls.create,1);
      assert.equal(calls.submit,1);
    } finally { await client.close();http.close();await rm(home,{recursive:true,force:true}); }
  });
}

async function createProfile(home,origin,authMode,controllerNetwork='ATTO',profileId='agent',
  {accountId:profileAccountId=accountId,identityId:profileIdentityId=identityId}={}) {
  const store=await MarketplaceProfileStore.open(home);
  try {
    store.createProfile({id:profileId,origin,audience:'marketplace-agent-api',accountId:profileAccountId,agentId,identityId:profileIdentityId,
      controllerNetwork,controllerAddress:controllerNetwork==='ATTO'?`atto://${'a'.repeat(61)}`:nanoPayer,controllerIndex:7,authMode,
      ...(authMode==='controller-session'?{accessToken:'access-token-for-marketplace',accessExpiresAt:Date.now()+120_000,
        refreshToken:'refresh-token-for-marketplace',refreshExpiresAt:Date.now()+240_000}:{apiKey:'scoped-api-key-value',apiScopes:['balances:read']})});
  } finally { store.close(); }
}

async function seedFundingMutation(home,profileId,requestIdValue,handle,{operation='marketplace-fund',includeJournal=true}={}) {
  const store=await MarketplaceProfileStore.open(home);
  try {
    const profile=store.getProfile(profileId);
    const requestHash='d'.repeat(64);
    store.beginMutation({profileId,requestId:requestIdValue,operation,target:profile.accountId,requestHash},handle);
    if(!includeJournal) return;
    store.putHandoff(profileId,handle,'MARKETPLACE_FUNDING',requestHash,'PREPARING',JSON.stringify({
      version:1,profileId,accountId:profile.accountId,origin:profile.origin,audience:profile.audience,
      requestId:requestIdValue,asset:'ATTO',amountAtomic:'700',state:'PREPARING',
    }),Number.MAX_SAFE_INTEGER);
  } finally { store.close(); }
}

async function seedAttoFundingMutation(home,profileId,requestIdValue) {
  const store=await MarketplaceProfileStore.open(home);
  try {
    const profile=store.getProfile(profileId);
    const requestHash='e'.repeat(64);
    store.beginMutation({profileId,requestId:requestIdValue,operation:'marketplace-fund',target:profile.accountId,requestHash},profile.accountId);
    store.completeMutation(profileId,requestIdValue,requestHash,profile.accountId);
  } finally {store.close();}
}

async function openMarketplace(home,origin,env,handoffDirectory,profileId='agent') {
  const main=fileURLToPath(new URL('../dist/main.js',import.meta.url));
  const transport=new StdioClientTransport({command:process.execPath,args:[main,'--profile',profileId,'--home',home,
    ...(handoffDirectory?['--payment-handoff-dir',handoffDirectory]:[])],env:{...env,MARKETPLACE_MCP_PROFILE:profileId},stderr:'pipe'});
  const client=new Client({name:'unified-funding-test',version:'1.0.0'});
  await client.connect(transport);
  return client;
}

function startFundingReservationWorker(home,profileId,requestIdValue) {
  const storeModule=pathToFileURL(require.resolve('../dist/profile-store.js')).href;
  const source=`
    import {MarketplaceProfileStore} from ${JSON.stringify(storeModule)};
    const [home,profileId,requestId]=process.argv.slice(1);
    const store=await MarketplaceProfileStore.open(home);
    const profile=store.getProfile(profileId);
    process.stdout.write('READY\\n');
    await new Promise(resolve=>process.stdin.once('data',resolve));
    try {
      const result=store.beginMutation({profileId,requestId,operation:'marketplace-fund',target:profile.accountId,
        requestHash:'f'.repeat(64)},profile.accountId);
      process.stdout.write(JSON.stringify({ok:true,state:result.state})+'\\n');
    } catch(error) {
      process.stdout.write(JSON.stringify({ok:false,code:error.code,message:error.message})+'\\n');
    } finally {store.close();}
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',source,home,profileId,requestIdValue],{stdio:['pipe','pipe','pipe']});
  let output='';
  let errorOutput='';
  let readySeen=false;
  let released=false;
  let resolveReady;
  let rejectReady;
  let resolveResult;
  let rejectResult;
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  const result=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
    output+=chunk;
    if(!readySeen&&output.includes('READY\n')) {readySeen=true;resolveReady();}
  });
  child.stderr.on('data',chunk=>{errorOutput+=chunk;});
  child.once('error',error=>{rejectReady(error);rejectResult(error);});
  child.once('close',code=>{
    if(!readySeen) rejectReady(new Error(`funding reservation worker exited before READY: ${errorOutput}`));
    if(code!==0) {rejectResult(new Error(`funding reservation worker exited ${code}: ${errorOutput}`));return;}
    const finalLine=output.trim().split('\n').at(-1);
    try {resolveResult(JSON.parse(finalLine));}
    catch(error) {rejectResult(new Error(`funding reservation worker returned invalid output: ${output} ${error}`));}
  });
  return {ready,result,release:()=>{
    if(released) return;
    released=true;
    if(!child.stdin.destroyed) child.stdin.end('go\n');
  }};
}

async function fakeAttoWallet(home) {
  const dataDirectory=join(home,'atto-data');
  await mkdir(dataDirectory,{mode:0o700});
  const source=join(home,'fake-atto-wallet.mjs');
  const serverModule=pathToFileURL(require.resolve('@modelcontextprotocol/server')).href;
  const stdioModule=pathToFileURL(require.resolve('@modelcontextprotocol/server/stdio')).href;
  const zodModule=pathToFileURL(require.resolve('zod')).href;
  await writeFile(source,`
    import {readFile,writeFile} from 'node:fs/promises';
    import {join} from 'node:path';
    const [{McpServer},{StdioServerTransport},{z}]=await Promise.all([
      import(${JSON.stringify(serverModule)}),import(${JSON.stringify(stdioModule)}),import(${JSON.stringify(zodModule)})]);
    if(process.argv.slice(2).length!==0)process.exit(4);
    const data=process.env.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR;
    if(!data)process.exit(4);
    const stateFile=join(data,'saved-payments.json');
    const callsFile=join(data,'wallet-calls.json');
    const server=new McpServer({name:'test-atto-wallet',version:'1.0.0'});
    const statusHandler=async({requestId})=>{
      let calls={statuses:0,payments:0};try{calls=JSON.parse(await readFile(callsFile,'utf8'));}catch{}
      calls.statuses++;await writeFile(callsFile,JSON.stringify(calls),{mode:0o600});
      try{return {content:[{type:'text',text:'status'}],structuredContent:JSON.parse(await readFile(join(data,requestId+'.status.json'),'utf8'))};}catch{}
      let saved={};try{saved=JSON.parse(await readFile(stateFile,'utf8'));}catch{}
      const payment=saved[requestId];
      const status=payment?{...payment,nativeState:calls.statuses>1?'confirmed':'unknown'}:{requestId,paymentState:'NOT_FOUND'};
      return {content:[{type:'text',text:'status'}],structuredContent:status};
    };
    const paymentHandler=async(args)=>{
      if(args.paymentIdentifier!==args.requestId||args.resourceUrl!==args.apiUrl+'/'+args.intentId||args.audience!=='marketplace-agent-api')process.exit(5);
      let calls={statuses:0,payments:0};try{calls=JSON.parse(await readFile(callsFile,'utf8'));}catch{}
      calls.payments++;await writeFile(callsFile,JSON.stringify(calls),{mode:0o600});
      let saved={};try{saved=JSON.parse(await readFile(stateFile,'utf8'));}catch{}
      const old=saved[args.requestId];
      const payment=old?{...old,reused:true}: {requestId:args.requestId,intentId:args.intentId,paymentIdentifier:args.paymentIdentifier,
        network:'atto:local',amountAtomic:args.amountAtomic,payer:${JSON.stringify(payer)},hash:'${'A'.repeat(64)}',
        paymentSignature:'private-exact-atto-payment-signature',paymentState:'READY',reused:false};
      saved[args.requestId]=payment;await writeFile(stateFile,JSON.stringify(saved),{mode:0o600});
      return {content:[{type:'text',text:'payment ready'}],structuredContent:payment};
    };
    server.registerTool('wallet_call',{inputSchema:{asset:z.literal('ATTO'),operation:z.enum(['payment.status','payment.prepare']),
      input:z.record(z.string(),z.unknown()),marketplace:z.strictObject({apiUrl:z.string(),audience:z.string()})}},async(request)=>{
      if(request.marketplace.audience!=='marketplace-agent-api')process.exit(6);
      if(request.operation==='payment.prepare'&&request.marketplace.apiUrl!==request.input.apiUrl)process.exit(7);
      const response=await (request.operation==='payment.status'?statusHandler:paymentHandler)(request.input);
      return {...response,structuredContent:{result:response.structuredContent}};
    });
    await server.connect(new StdioServerTransport());
  `,{mode:0o600});
  const command=join(home,'fake-atto-wallet');
  await writeFile(command,`#!/bin/sh\nexec '${process.execPath}' '${source}' "$@"\n`,{mode:0o700});
  return {command,dataDirectory,
    setStatus:async(id,status)=>writeFile(join(dataDirectory,id+'.status.json'),JSON.stringify(status),{mode:0o600}),
    clearStatus:async(id)=>rm(join(dataDirectory,id+'.status.json'),{force:true}),
    calls:async()=>{try{return JSON.parse(await readFile(join(dataDirectory,'wallet-calls.json'),'utf8'));}catch{return {statuses:0,payments:0};}}};
}

async function fakeNanoPayer(home) {
  const script=join(home,'fake-nano-payer.mjs');
  const serverModule=pathToFileURL(require.resolve('@modelcontextprotocol/server')).href;
  const stdioModule=pathToFileURL(require.resolve('@modelcontextprotocol/server/stdio')).href;
  const zodModule=pathToFileURL(require.resolve('zod')).href;
  await writeFile(script,`
    import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';
    const [{McpServer},{StdioServerTransport},{z}]=await Promise.all([
      import(${JSON.stringify(serverModule)}),import(${JSON.stringify(stdioModule)}),import(${JSON.stringify(zodModule)})]);
    if(process.argv.slice(2).length!==0)process.exit(3);
    const server=new McpServer({name:'test-shared-nano-wallet',version:'1.0.0'});
    server.registerTool('wallet_call',{inputSchema:{asset:z.literal('XNO'),operation:z.literal('payment.prepare'),
      input:z.strictObject({handoffId:z.string()})}},async({input:{handoffId}})=>{
      const directory=process.env.MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR;
      const request=JSON.parse(await readFile(join(directory,handoffId+'.request.json'),'utf8'));
      const challenge=JSON.parse(Buffer.from(request.paymentRequired,'base64').toString('utf8'));
      const signedDeadline=request.expiresAt;
      const payment={x402Version:2,resource:challenge.resource,accepted:challenge.accepts[0],payload:{block:{type:'state',account:${JSON.stringify(nanoPayer)},
          previous:'${'C'.repeat(64)}',link_as_account:challenge.accepts[0].payTo,link:'B0311EA55708D6A53C75CDBF88300259C6D018522FE3D4D0A242E431F9E8B6D0',signature:'${'E'.repeat(128)}',work:'${'F'.repeat(16)}',balance:'1'}},
        extensions:{...challenge.extensions,'payment-identifier':{...challenge.extensions['payment-identifier'],info:{...challenge.extensions['payment-identifier'].info,id:request.paymentIdentifier}},
          ...(challenge.extensions['marketplace-account-binding']?{'marketplace-account-binding':{...challenge.extensions['marketplace-account-binding'],
            info:{...challenge.extensions['marketplace-account-binding'].info,bindingSignature:'${'B'.repeat(128)}'}}}:{})}};
      const response={version:1,type:'marketplace-x402-payment-response',handoffId,requestSha256:request.requestSha256,
        intentId:request.intentId,requestId:request.requestId,accountId:request.accountId,asset:'XNO',network:request.network,
        amountAtomic:request.amountAtomic,origin:request.origin,paymentIdentifier:request.paymentIdentifier,resourceUrl:request.resourceUrl,
        paymentRequiredSha256:request.paymentRequiredSha256,sendHash:'${'A'.repeat(64)}',payer:${JSON.stringify(nanoPayer)},signedDeadline,
        paymentSignature:Buffer.from(JSON.stringify(payment)).toString('base64')};
      await writeFile(join(directory,handoffId+'.response.json'),JSON.stringify(response)+'\\n',{mode:0o600});
      return {content:[{type:'text',text:'prepared'}],structuredContent:{result:{handoffId,state:'PREPARED'}}};
    });
    await server.connect(new StdioServerTransport());
  `,{mode:0o600});
  const command=join(home,'fake-nano-payer');
  await writeFile(command,`#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`,{mode:0o700});
  return command;
}

function xnoChallenge(resourceUrl,amountAtomic,paymentIdentifier) {
  return {x402Version:2,resource:{url:resourceUrl,description:'Fund this Marketplace account',mimeType:'application/json'},
    accepts:[{scheme:'exact',network:'nano:dev',amount:amountAtomic,asset:'XNO',payTo:nanoPayer,maxTimeoutSeconds:300,
      extra:{assetTransferMethod:'native-state',paymentFlow:'upfront'}}],
    extensions:{'payment-identifier':{info:{required:true},schema:{type:'object',properties:{id:{type:'string'}}}}}};
}

async function listen(handler) {
  const server=createServer((req,res)=>{void Promise.resolve(handler(req,res)).catch(()=>{if(!res.destroyed)json(res,500,{});});});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  return Object.assign(server,{origin:`http://127.0.0.1:${server.address().port}`});
}
async function readBody(request){let value='';for await(const chunk of request)value+=chunk;return value?JSON.parse(value):null;}
function json(res,status,body){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));}
