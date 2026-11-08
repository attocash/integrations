import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MarketplaceProfileStore } from '../dist/profile-store.js';
import { approvalRequestDigest } from '../dist/approval-files.js';
import { AttoPrivateKey } from '@attocash/commons-core';

const id=n=>`de305d54-75b4-431b-adb2-eb6b9e5460${String(n).padStart(2,'0')}`;
const accountId=id(1),agentId=id(2),identityId=id(3),productId=id(4),releaseId=id(5),purchaseId=id(6),fileId=id(7),contentVersionId=id(8);
const releaseHash='a'.repeat(64),manifestHash='b'.repeat(64),createdAt='2026-10-16T20:00:00Z';
const bytes=Buffer.from('immutable purchased bytes\n');
const file={ordinal:0,fileId,contentVersionId,filename:'paid.txt',byteLength:bytes.length,mediaType:'text/plain',sha256:createHash('sha256').update(bytes).digest('hex')};
const pair=generateKeyPairSync('ed25519');
const fields=['schema','keyVersion','receiptId','purchaseId','buyerAccountId','buyerAgentId','sellerAccountId','sellerAgentId',
  'productId','releaseId','releaseHash','manifestHash','asset','grossAtomic','feeAtomic','netAtomic','feeRateBasisPoints',
  'commandId','ledgerTransactionId','outcome','createdAt','settledAt'];
const refundFields=['originalPurchaseReceiptId','originalPurchaseReceiptHash','originalPurchaseLedgerTransactionId',
  'authority','actorAccountId','actorIdentityId'];

