import { asRecord, redact } from './marketplace-results.js';
import { commandPointerFromError } from './marketplace-api.js';
import { requireSession } from './profile-store.js';
import { mutationHash } from './canonical-json.js';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { MarketplaceApiClient, MarketplaceApiError, parseCommandPointer, type ApiResponse, type MarketplaceCommandPointer } from './marketplace-api.js';
import { MarketplaceProfileStore, ProfileError, type MarketplaceProfile } from './profile-store.js';
import { approvalRequestPath, readApprovalResponse, validateApprovalResponse, verifyApprovalSignature, writeApprovalRequest, type MarketplaceProofApprovalRequest } from './approval-files.js';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const approvalChallenge = z.strictObject({
  challengeId: uuid, message: z.string().min(1).max(4096),
  issuedAt: z.string().datetime({offset:true}), expiresAt: z.string().datetime({offset:true}),
});

interface FreshProofMutationInput {
  store: MarketplaceProfileStore;
  profile: MarketplaceProfile;
  api: MarketplaceApiClient;
  env: NodeJS.ProcessEnv;
  home: string;
  operation: string;
  target: string;
  requestId: string;
  payload: unknown;
  purpose: string;
  challengePath: string;
  challengeBody: unknown;
  prepare?: () => Promise<unknown>;
  challengeResponse?: (response:unknown, context:unknown) => {challenge:z.infer<typeof approvalChallenge>;context:unknown};
  makeAction: (challenge: z.infer<typeof approvalChallenge>, context: unknown) => Record<string, unknown>;
  send: (proof: {challengeId:string;message:string;signature:string}) => Promise<ApiResponse>;
  result?: (response: unknown, context: unknown) => unknown;
}

