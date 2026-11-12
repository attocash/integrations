import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MarketplaceProfileStore } from '../dist/profile-store.js';
import { approvalRequestDigest } from '../dist/approval-files.js';
import { shellQuote } from '../dist/shell-quote.js';

const accountId='11111111-1111-4111-8111-111111111111';
const agentId='22222222-2222-4222-8222-222222222222';
const identityId='33333333-3333-4333-8333-333333333333';
const productId='44444444-4444-4444-8444-444444444444';
const releaseId='55555555-5555-4555-8555-555555555555';
const purchaseId='66666666-6666-4666-8666-666666666666';
const challengeId='77777777-7777-4777-8777-777777777777';
const requestId='88888888-8888-4888-8888-888888888888';
const releaseHash='a'.repeat(64);
const receiptHash='c'.repeat(64);
const manifestHash='b'.repeat(64);
const nanoAddress='nano_3noms9a1zytox399kygpge6cc7hu1z79ms1cgzojodz8741qi7w5u3nzb8mn';
const nanoMessage='Hej Nano!🥦';
const nanoSignature='535c745819d0f40056f3c46402b4fae4356b3a8897bde99c955d411920e740d781e6dddcbde228e8b86c4383a1003f9f315519ff73bd356f561d19865dc90f09';
const serverMain=join(import.meta.dirname,'../dist/main.js');

test('Nano Shop purchase rejects a changed NOMS signature and recovers the same key and proof after MCP restart', async t => {
  // Given a Nano controller session, the public JavaScript verifier, and a Marketplace purchase that applies before losing its acknowledgement.
  const root=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-nano-purchase-'));
  const home=join(root,'profile');
  const seen=[];
  let purchaseCalls=0;
  const http=await listen(async(req,res)=>{
    const body=req.method==='GET'?null:await readJson(req);
    seen.push({method:req.method,path:req.url,key:req.headers['idempotency-key'],body});
    if(req.method==='GET'&&req.url===`/v1/products/${productId}`) return json(res,200,publicProduct());
    if(req.method==='POST'&&req.url===`/v1/agent/releases/${releaseId}/purchase/challenges`) {
      assert.deepEqual(body,{idempotencyKey:requestId,expectedReleaseHash:releaseHash});
      return json(res,200,purchaseChallenge());
    }
    if(req.method==='POST'&&req.url===`/v1/agent/releases/${releaseId}/purchase`) {
      assert.equal(body.expectedReleaseHash,releaseHash);
      assert.deepEqual(body.proof,{challengeId,message:nanoMessage,signature:nanoSignature});
      purchaseCalls+=1;
      if(purchaseCalls===1) { res.destroy(); return; }
      return json(res,200,order(false));
    }
    return json(res,404,{error:'not_found'});
  });
  const store=await MarketplaceProfileStore.open(home);
  store.createProfile(profile('nano-buyer',http.origin));
  let client=await connect(home,'nano-buyer');
  t.after(async()=>{await client.close().catch(()=>{});await close(http);store.close();await rm(root,{recursive:true,force:true});});

  // When the buyer requests the exact release, then MCP creates a private NANO approval request and no purchase is sent.
  const args={productId,releaseId,expectedReleaseHash:releaseHash,asset:'ATTO',grossAtomic:'101',requestId};
  const pending=JSON.parse(text(await client.callTool({name:'marketplace_product_purchase',arguments:args}))).result;
  assert.equal(pending.status,'approval_required');
  assert.equal(pending.purpose,'product purchase');
  const command=`${process.platform==='win32'?'& ':''}${shellQuote(process.execPath)} ${shellQuote(serverMain)}`;
  assert.ok(pending.walletCommand.startsWith(`${command} approve `));
  const requestPath=join(home,'approvals','nano-buyer',`${pending.handoffId}.request.json`);
  const request=JSON.parse(await readFile(requestPath,'utf8'));
  assert.deepEqual(request.controller,{network:'NANO',address:nanoAddress,index:0});
  assert.deepEqual(request.action,{kind:'productPurchase',releaseId,expectedReleaseHash:releaseHash,sellerAgentId:agentId,
    asset:'ATTO',grossAtomic:'101',feeAtomic:'1',netAtomic:'100',idempotencyKey:requestId});
  assert.equal(pending.walletCommand,`${command} approve ${shellQuote(requestPath)}`);
  assert.equal(seen.filter(row=>row.path===`/v1/agent/releases/${releaseId}/purchase`).length,0);

  // When the saved response carries a changed signature nibble, then verification fails before claiming or sending the action.
  await writeNanoResponse(requestPath,request,`${nanoSignature.slice(0,-1)}0`);
  const bad=await client.callTool({name:'marketplace_product_purchase',arguments:args});
  assert.equal(bad.isError,true,text(bad));
  assert.equal(JSON.parse(text(bad)).error.code,'APPROVAL_FILE');
  assert.equal(store.getHandoff('nano-buyer',pending.handoffId).state,'WAITING_APPROVAL');
  assert.equal(seen.filter(row=>row.path===`/v1/agent/releases/${releaseId}/purchase`).length,0);

  // When the exact NOMS fixture is restored, Marketplace applies the purchase but drops the first acknowledgement.
  await writeNanoResponse(requestPath,request,nanoSignature);
  const lost=await client.callTool({name:'marketplace_product_purchase',arguments:args});
  assert.equal(lost.isError,true,text(lost));
  assert.equal(store.getHandoff('nano-buyer',pending.handoffId).state,'UNKNOWN');
  await client.close();

  // When a new MCP process retries with the same request ID and arguments, then it reuses the saved proof and idempotency key.
  client=await connect(home,'nano-buyer');
  const recovered=await client.callTool({name:'marketplace_product_purchase',arguments:args});
  assert.equal(recovered.isError,undefined,text(recovered));
  assert.equal(JSON.parse(text(recovered)).result.purchaseId,purchaseId);
  assert.equal(JSON.stringify(recovered).includes(nanoSignature),false);
  const posts=seen.filter(row=>row.method==='POST'&&row.path===`/v1/agent/releases/${releaseId}/purchase`);
  assert.deepEqual(posts.map(row=>row.key),[requestId,requestId]);
  assert.deepEqual(posts.map(row=>row.body.proof),[
    {challengeId,message:nanoMessage,signature:nanoSignature},
    {challengeId,message:nanoMessage,signature:nanoSignature},
  ]);
  assert.equal(seen.filter(row=>row.path===`/v1/agent/releases/${releaseId}/purchase/challenges`).length,1);
});

