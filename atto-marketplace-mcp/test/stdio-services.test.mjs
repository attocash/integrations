import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';
import { tmpdir } from '../../test/support/temporary-directory.mjs';

const packageDir = process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR ?? join(import.meta.dirname,'..');
const {MarketplaceProfileStore} = await import(pathToFileURL(join(packageDir,'dist/profile-store.js')));
const {registerServiceTools} = await import(pathToFileURL(join(packageDir,'dist/services.js')));
const {mutationHash} = await import(pathToFileURL(join(packageDir,'dist/canonical-json.js')));
const now = new Date().toISOString();
const buyer = randomUUID(), provider = randomUUID(), outsider = randomUUID(), publicProvider = randomUUID();
const amounts = [['5000'], ['1500','3500','9000']];
const originalResponseLimit = 1024 * 1024;
const escapedText = length => 'x' + '\u0001'.repeat(length - 2) + 'x';

test('service tools normalize new text and preserve stored text on reads', async () => {
  // Given
  const id = randomUUID(), listingId = randomUUID();
  const text = 'Summary\n\t* Detail\u001c';
  const legacyName = '\ufeff';
  const listing = {id:listingId,providerId:publicProvider,title:'Review',description:'Code review',
    asset:'ATTO',briefTemplate:null,status:'OPEN',createdAt:now,providerProfile:{handle:'reviewer',displayName:legacyName}};
  const terms = {position:1,amountAtomic:'5000',deliverable:'\ufeffReview',acceptanceCriteria:'Documentation'};
  const detail = {id,listingId,listingTitle:'Review',buyerId:buyer,providerId:provider,asset:'ATTO',status:'ORDERED',
    quoteVersion:1,createdAt:now,updatedAt:now,latestMessageCursor:1,
    quote:{version:1,totalAtomic:'5000',milestones:[terms]},
    order:{id,status:'ACTIVE',quoteVersion:1,feeId:randomUUID(),feePaymentRequirementId:randomUUID(),
      feeAtomic:'5',earnedAtomic:'0',refundAtomic:'0',
      milestones:[{...terms,status:'PENDING',paymentRequirementId:null,refundPaymentRequirementId:null,submission:null}]}};
  const tools = new Map();
  registerServiceTools((name,_,shape,handler) => tools.set(name,{schema:z.strictObject(shape),handler}), {
    request:async path => ({json:path === '/v1/services' ? {items:[listing],nextCursor:null} : detail}),
  }, undefined, {accountId:provider}, () => {}, undefined);

  // When
  const quoteInput = tools.get('marketplace_service_quote_set').schema.parse({serviceRequestId:id,requestId:randomUUID(),
    expectedQuoteVersion:0,milestones:[{amountAtomic:'5000',deliverable:'\ufeff\u00a0' + text + '\u3000',
      acceptanceCriteria:' Documentation '}]});
  const get = tools.get('marketplace_service_request_get');
  const stored = await get.handler(get.schema.parse({serviceRequestId:id}));
  const search = tools.get('marketplace_services_search');
  const services = await search.handler(search.schema.parse({}));

  // Then
  assert.deepEqual(quoteInput.milestones,[{amountAtomic:'5000',deliverable:text,acceptanceCriteria:'Documentation'}]);
  assert.deepEqual(stored,detail);
  assert.deepEqual(services.items,[listing]);
});

