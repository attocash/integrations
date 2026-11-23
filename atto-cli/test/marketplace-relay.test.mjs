import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { fixture, gate, until } from './support/payments.mjs';
import { offer, legacyOffer, legacyHeader, terms, legacyChallenge, paymentId } from '../../test/support/relay.mjs';
import { derivedSigner, mnemonicSeed } from '../dist/wallet/signing.js';
import { parseRelayOffer, decodePaymentHeader } from '../dist/marketplace/relay.js';
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
  // Preparing once atomically saves the SEND and the entire payment header.
  const prepared=await app.marketplaceRelay('payment_prepare',request);
  assert.equal(f.state.publicationAttempts.length,0);
  const record=app.ledger.get(paymentId),reads=f.secretReads;
  await assert.rejects(app.marketplaceRelay('payment_status',{requestId:paymentId,index:1}),{code:'REQUEST_CONFLICT'});
  assert.equal(f.secretReads,reads);
  assert.deepEqual(app.ledger.messageSigningIndexes(),[]);
  await app.close();f.forbidSecrets();
  const reopened=f.open('mcp',{internalMarketplaceAuthorizeWrite:()=>{}});
  const recovered=await reopened.marketplaceRelay('payment_status',{requestId:paymentId});
  // Then the exact signed candidate and header survive, the account stays fenced, and generic send cannot publish it.
  assert.equal(recovered.hash,prepared.hash);assert.equal(recovered.paymentSignature,prepared.paymentSignature);
  assert.equal(reopened.ledger.get(paymentId).transactionJson,record.transactionJson);
  assert.equal((await reopened.call('limits_get',{})).pendingRaw,'40');
  assert.equal(f.state.publicationAttempts.length,0);
  await assert.rejects(reopened.call('send',f.request(paymentId,'40',{index:0})),{code:'REQUEST_CONFLICT'});
  const decoded=decodePaymentHeader(recovered.paymentSignature);
  assert.equal(decoded.payload.transaction.block.receiverAddress,p.recipientAddress);
  assert.equal(decoded.payload.transaction.block.amount,'40');
  assert.deepEqual(Object.keys(decoded.extensions),['payment-identifier']);
  assert.equal(decoded.extensions['payment-identifier'].info.id,paymentId);
  await assert.rejects(reopened.marketplaceRelay('payment_prepare',{...request,terms:{...p,amountAtomic:'41'}}));
});

test('standard relay offers require the exact payment resource, identifier and transfer terms',()=>{
  const p=terms('ATTO','sender','seller'),request={requestId:paymentId,origin:'https://marketplace.example',audience:'marketplace',terms:p,paymentRequired:offer(p)};
  assert.doesNotThrow(()=>parseRelayOffer(request));
  const mutations=[raw=>raw.accepts[0].amount=40,raw=>raw.accepts[0].payTo='other',raw=>raw.accepts[0].network='atto:live',
    raw=>raw.extensions['payment-identifier'].info.required=false,raw=>raw.extensions['payment-identifier'].info.id='another-payment-id',
    raw=>delete raw.extensions['payment-identifier'],raw=>raw.extensions.unknown={info:{required:true}},
    raw=>raw.resource.url='https://elsewhere.example/v1/agent/payments/'+paymentId];
  for(const mutate of mutations){const raw=decodePaymentHeader(request.paymentRequired);mutate(raw);assert.throws(()=>parseRelayOffer({...request,paymentRequired:Buffer.from(JSON.stringify(raw)).toString('base64')}));}
  assert.throws(()=>parseRelayOffer({...request,paymentRequired:Buffer.from('{"x402Version":2,"x402Version":2}').toString('base64')}),/JSON/);
  assert.throws(()=>parseRelayOffer({...request,paymentRequired:request.paymentRequired+'\n'}));
  const legacy={...request,paymentRequired:legacyOffer(p)};
  assert.throws(()=>parseRelayOffer(legacy));assert.doesNotThrow(()=>parseRelayOffer(legacy,true));
});

