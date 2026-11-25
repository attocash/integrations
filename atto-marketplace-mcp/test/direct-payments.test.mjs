import {fileURLToPath,pathToFileURL} from 'node:url';
const packageDirectory=process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR??fileURLToPath(new URL('../',import.meta.url));
import {join} from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
const {payRequirement,paymentRequirement,relayTerms,reauthorizeRelay}=await import(pathToFileURL(join(packageDirectory,'dist/direct-payments.js')).href);
const {offer,legacyOffer}=await import('../../test/support/relay.mjs');
const {parseRelayOffer,relayPaymentPayload,decodePaymentHeader}=await import('@attocash/cli/internal-marketplace');
const id='11111111-1111-4111-8111-111111111111',account='22222222-2222-4222-8222-222222222222';
const profile={accountId:account,audience:'audience',origin:'https://marketplace.example'};
function fixture(asset){return {id,purpose:'SHOP_ORDER',sourceReference:'order',ownerAccountId:account,asset,network:asset==='ATTO'?'atto:local':'nano:dev',senderAddress:'sender',recipientAddress:'seller',amountAtomic:'100000000000000000000000000001',termsHash:'a'.repeat(64),versionHash:'b'.repeat(64),baselineHeight:7,baselineFrontier:'c'.repeat(64),status:'PENDING',verifiedPayment:null,submissions:[],relay:null};}
for(const purpose of ['SHOP_ORDER','SERVICE_MILESTONE'])for(const asset of ['ATTO','XNO'])for(const outcome of ['pending','confirmed'])test(`${asset} ${purpose} lost relay responses replay the same durable native payload through ${outcome} without client publication`,async t=>{
  // Given immutable instructions and one wallet-owned candidate/header journal.
  const p={...fixture(asset),purpose};p.amountAtomic=asset==='ATTO'?'9007199254740993':'100000000000000000000000000001';
  const requests=[],operations=[],headers=[];let saved,lost=true;
  const native={async callWallet(_env,request){operations.push(request.operation);
    if(request.operation==='identity.list')return {address:'sender',network:p.network,index:0};
    if(request.operation==='payment.status')return saved??{requestId:id,state:'NOT_FOUND'};
    assert.equal(request.operation,'payment.prepare');
    const offered=parseRelayOffer(request.input);
    saved={...request.input,network:p.network,sourceAddress:'sender',destination:'seller',amountAtomic:p.amountAtomic,
      state:'signed',hash:'d'.repeat(64),paymentSignature:relayPaymentPayload(offered,id,{[asset==='ATTO'?'transaction':'block']:{retained:true}})};
    return saved;
  }};
  const api={async request(path,options){requests.push({path,options});
    assert.equal(path,`/v1/agent/payments/${id}`);
    if(options?.method==='POST'&&!options.headers['PAYMENT-SIGNATURE'])return {status:402,headers:new Headers({'PAYMENT-REQUIRED':offer(relayTerms(p))}),json:{}};
    if(options?.headers?.['PAYMENT-SIGNATURE']){
      assert.equal(options.body,undefined);assert.equal(options.headers['Idempotency-Key'],id);headers.push(options.headers['PAYMENT-SIGNATURE']);
      if(lost){lost=false;throw Error('response lost');}
      if(outcome==='confirmed') {
        const settlement={success:true,payer:p.senderAddress,transaction:'d'.repeat(64),network:p.network};
        return {status:200,headers:new Headers({'PAYMENT-RESPONSE':Buffer.from(JSON.stringify(settlement)).toString('base64')}),json:{...p,status:'VERIFIED',verifiedPayment:{network:p.network,transactionHash:'d'.repeat(64),senderAddress:p.senderAddress,recipientAddress:p.recipientAddress,amountAtomic:p.amountAtomic,senderHeight:8,previousHash:'c'.repeat(64)}}};
      }
      return {status:202,headers:new Headers({Location:`/v1/agent/payments/${id}`}),json:{success:false,errorReason:'settlement_pending',payer:'sender',transaction:'d'.repeat(64),network:p.network,extensions:{'marketplace-relay':{info:{attempted:true,recovery:`/v1/agent/payments/${id}`}}}}};
    }
    return {status:200,headers:new Headers(),json:p};
  }};
  const input={api,profile,env:{},paymentId:id};
  // When the admitted relay loses its response and recovery runs after the offer expires.
  await assert.rejects(payRequirement(input,native),/response lost/);
  const recoveryTime = Date.now() + 600_000;
  t.mock.method(Date, 'now', () => recoveryTime);
  const result = await payRequirement(input,native);
  // Then the wallet never broadcasts, and Market receives identical signed bytes without another reservation or signature.
  if(outcome==='pending')assert.equal(result.settlement.errorReason,'settlement_pending');else assert.equal(result.status,'VERIFIED');
  assert.equal(headers[0],headers[1]);
  const {extensions}=decodePaymentHeader(headers[0]);
  assert.deepEqual(Object.keys(extensions),['payment-identifier']);
  assert.deepEqual(extensions['payment-identifier'].info,{required:true,id});
  assert.equal(requests.filter(({path}) => path.endsWith('/challenge')).length, 0);
  assert.equal(requests.filter(({path,options}) => path === `/v1/agent/payments/${id}`
    && options?.method === 'POST' && !options.headers['PAYMENT-SIGNATURE']).length, 1);
  assert.equal(operations.filter(op=>op==='payment.prepare').length,1);assert.equal(operations.filter(op=>op==='payment.authorize').length,0);
  assert.equal(operations.includes('transfer.send'),false);assert.equal(requests.filter(r=>r.path.endsWith('/evidence')).length,0);
});
for(const kind of ['admitted','attempted','manual'])test(`an existing ${kind} payment is recovered without another wallet candidate`,async()=>{
  // Given no local record while the canonical endpoint owns an original pending operation.
  const p=fixture('XNO'),operations=[],path=`/v1/agent/payments/${id}`;
  const staged={...p,relay:kind==='manual'?null:{requestId:id,transactionHash:'d'.repeat(64),attempted:kind==='attempted',status:'PENDING',reason:null},
    submissions:kind==='manual'?[{requestId:id,transactionHash:'d'.repeat(64),status:'PENDING',reason:null}]:[]};
  const api={async request(_path,options){if(!options)return {status:200,json:p,headers:new Headers()};
    return {status:202,headers:new Headers({Location:path}),json:kind==='attempted'
      ?{success:false,errorReason:'settlement_pending',payer:p.senderAddress,transaction:'d'.repeat(64),network:p.network,extensions:{'marketplace-relay':{info:{attempted:true,recovery:path}}}}
      :staged};}};
  const native={async callWallet(_env,request){operations.push(request.operation);return request.operation==='identity.list'?{address:p.senderAddress,network:p.network,index:0}:{requestId:id,state:'NOT_FOUND'};}};
  // When payment negotiation discovers the original pending manual claim or admitted relay.
  const result=await payRequirement({api,profile,env:{},paymentId:id},native);
  // Then recovery retains the canonical pending operation and no signing authority is exercised.
  assert.deepEqual(operations,['identity.list','payment.status']);assert.equal(result.recovery,path);
});
test('an unused wallet reservation negotiates before signing under the original requirement',async()=>{
  // Given a crash left no native candidate or signed header in the wallet's original reservation.
  const p={...fixture('XNO'),nativeRelaySupported:true};
  const terms=relayTerms(p),fresh=offer(terms),operations=[];
  const saved={requestId:id,origin:profile.origin,audience:profile.audience,terms,network:p.network,sourceAddress:p.senderAddress,destination:p.recipientAddress,amountAtomic:p.amountAtomic,state:'PREPARING',hash:null,paymentRequired:legacyOffer(terms),paymentSignature:null};
  const native={async callWallet(_env,request){operations.push(request.operation);if(request.operation==='identity.list')return {address:p.senderAddress,network:p.network,index:0};
    if(request.operation==='payment.status')return saved;
    assert.equal(request.operation,'payment.prepare');assert.equal(request.input.requestId,id);assert.equal(request.input.paymentRequired,fresh);
    throw Error('fresh prepare boundary');}};
  const api={async request(_path,options){if(!options)return {json:p};return {status:402,headers:new Headers({'PAYMENT-REQUIRED':fresh})};}};
  // When original request recovery asks the backend for a new unused window.
  // Then only the original request is prepared, and no generic send or previous signed payload is replaced.
  await assert.rejects(payRequirement({api,profile,env:{},paymentId:id},native),/fresh prepare boundary/);
  assert.deepEqual(operations,['identity.list','payment.status','payment.prepare']);
});

