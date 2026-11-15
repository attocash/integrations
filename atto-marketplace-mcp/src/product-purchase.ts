import { createHash, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { MarketplaceApiError } from './marketplace-api.js';

const uuid=z.string().uuid();
const hash=z.string().regex(/^[0-9a-f]{64}$/);
const atomic=z.string().regex(/^(0|[1-9][0-9]{0,64})$/);
const instant=z.string().datetime({offset:true});
export const productPurchaseResult=z.object({
  purchaseId:uuid,productId:uuid,releaseId:uuid,releaseHash:hash,manifestHash:hash,buyerAgentId:uuid,sellerAgentId:uuid,
  asset:z.enum(['ATTO','XNO']),grossAtomic:atomic,status:z.enum(['RESERVED','EXPIRED','PAYMENT_PENDING','ACTIVE','PAID_UNFULFILLED','REFUNDED']),
  version:z.number().int().nonnegative(),entitlementActive:z.boolean(),paymentRequirementId:uuid,reservationExpiresAt:instant,
  receiptId:uuid.nullable(),receiptHash:hash.nullable(),createdAt:instant,refundedAt:instant.nullable(),refundReceiptId:uuid.nullable(),
  refundReceiptHash:hash.nullable(),refundPaymentRequirementId:uuid.nullable(),paidTransactionHash:hash.nullable(),
}).refine(p=>BigInt(p.grossAtomic)>0n && p.entitlementActive===(p.status==='ACTIVE'));
export type ProductPurchaseResult=z.infer<typeof productPurchaseResult>;
export const productSellerOrder=z.strictObject({purchaseId:uuid,buyerAgentId:uuid,releaseId:uuid,
  status:z.enum(['RESERVED','EXPIRED','PAYMENT_PENDING','ACTIVE','PAID_UNFULFILLED','REFUNDED']),createdAt:instant,refundedAt:instant.nullable()});
export const productPaidContent=z.strictObject({purchaseId:uuid,releaseId:uuid,
  paidMarkdown:z.string().max(40_000).nullable(),licenseText:z.string().max(16_000),manifestHash:hash,
  files:z.array(z.strictObject({ordinal:z.number().int().nonnegative(),fileId:uuid,contentVersionId:uuid,
    filename:z.string().min(1).max(255),byteLength:z.number().int().min(1).max(104_857_600),
    mediaType:z.string().min(1).max(255),sha256:hash})).max(10)}).refine(value=>value.files.every((file,index)=>file.ordinal===index));
export const productReceipt=z.strictObject({receiptId:uuid,kind:z.enum(['PURCHASE','REFUND']),
  content:z.record(z.string(),z.string()),canonicalBase64:z.string().min(1).max(500_000),
  contentSha256:hash,signatureBase64:z.string().min(1).max(128),keyVersion:z.string().min(1).max(64)});
export type ProductReceipt=z.infer<typeof productReceipt>;

export function verifyProductReceipt(receipt:ProductReceipt,key:{version:string;algorithm:string;publicKeyBase64:string},purchase:ProductPurchaseResult):void {
  try {
    const kind=receipt.kind.toLowerCase();
    if(key.version!==receipt.keyVersion || key.algorithm!=='Ed25519') throw invalid();
    const bytes=decodeBase64(receipt.canonicalBase64,500000);
    const c=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as Record<string,string>;
    if(!c || Array.isArray(c) || Object.keys(c).length!==Object.keys(receipt.content).length
      || Object.keys(c).some(k=>typeof c[k]!=='string'||c[k]!==receipt.content[k])
      || c.schema!==`marketplace-product-${kind}-receipt-v2` || c.receiptId!==receipt.receiptId
      || c.purchaseId!==purchase.purchaseId || c.productId!==purchase.productId || c.releaseId!==purchase.releaseId
      || c.releaseHash!==purchase.releaseHash || c.manifestHash!==purchase.manifestHash || c.asset!==purchase.asset
      || c.amountAtomic!==purchase.grossAtomic || c.buyerAgentId!==purchase.buyerAgentId || c.sellerAgentId!==purchase.sellerAgentId
      || c.paymentRequirementId!==(receipt.kind==='PURCHASE'?purchase.paymentRequirementId:purchase.refundPaymentRequirementId)
      || receipt.receiptId!==(receipt.kind==='PURCHASE'?purchase.receiptId:purchase.refundReceiptId)
      || receipt.contentSha256!==(receipt.kind==='PURCHASE'?purchase.receiptHash:purchase.refundReceiptHash)
      || !/^[a-f0-9]{64}$/i.test(c.transactionHash??'') || !c.senderAddress || !c.recipientAddress) throw invalid();
    const digest=createHash('sha256').update(bytes).digest();
    if(digest.toString('hex')!==receipt.contentSha256) throw invalid();
    const publicKey=createPublicKey({key:decodeBase64(key.publicKeyBase64,256),format:'der',type:'spki'});
    if(!verify(null,Buffer.concat([Buffer.from(`marketplace-product-${kind}-v2\0`),digest]),publicKey,decodeBase64(receipt.signatureBase64,128))) throw invalid();
  } catch { throw invalid(); }
}

function decodeBase64(value:string,max:number):Buffer {
  if (value.length>max || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw invalid();
  return Buffer.from(value,'base64');
}
function invalid():MarketplaceApiError { return new MarketplaceApiError('RECEIPT_INVALID','Product receipt signature, canonical content or settlement terms do not match.'); }
