import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from '../../test/support/temporary-directory.mjs';
import {join} from 'node:path';
import {MarketplaceApiClient} from '../dist/marketplace-api.js';
import {MarketplaceProfileStore} from '../dist/profile-store.js';

const originalFetch = globalThis.fetch;
const profile = (extra = {}) => ({id:'agent',origin:'https://marketplace.example',audience:'marketplace',
  accountId:'11111111-1111-4111-8111-111111111111',agentId:'22222222-2222-4222-8222-222222222222',
  identityId:'33333333-3333-4333-8333-333333333333',controllerNetwork:'ATTO',
  controllerAddress:`atto://${'a'.repeat(61)}`,authMode:'controller-session',
  accessToken:'expired-access-token',accessExpiresAt:Date.now()-1000,
  refreshToken:'original-refresh-token',refreshExpiresAt:Date.now()+120_000,...extra});
const rotated = () => ({accessToken:'rotated-access-token',accessExpiresAt:new Date(Date.now()+60_000).toISOString(),
  refreshToken:'rotated-refresh-token',refreshExpiresAt:new Date(Date.now()+120_000).toISOString()});
const deferred = () => {let resolve; const promise=new Promise(done=>{resolve=done;}); return {promise,resolve};};

async function fixture(t, extra = {}) {
  const home=await mkdtemp(join(tmpdir(),'marketplace-api-refresh-'));
  const store=await MarketplaceProfileStore.open(home);
  store.createProfile(profile(extra));
  t.after(async()=>{globalThis.fetch=originalFetch;store.close();await rm(home,{recursive:true,force:true});});
  return {home,store};
}

test('parallel clients and store instances share one rotating refresh within this process',async t=>{
  // Given an expired session and a refresh response held while parallel reads arrive.
  const {home,store}=await fixture(t);
  const second=await MarketplaceProfileStore.open(home);
  try {
    const gate=deferred(); const entered=deferred(); let refreshes=0; const authorization=[];
    globalThis.fetch=async(url,options)=>{
      if(String(url).endsWith('/refresh')) {refreshes++;entered.resolve();await gate.promise;return Response.json(rotated());}
      authorization.push(options.headers.authorization);return Response.json({ok:true});
    };
    const first=new MarketplaceApiClient(store,'agent').request('/v1/agent/profile');
    await entered.promise;
    // When independent clients read that same pinned session before rotation completes.
    const reads=[first,...Array.from({length:8},(_,i)=>new MarketplaceApiClient(i%2?store:second,'agent')
      .request('/v1/agent/profile'))];
    gate.resolve();
    const results=await Promise.allSettled(reads);
    // Then every read succeeds with the single committed rotated access token.
    assert.equal(refreshes,1);
    assert.ok(results.every(result=>result.status==='fulfilled'),JSON.stringify(results));
    assert.deepEqual(authorization,Array(9).fill('Bearer rotated-access-token'));
    assert.equal(store.getProfile('agent').refreshState,'READY');
  } finally {
    // Close every connection before the fixture's after hook removes its files on Windows.
    second.close();
  }
});

for(const outcome of ['denied','network','malformed']) test(`parallel refresh ${outcome} remains unknown without replay`,async t=>{
  // Given concurrent reads waiting on one refresh whose result cannot install a valid rotated pair.
  const {store}=await fixture(t);const gate=deferred();const entered=deferred();let refreshes=0;let reads=0;
  globalThis.fetch=async(url)=>{
    if(!String(url).endsWith('/refresh')) {reads++;return Response.json({});}
    refreshes++;entered.resolve();await gate.promise;
    if(outcome==='network') throw new Error('private transport diagnostic');
    return outcome==='denied'?Response.json({message:'private denial'},{status:401}):Response.json({accessToken:'private malformed'});
  };
  const api=new MarketplaceApiClient(store,'agent');const first=api.request('/v1/agent/profile');await entered.promise;
  // When the refresh fails after another caller joins it, then both fail closed and subsequent calls cannot resend it.
  const pending=Promise.allSettled([first,api.request('/v1/agent/profile')]);gate.resolve();
  const results=await pending;
  assert.deepEqual(results.map(result=>result.reason?.code),['REAUTH_REQUIRED','REAUTH_REQUIRED']);
  await assert.rejects(api.request('/v1/agent/profile'),{code:'REAUTH_REQUIRED'});
  assert.equal(refreshes,1);assert.equal(reads,0);assert.equal(store.getProfile('agent').refreshState,'UNKNOWN');
  assert.doesNotMatch(JSON.stringify(results),/private/);
});

