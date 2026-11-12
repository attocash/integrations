import { defaultMarketplaceHome } from './defaults.js';
import { marketplaceCommand, shellQuote } from './shell-quote.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ProfileError, MarketplaceProfileStore, type NewProfile } from './profile-store.js';
import { approvalRequestPath, readApprovalResponse, validateApprovalResponse, verifyApprovalSignature, writeApprovalRequest,
  type MarketplaceProofApprovalRequest } from './approval-files.js';
import { apiUrl, MarketplaceApiError, signerApiError } from './marketplace-api.js';
import { managedWalletEnvironment } from './wallet-home.js';
import { validateTypedApproval } from './approval-validation.js';

const scopeNames = new Set([
  'tasks:read','applications:read','applications:apply','applications:withdraw','tasks:draft:write','tasks:publish',
  'submissions:read','submissions:write','activity:read','activity:write','balances:read',
  'files:read','files:write','products:read','products:write','products:publish','products:purchase',
  'purchases:read','purchases:refund',
]);
const requestTimeoutMs=15_000;
const responseLimit=1_048_576;

interface SetupOptions {
  profile?:string;
  home?:string;
  origin?:string;
  audience?:string;
  controllerAddress?:string;
  controllerIndex?:number;
  controllerNetwork?:'ATTO'|'NANO';
  mode?:'controller-session'|'scoped-api-key';
  complete:boolean;
  reauthenticate:boolean;
  status:boolean;
  fromProfile?:string;
  credentialId?:string;
  credentialName?:string;
  expiresInDays?:number;
  scopes:string[];
  publishAttoLimit?:string;
  publishXnoLimit?:string;
  productPublishAttoLimit?:string;
  productPublishXnoLimit?:string;
  applyAttoLimit?:string;
  applyXnoLimit?:string;
  purchaseAttoLimit?:string;
  purchaseXnoLimit?:string;
}

export async function runSetup(argv:string[],env:NodeJS.ProcessEnv):Promise<void> {
  const options=parseSetupArgs(argv);
  const home=resolve(options.home ?? env.MARKETPLACE_MCP_HOME ?? defaultMarketplaceHome(env));
  env=managedWalletEnvironment(home,env);
  if (!options.profile) throw setupUsage('Choose a private profile ID with --profile.');
  const store=await MarketplaceProfileStore.open(home);
  try {
    if (options.fromProfile || options.credentialId) {
      activateCredential(store,options);
      return;
    }
    if (options.status) {
      reportSetupStatus(store,options.profile,home);
      return;
    }
    if (options.reauthenticate) {
      await reauthenticate(store,options.profile,home,env);
      return;
    }
    if (options.complete) {
      await completeSetup(store,options.profile,home,env);
      return;
    }
    await beginSetup(store,options,home,env);
  } finally { store.close(); }
}

async function reauthenticate(store:MarketplaceProfileStore,profileId:string,home:string,env:NodeJS.ProcessEnv):Promise<void> {
  const profile=store.getProfile(profileId);
  if(profile.authMode!=='controller-session')throw new ProfileError('AUTH_MODE','Reauthentication requires the original controller-session profile. Scoped credentials must be replaced through their credential workflow.');
  const pending=store.getSetupState(profileId);
  if(pending&&asRecord(JSON.parse(pending.privatePayload)).reauthenticate!==true)throw new ProfileError('SETUP_IN_PROGRESS','Complete the original setup before reauthenticating this profile.');
  const challenge=parseChallenge(await requestJson(profile.origin,'/v1/agent/auth/challenges',{network:profile.controllerNetwork,address:profile.controllerAddress}));
  validateLoginChallenge(challenge,profile.controllerNetwork,profile.controllerAddress,profile.audience);
  if(challenge.accountId!==profile.accountId||challenge.controllerId!==profile.identityId)throw new ProfileError('PROFILE_CONFLICT','Marketplace returned a challenge for a different account or controller. The original profile was preserved.');
  const payload=JSON.stringify({profileId,origin:profile.origin,audience:profile.audience,controllerNetwork:profile.controllerNetwork,
    controllerAddress:profile.controllerAddress,controllerIndex:profile.controllerIndex,mode:'controller-session',reauthenticate:true,challenge});
  store.startReauthentication(profileId,payload,pending?.privatePayload??null);
  await completeSetup(store,profileId,home,env);
}

