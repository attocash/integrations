import { asRecord } from './marketplace-results.js';
import { requireSession } from './profile-store.js';
import { attoNetworks, xnoFundingNetworks, validateAssetNetwork } from './asset-network.js';
import { mutationHash } from './canonical-json.js';
import { randomBytes } from 'node:crypto';
import { MarketplaceApiClient, MarketplaceApiError } from './marketplace-api.js';
import { MarketplaceProfileStore, ProfileError, type MarketplaceProfile } from './profile-store.js';
import { createXnoPaymentRequest, parseXnoPaymentRequest, parseXnoPaymentResponse, PaymentHandoffError, type XnoPaymentRequest, type XnoPaymentResponse } from './payment-handoff.js';
import { ensurePaymentHandoffDirectory, readXnoPaymentResponse, readXnoPaymentResponseForRecovery, writeXnoPaymentRequest } from './payment-handoff-files.js';
import { attoIntentPaymentStatus, payAttoIntent, payXnoHandoff, callWallet, type AttoIntentPayment, type AttoIntentPaymentFailure, type AttoIntentPaymentStatus } from './wallet-process.js';

export function requireFundingContext(profile: MarketplaceProfile, args: Record<string, unknown>): void {
  const hasOrigin = args.expectedMarketplaceOrigin !== undefined;
  const hasAccount = args.expectedAccountId !== undefined;
  if (hasOrigin !== hasAccount) {
    throw new ProfileError('FUNDING_CONTEXT_MISMATCH',
      'Provide both expectedMarketplaceOrigin and expectedAccountId, or omit both. This validation runs before any funding request or payment is created.');
  }
  if (hasOrigin && (args.expectedMarketplaceOrigin !== profile.origin || args.expectedAccountId !== profile.accountId)) {
    throw new ProfileError('FUNDING_CONTEXT_MISMATCH',
      'The supplied expectedMarketplaceOrigin and expectedAccountId must both match the configured Marketplace profile. Select the matching Marketplace MCP profile; no funding request or payment was created.');
  }
}

function fundingProfileAliasError(store:MarketplaceProfileStore,profile:MarketplaceProfile,requestIdValue:string):ProfileError|undefined {
  const aliases=store.listFundingRecoveryProfileAliases(profile,requestIdValue);
  if (!aliases.length) return undefined;
  const profiles=aliases.map(alias=>`\`${alias.profileId}\``).join(', ');
  return new ProfileError('FUNDING_PROFILE_ALIAS',
    `This requestId is saved under matching local profile(s): ${profiles}. Select the original profile and check marketplace_funding_status with this same requestId. This call made no Marketplace or wallet request and created no mutation or payment.`);
}

interface MarketplaceFundingJournal {
  version: 1;
  profileId: string;
  accountId: string;
  origin: string;
  audience: string;
  requestId: string;
  asset: 'ATTO'|'XNO';
  amountAtomic: string;
  requestedNetwork?: string;
  state: string;
  intentId?: string;
  network?: string;
  expiresAt?: string;
  paymentRequired?: string;
  xnoRequest?: XnoPaymentRequest;
  xnoResponse?: XnoPaymentResponse;
  xnoNativeObservation?: NanoFundingObservation;
  attoPayment?: AttoIntentPayment;
  attoFailure?: AttoIntentPaymentFailure;
  attoNativeState?: 'challenged'|'unknown'|'confirmed'|'rejected';
  lastStatus?: Record<string,unknown>;
}

