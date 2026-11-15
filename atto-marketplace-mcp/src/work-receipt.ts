import { createHash, createPublicKey, verify } from 'node:crypto';
import { MarketplaceApiError } from './marketplace-api.js';

interface Receipt {receiptId:string;taskId:string;outcome:string;content:Record<string,string>;canonicalBase64:string;contentSha256:string;signatureBase64:string;keyVersion:string;paymentRequirementId:string}
export function verifyWorkReceipt(receipt:Receipt,key:{version:string;algorithm:string;publicKeyBase64:string},taskId:string):void {
  try {
    if(receipt.taskId!==taskId || key.version!==receipt.keyVersion || key.algorithm!=='Ed25519') throw invalid();
    const canonical=decodeBase64(receipt.canonicalBase64);
    const c=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(canonical)) as Record<string,string>;
    if(!c || Array.isArray(c) || Object.keys(c).length!==Object.keys(receipt.content).length || Object.keys(c).some(k=>typeof c[k]!=='string'||c[k]!==receipt.content[k])
      || c.schema!=='marketplace-work-receipt-v3' || c.taskId!==taskId || c.receiptId!==receipt.receiptId || c.outcome!==receipt.outcome
      || !/^[1-9][0-9]{0,64}$/.test(c.grossAtomic??'') || !(c.asset==='ATTO'?c.feeRateBasisPoints==='100':c.asset==='XNO'&&c.feeRateBasisPoints==='500')) throw invalid();
    const milestones=JSON.parse(c.milestones??'null') as Array<{state:string;amountAtomic:string;paidTransactionHash:string}>;
    if(!Array.isArray(milestones)||!milestones.length||milestones.some(m=>m.state!=='PAID'||!/^[1-9][0-9]{0,64}$/.test(m.amountAtomic)||!/^[a-f0-9]{64}$/i.test(m.paidTransactionHash))
      ||milestones.reduce((sum,m)=>sum+BigInt(m.amountAtomic),0n)!==BigInt(c.grossAtomic!)) throw invalid();
    if(JSON.stringify(Object.fromEntries(Object.entries(c).sort(([a],[b])=>a.localeCompare(b))))!==canonical.toString('utf8')) throw invalid();
    const digest=createHash('sha256').update(canonical).digest();
    if(digest.toString('hex')!==receipt.contentSha256) throw invalid();
    const publicKey=createPublicKey({key:decodeBase64(key.publicKeyBase64),format:'der',type:'spki'});
    if(!verify(null,Buffer.concat([Buffer.from('marketplace-work-receipt-v3\0'),digest]),publicKey,decodeBase64(receipt.signatureBase64))) throw invalid();
  } catch { throw invalid(); }
}

function decodeBase64(value:string):Buffer {
  if (value.length>700_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw invalid();
  return Buffer.from(value,'base64');
}
function invalid():MarketplaceApiError {
  return new MarketplaceApiError('RECEIPT_INVALID','Receipt signature, content or accounting does not match.');
}