async function beginSetup(store:MarketplaceProfileStore,options:SetupOptions,home:string,env:NodeJS.ProcessEnv):Promise<void> {
  const profileId=required(options.profile,'profile');
  if (store.listProfileIds().includes(profileId)) throw new ProfileError('PROFILE_EXISTS','This profile ID is already configured. Use --reauthenticate to renew its controller session while keeping its journals.');
  if (store.getSetupState(profileId)) throw new ProfileError('SETUP_IN_PROGRESS',`This setup has a pending private approval. Continue with: ${marketplaceCommand} setup --profile ${profileId} --complete --home ${shellQuote(home)}`);
  const origin=normalizeOrigin(required(options.origin,'origin'));
  const audience=required(options.audience,'audience');
  if (audience.length>255 || /[\r\n\0]/.test(audience) || audience.trim()!==audience) throw setupUsage('Use the exact configured Agent API audience as one nonempty line of at most 255 characters.');
  const controllerAddress=required(options.controllerAddress,'controller address');
  const controllerNetwork=options.controllerNetwork??'ATTO';
  if (controllerNetwork==='ATTO'?!/^atto:\/\/[a-z2-7]{61}$/.test(controllerAddress):!/^(?:nano|xrb)_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/.test(controllerAddress)) {
    throw setupUsage(`The controller address must be a canonical ${controllerNetwork==='ATTO'?'Atto':'Nano'} address.`);
  }
  const controllerIndex=options.controllerIndex;
  const maximumIndex=controllerNetwork==='ATTO'?0x7fff_ffff:0xffff_ffff;
  if (!Number.isSafeInteger(controllerIndex) || controllerIndex===undefined || controllerIndex<0 || controllerIndex>maximumIndex) throw setupUsage(`Choose the selected ${controllerNetwork==='ATTO'?'Atto':'Nano'} wallet derivation index from 0 through ${maximumIndex}.`);
  const mode=options.mode;
  if (!mode) throw setupUsage('Choose one explicit auth mode: --mode controller-session or --mode scoped-api-key.');
  const credential=mode==='scoped-api-key'?parseCredentialSetup(options):undefined;
  if (mode==='controller-session' && (options.scopes.length || options.credentialName || options.publishAttoLimit || options.publishXnoLimit
    || options.productPublishAttoLimit || options.productPublishXnoLimit || options.applyAttoLimit || options.applyXnoLimit
    || options.purchaseAttoLimit || options.purchaseXnoLimit)) {
    throw setupUsage('Scoped API grants and ceilings can only be supplied with --mode scoped-api-key.');
  }
  const challenge=await requestJson(origin,'/v1/agent/auth/challenges',{network:controllerNetwork,address:controllerAddress});
  const loginChallenge=parseChallenge(challenge);
  validateLoginChallenge(loginChallenge,controllerNetwork,controllerAddress,audience);
  store.createSetupState(profileId,'LOGIN_READY',JSON.stringify({profileId,origin,audience,controllerNetwork,controllerAddress,controllerIndex,mode,
    ...(credential?{credential}:{}),challenge:loginChallenge}));
  await completeSetup(store,profileId,home,env);
}

