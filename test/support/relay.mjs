export const paymentId='11111111-1111-4111-8111-111111111111';
export const accountId='22222222-2222-4222-8222-222222222222';
export function offer(terms,origin='https://marketplace.example',now=Date.now()) {
  return Buffer.from(JSON.stringify({x402Version:2,resource:{url:`${origin}/v1/agent/payments/${terms.paymentId}`,description:'Marketplace payment',mimeType:'application/json'},
    accepts:[{scheme:'exact',network:terms.network,asset:terms.asset==='ATTO'?'atto':'XNO',amount:terms.amountAtomic,payTo:terms.recipientAddress,
      maxTimeoutSeconds:terms.asset==='ATTO'?60:300,...(terms.asset==='ATTO'?{extra:{assetTransferMethod:'native',paymentFlow:'authorization'}}:{})}],
    extensions:{'payment-identifier':{info:{required:true},schema:{type:'object',required:['required','id'],properties:{required:{const:true},id:{type:'string',minLength:16,maxLength:128}}}},
      'marketplace-binding':{info:{required:true,version:1,...terms,offerExpiresAt:new Date(now+300000).toISOString()},schema:{type:'object',required:['info','proof'],properties:{info:{type:'object'},proof:{type:'object',required:['challengeId','message','signature']}}}}}})).toString('base64');
}
export function terms(asset,senderAddress,recipientAddress,amountAtomic='40') {return {paymentId,purpose:'SHOP_ORDER',sourceReference:'order',ownerAccountId:accountId,
  asset,network:asset==='ATTO'?'atto:local':'nano:dev',senderAddress,recipientAddress,amountAtomic,termsHash:'a'.repeat(64),versionHash:'b'.repeat(64),baselineHeight:'3',baselineFrontier:'1'.repeat(64)};}
export function challenge(terms,hash,binding,audience='marketplace',now=Date.now()) {
  const issuedAt=new Date(now).toISOString(),expiresAt=new Date(now+120000).toISOString();
  return {challengeId:paymentId,issuedAt,expiresAt,message:[`${terms.asset==='ATTO'?'':'Nano '}Marketplace Agent Controller Proof v1`,`Audience: ${audience}`,
    `Network: ${terms.asset==='ATTO'?'live':terms.network}`,`Address: ${terms.senderAddress}`,'Purpose: payment evidence',`Request ID: ${paymentId}`,
    `Binding Hash: ${binding(terms,hash)}`,`Nonce: ${'e'.repeat(64)}`,`Issued At: ${issuedAt}`,`Expiration Time: ${expiresAt}`].join('\n')};
}