test('refresh coordination stays isolated across homes, profiles, accounts and origins',async t=>{
  // Given separate profiles, including the same local profile ID in a different database/account/origin.
  const first=await fixture(t);const other=await fixture(t,{accountId:'44444444-4444-4444-8444-444444444444',origin:'https://other.example'});
  first.store.createProfile(profile({id:'other',accountId:'55555555-5555-4555-8555-555555555555'}));
  const gate=deferred();let refreshes=0;const entered=deferred();
  globalThis.fetch=async(url)=>{
    if(String(url).endsWith('/refresh')) {refreshes++;if(refreshes===3) entered.resolve();await gate.promise;return Response.json(rotated());}
    return Response.json({});
  };
  // When all independent sessions refresh concurrently, then each owns its own refresh request.
  const pending=Promise.all([new MarketplaceApiClient(first.store,'agent').request('/v1/agent/profile'),
    new MarketplaceApiClient(first.store,'other').request('/v1/agent/profile'),
    new MarketplaceApiClient(other.store,'agent').request('/v1/agent/profile')]);
  await entered.promise;gate.resolve();await pending;assert.equal(refreshes,3);
});

test('a revoked access token is denied without implicit refresh or credential recovery',async t=>{
  // Given an unexpired access token rejected by Marketplace.
  const {store}=await fixture(t,{accessExpiresAt:Date.now()+60_000});let requests=0;
  globalThis.fetch=async()=>{requests++;return Response.json({error:'revoked',message:'private diagnostic'},{status:401});};
  // When that token is used, then no refresh or alternate authority is attempted.
  await assert.rejects(new MarketplaceApiClient(store,'agent').request('/v1/agent/profile'),{code:'AUTHORIZATION_DENIED'});
  assert.equal(requests,1);assert.equal(store.getProfile('agent').refreshState,'READY');
});

test('a late shared refresh cannot replace credentials from an explicit local reauthentication',async t=>{
  // Given two readers sharing an old refresh while the terminal completes a new login.
  const {store}=await fixture(t);const gate=deferred();const entered=deferred();let refreshes=0;let reads=0;
  globalThis.fetch=async(url)=>{
    if(!String(url).endsWith('/refresh')) {reads++;return Response.json({});}
    refreshes++;entered.resolve();await gate.promise;return Response.json(rotated());
  };
  const api=new MarketplaceApiClient(store,'agent');const first=api.request('/v1/agent/profile');await entered.promise;
  const pending=Promise.allSettled([first,api.request('/v1/agent/profile')]);
  const payload='{"reauthenticate":true}';store.startReauthentication('agent',payload,null);
  assert.equal(store.transitionSetupState('agent','LOGIN_READY','LOGIN_SUBMITTING',payload,payload),true);
  store.completeReauthentication(profile({controllerIndex:0,accessToken:'new-login-access-token',refreshToken:'new-login-refresh-token',
    accessExpiresAt:Date.now()+60_000,refreshExpiresAt:Date.now()+120_000}),payload);
  // When the old refresh completes, then both readers reject it without overwriting or using the new login implicitly.
  gate.resolve();const results=await pending;
  assert.deepEqual(results.map(result=>result.reason?.code),['REAUTH_REQUIRED','REAUTH_REQUIRED']);
  assert.equal(refreshes,1);assert.equal(reads,0);
  assert.equal(store.getProfile('agent').accessToken,'new-login-access-token');
  assert.equal(store.getProfile('agent').refreshToken,'new-login-refresh-token');
  assert.equal(store.getProfile('agent').refreshState,'READY');
  // A later, explicit read uses the committed login rather than retaining a failed promise.
  await api.request('/v1/agent/profile');assert.equal(reads,1);assert.equal(refreshes,1);
});
