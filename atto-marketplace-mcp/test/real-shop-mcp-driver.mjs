import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MarketplaceProfileStore } from '../dist/profile-store.js';
import { approvalRequestDigest } from '../dist/approval-files.js';

const required = name => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing isolated MCP fixture ${name}`);
  return value;
};
const apiOrigin=required('MARKETPLACE_MKT188_API_ORIGIN');
const callbackOrigin=required('MARKETPLACE_MKT188_CALLBACK_ORIGIN');
const callbackToken=required('MARKETPLACE_MKT188_CALLBACK_TOKEN');
const productIds=[{asset:'ATTO',productId:required('MARKETPLACE_MKT188_ATTO_PRODUCT')},
  {asset:'XNO',productId:required('MARKETPLACE_MKT188_XNO_PRODUCT')}];
const buyer={accountId:required('MARKETPLACE_MKT188_ATTO_ACCOUNT'),agentId:required('MARKETPLACE_MKT188_ATTO_AGENT'),
  identityId:required('MARKETPLACE_MKT188_ATTO_IDENTITY'),address:required('MARKETPLACE_MKT188_ATTO_ADDRESS'),
  token:required('MARKETPLACE_MKT188_ATTO_AGENT_TOKEN')};
const seller={accountId:required('MARKETPLACE_MKT188_SELLER_ACCOUNT'),agentId:required('MARKETPLACE_MKT188_SELLER_AGENT'),
  identityId:required('MARKETPLACE_MKT188_SELLER_IDENTITY'),address:required('MARKETPLACE_MKT188_SELLER_ADDRESS'),
  token:required('MARKETPLACE_MKT188_SELLER_AGENT_TOKEN')};
const audience='urn:marketplace:agent-api:test';
const home=await mkdtemp(join(tmpdir(),'marketplace-mkt188-real-mcp-'));
const store=await MarketplaceProfileStore.open(home);
const expiry=Date.now()+120_000;
for(const [id,owner] of [['buyer',buyer],['seller',seller]]) {
  store.createProfile({id,origin:apiOrigin,audience,accountId:owner.accountId,agentId:owner.agentId,
    identityId:owner.identityId,controllerNetwork:'ATTO',controllerAddress:owner.address,controllerIndex:0,
    authMode:'controller-session',accessToken:owner.token,accessExpiresAt:expiry,
    refreshToken:`fixture-${id}`,refreshExpiresAt:expiry+120_000});
}
const connections=[];
try {
  // Given actual public release JSON and two fresh controller sessions.
  const buyerClient=await connect('buyer');connections.push(buyerClient);
  const sellerClient=await connect('seller');connections.push(sellerClient);
  const settled=[];
  for(const item of productIds) {
    const response=await fetch(`${apiOrigin}/v1/products/${item.productId}`,{signal:AbortSignal.timeout(10_000)});
    assert.equal(response.status,200);
    const offer=await response.json();
    assert.equal(offer.asset,item.asset);
    const purchaseArgs={productId:item.productId,releaseId:offer.releaseId,expectedReleaseHash:offer.releaseHash,
      asset:offer.asset,grossAtomic:offer.priceAtomic,requestId:randomUUID()};

    // When named clients consume the real challenge DTOs, two exact Commons approvals settle
    // each asset's purchase and full seller refund without switching proof authority.
    const purchased=await approvedMutation(buyerClient,'marketplace_product_purchase',purchaseArgs,'buyer',buyer.address,
      'productPurchase','product purchase');
    assert.equal(purchased.status,'ACTIVE');
    assert.equal(purchased.asset,item.asset);
    assert.equal(purchased.releaseId,offer.releaseId);
    assert.equal(purchased.grossAtomic,offer.priceAtomic);
    const purchaseId=purchased.purchaseId;
    const content=await buyerClient.callTool({name:'marketplace_purchase_content_get',arguments:{purchaseId}});
    assert.equal(content.isError,undefined,text(content));
    assert.equal(JSON.parse(text(content)).result.paidMarkdown,`Private ${item.asset} body`);
    const receipt=await buyerClient.callTool({name:'marketplace_purchase_receipt_get',arguments:{purchaseId,kind:'PURCHASE'}});
    assert.equal(receipt.isError,undefined,text(receipt));
    assert.equal(JSON.parse(text(receipt)).result.receipt.contentSha256,purchased.receiptHash);

    const original=await sellerClient.callTool({name:'marketplace_purchase_get',arguments:{purchaseId}});
    assert.equal(original.isError,undefined,text(original));
    const order=JSON.parse(text(original)).result;
    const refundArgs={purchaseId,expectedPurchaseVersion:order.version,
      originalPurchaseReceiptHash:order.receiptHash,asset:order.asset,grossAtomic:order.grossAtomic,
      requestId:randomUUID()};
    const refunded=await approvedMutation(sellerClient,'marketplace_product_refund',refundArgs,'seller',seller.address,
      'productRefund','product refund');
    assert.equal(refunded.status,'REFUNDED');
    assert.equal(refunded.commandId,purchased.commandId);
    assert.notEqual(refunded.refundCommandId,purchased.commandId);
    const refundReceipt=await sellerClient.callTool({name:'marketplace_purchase_receipt_get',arguments:{purchaseId,kind:'REFUND'}});
    assert.equal(refundReceipt.isError,undefined,text(refundReceipt));
    assert.equal(JSON.parse(text(refundReceipt)).result.receipt.contentSha256,refunded.refundReceiptHash);
    const revoked=await buyerClient.callTool({name:'marketplace_purchase_content_get',arguments:{purchaseId}});
    assert.equal(revoked.isError,true);
    settled.push({asset:item.asset,purchaseId,refundCommandId:refunded.refundCommandId});
  }
  process.stdout.write(`${JSON.stringify({status:'passed',source:'actual Marketplace HTTP JSON',
    mcp:'named stdio purchase/refund/content/typed receipt',assets:settled,
    controller:'ATTO typed Commons approval'})}\n`);
} finally {
  for(const client of connections.reverse()) await client.close();
  store.close();
  await rm(home,{recursive:true,force:true});
}

async function approvedMutation(client,name,args,profile,address,kind,purpose) {
  const first=await client.callTool({name,arguments:args});
  assert.equal(first.isError,undefined,text(first));
  const handoff=JSON.parse(text(first)).result;
  assert.equal(handoff.status,'approval_required');
  const requestPath=join(home,'approvals',profile,`${handoff.handoffId}.request.json`);
  const request=JSON.parse(await readFile(requestPath,'utf8'));
  assert.equal(request.action.kind,kind);
  assert.equal(request.purpose,purpose);
  assert.equal(request.audience,audience);
  assert.equal(request.action.asset,args.asset);
  assert.equal(request.action.grossAtomic,args.grossAtomic);
  assert.equal(request.action.idempotencyKey,args.requestId);
  assert.equal(request.challenge.message.includes(`Audience: ${audience}`),true);
  const signed=await fixture('/sign',{address,message:request.challenge.message});
  assert.match(signed.signature,/^[0-9a-fA-F]{128}$/);
  const responsePath=requestPath.replace(/\.request\.json$/,'.response.json');
  await writeFile(responsePath,`${JSON.stringify({version:1,type:'marketplace-controller-approval-response',
    profileId:request.profileId,handoffId:request.handoffId,requestDigest:approvalRequestDigest(request),
    challengeId:request.challenge.challengeId,message:request.challenge.message,signature:signed.signature,
    controllerAddress:address,controllerIndex:0})}\n`,{mode:0o600});
  await chmod(responsePath,0o600);
  const pending=client.callTool({name,arguments:args});
  await drainUntilSettled();
  const settled=await pending;
  assert.equal(settled.isError,undefined,text(settled));
  const result=JSON.parse(text(settled)).result;
  assert.equal(result.status,kind==='productPurchase'?'ACTIVE':'REFUNDED');
  return result;
}

async function drainUntilSettled() {
  for(let attempt=0;attempt<30;attempt++) {
    const result=await fixture('/drain',{});
    if(result.resolved>0)return;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('The real Marketplace command was not ready for fixture draining.');
}
async function fixture(path,body) {
  const response=await fetch(`${callbackOrigin}${path}`,{method:'POST',
    headers:{'Content-Type':'application/json','X-Fixture-Token':callbackToken},
    body:JSON.stringify(body),signal:AbortSignal.timeout(10_000)});
  if(!response.ok)throw new Error(`Fixture rejected ${path}: HTTP ${response.status}`);
  return response.json();
}
async function connect(profile) {
  const client=new Client({name:'marketplace-mkt188-real-client',version:'1.0.0'});
  const env=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>typeof value==='string'
    &&key!=='NODE_TEST_CONTEXT'&&!key.startsWith('NODE_TEST_')));
  await client.connect(new StdioClientTransport({command:process.execPath,
    args:[join(import.meta.dirname,'../dist/main.js'),'--profile',profile,'--home',home],env,stderr:'pipe'}));
  return client;
}
function text(result){return result.content?.filter(part=>part.type==='text').map(part=>part.text).join('\n')??'';}