export async function freshProofMutation(input: FreshProofMutationInput): Promise<unknown> {
  requireSession(input.profile);
  const requestHash=mutationHash({operation:input.operation,target:input.target,payload:input.payload,accountId:input.profile.accountId});
  const reservedHandle=randomBytes(16).toString('hex');
  const previous=input.store.beginMutation({profileId:input.profile.id,requestId:input.requestId,operation:input.operation,
    target:input.target,requestHash},reservedHandle);
  const handle=previous.resultIdentity;
  if (!handle || !/^[a-f0-9]{32}$/.test(handle)) throw new ProfileError('RECOVERY_REQUIRED','The protected Marketplace operation needs local recovery before retrying.');
  let handoff;
  try { handoff=input.store.getHandoff(input.profile.id,handle); }
  catch (error) {
    if (!(error instanceof ProfileError) || error.code!=='HANDOFF_NOT_FOUND') throw error;
    input.store.putHandoff(input.profile.id,handle,'CONTROLLER_APPROVAL',requestHash,'PREPARING',
      JSON.stringify({command:input.payload,requestHash}),Number.MAX_SAFE_INTEGER);
    handoff=input.store.getHandoff(input.profile.id,handle);
  }
  if (handoff.kind!=='CONTROLLER_APPROVAL' || handoff.requestHash!==requestHash) {
    throw new ProfileError('APPROVAL_BINDING','This local approval handle is bound to another protected Marketplace operation.');
  }
  let saved=asRecord(JSON.parse(handoff.privatePayload));
  if (previous.state==='COMPLETE' || handoff.state==='COMPLETE') {
    const result=saved.result;
    if (result===undefined) throw new ProfileError('RECOVERY_REQUIRED','The protected Marketplace operation completed, but its safe result is unavailable locally.');
    if (previous.state!=='COMPLETE') input.store.completeMutation(input.profile.id,input.requestId,requestHash,handle);
    if (input.operation==='withdrawal-create') {
      const withdrawalId=asRecord(result).withdrawalId;
      if (typeof withdrawalId!=='string' || !uuid.safeParse(withdrawalId).success) {
        throw new ProfileError('RECOVERY_REQUIRED','The saved withdrawal result has no original withdrawal ID. Use marketplace_withdrawals_list to reconcile it.');
      }
      const current=await input.api.request(`/v1/agent/withdrawals/${withdrawalId}`);
      const recovered=input.result?input.result(current.json,saved.context):safeMutationResult(current.json);
      return {...asRecord(recovered),recovered:true};
    }
    return {...asRecord(result),recovered:true};
  }
  if (handoff.state==='COMMAND_PENDING') {
    const pointer=parseCommandPointer(saved.commandPointer);
    if (!pointer) throw new ProfileError('RECOVERY_REQUIRED','The durable command pointer is missing from its private approval journal.');
    return resumeProtectedCommand(input,handle,requestHash,saved,pointer);
  }
  if (handoff.state==='UNKNOWN' || handoff.state==='SUBMITTING') {
    if (isShopFinancialProof(input.operation)) {
      const request=parseApprovalRequest(saved.request);
      if (saved.requestHash!==requestHash || mutationHash(saved.command)!==mutationHash(input.payload)) {
        throw new ProfileError('IDEMPOTENCY_CONFLICT','The saved signed Shop action differs from the original request.');
      }
      const responsePath=approvalRequestPath(input.home,input.profile.id,handle).replace(/\.request\.json$/,'.response.json');
      if (!existsSync(responsePath)) return {status:'unknown',requestId:input.requestId,handoffId:handle,
        ...protectedMutationRecovery(input)};
      const response=validateApprovalResponse(request,readApprovalResponse(input.home,input.profile.id,handle));
      await verifyApprovalSignature(request,response,input.env);
      const proof={challengeId:response.challengeId,message:response.message,signature:response.signature};
      try {
        const sent=await input.send(proof); // One exact same-key replay; Marketplace owns admission and effects.
        if (sent.command) {
          saved={...saved,commandPointer:sent.command};
          input.store.setHandoffState(input.profile.id,handle,'COMMAND_PENDING',JSON.stringify(saved));
          return resumeProtectedCommand(input,handle,requestHash,saved,sent.command);
        }
        return completeProtectedMutation(input,handle,request,requestHash,input.payload,saved.context,sent.json);
      } catch (error) {
        const pointer=commandPointerFromError(error);
        if (pointer) {
          saved={...saved,commandPointer:pointer};
          input.store.setHandoffState(input.profile.id,handle,'COMMAND_PENDING',JSON.stringify(saved));
        }
        throw error;
      }
    }
    return {status:'unknown',requestId:input.requestId,handoffId:handle,...protectedMutationRecovery(input)};
  }
  if (handoff.state==='EXPIRED') throw new ProfileError('APPROVAL_EXPIRED','This exact approval has expired. Inspect its resource state, then use a new request ID only when the operation is known not to have been applied.');
  if (handoff.state==='PREPARING') {
    let context=await input.prepare?.();
    const challengeResponse=await input.api.request(input.challengePath,{method:'POST',body:input.challengeBody});
    const extracted=input.challengeResponse?.(challengeResponse.json,context);
    if (extracted) context=extracted.context;
    const parsed=approvalChallenge.safeParse(extracted?.challenge??challengeResponse.json);
    if (!parsed.success || Date.parse(parsed.data.expiresAt)<=Date.now()
      || Date.parse(parsed.data.expiresAt)-Date.parse(parsed.data.issuedAt)>300_000) {
      throw new MarketplaceApiError('APPROVAL_CHALLENGE','Marketplace returned an invalid or expired controller approval challenge.');
    }
    const request:MarketplaceProofApprovalRequest={version:1,type:'marketplace-controller-approval-request',
      profileId:input.profile.id,handoffId:handle,marketplaceOrigin:input.profile.origin,transport:'AGENT_API',proofOrigin:null,
      audience:input.profile.audience,accountId:input.profile.accountId,identityId:input.profile.identityId,
      controller:{network:input.profile.controllerNetwork,address:input.profile.controllerAddress,index:input.profile.controllerIndex},
      purpose:input.purpose,action:input.makeAction(parsed.data,context),challenge:parsed.data};
    saved={command:input.payload,request,requestHash,context};
    input.store.setHandoffState(input.profile.id,handle,'WAITING_APPROVAL',JSON.stringify(saved));
    handoff=input.store.getHandoff(input.profile.id,handle);
  }
  if (handoff.state!=='WAITING_APPROVAL') throw new ProfileError('APPROVAL_STATE','This controller approval is not ready for the requested action. Use the original request ID to recover it.');
  saved=asRecord(JSON.parse(handoff.privatePayload));
  if (saved.requestHash!==requestHash || mutationHash(saved.command)!==mutationHash(input.payload)) {
    throw new ProfileError('IDEMPOTENCY_CONFLICT','This request ID is already bound to different protected Marketplace action content.');
  }
  const request=parseApprovalRequest(saved.request);
  if (Date.parse(request.challenge.expiresAt)<=Date.now()) {
    input.store.setHandoffState(input.profile.id,handle,'EXPIRED');
    throw new ProfileError('APPROVAL_EXPIRED','This exact approval has expired. Inspect its resource state, then retry only with a new request ID.');
  }
  const path=await writeApprovalRequest(input.home,input.profile.id,handle,request);
  const responsePath=approvalRequestPath(input.home,input.profile.id,handle).replace(/\.request\.json$/,'.response.json');
  if (!existsSync(responsePath)) return approvalRequired(input.requestId,handle,request,path);
  const response=validateApprovalResponse(request,readApprovalResponse(input.home,input.profile.id,handle));
  await verifyApprovalSignature(request,response,input.env);
  if (!input.store.claimHandoff(input.profile.id,handle,'WAITING_APPROVAL','SUBMITTING')) {
    throw new ProfileError('MUTATION_IN_PROGRESS','Another Marketplace MCP process is submitting this exact approved action. Retry after it completes.');
  }
  const proof={challengeId:response.challengeId,message:response.message,signature:response.signature};
  try {
    const sent=await input.send(proof);
    if (sent.command) {
      saved={...saved,commandPointer:sent.command};
      input.store.setHandoffState(input.profile.id,handle,'COMMAND_PENDING',JSON.stringify(saved));
      return resumeProtectedCommand(input,handle,requestHash,saved,sent.command);
    }
    return completeProtectedMutation(input,handle,request,requestHash,input.payload,saved.context,sent.json);
  } catch (error) {
    const pointer=commandPointerFromError(error);
    if (pointer) {
      saved={...saved,commandPointer:pointer};
      input.store.setHandoffState(input.profile.id,handle,'COMMAND_PENDING',JSON.stringify(saved));
      throw error;
    }
    input.store.setHandoffState(input.profile.id,handle,'UNKNOWN',JSON.stringify(saved));
    const recovery=protectedMutationRecovery(input);
    throw new ProfileError('MUTATION_UNKNOWN',`Marketplace may have applied this signed operation. Use ${String(recovery.reconciliationTool)} to reconcile it. ${String(recovery.next)}`);
  }
}