test('Nano seller refund uses the exact product refund purpose and saved NOMS response', async t => {
  // Given a Nano seller session, an active Shop purchase, and the public JavaScript verifier for the public NOMS vector.
  const root=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-nano-refund-'));
  const home=join(root,'profile');
  const seen=[];
  const http=await listen(async(req,res)=>{
    const body=req.method==='GET'?null:await readJson(req);
    seen.push({method:req.method,path:req.url,key:req.headers['idempotency-key'],body});
    if(req.method==='GET'&&req.url===`/v1/agent/purchases/${purchaseId}`) return json(res,200,order(false));
    if(req.method==='POST'&&req.url===`/v1/agent/purchases/${purchaseId}/refund/challenges`) {
      assert.deepEqual(body,{idempotencyKey:requestId,expectedPurchaseVersion:0});
      return json(res,200,refundChallenge('SELLER'));
    }
    if(req.method==='POST'&&req.url===`/v1/agent/purchases/${purchaseId}/refund`) {
      assert.equal(body.expectedPurchaseVersion,0);
      assert.deepEqual(body.proof,{challengeId,message:nanoMessage,signature:nanoSignature});
      return json(res,200,order(true));
    }
    return json(res,404,{error:'not_found'});
  });
  const store=await MarketplaceProfileStore.open(home);
  store.createProfile(profile('nano-seller',http.origin));
  const client=await connect(home,'nano-seller');
  t.after(async()=>{await client.close().catch(()=>{});await close(http);store.close();await rm(root,{recursive:true,force:true});});

  // When the seller requests a full refund, then the approval binds the seller authority and exact original receipt.
  const args={purchaseId,expectedPurchaseVersion:0,originalPurchaseReceiptHash:receiptHash,asset:'ATTO',grossAtomic:'101',requestId};
  const pending=JSON.parse(text(await client.callTool({name:'marketplace_product_refund',arguments:args}))).result;
  const requestPath=join(home,'approvals','nano-seller',`${pending.handoffId}.request.json`);
  const request=JSON.parse(await readFile(requestPath,'utf8'));
  assert.equal(pending.status,'approval_required');
  assert.equal(pending.purpose,'product refund');
  assert.equal(request.purpose,'product refund');
  assert.deepEqual(request.action,{kind:'productRefund',purchaseId,expectedPurchaseVersion:0,authority:'SELLER',
    buyerAgentId:agentId,sellerAgentId:agentId,asset:'ATTO',grossAtomic:'101',feeAtomic:'1',netAtomic:'100',
    originalPurchaseReceiptHash:receiptHash,idempotencyKey:requestId});
  assert.equal(seen.filter(row=>row.path===`/v1/agent/purchases/${purchaseId}/refund`).length,0);

  // When the matching response file is present, then MCP verifies it and sends one exact refund under the original key.
  await writeNanoResponse(requestPath,request,nanoSignature);
  const result=await client.callTool({name:'marketplace_product_refund',arguments:args});
  assert.equal(result.isError,undefined,text(result));
  assert.equal(JSON.parse(text(result)).result.status,'REFUNDED');
  assert.equal(JSON.stringify(result).includes(nanoSignature),false);
  const post=seen.find(row=>row.path===`/v1/agent/purchases/${purchaseId}/refund`);
  assert.equal(post.key,requestId);
  assert.deepEqual(post.body.proof,{challengeId,message:nanoMessage,signature:nanoSignature});
  assert.equal(seen.filter(row=>row.path===`/v1/agent/purchases/${purchaseId}/refund/challenges`).length,1);
});