test('service publish recovers a pending write with its original mutation hash', async t => {
  // Given
  const home = await mkdtemp(join(tmpdir(),'atto-service-text-'));
  const store = await MarketplaceProfileStore.open(home);
  t.after(async () => {
    store.close();
    await rm(home,{recursive:true,force:true});
  });
  const profile = {id:'provider',origin:'http://127.0.0.1:8080',audience:'marketplace',accountId:provider,agentId:publicProvider,
    identityId:randomUUID(),controllerNetwork:'ATTO',controllerAddress:'atto://' + 'a'.repeat(61),
    authMode:'controller-session',accessToken:'session',accessExpiresAt:Date.now()+300_000,
    refreshToken:randomUUID(),refreshExpiresAt:Date.now()+600_000};
  store.createProfile(profile);
  const target = '/v1/agent/services', operation = 'service-publish', requestId = randomUUID();
  const body = {title:'Review\u001c',description:'Code review',asset:'ATTO'};
  const requestHash = mutationHash({operation,target,payload:body,accountId:provider});
  const identity = {profileId:profile.id,requestId,operation,target,requestHash};
  store.beginMutation(identity,JSON.stringify({kind:'MARKETPLACE_MUTATION_RECOVERY'}));
  const stored = {id:randomUUID(),providerId:publicProvider,title:'Review',description:'Code review',
    asset:'ATTO',briefTemplate:null,status:'OPEN',createdAt:now};
  let publish;
  let sent = 0;
  registerServiceTools((name,_,shape,handler) => {
    if (name === 'marketplace_service_publish') publish = args => handler(z.strictObject(shape).parse(args));
  }, {request:async (path, options) => {
    assert.equal(path,target);
    assert.deepEqual(options.body,body);
    assert.equal(options.headers['Idempotency-Key'],requestId);
    sent++;
    return {json:stored};
  }}, store, profile, () => {}, undefined);

  // When
  const result = await publish({requestId,...body});
  const replay = await publish({requestId,...body});

  // Then
  assert.deepEqual(result,stored);
  assert.equal(store.getMutation(identity).state,'COMPLETE');
  assert.equal(replay.recovered,true);
  const freshBody = {...body,title:'\u200b'};
  const freshId = randomUUID();
  await assert.rejects(publish({requestId:freshId,...freshBody}), {code:'INVALID_SERVICE'});
  assert.equal(store.getMutation({...identity,requestId:freshId,
    requestHash:mutationHash({operation,target,payload:freshBody,accountId:provider})}),null);
  assert.equal(sent,1);
});

test('full service listing and conversation pages can exceed the default HTTP response limit', async t => {
  const f = await fixture(t);
  const serviceRequestId = randomUUID();
  const listings = {items:Array.from({length:100}, () => ({
    id:randomUUID(),providerId:publicProvider,title:escapedText(120),description:escapedText(4000),
    asset:'ATTO',briefTemplate:escapedText(2000),status:'OPEN',createdAt:now,
  })),nextCursor:null};
  const messages = {requestId:serviceRequestId,canMessage:true,messages:Array.from({length:100}, (_,i) => ({
    requestId:serviceRequestId,cursor:i+1,authorId:buyer,text:escapedText(2000),createdAt:now,
  }))};
  const messagePath = '/v1/agent/service-requests/' + serviceRequestId + '/messages?after=0&limit=100';
  const authorization = `Bearer ${provider}`;

  for (const [name,path,response,auth,args] of [
    ['services_search','/v1/services?limit=100',listings,undefined,{}],
    ['service_listings_list','/v1/agent/services?limit=100',listings,authorization,{}],
    ['service_messages_list',messagePath,messages,authorization,{serviceRequestId}],
  ]) {
    assert.ok(Buffer.byteLength(JSON.stringify(response)) > originalResponseLimit);
    f.queue.push({method:'GET',path,authorization:auth,response});
    const result = await f.provider.callTool({name:'marketplace_' + name,arguments:{...args,limit:100}});
    assert.equal(result.isError,undefined,result.structuredContent.error?.message);
    assert.deepEqual(result.structuredContent.result,response);
  }

  const oversize = {message:'x'.repeat(3 * originalResponseLimit)};
  f.queue.push({method:'GET',path:messagePath,authorization,response:oversize},
    {method:'GET',path:'/v1/discovery/tasks?limit=25',response:oversize});
  for (const [name,args] of [
    ['service_messages_list',{serviceRequestId,limit:100}],
    ['tasks_search',{limit:25}],
  ]) {
    const result = await f.provider.callTool({name:'marketplace_' + name,arguments:args});
    assert.equal(result.structuredContent.error?.code,'MARKETPLACE_PROTOCOL');
    assert.match(result.structuredContent.error?.message,/larger than the supported limit/);
  }
  assert.equal(f.fault,null);
  assert.equal(f.queue.length,0);
});

