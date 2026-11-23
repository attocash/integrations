import {fileURLToPath,pathToFileURL} from 'node:url';
const packageDirectory=process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR??fileURLToPath(new URL('../',import.meta.url));
import {join} from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
const {payRequirement,relayTerms}=await import(pathToFileURL(join(packageDirectory,'dist/direct-payments.js')).href);
const {offer,legacyOffer}=await import('../../test/support/relay.mjs');
const {parseRelayOffer,relayPaymentPayload,decodePaymentHeader}=await import('@attocash/cli/internal-marketplace');
const id='11111111-1111-4111-8111-111111111111',account='22222222-2222-4222-8222-222222222222';
const profile={accountId:account,audience:'audience',origin:'https://marketplace.example'};
function fixture(asset){return {id,purpose:'SHOP_ORDER',sourceReference:'order',ownerAccountId:account,asset,network:asset==='ATTO'?'atto:local':'nano:dev',senderAddress:'sender',recipientAddress:'seller',amountAtomic:'100000000000000000000000000001',termsHash:'a'.repeat(64),versionHash:'b'.repeat(64),baselineHeight:7,baselineFrontier:'c'.repeat(64),status:'PENDING',verifiedPayment:null,submissions:[],relay:null};}
for(const asset of ['ATTO','XNO'])for(const outcome of ['pending','confirmed'])test(`${asset} lost relay responses replay the same durable native payload through ${outcome} without client publication`,async t=>{
  // Given immutable instructions and one wallet-owned candidate/header journal.
  const p=fixture(asset);p.amountAtomic=asset==='ATTO'?'9007199254740993':'100000000000000000000000000001';
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
  const p=fixture('XNO');
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
  const p=fixture('XNO'),terms=relayTerms(p),paymentRequired=legacyOffer(terms),operations=[];
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
