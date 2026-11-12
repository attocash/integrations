import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from '../../test/support/temporary-directory.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {MarketplaceProfileStore} from '../dist/profile-store.js';

const require=createRequire(import.meta.url);
const payer='nano_3e3j5tkog48pnny9dmfzj1r16pg8t1e76dz5tmac6iq689wyjfpiij4txtdo';
const accountId='11111111-1111-4111-8111-111111111111';
for(const loseSubmitResponse of [false,true]) {
  test(`XNO ${loseSubmitResponse?'lost submit recovery':'successful submit'} reconciles the private wallet source lane before another funding`,async t=>{
    const home=await mkdtemp(join(tmpdir(),'marketplace-node-wallet-lane-'));
    let client,http;
    t.after(async()=>{
      try {await client?.close();}
      finally {
        try {
          http?.closeAllConnections();
          if(http)await new Promise(resolve=>http.close(resolve));
        } finally {await rm(home,{recursive:true,force:true});}
      }
    });
    const directory=join(home,'handoffs');await mkdir(directory,{mode:0o700});
    const host=await walletHost(home);
    const intents=new Map(),accepted=[];let creates=0,submits=0,drop=loseSubmitResponse;
    http=createServer((req,res)=>{void(async()=>{
      let text='';for await(const chunk of req)text+=chunk;const body=text?JSON.parse(text):null;
      if(req.method==='POST'&&req.url==='/v1/agent/topups') {
        creates++;const intentId=randomUUID(),hash=(creates===1?'A':'B').repeat(64);
        const intent={intentId,asset:'XNO',network:'nano:dev',amountAtomic:body.amountAtomic,state:'PENDING',
          expiresAt:new Date(Date.now()+120000).toISOString(),sendHash:null,payer:null,paymentState:null,receiveStatus:null};
        intents.set(intentId,{intent,hash});const challenge=xnoChallenge(`${http.origin}/v1/agent/topups/${intentId}`,body.amountAtomic);
        res.writeHead(402,{'content-type':'application/json','payment-required':Buffer.from(JSON.stringify(challenge)).toString('base64')});return res.end(JSON.stringify(intent));
      }
      if(req.url==='/v1/agent/balances')return json(res,balances(String(accepted.length*100)));
      const entry=intents.get(req.url?.split('/').at(-1));if(!entry){res.writeHead(404);return res.end('{}');}
      if(req.method==='GET')return json(res,entry.intent);
      if(req.method==='POST') {
        submits++;entry.intent={...entry.intent,state:'ACCEPTED',sendHash:entry.hash,payer,paymentState:'ACCEPTED'};
        accepted.push(entry.intent.intentId);await writeFile(join(directory,'accepted.json'),JSON.stringify(accepted),{mode:0o600});
        if(drop){drop=false;return res.destroy();}
        const receipt=Buffer.from(JSON.stringify({success:true,transaction:entry.hash,network:'nano:dev',payer})).toString('base64');
        res.setHeader('payment-response',receipt);return json(res,entry.intent);
      }
    })().catch(()=>{res.writeHead(500);res.end('{}');});});
    await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));http.origin=`http://127.0.0.1:${http.address().port}`;
    const store=await MarketplaceProfileStore.open(home);
    try {store.createProfile({id:'native',origin:http.origin,audience:'marketplace-agent-api',accountId,
      agentId:'22222222-2222-4222-8222-222222222222',identityId:'33333333-3333-4333-8333-333333333333',controllerNetwork:'NANO',
      controllerAddress:payer,controllerIndex:1,authMode:'controller-session',accessToken:'fake-fixture-access-token',accessExpiresAt:Date.now()+120000,
      refreshToken:'fake-fixture-refresh-token',refreshExpiresAt:Date.now()+240000});} finally {store.close();}
    client=await open(home,directory,host);
    const firstArgs={asset:'XNO',network:'nano:dev',amountAtomic:'100',requestId:randomUUID()};
    const first=await client.callTool({name:'marketplace_fund',arguments:firstArgs});
    if(loseSubmitResponse){
      assert.equal(first.structuredContent.error.code,'MARKETPLACE_UNAVAILABLE');
      assert.notEqual((await state(directory)).lane,null,'Lost response leaves original wallet candidate fenced until status recovery');
      await client.close();client=await open(home,directory,host);
      const recovered=await client.callTool({name:'marketplace_funding_status',arguments:{requestId:firstArgs.requestId}});
      assert.equal(recovered.structuredContent.result.status.state,'ACCEPTED');
    }else assert.equal(first.structuredContent.result.status.state,'ACCEPTED');
    let observed=await state(directory);assert.equal(observed.lane,null,'Credited SEND must reconcile and release its private wallet source lane');
    assert.ok(observed.statuses>=1);
    const second=await client.callTool({name:'marketplace_fund',arguments:{...firstArgs,requestId:randomUUID()}});
    assert.notEqual(second.isError,true,JSON.stringify(second.structuredContent));
    assert.equal(second.structuredContent.result.balances.balances.find(balance=>balance.asset==='XNO').availableAtomic,'200');
    observed=await state(directory);assert.equal(observed.prepares,2);assert.equal(observed.lane,null);
    const replay=await client.callTool({name:'marketplace_fund',arguments:firstArgs});assert.equal(replay.structuredContent.result.status.sendHash,'A'.repeat(64));
    assert.equal((await state(directory)).prepares,2);assert.equal(creates,2);assert.equal(submits,2);
  });
}