test('service detail and submission handle terms, stored HTTPS variants, and file manifests above the default HTTP limit', async t => {
  const f = await fixture(t);
  const serviceRequestId = randomUUID(), listingId = randomUUID();
  const path = '/v1/agent/service-requests/' + serviceRequestId;
  const authorization = `Bearer ${provider}`;
  const terms = Array.from({length:100}, (_,i) => {
    const text = i < 25 ? escapedText(2000) : 'x'.repeat(2000);
    return {position:i+1,amountAtomic:'1000',deliverable:text,acceptanceCriteria:text};
  });
  const files = Array.from({length:10}, (_,ordinal) => ({
    ordinal,fileId:randomUUID(),contentVersionId:randomUUID(),filename:'file-' + ordinal + '.txt',
    byteLength:1,mediaType:'text/plain',sha256:'a'.repeat(64),
  }));
  const fileIds = files.map(file => file.fileId);
  const origin = 'https://example.org/';
  const rawLongUrl = origin + '\u0958'.repeat(2048 - origin.length);
  const asciiLongUrl = origin + '%E0%A4%95%E0%A4%BC'.repeat(2048 - origin.length);
  const unicodeUrl = origin + 'é', asciiUrl = origin + '%C3%A9';
  const uppercaseUrl = 'HTTPS://example.org:443/Review?detail=[]';
  const raw = {text:escapedText(10_000),urls:[rawLongUrl,unicodeUrl,asciiUrl,uppercaseUrl],fileIds};
  const submission = {id:randomUUID(),...raw,urls:[asciiLongUrl,asciiUrl,asciiUrl,uppercaseUrl],files};
  const orderMilestones = terms.map(term => ({...term,status:'PENDING',paymentRequirementId:null,
    refundPaymentRequirementId:null,submission:null}));
  orderMilestones[0] = {...orderMilestones[0],status:'SUBMITTED',paymentRequirementId:randomUUID(),submission};
  const response = {
    id:serviceRequestId,listingId,listingTitle:'Proofread',buyerId:buyer,providerId:provider,asset:'ATTO',status:'ORDERED',
    quoteVersion:1,createdAt:now,updatedAt:now,latestMessageCursor:1,
    quote:{version:1,totalAtomic:'100000',milestones:terms},
    order:{id:serviceRequestId,status:'ACTIVE',quoteVersion:1,feeId:randomUUID(),feePaymentRequirementId:randomUUID(),
      feeAtomic:'100',earnedAtomic:'0',refundAtomic:'0',milestones:orderMilestones},
  };
  assert.ok(Buffer.byteLength(JSON.stringify(response)) > originalResponseLimit);

  const requestId = randomUUID();
  f.queue.push({method:'POST',path:path + '/milestones/1/submit',authorization,key:requestId,body:raw,response});
  const submit = urls => f.provider.callTool({
    name:'marketplace_service_milestone_submit',arguments:{serviceRequestId,position:1,requestId,...raw,urls},
  });
  const get = (response, status) => {
    f.queue.push({method:'GET',path,authorization,response,status});
    return f.provider.callTool({name:'marketplace_service_request_get',arguments:{serviceRequestId}});
  };
  const mutationResult = await submit(raw.urls);
  assert.equal(mutationResult.isError,undefined,mutationResult.structuredContent.error?.message);
  assert.deepEqual(mutationResult.structuredContent.result.order.milestones[0].submission,submission);

  const storedUrls = [...submission.urls, 'https://xn--x.org/:already-escaped%20'];
  submission.urls = storedUrls;
  const detailResult = await get(response);
  assert.equal(detailResult.isError,undefined,detailResult.structuredContent.error?.message);
  assert.deepEqual(detailResult.structuredContent.result.order.milestones[0].submission.urls,storedUrls);
  for (const urls of [[asciiLongUrl],['HTTP://example.org/'],[asciiUrl,asciiUrl]]) {
    assert.equal((await submit(urls)).isError,true);
  }
  for (const url of ['http://example.org/a','https://example.org/é','https://example.org/%xx','https://u@example.org/',
    'https://example.org/a#item','https://example.org:0/']) {
    // The malformed output fits under the original transport limit so the schema must reject it.
    const invalid = {...response,quote:{...response.quote,totalAtomic:'1000',milestones:terms.slice(0,1)},
      order:{...response.order,milestones:[{...orderMilestones[0],submission:{...submission,urls:[url]}}]}};
    const result = await get(invalid);
    assert.match(result.structuredContent.error?.message,/invalid service request/);
  }
  const overflow = await get({error:'x'.repeat(originalResponseLimit)},409);
  assert.match(overflow.structuredContent.error?.message,/larger than the supported limit/);
  assert.equal(f.fault,null);
  assert.equal(f.queue.length,0);
});