export async function marketplaceFund(input:{store:MarketplaceProfileStore;profile:MarketplaceProfile;api:MarketplaceApiClient;env:NodeJS.ProcessEnv;
  paymentHandoffDirectory?:string;asset:'ATTO'|'XNO';amountAtomic:string;requestId:string;network?:string}):Promise<unknown> {
  requireSession(input.profile);
  validateAssetNetwork(input.asset,input.network,'funding');
  if (!input.store.getMutationByRequestId(input.profile.id,input.requestId)) {
    const aliasError=fundingProfileAliasError(input.store,input.profile,input.requestId);
    if (aliasError) throw aliasError;
  }
  const requestHash=mutationHash({operation:'marketplace-fund',accountId:input.profile.accountId,origin:input.profile.origin,
    asset:input.asset,amountAtomic:input.amountAtomic,...(input.network!==undefined?{network:input.network}:{})});
  const reservedHandle=randomBytes(16).toString('hex');
  const mutation=input.store.beginMutation({profileId:input.profile.id,requestId:input.requestId,operation:'marketplace-fund',
    target:input.profile.accountId,requestHash},reservedHandle);
  const handle=mutation.resultIdentity;
  if (!handle || !/^[a-f0-9]{32}$/.test(handle)) throw new ProfileError('FUNDING_RECOVERY','The durable funding journal is missing its original payment handle. Do not create a replacement request.');
  let journal:MarketplaceFundingJournal;
  try {
    const existing=input.store.getHandoff(input.profile.id,handle);
    if (existing.kind!=='MARKETPLACE_FUNDING' || existing.requestHash!==requestHash) throw new Error('binding mismatch');
    journal=parseFundingJournal(existing.privatePayload,input.profile,handle);
    if (journal.requestId!==input.requestId || journal.asset!==input.asset || journal.amountAtomic!==input.amountAtomic
      || journal.requestedNetwork!==input.network) {
      throw new Error('request mismatch');
    }
  } catch (error) {
    if (error instanceof ProfileError && error.code!=='HANDOFF_NOT_FOUND') throw error;
    if (!(error instanceof ProfileError)) throw new ProfileError('FUNDING_RECOVERY','The saved funding journal does not match this request. Reconcile its existing status before continuing.');
    journal={version:1,profileId:input.profile.id,accountId:input.profile.accountId,origin:input.profile.origin,
      audience:input.profile.audience,requestId:input.requestId,asset:input.asset,amountAtomic:input.amountAtomic,
      ...(input.network!==undefined?{requestedNetwork:input.network}:{}),state:'PREPARING'};
    input.store.putHandoff(input.profile.id,handle,'MARKETPLACE_FUNDING',requestHash,'PREPARING',JSON.stringify(journal),Number.MAX_SAFE_INTEGER);
  }

  if (!journal.intentId) {
    const created=await input.api.request('/v1/agent/topups',{method:'POST',body:{asset:input.asset,
      amountAtomic:input.amountAtomic,paymentIdentifier:input.requestId,
      ...(input.network!==undefined?{network:input.network}:{})},allowStatus:[200,202,402,410]});
    const status=asRecord(created.json);
    validateFundingStatus(status,input.profile,input.asset,input.amountAtomic,undefined,input.network);
    journal={...journal,intentId:String(status.intentId),network:String(status.network),expiresAt:String(status.expiresAt),
      state:created.status===402?'INTENT_ISSUED':String(status.state),lastStatus:status};
    if (created.status===402) {
      const required=created.headers.get('payment-required');
      if (!required || required.length>100_000) throw new MarketplaceApiError('PAYMENT_PROTOCOL','Marketplace omitted or oversized its exact native payment challenge.');
      journal.paymentRequired=required;
      if (input.asset==='XNO') {
        const directory=requirePaymentHandoffDirectory(input.paymentHandoffDirectory);
        const request=createXnoPaymentRequest({version:1,type:'marketplace-x402-payment-request',handoffId:handle,
          origin:input.profile.origin,audience:input.profile.audience,accountId:input.profile.accountId,asset:'XNO',
          network:String(status.network) as XnoPaymentRequest['network'],amountAtomic:input.amountAtomic,
          requestId:input.requestId,paymentIdentifier:input.requestId,intentId:String(status.intentId),
          resourceUrl:`${input.profile.origin}/v1/agent/topups/${String(status.intentId)}`,
          expiresAt:String(status.expiresAt),paymentRequired:required});
        assertPaymentRequestProfile(request,input.profile);
        journal.xnoRequest=request;
        writeXnoPaymentRequest(directory,request);
      }
    }
    saveFundingJournal(input.store,input.profile.id,handle,journal,journal.state);
    if (created.status!==402) {
      const reconciled=await fundingStatusForJournal(input.store,input.profile,input.api,input.env,input.paymentHandoffDirectory,handle,journal,false);
      return reconciled;
    }
  }

  if (!journal.intentId || !journal.expiresAt || !journal.network || !journal.paymentRequired) {
    throw new ProfileError('FUNDING_RECOVERY','The original Marketplace funding challenge is incomplete in the local journal. Do not request a replacement intent.');
  }
  if (Date.parse(journal.expiresAt)<=Date.now()) {
    return await fundingStatusForJournal(input.store,input.profile,input.api,input.env,input.paymentHandoffDirectory,handle,journal,false);
  }
  const current=await fetchFundingIntent(input.api,input.profile,journal);
  let attoObservation:AttoIntentPaymentStatus|undefined;
  if (input.asset==='ATTO') {
    const terminal=fundingFailed(current)||fundingUsable(current)
      || current.state==='PENDING'&&typeof current.sendHash==='string';
    attoObservation=terminal||journal.attoFailure
      ? await bestEffortAttoPaymentStatus(input.env,input.profile,input.requestId)
      : await attoIntentPaymentStatus({env:input.env,requestId:input.requestId,
        apiUrl:`${input.profile.origin}/v1/agent/topups`,audience:input.profile.audience});
    if (attoObservation && attoObservation.paymentState!=='NOT_FOUND') {
      assertAttoPaymentStatusBinding(attoObservation,journal,current);
      if (attoObservation.paymentState==='FAILED' && !fundingUsable(current)) {
        journal={...journal,attoFailure:attoObservation,attoNativeState:attoObservation.nativeState,state:'FAILED',lastStatus:current};
        saveFundingJournal(input.store,input.profile.id,handle,journal,'FAILED');
        input.store.completeMutation(input.profile.id,input.requestId,requestHash,handle);
        return await fundingPublicResult(input.api,journal,current,'Fresh Marketplace API intent read');
      }
      journal=recordAttoPaymentStatus(journal,attoObservation);
    }
    if (journal.attoFailure && fundingUsable(current)) {
      throw new MarketplaceApiError('PAYMENT_BINDING','Marketplace reports this ATTO intent credited, but the local wallet reports its native transaction rejected. Reconcile the exact intent before retrying.');
    }
    if (journal.attoFailure && !fundingUsable(current)) {
      journal={...journal,state:'FAILED',lastStatus:current};
      saveFundingJournal(input.store,input.profile.id,handle,journal,'FAILED');
      input.store.completeMutation(input.profile.id,input.requestId,requestHash,handle);
      return await fundingPublicResult(input.api,journal,current,'Fresh Marketplace API intent read');
    }
    if (journal.attoPayment || journal.attoNativeState) {
      saveFundingJournal(input.store,input.profile.id,handle,journal,journal.state);
    }
  }
  if(journal.asset==='XNO'&&journal.xnoRequest) {
    const observation=await reconcileXnoWallet(input.env,handle,journal.xnoRequest,journal.xnoResponse,current);
    if(observation)journal={...journal,xnoNativeObservation:observation};
  }
  if (fundingFailed(current)) {
    journal={...journal,state:'FAILED',lastStatus:current};
    saveFundingJournal(input.store,input.profile.id,handle,journal,'FAILED');
    input.store.completeMutation(input.profile.id,input.requestId,requestHash,handle);
    return await fundingPublicResult(input.api,journal,current,'Fresh Marketplace API intent read');
  }
  if (fundingUsable(current) || current.state==='PENDING' && current.sendHash) {
    journal={...journal,state:String(current.state),lastStatus:current};
    saveFundingJournal(input.store,input.profile.id,handle,journal,journal.state);
    input.store.completeMutation(input.profile.id,input.requestId,requestHash,handle);
    return await fundingPublicResult(input.api,journal,current,'Fresh Marketplace API intent read');
  }
  if (input.asset==='ATTO' && !journal.attoPayment) {
    const recovered=attoObservation?.paymentState==='READY'?attoObservation:undefined;
    const intentId=journal.intentId;
    const paymentRequired=journal.paymentRequired;
    const expiresAt=journal.expiresAt;
    if (!intentId || !paymentRequired || !expiresAt) {
      throw new ProfileError('FUNDING_RECOVERY','The exact Marketplace challenge is missing from the local journal.');
    }
    const payment=recovered ?? await payAttoIntent({
      env:input.env,apiUrl:`${input.profile.origin}/v1/agent/topups`,audience:input.profile.audience,
      request:{requestId:input.requestId,intentId,amountAtomic:input.amountAtomic,
        paymentIdentifier:input.requestId,paymentRequired,
        apiUrl:`${input.profile.origin}/v1/agent/topups`,resourceUrl:`${input.profile.origin}/v1/agent/topups/${intentId}`,
        expiresAt},
    });
    assertAttoPaymentBinding(payment,journal);
    journal={...journal,attoPayment:payment,attoNativeState:'unknown',state:'PAYMENT_READY'};
    saveFundingJournal(input.store,input.profile.id,handle,journal,'PAYMENT_READY');
  }
  if (input.asset==='XNO' && !journal.xnoResponse) {
    const request=journal.xnoRequest;
    if (!request) throw new ProfileError('FUNDING_RECOVERY','The exact XNO payment request is missing from the durable Marketplace journal.');
    const directory=requirePaymentHandoffDirectory(input.paymentHandoffDirectory);
    await payXnoHandoff(input.env,handle);
    const response=readXnoPaymentResponse(directory,handle,request);
    journal={...journal,xnoResponse:response,state:'PAYMENT_READY'};
    saveFundingJournal(input.store,input.profile.id,handle,journal,'PAYMENT_READY');
  }
  return submitFundingPayment(input.store,input.profile,input.api,input.env,input.requestId,requestHash,handle,journal);
}

