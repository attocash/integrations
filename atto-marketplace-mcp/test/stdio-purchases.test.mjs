import {fileURLToPath,pathToFileURL} from 'node:url';
const packageDirectory=process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR??fileURLToPath(new URL('../',import.meta.url));
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const { MarketplaceProfileStore }=await import(pathToFileURL(join(packageDirectory,'dist/profile-store.js')).href);

const id=n=>`de305d54-75b4-431b-adb2-eb6b9e5460${String(n).padStart(2,'0')}`;
const accountId=id(1),agentId=id(2),identityId=id(3),productId=id(4),releaseId=id(5),purchaseId=id(6),fileId=id(7),contentVersionId=id(8);
const releaseHash='a'.repeat(64),manifestHash='b'.repeat(64),createdAt='2026-10-16T20:00:00Z';
const bytes=Buffer.from('immutable purchased bytes\n');
const file={ordinal:0,fileId,contentVersionId,filename:'paid.txt',byteLength:bytes.length,mediaType:'text/plain',sha256:createHash('sha256').update(bytes).digest('hex')};
const pair=generateKeyPairSync('ed25519');

function order(asset='ATTO',status='RESERVED') {
  const active=status==='ACTIVE',paid=['ACTIVE','REFUNDED'].includes(status),refunded=status==='REFUNDED';
  return {purchaseId,productId,releaseId,releaseHash,manifestHash,buyerAgentId:agentId,sellerAgentId:agentId,
    asset,grossAtomic:asset==='ATTO'?'101':'900719925474099312345',status,version:paid?1:0,entitlementActive:active,
    paymentRequirementId:id(40),reservationExpiresAt:'2026-10-16T20:30:00Z',receiptId:paid?id(32):null,receiptHash:null,
    createdAt,refundedAt:refunded?createdAt:null,refundReceiptId:refunded?id(33):null,refundReceiptHash:null,
    refundPaymentRequirementId:null,paidTransactionHash:paid?'c'.repeat(64):null};
}
const publicProduct=(asset,price)=>({productId,releaseId,releaseSequence:1,releaseHash,sellerAgentId:agentId,sellerProfile:null,
  title:'Paid note',summaryMarkdown:'Public description',asset,priceAtomic:price,licenseText:'Personal use',manifestHash,
  files:[{fileId,filename:'paid.txt',byteLength:bytes.length,mediaType:'text/plain'}]});

// Match actual canonical JSON v2 receipts; native transaction evidence replaces ledger/command IDs.
function makeReceipt(kind,purchase) {
  const refund=kind==='REFUND',receiptId=refund?id(33):id(32);
  const content={schema:`marketplace-product-${refund?'refund':'purchase'}-receipt-v2`,receiptId,purchaseId,
    productId,releaseId,releaseHash,manifestHash,buyerAgentId:agentId,sellerAgentId:agentId,asset:purchase.asset,
    amountAtomic:purchase.grossAtomic,paymentRequirementId:refund?purchase.refundPaymentRequirementId:purchase.paymentRequirementId,
    transactionHash:refund?'d'.repeat(64):purchase.paidTransactionHash,senderAddress:refund?'seller-wallet':'buyer-wallet',
    recipientAddress:refund?'buyer-wallet':'seller-wallet'};
  const canonical=Buffer.from(JSON.stringify(content)),digest=createHash('sha256').update(canonical).digest();
  return {receiptId,kind,content,canonicalBase64:canonical.toString('base64'),contentSha256:digest.toString('hex'),
    signatureBase64:sign(null,Buffer.concat([Buffer.from(`marketplace-product-${refund?'refund':'purchase'}-v2\0`),digest]),pair.privateKey).toString('base64'),keyVersion:'test-v1'};
}