test('stdio purchase recovery keeps exact saved terms, limits scoped keys, verifies receipts and bought bytes',async()=>{
  // Given scoped profiles and a deterministic server that applies a purchase before losing its first response.
  const root=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-purchases-'));
  const home=join(root,'profile'),filesDirectory=join(root,'files');
  await mkdir(join(filesDirectory,'downloads'),{recursive:true,mode:0o700});
  const requests=[];
  let currentPrice='101',lost=true,refunded=false;
  let purchase=order(false);
  const purchaseReceipt=makeReceipt('PURCHASE',purchase);
  purchase={...purchase,receiptHash:purchaseReceipt.contentSha256};
  let refundReceipt;
  const http=await listen(async(req,res)=>{
    const body=req.method==='GET'?undefined:await readJson(req);
    requests.push({method:req.method,path:req.url,key:req.headers['idempotency-key'],body});
    if(req.method==='GET'&&req.url===`/v1/products/${productId}`) return json(res,200,publicProduct(currentPrice));
    if(req.method==='POST'&&req.url===`/v1/agent/releases/${releaseId}/purchase`) {
      assert.deepEqual(body,{expectedReleaseHash:releaseHash});
      if(lost){lost=false;return json(res,503,{error:'temporary_error'});}
      return json(res,200,purchase);
    }
    if(req.method==='GET'&&req.url==='/v1/agent/purchases') return json(res,200,[purchase]);
    if(req.method==='GET'&&req.url===`/v1/agent/purchases/${purchaseId}`) return json(res,200,purchase);
    if(req.method==='GET'&&req.url===`/v1/agent/products/${productId}/orders`) return json(res,200,[{
      purchaseId,buyerAgentId:agentId,releaseId,status:purchase.status,createdAt,refundedAt:purchase.refundedAt}]);
    if(req.method==='GET'&&req.url===`/v1/agent/purchases/${purchaseId}/content`) {
      if(refunded)return json(res,403,{error:'forbidden'});
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
      assert.deepEqual(body,{expectedPurchaseVersion:0});
      refunded=true;purchase={...order(true),receiptHash:purchaseReceipt.contentSha256};
      refundReceipt=makeReceipt('REFUND',purchase);
      purchase={...purchase,receiptHash:purchaseReceipt.contentSha256,refundReceiptHash:refundReceipt.contentSha256};
      return json(res,200,purchase);
    }
    return json(res,404,{error:'not_found'});
  });
  const store=await MarketplaceProfileStore.open(home);
  const basic={origin:http.origin,audience:'marketplace',accountId,agentId,identityId,
    controllerNetwork:'ATTO',controllerAddress:`atto://${'a'.repeat(61)}`,authMode:'scoped-api-key'};
  store.createProfile({id:'buyer',...basic,apiKey:'buyer-key',apiScopes:['products:purchase','purchases:read','purchases:refund','files:read','products:read'],
    purchaseAttoLimit:'101'});
  store.createProfile({id:'low-limit',...basic,apiKey:'limited-key',apiScopes:['products:purchase'],purchaseAttoLimit:'100'});
  const buyer=await connect(home,'buyer',filesDirectory);
  try {
    const args={productId,releaseId,expectedReleaseHash:releaseHash,asset:'ATTO',grossAtomic:'101',requestId:id(20)};
    const lower=await connect(home,'low-limit',filesDirectory);
    try {
      const denied=await lower.callTool({name:'marketplace_product_purchase',arguments:args});
      assert.equal(denied.isError,true);
      assert.equal(JSON.parse(text(denied)).error.code,'CEILING_EXCEEDED');
      assert.equal(requests.length,0);
    } finally { await lower.close(); }

    // When a response is lost after posting, the exact saved request retries without a new offer preflight.
    const uncertain=await buyer.callTool({name:'marketplace_product_purchase',arguments:args});
    assert.equal(uncertain.isError,true);
    const beforeRetry=requests.length;
    currentPrice='999';
    const recovered=await buyer.callTool({name:'marketplace_product_purchase',arguments:args});
    assert.equal(recovered.isError,undefined,text(recovered));
    assert.equal(JSON.parse(text(recovered)).result.purchaseId,purchaseId);
    assert.deepEqual(requests.slice(beforeRetry).map(item=>item.path),[`/v1/agent/releases/${releaseId}/purchase`]);
    assert.deepEqual(requests.filter(item=>item.path===`/v1/agent/releases/${releaseId}/purchase`).map(item=>item.key),[id(20),id(20)]);
    const wrongReplay=await buyer.callTool({name:'marketplace_product_purchase',arguments:{...args,grossAtomic:'100'}});
    assert.equal(wrongReplay.isError,true);
    const afterComplete=await buyer.callTool({name:'marketplace_product_purchase',arguments:args});
    assert.equal(afterComplete.isError,undefined,text(afterComplete));
    assert.equal(JSON.parse(text(afterComplete)).result.commandId,id(30));

    // Then historical access uses the exact purchase, signature and byte manifest.
    const content=await buyer.callTool({name:'marketplace_purchase_content_get',arguments:{purchaseId}});
    assert.equal(JSON.parse(text(content)).result.paidMarkdown,'Private licensed text');
    const signed=await buyer.callTool({name:'marketplace_purchase_receipt_get',arguments:{purchaseId,kind:'PURCHASE'}});
    assert.equal(signed.isError,undefined,text(signed));
    assert.equal(JSON.parse(text(signed)).result.verified,true);
    const downloaded=await buyer.callTool({name:'marketplace_purchase_file_download',arguments:{purchaseId,fileId,
      destinationPath:'downloads/paid.txt'}});
    assert.equal(downloaded.isError,undefined,text(downloaded));
    assert.deepEqual(await readFile(join(filesDirectory,'downloads/paid.txt')),bytes);

    // A full refund retains the original purchase command and signs a distinct refund command.
    const refundArgs={purchaseId,expectedPurchaseVersion:0,originalPurchaseReceiptHash:purchase.receiptHash,
      asset:'ATTO',grossAtomic:'101',requestId:id(21)};
    const refundedResult=await buyer.callTool({name:'marketplace_product_refund',arguments:refundArgs});
    assert.equal(refundedResult.isError,undefined,text(refundedResult));
    assert.equal(JSON.parse(text(refundedResult)).result.commandId,id(30));
    assert.equal(JSON.parse(text(refundedResult)).result.refundCommandId,id(31));
    const signedRefund=await buyer.callTool({name:'marketplace_purchase_receipt_get',arguments:{purchaseId,kind:'REFUND'}});
    assert.equal(signedRefund.isError,undefined,text(signedRefund));
    const revoked=await buyer.callTool({name:'marketplace_purchase_content_get',arguments:{purchaseId}});
    assert.equal(revoked.isError,true);
  } finally {
    await buyer.close();await new Promise(resolve=>http.close(resolve));store.close();await rm(root,{recursive:true,force:true});
  }
});