async function completeSetup(store:MarketplaceProfileStore,profileId:string,home:string,env:NodeJS.ProcessEnv):Promise<void> {
  const existing=store.listProfileIds().includes(profileId)?store.getProfile(profileId):undefined;
  const pending=store.getSetupState(profileId);
  if (!pending) {
    if (!existing) throw new ProfileError('SETUP_REQUIRED',`No pending setup exists for this profile ID. Start with ${marketplaceCommand} setup --profile ${profileId} --home ${shellQuote(home)} and a fresh controller challenge.`);
    if(store.needsReauthentication(profileId))throw new ProfileError('REAUTH_REQUIRED','Run setup --profile '+profileId+' --reauthenticate with the same --home to renew this session and retain its payment journals.');
    printJson({status:'ready',profileId:existing.id,origin:existing.origin,accountId:existing.accountId,authMode:existing.authMode});
    return;
  }
  if (pending.state==='LOGIN_UNKNOWN' || pending.state==='LOGIN_SUBMITTING' || pending.state==='SCOPED_KEY_UNKNOWN'
    || pending.state==='SCOPED_KEY_SUBMITTING' || pending.state==='SCOPED_KEY_CHALLENGE_IN_FLIGHT') {
    if(existing&&asRecord(JSON.parse(pending.privatePayload)).reauthenticate===true)throw new ProfileError('REAUTH_REQUIRED','The last login outcome is unknown. Use --reauthenticate with this same profile and --home for a fresh proof; its payment journals are preserved.');
    throw new ProfileError('SETUP_UNKNOWN','The last setup request may have reached Marketplace. Do not replay it. Start a new setup under a new profile ID after checking the account’s session or credential list.');
  }
  const saved=asRecord(JSON.parse(pending.privatePayload));
  const expectedPayload=saved.reauthenticate===true?pending.privatePayload:undefined;
  if (pending.state==='LOGIN_READY') {
    const challenge=parseChallenge(saved.challenge);
    const controllerNetwork=saved.controllerNetwork==='NANO'?'NANO':'ATTO';
    const controllerAddress=String(saved.controllerAddress);
    const controllerIndex=Number(saved.controllerIndex);
    validateLoginChallenge(challenge,controllerNetwork,controllerAddress,String(saved.audience));
    const handle=randomBytes(16).toString('hex');
    const request=createApprovalRequest({profileId,handoffId:handle,origin:String(saved.origin),audience:String(saved.audience),
      controllerNetwork,controllerAddress,controllerIndex,accountId:challenge.accountId!,identityId:challenge.controllerId!,
      purpose:'login',action:{kind:'login',network:controllerNetwork,address:controllerAddress},challenge});
    if (!store.transitionSetupState(profileId,'LOGIN_READY','LOGIN_APPROVAL',JSON.stringify({...saved,request}),expectedPayload)) {
      throw new ProfileError('SETUP_BUSY','Another local setup process is preparing this exact login challenge. Retry after it finishes.');
    }
    const path=await writeApprovalRequest(home,profileId,handle,request);
    printApprovalInstructions(profileId,handle,path,home,'Approve the exact login in the local Marketplace wallet terminal, then complete this same setup.');
    return;
  }
  if (pending.state==='LOGIN_APPROVAL') {
    const request=parseApprovalRequest(saved.request);
    const challenge=parseChallenge({...request.challenge,accountId:request.accountId,controllerId:request.identityId});
    validateLoginChallenge(challenge,request.controller.network,request.controller.address,request.audience);
    await writeApprovalRequest(home,profileId,request.handoffId,request);
    const response=await readAndValidateResponse(home,profileId,request,env);
    if (!store.transitionSetupState(profileId,'LOGIN_APPROVAL','LOGIN_SUBMITTING',pending.privatePayload,expectedPayload)) {
      throw new ProfileError('SETUP_BUSY','Another local setup process is consuming this exact login approval. Retry after it finishes.');
    }
    let session:Record<string,unknown>;
    try {
      session=asRecord(await requestJson(String(saved.origin),'/v1/agent/auth/sessions',proofBody(response)));
    } catch (error) {
      if (error instanceof MarketplaceApiError && (error.code==='SIGNER_REQUEST_REJECTED' || error.code==='SIGNER_UNAVAILABLE')) {
        store.transitionSetupState(profileId,'LOGIN_SUBMITTING','LOGIN_APPROVAL',pending.privatePayload,expectedPayload);
        throw new ProfileError(error.code,`${error.message} Resume this same setup with --complete while its challenge is valid.`);
      }
      store.transitionSetupState(profileId,'LOGIN_SUBMITTING','LOGIN_UNKNOWN',pending.privatePayload,expectedPayload);
      throw new ProfileError('SETUP_UNKNOWN',saved.reauthenticate===true?'Marketplace may have created a new session. Use --reauthenticate again with this same profile for a fresh proof; its journals are preserved.':'Marketplace may have created a controller session but its tokens were not received. Do not replay this challenge; start a new profile setup.');
    }
    const parsedSession=parseSession(session);
    if (parsedSession.accountId!==challenge.accountId || parsedSession.identityId!==challenge.controllerId) throw setupFailure();
    if (saved.mode==='controller-session') {
    const profile=profileFromSetup(saved,parsedSession);
      if(saved.reauthenticate===true)store.completeReauthentication(profile,pending.privatePayload);
      else{store.createProfile(profile);store.deleteSetupState(profileId);}
      printJson({status:'ready',profileId,origin:profile.origin,accountId:profile.accountId,authMode:profile.authMode,
        controllerNetwork:profile.controllerNetwork,controllerAddress:profile.controllerAddress,controllerIndex:profile.controllerIndex});
      return;
    }
    if (saved.mode!=='scoped-api-key' || !saved.credential) throw new ProfileError('SETUP_STATE','The pending setup has an invalid explicit auth mode.');
    const credential=asRecord(saved.credential);
    const command={operation:'CREATE',idempotencyKey:randomUUID(),credential};
    const setupWithSession={...saved,session:parsedSession,credentialCommand:command};
    if (!store.transitionSetupState(profileId,'LOGIN_SUBMITTING','SCOPED_KEY_PREPARING',JSON.stringify(setupWithSession))) {
      throw new ProfileError('SETUP_BUSY','The completed login no longer owns this scoped-profile setup. Inspect local setup state.');
    }
    await continueScopedSetup(store,profileId,home,'SCOPED_KEY_PREPARING',setupWithSession);
    return;
  }
  if (pending.state==='SCOPED_KEY_PREPARING') {
    await continueScopedSetup(store,profileId,home,pending.state,saved);
    return;
  }
  if (pending.state==='SCOPED_KEY_APPROVAL') {
    const request=parseApprovalRequest(saved.request);
    await writeApprovalRequest(home,profileId,request.handoffId,request);
    const response=await readAndValidateResponse(home,profileId,request,env);
    if (!store.transitionSetupState(profileId,'SCOPED_KEY_APPROVAL','SCOPED_KEY_SUBMITTING',pending.privatePayload,expectedPayload)) {
      throw new ProfileError('SETUP_BUSY','Another local setup process is consuming this exact credential approval. Retry after it finishes.');
    }
    let result:Record<string,unknown>;
    try {
      result=asRecord(await requestJson(String(saved.origin),'/v1/agent/credentials',{
        idempotencyKey:asRecord(saved.credentialCommand).idempotencyKey,
        credential:asRecord(saved.credentialCommand).credential,proof:proofBody(response),
      },String(asRecord(saved.session).accessToken)));
    } catch {
      store.transitionSetupState(profileId,'SCOPED_KEY_SUBMITTING','SCOPED_KEY_UNKNOWN',pending.privatePayload,expectedPayload);
      throw new ProfileError('SETUP_UNKNOWN','Marketplace may have created the one-time scoped key but did not return its secret. Do not replay; start a new setup under another profile ID and inspect credential metadata for cleanup.');
    }
    if (typeof result.apiKey!=='string' || typeof result.apiKeyId!=='string') {
      store.transitionSetupState(profileId,'SCOPED_KEY_SUBMITTING','SCOPED_KEY_UNKNOWN',pending.privatePayload,expectedPayload);
      throw new ProfileError('SETUP_UNKNOWN','Marketplace did not return the one-time scoped credential secret. It will not be reconstructed or exposed. Start a new setup under another profile ID.');
    }
    if (result.apiKey.length<16 || result.apiKey.length>8192 || /[\r\n\0]/.test(result.apiKey)) {
      store.transitionSetupState(profileId,'SCOPED_KEY_SUBMITTING','SCOPED_KEY_UNKNOWN',pending.privatePayload,expectedPayload);
      throw new ProfileError('SETUP_UNKNOWN','Marketplace returned an invalid one-time scoped credential secret. It will not be printed or replayed. Start a new setup under another profile ID.');
    }
    const session=asRecord(saved.session);
    const spec=asRecord(asRecord(saved.credentialCommand).credential);
    const profile=profileFromSetup({...saved,credential:spec},session,result.apiKey);
    store.createProfile(profile);
    store.deleteSetupState(profileId);
    printJson({status:'ready',profileId,origin:profile.origin,accountId:profile.accountId,authMode:profile.authMode,
      apiKeyId:result.apiKeyId,scopes:profile.apiScopes,publishAttoLimit:profile.publishAttoLimit,
      publishXnoLimit:profile.publishXnoLimit,applyAttoLimit:profile.applyAttoLimit,applyXnoLimit:profile.applyXnoLimit,
      productPublishAttoLimit:profile.productPublishAttoLimit,productPublishXnoLimit:profile.productPublishXnoLimit,
      purchaseAttoLimit:profile.purchaseAttoLimit,purchaseXnoLimit:profile.purchaseXnoLimit});
    return;
  }
  throw new ProfileError('SETUP_STATE','This setup state cannot be resumed automatically. Inspect it in the local terminal and use a fresh profile ID if the result is uncertain.');
}