export async function marketplaceFundingStatus(input:{store:MarketplaceProfileStore;profile:MarketplaceProfile;api:MarketplaceApiClient;env:NodeJS.ProcessEnv;
  paymentHandoffDirectory?:string;requestId:string}):Promise<unknown> {
  requireSession(input.profile);
  const mutation=input.store.getMutationByRequestId(input.profile.id,input.requestId);
  if (!mutation) {
    const aliasError=fundingProfileAliasError(input.store,input.profile,input.requestId);
    if (aliasError) throw aliasError;
    throw new ProfileError('FUNDING_NOT_FOUND','No Marketplace funding request with this requestId exists in this local profile.');
  }
  if (mutation.operation!=='marketplace-fund' || mutation.target!==input.profile.accountId) {
    throw new ProfileError('IDEMPOTENCY_CONFLICT','This requestId is already bound to a different Marketplace operation.');
  }
  if (!mutation.resultIdentity || !/^[a-f0-9]{32}$/.test(mutation.resultIdentity)) {
    throw new ProfileError('FUNDING_RECOVERY','The original funding handle is unavailable. Reconcile with Marketplace support before creating another payment.');
  }
  const handoff=input.store.getHandoff(input.profile.id,mutation.resultIdentity);
  if (handoff.kind!=='MARKETPLACE_FUNDING' || handoff.requestHash!==mutation.requestHash) {
    throw new ProfileError('FUNDING_RECOVERY','The original funding journal does not match this request. Reconcile with Marketplace support before creating another payment.');
  }
  const journal=parseFundingJournal(handoff.privatePayload,input.profile,mutation.resultIdentity);
  return await fundingStatusForJournal(input.store,input.profile,input.api,input.env,input.paymentHandoffDirectory,
    mutation.resultIdentity,journal,true);
}