test('typed session replays exact purchase and refund proofs for both assets after 429, lost ack and restart',async()=>{
  // Given a session controller whose ATTO key signs exact server-issued proof text for either purchase asset.
  const root=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-purchase-proof-'));
  const home=join(root,'profile');
  const signer=await AttoPrivateKey.Companion.parse('01'.repeat(32)).toSigner();
  const address=signer.address.toString();
  const seen=[];
  let currentAsset='ATTO';
  const sends=new Map(),purchased=new Set(),refunded=new Set();
  const http=await listen(async(req,res)=>{
    const body=req.method==='GET'?null:await readJson(req);
    seen.push({method:req.method,path:req.url,key:req.headers['idempotency-key'],body});
    const assetName=req.url?.includes(id(51)) || req.url?.includes(id(61))?'XNO':'ATTO';
    const selectedRelease=assetName==='XNO'?id(51):id(50);
    const gross=assetName==='XNO'?'900719925474099312345':'101';
    const fee=assetName==='XNO'?'9007199254740993123':'1';
    const net=(BigInt(gross)-BigInt(fee)).toString();
    if(req.method==='GET'&&req.url===`/v1/products/${productId}`) {
      const selected=currentAsset;
      return json(res,200,{...publicProduct(selected==='XNO'?'900719925474099312345':'101'),
        releaseId:selected==='XNO'?id(51):id(50),asset:selected});
    }
    if(req.method==='POST'&&req.url===`/v1/agent/releases/${selectedRelease}/purchase/challenges`) {
      const binding=lengthPrefixedHash(['marketplace-product-purchase-approval-v1',accountId,identityId,
        selectedRelease,releaseHash,assetName,gross,body.idempotencyKey]);
      return json(res,200,{releaseId:selectedRelease,releaseHash,sellerAgentId:agentId,asset:assetName,
        grossAtomic:gross,feeAtomic:fee,netAtomic:net,
        challenge:proofChallenge(id(52),address,'product purchase',binding)});
    }
    if(req.method==='POST'&&req.url===`/v1/agent/releases/${selectedRelease}/purchase`) {
      assert.equal(body.proof.signature,await signMessage(signer,body.proof.message));
      const count=(sends.get(`purchase-${assetName}`)??0)+1;sends.set(`purchase-${assetName}`,count);
      if(count===1) {
        if(assetName==='ATTO')return json(res,429,{error:'temporary_rate_limit'});
        purchased.add(assetName);res.destroy();return;
      }
      purchased.add(assetName);
      return json(res,200,sessionOrder(assetName,false));
    }
    const purchaseId=assetName==='ATTO'?id(60):id(61);
    if(req.method==='GET'&&req.url===`/v1/agent/purchases/${purchaseId}`) {
      return json(res,200,sessionOrder(assetName,refunded.has(assetName)));
    }
    if(req.method==='POST'&&req.url===`/v1/agent/purchases/${purchaseId}/refund/challenges`) {
      const original='c'.repeat(64);
      const binding=lengthPrefixedHash(['marketplace-product-refund-approval-v1','SELLER',accountId,identityId,
        purchaseId,original,'0',assetName,gross,body.idempotencyKey]);
      return json(res,200,{purchaseId,authority:'SELLER',buyerAgentId:agentId,sellerAgentId:agentId,
        asset:assetName,grossAtomic:gross,feeAtomic:fee,netAtomic:net,originalPurchaseReceiptHash:original,
        challenge:proofChallenge(id(53),address,'product refund',binding)});
    }
    if(req.method==='POST'&&req.url===`/v1/agent/purchases/${purchaseId}/refund`) {
      assert.equal(body.proof.signature,await signMessage(signer,body.proof.message));
      const count=(sends.get(`refund-${assetName}`)??0)+1;sends.set(`refund-${assetName}`,count);
      if(count===1) {
        if(assetName==='ATTO')return json(res,429,{error:'temporary_rate_limit'});
        refunded.add(assetName);res.destroy();return;
      }
      refunded.add(assetName);
      return json(res,200,sessionOrder(assetName,true));
    }
    return json(res,404,{error:'not_found'});
  });
  const store=await MarketplaceProfileStore.open(home);
  store.createProfile({id:'session',origin:http.origin,audience:'marketplace',accountId,agentId,identityId,
    controllerNetwork:'ATTO',controllerAddress:address,controllerIndex:0,authMode:'controller-session',
    accessToken:'session-token',accessExpiresAt:Date.now()+120_000,
    refreshToken:'refresh-token',refreshExpiresAt:Date.now()+240_000});
  let client=await connect(home,'session',undefined);
  try {
    for(const [assetName,selectedRelease,gross,key] of [
      ['ATTO',id(50),'101',id(70)],['XNO',id(51),'900719925474099312345',id(71)]]) {
      currentAsset=assetName;
      const args={productId,releaseId:selectedRelease,expectedReleaseHash:releaseHash,
        asset:assetName,grossAtomic:gross,requestId:key};
      const pending=await client.callTool({name:'marketplace_product_purchase',arguments:args});
      assert.equal(pending.isError,undefined,text(pending));
      const handoff=JSON.parse(text(pending)).result;
      assert.equal(handoff.status,'approval_required');
      const requestPath=join(home,'approvals','session',`${handoff.handoffId}.request.json`);
      const request=JSON.parse(await readFile(requestPath,'utf8'));
      assert.equal(request.purpose,'product purchase');
      assert.deepEqual(request.action,{kind:'productPurchase',releaseId:selectedRelease,expectedReleaseHash:releaseHash,
        sellerAgentId:agentId,asset:assetName,grossAtomic:gross,
        feeAtomic:assetName==='ATTO'?'1':'9007199254740993123',
        netAtomic:assetName==='ATTO'?'100':'891712726219358319222',idempotencyKey:key});
      const responsePath=requestPath.replace(/\.request\.json$/,'.response.json');
      const response={version:1,type:'marketplace-controller-approval-response',profileId:request.profileId,
        handoffId:request.handoffId,requestDigest:approvalRequestDigest(request),
        challengeId:request.challenge.challengeId,message:request.challenge.message,
        signature:await signMessage(signer,request.challenge.message),controllerAddress:address,controllerIndex:0};
      await writeFile(responsePath,`${JSON.stringify(response)}\n`,{mode:0o600});await chmod(responsePath,0o600);
      const lost=await client.callTool({name:'marketplace_product_purchase',arguments:args});
      assert.equal(lost.isError,true,text(lost));
      assert.equal(store.getHandoff('session',handoff.handoffId).state,'UNKNOWN');
      if(assetName==='XNO') {
        store.setHandoffState('session',handoff.handoffId,'SUBMITTING');
        await client.close();client=await connect(home,'session',undefined);
      }
      const completed=await client.callTool({name:'marketplace_product_purchase',arguments:args});
      assert.equal(completed.isError,undefined,text(completed));
      assert.equal(JSON.parse(text(completed)).result.asset,assetName);
      assert.equal(seen.filter(item=>item.path===`/v1/agent/releases/${selectedRelease}/purchase`).length,2);
      assert.deepEqual(seen.filter(item=>item.path===`/v1/agent/releases/${selectedRelease}/purchase`)
        .map(item=>item.body.proof),[responseProof(response),responseProof(response)]);

      const purchaseId=assetName==='ATTO'?id(60):id(61);
      const refundArgs={purchaseId,expectedPurchaseVersion:0,originalPurchaseReceiptHash:'c'.repeat(64),
        asset:assetName,grossAtomic:gross,requestId:assetName==='ATTO'?id(72):id(73)};
      const refundPending=await client.callTool({name:'marketplace_product_refund',arguments:refundArgs});
      assert.equal(JSON.parse(text(refundPending)).result.status,'approval_required');
      const refundHandle=JSON.parse(text(refundPending)).result.handoffId;
      const refundPath=join(home,'approvals','session',`${refundHandle}.request.json`);
      const refundRequest=JSON.parse(await readFile(refundPath,'utf8'));
      assert.equal(refundRequest.action.kind,'productRefund');
      const refundResponse={version:1,type:'marketplace-controller-approval-response',profileId:refundRequest.profileId,
        handoffId:refundRequest.handoffId,requestDigest:approvalRequestDigest(refundRequest),
        challengeId:refundRequest.challenge.challengeId,message:refundRequest.challenge.message,
        signature:await signMessage(signer,refundRequest.challenge.message),controllerAddress:address,controllerIndex:0};
      await writeFile(refundPath.replace(/\.request\.json$/,'.response.json'),`${JSON.stringify(refundResponse)}\n`,{mode:0o600});
      const refundLost=await client.callTool({name:'marketplace_product_refund',arguments:refundArgs});
      assert.equal(refundLost.isError,true,text(refundLost));
      assert.equal(store.getHandoff('session',refundHandle).state,'UNKNOWN');
      if(assetName==='XNO') {
        store.setHandoffState('session',refundHandle,'SUBMITTING');
        await client.close();client=await connect(home,'session',undefined);
      }
      const refundCompleted=await client.callTool({name:'marketplace_product_refund',arguments:refundArgs});
      assert.equal(refundCompleted.isError,undefined,text(refundCompleted));
      assert.equal(JSON.parse(text(refundCompleted)).result.status,'REFUNDED');
      assert.equal(store.getHandoff('session',refundHandle).state,'COMPLETE');
      assert.equal(seen.filter(item=>item.path===`/v1/agent/purchases/${purchaseId}/refund`).length,2);
      assert.deepEqual(seen.filter(item=>item.path===`/v1/agent/purchases/${purchaseId}/refund`)
        .map(item=>item.body.proof),[responseProof(refundResponse),responseProof(refundResponse)]);
    }
    assert.deepEqual([...purchased].sort(),['ATTO','XNO']);
    assert.deepEqual([...refunded].sort(),['ATTO','XNO']);
  } finally {await client.close();await new Promise(resolve=>http.close(resolve));store.close();await rm(root,{recursive:true,force:true});}
});