test('recovery rejects changed immutable terms before reusing a native candidate',async()=>{
  const p=fixture('XNO'),terms=relayTerms(p),operations=[];
  const saved={requestId:id,origin:profile.origin,audience:profile.audience,terms:{...terms,versionHash:'e'.repeat(64)},
    state:'SIGNED',hash:'d'.repeat(64),paymentRequired:offer(terms),paymentSignature:'saved'};
  const native={async callWallet(_env,request){
    operations.push(request.operation);
    return request.operation==='identity.list'?{address:p.senderAddress,network:p.network,index:0}:saved;
  }};
  const api={async request(_path,options){assert.equal(options,undefined);return {json:p};}};
  await assert.rejects(payRequirement({api,profile,env:{},paymentId:id},native),/original payment terms/);
  assert.deepEqual(operations,['identity.list','payment.status']);
});

test('a retained legacy candidate missing its envelope is completed using its original offer and hash',async()=>{
  const p={...fixture('XNO'),nativeRelaySupported:true},terms=relayTerms(p),paymentRequired=legacyOffer(terms),operations=[];
  const request={requestId:id,origin:profile.origin,audience:profile.audience,terms,paymentRequired};
  const retained={...request,network:p.network,sourceAddress:p.senderAddress,destination:p.recipientAddress,amountAtomic:p.amountAtomic,
    state:'SIGNED',hash:'d'.repeat(64),paymentSignature:null};
  const native={async callWallet(_env,call){
    operations.push(call.operation);
    if(call.operation==='identity.list')return {address:p.senderAddress,network:p.network,index:0};
    if(call.operation==='payment.status')return retained;
    assert.deepEqual(call.input,request);
    return {...retained,paymentSignature:relayPaymentPayload(parseRelayOffer(request,true),id,{block:{retained:true}})};
  }};
  const api={async request(path,options){
    if(!options)return {json:p};
    assert.equal(options.headers['Idempotency-Key'],id);
    assert.deepEqual(Object.keys(decodePaymentHeader(options.headers['PAYMENT-SIGNATURE']).extensions),['payment-identifier']);
    return {status:202,headers:new Headers({Location:path}),json:{...p,
      relay:{requestId:id,transactionHash:retained.hash,attempted:false,status:'READY',reason:null}}};
  }};
  assert.equal((await payRequirement({api,profile,env:{},paymentId:id},native)).requirement.relay.transactionHash,retained.hash);
  assert.deepEqual(operations,['identity.list','payment.status','payment.prepare']);
});