for(const hasHeader of [false,true]) test(`ATTO reopens a previous-version ${hasHeader?'authorized':'prepared'} relay and reuses its signed transaction`, async t=>{
  const f=await fixture(t,['100']),app=f.open('mcp',{internalMarketplaceAuthorizeWrite:()=>{}});
  const p={...terms('ATTO',f.addresses[0].address,f.recipient.address),baselineFrontier:'01'.repeat(32)};
  const request={requestId:paymentId,origin:'https://marketplace.example',audience:'marketplace',terms:p,index:0,paymentRequired:offer(p)};
  const prepared=await app.marketplaceRelay('payment_prepare',request);
  // Seed the old journal layout with a genuine signed candidate and its original request binding.
  const record=app.ledger.get(paymentId),oldRequest={...request,paymentRequired:legacyOffer(p,request.origin,Date.now()-400000)};
  record.relay.paymentRequired=oldRequest.paymentRequired;
  delete record.relay.paymentSignature;
  record.candidateBinding=app.payments.candidateBinding(record);
  if(hasHeader) {
    const seed=await mnemonicSeed(f.mnemonic()),signer=await derivedSigner(seed,0);
    const c=legacyChallenge(p,prepared.hash,request.audience,Date.now()-400000);
    const proof={challengeId:c.challengeId,message:c.message,signature:(await signer.signMessage(Int8Array.from(Buffer.from(c.message)))).toString()};
    seed.value.fill(0);
    record.relay.paymentSignature=legacyHeader(oldRequest,decodePaymentHeader(prepared.paymentSignature).payload,proof);
  }
  app.store.set('spending.records',[record]);
  await app.close();f.forbidSecrets();
  const reopened=f.open('mcp',{internalMarketplaceAuthorizeWrite:()=>{}});
  const before=await reopened.marketplaceRelay('payment_status',{requestId:paymentId});
  assert.equal(before.paymentSignature,record.relay.paymentSignature??null);
  const recovered=await reopened.marketplaceRelay('payment_prepare',oldRequest);
  assert.equal(recovered.hash,prepared.hash);
  if(hasHeader) assert.equal(recovered.paymentSignature,record.relay.paymentSignature);
  else {
    const decoded=decodePaymentHeader(recovered.paymentSignature);
    assert.deepEqual(decoded.payload,decodePaymentHeader(prepared.paymentSignature).payload);
    assert.deepEqual(Object.keys(decoded.extensions),['payment-identifier']);
    assert.deepEqual(decoded.extensions['payment-identifier'].schema,decodePaymentHeader(oldRequest.paymentRequired).extensions['payment-identifier'].schema);
  }
  assert.equal(reopened.ledger.get(paymentId).transactionJson,record.transactionJson);
  assert.equal(reopened.ledger.usage().pendingRaw,'40');assert.equal(f.state.publicationAttempts.length,0);
});

test('an unsigned pre-upgrade ATTO relay resumes the original reservation', {timeout:20000},async t=>{
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
  original.relay.paymentRequired=legacyOffer(p,request.origin);
  f.app.store.set('spending.records',[original]);
  const app=f.open('mcp',{internalMarketplaceAuthorizeWrite:()=>{}});
  await assert.rejects(app.marketplaceRelay('payment_prepare',{...request,terms:{...p,termsHash:'c'.repeat(64)}}));
  assert.equal(app.ledger.get(paymentId).relay.paymentRequired,original.relay.paymentRequired);
  const recovered=await app.marketplaceRelay('payment_prepare',request),saved=app.ledger.get(paymentId);
  assert.equal(saved.createdAt,original.createdAt);assert.equal(saved.raw,original.raw);
  assert.equal(saved.relay.paymentRequired,request.paymentRequired);assert.ok(recovered.paymentSignature);
  assert.equal(app.ledger.usage().pendingRaw,'40');assert.equal(app.ledger.journalList().items.length,1);
  assert.equal(f.state.publicationAttempts.length,0);
});

test('concurrent ATTO prepares retain one header and use one allowance', {timeout:20000},async t=>{
  const f=await fixture(t,['100']),app=f.open('mcp',{internalMarketplaceAuthorizeWrite:()=>{}}),other=f.open('mcp',{internalMarketplaceAuthorizeWrite:()=>{}});
  const p={...terms('ATTO',f.addresses[0].address,f.recipient.address),baselineFrontier:'01'.repeat(32)};
  const request={requestId:paymentId,origin:'https://marketplace.example',audience:'marketplace',terms:p,paymentRequired:offer(p),index:0};
  f.state.holdWork=gate();const first=app.marketplaceRelay('payment_prepare',request);
  try {
    await until(()=>f.state.works.length>0);
    const second=other.marketplaceRelay('payment_prepare',request);
    f.state.holdWork.release();
    const results=await Promise.all([first,second]);
    assert.equal(results[0].hash,results[1].hash);assert.equal(results[0].paymentSignature,results[1].paymentSignature);
    assert.equal(app.ledger.usage().pendingRaw,'40');assert.equal(f.state.publicationAttempts.length,0);
  } finally { f.state.holdWork.release(); }
});