async function submitFundingPayment(store:MarketplaceProfileStore,profile:MarketplaceProfile,api:MarketplaceApiClient,env:NodeJS.ProcessEnv,requestIdValue:string,
  requestHash:string,handle:string,journal:MarketplaceFundingJournal):Promise<unknown> {
  const payment=journal.asset==='ATTO'?journal.attoPayment:journal.xnoResponse;
  if (!payment || !journal.intentId) throw new ProfileError('FUNDING_RECOVERY','The exact native payment is not saved in the Marketplace funding journal.');
  saveFundingJournal(store,profile.id,handle,{...journal,state:'SUBMITTING'},'SUBMITTING');
  let saved:MarketplaceFundingJournal;
  let status:Record<string,unknown>;
  let settledState:'PENDING'|'ACCEPTED'|'SETTLED'|'REJECTED';
  try {
    const result=await api.request(`/v1/agent/topups/${journal.intentId}`,{method:'POST',
      headers:{'PAYMENT-SIGNATURE':journal.asset==='ATTO'?journal.attoPayment!.paymentSignature:journal.xnoResponse!.paymentSignature},
      allowStatus:[200,202,409]});
    status=asRecord(result.json);
    validateFundingStatus(status,profile,journal.asset,journal.amountAtomic,journal.intentId,journal.network);
    const receipt=result.headers.get('payment-response');
    const settlement=journal.asset==='XNO'
      ? validatePaymentReceipt(receipt,status,journal.xnoResponse!,result.status)
      : validateAttoPaymentReceipt(receipt,status,journal.attoPayment!,result.status);
    settledState=settlement;
    const nextState=fundingFailed(status)?'FAILED':fundingUsable(status)?String(status.state):'PENDING';
    saved={...journal,state:nextState,lastStatus:status};
    saveFundingJournal(store,profile.id,handle,saved,nextState);
    if (fundingUsable(status) || nextState==='FAILED') store.completeMutation(profile.id,requestIdValue,requestHash,handle);
  } catch (error) {
    const existing=store.getHandoff(profile.id,handle);
    const saved=parseFundingJournal(existing.privatePayload,profile,handle);
    saveFundingJournal(store,profile.id,handle,{...saved,state:'UNKNOWN'},'UNKNOWN');
    if (error instanceof MarketplaceApiError || error instanceof ProfileError) throw error;
    throw new MarketplaceApiError('FUNDING_UNKNOWN','Marketplace may have received this exact native payment. Retry marketplace_fund with the same requestId or reconcile it with marketplace_funding_status.');
  }
  if (journal.asset==='ATTO' && (fundingUsable(status) || ['EXPIRED','FAILED'].includes(saved.state))) {
    const observation=await bestEffortAttoPaymentStatus(env,profile,requestIdValue);
    if (observation && observation.paymentState!=='NOT_FOUND') {
      assertAttoPaymentStatusBinding(observation,saved,status);
      if (observation.paymentState==='FAILED' && fundingUsable(status)) {
        throw new MarketplaceApiError('PAYMENT_BINDING','Marketplace reports this ATTO intent credited, but the local wallet reports its native transaction rejected. Reconcile the exact intent before retrying.');
      }
      saved=recordAttoPaymentStatus(saved,observation);
      saveFundingJournal(store,profile.id,handle,saved,saved.state);
    }
  }
  if(saved.asset==='XNO'&&saved.xnoRequest) {
    const observation=await reconcileXnoWallet(env,handle,saved.xnoRequest,saved.xnoResponse,status);
    if(observation) {saved={...saved,xnoNativeObservation:observation};saveFundingJournal(store,profile.id,handle,saved,saved.state);}
  }
  return {...await fundingPublicResult(api,saved,status,'Marketplace API response to payment submission (POST)'),settlementState:settledState};
}

async function fundingStatusForJournal(store:MarketplaceProfileStore,profile:MarketplaceProfile,api:MarketplaceApiClient,env:NodeJS.ProcessEnv,
  paymentHandoffDirectory:string|undefined,handle:string,journal:MarketplaceFundingJournal,recoverLocalPayment:boolean):Promise<unknown> {
  if (!journal.intentId) throw new ProfileError('FUNDING_RECOVERY','The intent ID has not been recorded yet. Retry marketplace_fund with the same requestId to recover the idempotent intent response.');
  if (recoverLocalPayment && !['ACCEPTED','SETTLED','EXPIRED','FAILED','REJECTED'].includes(journal.state)) {
    if (journal.asset==='XNO' && !journal.xnoResponse && journal.xnoRequest) {
      try {
        const response=readXnoPaymentResponseForRecovery(requirePaymentHandoffDirectory(paymentHandoffDirectory),handle,journal.xnoRequest);
        journal={...journal,xnoResponse:response,state:'PAYMENT_READY'};
        saveFundingJournal(store,profile.id,handle,journal,'PAYMENT_READY');
      } catch (error) {
        if (!(error instanceof PaymentHandoffError) || error.code!=='PAYMENT_FILE') throw error;
      }
    }
  }
  const status=await fetchFundingIntent(api,profile,journal);
  if(journal.asset==='XNO'&&journal.xnoRequest) {
    const observation=await reconcileXnoWallet(env,handle,journal.xnoRequest,journal.xnoResponse,status);
    if(observation)journal={...journal,xnoNativeObservation:observation};
  }
  if (journal.asset==='ATTO') {
    const observation=await bestEffortAttoPaymentStatus(env,profile,journal.requestId);
    if (observation && observation.paymentState!=='NOT_FOUND') {
      assertAttoPaymentStatusBinding(observation,journal,status);
      if (observation.paymentState==='FAILED' && fundingUsable(status)) {
        throw new MarketplaceApiError('PAYMENT_BINDING','Marketplace reports this ATTO intent credited, but the local wallet reports its native transaction rejected. Reconcile the exact intent before retrying.');
      }
      journal=recordAttoPaymentStatus(journal,observation);
    }
  }
  if (journal.attoFailure && fundingUsable(status)) {
    throw new MarketplaceApiError('PAYMENT_BINDING','Marketplace reports this ATTO intent credited, but the saved native wallet journal records rejection. Reconcile the exact intent before retrying.');
  }
  journal={...journal,state:journal.attoFailure&&!fundingUsable(status)?'FAILED':fundingFailed(status)?'FAILED':String(status.state),lastStatus:status};
  saveFundingJournal(store,profile.id,handle,journal,journal.state);
  if (fundingUsable(status) || fundingFailed(status) || journal.attoFailure) {
    const mutation=store.getMutationByRequestId(profile.id,journal.requestId);
    if (mutation?.state==='PENDING') store.completeMutation(profile.id,journal.requestId,mutation.requestHash,handle);
  }
  return await fundingPublicResult(api,journal,status,'Fresh Marketplace API intent read');
}