function durableFixture(asset, purpose='SHOP_ORDER') {
  const path = `/v1/agent/payments/${id}`, transactionHash = 'd'.repeat(64);
  const p = {...fixture(asset), purpose, nativeRelaySupported:true, status:'AWAITING_PAYMENT',
    amountAtomic:asset === 'ATTO' ? '9007199254740993' : '100000000000000000000000000001'};
  const payload = {[asset === 'ATTO' ? 'transaction' : 'block']:{work:'retained-work',signature:'retained-signature',amount:p.amountAtomic}};
  const pending = {...p, status:'PENDING', relay:{mode:'DURABLE_NATIVE', requestId:id, transactionHash,
    status:'PENDING', attempted:true, reason:'native_rate_limited', nextCheckAt:'2026-11-24T10:15:30.123456Z'}};
  const verified = {...pending, status:'VERIFIED', relay:{...pending.relay, status:'VERIFIED', reason:null, nextCheckAt:null},
    verifiedPayment:{network:p.network, transactionHash, senderAddress:p.senderAddress, recipientAddress:p.recipientAddress,
      amountAtomic:p.amountAtomic, senderHeight:8, previousHash:p.baselineFrontier}};
  const preparations = [];
  const checks = [];
  let savedJson;
  const wallet = () => ({async callWallet(_env, request) {
    if (request.operation === 'identity.list') return {address:p.senderAddress, network:p.network, index:0};
    if (request.operation === 'payment.status') return savedJson ? JSON.parse(savedJson) : {requestId:id,state:'NOT_FOUND'};
    if (request.operation === 'payment.relay.check') {
      assert.deepEqual(request.input,{requestId:id,transactionHash:transactionHash.toUpperCase()});
      checks.push(request);
      return JSON.parse(savedJson);
    }
    assert.equal(request.operation,'payment.prepare');
    assert.deepEqual(request.input,{requestId:id, origin:profile.origin, audience:profile.audience, terms:relayTerms(p), mode:'DURABLE_NATIVE'});
    preparations.push(request);
    const signed = {...request.input, network:p.network, sourceAddress:p.senderAddress, destination:p.recipientAddress,
      amountAtomic:p.amountAtomic, hash:transactionHash.toUpperCase(), state:'PREPARED', payload};
    savedJson = JSON.stringify(signed);
    return signed;
  }});
  const response = (json, status = 200, headers = {}) => ({status, json, headers:new Headers(headers)});
  const recoveredBody = {requestId:id, transactionHash, termsHash:p.termsHash, versionHash:p.versionHash, payload};
  return {p, path, pending, verified, preparations, checks, wallet, response, recoveredBody, paymentInput:{profile, env:{}, paymentId:id}};
}