test('stdio reservation recovery preserves terms and scopes then verifies v2 receipts and immutable bought bytes',async()=>{
  // Given
  const root=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-purchases-'));
  const home=join(root,'profile'),filesDirectory=join(root,'files');
  await mkdir(join(filesDirectory,'downloads'),{recursive:true,mode:0o700});
  const requests=[];
  let currentPrice='101',lost=true,purchase=order(),purchaseReceipt,refundReceipt;
  const http=await listen(async(req,res)=>{
    const body=req.method==='GET'?undefined:await readJson(req);
    requests.push({path:req.url,key:req.headers['idempotency-key'],body});
    if(req.method==='GET'&&req.url===`/v1/products/${productId}`) return json(res,200,publicProduct('ATTO',currentPrice));
    if(req.method==='POST'&&req.url===`/v1/agent/releases/${releaseId}/purchase`) {
      assert.deepEqual(body,{expectedReleaseHash:releaseHash});
      if(req.headers.authorization==='Bearer limited-key')return json(res,403,{error:'forbidden'});
      if(lost){lost=false;return json(res,503,{error:'temporary_error'});}
      return json(res,200,purchase);
    }
    if(req.method==='GET'&&req.url==='/v1/agent/purchases') return json(res,200,[purchase]);
    if(req.method==='GET'&&req.url===`/v1/agent/purchases/${purchaseId}`) return json(res,200,purchase);
    if(req.method==='GET'&&req.url===`/v1/agent/purchases/${purchaseId}/content`) {
      if(!purchase.entitlementActive) return json(res,403,{error:'forbidden'});
      return json(res,200,{purchaseId,releaseId,paidMarkdown:'Private licensed text',licenseText:'Personal use',manifestHash,files:[file]});
    }
    if(req.method==='GET'&&req.url===`/v1/agent/files/${fileId}/content`) {
      res.writeHead(200,{'content-type':'application/octet-stream','content-length':String(bytes.length)});res.end(bytes);return;
    }
    if(req.method==='GET'&&req.url===`/v1/agent/purchases/${purchaseId}/receipt`) return json(res,200,purchaseReceipt);
    if(req.method==='GET'&&req.url===`/v1/agent/purchases/${purchaseId}/refund/receipt`) return json(res,200,refundReceipt);
    if(req.method==='GET'&&req.url==='/v1/receipts/keys/test-v1') return json(res,200,{
      version:'test-v1',algorithm:'Ed25519',publicKeyBase64:pair.publicKey.export({format:'der',type:'spki'}).toString('base64')});
    if(req.method==='POST'&&req.url===`/v1/agent/purchases/${purchaseId}/refund`) {
      assert.deepEqual(body,{expectedPurchaseVersion:1});
      purchase={...purchase,refundPaymentRequirementId:id(41)};
      return json(res,200,purchase);
    }
    return json(res,404,{error:'not_found'});
  });
  const store=await MarketplaceProfileStore.open(home);
  const basic={origin:http.origin,audience:'marketplace',accountId,agentId,identityId,controllerNetwork:'ATTO',
    controllerAddress:`atto://${'a'.repeat(61)}`,authMode:'scoped-api-key'};
  store.createProfile({id:'buyer',...basic,apiKey:'buyer-key',apiScopes:['products:purchase','purchases:read','purchases:refund','files:read','products:read'],purchaseAttoLimit:'101'});
  store.createProfile({id:'low-limit',...basic,apiKey:'limited-key',apiScopes:['products:purchase'],purchaseAttoLimit:'100'});
  const buyer=await connect(home,'buyer',filesDirectory);
  try {
    const args={productId,releaseId,expectedReleaseHash:releaseHash,asset:'ATTO',grossAtomic:'101',requestId:id(20)};
    const limited=await connect(home,'low-limit',filesDirectory);
    try {
      // When current backend authority denies this credential's actual purchase amount.
      const denied=await limited.callTool({name:'marketplace_product_purchase',arguments:args});
      // Then the denial remains authoritative and is never bypassed with another credential.
      assert.equal(denied.isError,true);
      assert.equal(JSON.parse(text(denied)).error.code,'AUTHORIZATION_DENIED');
      assert.deepEqual(requests.map(r=>r.path),[`/v1/agent/releases/${releaseId}/purchase`]);
    } finally { await limited.close(); }
    // When a permitted mutation loses its response and retries the identical saved body and key.
    const uncertain=await buyer.callTool({name:'marketplace_product_purchase',arguments:args});
    assert.equal(uncertain.isError,true);
    const beforeRetry=requests.length;
    currentPrice='999';
    const recovered=await buyer.callTool({name:'marketplace_product_purchase',arguments:args});
    assert.equal(recovered.isError,undefined,text(recovered));
    assert.equal(result(recovered).status,'RESERVED');
    assert.equal(result(recovered).paymentRequirementId,id(40));
    assert.equal(result(recovered).entitlementActive,false);
    assert.deepEqual(requests.slice(beforeRetry).map(r=>r.path),[`/v1/agent/releases/${releaseId}/purchase`]);
    // Then recovery preserves the original requirement and rejects changed immutable terms.
    assert.deepEqual(requests.filter(r=>r.path===`/v1/agent/releases/${releaseId}/purchase`).map(r=>r.key),[id(20),id(20),id(20)]);
    assert.equal((await buyer.callTool({name:'marketplace_product_purchase',arguments:{...args,grossAtomic:'100'}})).isError,true);
    const completedCount=requests.length;
    assert.equal(result(await buyer.callTool({name:'marketplace_product_purchase',arguments:args})).recovered,true);
    assert.equal(requests.length,completedCount);
    assert.equal((await buyer.callTool({name:'marketplace_purchase_content_get',arguments:{purchaseId}})).isError,true);

    // Only a separately verified chain event updates the authoritative fixture, never reservation status.
    purchase=order('ATTO','ACTIVE');purchaseReceipt=makeReceipt('PURCHASE',purchase);
    purchase={...purchase,receiptHash:purchaseReceipt.contentSha256};
    const content=await buyer.callTool({name:'marketplace_purchase_content_get',arguments:{purchaseId}});
    assert.equal(result(content).paidMarkdown,'Private licensed text');
    const signed=await buyer.callTool({name:'marketplace_purchase_receipt_get',arguments:{purchaseId,kind:'PURCHASE'}});
    assert.equal(signed.isError,undefined,text(signed));assert.equal(result(signed).verified,true);
    const downloaded=await buyer.callTool({name:'marketplace_purchase_file_download',arguments:{purchaseId,fileId,destinationPath:'downloads/paid.txt'}});
    assert.equal(downloaded.isError,undefined,text(downloaded));
    assert.deepEqual(await readFile(join(filesDirectory,'downloads/paid.txt')),bytes);
    const requested=await buyer.callTool({name:'marketplace_product_refund',arguments:{purchaseId,expectedPurchaseVersion:1,requestId:id(21)}});
    assert.equal(requested.isError,undefined,text(requested));
    assert.equal(result(requested).refundPaymentRequirementId,id(41));
    assert.equal(result(requested).status,'ACTIVE');
    assert.equal(result(requested).entitlementActive,true);
    purchase={...order('ATTO','REFUNDED'),receiptHash:purchaseReceipt.contentSha256,refundPaymentRequirementId:id(41)};
    refundReceipt=makeReceipt('REFUND',purchase);purchase={...purchase,refundReceiptHash:refundReceipt.contentSha256};
    const signedRefund=await buyer.callTool({name:'marketplace_purchase_receipt_get',arguments:{purchaseId,kind:'REFUND'}});
    assert.equal(signedRefund.isError,undefined,text(signedRefund));assert.equal(result(signedRefund).verified,true);
    assert.equal((await buyer.callTool({name:'marketplace_purchase_content_get',arguments:{purchaseId}})).isError,true);
    assert.equal(requests.some(r=>r.path.includes('/challenges')),false);
  } finally {
    await buyer.close();await new Promise(resolve=>http.close(resolve));store.close();await rm(root,{recursive:true,force:true});
  }
});