function parseFundingJournal(payload:string,profile:MarketplaceProfile,handle:string):MarketplaceFundingJournal {
  let value:Record<string,unknown>;
  try { value=asRecord(JSON.parse(payload)); } catch { throw new ProfileError('FUNDING_RECOVERY','The private Marketplace funding journal is invalid.'); }
  if (value.version!==1 || value.profileId!==profile.id || value.accountId!==profile.accountId
    || value.origin!==profile.origin || value.audience!==profile.audience
    || typeof value.requestId!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.requestId)
    || value.asset!=='ATTO'&&value.asset!=='XNO' || typeof value.amountAtomic!=='string'||! /^[1-9][0-9]{0,64}$/.test(value.amountAtomic)
    || typeof value.state!=='string' || (value.intentId!==undefined && typeof value.intentId!=='string')) {
    throw new ProfileError('FUNDING_RECOVERY','The private Marketplace funding journal does not match its profile or stable request.');
  }
  const journal=value as unknown as MarketplaceFundingJournal;
  if (journal.requestedNetwork!==undefined) {
    try { validateAssetNetwork(journal.asset,journal.requestedNetwork,'funding'); }
    catch { throw new ProfileError('FUNDING_RECOVERY','The saved funding journal has an invalid requested network.'); }
    if (journal.network!==undefined && journal.network!==journal.requestedNetwork) {
      throw new ProfileError('FUNDING_RECOVERY','The saved funding intent resolved to a different requested network.');
    }
  }
  if (journal.xnoRequest) {
    const request=parseXnoPaymentRequest(journal.xnoRequest,0);
    assertPaymentRequestProfile(request,profile);
    if (request.handoffId!==handle || request.requestId!==journal.requestId || request.amountAtomic!==journal.amountAtomic
      || request.network!==journal.network) {
      throw new ProfileError('FUNDING_RECOVERY','The saved XNO payment request is bound to a different Marketplace funding identity.');
    }
  }
  if (journal.xnoResponse && journal.xnoRequest) parseXnoPaymentResponse(journal.xnoResponse,journal.xnoRequest,handle,0);
  return journal;
}

function saveFundingJournal(store:MarketplaceProfileStore,profileId:string,handle:string,journal:MarketplaceFundingJournal,state:string):void {
  store.setHandoffState(profileId,handle,state,JSON.stringify({...journal,state}));
}

async function fetchFundingIntent(api:MarketplaceApiClient,profile:MarketplaceProfile,journal:MarketplaceFundingJournal):Promise<Record<string,unknown>> {
  if (!journal.intentId) throw new ProfileError('FUNDING_RECOVERY','The Marketplace funding intent ID is missing from its local journal.');
  const status=asRecord((await api.request(`/v1/agent/topups/${journal.intentId}`)).json);
  validateFundingStatus(status,profile,journal.asset,journal.amountAtomic,journal.intentId,journal.network);
  if (journal.attoPayment && typeof status.sendHash==='string' && status.sendHash.toUpperCase()!==journal.attoPayment.hash.toUpperCase()) {
    throw new MarketplaceApiError('PAYMENT_BINDING','Marketplace reports a different ATTO transaction for this funding request.');
  }
  if (journal.xnoResponse && typeof status.sendHash==='string' && status.sendHash.toUpperCase()!==journal.xnoResponse.sendHash) {
    throw new MarketplaceApiError('PAYMENT_BINDING','Marketplace reports a different XNO SEND for this funding request.');
  }
  return status;
}

function hasValidFundingStatuses(status:Record<string,unknown>):boolean {
  const financialStates=['PENDING','ACCEPTED','SETTLED','REJECTED'];
  return financialStates.includes(String(status.state))
    && (status.paymentState===null || financialStates.includes(String(status.paymentState)))
    && (status.receiveStatus===null || financialStates.includes(String(status.receiveStatus)));
}

function validateFundingStatus(status:Record<string,unknown>,profile:MarketplaceProfile,assetName:'ATTO'|'XNO',amountAtomic:string,
  intentId?:string,network?:string):void {
  if (status.asset!==assetName || status.amountAtomic!==amountAtomic || typeof status.intentId!=='string'
    || (intentId!==undefined && status.intentId!==intentId) || typeof status.network!=='string'
    || (network!==undefined && status.network!==network) || !hasValidFundingStatuses(status)
    || typeof status.expiresAt!=='string' || !Number.isFinite(Date.parse(status.expiresAt))) {
    throw new MarketplaceApiError('FUNDING_BINDING','Marketplace returned a funding intent that does not match the exact asset, amount and request.');
  }
  if (assetName==='XNO' && !xnoFundingNetworks.some(value => value === status.network)) throw new MarketplaceApiError('FUNDING_BINDING','Marketplace returned an unsupported XNO network for its exact funding intent.');
  if (assetName==='ATTO' && !attoNetworks.some(value => value === status.network)) throw new MarketplaceApiError('FUNDING_BINDING','Marketplace returned an unsupported Atto network for its exact funding intent.');
    void profile;
}

