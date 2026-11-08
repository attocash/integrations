import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MarketplaceProfileStore } from '../dist/profile-store.js';

const accountId='11111111-1111-4111-8111-111111111111';
const agentId='22222222-2222-4222-8222-222222222222';
const identityId='33333333-3333-4333-8333-333333333333';
const productId='44444444-4444-4444-8444-444444444444';
const releaseId='55555555-5555-4555-8555-555555555555';
const releaseHash='a'.repeat(64);
const serverMain=join(import.meta.dirname,'../dist/main.js');
const snapshot={asset:'ATTO',amountAtomic:'500',usdAmount:'0.000100000000000000',policyVersion:'product-publication-usd-growth-v1:test',
  ordinal:1,priceUsd:'400.00',providerUpdatedAt:null,fetchedAt:'2026-10-17T10:00:00Z'};

test('stdio publication quote and cap bind new holds while legacy keys can update and release existing holds',async()=>{
  // Given publication policy evidence, an unreserved draft, and current and legacy seller grants.
  let reservation=null;
  const requests=[];
  const detail=()=>({productId,sellerAgentId:agentId,published:reservation!==null,currentReleaseId:reservation?releaseId:null,
    currentReleaseHash:reservation?releaseHash:null,publicationReservation:reservation,
    draft:{version:2,title:'Research bundle',summaryMarkdown:'Public overview',paidMarkdown:null,licenseText:'Personal use',
      asset:'ATTO',priceAtomic:'100',fileIds:[],files:[]},releases:[],nextReleaseBeforeSequence:null,
    createdAt:'2026-10-01T10:00:00Z',updatedAt:'2026-10-02T10:00:00Z'});
  const http=await listen(async(req,res)=>{
    const body=req.method==='GET'?Buffer.alloc(0):await readBody(req);
    const parsed=body.length?JSON.parse(body.toString('utf8')):undefined;
    requests.push({method:req.method,path:req.url,authorization:req.headers.authorization,idempotency:req.headers['idempotency-key'],body:parsed});
    if(req.method==='GET'&&req.url.startsWith(`/v1/agent/products/${productId}`)) return json(res,200,detail());
    if(req.method==='POST'&&req.url===`/v1/agent/products/${productId}/publication-quote`)
      return json(res,200,{...snapshot,alreadyReserved:reservation!==null});
    if(req.method==='POST'&&req.url===`/v1/agent/products/${productId}/publish`) {
      reservation=snapshot;
      return json(res,200,{productId,draftVersion:2,published:true,releaseId,releaseHash,publicationReservation:reservation});
    }
    if(req.method==='POST'&&req.url===`/v1/agent/products/${productId}/unpublish`) {
      reservation=null;
      return json(res,200,{productId,draftVersion:2,published:false,releaseId,releaseHash,publicationReservation:null});
    }
    return json(res,404,{error:'not_found',message:'Unexpected fixture route'});
  });
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-publication-reservation-'));
  const store=await MarketplaceProfileStore.open(home);
  store.createProfile({id:'quote-only',origin:http.origin,audience:'marketplace',accountId,agentId,identityId,
    controllerNetwork:'ATTO',controllerAddress:`atto://${'a'.repeat(61)}`,authMode:'scoped-api-key',apiKey:'quote-key',
    apiScopes:['products:publish'],productPublishAttoLimit:'500'});
  store.createProfile({id:'seller',origin:http.origin,audience:'marketplace',accountId,agentId,identityId,
    controllerNetwork:'ATTO',controllerAddress:`atto://${'a'.repeat(61)}`,authMode:'scoped-api-key',apiKey:'seller-key',
    apiScopes:['products:read','products:publish'],productPublishAttoLimit:'500'});
  store.createProfile({id:'legacy-seller',origin:http.origin,audience:'marketplace',accountId,agentId,identityId,
    controllerNetwork:'ATTO',controllerAddress:`atto://${'a'.repeat(61)}`,authMode:'scoped-api-key',apiKey:'legacy-seller-key',
    apiScopes:['products:read','products:publish']});
  const quoteClient=await connect(home,'quote-only');
  const seller=await connect(home,'seller');
  const legacy=await connect(home,'legacy-seller');
  try {
    // When a publish-only key requests the quote and a seller attempts new reservation creation.
    const quote=await quoteClient.callTool({name:'marketplace_product_publication_quote',arguments:{productId,expectedVersion:2}});
    assert.equal(quote.isError,undefined,contentText(quote));
    assert.deepEqual(JSON.parse(contentText(quote)).result,{...snapshot,alreadyReserved:false});
    assert.deepEqual(requests.at(-1).body,{expectedVersion:2});
    assert.equal(requests.at(-1).authorization,'Bearer quote-key');
    const missingCap=await seller.callTool({name:'marketplace_product_publish',arguments:{productId,requestId:'99999999-9999-4999-8999-999999999991',
      expectedVersion:2,confirmsDistributionRights:true}});
    assert.equal(JSON.parse(contentText(missingCap)).error.code,'MAX_RESERVATION_REQUIRED');
    assert.equal(requests.some(row=>row.method==='POST'&&row.path.endsWith('/publish')),false);
    const overLimit=await seller.callTool({name:'marketplace_product_publish',arguments:{productId,requestId:'99999999-9999-4999-8999-999999999992',
      expectedVersion:2,confirmsDistributionRights:true,maxReservationAtomic:'501'}});
    assert.equal(JSON.parse(contentText(overLimit)).error.code,'CEILING_EXCEEDED');
    assert.equal(requests.some(row=>row.method==='POST'&&row.path.endsWith('/publish')),false);

    // When the seller sends the quote-sized ceiling, the exact cap and reservation snapshot survive response replay.
    const args={productId,requestId:'99999999-9999-4999-8999-999999999993',expectedVersion:2,
      confirmsDistributionRights:true,maxReservationAtomic:'500'};
    const published=await seller.callTool({name:'marketplace_product_publish',arguments:args});
    assert.equal(published.isError,undefined,contentText(published));
    assert.deepEqual(JSON.parse(contentText(published)).result.publicationReservation,snapshot);
    const publishRequest=requests.find(row=>row.method==='POST'&&row.path.endsWith('/publish'));
    assert.deepEqual(publishRequest.body,{expectedVersion:2,confirmsDistributionRights:true,maxReservationAtomic:'500'});
    assert.equal(publishRequest.idempotency,args.requestId);
    const beforeReplay=requests.length;
    const replay=await seller.callTool({name:'marketplace_product_publish',arguments:args});
    const replayResult=JSON.parse(contentText(replay)).result;
    assert.equal(JSON.parse(replayResult.resultIdentity).publicationReservation.amountAtomic,'500');
    assert.equal(requests.length,beforeReplay);
    const replayConflict=await seller.callTool({name:'marketplace_product_publish',arguments:{...args,maxReservationAtomic:'499'}});
    assert.equal(JSON.parse(contentText(replayConflict)).error.code,'IDEMPOTENCY_CONFLICT');
    assert.equal(requests.length,beforeReplay);

    // When a legacy product-publish key manages an already-held listing, no new ceiling is required.
    const alreadyReserved=await quoteClient.callTool({name:'marketplace_product_publication_quote',arguments:{productId,expectedVersion:2}});
    assert.equal(JSON.parse(contentText(alreadyReserved)).result.alreadyReserved,true);
    const updated=await legacy.callTool({name:'marketplace_product_publish',arguments:{productId,
      requestId:'99999999-9999-4999-8999-999999999994',expectedVersion:2,confirmsDistributionRights:true}});
    assert.equal(updated.isError,undefined,contentText(updated));
    assert.equal(JSON.parse(contentText(updated)).result.publicationReservation.amountAtomic,'500');
    const legacyPublish=requests.filter(row=>row.method==='POST'&&row.path.endsWith('/publish')).at(-1);
    assert.deepEqual(legacyPublish.body,{expectedVersion:2,confirmsDistributionRights:true});
    const unpublished=await legacy.callTool({name:'marketplace_product_unpublish',arguments:{productId,
      requestId:'99999999-9999-4999-8999-999999999995',expectedVersion:2}});
    assert.equal(unpublished.isError,undefined,contentText(unpublished));
    assert.equal(JSON.parse(contentText(unpublished)).result.publicationReservation,null);
  } finally {
    await quoteClient.close();await seller.close();await legacy.close();http.close();store.close();await rm(home,{recursive:true,force:true});
  }
});

async function connect(home,profile) {
  const client=new Client({name:'test-marketplace-publication',version:'1.0.0'});
  const environment=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>typeof value==='string'
    &&key!=='NODE_TEST_CONTEXT'&&!key.startsWith('NODE_TEST_')));
  await client.connect(new StdioClientTransport({command:process.execPath,args:[serverMain,'--profile',profile,'--home',home],env:environment,stderr:'pipe'}));
  return client;
}
async function listen(handler) {
  const server=createServer((req,res)=>{void Promise.resolve(handler(req,res)).catch(()=>{if(!res.destroyed)json(res,500,{});});});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  return Object.assign(server,{origin:`http://127.0.0.1:${server.address().port}`});
}
async function readBody(req){const chunks=[];for await(const chunk of req)chunks.push(chunk);return Buffer.concat(chunks);}
function json(res,status,body){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));}
function contentText(result){return result.content?.filter(part=>part.type==='text').map(part=>part.text).join('\n')??'';}
