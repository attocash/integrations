import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { fixture, gate, until } from './support/payments.mjs';
import { offer, terms, challenge, paymentId } from '../../test/support/relay.mjs';
import { derivedSigner, mnemonicSeed } from '../dist/wallet/signing.js';
import { parseRelayOffer, relayEvidenceBinding, decodePaymentHeader } from '../dist/marketplace/relay.js';
const strictJsonModule=process.env.ATTO_TEST_CLI_PACKAGE_DIR
  ?pathToFileURL(join(process.env.ATTO_TEST_CLI_PACKAGE_DIR,'dist/marketplace/strict-json.js'))
  :new URL('../dist/marketplace/strict-json.js',import.meta.url);
const {parseJsonObject}=await import(strictJsonModule.href);

test('strict JSON preserves valid escapes Unicode and ordinary nested value semantics',()=>{
  // Given every JSON escape form, decoded Unicode, and ordinary number/array/null values.
  const text=String.raw`{"quote\"\\key":"quote\" slash\/ backslash\\ controls\b\f\n\r\t unicode\u0061\uD83D\uDE00 lone\uD800","normal":"é漢😀","numbers":[0,-12.5,1e3,-0.25E-2],"values":[true,false,null,{"other":"value"}],"trailing":"slash\\"}`;
  // When the duplicate-field traversal scans the already validated source.
  const parsed=parseJsonObject(text);
  // Then it retains complete JSON.parse semantics, including a trailing escaped backslash.
  assert.deepEqual(parsed,JSON.parse(text));
  const separate=String.raw`{"outer":[{"key":1},{"key":2}],"é":1,"e\u0301":2}`;
  assert.deepEqual(parseJsonObject(separate),JSON.parse(separate));
});

test('strict JSON rejects decoded duplicate names at root and nested object or array boundaries',()=>{
  // Given direct duplicates and equivalent escaped names, including surrogate pairs and escaped delimiters.
  const texts=[String.raw`{"key":1,"key":2}`,String.raw`{"key":1,"k\u0065y":2}`,
    String.raw`{"\u006bey":1,"key":2}`,String.raw`{"outer":[{"name":1,"\u006eame":2}]}`,
    String.raw`{"outer":{"😀":1,"\ud83d\ude00":2}}`,String.raw`{"outer":[{"a\"\\":1,"a\u0022\u005c":2}]}`];
  // When the actual parser decodes each object key.
  // Then duplicates are rejected before callers can normalize the original bytes.
  for(const text of texts)assert.throws(()=>parseJsonObject(text),/Duplicate JSON field/);
});

test('strict JSON retains malformed root trailing and depth rejection boundaries',()=>{
  // Given malformed escape/Unicode/string/control inputs, non-object roots and trailing tokens.
  const texts=[String.raw`{"key":"\x"}`,String.raw`{"key":"\u12"}`,String.raw`{"key":"unterminated}`,
    '{"key":"raw\ncontrol"}',String.raw`{"key":"valid"} trailing`,'[]','"string"','null','true','42'];
  const within='{"value":'+'['.repeat(63)+'0'+']'.repeat(63)+'}',over='{"value":'+'['.repeat(64)+'0'+']'.repeat(64)+'}';
  // When syntax/type checks run before the bounded duplicate traversal.
  // Then malformed inputs fail and the existing 64-level value boundary stays exact.
  for(const text of texts)assert.throws(()=>parseJsonObject(text));
  assert.deepEqual(parseJsonObject(within),JSON.parse(within));
  assert.throws(()=>parseJsonObject(over),/JSON nesting exceeds its limit/);
});

test('strict JSON handles bounded adversarial quoted keys and values at the exact UTF-8 byte cap',()=>{
  // Given long repeated escaped quote/backslash tokens with correctly escaped trailing backslashes.
  const cap=1_000_000,bytes=text=>Buffer.byteLength(text,'utf8');
  const repeated='\\"'.repeat(Math.floor((cap-11)/8)),key=repeated+'\\',base=JSON.stringify({[key]:repeated+'\\'});
  const value=repeated+'a'.repeat(cap-bytes(base))+'\\',bounded=JSON.stringify({[key]:value});
  const multibyteValue='é'.repeat((cap-bytes(JSON.stringify({value:''})))/2),multibyte=JSON.stringify({value:multibyteValue});
  // When the real parser receives valid and malformed bounded source strings, without timing assumptions.
  const parsed=parseJsonObject(bounded);
  // Then results and byte limits are preserved for ASCII escapes and multibyte UTF-8 alike.
  assert.ok(bytes(base)<cap);assert.deepEqual(parseJsonObject(base),JSON.parse(base));
  assert.equal(bytes(bounded),cap);assert.deepEqual(parsed,{[key]:value});
  assert.throws(()=>parseJsonObject(bounded+' '),/JSON input exceeds its byte limit/);
  const malformed=bounded.slice(0,-2)+'  ';
  assert.equal(bytes(malformed),cap);assert.throws(()=>parseJsonObject(malformed));
  assert.equal(bytes(multibyte),cap);assert.deepEqual(parseJsonObject(multibyte),{value:multibyteValue});
  assert.throws(()=>parseJsonObject(JSON.stringify({value:multibyteValue+'a'})),/JSON input exceeds its byte limit/);
});