function fundingFailed(status:Record<string,unknown>):boolean {
  return status.state==='REJECTED';
}

function fundingUsable(status:Record<string,unknown>):boolean {
  return status.state==='ACCEPTED' || status.state==='SETTLED';
}

async function bestEffortAttoPaymentStatus(env:NodeJS.ProcessEnv,profile:MarketplaceProfile,requestIdValue:string):Promise<AttoIntentPaymentStatus|undefined> {
  try {
    return await attoIntentPaymentStatus({env,requestId:requestIdValue,
      apiUrl:`${profile.origin}/v1/agent/topups`,audience:profile.audience});
  } catch {
    return undefined;
  }
}

function assertAttoPaymentStatusBinding(observation:AttoIntentPaymentStatus,journal:MarketplaceFundingJournal,
  marketplaceStatus?:Record<string,unknown>):void {
  if (observation.paymentState==='NOT_FOUND') return;
  if (observation.requestId!==journal.requestId || observation.intentId!==journal.intentId
    || observation.network!==journal.network || observation.amountAtomic!==journal.amountAtomic) {
    throw new ProfileError('FUNDING_BINDING','The managed Atto wallet returned native status for a different Marketplace intent.');
  }
  if (observation.paymentState==='FAILED') {
    if (observation.failureReason==='MARKETPLACE_CHALLENGE_EXPIRED') {
      if (journal.attoPayment || typeof marketplaceStatus?.sendHash==='string' || typeof marketplaceStatus?.payer==='string') {
        throw new ProfileError('FUNDING_BINDING','An unsigned ATTO expiry cannot replace an observed native payment.');
      }
      return;
    }
    if (journal.attoPayment && (journal.attoPayment.hash.toUpperCase()!==observation.hash.toUpperCase()
      || journal.attoPayment.payer!==observation.payer)) {
      throw new ProfileError('FUNDING_BINDING','The managed Atto wallet rejection does not match its saved native payment.');
    }
    if (typeof marketplaceStatus?.sendHash==='string' && marketplaceStatus.sendHash.toUpperCase()!==observation.hash.toUpperCase()) {
      throw new ProfileError('FUNDING_BINDING','The managed Atto wallet rejection does not match the Marketplace intent transaction.');
    }
    if (typeof marketplaceStatus?.payer==='string' && marketplaceStatus.payer!==observation.payer) {
      throw new ProfileError('FUNDING_BINDING','The managed Atto wallet rejection does not match the Marketplace intent payer.');
    }
    return;
  }
  if (observation.paymentState==='READY') {
    assertAttoPaymentBinding(observation,journal);
    if (typeof marketplaceStatus?.sendHash==='string' && marketplaceStatus.sendHash.toUpperCase()!==observation.hash.toUpperCase()) {
      throw new ProfileError('FUNDING_BINDING','The managed Atto wallet payment hash does not match the Marketplace intent transaction.');
    }
    if (typeof marketplaceStatus?.payer==='string' && marketplaceStatus.payer!==observation.payer) {
      throw new ProfileError('FUNDING_BINDING','The managed Atto wallet payer does not match the Marketplace intent transaction.');
    }
    if (journal.attoPayment && (journal.attoPayment.hash.toUpperCase()!==observation.hash.toUpperCase()
      || journal.attoPayment.payer!==observation.payer
      || journal.attoPayment.paymentSignature!==observation.paymentSignature)) {
      throw new ProfileError('FUNDING_BINDING','The managed Atto wallet returned a different saved native payment.');
    }
    return;
  }
  if (journal.attoPayment) throw new ProfileError('FUNDING_BINDING','The managed Atto wallet lost the saved identity of a signed payment.');
}

function recordAttoPaymentStatus(journal:MarketplaceFundingJournal,observation:AttoIntentPaymentStatus):MarketplaceFundingJournal {
  if (observation.paymentState==='NOT_FOUND') return journal;
  if (observation.paymentState==='FAILED') return {...journal,attoFailure:observation,attoNativeState:observation.nativeState,state:'FAILED'};
  if (observation.paymentState==='PENDING_SIGNATURE') return {...journal,attoNativeState:'challenged'};
  return {...journal,attoPayment:journal.attoPayment??observation,attoNativeState:observation.nativeState??'unknown'};
}

function assertAttoPaymentBinding(payment:AttoIntentPayment,journal:MarketplaceFundingJournal):void {
  if (payment.requestId!==journal.requestId || payment.intentId!==journal.intentId
    || payment.paymentIdentifier!==journal.requestId || payment.amountAtomic!==journal.amountAtomic
    || payment.network!==journal.network || payment.paymentState!=='READY') {
    throw new ProfileError('FUNDING_BINDING','The managed Atto wallet returned payment facts for a different saved Marketplace intent.');
  }
}