test('service listings preserve starting price, public profile, and completed-order count via stdio', async t => {
  const f = await fixture(t);
  const listingId = randomUUID();
  const listingPath = '/v1/services/' + listingId;
  const ownerPath = '/v1/agent/services';
  const authorization = `Bearer ${provider}`;
  const body = {title:'Proofread',description:'Proofread a draft',asset:'XNO'};
  const listing = {id:listingId,providerId:null,...body,briefTemplate:null,status:'OPEN',createdAt:now};
  const indicativePrice = {usd:{price:'2.35',timestamp:now}};
  const providerProfile = {handle:'my-studio',displayName:'My Studio'};
  const priced = {...listing,startingPriceAtomic:'1000000000000000000000000000000',indicativePrice,providerProfile,completedOrderCount:0};

  async function exchange(who, tool, args, expected) {
    f.queue.push(expected);
    const result = await f[who].callTool({name:'marketplace_' + tool,arguments:args});
    assert.equal(f.fault,null);
    assert.equal(f.queue.length,0,JSON.stringify(result));
    return result.structuredContent;
  }
  const publish = args => f.provider.callTool({name:'marketplace_service_publish',arguments:args});
  async function publishListing(expectedBody, response, requestId = randomUUID()) {
    return exchange('provider','service_publish',{requestId,...expectedBody},
      {method:'POST',path:ownerPath,authorization,key:requestId,body:expectedBody,response});
  }

  const unpricedKey = randomUUID();
  assert.deepEqual((await publishListing(body,listing,unpricedKey)).result,listing);
  assert.equal((await publish({requestId:unpricedKey,...body})).structuredContent.result.recovered,true);
  assert.equal((await publish({requestId:unpricedKey,...body,startingPriceAtomic:'1'})).structuredContent.error.code,'IDEMPOTENCY_CONFLICT');

  for (const invalid of [null,0,1,'0','01','-1','1.2','1e3','1 ','9'.repeat(66)]) {
    const result = await publish({requestId:randomUUID(),...body,startingPriceAtomic:invalid});
    assert.equal(result.isError,true,JSON.stringify(invalid));
    assert.equal(f.fault,null);
  }
  const pricedBody = {...body,startingPriceAtomic:priced.startingPriceAtomic};
  assert.deepEqual((await publishListing(pricedBody,priced)).result,priced);
  assert.equal((await publishListing(pricedBody,listing)).error.code,'SERVICE_BINDING');
  assert.equal((await publishListing(pricedBody,{...priced,startingPriceAtomic:'1'})).error.code,'SERVICE_BINDING');
  assert.equal((await publishListing(body,priced)).error.code,'SERVICE_BINDING');

  const nullFields = {...listing,id:randomUUID(),startingPriceAtomic:null,indicativePrice:null,providerProfile:null,completedOrderCount:3};
  const oldListing = {...listing,id:randomUUID()};
  const page = {items:[priced,nullFields,oldListing],nextCursor:null};
  assert.deepEqual((await exchange('buyer','services_search',{},
    {method:'GET',path:'/v1/services?limit=25',response:page})).result,page);
  const ownerListing = {...priced,providerId:publicProvider};
  assert.deepEqual((await exchange('provider','service_listings_list',{},
    {method:'GET',path:ownerPath + '?limit=25',authorization,response:{items:[ownerListing],nextCursor:null}})).result.items,[ownerListing]);

  const get = response => exchange('buyer','service_get',{listingId},{method:'GET',path:listingPath,response});
  assert.deepEqual((await get(priced)).result,priced);
  for (const bad of [
    {startingPriceAtomic:'0'},
    {indicativePrice:{usd:{...indicativePrice.usd,price:'2e-2'}}},
    {indicativePrice:{usd:{...indicativePrice.usd,timestamp:'2026-11-25'}}},
    {providerProfile:{...providerProfile,accountId:provider}},
    {providerProfile:{...providerProfile,handle:'My-Studio'}},
    {completedOrderCount:-1},
    {completedOrderCount:0.5},
  ]) assert.equal((await get({...priced,...bad})).error.code,'MARKETPLACE_PROTOCOL');

  const closeKey = randomUUID();
  const closed = {...ownerListing,status:'CLOSED',completedOrderCount:3};
  assert.deepEqual((await exchange('provider','service_close',{listingId,requestId:closeKey},
    {method:'POST',path:ownerPath + '/' + listingId + '/close',authorization,key:closeKey,body:{},response:closed})).result,closed);
});