for(const asset of ['ATTO','XNO']) test(`${asset} controller-session direct reservation and refund retry same keys after 429, lost ack and restart`,async()=>{
  // Given
  const root=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-direct-order-')),home=join(root,'profile');
  const requests=[],purchase=order(asset);let price=purchase.grossAtomic,purchases=0,refunds=0;
  const http=await listen(async(req,res)=>{
    const body=req.method==='GET'?undefined:await readJson(req);
    requests.push({path:req.url,key:req.headers['idempotency-key'],body});
    if(req.method==='GET'&&req.url===`/v1/products/${productId}`)return json(res,200,publicProduct(asset,price));
    if(req.method==='POST'&&req.url===`/v1/agent/releases/${releaseId}/purchase`) {
      assert.deepEqual(body,{expectedReleaseHash:releaseHash});
      if(++purchases===1)return json(res,429,{error:'temporary_rate_limit'});
      return json(res,200,purchase);
    }
    if(req.method==='POST'&&req.url===`/v1/agent/purchases/${purchaseId}/refund`) {
      assert.deepEqual(body,{expectedPurchaseVersion:1});
      if(++refunds===1){res.destroy();return;}
      return json(res,200,{...order(asset,'ACTIVE'),refundPaymentRequirementId:id(41)});
    }
    return json(res,404,{error:'not_found'});
  });
  const store=await MarketplaceProfileStore.open(home);
  store.createProfile({id:'session',origin:http.origin,audience:'marketplace',accountId,agentId,identityId,
    controllerNetwork:'ATTO',controllerAddress:`atto://${'a'.repeat(61)}`,controllerIndex:0,authMode:'controller-session',
    accessToken:'session-token',accessExpiresAt:Date.now()+120000,refreshToken:'refresh-token',refreshExpiresAt:Date.now()+240000});
  let client=await connect(home,'session');
  try {
    const args={productId,releaseId,expectedReleaseHash:releaseHash,asset,grossAtomic:purchase.grossAtomic,requestId:id(70)};
    // When
    assert.equal((await client.callTool({name:'marketplace_product_purchase',arguments:args})).isError,true);
    price='999';await client.close();client=await connect(home,'session');
    const replay=await client.callTool({name:'marketplace_product_purchase',arguments:args});
    assert.equal(replay.isError,undefined,text(replay));assert.equal(result(replay).paymentRequirementId,id(40));
    const refundArgs={purchaseId,expectedPurchaseVersion:1,requestId:id(71)};
    assert.equal((await client.callTool({name:'marketplace_product_refund',arguments:refundArgs})).isError,true);
    await client.close();client=await connect(home,'session');
    const refund=await client.callTool({name:'marketplace_product_refund',arguments:refundArgs});
    assert.equal(refund.isError,undefined,text(refund));assert.equal(result(refund).refundPaymentRequirementId,id(41));
    // Then
    assert.equal(result(refund).status,'ACTIVE');
    assert.deepEqual(requests.filter(r=>r.path.endsWith('/purchase')).map(r=>r.key),[id(70),id(70)]);
    assert.deepEqual(requests.filter(r=>r.path.endsWith('/refund')).map(r=>r.key),[id(71),id(71)]);
    assert.equal(requests.filter(r=>r.path===`/v1/products/${productId}`).length,0);
    assert.equal(requests.some(r=>r.body?.proof),false);
    assert.equal(requests.some(r=>r.path.includes('/challenges')||r.path.includes('/commands')),false);
  } finally { await client.close();await new Promise(resolve=>http.close(resolve));store.close();await rm(root,{recursive:true,force:true}); }
});