function validateAttoPaymentReceipt(header:string|null,status:Record<string,unknown>,payment:AttoIntentPayment,httpStatus:number):'PENDING'|'ACCEPTED'|'SETTLED'|'REJECTED' {
  if (header===null) return validatePendingPaymentStatus(status,payment.hash,payment.payer,payment.network,httpStatus);
  const receipt=decodeHeader(header);
  if (receipt.network!==payment.network || typeof receipt.transaction!=='string'
    || receipt.transaction.toUpperCase()!==payment.hash.toUpperCase() || status.sendHash?.toString().toUpperCase()!==payment.hash.toUpperCase()
    || receipt.payer!==payment.payer || status.payer!==payment.payer) throw new MarketplaceApiError('PAYMENT_BINDING','Marketplace returned a receipt for a different ATTO transaction.');
  if (receipt.success===true && httpStatus===200 && fundingUsable(status)
    && ['ACCEPTED','SETTLED'].includes(String(status.paymentState)) && receipt.errorReason===undefined) {
    return status.state as 'ACCEPTED'|'SETTLED';
  }
  if (receipt.success===false && receipt.errorReason==='settlement_pending' && httpStatus===202
    && status.state==='PENDING' && status.paymentState==='PENDING') return 'PENDING';
  if (receipt.success===false && receipt.errorReason==='invalid_transaction_state' && httpStatus===409
    && fundingFailed(status) && status.paymentState==='REJECTED') return 'REJECTED';
  throw new MarketplaceApiError('PAYMENT_BINDING','Marketplace returned an inconsistent ATTO settlement receipt and status.');
}

async function fundingPublicResult(api:MarketplaceApiClient,journal:MarketplaceFundingJournal,
  status:Record<string,unknown>,statusSource:'Fresh Marketplace API intent read'|'Marketplace API response to payment submission (POST)'):
  Promise<Record<string,unknown>> {
  const balances=(await api.request('/v1/agent/balances')).json;
  const nativeHash = journal.asset === 'ATTO' ? journal.attoFailure?.hash ?? journal.attoPayment?.hash ?? null
    : journal.xnoNativeObservation?.sendHash ?? journal.xnoResponse?.sendHash ?? null;
  const rejected = journal.asset === 'ATTO' ? Boolean(journal.attoFailure) : journal.xnoNativeObservation?.state === 'COMPETING';
  const confirmed = journal.asset === 'ATTO' ? journal.attoNativeState === 'confirmed' : journal.xnoNativeObservation?.state === 'CONFIRMED';
  const nativePayment = {
    state: rejected ? 'REJECTED' : confirmed ? 'SETTLED' : 'PENDING',
    hash: nativeHash,
    failureReason: rejected ? journal.attoFailure?.failureReason === 'MARKETPLACE_CHALLENGE_EXPIRED'
      ? 'CHALLENGE_EXPIRED' : 'NATIVE_TRANSACTION_REJECTED' : null,
  };
  return {requestId:journal.requestId,asset:journal.asset,amountAtomic:journal.amountAtomic,intentId:journal.intentId,
    ...(journal.network?{network:journal.network}:{}),status:jsonSafeStatus(status),statusSource,
    nativePayment,nativePaymentSource:'Managed wallet observation saved in the Marketplace MCP private journal',
    balances,balancesSource:'Fresh Marketplace API account ledger read',
    savedObservation:{source:'Marketplace MCP private funding journal',journalState:journal.state,
      interpretation:'Saved wallet metadata does not override current Marketplace intent or balance status.'},
    next:journal.attoFailure?(journal.attoFailure.failureReason==='MARKETPLACE_CHALLENGE_EXPIRED'
      ?'The original ATTO challenge expired before signing. This requestId will not be signed or submitted again; check Marketplace status before starting another funding request.'
      :'The managed Atto wallet has recorded a terminal native rejection. This requestId will not be signed or submitted again; wait for Marketplace status to reconcile before starting another funding request.')
      :fundingFailed(status)?'Marketplace rejected this native payment without credit. Reconcile the original request before starting another funding request.'
      :fundingUsable(status)?'Funding is credited and usable in this Marketplace account.':status.state==='PENDING'
      ?'Marketplace has saved this exact native payment and its outcome is pending. Recheck marketplace_funding_status with the same requestId.'
      :status.state==='REJECTED'?'Marketplace rejected this exact payment without credit. Reconcile the original request before creating another.'
      :'The original intent remains open. Retry marketplace_fund with this same requestId to continue its saved payment.',
    statusTool:'marketplace_funding_status',statusIdentifierField:'requestId',
    recovery:{tool:'marketplace_funding_status',arguments:{requestId:journal.requestId}}};
}

function decodeHeader(header: string): Record<string,unknown> {
  if (header.length>100_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(header)) throw new MarketplaceApiError('PAYMENT_PROTOCOL','Marketplace returned an invalid payment requirement header.');
  const bytes=Buffer.from(header,'base64');
  if (bytes.toString('base64')!==header || bytes.length>75_000) throw new MarketplaceApiError('PAYMENT_PROTOCOL','Marketplace returned an invalid payment requirement header.');
  try { return asRecord(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))); }
  catch { throw new MarketplaceApiError('PAYMENT_PROTOCOL','Marketplace returned an invalid payment requirement body.'); }
}

function validatePendingPaymentStatus(status:Record<string,unknown>,hash:string,payer:string,network:string,httpStatus:number):'PENDING' {
  if (httpStatus===202 && status.state==='PENDING' && status.paymentState==='PENDING'
    && status.network===network && typeof status.sendHash==='string'
    && status.sendHash.toUpperCase()===hash.toUpperCase() && status.payer===payer) return 'PENDING';
  throw new MarketplaceApiError('PAYMENT_BINDING','Marketplace omitted the native payment receipt without an exact pending payment status.');
}