for (const network of ['ATTO','NANO']) {
  test(`${network==='ATTO'?'Atto (ATTO)':'Nano (XNO)'} administrator sessions cannot discover or invoke administrator MCP operations`, async t => {
    // Given a controller session whose API would accept administrator requests.
    const root=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-no-admin-'));
    const home=join(root,'profile');
    const requests=[];
    const http=await listen(async(req,res)=>{
      requests.push({method:req.method,path:req.url,authorization:req.headers.authorization});
      return json(res,200,order(false));
    });
    const store=await MarketplaceProfileStore.open(home);
    store.createProfile({...profile('administrator',http.origin),controllerNetwork:network,
      controllerAddress:network==='NANO'?nanoAddress:`atto://${'a'.repeat(61)}`,
      accessToken:'administrator-session-token'});
    const client=await connect(home,'administrator');
    t.after(async()=>{await client.close().catch(()=>{});await close(http);store.close();await rm(root,{recursive:true,force:true});});
    const removedTools=[
      ['marketplace_admin_purchase_get',{purchaseId}],
      ['marketplace_admin_purchase_receipt_get',{purchaseId,kind:'PURCHASE'}],
      ['marketplace_admin_product_refund',{purchaseId,expectedPurchaseVersion:0,originalPurchaseReceiptHash:receiptHash,
        asset:'ATTO',grossAtomic:'101',requestId}],
    ];

    // When an administrator lists the tools, then administrator operations are absent and participant tools remain.
    const {tools}=await client.listTools();
    assert.deepEqual(tools.filter(tool=>tool.name.startsWith('marketplace_admin_')),[]);
    for (const name of ['marketplace_purchase_get','marketplace_purchase_receipt_get','marketplace_product_refund',
      'marketplace_dispute_open','marketplace_dispute_respond']) {
      assert.equal(tools.some(tool=>tool.name===name),true,name);
    }

    // When removed tool names are invoked directly, then MCP rejects them without contacting the API or creating a mutation.
    for (const [name,arguments_] of removedTools) {
      await assert.rejects(client.callTool({name,arguments:arguments_}),{
        code:-32602,message:`Tool ${name} not found`,
      });
    }
    assert.deepEqual(requests,[]);
    assert.equal(store.getMutationByRequestId('administrator',requestId),null);
  });
}

test('Nano protected operations reach their typed challenge workflow outside Shop purchase and refund', async t => {
  // Given a Nano controller profile and protected withdrawal, payout, and credential operations.
  const root=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-nano-scope-'));
  const home=join(root,'profile');
  const requests=[];
  const http=await listen(async(req,res)=>{requests.push(req.url);return json(res,404,{error:'not_found'});});
  const store=await MarketplaceProfileStore.open(home);
  store.createProfile(profile('nano-scope',http.origin));
  const client=await connect(home,'nano-scope');
  t.after(async()=>{await client.close().catch(()=>{});await close(http);store.close();await rm(root,{recursive:true,force:true});});
  const attempts=[
    ['marketplace_withdrawal_create',{asset:'ATTO',atomicAmount:'1',destinationId:'99999999-9999-4999-8999-999999999999',expectedSelectionVersion:0,requestId}],
    ['marketplace_payout_address_mutate',{action:'ENROLL',asset:'ATTO',address:`atto://${'a'.repeat(61)}`,requestId}],
    ['marketplace_credentials_create',{requestId,credential:{name:'read only',expiresInDays:90,scopes:['tasks:read']}}],
  ];

  // When protected tools reach an unavailable API, their ordinary Marketplace errors prove the Nano-only gate is gone.
  for(const [index,[name,arguments_]] of attempts.entries()) {
    arguments_.requestId=`44444444-4444-4444-8444-${String(index+1).padStart(12,'0')}`;
    const result=await client.callTool({name,arguments:arguments_});
    assert.equal(result.isError,true,text(result));
    assert.equal(JSON.parse(text(result)).error.code,'MARKETPLACE_HTTP');
  }
  assert.ok(requests.includes('/v1/agent/credentials/challenges'));
  assert.ok(requests.some(path=>path.includes('payout-addresses')));
  assert.equal(requests.some(path=>path==='/v1/agent/withdrawals'||path==='/v1/agent/credentials'),false);
});

