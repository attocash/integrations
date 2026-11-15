import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import test from 'node:test';
const cliDirectory=process.env.ATTO_TEST_CLI_PACKAGE_DIR??fileURLToPath(new URL('../',import.meta.url));
const {AttoMnemonic,AttoSignature}=await import(pathToFileURL(createRequire(join(cliDirectory,'package.json')).resolve('@attocash/commons-core')).href);
const {MarketplaceConnectionClient}=await import(pathToFileURL(join(cliDirectory,'dist/marketplace/connection.js')).href);
const {derivedSigner}=await import(pathToFileURL(join(cliDirectory,'dist/wallet/signing.js')).href);
const phrase=`${'abandon '.repeat(23)}art`,origin='https://marketplace.example';
const accountId='11111111-1111-4111-8111-111111111111',identityId='22222222-2222-4222-8222-222222222222',agentId='33333333-3333-4333-8333-333333333333';

async function fixture(t){
  const seed=await(await AttoMnemonic.fromPhrase(phrase)).toSeedAsync(),signer=await derivedSigner(seed,0);
  t.after(()=>seed.value.fill(0));
  const fingerprint=createHash('sha256').update(signer.publicKey.toString()).digest('hex');
  const saved=new Map([['identity',{address:signer.address.value,fingerprint}]]);let keyReads=0;
  const client=new MarketplaceConnectionClient({get:key=>saved.get(key),set:(key,value)=>saved.set(key,value)},{
    settings:()=>({network:'LIVE'}),addresses:()=>[{index:0,address:signer.address.value,publicKey:signer.publicKey.toString(),active:true}],
    seed:async()=>{keyReads++;return(await AttoMnemonic.fromPhrase(phrase)).toSeedAsync();},mcp:false,
  });
  return{client,signer,saved,fingerprint,get keyReads(){return keyReads;}};
}

test('connection posts only current auth challenges and sessions from the payments API context',async t=>{
  const f=await fixture(t),requests=[];
  const challengeId='44444444-4444-4444-8444-444444444444',issuedAt=new Date().toISOString(),expiresAt=new Date(Date.now()+120000).toISOString();
  const binding=createHash('sha256').update(['marketplace-login-v1',accountId,identityId].join('\n')).digest('hex');
  const message=['Marketplace Agent Controller Proof v1','Audience: marketplace','Network: live',`Address: ${f.signer.address.value}`,'Purpose: login',`Request ID: ${challengeId}`,`Binding Hash: ${binding}`,`Nonce: ${'a'.repeat(64)}`,`Issued At: ${issuedAt}`,`Expiration Time: ${expiresAt}`].join('\n');
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const body=JSON.parse(options.body);requests.push({url:String(url),options,body});
    if(String(url)===`${origin}/v1/agent/auth/challenges`)return Response.json({accountId,controllerId:identityId,challengeId,message,issuedAt,expiresAt});
    assert.equal(String(url),`${origin}/v1/agent/auth/sessions`);
    assert.deepEqual(Object.keys(body).sort(),['challengeId','message','signature']);
    assert.equal(body.message,message);assert.equal(body.challengeId,challengeId);
    assert.equal(await AttoSignature.Companion.parse(body.signature).isValidMessage(f.signer.publicKey,Int8Array.from(Buffer.from(message))),true);
    return Response.json({accountId,agentId,identityId,accountState:'ACTIVE',accessToken:'local-test-session-access',refreshToken:'local-test-session-refresh',accessExpiresAt:expiresAt,refreshExpiresAt:new Date(Date.now()+240000).toISOString()});
  });
  const connection=await f.client.connect({apiUrl:`${origin}/v1/agent/payments`,audience:'marketplace',controllerIndex:0});
  assert.equal(connection.apiUrl,`${origin}/v1/agent/payments`);assert.equal(connection.accountId,accountId);
  assert.deepEqual(requests.map(row=>row.url),[`${origin}/v1/agent/auth/challenges`,`${origin}/v1/agent/auth/sessions`]);
  assert.deepEqual(requests[0].body,{network:'ATTO',address:f.signer.address.value});
  for(const {options}of requests){assert.equal(options.method,'POST');assert.equal(options.redirect,'error');assert.equal(new Headers(options.headers).get('authorization'),null);}
  assert.equal(f.keyReads,1);assert.equal(JSON.stringify(f.saved.get('marketplace.connection')).includes('local-test-session-access'),false);
});

test('connection rejects arbitrary, retired and transaction publication paths before HTTP or key access',async t=>{
  const f=await fixture(t);let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('must not contact arbitrary resource');});
  for(const path of ['/v1/agent/topups','/v1/agent/payments/44444444-4444-4444-8444-444444444444','/v1/agent/payments/transactions','/v1/agent/auth/challenges','/transactions','/v1/agent/payments?destination=attacker','/v1/agent/payments#other']){
    await assert.rejects(f.client.connect({apiUrl:`${origin}${path}`,audience:'marketplace',controllerIndex:0}),{code:'MARKETPLACE_CONFIGURATION'});
  }
  assert.equal(calls,0);assert.equal(f.keyReads,0);assert.equal(f.saved.has('marketplace.connection'),false);
});
