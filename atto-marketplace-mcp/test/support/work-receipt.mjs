import {createHash, generateKeyPairSync, sign} from 'node:crypto';

export function signedReceipt(version=2, rate=100) {
  const fields=['schema','keyVersion','receiptId','taskId','engagementId','buyerAgentId','workerAgentId',
    'buyerRole','workerRole','category','buyerHandle','buyerDisplayName','workerHandle','workerDisplayName',
    'asset','grossAtomic','feeAtomic','workerNetAtomic','refundAtomic','outcome','submissionHash',
    'ledgerTransactionId','engagementCreatedAt','settledAt',...(version===2?['feeRateBasisPoints']:[])];
  const content={schema:`marketplace-work-receipt-v${version}`,keyVersion:'test-v1',
    receiptId:'66666666-6666-4666-8666-666666666666',taskId:'77777777-7777-4777-8777-777777777777',
    engagementId:'77777777-7777-4777-8777-777777777777',buyerAgentId:'11111111-1111-4111-8111-111111111111',
    workerAgentId:'22222222-2222-4222-8222-222222222222',buyerRole:'BUYER',workerRole:'WORKER',
    category:'general',buyerHandle:'buyer',buyerDisplayName:'Buyer',workerHandle:'worker',workerDisplayName:'Worker',
    asset:'ATTO',grossAtomic:'100',feeAtomic:String(rate/100),workerNetAtomic:String(100-rate/100),
    refundAtomic:'0',outcome:'ACCEPTED',submissionHash:'a'.repeat(64),
    ledgerTransactionId:'88888888-8888-4888-8888-888888888888',
    engagementCreatedAt:'2026-09-26T09:00:00Z',settledAt:'2026-09-26T10:00:00Z',
    ...(version===2?{feeRateBasisPoints:String(rate)}:{})};
  const canonical=Buffer.concat(fields.map(field=>{
    const bytes=Buffer.from(content[field]); const length=Buffer.alloc(4);length.writeUInt32BE(bytes.length);
    return Buffer.concat([length,bytes]);
  }));
  const digest=createHash('sha256').update(canonical).digest();
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const key={version:'test-v1',algorithm:'Ed25519',publicKeyBase64:publicKey.export({format:'der',type:'spki'}).toString('base64')};
  const receipt={receiptId:content.receiptId,taskId:content.taskId,outcome:content.outcome,content,
    canonicalBase64:canonical.toString('base64'),contentSha256:digest.toString('hex'),
    signatureBase64:sign(null,Buffer.concat([Buffer.from(`marketplace-work-receipt-signature-v${version}\0`),digest]),privateKey).toString('base64'),
    keyVersion:key.version,ledgerTransactionId:content.ledgerTransactionId,createdAt:content.settledAt};
  return {receipt,key};
}
