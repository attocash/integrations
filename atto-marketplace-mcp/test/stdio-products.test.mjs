import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MarketplaceProfileStore } from '../dist/profile-store.js';

const accountId='11111111-1111-4111-8111-111111111111';
const agentId='22222222-2222-4222-8222-222222222222';
const identityId='33333333-3333-4333-8333-333333333333';
const productId='44444444-4444-4444-8444-444444444444';
const releaseId='55555555-5555-4555-8555-555555555555';
const fileId='66666666-6666-4666-8666-666666666666';
const contentVersionId='77777777-7777-4777-8777-777777777777';
const uploadId='88888888-8888-4888-8888-888888888888';
const serverMain=join(import.meta.dirname,'../dist/main.js');
const bytes=Buffer.from('product source bytes\n');
const sha256=createHash('sha256').update(bytes).digest('hex');
const file={ordinal:0,fileId,contentVersionId,filename:'source.txt',byteLength:bytes.length,mediaType:'text/plain',sha256};
const readyFile={fileId,contentVersionId,filename:'source.txt',byteLength:bytes.length,mediaType:'text/plain',sha256,state:'READY'};
const publicProduct={productId,releaseId,releaseSequence:1,releaseHash:'a'.repeat(64),sellerAgentId:agentId,sellerProfile:null,
  title:'Research bundle',summaryMarkdown:'## Public overview',asset:'ATTO',priceAtomic:'1000000000',licenseText:'Personal use',manifestHash:'b'.repeat(64),
  files:[{fileId,filename:'source.txt',byteLength:bytes.length,mediaType:'text/plain'}]};
let sellerVersion=2;
let published=false;
const detail=()=>({productId,sellerAgentId:agentId,published,currentReleaseId:published?releaseId:null,
  currentReleaseHash:published?'a'.repeat(64):null,
  draft:{version:sellerVersion,title:'Research bundle',summaryMarkdown:'## Public overview',paidMarkdown:'Seller-only notes',
    licenseText:'Personal use',asset:'ATTO',priceAtomic:'1000000000',fileIds:[fileId],files:[file]},
  releases:[{releaseId,releaseSequence:1,sourceDraftVersion:1,releaseHash:'a'.repeat(64),feeRateBasisPoints:100,
    manifestHash:'b'.repeat(64),title:'Research bundle',summaryMarkdown:'## Public overview',paidMarkdown:'Seller-only notes',
    licenseText:'Personal use',asset:'ATTO',priceAtomic:'1000000000',files:[file],publishedAt:'2026-10-01T10:00:00Z'}],
  nextReleaseBeforeSequence:null,createdAt:'2026-10-01T10:00:00Z',updatedAt:'2026-10-02T10:00:00Z'});