function profile(id,origin) {
  return {id,origin,audience:'marketplace',accountId,agentId,identityId,controllerNetwork:'NANO',controllerAddress:nanoAddress,
    controllerIndex:0,authMode:'controller-session',accessToken:'nano-controller-session-token',accessExpiresAt:Date.now()+120_000,
    refreshToken:'nano-controller-refresh-token',refreshExpiresAt:Date.now()+240_000};
}

async function connect(home,profileId) {
  const client=new Client({name:'test-marketplace-nano-shop',version:'1.0.0'});
  const env=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>typeof value==='string'&&key!=='NODE_TEST_CONTEXT'&&!key.startsWith('NODE_TEST_')));
  await client.connect(new StdioClientTransport({command:process.execPath,args:[serverMain,'--profile',profileId,'--home',home],env,stderr:'pipe'}));
  return client;
}

async function writeNanoResponse(requestPath,request,signature) {
  const response={version:1,type:'marketplace-controller-approval-response',profileId:request.profileId,
    handoffId:request.handoffId,requestDigest:approvalRequestDigest(request),challengeId:request.challenge.challengeId,
    message:request.challenge.message,signature,controllerAddress:request.controller.address,controllerIndex:request.controller.index};
  const path=requestPath.replace(/\.request\.json$/,'.response.json');
  await writeFile(path,`${JSON.stringify(response)}\n`,{mode:0o600});
  await chmod(path,0o600);
}

function publicProduct() {
  return {productId,releaseId,releaseSequence:1,releaseHash,sellerAgentId:agentId,sellerProfile:null,
    title:'Paid note',summaryMarkdown:'Public description',asset:'ATTO',priceAtomic:'101',licenseText:'Personal use',manifestHash,files:[]};
}

function order(isRefunded) {
  return {purchaseId,commandId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',productId,releaseId,releaseHash,manifestHash,
    buyerAgentId:agentId,sellerAgentId:agentId,asset:'ATTO',grossAtomic:'101',feeAtomic:'1',netAtomic:'100',feeRateBasisPoints:100,
    status:isRefunded?'REFUNDED':'ACTIVE',version:isRefunded?1:0,entitlementActive:!isRefunded,receiptId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    receiptHash,createdAt:'2026-10-16T20:00:00Z',refundedAt:isRefunded?'2026-10-16T20:01:00Z':null,
    refundReceiptId:isRefunded?'cccccccc-cccc-4ccc-8ccc-cccccccccccc':null,
    refundReceiptHash:isRefunded?'d'.repeat(64):null,refundCommandId:isRefunded?'dddddddd-dddd-4ddd-8ddd-dddddddddddd':null};
}

function purchaseChallenge() {
  return {releaseId,releaseHash,sellerAgentId:agentId,asset:'ATTO',grossAtomic:'101',feeAtomic:'1',netAtomic:'100',challenge:challenge()};
}

function refundChallenge(authority) {
  return {purchaseId,authority,buyerAgentId:agentId,sellerAgentId:agentId,asset:'ATTO',grossAtomic:'101',feeAtomic:'1',netAtomic:'100',
    originalPurchaseReceiptHash:receiptHash,challenge:challenge()};
}

function challenge() {
  return {challengeId,message:nanoMessage,issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+120_000).toISOString()};
}

async function listen(handler) {
  const server=createServer((req,res)=>{void Promise.resolve(handler(req,res)).catch(error=>{if(!res.destroyed)json(res,500,{error:String(error)});});});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  return Object.assign(server,{origin:`http://127.0.0.1:${server.address().port}`});
}

async function readJson(req) {
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  return chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):null;
}

async function close(server) { await new Promise(resolve=>server.close(resolve)); }
function json(res,status,body) { res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body)); }
function text(result) { return result.content?.filter(part=>part.type==='text').map(part=>part.text).join('\n')??''; }