function responseProof(response){return {challengeId:response.challengeId,message:response.message,signature:response.signature};}
function sessionOrder(assetName,isRefunded){
  const gross=assetName==='XNO'?'900719925474099312345':'101';
  const fee=assetName==='XNO'?'9007199254740993123':'1';
  const purchaseId=assetName==='ATTO'?id(60):id(61);
  return {...order(isRefunded),purchaseId,commandId:assetName==='ATTO'?id(30):id(36),
    releaseId:assetName==='ATTO'?id(50):id(51),asset:assetName,grossAtomic:gross,feeAtomic:fee,
    netAtomic:(BigInt(gross)-BigInt(fee)).toString(),refundCommandId:isRefunded?(assetName==='ATTO'?id(31):id(37)):null};
}

function proofChallenge(challengeId,address,purpose,bindingHash){
  const issuedAt=new Date(Date.now()-1000).toISOString(),expiresAt=new Date(Date.now()+120_000).toISOString();
  return {challengeId,issuedAt,expiresAt,message:[
    'Marketplace Agent Controller Proof v1','Audience: marketplace','Network: live',`Address: ${address}`,
    `Purpose: ${purpose}`,`Request ID: ${challengeId}`,`Binding Hash: ${bindingHash}`,
    `Nonce: ${'a'.repeat(64)}`,`Issued At: ${issuedAt}`,`Expiration Time: ${expiresAt}`].join('\n')};
}
function lengthPrefixedHash(fields){return createHash('sha256').update(Buffer.concat(fields.map(field=>{
  const bytes=Buffer.from(field),length=Buffer.alloc(4);length.writeUInt32BE(bytes.length);return Buffer.concat([length,bytes]);
}))).digest('hex');}
async function signMessage(signer,message){return (await signer.signMessage(Int8Array.from(Buffer.from(message,'utf8')))).toString();}