for(const tamperDigest of [false,true]) {
  test(`XNO interrupted signing ${tamperDigest?'rejects a mismatched candidate digest':'preserves its unknown candidate'} after intent expiry without a response file`,async t=>{
    // Given the wallet persists its original candidate, then dies before publishing a response.
    const home=await mkdtemp(join(tmpdir(),'marketplace-node-wallet-interrupted-'));
    let client,http;
    t.after(async()=>{
      try {await client?.close();}
      finally {
        try {
          http?.closeAllConnections();
          if(http)await new Promise(resolve=>http.close(resolve));
        } finally {await rm(home,{recursive:true,force:true});}
      }
    });
    const directory=join(home,'handoffs');await mkdir(directory,{mode:0o700});
    const host=await walletHost(home,{interruptBeforeResponse:true});
    let intent,creates=0,submits=0;
    http=createServer((req,res)=>{void(async()=>{
      let text='';for await(const chunk of req)text+=chunk;const body=text?JSON.parse(text):null;
      if(req.method==='POST'&&req.url==='/v1/agent/topups') {
        creates++;
        intent={intentId:randomUUID(),asset:'XNO',network:'nano:dev',amountAtomic:body.amountAtomic,state:'PENDING',
          expiresAt:new Date(Date.now()+5000).toISOString(),sendHash:null,payer:null,paymentState:null,receiveStatus:null};
        const challenge=xnoChallenge(`${http.origin}/v1/agent/topups/${intent.intentId}`,body.amountAtomic);
        res.writeHead(402,{'content-type':'application/json','payment-required':Buffer.from(JSON.stringify(challenge)).toString('base64')});
        return res.end(JSON.stringify(intent));
      }
      if(req.url==='/v1/agent/balances')return json(res,balances('0'));
      if(intent&&req.url===`/v1/agent/topups/${intent.intentId}`) {
        if(req.method==='POST'){submits++;res.writeHead(500);return res.end('{}');}
        return json(res,{...intent,state:Date.now()>=Date.parse(intent.expiresAt)?'REJECTED':'PENDING'});
      }
      res.writeHead(404);res.end('{}');
    })().catch(()=>{res.writeHead(500);res.end('{}');});});
    await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));http.origin=`http://127.0.0.1:${http.address().port}`;
    const store=await MarketplaceProfileStore.open(home);
    try {store.createProfile({id:'native',origin:http.origin,audience:'marketplace-agent-api',accountId,
      agentId:'22222222-2222-4222-8222-222222222222',identityId:'33333333-3333-4333-8333-333333333333',controllerNetwork:'NANO',
      controllerAddress:payer,controllerIndex:1,authMode:'controller-session',accessToken:'fake-fixture-access-token',accessExpiresAt:Date.now()+120000,
      refreshToken:'fake-fixture-refresh-token',refreshExpiresAt:Date.now()+240000});} finally {store.close();}
    client=await open(home,directory,host);
    const args={asset:'XNO',network:'nano:dev',amountAtomic:'100',requestId:randomUUID()};
    const interrupted=await client.callTool({name:'marketplace_fund',arguments:args});
    assert.equal(interrupted.isError,true);
    const saved=await state(directory),candidate=Object.values(saved.payments)[0];
    assert.ok(candidate,'The killed child must leave one durable candidate');
    assert.equal(saved.prepares,1);assert.equal(saved.lane,candidate.handoffId);
    const request=JSON.parse(await readFile(join(directory,`${candidate.handoffId}.request.json`),'utf8'));
    const responsePath=join(directory,`${candidate.handoffId}.response.json`);
    assert.equal(candidate.requestSha256,request.requestSha256);
    await assert.rejects(readFile(responsePath),{code:'ENOENT'});
    await client.close();
    await delay(Math.max(0,Date.parse(request.expiresAt)-Date.now()+25));
    if(tamperDigest)await writeFile(join(directory,'tamper-digest'),'1',{mode:0o600});
    client=await open(home,directory,host);

    // When the original request is recovered after expiry through the restarted public MCP.
    const recovered=await client.callTool({name:'marketplace_funding_status',arguments:{requestId:args.requestId}});
    if(tamperDigest) {
      // Then a candidate from different request bytes is rejected before it can be trusted.
      assert.equal(recovered.isError,true);
      assert.equal(recovered.structuredContent.error.code,'PAYMENT_BINDING');
    } else {
      // Then missing response bytes do not erase the original candidate or permit replacement spending.
      assert.notEqual(recovered.isError,true,JSON.stringify(recovered.structuredContent));
      const result=recovered.structuredContent.result;
      assert.equal(result.status.state,'REJECTED');assert.ok(Date.parse(result.status.expiresAt)<=Date.now());
      assert.equal(result.status.sendHash,null);assert.equal(result.status.paymentState,null);
      assert.deepEqual(result.nativePayment,{state:'PENDING',hash:candidate.sendHash,failureReason:null});
      for(const field of ['localPaymentState','localPaymentStateSource','nativePaymentState','nativePaymentStateSource','nativePaymentStatus']) assert.equal(field in result,false);
      const replay=await client.callTool({name:'marketplace_fund',arguments:args});
      assert.notEqual(replay.isError,true,JSON.stringify(replay.structuredContent));
      assert.deepEqual(replay.structuredContent.result.nativePayment,result.nativePayment);
    }
    const after=await state(directory);
    assert.ok(after.statuses>saved.statuses,'Recovery must query the private wallet despite the missing response');
    assert.equal(after.prepares,1);assert.equal(after.lane,candidate.handoffId);
    assert.equal(Object.keys(after.payments).length,1);assert.equal(after.payments[candidate.handoffId].sendHash,candidate.sendHash);
    assert.equal(after.payments[candidate.handoffId].requestSha256,request.requestSha256);
    assert.equal(creates,1);assert.equal(submits,0);
    await assert.rejects(readFile(responsePath),{code:'ENOENT'});
  });
}