function isShopFinancialProof(operation:string):boolean {
  return operation==='product-purchase' || operation==='product-refund';
}

async function resumeProtectedCommand(input:FreshProofMutationInput,handle:string,requestHash:string,
  saved:Record<string,unknown>,pointer:MarketplaceCommandPointer):Promise<unknown> {
  try {
    const completed=await input.api.resumeCommand(pointer);
    return completeProtectedMutation(input,handle,parseApprovalRequest(saved.request),requestHash,
      saved.command??input.payload,saved.context,completed.json);
  } catch(error) {
    if (!isShopFinancialProof(input.operation) || !(error instanceof MarketplaceApiError)
      || error.details?.terminal!==true || error.details.commandId!==pointer.commandId
      || error.details.statusUrl!==pointer.statusUrl) throw error;
    const result={status:'rejected',requestId:input.requestId,commandId:pointer.commandId,
      errorCode:error.code,httpStatus:error.httpStatus??409};
    input.store.setHandoffState(input.profile.id,handle,'COMPLETE',JSON.stringify({...saved,result}));
    input.store.completeMutation(input.profile.id,input.requestId,requestHash,handle);
    return result;
  }
}

function completeProtectedMutation(input:FreshProofMutationInput,handle:string,request:MarketplaceProofApprovalRequest,
  requestHash:string,command:unknown,context:unknown,serverResponse:unknown):unknown {
  const result=input.result?input.result(serverResponse,context):safeMutationResult(serverResponse);
  input.store.setHandoffState(input.profile.id,handle,'COMPLETE',JSON.stringify({request,command,requestHash,result}));
  input.store.completeMutation(input.profile.id,input.requestId,requestHash,handle);
  return result;
}

