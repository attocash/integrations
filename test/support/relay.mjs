import { createHash } from 'node:crypto';

export const paymentId='11111111-1111-4111-8111-111111111111';
export const accountId='22222222-2222-4222-8222-222222222222';
export function offer(terms,origin='https://marketplace.example') {
  return Buffer.from(JSON.stringify({x402Version:2,resource:{url:`${origin}/v1/agent/payments/${terms.paymentId}`,description:'Marketplace payment',mimeType:'application/json'},
    accepts:[{scheme:'exact',network:terms.network,asset:terms.asset==='ATTO'?'atto':'XNO',amount:terms.amountAtomic,payTo:terms.recipientAddress,
      maxTimeoutSeconds:terms.asset==='ATTO'?60:300,...(terms.asset==='ATTO'?{extra:{assetTransferMethod:'native',paymentFlow:'authorization'}}:{})}],
    extensions:{'payment-identifier':{info:{required:true},schema:{$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',
      properties:{required:{type:'boolean'},id:{type:'string',minLength:16,maxLength:128,pattern:'^[a-zA-Z0-9_-]+$'}},required:['required']}}}})).toString('base64');
}

export function legacyOffer(terms,origin='https://marketplace.example',now=Date.now()) {
  const raw=JSON.parse(Buffer.from(offer(terms,origin),'base64'));
  raw.extensions['payment-identifier'].schema={type:'object',required:['required','id'],properties:{required:{const:true},id:{type:'string',minLength:16,maxLength:128}}};
  raw.extensions['marketplace-binding']={info:{required:true,version:1,...terms,offerExpiresAt:new Date(now+300000).toISOString()},
    schema:{type:'object',required:['info','proof'],properties:{info:{type:'object'},proof:{type:'object',required:['challengeId','message','signature']}}}};
  return Buffer.from(JSON.stringify(raw)).toString('base64');
}

export function legacyHeader(request, payload, proof) {
  const raw=JSON.parse(Buffer.from(request.paymentRequired,'base64'));
  raw.extensions['payment-identifier'].info.id=request.requestId;
  raw.extensions['marketplace-binding'].proof=proof;
  return Buffer.from(JSON.stringify({x402Version:2,resource:raw.resource,accepted:raw.accepts[0],payload,extensions:raw.extensions})).toString('base64');
}
export function terms(asset,senderAddress,recipientAddress,amountAtomic='40') {return {paymentId,purpose:'SHOP_ORDER',sourceReference:'order',ownerAccountId:accountId,
  asset,network:asset==='ATTO'?'atto:local':'nano:dev',senderAddress,recipientAddress,amountAtomic,termsHash:'a'.repeat(64),versionHash:'b'.repeat(64),baselineHeight:'3',baselineFrontier:'1'.repeat(64)};}
export function legacyChallenge(terms,hash,audience='marketplace',now=Date.now()) {
  const binding=createHash('sha256').update(['Marketplace payment evidence v1',terms.paymentId,terms.versionHash,terms.termsHash,
    terms.ownerAccountId,terms.network,terms.senderAddress,terms.recipientAddress,terms.amountAtomic,hash.toLowerCase()].join('\n')).digest('hex');
  const issuedAt=new Date(now).toISOString(),expiresAt=new Date(now+120000).toISOString();
  return {challengeId:paymentId,issuedAt,expiresAt,message:[`${terms.asset==='ATTO'?'':'Nano '}Marketplace Agent Controller Proof v1`,`Audience: ${audience}`,
    `Network: ${terms.asset==='ATTO'?'live':terms.network}`,`Address: ${terms.senderAddress}`,'Purpose: payment evidence',`Request ID: ${paymentId}`,
    `Binding Hash: ${binding}`,`Nonce: ${'e'.repeat(64)}`,`Issued At: ${issuedAt}`,`Expiration Time: ${expiresAt}`].join('\n')};
}