async function continueScopedSetup(store:MarketplaceProfileStore,profileId:string,home:string,state:string,saved:Record<string,unknown>):Promise<void> {
  if (state!=='SCOPED_KEY_PREPARING') throw new ProfileError('SETUP_STATE','The scoped-key setup is not ready for a new approval challenge.');
  const credentialCommand=asRecord(saved.credentialCommand);
  if (!store.transitionSetupState(profileId,'SCOPED_KEY_PREPARING','SCOPED_KEY_CHALLENGE_IN_FLIGHT',JSON.stringify(saved))) {
    throw new ProfileError('SETUP_BUSY','Another local setup process is requesting this scoped-key challenge. Retry after it completes.');
  }
  let challenge:unknown;
  try { challenge=await requestJson(String(saved.origin),'/v1/agent/credentials/challenges',credentialCommand,String(asRecord(saved.session).accessToken)); }
  catch (error) {
    store.transitionSetupState(profileId,'SCOPED_KEY_CHALLENGE_IN_FLIGHT','SCOPED_KEY_PREPARING',JSON.stringify(saved));
    throw error;
  }
  const parsedChallenge=parseChallenge(challenge);
  const controllerIndex=Number(saved.controllerIndex);
  const handle=randomBytes(16).toString('hex');
  const request=createApprovalRequest({profileId,handoffId:handle,origin:String(saved.origin),audience:String(saved.audience),
    accountId:String(asRecord(saved.session).accountId),identityId:String(asRecord(saved.session).identityId),
    controllerNetwork:saved.controllerNetwork==='NANO'?'NANO':'ATTO',controllerAddress:String(saved.controllerAddress),controllerIndex,purpose:'API-key creation',
    action:{kind:'credential',operation:'CREATE',command:credentialCommand},challenge:parsedChallenge});
  const pending={...saved,request};
  if (!store.transitionSetupState(profileId,'SCOPED_KEY_CHALLENGE_IN_FLIGHT','SCOPED_KEY_APPROVAL',JSON.stringify(pending))) {
    throw new ProfileError('SETUP_BUSY','The challenge response no longer owns this setup. Inspect local setup state.');
  }
  const path=await writeApprovalRequest(home,profileId,handle,request);
  printApprovalInstructions(profileId,handle,path,home,'Sign the exact scoped credential grant in the local wallet terminal. Marketplace MCP stores the returned API key directly in this private profile; no secret is printed.');
}

