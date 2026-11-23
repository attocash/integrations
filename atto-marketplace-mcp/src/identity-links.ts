import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { approvalResponseIsAbsent, readApprovalResponse, validateApprovalResponse, verifyApprovalSignature,
  writeApprovalRequest, type MarketplaceProofApprovalRequest } from './approval-files.js';
import { validateTypedApproval } from './approval-validation.js';
import { mutationHash } from './canonical-json.js';
import { MarketplaceApiClient, MarketplaceApiError } from './marketplace-api.js';
import { parseMarketplaceDto, uuid } from './marketplace-results.js';
import { MarketplaceProfileStore, ProfileError, requireSession, type MarketplaceProfile } from './profile-store.js';
import { marketplaceCommand, shellQuote } from './shell-quote.js';
import { callWallet } from './wallet-process.js';
import { publicWalletIdentity } from './wallet-results.js';

const timestamp = z.string().datetime({offset:true});
const challenge = z.strictObject({challengeId:uuid, message:z.string().min(1).max(4096), issuedAt:timestamp, expiresAt:timestamp});
const identity = z.strictObject({identityId:uuid, network:z.enum(['ATTO','NANO']), address:z.string().min(1).max(128),
  verificationMethod:z.enum(['ATTO_MESSAGE','NANO_NOMS']), createdAt:timestamp, lastVerifiedAt:timestamp, revokedAt:timestamp.nullable().optional()});
const issuedLink = z.discriminatedUnion('status', [
  z.strictObject({status:z.literal('PENDING'), linkId:uuid, authorizingProof:challenge, newIdentityProof:challenge, expiresAt:timestamp}),
  z.strictObject({status:z.literal('COMPLETED'), linkId:uuid, identity}),
]);
const path = '/v1/account/identity-links';
const handle = () => randomBytes(16).toString('hex');
type Asset = 'ATTO' | 'XNO';
type Controller = MarketplaceProofApprovalRequest['controller'];
type Pair = {linkId:string; expiresAt:string; requests:[MarketplaceProofApprovalRequest,MarketplaceProofApprovalRequest]};
type Context = {profiles:MarketplaceProfileStore; profileId:string; api:MarketplaceApiClient; env:NodeJS.ProcessEnv};

function linkedResult(requestId:string, linkId:string, linked:z.infer<typeof identity>, target:Controller) {
  if (linked.address !== target.address || linked.network !== target.network || linked.revokedAt != null
    || linked.verificationMethod !== (target.network === 'ATTO' ? 'ATTO_MESSAGE' : 'NANO_NOMS')) {
    throw new MarketplaceApiError('MARKETPLACE_PROTOCOL', 'Marketplace returned a different or inactive linked identity.');
  }
  return {status:'completed', requestId, linkId, identity:linked};
}

async function selectedWallet(env:NodeJS.ProcessEnv, asset:Asset) {
  const wallet = publicWalletIdentity(await callWallet(env, {asset, operation:'identity.list', input:{}}));
  if (wallet.asset !== asset) throw new ProfileError('WALLET_RESPONSE_INVALID', 'The selected wallet returned a different asset.');
  return wallet;
}