test('Marketplace relay signs locally, retains exact authorization through restart, and never publishes from wallet commands', {timeout:20000},async t=>{
  // Given a selected wallet with its existing spend grant and immutable seller requirement.
  const f=await fixture(t,['100']), app=f.open('mcp',{internalMarketplaceAuthorizeWrite:()=>{}});
  const p={...terms('ATTO',f.addresses[0].address,f.recipient.address),baselineFrontier:'01'.repeat(32)},request={requestId:paymentId,origin:'https://marketplace.example',audience:'marketplace',terms:p,paymentRequired:offer(p),index:0};
  // When the native candidate is prepared and its exact bound proof is retained before relay.
  const prepared=await app.marketplaceRelay('payment_prepare',request);
  assert.equal(f.state.publicationAttempts.length,0);
  const record=app.ledger.get(paymentId),seed=await mnemonicSeed(f.mnemonic());
  const c=challenge(p,prepared.hash,relayEvidenceBinding),signer=await derivedSigner(seed,0);
  const proof={challengeId:c.challengeId,message:c.message,signature:(await signer.signMessage(Int8Array.from(Buffer.from(c.message)))).toString()};seed.value.fill(0);
  const reads=f.secretReads;
  await assert.rejects(app.marketplaceRelay('payment_authorize',{requestId:paymentId,index:1,proof:{challengeId:proof.challengeId,message:proof.message}}),{code:'REQUEST_CONFLICT'});
  await assert.rejects(app.marketplaceRelay('payment_status',{requestId:paymentId,index:1}),{code:'REQUEST_CONFLICT'});
  assert.equal(f.secretReads,reads);
  assert.deepEqual(app.ledger.messageSigningIndexes(),[]);
  const authorized=await app.marketplaceRelay('payment_authorize',{requestId:paymentId,proof:{challengeId:proof.challengeId,message:proof.message}});
  await app.close();f.forbidSecrets();
  const reopened=f.open('mcp',{internalMarketplaceAuthorizeWrite:()=>{}});
  const recovered=await reopened.marketplaceRelay('payment_status',{requestId:paymentId});
  // Then the exact signed candidate and proof survive, the account stays fenced, and generic send cannot publish it.
  assert.equal(recovered.hash,prepared.hash);assert.equal(recovered.paymentSignature,authorized.paymentSignature);
  assert.equal(reopened.ledger.get(paymentId).transactionJson,record.transactionJson);
  assert.equal((await reopened.call('limits_get',{})).pendingRaw,'40');
  assert.equal(f.state.publicationAttempts.length,0);
  await assert.rejects(reopened.call('send',f.request(paymentId,'40',{index:0})),{code:'REQUEST_CONFLICT'});
  const decoded=decodePaymentHeader(recovered.paymentSignature);
  assert.equal(decoded.payload.transaction.block.receiverAddress,p.recipientAddress);
  assert.equal(decoded.payload.transaction.block.amount,'40');
  assert.deepEqual(decoded.extensions['marketplace-binding'].proof,proof);
  await assert.rejects(reopened.marketplaceRelay('payment_prepare',{...request,terms:{...p,amountAtomic:'41'}}));
});

test('relay offer parser rejects changed immutable fields, duplicate JSON, unsupported extensions and expired fresh authorization',()=>{
  // Given one frozen offer whose atomic amount must remain a lossless string.
  const p=terms('ATTO','sender','seller'),request={requestId:paymentId,origin:'https://marketplace.example',audience:'marketplace',terms:p,paymentRequired:offer(p)};
  // When offer fields or wire parsing are changed at the trust boundary.
  const mutations=[raw=>raw.accepts[0].amount=40,raw=>raw.accepts[0].payTo='other',raw=>raw.accepts[0].network='atto:live',
    raw=>raw.extensions['marketplace-binding'].info.termsHash='c'.repeat(64),raw=>raw.extensions.unknown={info:{required:true}},
    raw=>raw.resource.url='https://elsewhere.example/v1/agent/payments/'+paymentId,raw=>raw.extensions['marketplace-binding'].info.baselineHeight=3];
  // Then every inconsistent offer is rejected before a key or native network is accessed.
  for(const mutate of mutations){const raw=decodePaymentHeader(request.paymentRequired);mutate(raw);assert.throws(()=>parseRelayOffer({...request,paymentRequired:Buffer.from(JSON.stringify(raw)).toString('base64')}));}
  assert.throws(()=>parseRelayOffer({...request,paymentRequired:Buffer.from('{"x402Version":2,"x402Version":2}').toString('base64')}),/JSON/);
  assert.throws(()=>parseRelayOffer({...request,paymentRequired:request.paymentRequired+'\n'}));
  const expired={...request,paymentRequired:offer(p,request.origin,Date.now()-400000)};
  assert.throws(()=>parseRelayOffer(expired),/expired/);assert.doesNotThrow(()=>parseRelayOffer(expired,true));
});