for (const purpose of ['SHOP_ORDER','SERVICE_MILESTONE']) for (const asset of ['ATTO','XNO']) test(`${asset} ${purpose} durable relay replays stable wire bytes and reports queued progress and independent settlement`,async()=>{
  const f = durableFixture(asset,purpose);
  const posts = [];
  let current = f.p;
  const api = {async request(path, options) {
    if (!options) {
      assert.equal(path,f.path);
      return f.response(current);
    }
    assert.equal(path,`${f.path}/relay`);
    assert.equal(options.method,'POST');
    assert.deepEqual(options.allowStatus,[200,202]);
    assert.equal(options.headers,undefined);
    assert.deepEqual(options.body,f.recoveredBody);
    posts.push(JSON.stringify(options.body));
    if (posts.length === 1) throw Error('response lost before admission');
    current = f.pending;
    return f.response(current,202,{Location:f.path});
  }};
  const input = {...f.paymentInput, api};
  await assert.rejects(payRequirement(input,f.wallet()),/response lost/);
  const queued = await payRequirement(input,f.wallet());
  assert.deepEqual(queued,f.pending);
  assert.equal(posts[0],posts[1]);
  assert.deepEqual(await payRequirement(input,f.wallet()),f.pending);
  current = f.verified;
  assert.deepEqual(await payRequirement(input,f.wallet()),f.verified);
  assert.equal(posts.length,2);
  assert.equal(f.preparations.length,1);
  assert.equal(f.checks.length,1);
});

test('a successful durable POST requires a verified response bound to the retained candidate',async()=>{
  const f = durableFixture('ATTO');
  for (const change of [
    reply => {reply.status = 202;},
    reply => {reply.json.verifiedPayment.transactionHash = 'e'.repeat(64);},
    reply => {reply.json.relay.requestId = account;},
    reply => {reply.json.termsHash = 'e'.repeat(64);},
    reply => {reply.json.verifiedPayment.senderAddress = 'other-sender';},
    reply => {reply.headers.set('Location','https://other.example' + f.path);},
    reply => {reply.headers.set('PAYMENT-RESPONSE','unexpected');},
  ]) {
    const api = {async request(_path, options) {
      if (!options) return f.response(f.p);
      const reply = f.response(structuredClone(f.verified));
      change(reply);
      return reply;
    }};
    await assert.rejects(payRequirement({...f.paymentInput,api},f.wallet()), {code:'PAYMENT_PROTOCOL'});
  }
  const api = {async request(_path, options) {return f.response(options ? f.verified : f.p);}};
  assert.deepEqual(await payRequirement({...f.paymentInput,api},f.wallet()),f.verified);
  assert.equal(f.preparations.length,1);
});

test('durable recovery returns the terminal relay and preserves admissions from other clients',async()=>{
  const f = durableFixture('XNO');
  const terminal = {...f.pending, status:'AWAITING_PAYMENT', relay:{...f.pending.relay, status:'REJECTED',
    reason:'confirmed_competing_native_block', nextCheckAt:null}};
  const other = {...f.pending, relay:{...f.pending.relay, requestId:account}};
  for (const current of [terminal,other]) {
    const api = {async request(path, options) {assert.equal(path,f.path);assert.equal(options,undefined);return f.response(current);}};
    assert.deepEqual(await payRequirement({...f.paymentInput,api},f.wallet()),current);
    assert.deepEqual(paymentRequirement(current,id,account),current);
  }
  assert.equal(f.preparations.length,0);
});