async function state(directory){return JSON.parse(await readFile(join(directory,'wallet-state.json'),'utf8'));}
async function open(home,directory,host){
  const client=new Client({name:'native-lane-fixture',version:'1.0.0'});
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,
      args:[fileURLToPath(new URL('../dist/main.js',import.meta.url)),'--profile','native','--home',home],
      env:{...process.env,MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR:directory,MARKETPLACE_MCP_WALLET_HOST_COMMAND:host},stderr:'pipe'}));
    return client;
  } catch(error) {await client.close();throw error;}
}
function balances(availableAtomic){return {balances:[{asset:'ATTO',availableAtomic:'0',reservedAtomic:'0'},{asset:'XNO',availableAtomic,reservedAtomic:'0'}]};}
function json(res,body){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(body));}
function xnoChallenge(resourceUrl,amount){return {x402Version:2,resource:{url:resourceUrl,description:'Fund this Marketplace account',mimeType:'application/json'},accepts:[{scheme:'exact',network:'nano:dev',amount,asset:'XNO',payTo:payer,maxTimeoutSeconds:300,extra:{assetTransferMethod:'native-state',paymentFlow:'upfront'}}],extensions:{'payment-identifier':{info:{required:true},schema:{type:'object',properties:{id:{type:'string'}}}}}};}
async function walletHost(home,{interruptBeforeResponse=false}={}){
  const script=join(home,'wallet-host.mjs');const modules=['@modelcontextprotocol/server','@modelcontextprotocol/server/stdio','zod'].map(name=>pathToFileURL(require.resolve(name)).href);
  await writeFile(script,`
import {readFileSync,writeFileSync,existsSync,openSync,fsyncSync,closeSync} from 'node:fs';import {join} from 'node:path';
const [{McpServer},{StdioServerTransport},{z}]=await Promise.all(${JSON.stringify(modules)}.map(url=>import(url)));
const directory=process.env.MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR,path=join(directory,'wallet-state.json');
const load=()=>{try{return JSON.parse(readFileSync(path,'utf8'));}catch{return {prepares:0,statuses:0,lane:null,payments:{}};}};
const server=new McpServer({name:'nano-source-lane-fixture',version:'1.0.0'});
server.registerTool('wallet_call',{inputSchema:{asset:z.literal('XNO'),operation:z.enum(['payment.prepare','payment.status']),input:z.strictObject({handoffId:z.string()})}},async({operation,input:{handoffId}})=>{
  const state=load();let payment=state.payments[handoffId];
  if(operation==='payment.status'){
    state.statuses++;let accepted=[];try{accepted=JSON.parse(readFileSync(join(directory,'accepted.json'),'utf8'));}catch{}
    if(payment&&accepted.includes(payment.intentId)){payment.state='CONFIRMED';if(state.lane===handoffId)state.lane=null;}
    else if(payment&&${interruptBeforeResponse}&&Date.now()>=Date.parse(payment.expiresAt))payment.state='UNKNOWN';
  }else{
    if(state.lane&&state.lane!==handoffId)return {content:[],isError:true,structuredContent:{error:{code:'SOURCE_FENCED'}}};
    state.prepares++;const request=JSON.parse(readFileSync(join(directory,handoffId+'.request.json'),'utf8'));
    const challenge=JSON.parse(Buffer.from(request.paymentRequired,'base64').toString('utf8')),sendHash=(state.prepares===1?'A':'B').repeat(64),signedDeadline=request.expiresAt;
    const envelope={x402Version:2,resource:challenge.resource,accepted:challenge.accepts[0],payload:{block:{type:'state',account:${JSON.stringify(payer)},previous:'C'.repeat(64),link_as_account:challenge.accepts[0].payTo,link:'B0311EA55708D6A53C75CDBF88300259C6D018522FE3D4D0A242E431F9E8B6D0',signature:'E'.repeat(128),work:'F'.repeat(16),balance:'1'}},extensions:{'payment-identifier':{schema:challenge.extensions['payment-identifier'].schema,info:{required:true,id:request.paymentIdentifier}}}};
    const response={version:1,type:'marketplace-x402-payment-response',handoffId,requestSha256:request.requestSha256,intentId:request.intentId,requestId:request.requestId,accountId:request.accountId,asset:'XNO',network:request.network,amountAtomic:request.amountAtomic,origin:request.origin,paymentIdentifier:request.paymentIdentifier,resourceUrl:request.resourceUrl,paymentRequiredSha256:request.paymentRequiredSha256,sendHash,payer:${JSON.stringify(payer)},signedDeadline,paymentSignature:Buffer.from(JSON.stringify(envelope)).toString('base64')};
    payment={handoffId,intentId:request.intentId,requestSha256:request.requestSha256,expiresAt:request.expiresAt,state:'PREPARED',network:'nano:dev',sourceAddress:${JSON.stringify(payer)},candidateState:'PRESENT',sendHash};state.payments[handoffId]=payment;state.lane=handoffId;
    if(${interruptBeforeResponse}) {
      writeFileSync(path,JSON.stringify(state),{mode:0o600});const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
      process.kill(process.pid,'SIGKILL');
    }
    writeFileSync(join(directory,handoffId+'.response.json'),JSON.stringify(response)+'\\n',{mode:0o600});
  }
  writeFileSync(path,JSON.stringify(state),{mode:0o600});return {content:[{type:'text',text:'fixture status'}],structuredContent:{result:payment&&existsSync(join(directory,'tamper-digest'))?{...payment,requestSha256:'0'.repeat(64)}:payment}};
});await server.connect(new StdioServerTransport());
`,{mode:0o600});
  if(process.platform==='win32') return script;
  const command=join(home,'wallet-host');await writeFile(command,`#!/bin/sh\nexec '${process.execPath}' '${script}'\n`,{mode:0o700});return command;
}