for (const prices of amounts) test(`private service with ${prices.length} prepaid milestone(s) via named stdio tools`, async t => {
  const f = await fixture(t);
  const listingId = randomUUID(), serviceRequestId = randomUUID();
  const service = {id:listingId,providerId:null,title:'Proofread',description:'Proofread a draft',asset:'ATTO',briefTemplate:'Word count?',status:'OPEN',createdAt:now};
  const summary = {id:serviceRequestId,listingId,listingTitle:service.title,buyerId:buyer,providerId:provider,asset:'ATTO',status:'OPEN',quoteVersion:0,createdAt:now,updatedAt:now,latestMessageCursor:1};
  const request = {...summary,quote:null,order:null};
  const target = '/v1/agent/service-requests/' + serviceRequestId;
  const ref = {serviceRequestId};
  const auth = {buyer:`Bearer ${buyer}`,provider:`Bearer ${provider}`,outsider:`Bearer ${outsider}`,reader:'Bearer reader-key'};
  const tools = await f.buyer.listTools();
  assert.equal(tools.tools.find(x => x.name === 'marketplace_service_quote_accept').inputSchema.additionalProperties,false);

  async function exchange(who, tool, args, path, response, options={}) {
    const expected = {method:options.body === undefined ? 'GET' : 'POST',path,authorization:options.public ? undefined : auth[who],
      key:args.requestId, body:options.body, status:options.status ?? 200, response};
    f.queue.push(expected);
    const result = await f[who].callTool({name:'marketplace_' + tool,arguments:args});
    assert.equal(f.fault,null);
    assert.equal(f.queue.length,0,`missing HTTP for ${tool}: ${JSON.stringify(result)}`);
    if (options.error) { assert.equal(result.isError,true); return result; }
    assert.equal(result.isError,undefined,JSON.stringify(result));
    return result.structuredContent.result;
  }
  async function mutate(who, tool, args, path, body, response) {
    return exchange(who,tool,{...args,requestId:randomUUID()},path,response,{body});
  }
  // Public discovery carries no private authorization, including from a configured buyer.
  const listingBody = {title:service.title,description:service.description,asset:service.asset,briefTemplate:service.briefTemplate};
  await mutate('provider','service_publish',listingBody,'/v1/agent/services',listingBody,service);
  await exchange('buyer','services_search',{},'/v1/services?limit=25',{items:[service],nextCursor:null},{public:true});
  await exchange('buyer','services_search',{q:'  Proofread a draft  '},'/v1/services?limit=25&q=Proofread+a+draft',{items:[service],nextCursor:null},{public:true});
  await exchange('buyer','service_get',{listingId},'/v1/services/' + listingId,service,{public:true});
  await exchange('provider','service_listings_list',{},'/v1/agent/services?limit=25',{items:[{...service,providerId:publicProvider}],nextCursor:null});
  const brief = 'Proofread six paragraphs.';
  await mutate('buyer','service_request_create',{listingId,brief},'/v1/agent/services/' + listingId + '/requests',{brief},request);
  const inbox = await exchange('provider','service_requests_list',{role:'provider'},'/v1/agent/service-requests?limit=25&role=provider',{items:[summary],nextCursor:null});
  assert.equal(inbox.items[0].latestMessageCursor,1);
  const message = {requestId:serviceRequestId,cursor:1,authorId:buyer,text:brief,createdAt:now};
  await exchange('provider','service_messages_list',ref,target + '/messages?after=0&limit=50',{requestId:serviceRequestId,canMessage:true,messages:[message]});

  // A server that discloses someone else's request or adds private data to a listing fails closed in the client.
  assert.equal((await exchange('outsider','service_request_get',ref,target,request,{error:true})).structuredContent.error.code,'SERVICE_BINDING');
  assert.equal((await exchange('buyer','service_get',{listingId},'/v1/services/' + listingId,{...service,brief},{public:true,error:true})).structuredContent.error.code,'MARKETPLACE_PROTOCOL');
  const denied = await f.reader.callTool({name:'marketplace_service_quote_accept',arguments:{...ref,quoteVersion:1,requestId:randomUUID()}});
  assert.equal(denied.structuredContent.error.code,'SETUP_REQUIRED');
  const noWrite = await f.reader.callTool({name:'marketplace_service_message_add',arguments:{...ref,text:'Hi',requestId:randomUUID()}});
  assert.equal(noWrite.structuredContent.error.code,'SCOPE_REQUIRED');

  const milestones = prices.map((amountAtomic,i)=>({amountAtomic,deliverable:'Section ' + (i+1),acceptanceCriteria:'Reviewed and cited'}));
  const quoted = milestones.map((m,i)=>({...m,position:i+1}));
  const totalAtomic = prices.reduce((s,n)=>s+BigInt(n),0n).toString();
  for (let expectedQuoteVersion=0; expectedQuoteVersion<2; expectedQuoteVersion++) {
    request.quoteVersion++;
    request.quote = {version:request.quoteVersion,totalAtomic,milestones:quoted};
    const body = {expectedQuoteVersion,milestones};
    await mutate('provider','service_quote_set',{...ref,...body},target + '/quotes',body,request);
  }
  const stale = await exchange('buyer','service_quote_accept',{...ref,quoteVersion:1,requestId:randomUUID()},target + '/accept',
    {error:'service_conflict'},{body:{quoteVersion:1},status:409,error:true});
  assert.equal(stale.structuredContent.error.httpStatus,409);

  request.status = 'ORDERED';
  const feePaymentRequirementId = randomUUID();
  request.order = {id:serviceRequestId,status:'AWAITING_FEE',quoteVersion:2,feeId:randomUUID(),feePaymentRequirementId,
    feeAtomic:(BigInt(totalAtomic)/1000n).toString(),earnedAtomic:'0',refundAtomic:'0',milestones:quoted.map(m=>({...m,
      status:'PENDING',paymentRequirementId:null,refundPaymentRequirementId:null,submission:null}))};
  const accepted = await mutate('buyer','service_quote_accept',{...ref,quoteVersion:2},target + '/accept',{quoteVersion:2},request);
  assert.equal(accepted.order.feeAtomic,request.order.feeAtomic);

  async function verifyPaid(who,paymentId,purpose,sourceReference,amountAtomic,destination) {
    const source = who === 'buyer' ? buyer : provider;
    const terms = {id:paymentId,purpose,sourceReference,ownerAccountId:source,asset:'ATTO',network:'atto:local',
      senderAddress:'sender-' + source,recipientAddress:destination,amountAtomic,termsHash:'a'.repeat(64),versionHash:'b'.repeat(64),
      baselineHeight:1,baselineFrontier:'c'.repeat(64),status:'PENDING',verifiedPayment:null,submissions:[],relay:null};
    const path = '/v1/agent/payments/' + paymentId;
    const pending = await exchange(who,'payment_get',{paymentId},path,terms);
    assert.equal(pending.status,'PENDING');
    const settled = {...terms,status:'VERIFIED',verifiedPayment:{network:terms.network,transactionHash:'d'.repeat(64),senderAddress:terms.senderAddress,
      recipientAddress:destination,amountAtomic,senderHeight:2,previousHash:terms.baselineFrontier}};
    const result = await exchange(who,'payment_get',{paymentId},path,settled);
    assert.equal(result.verifiedPayment.amountAtomic,amountAtomic);
    assert.equal(result.verifiedPayment.recipientAddress,destination);
  }
  await verifyPaid('provider',accepted.order.feePaymentRequirementId,'PUBLICATION_FEE',accepted.order.feeId,accepted.order.feeAtomic,'treasury');
  request.order.status = 'ACTIVE';
  const bytes = Buffer.from('Delivered edit'), fileId = randomUUID();
  const file = {ordinal:0,fileId,contentVersionId:randomUUID(),filename:'proof.txt',byteLength:bytes.length,
    mediaType:'text/plain',sha256:createHash('sha256').update(bytes).digest('hex')};
  for (const m of request.order.milestones) {
    const milestone = {...ref,position:m.position}, path = target + '/milestones/' + m.position;
    m.status = 'AWAITING_PAYMENT';
    m.paymentRequirementId = randomUUID();
    const args = {...milestone,requestId:randomUUID()};
    const funded = await exchange('buyer','service_milestone_fund',args,path + '/fund',request,{body:{}});
    assert.equal(funded.order.milestones[m.position-1].paymentRequirementId,m.paymentRequirementId);
    const repeated = await f.buyer.callTool({name:'marketplace_service_milestone_fund',arguments:args});
    assert.equal(repeated.structuredContent.result.recovered,true);
    const wrong = await f.buyer.callTool({name:'marketplace_service_milestone_fund',arguments:{...args,position:m.position+1}});
    assert.equal(wrong.structuredContent.error.code,'IDEMPOTENCY_CONFLICT');
    await verifyPaid('buyer',m.paymentRequirementId,'SERVICE_MILESTONE',serviceRequestId + ':' + m.position,m.amountAtomic,'provider-wallet');
    m.status = 'FUNDED';
    await exchange('provider','service_request_get',ref,target,request);
    const empty = await f.buyer.callTool({name:'marketplace_service_milestone_submit',arguments:{...milestone,requestId:randomUUID(),text:'   '}});
    assert.equal(empty.structuredContent.error.code,'INVALID_SUBMISSION');
    // A link-only first delivery and file-only revision are both complete service submissions.
    const body = {text:'',urls:['https://example.org/draft'],fileIds:[]};
    m.submission = {id:randomUUID(),...body,files:[]};
    m.status = 'SUBMITTED';
    await mutate('provider','service_milestone_submit',{...milestone,...body},path + '/submit',body,request);
    const revision = 'Please fix the citation.';
    await mutate('buyer','service_message_add',{...ref,text:revision},target + '/messages',{text:revision},
      {...message,cursor:m.position+1,text:revision});
    request.updatedAt = new Date(Date.parse(now)+m.position*1000).toISOString();
    request.latestMessageCursor = m.position+1;
    const detail = await exchange('provider','service_request_get',ref,target,request);
    assert.equal(detail.updatedAt,request.updatedAt);
    assert.equal(detail.latestMessageCursor,m.position+1);
    const oldSubmission = m.submission.id;
    const replacement = {text:'',urls:[],fileIds:[fileId]};
    m.submission = {id:randomUUID(),...replacement,files:[file]};
    await mutate('provider','service_milestone_submit',{...milestone,fileIds:[fileId]},path + '/submit',replacement,request);
    const staleApproval = await exchange('buyer','service_milestone_approve',{...milestone,submissionId:oldSubmission,requestId:randomUUID()},path + '/approve',
      {error:'service_conflict'},{body:{submissionId:oldSubmission},status:409,error:true});
    assert.equal(staleApproval.structuredContent.error.httpStatus,409);
    f.queue.push({method:'GET',path:target,authorization:auth.buyer,response:request});
    const staleDownload = await f.buyer.callTool({name:'marketplace_service_submission_file_download',arguments:{...milestone,
      submissionId:oldSubmission,fileId,destinationPath:'stale-delivery.txt'}});
    assert.equal(staleDownload.structuredContent.error.code,'SERVICE_BINDING');
    f.queue.push({method:'GET',path:target,authorization:auth.buyer,response:request},
      {method:'GET',path:'/v1/agent/files/' + fileId + '/content',authorization:auth.buyer,response:bytes});
    const saved = await f.buyer.callTool({name:'marketplace_service_submission_file_download',arguments:{...milestone,
      submissionId:m.submission.id,fileId,destinationPath:'delivery-' + m.position + '.txt'}});
    assert.equal(saved.isError,undefined,JSON.stringify(saved));
    assert.deepEqual(await readFile(saved.structuredContent.result.savedAs),bytes);
    if (prices.length > 1 && m.position === prices.length) {
      request.order.status = 'STOPPING';
      await mutate('buyer','service_request_stop',ref,target + '/stop',{},request);
      m.refundPaymentRequirementId = randomUUID();
      const refund = await mutate('provider','service_milestone_refund',milestone,path + '/refund',{},request);
      assert.equal(refund.order.milestones.at(-1).status,'SUBMITTED');
      await verifyPaid('provider',refund.order.milestones.at(-1).refundPaymentRequirementId,'BUYER_REFUND',
        'service-refund:' + serviceRequestId + ':' + m.position,m.amountAtomic,'buyer-wallet');
      m.status = 'REFUNDED';
    } else {
      m.status = 'COMPLETED';
      await mutate('buyer','service_milestone_approve',{...milestone,submissionId:m.submission.id},path + '/approve',{submissionId:m.submission.id},request);
    }
  }
  request.order.status = 'CLOSED'; request.status = 'CLOSED';
  await exchange('buyer','service_request_get',ref,target,request);
  await mutate('provider','service_close',{listingId},'/v1/agent/services/' + listingId + '/close',{}, {...service,status:'CLOSED'});
  assert.equal(f.fault,null);
});

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(),'quoted-services-'));
  const files = join(home,'files');
  await mkdir(files,{mode:0o700});
  const f = {queue:[],fault:null};
  const http = createServer(async (req,res) => {
    try {
      const expected = f.queue.shift();
      assert.ok(expected,`unexpected ${req.method} ${req.url}`);
      assert.equal(req.method,expected.method);
      assert.equal(req.url,expected.path);
      assert.equal(req.headers.authorization,expected.authorization);
      assert.equal(req.headers['idempotency-key'],expected.key);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      assert.deepEqual(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined,expected.body);
      const bytes = Buffer.isBuffer(expected.response);
      res.writeHead(expected.status ?? 200,{'content-type':bytes?'application/octet-stream':'application/json'});
      res.end(bytes ? expected.response : JSON.stringify(expected.response));
    } catch(error) {
      f.fault = error;
      res.writeHead(500);res.end('{}');
    }
  });
  http.listen(0,'127.0.0.1');
  await once(http,'listening');
  const origin = 'http://127.0.0.1:' + http.address().port;
  const store = await MarketplaceProfileStore.open(home), clients=[];
  t.after(async () => {
    for (const c of clients) await c.close();
    await new Promise(resolve => http.close(resolve));
    store.close();
    await rm(home,{recursive:true,force:true});
  });
  for (const [name,accountId] of Object.entries({provider,buyer,outsider,reader:buyer})) {
    const actor = name === 'reader' ? {authMode:'scoped-api-key',apiKey:'reader-key',apiScopes:['services:read']} :
      {authMode:'controller-session',accessToken:accountId,accessExpiresAt:Date.now()+300_000,refreshToken:randomUUID(),refreshExpiresAt:Date.now()+600_000};
    store.createProfile({id:name,origin,audience:'marketplace',accountId,agentId:name === 'provider' ? publicProvider : randomUUID(),
      identityId:randomUUID(),controllerNetwork:'ATTO',controllerAddress:'atto://' + 'a'.repeat(61),...actor});
    const client = new Client({name:'service-contract-test',version:'1'});
    const env = Object.fromEntries(Object.entries(process.env).filter(([key,value])=>typeof value==='string' && !key.startsWith('NODE_TEST_')));
    await client.connect(new StdioClientTransport({command:process.execPath,args:[join(packageDir,'dist/main.js'),'--profile',name,
      '--home',home,'--files-dir',files],env,stderr:'pipe'}));
    clients.push(client); f[name] = client;
  }
  return f;
}