test('unadmitted durable recovery uses current wallet authority while already admitted recovery reads status',async()=>{
  const f = durableFixture('XNO');
  let current = f.p;
  let posts = 0;
  const api = {async request(_path, options) {
    if (!options) return f.response(current);
    posts++;
    throw Error('response lost');
  }};
  const input = {...f.paymentInput,api};
  await assert.rejects(payRequirement(input,f.wallet()),/response lost/);
  const wallet = {async callWallet(env, request) {
    if (request.operation === 'payment.relay.check') throw Error('grant revoked');
    return f.wallet().callWallet(env,request);
  }};
  await assert.rejects(payRequirement(input,wallet),/grant revoked/);
  assert.equal(posts,1);
  current = f.pending;
  assert.deepEqual(await payRequirement(input,wallet),f.pending);

  current = {...f.verified,
    verifiedPayment:{...f.verified.verifiedPayment,transactionHash:'e'.repeat(64)},
    relay:{...f.verified.relay,status:'REJECTED',reason:'confirmed_competing_native_block'}};
  assert.deepEqual(paymentRequirement(current,id,account),current);
  assert.deepEqual(await payRequirement(input,wallet),{requirement:current,originalRelay:current.relay});

  const originalRelay={requestId:id,transactionHash:f.pending.relay.transactionHash,status:'REJECTED',reason:'confirmed_competing_native_block'};
  current={...current,relay:{...f.verified.relay,requestId:account,transactionHash:current.verifiedPayment.transactionHash},
    submissions:[originalRelay]};
  const noWallet={async callWallet() {throw Error('foreign admission is read-only');}};
  assert.deepEqual(await payRequirement(input,noWallet),{requirement:current,originalRelay});
  assert.equal(posts,1);
  assert.equal(f.preparations.length,1);
});

test('server-side legacy admission keeps its original flow after durable support is advertised',async()=>{
  const f = durableFixture('XNO');
  const staged = {...f.pending, relay:{...f.pending.relay, mode:'X402', attempted:false}};
  const api = {async request(path, options) {
    assert.equal(path,f.path);
    return options ? f.response(staged,202,{Location:f.path}) : f.response(staged);
  }};
  assert.equal((await payRequirement({...f.paymentInput,api},f.wallet())).requirement.relay.mode,'X402');
  assert.equal(f.preparations.length,0);
});

function reauthorizationFixture() {
  const transactionHash = 'd'.repeat(64);
  const p = {...fixture('XNO'), purpose:'PUBLICATION_FEE',
    relay:{requestId:id, transactionHash, attempted:false, status:'PENDING', reason:'deadline expired',
      authorizationRequired:true, reauthorizedUntil:null}};
  const validUntil = new Date(Date.now() + 240_000).toISOString();
  const body = {requestId:id, transactionHash, validUntil};
  const retained = {requestId:id, hash:transactionHash.toUpperCase(), origin:profile.origin, audience:profile.audience, terms:relayTerms(p)};
  const calls = [], writes = [];
  const native = {async callWallet(_env, request) {calls.push(request); return retained;}};
  const api = {async request(path, options) {
    if (options) {
      assert.equal(path, `/v1/agent/payments/${id}/relay/reauthorize`);
      writes.push(options);
      p.relay = {...p.relay, reauthorizedUntil:validUntil, authorizationRequired:false};
    } else assert.equal(path, `/v1/agent/payments/${id}`);
    return {json:structuredClone(p)};
  }};
  return {p, retained, calls, writes, body, native, input:{api, profile, env:{}, paymentId:id, ...body}};
}

test('only explicit reauthorization grants the exact retained candidate a new deadline; lost responses recover via GET', async () => {
  const f = reauthorizationFixture();
  const read = await f.input.api.request(`/v1/agent/payments/${id}`);
  assert.equal(read.json.relay.authorizationRequired, true);
  const transport = f.input.api;
  f.input.api = {async request(path, options) {
    const response = await transport.request(path, options);
    if (options) throw Error('lost response after commit');
    return response;
  }};
  await assert.rejects(reauthorizeRelay(f.input, f.native), /lost response/);
  const recovered = await reauthorizeRelay(f.input, f.native);
  assert.equal(recovered.relay.reauthorizedUntil, f.body.validUntil);
  assert.equal(recovered.status, 'PENDING');
  assert.deepEqual(f.calls, [{asset:'XNO', operation:'payment.reauthorization.check',
    input:{requestId:id, transactionHash:f.body.transactionHash}}]);
  assert.deepEqual(f.writes, [{method:'POST', body:f.body}]);
});

test('a changed native journal, hash, deadline or unexpired relay cannot authorize publication', async () => {
  for (const change of [f => {f.retained.terms.amountAtomic = '99';}, f => {f.retained.origin = 'https://other.example';},
    f => {f.retained.hash = 'a'.repeat(64);}, f => {f.input.requestId = account;}, f => {f.input.transactionHash = 'e'.repeat(64);},
    f => {f.input.validUntil = new Date(Date.now() + 600_000).toISOString();}, f => {f.p.relay.attempted = true;},
    f => {f.p.relay.authorizationRequired = false;}, f => {delete f.p.relay.authorizationRequired;}]) {
    const f = reauthorizationFixture();
    change(f);
    await assert.rejects(reauthorizeRelay(f.input, f.native));
    assert.deepEqual(f.writes, []);
  }
});