function activateCredential(store:MarketplaceProfileStore,options:SetupOptions):void {
  const newProfileId=required(options.profile,'new profile');
  const sourceProfileId=required(options.fromProfile,'source profile');
  const credentialId=required(options.credentialId,'credential ID');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(credentialId)) throw setupUsage('Choose a canonical API key ID from the local credential-creation result.');
  if (store.listProfileIds().includes(newProfileId)) throw new ProfileError('PROFILE_EXISTS','This profile ID is already configured. Choose a new name for the scoped profile.');
  const source=store.getProfile(sourceProfileId);
  if (source.authMode!=='controller-session') throw new ProfileError('AUTH_MODE','A new scoped API profile can be copied only from an explicitly configured controller-session profile.');
  const saved=store.getIssuedCredential(sourceProfileId,credentialId);
  store.createProfile({id:newProfileId,origin:source.origin,audience:source.audience,accountId:source.accountId,
    agentId:source.agentId,identityId:source.identityId,controllerNetwork:source.controllerNetwork,controllerAddress:source.controllerAddress,
    controllerIndex:source.controllerIndex,authMode:'scoped-api-key',apiKey:saved.apiKey,apiScopes:saved.scopes,
    publishAttoLimit:saved.publishAttoLimit,publishXnoLimit:saved.publishXnoLimit,applyAttoLimit:saved.applyAttoLimit,applyXnoLimit:saved.applyXnoLimit,
    productPublishAttoLimit:saved.productPublishAttoLimit,productPublishXnoLimit:saved.productPublishXnoLimit,
    purchaseAttoLimit:saved.purchaseAttoLimit,purchaseXnoLimit:saved.purchaseXnoLimit});
  store.deleteIssuedCredential(sourceProfileId,credentialId);
  const profile=store.getProfile(newProfileId);
  printJson({status:'ready',profileId:newProfileId,origin:profile.origin,accountId:profile.accountId,authMode:profile.authMode,
    scopes:profile.apiScopes,publishAttoLimit:profile.publishAttoLimit,publishXnoLimit:profile.publishXnoLimit,applyAttoLimit:profile.applyAttoLimit,applyXnoLimit:profile.applyXnoLimit,
    productPublishAttoLimit:profile.productPublishAttoLimit,productPublishXnoLimit:profile.productPublishXnoLimit,
    purchaseAttoLimit:profile.purchaseAttoLimit,purchaseXnoLimit:profile.purchaseXnoLimit});
}

function reportSetupStatus(store:MarketplaceProfileStore,profileId:string,home:string):void {
  const state=store.getSetupState(profileId);
  if (!state) {
    const profile=store.getProfile(profileId);
    printJson({status:'ready',profileId:profile.id,origin:profile.origin,accountId:profile.accountId,authMode:profile.authMode});
    return;
  }
  const saved=asRecord(JSON.parse(state.privatePayload));
  const request=saved.request?parseApprovalRequest(saved.request):undefined;
  printJson({status:state.state,profileId,...(request?{handoffId:request.handoffId,expiresAt:request.challenge.expiresAt,
    walletCommand:`${marketplaceCommand} approve ${shellQuote(approvalRequestPath(home,profileId,request.handoffId))} --home ${shellQuote(home)}`}:{}) ,
    ...(state.state==='LOGIN_READY'?{resumeCommand:`${marketplaceCommand} setup --profile ${profileId} --complete --home ${shellQuote(home)}`}:{}),
    ...(typeof saved.controllerNetwork==='string'?{controllerNetwork:saved.controllerNetwork}:{})});
}

async function readAndValidateResponse(home:string,profileId:string,request:MarketplaceProofApprovalRequest,env:NodeJS.ProcessEnv) {
  if (request.profileId!==profileId) throw new ProfileError('APPROVAL_BINDING','The signed wallet approval belongs to a different local profile.');
  validateTypedApproval(request);
  const response=validateApprovalResponse(request,readApprovalResponse(home,profileId,request.handoffId));
  await verifyApprovalSignature(request,response,env);
  return response;
}

function createApprovalRequest(input:{profileId:string;handoffId:string;origin:string;audience:string;controllerNetwork?:'ATTO'|'NANO';controllerAddress:string;controllerIndex:number;
  accountId?:string;identityId?:string;purpose:string;action:Record<string,unknown>;challenge:ReturnType<typeof parseChallenge>}):MarketplaceProofApprovalRequest {
  return {version:1,type:'marketplace-controller-approval-request',profileId:input.profileId,handoffId:input.handoffId,
    marketplaceOrigin:input.origin,transport:'AGENT_API',proofOrigin:null,audience:input.audience,
    ...(input.accountId?{accountId:input.accountId}:{}),...(input.identityId?{identityId:input.identityId}:{}),
    controller:{network:input.controllerNetwork??'ATTO',address:input.controllerAddress,index:input.controllerIndex},purpose:input.purpose,
    action:input.action,challenge:{challengeId:input.challenge.challengeId,message:input.challenge.message,
      issuedAt:input.challenge.issuedAt,expiresAt:input.challenge.expiresAt}};
}

function profileFromSetup(saved:Record<string,unknown>,session:Record<string,unknown>,apiKey?:string):NewProfile {
  const credential=saved.credential?asRecord(saved.credential):undefined;
  const controllerNetwork=saved.controllerNetwork==='NANO'?'NANO':'ATTO';
  return {id:String(saved.profileId ?? ''),origin:String(saved.origin),audience:String(saved.audience),accountId:String(session.accountId),
    agentId:String(session.agentId),identityId:String(session.identityId),controllerNetwork,
    controllerAddress:String(saved.controllerAddress),controllerIndex:Number(saved.controllerIndex),
    authMode:apiKey?'scoped-api-key':'controller-session',...(apiKey?{apiKey,apiScopes:credential?.scopes as string[] ?? [],
      publishAttoLimit:typeof credential?.publishAttoLimit==='string'?credential.publishAttoLimit:null,
      publishXnoLimit:typeof credential?.publishXnoLimit==='string'?credential.publishXnoLimit:null,
      productPublishAttoLimit:typeof credential?.productPublishAttoLimit==='string'?credential.productPublishAttoLimit:null,
      productPublishXnoLimit:typeof credential?.productPublishXnoLimit==='string'?credential.productPublishXnoLimit:null,
      applyAttoLimit:typeof credential?.applyAttoLimit==='string'?credential.applyAttoLimit:null,
      applyXnoLimit:typeof credential?.applyXnoLimit==='string'?credential.applyXnoLimit:null,
      purchaseAttoLimit:typeof credential?.purchaseAttoLimit==='string'?credential.purchaseAttoLimit:null,
      purchaseXnoLimit:typeof credential?.purchaseXnoLimit==='string'?credential.purchaseXnoLimit:null}:{}),
    ...(apiKey?{}:{accessToken:String(session.accessToken),accessExpiresAt:timestampMillis(session.accessExpiresAt),
      refreshToken:String(session.refreshToken),refreshExpiresAt:timestampMillis(session.refreshExpiresAt)})};
}