export async function startIdentityLink(ctx:Context, requestId:string, asset:Asset) {
  const profile = ctx.profiles.getProfile(ctx.profileId);
  requireSession(profile);
  const wallet = await selectedWallet(ctx.env, asset);
  const target:Controller = {network:asset === 'ATTO' ? 'ATTO' : 'NANO', address:wallet.address, index:wallet.index};
  if (target.address === profile.controllerAddress) throw new ProfileError('IDENTITY_ALREADY_SELECTED', 'Select a wallet distinct from the current Marketplace controller.');
  let authorizingNetworkId = 'live';
  if (profile.controllerNetwork === 'NANO') {
    const controller = await selectedWallet({...ctx.env, MARKETPLACE_MCP_NANO_WALLET_DATA_DIR:ctx.env.MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR}, 'XNO');
    if (controller.address !== profile.controllerAddress || controller.index !== profile.controllerIndex) {
      throw new ProfileError('APPROVAL_BINDING', 'The selected Nano controller differs from the current Marketplace profile.');
    }
    authorizingNetworkId = controller.network;
  }
  const newIdentityNetworkId = asset === 'ATTO' ? 'live' : wallet.network;
  const targetKey = mutationHash([profile.origin, profile.accountId, profile.identityId, target.network, target.address]);
  const requestHash = mutationHash([targetKey, profile.audience, profile.controllerAddress, profile.controllerIndex, target.index,
    authorizingNetworkId, newIdentityNetworkId]);
  const store = ctx.profiles;
  const mutation = store.beginMutation({profileId:profile.id, requestId, operation:'identity-link', target:targetKey, requestHash}, handle());
  const parent = mutation.resultIdentity!;
  const owner = 'ISSUING:' + handle();
  if (store.reserveIdentityLinkIssue(profile.id, parent, requestHash, targetKey, owner)) {
    try {
      const response = await ctx.api.request(path, {method:'POST', auth:'controller-session', allowStatus:[200,201],
        body:{authorizingIdentityId:profile.identityId, network:target.network, address:target.address}});
      const issued = parseMarketplaceDto(issuedLink, response.json, 'identity link');
      if (issued.status === 'COMPLETED') {
        const result = linkedResult(requestId, issued.linkId, issued.identity, target);
        if (!store.claimHandoff(profile.id, parent, owner, 'COMPLETE', JSON.stringify(result))) throw changed();
      } else {
        const pair = preparePair(profile, target, authorizingNetworkId, newIdentityNetworkId, issued);
        if (!store.claimHandoff(profile.id, parent, owner, 'WAITING_APPROVAL', JSON.stringify(pair), Date.parse(pair.expiresAt))) throw changed();
      }
    } catch (error) {
      store.claimHandoff(profile.id, parent, owner, 'PREPARING', undefined, 0);
      throw error;
    }
  }
  return resumeIdentityLink(ctx, requestId, false);
}

function preparePair(profile:MarketplaceProfile, target:Controller, authorizingNetworkId:string, newIdentityNetworkId:string,
  issued:Extract<z.infer<typeof issuedLink>,{status:'PENDING'}>):Pair {
  const {linkId, expiresAt, authorizingProof, newIdentityProof} = issued;
  if (authorizingProof.challengeId === newIdentityProof.challengeId || Date.parse(expiresAt) <= Date.now()
    || Date.parse(expiresAt) > Math.min(Date.parse(authorizingProof.expiresAt), Date.parse(newIdentityProof.expiresAt))) {
    throw new MarketplaceApiError('APPROVAL_CHALLENGE', 'Marketplace returned inconsistent wallet-link challenges or expiry.');
  }
  const common = {version:1, type:'marketplace-controller-approval-request', profileId:profile.id, marketplaceOrigin:profile.origin,
    transport:'AGENT_API', proofOrigin:null, audience:profile.audience, accountId:profile.accountId, identityId:profile.identityId} as const;
  const action = {kind:'identity-link', linkId, authorizingIdentityId:profile.identityId, authorizingAddress:profile.controllerAddress,
    newIdentityAddress:target.address, authorizingNetworkId, newIdentityNetworkId};
  const authorizer = validateTypedApproval({...common, handoffId:handle(), purpose:'link authorizer', challenge:authorizingProof,
    controller:{network:profile.controllerNetwork, address:profile.controllerAddress, index:profile.controllerIndex},
    action:{...action, operation:'AUTHORIZE'}}, {nativeNetwork:authorizingNetworkId});
  const newIdentity = validateTypedApproval({...common, handoffId:handle(), purpose:'link new identity', challenge:newIdentityProof,
    controller:target, action:{...action, operation:'NEW_IDENTITY'}}, {nativeNetwork:newIdentityNetworkId});
  return {linkId, expiresAt, requests:[authorizer,newIdentity]};
}