function order(refunded){return {purchaseId,commandId:id(30),productId,releaseId,releaseHash,manifestHash,
  buyerAgentId:agentId,sellerAgentId:agentId,asset:'ATTO',grossAtomic:'101',feeAtomic:'1',netAtomic:'100',
  feeRateBasisPoints:100,status:refunded?'REFUNDED':'ACTIVE',version:refunded?1:0,entitlementActive:!refunded,
  receiptId:id(32),receiptHash:'c'.repeat(64),createdAt,refundedAt:refunded?createdAt:null,
  refundReceiptId:refunded?id(33):null,refundReceiptHash:refunded?'d'.repeat(64):null,
  refundCommandId:refunded?id(31):null};}
function publicProduct(price){return {productId,releaseId,releaseSequence:1,releaseHash,sellerAgentId:agentId,sellerProfile:null,
  title:'Paid note',summaryMarkdown:'Public description',asset:'ATTO',priceAtomic:price,licenseText:'Personal use',manifestHash,
  files:[{fileId,filename:'paid.txt',byteLength:bytes.length,mediaType:'text/plain'}]};}
function makeReceipt(kind,purchase){
  const isRefund=kind==='REFUND',receiptId=isRefund?id(33):id(32),commandId=isRefund?id(31):id(30);
  const values=[`marketplace-product-${isRefund?'refund':'purchase'}-receipt-v1`,'test-v1',receiptId,purchaseId,
    accountId,agentId,accountId,agentId,productId,releaseId,releaseHash,manifestHash,'ATTO','101','1','100','100',
    commandId,isRefund?id(35):id(34),isRefund?'REFUNDED':'PURCHASED',createdAt,createdAt,
    ...(isRefund?[id(32),purchase.receiptHash,id(34),'SELLER',accountId,identityId]:[])];
  const bytes=Buffer.concat(values.map(value=>{const raw=Buffer.from(value),prefix=Buffer.alloc(4);prefix.writeUInt32BE(raw.length);return Buffer.concat([prefix,raw]);}));
  const digest=createHash('sha256').update(bytes).digest();
  return {receiptId,kind,content:Object.fromEntries((isRefund?[...fields,...refundFields]:fields).map((field,index)=>[field,values[index]])),
    canonicalBase64:bytes.toString('base64'),contentSha256:digest.toString('hex'),
    signatureBase64:sign(null,Buffer.concat([Buffer.from(`marketplace-product-${isRefund?'refund':'purchase'}-receipt-signature-v1\0`),digest]),pair.privateKey).toString('base64'),
    keyVersion:'test-v1'};
}
async function connect(home,profile,filesDirectory){
  const client=new Client({name:'test-marketplace-purchases',version:'1.0.0'});
  const env=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>typeof value==='string'&&key!=='NODE_TEST_CONTEXT'&&!key.startsWith('NODE_TEST_')));
  await client.connect(new StdioClientTransport({command:process.execPath,args:[join(import.meta.dirname,'../dist/main.js'),
    '--profile',profile,'--home',home,...(filesDirectory?['--files-dir',filesDirectory]:[])],env,stderr:'pipe'}));
  return client;
}
async function listen(handler){const server=createServer((req,res)=>{void Promise.resolve(handler(req,res)).catch(error=>json(res,500,{error:String(error)}));});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  return Object.assign(server,{origin:`http://127.0.0.1:${server.address().port}`});}
async function readJson(req){const chunks=[];for await(const chunk of req)chunks.push(chunk);return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
function json(res,status,body){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));}
function text(result){return result.content?.filter(part=>part.type==='text').map(part=>part.text).join('\n')??'';}
