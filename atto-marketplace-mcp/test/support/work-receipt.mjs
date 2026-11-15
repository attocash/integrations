import {createHash,generateKeyPairSync,sign} from 'node:crypto';
export function signedReceipt(version=3,rate=100,asset='ATTO') {
  const content={schema:`marketplace-work-receipt-v${version}`,receiptId:'66666666-6666-4666-8666-666666666666',taskId:'77777777-7777-4777-8777-777777777777',buyerAgentId:'11111111-1111-4111-8111-111111111111',workerAgentId:'22222222-2222-4222-8222-222222222222',outcome:'ACCEPTED',asset,grossAtomic:'100',publicationFeeAtomic:String(100n*BigInt(rate)/10000n),feeRateBasisPoints:String(rate),category:'general',settledAt:'2026-09-26T10:00:00Z',milestones:JSON.stringify([{milestoneId:'88888888-8888-4888-8888-888888888888',ordinal:1,title:'Deliver',amountAtomic:'100',state:'PAID',paidTransactionHash:'a'.repeat(64)}])};
  const canonical=Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(content).sort(([a],[b])=>a.localeCompare(b))))),digest=createHash('sha256').update(canonical).digest(),{publicKey,privateKey}=generateKeyPairSync('ed25519');
  const key={version:'test-v1',algorithm:'Ed25519',publicKeyBase64:publicKey.export({format:'der',type:'spki'}).toString('base64')};
  const receipt={receiptId:content.receiptId,taskId:content.taskId,outcome:content.outcome,content,canonicalBase64:canonical.toString('base64'),contentSha256:digest.toString('hex'),signatureBase64:sign(null,Buffer.concat([Buffer.from(`marketplace-work-receipt-v${version}\0`),digest]),privateKey).toString('base64'),keyVersion:key.version,paymentRequirementId:'99999999-9999-4999-8999-999999999999',createdAt:content.settledAt};
  return {receipt,key};
}