test('a killed unsigned ATTO relay refreshes only its expired unused offer and preserves the original reservation', {timeout:20000},async t=>{
  // Given a real wallet process stopped during work before any complete candidate is retained or returned.
  const f=await fixture(t,['100']),p={...terms('ATTO',f.addresses[0].address,f.recipient.address),baselineFrontier:'01'.repeat(32)},
    request={requestId:paymentId,origin:'https://marketplace.example',audience:'marketplace',terms:p,paymentRequired:offer(p),index:0};
  f.state.holdWork=gate();
  const child=spawn(process.execPath,['--input-type=module','--eval',`
    const {AttoApplication}=await import(process.env.RELAY_APPLICATION);
    const app=new AttoApplication({directory:process.env.RELAY_DIRECTORY,access:'mcp',secrets:{get:async()=>process.env.RELAY_PHRASE},internalMarketplaceAuthorizeWrite:()=>{}});
    try{await app.marketplaceRelay('payment_prepare',JSON.parse(process.env.RELAY_REQUEST));}finally{await app.close();}
  `],{stdio:['ignore','pipe','pipe'],env:{...process.env,RELAY_APPLICATION:new URL('../dist/application/app.js',import.meta.url).href,
    RELAY_DIRECTORY:f.directory,RELAY_PHRASE:f.mnemonic(),RELAY_REQUEST:JSON.stringify(request)}});
  child.stdout.resume();let diagnostics='';child.stderr.on('data',value=>{diagnostics+=value;});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  await until(()=>{assert.equal(child.exitCode,null,diagnostics);return f.state.works.length>0;});
  const original=f.app.ledger.get(paymentId);assert.equal(original.hash,undefined);assert.equal(original.transactionJson,undefined);
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;f.state.holdWork.release();
  // When time passes beyond the unused offer and a new backend-issued window is offered for the exact same operation.
  const realNow=Date.now,advanced=realNow()+400000;Date.now=()=>advanced;
  try {
    const app=f.open('mcp',{internalMarketplaceAuthorizeWrite:()=>{}}),fresh={...request,paymentRequired:offer(p,request.origin,advanced)};
    const recovered=await app.marketplaceRelay('payment_prepare',fresh),saved=app.ledger.get(paymentId);
    // Then only the unused window changes; the reservation is retained once and no native publication occurs.
    assert.equal(saved.createdAt,original.createdAt);assert.equal(saved.id,original.id);assert.equal(saved.raw,original.raw);
    assert.equal(saved.relay.paymentRequired,fresh.paymentRequired);assert.ok(recovered.hash);assert.equal(f.state.publicationAttempts.length,0);
    assert.equal(app.ledger.usage().pendingRaw,'40');assert.equal(app.ledger.journalList().items.length,1);
    await assert.rejects(app.marketplaceRelay('payment_prepare',{...fresh,paymentRequired:offer(p,request.origin,advanced+400000)}),{code:'REQUEST_CONFLICT'});
    assert.equal(app.ledger.get(paymentId).hash,recovered.hash);
  } finally {Date.now=realNow;}
});

test('ATTO offer refresh races with signing under the same account lock and never replaces a retained candidate', {timeout:20000},async t=>{
  // Given the original prepare holds its account while work is in flight.
  const f=await fixture(t,['100']),app=f.open('mcp',{internalMarketplaceAuthorizeWrite:()=>{}}),other=f.open('mcp',{internalMarketplaceAuthorizeWrite:()=>{}}),
    p={...terms('ATTO',f.addresses[0].address,f.recipient.address),baselineFrontier:'01'.repeat(32)},request={requestId:paymentId,origin:'https://marketplace.example',audience:'marketplace',terms:p,paymentRequired:offer(p),index:0};
  f.state.holdWork=gate();const first=app.marketplaceRelay('payment_prepare',request);first.catch(()=>{});
  await until(()=>f.state.works.length>0);
  const realNow=Date.now,advanced=realNow()+400000;Date.now=()=>advanced;
  try {
    // When the offer expires and another process-equivalent session requests a fresh unused window.
    const fresh={...request,paymentRequired:offer(p,request.origin,advanced)},second=other.marketplaceRelay('payment_prepare',fresh);second.catch(()=>{});
    f.state.holdWork.release();
    await assert.rejects(first,/expired/);const result=await second;
    // Then stale preparation returns no candidate; the locked refresh persists just one candidate and allowance.
    assert.ok(result.hash);assert.equal(app.ledger.get(paymentId).hash,result.hash);assert.equal(app.ledger.usage().pendingRaw,'40');
    assert.equal(app.ledger.get(paymentId).relay.paymentRequired,fresh.paymentRequired);assert.equal(f.state.publicationAttempts.length,0);
  } finally {Date.now=realNow;f.state.holdWork.release();}
});