test('stdio Shop clients expose bounded public reads, scoped seller mutations, and explicit verified product files',async()=>{
  // Given private configured file paths, scoped profiles, and a local Marketplace fixture.
  const root=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-products-'));
  const home=join(root,'profile');
  const filesDirectory=join(root,'files');
  await mkdir(join(filesDirectory,'downloads'),{recursive:true,mode:0o700});
  await writeFile(join(filesDirectory,'source.txt'),bytes,{mode:0o600});
  const requests=[];
  let uploadState='PENDING_UPLOAD';
  let uploadedBytes;
  const publishResults=new Map();
  let losePublishResponseOnce=true;
  const http=await listen(async(req,res)=>{
    const body=req.method==='GET'?Buffer.alloc(0):await readBody(req);
    const parsedBody=body.length>0&&req.headers['content-type']?.includes('application/json')?JSON.parse(body.toString('utf8')):undefined;
    requests.push({method:req.method,path:req.url,authorization:req.headers.authorization,idempotency:req.headers['idempotency-key'],body:parsedBody??body});
    if(req.method==='GET'&&req.url.startsWith('/v1/products?')) return json(res,200,{items:[publicProduct],nextCursor:null});
    if(req.method==='GET'&&req.url===`/v1/products/${productId}`) return json(res,200,publicProduct);
    if(req.method==='GET'&&req.url.startsWith('/v1/agent/products?')) return json(res,200,[{
      productId,sellerAgentId:agentId,draftVersion:sellerVersion,title:'Research bundle',asset:'ATTO',priceAtomic:'1000000000',
      published,currentReleaseId:published?releaseId:null,currentReleaseHash:published?'a'.repeat(64):null,
      createdAt:'2026-10-01T10:00:00Z',updatedAt:'2026-10-02T10:00:00Z'}]);
    if(req.method==='GET'&&req.url.startsWith(`/v1/agent/products/${productId}`)) return json(res,200,detail());
    if(req.method==='POST'&&req.url==='/v1/agent/products') {
      return json(res,201,{productId,draftVersion:0,published:false,releaseId:null,releaseHash:null});
    }
    if(req.method==='PUT'&&req.url===`/v1/agent/products/${productId}/draft`) {
      sellerVersion=Number(parsedBody.expectedVersion)+1;
      return json(res,200,{productId,draftVersion:sellerVersion,published:false,releaseId:null,releaseHash:null});
    }
    if(req.method==='POST'&&req.url===`/v1/agent/products/${productId}/publish`) {
      const key=req.headers['idempotency-key'];
      if(publishResults.has(key)) return json(res,200,publishResults.get(key));
      published=true;
      const result={productId,draftVersion:sellerVersion,published:true,releaseId,releaseHash:'a'.repeat(64)};
      publishResults.set(key,result);
      if(key==='99999999-9999-4999-8999-999999999996'&&losePublishResponseOnce) {
        losePublishResponseOnce=false;
        return json(res,503,{error:'temporary_error',message:'The publish response was lost after the request committed.'});
      }
      return json(res,200,result);
    }
    if(req.method==='POST'&&req.url===`/v1/agent/products/${productId}/unpublish`) {
      published=false;
      return json(res,200,{productId,draftVersion:sellerVersion,published:false,releaseId,releaseHash:'a'.repeat(64)});
    }
    if(req.method==='POST'&&req.url==='/v1/agent/files/uploads') return json(res,201,{uploadId,state:uploadState,expiresAt:'2026-10-17T00:00:00Z'});
    if(req.method==='GET'&&req.url===`/v1/agent/files/uploads/${uploadId}`) return json(res,200,{uploadId,state:uploadState,file:uploadState==='READY'?readyFile:null});
    if(req.method==='PUT'&&req.url===`/v1/agent/files/uploads/${uploadId}/content`) {
      uploadedBytes=body; uploadState='SCANNING';
      return json(res,200,{uploadId,state:'PENDING_UPLOAD',byteLength:bytes.length,sha256});
    }
    if(req.method==='POST'&&req.url===`/v1/agent/files/uploads/${uploadId}/finalize`) {
      uploadState='READY'; return json(res,200,{uploadId,state:'READY',file:readyFile});
    }
    if(req.method==='GET'&&req.url===`/v1/agent/files/${fileId}/content`) {
      res.writeHead(200,{'content-type':'application/octet-stream','content-length':String(bytes.length)});res.end(bytes);return;
    }
    return json(res,404,{error:'not_found',message:'Unexpected fixture route'});
  });
  const store=await MarketplaceProfileStore.open(home);
  const scopes=['products:read','products:write','products:publish','files:read','files:write'];
  store.createProfile({id:'seller',origin:http.origin,audience:'marketplace',accountId,agentId,identityId,
    controllerNetwork:'ATTO',controllerAddress:`atto://${'a'.repeat(61)}`,authMode:'scoped-api-key',apiKey:'seller-key',apiScopes:scopes});
  store.createProfile({id:'no-file-write',origin:http.origin,audience:'marketplace',accountId,agentId,identityId,
    controllerNetwork:'ATTO',controllerAddress:`atto://${'a'.repeat(61)}`,authMode:'scoped-api-key',apiKey:'limited-key',
    apiScopes:['products:read','products:write','products:publish','files:read']});
  const client=await connect(home,'seller',filesDirectory);
  try {
    const tools=await client.listTools();
    for(const name of ['marketplace_products_search','marketplace_product_get','marketplace_products_list','marketplace_product_seller_get',
      'marketplace_product_draft_create','marketplace_product_draft_update','marketplace_product_publish','marketplace_product_unpublish',
      'marketplace_product_file_upload','marketplace_product_file_download']) assert.ok(tools.tools.some(tool=>tool.name===name),name);
    for(const name of ['marketplace_product_purchase','marketplace_product_refund','marketplace_purchases_list','marketplace_purchase_get',
      'marketplace_product_orders_list','marketplace_purchase_content_get','marketplace_purchase_receipt_get','marketplace_purchase_file_download']) {
      assert.ok(tools.tools.some(tool=>tool.name===name),name);
    }

    // Public listing and detail remain anonymous and reject no private fields into their result.
    const search=await client.callTool({name:'marketplace_products_search',arguments:{asset:'ATTO',q:'research'}});
    const publicOutput=contentText(search);
    assert.equal(search.isError,undefined,publicOutput);
    assert.equal(JSON.parse(publicOutput).result.items[0].productId,productId);
    assert.equal(publicOutput.includes('Seller-only notes'),false);
    const publicGet=await client.callTool({name:'marketplace_product_get',arguments:{productId}});
    assert.equal(publicGet.isError,undefined,contentText(publicGet));
    assert.equal(requests.find(item=>item.path==='/v1/products')?.authorization,undefined);

    // Seller reads stay account-scoped; mutation calls carry exact request keys and explicit rights confirmation.
    const listing=await client.callTool({name:'marketplace_products_list',arguments:{}});
    assert.equal(listing.isError,undefined,contentText(listing));
    const sellerRead=await client.callTool({name:'marketplace_product_seller_get',arguments:{productId}});
    assert.equal(sellerRead.isError,undefined,contentText(sellerRead));
    assert.equal(contentText(sellerRead).includes('Seller-only notes'),true);
    const createId='99999999-9999-4999-8999-999999999991';
    const created=await client.callTool({name:'marketplace_product_draft_create',arguments:{requestId:createId,title:'Text-only note',
      summaryMarkdown:'Public summary',paidMarkdown:'Private draft text',licenseText:'Personal use',asset:'ATTO',priceAtomic:'1'}});
    assert.equal(created.isError,undefined,contentText(created));
    const createRequest=requests.find(item=>item.method==='POST'&&item.path==='/v1/agent/products');
    assert.deepEqual(createRequest.body,{title:'Text-only note',summaryMarkdown:'Public summary',paidMarkdown:'Private draft text',
      licenseText:'Personal use',asset:'ATTO',priceAtomic:'1',fileIds:[]});
    assert.equal(createRequest.idempotency,createId);
    const publishId='99999999-9999-4999-8999-999999999992';
    const missingRights=await client.callTool({name:'marketplace_product_publish',arguments:{productId,requestId:publishId,expectedVersion:2}});
    assert.equal(missingRights.isError,true);
    assert.equal(requests.some(item=>item.path===`/v1/agent/products/${productId}/publish`),false);
    const published=await client.callTool({name:'marketplace_product_publish',arguments:{productId,requestId:publishId,expectedVersion:2,confirmsDistributionRights:true}});
    assert.equal(published.isError,undefined,contentText(published));
    const publishRequest=requests.find(item=>item.path===`/v1/agent/products/${productId}/publish`);
    assert.deepEqual(publishRequest.body,{expectedVersion:2,confirmsDistributionRights:true});
    assert.equal(publishRequest.idempotency,publishId);
    const completeReplayRequestCount=requests.length;
    sellerVersion=3; // A later draft edit must not invalidate replay of this completed publication.
    const completeReplay=await client.callTool({name:'marketplace_product_publish',arguments:{productId,requestId:publishId,
      expectedVersion:2,confirmsDistributionRights:true}});
    assert.equal(completeReplay.isError,undefined,contentText(completeReplay));
    assert.equal(JSON.parse(contentText(completeReplay)).result.recovered,true);
    assert.equal(requests.length,completeReplayRequestCount);

    // A lost first response leaves PENDING; replay keeps the original request after a later draft edit.
    sellerVersion=3;
    const pendingPublishId='99999999-9999-4999-8999-999999999996';
    const beforePendingPublish=requests.length;
    const uncertain=await client.callTool({name:'marketplace_product_publish',arguments:{productId,requestId:pendingPublishId,
      expectedVersion:3,confirmsDistributionRights:true}});
    assert.equal(uncertain.isError,true);
    const firstPendingRequests=requests.slice(beforePendingPublish);
    assert.deepEqual(firstPendingRequests.map(item=>item.path),[
      `/v1/agent/products/${productId}?limit=1`, `/v1/agent/products/${productId}/publish`,
    ]);
    assert.deepEqual(firstPendingRequests[1].body,{expectedVersion:3,confirmsDistributionRights:true});
    assert.equal(firstPendingRequests[1].idempotency,pendingPublishId);
    sellerVersion=4; // Simulate another edit after the backend committed but before the client saw the result.
    const beforePendingReplay=requests.length;
    const pendingReplay=await client.callTool({name:'marketplace_product_publish',arguments:{productId,requestId:pendingPublishId,
      expectedVersion:3,confirmsDistributionRights:true}});
    assert.equal(pendingReplay.isError,undefined,contentText(pendingReplay));
    assert.equal(JSON.parse(contentText(pendingReplay)).result.published,true);
    const replayRequests=requests.slice(beforePendingReplay);
    assert.deepEqual(replayRequests.map(item=>item.path),[`/v1/agent/products/${productId}/publish`]);
    assert.deepEqual(replayRequests[0].body,{expectedVersion:3,confirmsDistributionRights:true});
    assert.equal(replayRequests[0].idempotency,pendingPublishId);
    const unpublished=await client.callTool({name:'marketplace_product_unpublish',arguments:{productId,
      requestId:'99999999-9999-4999-8999-999999999993',expectedVersion:4}});
    assert.equal(unpublished.isError,undefined,contentText(unpublished));

    // The product-file flow uses explicit local selection, returns unattached READY metadata, and verifies an exact release download.
    const uploaded=await client.callTool({name:'marketplace_product_file_upload',arguments:{sourcePath:'source.txt',
      requestId:'99999999-9999-4999-8999-999999999994'}});
    assert.equal(uploaded.isError,undefined,contentText(uploaded));
    assert.equal(JSON.parse(contentText(uploaded)).result.attached,false);
    assert.deepEqual(uploadedBytes,bytes);
    const downloaded=await client.callTool({name:'marketplace_product_file_download',arguments:{productId,releaseSequence:1,fileId,
      destinationPath:'downloads/restored.txt'}});
    assert.equal(downloaded.isError,undefined,contentText(downloaded));
    assert.deepEqual(await readFile(join(filesDirectory,'downloads/restored.txt')),bytes);
    const beforeDenied= requests.length;
    const limited=await connect(home,'no-file-write',filesDirectory);
    try {
      const denied=await limited.callTool({name:'marketplace_product_draft_update',arguments:{productId,requestId:'99999999-9999-4999-8999-999999999995',
        expectedVersion:5,title:'Research bundle',summaryMarkdown:'## Public overview',paidMarkdown:'Seller-only notes',
        licenseText:'Personal use',asset:'ATTO',priceAtomic:'1000000000',fileIds:[fileId]}});
      assert.equal(denied.isError,true);
      assert.equal(JSON.parse(contentText(denied)).error.code,'SCOPE_REQUIRED');
      assert.equal(requests.length,beforeDenied);
      const beforeFilePublish=requests.length;
      const deniedPublish=await limited.callTool({name:'marketplace_product_publish',arguments:{productId,
        requestId:'99999999-9999-4999-8999-999999999997',expectedVersion:4,confirmsDistributionRights:true}});
      assert.equal(deniedPublish.isError,true);
      assert.equal(JSON.parse(contentText(deniedPublish)).error.code,'SCOPE_REQUIRED');
      assert.equal(requests.slice(beforeFilePublish).filter(item=>item.path===`/v1/agent/products/${productId}/publish`).length,0);
    } finally { await limited.close(); }
  } finally {
    await client.close();
    await new Promise(resolve=>http.close(resolve));
    store.close();
    await rm(root,{recursive:true,force:true});
  }
});

async function connect(home,profile,filesDirectory) {
  const client=new Client({name:'test-marketplace-shop',version:'1.0.0'});
  const environment=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>typeof value==='string'
    &&key!=='NODE_TEST_CONTEXT'&&!key.startsWith('NODE_TEST_')));
  const args=[serverMain,'--profile',profile,'--home',home,'--files-dir',filesDirectory];
  await client.connect(new StdioClientTransport({command:process.execPath,args,env:environment,stderr:'pipe'}));
  return client;
}

async function listen(handler) {
  const server=createServer((req,res)=>{void Promise.resolve(handler(req,res)).catch(()=>{if(!res.destroyed)json(res,500,{});});});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const address=server.address();return Object.assign(server,{origin:`http://127.0.0.1:${address.port}`});
}
async function readBody(req){const chunks=[];for await(const chunk of req)chunks.push(chunk);return Buffer.concat(chunks);}
function json(res,status,body){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));}
function contentText(result){return result.content?.filter(part=>part.type==='text').map(part=>part.text).join('\n')??'';}
