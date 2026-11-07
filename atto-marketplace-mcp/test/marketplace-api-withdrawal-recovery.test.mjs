import assert from 'node:assert/strict';
import test from 'node:test';
import {MarketplaceApiClient,commandPointerFromError} from '../dist/marketplace-api.js';

const commandId='98989898-9898-4898-8898-989898989898';
const statusUrl=`/v1/agent/commands/${commandId}`;
const makeApi=()=>new MarketplaceApiClient({getProfile:()=>({id:'agent',origin:'https://marketplace.example',
  authMode:'scoped-api-key',apiKey:'test-private-key'})},'agent');

test('withdrawal non-2xx command pointer retains only fixed diagnostics and exact recovery identity',async t=>{
  const originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;});
  for(const status of [409,503]) {
    globalThis.fetch=async()=>Response.json({error:'private-code',message:'private-proof-message',token:'private-token'},
      {status,headers:{Location:statusUrl}});
    const error=await makeApi().request('/v1/agent/withdrawals',{method:'POST',body:{}}).catch(error=>error);
    assert.equal(error.code,'COMMAND_UNRESOLVED');
    assert.equal(error.httpStatus,status);
    assert.deepEqual(commandPointerFromError(error),{commandId,statusUrl});
    assert.doesNotMatch(JSON.stringify({message:error.message,code:error.code,details:error.details}),/private-/);
    assert.equal(error.details.terminal,undefined,'HTTP status does not prove a terminal command outcome');
  }
});

test('withdrawal pointer preservation excludes queries, other paths, other methods and authorization denials',async t=>{
  const originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;});
  for(const scenario of [
    {path:'/v1/agent/withdrawals?network=atto%3Adev',method:'POST',status:409},
    {path:'/v1/agent/withdrawals/',method:'POST',status:409},
    {path:'/v1/agent/withdrawals/challenges',method:'POST',status:409},
    {path:'/v1/agent/withdrawals',method:'GET',status:409},
    {path:'/v1/agent/withdrawals',method:'PATCH',status:409},
    {path:'/v1/agent/withdrawals',method:'POST',status:401},
    {path:'/v1/agent/withdrawals',method:'POST',status:403},
  ]) {
    globalThis.fetch=async()=>Response.json({error:'private-code',message:'private-token'},
      {status:scenario.status,headers:{Location:statusUrl}});
    const error=await makeApi().request(scenario.path,{method:scenario.method}).catch(error=>error);
    assert.equal(commandPointerFromError(error),undefined,JSON.stringify(scenario));
    assert.equal(error.details?.terminal,undefined);
  }
});

test('withdrawal unsafe relative or foreign command pointers fail closed',async t=>{
  const originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;});
  for(const location of [
    'https://evil.example'+statusUrl,'//evil.example'+statusUrl,statusUrl+'?x=1',statusUrl+'#fragment',
    '/v1/agent/withdrawals/'+commandId,'/v1/agent/commands/not-a-uuid',
  ]) {
    globalThis.fetch=async()=>Response.json({}, {status:409,headers:{Location:location}});
    const error=await makeApi().request('/v1/agent/withdrawals',{method:'POST'}).catch(error=>error);
    assert.equal(error.code,'COMMAND_PROTOCOL');
    assert.equal(commandPointerFromError(error),undefined);
  }
});