function parseSession(input:Record<string,unknown>):Record<string,unknown> {
  for (const name of ['accountId','agentId','identityId']) if (typeof input[name]!=='string' || !isUuid(input[name])) throw setupFailure();
  for (const name of ['accessToken','refreshToken']) if (typeof input[name]!=='string' || (input[name] as string).length<16
    || (input[name] as string).length>8192 || /[\r\n\0]/.test(input[name] as string)) throw setupFailure();
  const accessExpiresAt=dateMillis(input.accessExpiresAt);
  const refreshExpiresAt=dateMillis(input.refreshExpiresAt);
  if (accessExpiresAt<=Date.now() || refreshExpiresAt<accessExpiresAt) throw setupFailure();
  return {...input,accessExpiresAt,refreshExpiresAt};
}

function parseChallenge(input:unknown):{challengeId:string;message:string;issuedAt:string;expiresAt:string;accountId?:string;controllerId?:string} {
  const value=asRecord(input);
  if (!isUuid(value.challengeId) || typeof value.message!=='string' || value.message.length<1 || value.message.length>4096
    || /\0/.test(value.message) || typeof value.issuedAt!=='string' || typeof value.expiresAt!=='string') throw setupFailure();
  const issued=dateMillis(value.issuedAt); const expires=dateMillis(value.expiresAt);
  if (issued>Date.now()+30_000 || expires<=Date.now() || expires<=issued || expires-issued>300_000) throw setupFailure();
  if ((value.accountId!==undefined || value.controllerId!==undefined) && (!isUuid(value.accountId) || !isUuid(value.controllerId))) throw setupFailure();
  return {challengeId:value.challengeId,message:value.message,issuedAt:value.issuedAt,expiresAt:value.expiresAt,
    ...(value.accountId!==undefined?{accountId:value.accountId as string,controllerId:value.controllerId as string}:{})};
}

function validateLoginChallenge(challenge:ReturnType<typeof parseChallenge>,
  network:'ATTO'|'NANO',address:string,audience:string):void {
  const lines=challenge.message.split('\n');
  if (lines.length!==10 || !isUuid(challenge.accountId) || !isUuid(challenge.controllerId) || lines[0]!==`${network==='ATTO'?'':'Nano '}Marketplace Agent Controller Proof v1`
    || proofField(lines[1]??'','Audience')!==audience || proofField(lines[3]??'','Address')!==address
    || proofField(lines[4]??'','Purpose')!=='login' || proofField(lines[5]??'','Request ID')!==challenge.challengeId
    || proofField(lines[6]??'','Binding Hash')!==enrollmentHash(challenge.accountId,challenge.controllerId)
    || !/^[0-9a-f]{64}$/.test(proofField(lines[7]??'','Nonce'))
    || Date.parse(proofField(lines[8]??'','Issued At'))!==Date.parse(challenge.issuedAt)
    || Date.parse(proofField(lines[9]??'','Expiration Time'))!==Date.parse(challenge.expiresAt)) throw setupFailure();
  const proofNetwork=proofField(lines[2]??'','Network');
  if (network==='ATTO'?!['live','beta','dev','local'].includes(proofNetwork):!['nano:mainnet','nano:beta','nano:dev'].includes(proofNetwork)) throw setupFailure();
}

function enrollmentHash(accountId:string,controllerId:string):string {
  return createHash('sha256').update(['signer-controller-enrollment-v1',accountId,controllerId].join('\n'),'utf8').digest('hex');
}

function proofField(line:string,label:string):string {
  const prefix=`${label}: `;
  if (!line.startsWith(prefix) || line.length===prefix.length || /[\r\0]/.test(line)) throw setupFailure();
  return line.slice(prefix.length);
}

function parseApprovalRequest(input:unknown):MarketplaceProofApprovalRequest {
  const value=asRecord(input);
  if (value.version!==1 || value.type!=='marketplace-controller-approval-request'
    || typeof value.profileId!=='string' || typeof value.handoffId!=='string' || typeof value.marketplaceOrigin!=='string'
    || value.transport!=='AGENT_API' || value.proofOrigin!==null || typeof value.audience!=='string'
    || typeof value.purpose!=='string' || !value.controller || !value.challenge || !value.action) throw setupFailure();
  return value as unknown as MarketplaceProofApprovalRequest;
}

