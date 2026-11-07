import assert from 'node:assert/strict';
import test from 'node:test';
import {MarketplaceApiClient} from '../dist/marketplace-api.js';

test('public product error codes survive without arbitrary backend diagnostics',async t=>{
  // Given trusted product status/code pairs mixed with private response fields and unsupported codes.
  const originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;});
  const api=new MarketplaceApiClient({getProfile:()=>({id:'agent',origin:'https://marketplace.example',authMode:'scoped-api-key',apiKey:'private-key'})},'agent');
  for(const scenario of [
    {status:409,code:'product_conflict',expected:'PRODUCT_CONFLICT'},
    {status:503,code:'product_publication_price_unavailable',expected:'PRODUCT_PUBLICATION_PRICE_UNAVAILABLE'},
    {status:409,code:'product_publication_insufficient_funds',expected:'PRODUCT_PUBLICATION_INSUFFICIENT_FUNDS'},
    {status:409,code:'product_idempotency_conflict',expected:'PRODUCT_IDEMPOTENCY_CONFLICT'},
    {status:400,code:'product_conflict',expected:'MARKETPLACE_HTTP'},
    {status:401,code:'product_conflict',expected:'AUTHORIZATION_DENIED'},
    {status:503,code:'private-code',expected:'MARKETPLACE_HTTP'},
    {status:503,code:'product_publication_price_unavailable'+'x'.repeat(10000),expected:'MARKETPLACE_HTTP'},
  ]) {
    globalThis.fetch=async()=>Response.json({error:scenario.code,message:'private-secret',details:{token:'private-token'}},{status:scenario.status});
    // When a product operation fails, then only allowlisted bounded metadata is exposed.
    const error=await api.request('/v1/agent/products/11111111-1111-4111-8111-111111111111/publish',{method:'POST',body:{}}).catch(error=>error);
    assert.equal(error.code,scenario.expected);assert.equal(error.httpStatus,scenario.status);
    assert.doesNotMatch(JSON.stringify({message:error.message,details:error.details}),/private-/);
    if(scenario.expected.startsWith('PRODUCT_')) assert.equal(error.details.serverCode,scenario.code);
  }
});