function validatePaymentReceipt(header:string|null,status:Record<string,unknown>,response:XnoPaymentResponse,httpStatus:number):'PENDING'|'ACCEPTED'|'SETTLED'|'REJECTED' {
  if (header===null) return validatePendingPaymentStatus(status,response.sendHash,response.payer,response.network,httpStatus);
  const receipt=decodeHeader(header);
  if (receipt.network!==response.network || typeof receipt.transaction!=='string'
    || receipt.transaction.toUpperCase()!==response.sendHash || String(status.sendHash).toUpperCase()!==response.sendHash
    || receipt.payer!==response.payer || status.payer!==response.payer) throw new MarketplaceApiError('PAYMENT_BINDING','Marketplace returned a receipt for a different XNO SEND.');
  if (receipt.success===true && httpStatus===200 && fundingUsable(status)
    && ['ACCEPTED','SETTLED'].includes(String(status.paymentState)) && receipt.errorReason===undefined) {
    return status.state as 'ACCEPTED'|'SETTLED';
  }
  if (receipt.success===false && receipt.errorReason==='error_block_already_confirmed' && httpStatus===200
    && fundingUsable(status) && ['ACCEPTED','SETTLED'].includes(String(status.paymentState))) return status.state as 'ACCEPTED'|'SETTLED';
  if (receipt.success===false && ['settlement_pending','error_block_awaiting_confirmation','error_timeout_expired'].includes(String(receipt.errorReason)) && httpStatus===202
    && status.state==='PENDING' && status.paymentState==='PENDING') return 'PENDING';
  if (receipt.success===false && ['error_previous_not_frontier','error_invalid_block'].includes(String(receipt.errorReason)) && httpStatus===409
    && fundingFailed(status) && status.paymentState==='REJECTED') return 'REJECTED';
  throw new MarketplaceApiError('PAYMENT_BINDING','Marketplace returned an inconsistent XNO settlement receipt and status.');
}

function jsonSafeStatus(value:Record<string,unknown>):Record<string,unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key])=>!/(?:signature|payload|token|apiKey)/i.test(key)));
}

function requirePaymentHandoffDirectory(directory:string|undefined):string {
  if (!directory) throw new ProfileError('SETUP_REQUIRED','Configure MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR as the private directory shared with the Nano payer before using XNO funding.');
  return ensurePaymentHandoffDirectory(directory);
}

function assertPaymentRequestProfile(request:XnoPaymentRequest,profile:MarketplaceProfile):void {
  if (request.origin!==profile.origin || request.audience!==profile.audience || request.accountId!==profile.accountId
    || request.requestId!==request.paymentIdentifier) throw new MarketplaceApiError('PAYMENT_BINDING','The XNO payment handoff belongs to a different configured Marketplace profile.');
}

interface NanoFundingObservation {
  handoffId:string;network:string;sourceAddress:string;sendHash:string|null;
  candidateState:'PRESENT'|'ABSENT';state:'PREPARED'|'UNKNOWN'|'CONFIRMED'|'COMPETING'|'READY';requestSha256?:string;
}
/** API settlement and wallet reservation recovery are separate observations of the same SEND. */
async function reconcileXnoWallet(env:NodeJS.ProcessEnv,handle:string,request:XnoPaymentRequest,response:XnoPaymentResponse|undefined,status:Record<string,unknown>):Promise<NanoFundingObservation|undefined> {
  let observation:Record<string,unknown>;
  try {observation=await callWallet(env,{asset:'XNO',operation:'payment.status',input:{handoffId:handle}});}
  catch {return;} // An unavailable wallet keeps its own source lane fenced.
  const present=observation.candidateState==='PRESENT';
  if(observation.handoffId!==handle||observation.network!==request.network
    ||typeof observation.sourceAddress!=='string'||!/^nano_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/.test(observation.sourceAddress)
    ||!['PRESENT','ABSENT'].includes(String(observation.candidateState))
    ||(present?typeof observation.sendHash!=='string'||! /^[A-F0-9]{64}$/.test(observation.sendHash):observation.sendHash!==null)
    ||!(present?['PREPARED','UNKNOWN','CONFIRMED','COMPETING']:['READY']).includes(String(observation.state))
    ||(response!==undefined&&(observation.sourceAddress!==response.payer||observation.sendHash!==response.sendHash||!present))
    ||((response===undefined||observation.requestSha256!==undefined)&&observation.requestSha256!==request.requestSha256)) {
    throw new MarketplaceApiError('PAYMENT_BINDING','The local Nano wallet status does not match this saved Marketplace request and SEND.');
  }
  if(observation.state==='COMPETING'&&fundingUsable(status))throw new MarketplaceApiError('PAYMENT_BINDING','Marketplace reports credit for a Nano SEND that the native wallet proved ineffective. Reconcile this intent before continuing.');
  return {handoffId:handle,network:request.network,sourceAddress:observation.sourceAddress,sendHash:observation.sendHash as string|null,
    candidateState:observation.candidateState as 'PRESENT'|'ABSENT',state:observation.state as NanoFundingObservation['state'],
    ...(typeof observation.requestSha256==='string'?{requestSha256:observation.requestSha256}:{})};
}