function parseCredentialSetup(options:SetupOptions):Record<string,unknown> {
  const name=options.credentialName?.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g,'');
  const scopes=options.scopes;
  const expiresInDays=options.expiresInDays??90;
  if (!name || name.length>64 || /[\x00-\x1f\x7f]/.test(name) || scopes.length===0 || new Set(scopes).size!==scopes.length
    || scopes.some(scope=>!scopeNames.has(scope)) || !Number.isSafeInteger(expiresInDays) || expiresInDays<1 || expiresInDays>365) {
    throw setupUsage('Scoped setup needs --credential-name, one or more exact --scope values, and --expires-in-days from 1 through 365.');
  }
  for (const limit of [options.publishAttoLimit,options.publishXnoLimit,options.productPublishAttoLimit,options.productPublishXnoLimit,
    options.applyAttoLimit,options.applyXnoLimit,
    options.purchaseAttoLimit,options.purchaseXnoLimit]) {
    if (limit!==undefined && !/^[1-9][0-9]{0,64}$/.test(limit)) throw setupUsage('Credential ceilings must be positive exact decimal atomic strings.');
  }
  const publish=scopes.includes('tasks:publish'); const productPublish=scopes.includes('products:publish');
  const apply=scopes.includes('applications:apply');
  const purchase=scopes.includes('products:purchase');
  if (publish!==Boolean(options.publishAttoLimit||options.publishXnoLimit) || apply!==Boolean(options.applyAttoLimit||options.applyXnoLimit)
    || (Boolean(options.productPublishAttoLimit||options.productPublishXnoLimit) && !productPublish)
    || purchase!==Boolean(options.purchaseAttoLimit||options.purchaseXnoLimit)) {
    throw setupUsage('tasks:publish, applications:apply, and products:purchase require their matching ATTO and/or XNO ceiling; product publication ceilings require products:publish. Irrelevant ceilings are rejected.');
  }
  return {name,expiresInDays,scopes:[...scopes].sort(),...(options.publishAttoLimit?{publishAttoLimit:options.publishAttoLimit}:{}),
    ...(options.publishXnoLimit?{publishXnoLimit:options.publishXnoLimit}:{}),...(options.applyAttoLimit?{applyAttoLimit:options.applyAttoLimit}:{}),
    ...(options.productPublishAttoLimit?{productPublishAttoLimit:options.productPublishAttoLimit}:{}),
    ...(options.productPublishXnoLimit?{productPublishXnoLimit:options.productPublishXnoLimit}:{}),
    ...(options.applyXnoLimit?{applyXnoLimit:options.applyXnoLimit}:{}),
    ...(options.purchaseAttoLimit?{purchaseAttoLimit:options.purchaseAttoLimit}:{}),
    ...(options.purchaseXnoLimit?{purchaseXnoLimit:options.purchaseXnoLimit}:{})};
}

function proofBody(response:{challengeId:string;message:string;signature:string}):Record<string,string> {
  return {challengeId:response.challengeId,message:response.message,signature:response.signature};
}

async function requestJson(origin:string,path:string,body:unknown,bearer?:string):Promise<unknown> {
  const headers:Record<string,string>={accept:'application/json','content-type':'application/json'};
  if (bearer) headers.authorization=`Bearer ${bearer}`;
  let response:Response;
  try {
    response=await fetch(apiUrl(normalizeOrigin(origin),path),{method:'POST',headers,body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(requestTimeoutMs)});
  } catch { throw new ProfileError('SETUP_NETWORK','The pinned Marketplace setup endpoint could not be reached. The request was not automatically replayed.'); }
  if (response.url && new URL(response.url).origin!==normalizeOrigin(origin)) { await response.body?.cancel().catch(()=>undefined); throw setupFailure(); }
  const text=await boundedText(response);
  let value:unknown=null;
  if (text) { try { value=JSON.parse(text); } catch { throw setupFailure(); } }
  const signerError=signerApiError(response.status,value);
  if (signerError) throw signerError;
  if (![200,201].includes(response.status)) throw new ProfileError('SETUP_HTTP',`Marketplace setup returned HTTP ${response.status}. Check the pinned origin, audience and local approval, then reconcile before retrying.`);
  return value;
}

async function boundedText(response:Response):Promise<string> {
  if (!response.body) return '';
  const reader=response.body.getReader(); const chunks:Uint8Array[]=[]; let size=0;
  try {
    for (;;) { const {done,value}=await reader.read(); if (done) break; size+=value.byteLength; if (size>responseLimit) throw setupFailure(); chunks.push(value); }
    return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
  } catch { await reader.cancel().catch(()=>undefined); throw setupFailure(); }
  finally { reader.releaseLock(); }
}