export async function resumeIdentityLink(ctx:Context, requestId:string, submit = true) {
  const {profiles:store, profileId} = ctx;
  requireSession(store.getProfile(profileId));
  const mutation = store.getMutationByRequestId(profileId, requestId);
  if (mutation?.operation !== 'identity-link' || !mutation.resultIdentity) {
    throw new ProfileError('LINK_NOT_FOUND', 'Start a wallet identity link and complete it with its original requestId.');
  }
  const parent = mutation.resultIdentity;
  const saved = store.getHandoff(profileId, parent);
  if (saved.kind !== 'IDENTITY_LINK' || saved.requestHash !== mutation.requestHash) throw changed();
  if (saved.state === 'COMPLETE') {
    if (mutation.state !== 'COMPLETE') store.completeMutation(profileId, requestId, mutation.requestHash, parent);
    return JSON.parse(saved.privatePayload);
  }
  const sending = saved.state.startsWith('SUBMITTING:');
  if (sending && Number(saved.state.split(':')[1]) > Date.now() - 60_000) throw changed();
  if (saved.state !== 'WAITING_APPROVAL' && saved.state !== 'UNKNOWN' && !sending) {
    throw new ProfileError('LINK_IN_PROGRESS', 'Retry marketplace_identity_link_start with the original requestId and asset to finish preparing the wallet approvals.');
  }
  const pair:Pair = JSON.parse(saved.privatePayload);
  if (saved.state === 'WAITING_APPROVAL' && Date.parse(pair.expiresAt) <= Date.now()) throw expired();
  const approvals = [];
  for (const request of pair.requests) {
    store.putHandoff(profileId, request.handoffId, 'CONTROLLER_APPROVAL', mutation.requestHash, 'WAITING_APPROVAL',
      JSON.stringify({request}), Date.parse(request.challenge.expiresAt));
    const file = await writeApprovalRequest(store.home, profileId, request.handoffId, request);
    if (approvalResponseIsAbsent(store.home, profileId, request.handoffId)) {
      approvals.push({purpose:request.purpose, handoffId:request.handoffId, address:request.controller.address,
        walletCommand:`${marketplaceCommand} approve ${shellQuote(file)}`});
    }
  }
  if (!submit || approvals.length) return {
    status:approvals.length ? 'approval_required' : 'ready_to_complete', requestId, linkId:pair.linkId, expiresAt:pair.expiresAt, approvals,
    next:'Review and approve each outstanding wallet command separately in a local terminal. Call marketplace_identity_link_complete with this requestId to submit both proofs.',
  };
  const readProof = async (request:MarketplaceProofApprovalRequest) => {
    const response = validateApprovalResponse(request, readApprovalResponse(store.home, profileId, request.handoffId));
    await verifyApprovalSignature(request, response);
    return response;
  };
  const [authorizer, newIdentity] = await Promise.all([readProof(pair.requests[0]), readProof(pair.requests[1])]);
  if (saved.state === 'WAITING_APPROVAL' && Date.parse(pair.expiresAt) <= Date.now()) throw expired();
  const owner = 'SUBMITTING:' + Date.now() + ':' + handle();
  if (!store.claimHandoff(profileId, parent, saved.state, owner)) throw changed();
  // The backend returns the linked identity on exact link-ID replay, including after expiry.
  try {
    const response = await ctx.api.request(`${path}/${pair.linkId}/complete`, {method:'POST', auth:'controller-session', allowStatus:[200],
      body:{authorizingMessage:authorizer.message, authorizingSignature:authorizer.signature,
        newIdentityMessage:newIdentity.message, newIdentitySignature:newIdentity.signature}});
    const linked = parseMarketplaceDto(identity, response.json, 'linked identity');
    const result = linkedResult(requestId, pair.linkId, linked, pair.requests[1].controller);
    if (!store.claimHandoff(profileId, parent, owner, 'COMPLETE', JSON.stringify(result))) throw changed();
    store.completeMutation(profileId, requestId, mutation.requestHash, parent);
    return result;
  } catch (error) {
    store.claimHandoff(profileId, parent, owner, 'UNKNOWN');
    throw error;
  }
}

function changed() { return new ProfileError('LINK_IN_PROGRESS', 'Another process advanced this wallet link. Retry with the original requestId.'); }
function expired() { return new ProfileError('APPROVAL_EXPIRED', 'The wallet link expired before submission. Start a fresh link with a new requestId and approve both new requests.'); }