for(const visibility of ['EXHAUSTED','UNLISTED'])test(`fresh-key MCP purchase recovers an owned ${visibility} release without a library scope or native wallet`,async()=>{
  // Given an existing paid order and a public offer which is no longer discoverable.
  const root=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-owned-order-')),home=join(root,'profile'),requests=[];
  const purchase=order('ATTO','ACTIVE');
  const http=await listen(async(req,res)=>{
    const body=req.method==='GET'?undefined:await readJson(req);
    requests.push({method:req.method,path:req.url,key:req.headers['idempotency-key'],body});
    if(req.url===`/v1/products/${productId}`)return json(res,404,{error:'not_found',state:visibility});
    if(req.method==='POST'&&req.url===`/v1/agent/releases/${releaseId}/purchase`){
      assert.equal(req.headers.authorization,'Bearer current-buyer-grant');
      assert.deepEqual(body,{expectedReleaseHash:releaseHash});
      // The backend owns buyer/release recovery and checks its current grant before this result.
      return json(res,200,purchase);
    }
    return json(res,403,{error:'forbidden'});
  });
  const store=await MarketplaceProfileStore.open(home);
  store.createProfile({id:'buyer',origin:http.origin,audience:'marketplace',accountId,agentId,identityId,
    controllerNetwork:'ATTO',controllerAddress:`atto://${'a'.repeat(61)}`,authMode:'scoped-api-key',
    apiKey:'current-buyer-grant',apiScopes:['products:purchase'],purchaseAttoLimit:'1'});
  const client=await connect(home,'buyer');
  try{
    const args={productId,releaseId,expectedReleaseHash:releaseHash,asset:'ATTO',grossAtomic:'101',requestId:id(80)};
    // When a fresh mutation key reaches the authenticated purchase owner despite stale cached ceiling metadata.
    const response=await client.callTool({name:'marketplace_product_purchase',arguments:args});
    // Then the original order/requirement return without a public/library read or native wallet configuration.
    assert.equal(response.isError,undefined,text(response));
    assert.equal(result(response).purchaseId,purchaseId);assert.equal(result(response).paymentRequirementId,id(40));
    assert.equal(result(response).status,'ACTIVE');
    assert.deepEqual(requests,[{method:'POST',path:`/v1/agent/releases/${releaseId}/purchase`,key:id(80),body:{expectedReleaseHash:releaseHash}}]);
    assert.equal((await client.callTool({name:'marketplace_product_purchase',arguments:{...args,expectedReleaseHash:'c'.repeat(64)}})).isError,true);
    assert.equal(requests.length,1);
  }finally{await client.close();await new Promise(resolve=>http.close(resolve));store.close();await rm(root,{recursive:true,force:true});}
});

async function connect(home,profile,filesDirectory){
  const client=new Client({name:'test-marketplace-purchases',version:'1.0.0'});
  const env=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>typeof value==='string'&&key!=='NODE_TEST_CONTEXT'&&!key.startsWith('NODE_TEST_')));
  await client.connect(new StdioClientTransport({command:process.execPath,args:[join(packageDirectory,'dist/main.js'),
    '--profile',profile,'--home',home,...(filesDirectory?['--files-dir',filesDirectory]:[])],env,stderr:'pipe'}));return client;
}
async function listen(handler){const server=createServer((req,res)=>{void Promise.resolve(handler(req,res)).catch(error=>json(res,500,{error:String(error)}));});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  return Object.assign(server,{origin:`http://127.0.0.1:${server.address().port}`});}
async function readJson(req){const chunks=[];for await(const chunk of req)chunks.push(chunk);return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
function json(res,status,body){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));}
function text(result){return result.content?.filter(part=>part.type==='text').map(part=>part.text).join('\n')??'';}
function result(response){return JSON.parse(text(response)).result;}