function parseSetupArgs(argv:string[]):SetupOptions {
  const result:SetupOptions={complete:false,reauthenticate:false,status:false,scopes:[]};
  for (let index=0;index<argv.length;index++) {
    const arg=argv[index]!; const value=()=>{const next=argv[++index];if(!next)throw setupUsage(`Missing value for ${arg}.`);return next;};
    switch(arg) {
      case '--profile': result.profile=value(); break;
      case '--home': result.home=value(); break;
      case '--origin': result.origin=value(); break;
      case '--audience': result.audience=value(); break;
      case '--controller-address': result.controllerAddress=value(); break;
      case '--controller-index': {const number=Number(value());if(!Number.isSafeInteger(number))throw setupUsage('Controller index must be an integer.');result.controllerIndex=number;break;}
      case '--controller-network': {const network=value();if(network!=='ATTO'&&network!=='NANO')throw setupUsage('Controller network must be ATTO or NANO.');result.controllerNetwork=network;break;}
      case '--mode': {const mode=value();if(mode!=='controller-session'&&mode!=='scoped-api-key')throw setupUsage('Choose controller-session or scoped-api-key.');result.mode=mode;break;}
      case '--complete': result.complete=true; break;
      case '--reauthenticate': result.reauthenticate=true; break;
      case '--status': result.status=true; break;
      case '--from-profile': result.fromProfile=value(); break;
      case '--credential-id': result.credentialId=value(); break;
      case '--credential-name': result.credentialName=value(); break;
      case '--expires-in-days': {const number=Number(value());if(!Number.isSafeInteger(number))throw setupUsage('Expiry must be an integer.');result.expiresInDays=number;break;}
      case '--scope': result.scopes.push(value()); break;
      case '--publish-atto-limit': result.publishAttoLimit=value(); break;
      case '--publish-xno-limit': result.publishXnoLimit=value(); break;
      case '--product-publish-atto-limit': result.productPublishAttoLimit=value(); break;
      case '--product-publish-xno-limit': result.productPublishXnoLimit=value(); break;
      case '--apply-atto-limit': result.applyAttoLimit=value(); break;
      case '--apply-xno-limit': result.applyXnoLimit=value(); break;
      case '--purchase-atto-limit': result.purchaseAttoLimit=value(); break;
      case '--purchase-xno-limit': result.purchaseXnoLimit=value(); break;
      default: throw setupUsage(`Unknown setup option: ${arg}`);
    }
  }
  if (result.profile && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(result.profile)) throw setupUsage('Profile IDs must be 1 to 48 letters, digits, underscores or hyphens.');
  if (result.fromProfile && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(result.fromProfile)) throw setupUsage('Source profile IDs must be 1 to 48 letters, digits, underscores or hyphens.');
  if (result.home && (result.home.includes('\0')||result.home.length>2048)) throw setupUsage('Private profile directory path is invalid.');
  if (result.reauthenticate && argv.some(arg=>!['--reauthenticate','--profile','--home',result.profile,result.home].includes(arg))) throw setupUsage('Reauthentication only takes --profile, --reauthenticate and optional --home; it preserves the saved account and controller.');
  if (result.complete&&result.status) throw setupUsage('Choose either --complete or --status.');
  if ((result.fromProfile||result.credentialId)&&!(result.fromProfile&&result.credentialId)) throw setupUsage('Credential activation needs both --from-profile and --credential-id.');
  if ((result.fromProfile||result.credentialId)&&(result.complete||result.status||result.origin||result.audience||result.mode||result.controllerAddress||result.controllerIndex!==undefined||result.controllerNetwork)) throw setupUsage('Credential activation only takes --profile, --from-profile, --credential-id and optional --home.');
  return result;
}

function normalizeOrigin(value:string):string {
  let url:URL;try{url=new URL(value);}catch{throw setupUsage('Marketplace origin must be an absolute HTTPS origin.');}
  const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname.toLowerCase());
  if (url.username||url.password||url.pathname!=='/'||url.search||url.hash||(url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback))) throw setupUsage('Marketplace origin must be HTTPS; HTTP is allowed only for loopback development.');
  return url.origin;
}

function dateMillis(value:unknown):number {
  if(typeof value!=='string')throw setupFailure();const timestamp=Date.parse(value);if(!Number.isSafeInteger(timestamp)||timestamp<=0)throw setupFailure();return timestamp;
}
function timestampMillis(value:unknown):number {if(typeof value==='number'&&Number.isSafeInteger(value)&&value>0)return value;return dateMillis(value);}
function isUuid(value:unknown):value is string {return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);}
function asRecord(value:unknown):Record<string,unknown>{if(value===null||typeof value!=='object'||Array.isArray(value))throw setupFailure();return value as Record<string,unknown>;}
function required(value:string|undefined,label:string):string{if(!value)throw setupUsage(`Provide --${label.replaceAll(' ','-')}.`);return value;}
function printApprovalInstructions(profileId:string,handle:string,path:string,home:string,next:string):void {
  printJson({status:'approval_required',profileId,handoffId:handle,walletCommand:`${marketplaceCommand} approve ${shellQuote(path)} --home ${shellQuote(home)}`,
    resumeCommand:`${marketplaceCommand} setup --profile ${profileId} --complete --home ${shellQuote(home)}`,next});
}
function printJson(value:unknown):void {process.stdout.write(`${JSON.stringify(value)}\n`);}
function setupUsage(message:string):ProfileError{return new ProfileError('SETUP_USAGE',message);}
function setupFailure():ProfileError{return new ProfileError('SETUP_PROTOCOL','Marketplace setup returned an invalid response. Check the pinned origin and repeat only after confirming the previous action had no effect.');}