function protectedMutationRecovery(input:FreshProofMutationInput):Record<string,unknown> {
  if(input.operation==='product-purchase') return {
    reconciliationTool:'marketplace_purchases_list',releaseId:input.target,
    next:'Inspect this account’s purchases for the exact original release and original purchase command. Keep the saved requestId and handoff; do not start another purchase while this signed submission is uncertain.'};
  if(input.operation==='product-refund') return {
    reconciliationTool:'marketplace_purchase_get',
    purchaseId:input.target,
    next:'Inspect this original order for status REFUNDED and its stable refundCommandId. Keep the saved requestId and handoff; do not start another refund while this signed submission is uncertain.'};
  if (input.operation.startsWith('credential-')) {
    const credential=asRecord(asRecord(input.payload).credential ?? {});
    const operation=input.operation.slice('credential-'.length).toUpperCase();
    const target=input.operation==='credential-create'?undefined:input.target;
    const name=input.operation==='credential-create' && typeof credential.name==='string'?credential.name:undefined;
    let next:string;
    if (operation==='CREATE') {
      next='Inspect this credential name in the metadata list. A committed one-time key whose response was lost cannot be retrieved or activated from metadata. If it exists, use its safe apiKeyId to request an explicitly approved rotation or revocation, then create or activate a replacement as appropriate. If the operation is absent, retry only after confirming that no credential was created.';
    } else if (operation==='ROTATE') {
      next='Inspect the target credential and its active successor in the metadata list. A lost one-time rotated key cannot be retrieved or activated. If rotation committed, explicitly approve a new rotation of the active successor to save a fresh key; if the target remains active, retry only after confirming no effect and use a fresh request ID.';
    } else {
      next='Inspect the target credential’s revokedAt value in the metadata list. If it is still active, retry only after confirming no effect and use a fresh request ID; if revoked, no replacement is needed.';
    }
    return {reconciliationTool:'marketplace_credentials_list',...(target?{targetApiKeyId:target}:{}),...(name?{credentialName:name}:{}),next};
  }
  if (input.operation.startsWith('withdrawal-')) return {
    reconciliationTool:'marketplace_withdrawals_list',
    next:'Inspect this account’s withdrawal list for the original action. Do not create another request while its outcome is unknown.'};
  return {reconciliationTool:'marketplace_payout_addresses_list',alsoReadTool:'marketplace_payout_selection_get',
    next:'Inspect the payout-address list and current selection for the original action. Do not create another request while its outcome is unknown.'};
}

function approvalRequired(requestId:string,handle:string,request:MarketplaceProofApprovalRequest,path:string):Record<string,unknown> {
  return {status:'approval_required',requestId,handoffId:handle,purpose:request.purpose,expiresAt:request.challenge.expiresAt,
    walletCommand:`atto-marketplace-mcp approve ${shellQuote(path)}`,
    next:'Run this exact command in a local wallet terminal, then call the same Marketplace tool again with the identical request ID and action. The signed response remains in the private profile directory.'};
}

function parseApprovalRequest(value:unknown):MarketplaceProofApprovalRequest {
  const request=asRecord(value);
  const controller=asRecord(request.controller);
  if (request.version!==1 || request.type!=='marketplace-controller-approval-request'
    || typeof request.profileId!=='string' || typeof request.handoffId!=='string'
    || typeof request.marketplaceOrigin!=='string' || request.transport!=='AGENT_API' || request.proofOrigin!==null
    || typeof request.audience!=='string' || typeof request.purpose!=='string'
    || (controller.network!=='ATTO' && controller.network!=='NANO')
    || !request.challenge || typeof request.action!=='object') {
    throw new ProfileError('APPROVAL_FILE','The saved typed wallet approval request is invalid.');
  }
  return request as unknown as MarketplaceProofApprovalRequest;
}

function safeMutationResult(value:unknown):Record<string,unknown> {
  const record=asRecord(value);
  const safe=Object.fromEntries(Object.entries(record).filter(([key])=>/^(?:apiKeyId|result|replayed|destinationId|selectionVersion|withdrawalId|asset|network|atomicAmount|destinationVersion|destinationAddress|state|createdAt|updatedAt)$/.test(key)));
  return redact(safe,true) as Record<string,unknown>;
}

function shellQuote(value:string):string { return `'${value.replace(/'/g,"'\\''")}'`; }
