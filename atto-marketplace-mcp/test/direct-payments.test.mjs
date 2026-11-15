import {fileURLToPath,pathToFileURL} from 'node:url';
const packageDirectory=process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR??fileURLToPath(new URL('../',import.meta.url));
import {join} from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
const {paymentEvidenceBinding,payRequirement,validatePaymentChallenge}=await import(pathToFileURL(join(packageDirectory,'dist/direct-payments.js')).href);
const id='11111111-1111-4111-8111-111111111111',account='22222222-2222-4222-8222-222222222222';
function fixture(asset){return {id,purpose:'SHOP_ORDER',sourceReference:'order',ownerAccountId:account,asset,network:asset==='ATTO'?'atto:local':'nano:dev',senderAddress:'sender',recipientAddress:'seller',amountAtomic:'100000000000000000000000000001',termsHash:'a'.repeat(64),versionHash:'b'.repeat(64),baselineHeight:7,baselineFrontier:'c'.repeat(64),status:'PENDING',verifiedPayment:null,submissions:[],relay:null};}
for(const asset of ['ATTO','XNO'])for(const outcome of ['pending','confirmed'])test(`${asset} lost relay responses replay the same durable payload and proof through ${outcome} without client publication`,async()=>{
  // Given immutable instructions and one wallet-owned candidate/header journal.
  const p=fixture(asset);p.amountAtomic=asset==='ATTO'?'9007199254740993':'100000000000000000000000000001';
  const requests=[],operations=[],headers=[];let saved,signs=0,lost=true;
  const {offer}=await import('../../test/support/relay.mjs');
  const {relayTerms}=await import(pathToFileURL(join(packageDirectory,'dist/direct-payments.js')).href);
  const {parseRelayOffer,relayPaymentPayload}=await import('@attocash/cli/internal-marketplace');
  const native={async callWallet(_env,request){operations.push(request.operation);
    if(request.operation==='identity.list')return {address:'sender',network:p.network,index:0};
    if(request.operation==='payment.status')return saved??{requestId:id,state:'NOT_FOUND'};
    if(request.operation==='payment.prepare'){
      saved={requestId:id,network:p.network,sourceAddress:'sender',destination:'seller',amountAtomic:p.amountAtomic,state:'signed',hash:'d'.repeat(64),paymentRequired:request.input.paymentRequired,paymentSignature:null};return saved;
    }
    assert.equal(request.operation,'payment.authorize');
    const offered=parseRelayOffer({requestId:id,origin:'https://marketplace.example',audience:'audience',terms:relayTerms(p),paymentRequired:saved.paymentRequired});
    saved={...saved,paymentSignature:relayPaymentPayload(offered,id,{[asset==='ATTO'?'transaction':'block']:{retained:true}},{...request.input.proof,signature:'f'.repeat(128)})};
    return saved;
  },async signAttoControllerProof(){signs++;return 'f'.repeat(128);},async signNanoControllerProof(){signs++;return 'f'.repeat(128);}};
  const api={async request(path,options){requests.push({path,options});
    if(path.endsWith('/challenge')){
      const issuedAt=new Date().toISOString(),expiresAt=new Date(Date.now()+120000).toISOString();
      return {json:{challengeId:id,issuedAt,expiresAt,message:[`${asset==='ATTO'?'':'Nano '}Marketplace Agent Controller Proof v1`,'Audience: audience',`Network: ${asset==='ATTO'?'live':p.network}`,'Address: sender','Purpose: payment evidence',`Request ID: ${id}`,`Binding Hash: ${paymentEvidenceBinding(p,'d'.repeat(64))}`,`Nonce: ${'e'.repeat(64)}`,`Issued At: ${issuedAt}`,`Expiration Time: ${expiresAt}`].join('\n')}};
    }
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
  const input={api,profile:{accountId:account,audience:'audience',origin:'https://marketplace.example'},env:{},paymentId:id};
  // When the admitted relay loses its response and the process repeats the original operation.
  await assert.rejects(payRequirement(input,native),/response lost/);const result=await payRequirement(input,native);
  // Then the wallet never broadcasts, and Market receives identical signed bytes/proof without another reservation or signature.
  if(outcome==='pending')assert.equal(result.settlement.errorReason,'settlement_pending');else assert.equal(result.status,'VERIFIED');
  assert.equal(signs,0);assert.equal(headers[0],headers[1]);
  assert.equal(operations.filter(op=>op==='payment.prepare').length,1);assert.equal(operations.filter(op=>op==='payment.authorize').length,1);
  assert.equal(operations.includes('transfer.send'),false);assert.equal(requests.filter(r=>r.path.endsWith('/evidence')).length,0);
});
test('challenge validation refuses a proof for another amount or transaction hash before signing',()=>{
  // Given a challenge whose request and audience look correct but binding is forged.
  const p=fixture('XNO'),now=Date.now(),issuedAt=new Date(now).toISOString(),expiresAt=new Date(now+60000).toISOString();
  const challenge={challengeId:id,issuedAt,expiresAt,message:['Nano Marketplace Agent Controller Proof v1','Audience: audience',`Network: ${p.network}`,'Address: sender','Purpose: payment evidence',`Request ID: ${id}`,`Binding Hash: ${'f'.repeat(64)}`,`Nonce: ${'e'.repeat(64)}`,`Issued At: ${issuedAt}`,`Expiration Time: ${expiresAt}`].join('\n')};
  // When validating against the immutable requirement and candidate.
  // Then no signer can be called with the mismatched challenge.
  assert.throws(()=>validatePaymentChallenge(challenge,p,'d'.repeat(64),'audience',now),/differs/);
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
  const result=await payRequirement({api,profile:{accountId:account,audience:'audience',origin:'https://marketplace.example'},env:{},paymentId:id},native);
  // Then recovery retains the canonical pending operation and no signing authority is exercised.
  assert.deepEqual(operations,['identity.list','payment.status']);assert.equal(result.recovery,path);
});
for(const expiration of ['not-a-date',new Date(Date.now()-60000).toISOString()])test('a nonfinite or backward payment challenge expiry is rejected',()=>{
  // Given the correct binding but unusable expiration timing in the exact signed frame.
  const p=fixture('XNO'),issuedAt=new Date().toISOString(),c={challengeId:id,issuedAt,expiresAt:expiration,
    message:['Nano Marketplace Agent Controller Proof v1','Audience: audience',`Network: ${p.network}`,'Address: sender','Purpose: payment evidence',`Request ID: ${id}`,
      `Binding Hash: ${paymentEvidenceBinding(p,'d'.repeat(64))}`,`Nonce: ${'e'.repeat(64)}`,`Issued At: ${issuedAt}`,`Expiration Time: ${expiration}`].join('\n')};
  // When the challenge is validated before key access.
  // Then invalid timing cannot produce a payment proof.
  assert.throws(()=>validatePaymentChallenge(c,p,'d'.repeat(64),'audience'),/differs/);
});

test('an expired unused wallet offer is refreshed before fresh signing under the original requirement',async()=>{
  // Given a crash left no native candidate or signed header in the wallet's original reservation.
  const p=fixture('XNO'),{offer}=await import('../../test/support/relay.mjs'),{relayTerms}=await import(pathToFileURL(join(packageDirectory,'dist/direct-payments.js')).href);
  const terms=relayTerms(p),expired=offer(terms,'https://marketplace.example',Date.now()-400000),fresh=offer(terms),operations=[];
  const saved={requestId:id,network:p.network,sourceAddress:p.senderAddress,destination:p.recipientAddress,amountAtomic:p.amountAtomic,state:'PREPARING',hash:null,paymentRequired:expired,paymentSignature:null};
  const native={async callWallet(_env,request){operations.push(request.operation);if(request.operation==='identity.list')return {address:p.senderAddress,network:p.network,index:0};
    if(request.operation==='payment.status')return saved;
    assert.equal(request.operation,'payment.prepare');assert.equal(request.input.requestId,id);assert.equal(request.input.paymentRequired,fresh);
    throw Error('fresh prepare boundary');}};
  const api={async request(_path,options){if(!options)return {json:p};return {status:402,headers:new Headers({'PAYMENT-REQUIRED':fresh})};}};
  // When original request recovery asks the backend for a new unused window.
  // Then only the original request is prepared, and no generic send or previous signed payload is replaced.
  await assert.rejects(payRequirement({api,profile:{accountId:account,audience:'audience',origin:'https://marketplace.example'},env:{},paymentId:id},native),/fresh prepare boundary/);
  assert.deepEqual(operations,['identity.list','payment.status','payment.prepare']);
});
