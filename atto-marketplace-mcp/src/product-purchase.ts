import { createHash, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { MarketplaceApiError } from './marketplace-api.js';

const uuid=z.string().uuid();
const hash=z.string().regex(/^[0-9a-f]{64}$/);
const atomic=z.string().regex(/^(0|[1-9][0-9]{0,64})$/);
const instant=z.string().datetime({offset:true});
export const productPurchaseResult=z.strictObject({
  purchaseId:uuid,commandId:uuid,productId:uuid,releaseId:uuid,releaseHash:hash,manifestHash:hash,
  buyerAgentId:uuid,sellerAgentId:uuid,asset:z.enum(['ATTO','XNO']),grossAtomic:atomic,feeAtomic:atomic,
  netAtomic:atomic,feeRateBasisPoints:z.number().int().min(0).max(10_000),status:z.enum(['ACTIVE','REFUNDED']),
  version:z.number().int().nonnegative(),entitlementActive:z.boolean(),receiptId:uuid,receiptHash:hash,
  createdAt:instant,refundedAt:instant.nullable(),refundReceiptId:uuid.nullable(),
  refundReceiptHash:hash.nullable(),refundCommandId:uuid.nullable(),
}).superRefine((value,context)=>{
  if (BigInt(value.grossAtomic)<=0n || BigInt(value.grossAtomic)!==BigInt(value.feeAtomic)+BigInt(value.netAtomic)
    || value.entitlementActive!==(value.status==='ACTIVE')
    || (value.status==='ACTIVE' && [value.refundedAt,value.refundReceiptId,value.refundReceiptHash,value.refundCommandId].some(item=>item!==null))
    || (value.status==='REFUNDED' && [value.refundedAt,value.refundReceiptId,value.refundReceiptHash,value.refundCommandId].some(item=>item===null))) {
    context.addIssue({code:'custom',message:'Inconsistent product settlement'});
  }
});
export type ProductPurchaseResult=z.infer<typeof productPurchaseResult>;
export const productSellerOrder=z.strictObject({purchaseId:uuid,buyerAgentId:uuid,releaseId:uuid,
  status:z.enum(['ACTIVE','REFUNDED']),createdAt:instant,refundedAt:instant.nullable()});
export const productPurchaseChallenge=z.strictObject({releaseId:uuid,releaseHash:hash,sellerAgentId:uuid,
  asset:z.enum(['ATTO','XNO']),grossAtomic:atomic,feeAtomic:atomic,netAtomic:atomic,
  challenge:z.strictObject({challengeId:uuid,message:z.string().min(1).max(4096),issuedAt:instant,expiresAt:instant})});
export const productRefundChallenge=z.strictObject({purchaseId:uuid,authority:z.literal('SELLER'),
  buyerAgentId:uuid,sellerAgentId:uuid,asset:z.enum(['ATTO','XNO']),grossAtomic:atomic,feeAtomic:atomic,
  netAtomic:atomic,originalPurchaseReceiptHash:hash,
  challenge:z.strictObject({challengeId:uuid,message:z.string().min(1).max(4096),issuedAt:instant,expiresAt:instant})});
export const productPaidContent=z.strictObject({purchaseId:uuid,releaseId:uuid,
  paidMarkdown:z.string().max(40_000).nullable(),licenseText:z.string().max(16_000),manifestHash:hash,
  files:z.array(z.strictObject({ordinal:z.number().int().nonnegative(),fileId:uuid,contentVersionId:uuid,
    filename:z.string().min(1).max(255),byteLength:z.number().int().min(1).max(104_857_600),
    mediaType:z.string().min(1).max(255),sha256:hash})).max(10)}).refine(value=>value.files.every((file,index)=>file.ordinal===index));
export const productReceipt=z.strictObject({receiptId:uuid,kind:z.enum(['PURCHASE','REFUND']),
  content:z.record(z.string(),z.string()),canonicalBase64:z.string().min(1).max(500_000),
  contentSha256:hash,signatureBase64:z.string().min(1).max(128),keyVersion:z.string().min(1).max(64)});
export type ProductReceipt=z.infer<typeof productReceipt>;

const common=['schema','keyVersion','receiptId','purchaseId','buyerAccountId','buyerAgentId',
  'sellerAccountId','sellerAgentId','productId','releaseId','releaseHash','manifestHash','asset',
  'grossAtomic','feeAtomic','netAtomic','feeRateBasisPoints','commandId','ledgerTransactionId',
  'outcome','createdAt','settledAt'];
const refund=['originalPurchaseReceiptId','originalPurchaseReceiptHash',
  'originalPurchaseLedgerTransactionId','authority','actorAccountId','actorIdentityId'];

export function verifyProductReceipt(receipt:ProductReceipt,
  key:{version:string;algorithm:string;publicKeyBase64:string},purchase:ProductPurchaseResult):void {
  try {
    const isRefund=receipt.kind==='REFUND';
    const fields=isRefund?[...common,...refund]:common;
    const schema=`marketplace-product-${isRefund?'refund':'purchase'}-receipt-v1`;
    const domain=`marketplace-product-${isRefund?'refund':'purchase'}-receipt-signature-v1\0`;
    if (key.version!==receipt.keyVersion || key.algorithm!=='Ed25519'
      || Object.keys(receipt.content).length!==fields.length
      || Object.keys(receipt.content).some(field=>!fields.includes(field))) throw invalid();
    const bytes=decodeBase64(receipt.canonicalBase64,500_000);
    const content:Record<string,string>={};
    let offset=0;
    for (const field of fields) {
      if (offset+4>bytes.length) throw invalid();
      const length=bytes.readUInt32BE(offset); offset+=4;
      if (length>16_384 || offset+length>bytes.length) throw invalid();
      content[field]=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(offset,offset+length));
      offset+=length;
      if (content[field]!==receipt.content[field]) throw invalid();
    }
    if (offset!==bytes.length || content.schema!==schema || content.keyVersion!==key.version
      || content.receiptId!==receipt.receiptId || content.purchaseId!==purchase.purchaseId
      || content.productId!==purchase.productId || content.releaseId!==purchase.releaseId
      || content.releaseHash!==purchase.releaseHash || content.manifestHash!==purchase.manifestHash
      || content.buyerAgentId!==purchase.buyerAgentId || content.sellerAgentId!==purchase.sellerAgentId
      || content.asset!==purchase.asset || content.grossAtomic!==purchase.grossAtomic
      || content.feeAtomic!==purchase.feeAtomic || content.netAtomic!==purchase.netAtomic
      || content.feeRateBasisPoints!==String(purchase.feeRateBasisPoints)
      || content.commandId!==(isRefund?purchase.refundCommandId:purchase.commandId)
      || content.outcome!==(isRefund?'REFUNDED':'PURCHASED')
      || !Number.isFinite(Date.parse(content.createdAt??''))
      || !Number.isFinite(Date.parse(content.settledAt??''))) throw invalid();
    if (isRefund) {
      if (receipt.receiptId!==purchase.refundReceiptId || receipt.contentSha256!==purchase.refundReceiptHash
        || content.originalPurchaseReceiptId!==purchase.receiptId
        || content.originalPurchaseReceiptHash!==purchase.receiptHash
        || !['SELLER','ADMIN'].includes(content.authority??'')) throw invalid();
    } else if (receipt.receiptId!==purchase.receiptId || receipt.contentSha256!==purchase.receiptHash) throw invalid();
    const digest=createHash('sha256').update(bytes).digest();
    if (digest.toString('hex')!==receipt.contentSha256) throw invalid();
    const publicKey=createPublicKey({key:decodeBase64(key.publicKeyBase64,256),format:'der',type:'spki'});
    if (!verify(null,Buffer.concat([Buffer.from(domain),digest]),publicKey,
      decodeBase64(receipt.signatureBase64,128))) throw invalid();
  } catch { throw invalid(); }
}

function decodeBase64(value:string,max:number):Buffer {
  if (value.length>max || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw invalid();
  return Buffer.from(value,'base64');
}
function invalid():MarketplaceApiError { return new MarketplaceApiError('RECEIPT_INVALID','Product receipt signature, canonical content or settlement terms do not match.'); }
