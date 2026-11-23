import { parseRelayOffer, decodePaymentHeader, relayEvidenceBinding, validateRelayChallenge, validateRelayProof, relayProofFromHeader, relayPaymentPayload, type RelayTerms, type RelayOffer } from '@attocash/cli/internal-marketplace';
import { z } from 'zod';
import { MarketplaceApiClient, MarketplaceApiError, type ApiResponse } from './marketplace-api.js';
import type { MarketplaceProfile } from './profile-store.js';
import type { NanoWorkProvider } from '@attocash/atto-marketplace-nano-adapter';
import { callWallet } from './wallet-process.js';
const hash=z.string().regex(/^[a-fA-F0-9]{64}$/);
const requirement=z.object({id:z.string().uuid(),purpose:z.enum(['PUBLICATION_FEE','SHOP_ORDER','TASK_MILESTONE','BUYER_REFUND']),
  sourceReference:z.string(),ownerAccountId:z.string().uuid(),asset:z.enum(['ATTO','XNO']),network:z.string(),
  senderAddress:z.string().min(1).max(160),recipientAddress:z.string().min(1).max(160),amountAtomic:z.string().regex(/^[1-9][0-9]{0,64}$/),
  termsHash:hash,versionHash:hash,baselineHeight:z.number().int().nonnegative(),baselineFrontier:hash.nullable(),
  status:z.enum(['AWAITING_PAYMENT','PENDING','VERIFIED']),verifiedPayment:z.object({network:z.string(),transactionHash:hash,
    senderAddress:z.string(),recipientAddress:z.string(),amountAtomic:z.string(),senderHeight:z.number().int(),previousHash:hash}).nullable(),
  submissions:z.array(z.object({requestId:z.string(),transactionHash:hash,status:z.enum(['PENDING','REJECTED','VERIFIED']),reason:z.string().nullable()})),
  relay:z.object({requestId:z.string().min(16).max(128),transactionHash:hash,attempted:z.boolean(),status:z.string(),reason:z.string().nullable()}).nullable(),
});
export type PaymentRequirement=z.infer<typeof requirement>;
function invalid(message='Marketplace returned inconsistent immutable payment instructions.'):never { throw new MarketplaceApiError('PAYMENT_PROTOCOL',message); }
export function paymentRequirement(value:unknown,id:string,accountId:string):PaymentRequirement {
  const result=requirement.safeParse(value);
  if(!result.success) return invalid();
  const p=result.data;
  if(p.id!==id || p.ownerAccountId!==accountId || !(p.asset==='ATTO'?/^atto:(live|beta|dev|local)$/.test(p.network):/^nano:(mainnet|dev)$/.test(p.network))) invalid();
  if((p.status==='VERIFIED')!==(p.verifiedPayment!==null)) invalid();
  if(p.verifiedPayment) {
    const paid=p.verifiedPayment;
    if(paid.network!==p.network || paid.senderAddress!==p.senderAddress || paid.recipientAddress!==p.recipientAddress
      || paid.amountAtomic!==p.amountAtomic || paid.senderHeight<=p.baselineHeight) invalid();
  }
  return p;
}
export function relayTerms(p:PaymentRequirement):RelayTerms {
  return {paymentId:p.id,purpose:p.purpose,sourceReference:p.sourceReference,ownerAccountId:p.ownerAccountId,asset:p.asset,
    network:p.network,senderAddress:p.senderAddress,recipientAddress:p.recipientAddress,amountAtomic:p.amountAtomic,
    termsHash:p.termsHash,versionHash:p.versionHash,baselineHeight:String(p.baselineHeight),baselineFrontier:p.baselineFrontier};
}
export function paymentEvidenceBinding(p:PaymentRequirement,transactionHash:string):string {
  return relayEvidenceBinding(relayTerms(p),transactionHash);
}
export function validatePaymentChallenge(value:unknown,p:PaymentRequirement,transactionHash:string,audience:string,now=Date.now()) {
  const parsed=z.object({challengeId:z.string().uuid(),message:z.string().min(1).max(4096),issuedAt:z.string(),expiresAt:z.string()}).safeParse(value);
  if(!parsed.success) return invalid('Invalid payment proof challenge.');
  const { challengeId, message, issuedAt, expiresAt } = parsed.data;
  let frame;
  try {
    frame = validateRelayChallenge(relayTerms(p), transactionHash, audience, { challengeId, message }, now);
  } catch {
    return invalid('Payment challenge differs from the exact requirement, hash or wallet audience.');
  }
  if (issuedAt !== frame.issuedAt || expiresAt !== frame.expiresAt) {
    return invalid('Payment challenge differs from its signed timestamps.');
  }
  return parsed.data;
}
/** The wallet retains the native candidate and final header; only Market publishes it. */
export async function payRequirement(input:{api:MarketplaceApiClient;profile:MarketplaceProfile;env:NodeJS.ProcessEnv;paymentId:string;nanoWork?:NanoWorkProvider | undefined},native={callWallet}) {
  const {api,profile,env,paymentId}=input;
  const path=`/v1/agent/payments/${paymentId}`;
  const p=paymentRequirement((await api.request(path)).json,paymentId,profile.accountId);
  if(p.status==='VERIFIED') return p;
  const identity=await native.callWallet(env,{asset:p.asset,operation:'identity.list',input:{}});
  if(identity.address!==p.senderAddress || identity.network!==p.network || !Number.isSafeInteger(identity.index)) invalid('The selected local wallet differs from the frozen sender or network.');
  let saved=await native.callWallet(env,{asset:p.asset,operation:'payment.status',input:{requestId:p.id}});
  const binding = { requestId: p.id, origin: profile.origin, audience: profile.audience, terms: relayTerms(p) };
  const needsCandidate = saved.state === 'NOT_FOUND' || saved.hash === null;
  let offer: RelayOffer | undefined;
  if (saved.state !== 'NOT_FOUND') {
    if (typeof saved.paymentRequired !== 'string') invalid('The wallet did not retain its original x402 offer.');
    offer = parseRelayOffer({ ...binding, paymentRequired: saved.paymentRequired }, true);
  }
  if (!offer || (needsCandidate && offer.expiresAt <= Date.now())) {
    const response=await api.request(path,{method:'POST',headers:{'Idempotency-Key':p.id},allowStatus:[200,202,402]});
    if(response.status===200) return confirmedResponse(response,p,profile.accountId);
    if(response.status===202) return pendingResponse(response,p,profile.accountId,profile.origin);
    const paymentRequired=response.headers.get('PAYMENT-REQUIRED');
    if (!paymentRequired) invalid(offer ? 'Marketplace omitted the refreshed unused x402 offer.' : 'Marketplace omitted the x402 payment offer.');
    offer = parseRelayOffer({ ...binding, paymentRequired });
  }
  const request = { ...binding, paymentRequired: offer.header };
  if (needsCandidate) {
    saved = await native.callWallet(env, { asset: p.asset, operation: 'payment.prepare', input: request }, input.nanoWork);
  }
  validateSaved(saved,p);
  if(saved.state==='failed'||saved.state==='COMPETING')return {requirement:p,wallet:saved};
  const transactionHash=String(saved.hash).toLowerCase();
  if(saved.paymentSignature===null) {
    const challenge=validatePaymentChallenge((await api.request(`${path}/challenge`,{method:'POST',body:{transactionHash}})).json,p,transactionHash,profile.audience);
    const proof={challengeId:challenge.challengeId,message:challenge.message};
    parseRelayOffer(request); // Recheck offer expiry after fetching the challenge.
    saved=await native.callWallet(env,{asset:p.asset,operation:'payment.authorize',input:{requestId:p.id,proof}});
    validateSaved(saved,p);
  }
  if(typeof saved.paymentSignature!=='string')invalid('The wallet did not durably retain its payment authorization.');
  // The saved header includes the original proof. Never obtain fresh terms after an uncertain submission.
  const payload=decodePaymentHeader(saved.paymentSignature),proof=relayProofFromHeader(saved.paymentSignature);
  validateRelayProof(offer,transactionHash,profile.audience,proof,true);
  const nativePayload=z.record(z.string(),z.unknown()).safeParse(payload.payload);
  if(!nativePayload.success||relayPaymentPayload(offer,p.id,nativePayload.data,proof)!==saved.paymentSignature)invalid('The saved x402 envelope differs from its original offer or proof.');
  const response=await api.request(path,{method:'POST',headers:{'Idempotency-Key':p.id,'PAYMENT-SIGNATURE':saved.paymentSignature},allowStatus:[200,202,402]});
  if(response.status===402)invalid('The original relay was not settled. Preserve its wallet candidate and recover this payment ID; do not prepare another payment.');
  if(response.status===200) return confirmedResponse(response,p,profile.accountId,transactionHash);
  return pendingResponse(response,p,profile.accountId,profile.origin,transactionHash);
}
function confirmedResponse(response:ApiResponse,p:PaymentRequirement,accountId:string,transactionHash?:string) {
  const result=paymentRequirement(response.json,p.id,accountId),header=response.headers.get('PAYMENT-RESPONSE');
  if(result.status!=='VERIFIED'||!header)invalid('Marketplace reported success without independently verified settlement.');
  if(JSON.stringify(relayTerms(result))!==JSON.stringify(relayTerms(p)))invalid('Settlement changed immutable payment terms.');
  const settlement=decodePaymentHeader(header);
  if(settlement.success!==true||settlement.payer!==p.senderAddress||settlement.network!==p.network
    ||typeof settlement.transaction!=='string'||(transactionHash!==undefined&&settlement.transaction.toLowerCase()!==transactionHash)
    ||result.verifiedPayment?.transactionHash.toLowerCase()!==settlement.transaction.toLowerCase())invalid('The settlement response differs from the original native candidate.');
  return result;
}
function pendingResponse(response:ApiResponse,p:PaymentRequirement,accountId:string,origin:string,transactionHash?:string) {
  const path=`/v1/agent/payments/${p.id}`;
  if(response.headers.has('PAYMENT-RESPONSE'))invalid('An unresolved relay must not report successful settlement.');
  const location=response.headers.get('Location');
  if(!location)invalid('Pending payment omitted its original recovery location.');
  let recovery:URL;
  try {recovery=new URL(location,origin);}catch{return invalid('Invalid pending payment recovery location.');}
  if(recovery.origin!==origin||recovery.pathname!==path||recovery.search||recovery.hash||recovery.username||recovery.password)invalid('Pending payment recovery left the original resource.');
  const pending=z.object({success:z.literal(false),errorReason:z.literal('settlement_pending'),payer:z.literal(p.senderAddress),
    transaction:hash,network:z.literal(p.network),extensions:z.object({'marketplace-relay':z.object({info:z.object({attempted:z.literal(true),recovery:z.literal(path)})})})}).safeParse(response.json);
  if(pending.success) {
    if(transactionHash!==undefined&&pending.data.transaction.toLowerCase()!==transactionHash)invalid();
    if(p.relay&&pending.data.transaction.toLowerCase()!==p.relay.transactionHash.toLowerCase())invalid();
    return {requirement:p,settlement:pending.data,recovery:path};
  }
  const staged=paymentRequirement(response.json,p.id,accountId);
  if(staged.status==='VERIFIED'||JSON.stringify(relayTerms(staged))!==JSON.stringify(relayTerms(p)))invalid('Pending settlement differs from the original requirement.');
  if(transactionHash!==undefined) {
    if(!staged.relay||staged.relay.requestId!==p.id||staged.relay.transactionHash.toLowerCase()!==transactionHash||staged.relay.attempted)invalid('Unattempted relay status differs from the admitted original candidate.');
  } else if(!staged.relay&&!staged.submissions.some(submission=>submission.status==='PENDING'))invalid('Pending payment has no original admitted operation.');
  return {requirement:staged,recovery:path};
}

function validateSaved(saved:Record<string,unknown>,p:PaymentRequirement):void {
  if(saved.requestId!==p.id||saved.network!==p.network||saved.sourceAddress!==p.senderAddress
    ||saved.destination!==p.recipientAddress||saved.amountAtomic!==p.amountAtomic||!hash.safeParse(saved.hash).success
    ||!(saved.paymentSignature===null||typeof saved.paymentSignature==='string'))invalid('The retained wallet candidate differs from immutable payment instructions.');
}
