import { createHash, createPublicKey, verify } from 'node:crypto';
import { MarketplaceApiError } from './marketplace-api.js';

const v2Fields = ['schema','keyVersion','receiptId','taskId','engagementId','buyerAgentId','workerAgentId',
  'buyerRole','workerRole','category','buyerHandle','buyerDisplayName','workerHandle','workerDisplayName',
  'asset','grossAtomic','feeAtomic','workerNetAtomic','refundAtomic','outcome','submissionHash',
  'ledgerTransactionId','engagementCreatedAt','settledAt','feeRateBasisPoints'];

interface Receipt {
  receiptId:string; taskId:string; outcome:string; content:Record<string,string>; canonicalBase64:string;
  contentSha256:string; signatureBase64:string; keyVersion:string; ledgerTransactionId:string;
}

/** Verify the canonical payload, its JSON projection and the committed economic terms. */
export function verifyWorkReceipt(receipt:Receipt, key:{version:string;algorithm:string;publicKeyBase64:string}, taskId:string):void {
  try {
    if (receipt.taskId !== taskId || key.version !== receipt.keyVersion || key.algorithm !== 'Ed25519') throw invalid();
    const canonical = decodeBase64(receipt.canonicalBase64);
    let offset = 0;
    const read = ():string => {
      if (offset+4 > canonical.length) throw invalid();
      const length=canonical.readUInt32BE(offset); offset+=4;
      if (length>16_384 || offset+length>canonical.length) throw invalid();
      const value=new TextDecoder('utf-8',{fatal:true}).decode(canonical.subarray(offset,offset+length));
      offset+=length; return value;
    };
    const schema=read();
    if (schema!=='marketplace-work-receipt-v2') throw invalid();
    const fields=v2Fields;
    const content:Record<string,string>={schema};
    for (const field of fields.slice(1)) content[field]=read();
    if (offset!==canonical.length || Object.keys(receipt.content).length!==fields.length
      || fields.some(field=>content[field]!==receipt.content[field]) || content.taskId!==taskId
      || content.engagementId!==taskId || content.receiptId!==receipt.receiptId
      || content.keyVersion!==receipt.keyVersion || content.outcome!==receipt.outcome
      || content.ledgerTransactionId!==receipt.ledgerTransactionId || !['ATTO','XNO'].includes(content.asset!)) throw invalid();
    const digest=createHash('sha256').update(canonical).digest();
    if (digest.toString('hex')!==receipt.contentSha256) throw invalid();
    const message=Buffer.concat([Buffer.from('marketplace-work-receipt-signature-v2\0'),digest]);
    const publicKey=createPublicKey({key:decodeBase64(key.publicKeyBase64),format:'der',type:'spki'});
    if (!verify(null,message,publicKey,decodeBase64(receipt.signatureBase64))) throw invalid();
    for (const field of ['grossAtomic','feeAtomic','workerNetAtomic','refundAtomic']) {
      if (!/^(0|[1-9][0-9]{0,64})$/.test(content[field]!)) throw invalid();
    }
    const rate=content.feeRateBasisPoints;
    if (rate!=='100') throw invalid();
    const gross=BigInt(content.grossAtomic!),fee=BigInt(content.feeAtomic!),net=BigInt(content.workerNetAtomic!),refund=BigInt(content.refundAtomic!);
    if (gross<=0n) throw invalid();
    if (content.outcome==='BUYER_REFUND') {
      if (refund!==gross || fee!==0n || net!==0n) throw invalid();
    } else if (!['ACCEPTED','WORKER_AWARD'].includes(content.outcome!)
      || fee!==gross*BigInt(rate)/10_000n || net!==gross-fee || refund!==0n) throw invalid();
  } catch { throw invalid(); }
}

function decodeBase64(value:string):Buffer {
  if (value.length>700_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw invalid();
  return Buffer.from(value,'base64');
}
function invalid():MarketplaceApiError {
  return new MarketplaceApiError('RECEIPT_INVALID','Receipt signature, content or accounting does not match.');
}
