import { takeJsonFlag, terminalFields, writeTerminalResult } from './terminal-output.js';
import { defaultMarketplaceHome } from './defaults.js';
import { existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createApplication } from '@attocash/cli/core';
import { signMarketplaceAttoController, signPreauthorizedMarketplaceAttoLogin } from '@attocash/cli/internal-marketplace';
import { loadConfiguration, signMarketplaceNanoController } from '@attocash/atto-marketplace-nano-adapter';
import { MarketplaceProfileStore, ProfileError } from './profile-store.js';
import { managedWalletEnvironment } from './wallet-home.js';
import { canonicalJson } from './canonical-json.js';
import {expiredUnsignedLoginApproval,expiredLoginRetry,walletConsentRequired} from './setup.js';
import { validateTypedApproval } from './approval-validation.js';
import { approvalRequestDigest, approvalRequestPath, approvalResponsePath, approvalResponseIsAbsent, readApprovalRequest, readApprovalResponse,
  validateApprovalResponse, verifyApprovalSignature, writeApprovalResponse, type MarketplaceProofApprovalRequest } from './approval-files.js';

export const approvalUsage = 'atto-marketplace-mcp approve <private-request-file> [--home <private-home>] [--login-authorization <deployment-file>] [--json]';

export interface CombinedWalletConsent {
  expectedPayload:string;
  review:string;
  controller:{directory:string;network:string;address:string;index:number};
  validate():Promise<void>;
  commit(assertCurrent:()=>Promise<void>):Promise<void>;
}

/** Approve the pinned typed request through operator review or a deployment-authorized Atto login. */
export async function approveMarketplaceController(requestPath: string, options: {
  home: string; env: NodeJS.ProcessEnv; json?: boolean; loginAuthorizationFile?: string;
  walletConsent?:CombinedWalletConsent; prompt?: (preview: string) => boolean | Promise<boolean>;
}): Promise<{ responsePath: string; recovered: boolean }> {
  const loginAuthorizationFile = options.loginAuthorizationFile;
  if (loginAuthorizationFile === undefined) requireTerminal();
  const home = resolve(options.home);
  const path = resolve(requestPath);
  const match = /\/approvals\/([A-Za-z0-9][A-Za-z0-9_-]{0,47})\/([a-f0-9]{32})\.request\.json$/.exec(path.split(sep).join('/'));
  if (!match || path !== approvalRequestPath(home, match[1]!, match[2]!)) throw invalid();
  const profileId = match[1]!, handoffId = match[2]!;
  const env = managedWalletEnvironment(home, options.env);
  const request = readApprovalRequest(home, profileId, handoffId);
  validateTypedApproval(request, { allowExpired: true });
  const responsePath = approvalResponsePath(home, profileId, handoffId);
  const recovering = existsSync(responsePath);
  const consent=options.walletConsent;
  const consentStore=await MarketplaceProfileStore.open(home);
  let consentPayload:string|undefined;
  try{
    const setup=consentStore.getSetupState(profileId);
    const saved = setup && JSON.parse(setup.privatePayload);
    if (loginAuthorizationFile !== undefined && (consent || setup?.state !== 'LOGIN_APPROVAL'
      || saved.mode !== 'controller-session' || saved.walletConsent || request.purpose !== 'login'
      || request.action.kind !== 'login' || request.controller.network !== 'ATTO')) {
      throw new ProfileError('LOGIN_AUTHORIZATION_SCOPE', 'Deployment authorization covers only an Atto controller login or reauthentication with existing wallet settings. Use operator review for this request.');
    }
    if(setup&&saved?.walletConsent){
      if(!consent||consent.expectedPayload!==setup.privatePayload||request.purpose!=='login')throw walletConsentRequired(home,profileId);
      consentPayload=setup.privatePayload;
    }else if(consent)throw new ProfileError('APPROVAL_CHANGED','This wallet review no longer owns the pending login.');
  }finally{consentStore.close();}
  if(consentPayload&&!approvalResponseIsAbsent(home,profileId,handoffId))throw walletConsentRequired(home,profileId);
  if(consent&&(consent.controller.address!==request.controller.address||consent.controller.index!==request.controller.index))throw invalid();
  let originalPin = await pinnedProfile(home, request, recovering);
  if(!recovering)await validateFresh(request);
  let expectedSetupPayload=consentPayload;
  let consentPending=Boolean(consentPayload);
  let native:Awaited<ReturnType<typeof nativeIdentity>>=consent
    ? {directory:consent.controller.directory,network:consent.controller.network}:await nativeIdentity(env, request);
  if(consent)await consent.validate();
  validateTypedApproval(request, { nativeNetwork: native.network, allowExpired: true });
  if (recovering) {
    const saved = validateApprovalResponse(request, readApprovalResponse(home, profileId, handoffId));
    await verifyApprovalSignature(request, saved);
    return { responsePath, recovered: true };
  }
  await validateFresh(request, native.network);
  const details = { walletDirectory: native.directory, nativeNetwork: native.network,
    requestDigest: approvalRequestDigest(request), ...request };
  const summary = { marketplaceOrigin: request.marketplaceOrigin, audience: request.audience,
    walletDirectory: native.directory, controllerNetwork: request.controller.network,
    nativeNetwork: native.network, controllerAddress: request.controller.address, controllerIndex: request.controller.index,
    purpose: request.purpose, action: request.action, expiresAt: request.challenge.expiresAt };
  const terms=options.json?JSON.stringify(details,null,2):terminalFields(summary);
  if (loginAuthorizationFile === undefined) {
    const preview=consent
      ? `${consent.review}\n\nReview Marketplace setup:\n${terms}\nThis approval saves the wallet permissions above and signs in to Marketplace with this exact request.`
      : `Review this exact Marketplace controller action:\n${terms}\nThis one-off terminal approval authorizes only these exact typed terms.`;
    const loginReview = request.purpose === 'login'
      ? '\nThe operator can approve this exact request directly or explicitly authorize the agent to enter the confirmation.'
      : '';
    if (!await (options.prompt ?? confirm)(preview + loginReview)) throw new ProfileError('APPROVAL_DECLINED', 'The Marketplace controller approval was declined.');
    requireTerminal();
  }
  const currentRequest = await assertUnchanged();
  await validateFresh(currentRequest, native.network);
  if(consent&&consentPayload){
    await consent.validate();
    await assertCurrentConsent();
    await consent.commit(assertCurrentConsent);
    await consent.validate();
    await assertCurrentConsent();
    const store=await MarketplaceProfileStore.open(home);
    try{
      const saved=JSON.parse(consentPayload) as Record<string,unknown>;delete saved.walletConsent;
      const clearedPayload=JSON.stringify(saved);
      if(!store.transitionSetupState(profileId,'LOGIN_APPROVAL','LOGIN_APPROVAL',clearedPayload,consentPayload))throw new ProfileError('APPROVAL_CHANGED','A newer setup owns this login; approved wallet settings were preserved.');
      expectedSetupPayload=clearedPayload;
    }finally{store.close();}
    consentPending=false;
    originalPin=await pinnedProfile(home,request);
    native=await nativeIdentity(managedWalletEnvironment(home,options.env),request);
    await consent.validate();
    await assertUnchanged();
    await validateFresh(currentRequest,native.network);
  }
  // Never replace a competing response. Its complete terms and signature must match this request.
  if (existsSync(responsePath)) {
    const saved = validateApprovalResponse(currentRequest, readApprovalResponse(home, profileId, handoffId));
    await verifyApprovalSignature(currentRequest, saved);
    return { responsePath, recovered: true };
  }
  let signature: string;
  if (loginAuthorizationFile !== undefined) {
    const response = await signPreauthorizedMarketplaceAttoLogin({
      directory: native.directory, marketplaceHome: home, request: currentRequest, authorizationFile: loginAuthorizationFile,
    });
    signature = response.signature;
  } else if (request.controller.network === 'ATTO') {
    const response = await signMarketplaceAttoController({ directory: native.directory, request: currentRequest, terminalConfirmed: true });
    signature = response.signature;
  } else {
    signature = await signMarketplaceNanoController({ dataDir: native.directory, terminalConfirmed: true, request: {
      origin: request.marketplaceOrigin, network: native.network, address: request.controller.address, index: request.controller.index,
      audience: request.audience, purpose: request.purpose, message: request.challenge.message,
    } });
  }
  await assertUnchanged();
  await validateFresh(currentRequest, native.network);
  const response = { version: 1 as const, type: 'marketplace-controller-approval-response' as const,
    profileId, handoffId, requestDigest: approvalRequestDigest(currentRequest), challengeId: currentRequest.challenge.challengeId,
    message: currentRequest.challenge.message, signature, controllerAddress: currentRequest.controller.address,
    controllerIndex: currentRequest.controller.index };
  await verifyApprovalSignature(currentRequest, response);
  await validateFresh(currentRequest,native.network);
  await writeApprovalResponse(home, currentRequest, response);
  return { responsePath, recovered: false };

  async function assertCurrentConsent():Promise<void>{
    const current=readApprovalRequest(home,profileId,handoffId);
    if(approvalRequestDigest(current)!==approvalRequestDigest(request))throw new ProfileError('APPROVAL_CHANGED','The exact login request changed before wallet commit.');
    const store=await MarketplaceProfileStore.open(home);
    try{
      const pending=store.getSetupState(profileId);
      if(pending?.state!=='LOGIN_APPROVAL'||pending.privatePayload!==consentPayload)throw new ProfileError('APPROVAL_CHANGED','The login setup changed before wallet commit.');
    }finally{store.close();}
    if(!approvalResponseIsAbsent(home,profileId,handoffId))throw new ProfileError('APPROVAL_CHANGED','A login response appeared before wallet consent completed.');
    await validateFresh(current,native.network);
  }

  async function validateFresh(current:MarketplaceProofApprovalRequest,nativeNetwork?:string):Promise<void> {
    try{validateTypedApproval(current,nativeNetwork?{nativeNetwork}:{});}
    catch(error){
      if(error instanceof ProfileError&&error.code==='APPROVAL_EXPIRED'&&current.purpose==='login'){
        const store=await MarketplaceProfileStore.open(home);
        try{
          const expired=expiredUnsignedLoginApproval(store,profileId,home);
          if(expired?.request.handoffId===handoffId)throw expiredLoginRetry(home,profileId);
        }finally{store.close();}
      }
      throw error;
    }
  }

  async function assertUnchanged(): Promise<MarketplaceProofApprovalRequest> {
    if(consent){
      await consent.validate();
      const store=await MarketplaceProfileStore.open(home);
      try{const setup=store.getSetupState(profileId);if(setup?.state!=='LOGIN_APPROVAL'||setup.privatePayload!==expectedSetupPayload)throw new ProfileError('APPROVAL_CHANGED','The reviewed setup payload changed.');}finally{store.close();}
    }
    const currentRequest = readApprovalRequest(home, profileId, handoffId);
    if (approvalRequestDigest(currentRequest) !== approvalRequestDigest(request)
      || await pinnedProfile(home, currentRequest) !== originalPin
      || (!consentPending&&canonicalJson(await nativeIdentity(managedWalletEnvironment(home, options.env), currentRequest)) !== canonicalJson(native))) {
      throw new ProfileError('APPROVAL_CHANGED', 'The request, selected wallet, or pinned Marketplace profile changed during terminal review. Review its current state again.');
    }
    return currentRequest;
  }
}

export async function runApproval(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const selected = takeJsonFlag(argv); argv = selected.argv;
  if (argv.length === 1 && ['--help','-h'].includes(argv[0]!)) { process.stdout.write(`${approvalUsage}\n`); return; }
  const path = argv[0];
  if (!path) throw new ProfileError('SETUP_USAGE', approvalUsage);
  let home: string | undefined;
  let loginAuthorizationFile: string | undefined;
  for (let index = 1; index < argv.length; index++) {
    const option = argv[index];
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new ProfileError('SETUP_USAGE', approvalUsage);
    if (option === '--home' && home === undefined) home = value;
    else if (option === '--login-authorization' && loginAuthorizationFile === undefined) loginAuthorizationFile = value;
    else throw new ProfileError('SETUP_USAGE', approvalUsage);
  }
  home ??= env.MARKETPLACE_MCP_HOME ?? (resolve(path).includes(`${sep}approvals${sep}`)
    ? dirname(dirname(dirname(resolve(path)))) : defaultMarketplaceHome(env));
  const result = await approveMarketplaceController(path, { home, env, json: selected.json, ...(loginAuthorizationFile === undefined ? {} : { loginAuthorizationFile }) });
  writeTerminalResult(result, selected.json);
}

async function pinnedProfile(home: string, request: MarketplaceProofApprovalRequest, recovery = false): Promise<string> {
  const store = await MarketplaceProfileStore.open(home);
  try {
    let pin: Record<string, unknown>;
    let setupPayload:string|undefined;
    const setup = store.getSetupState(request.profileId);
    if ((request.purpose === 'login' && setup) || (setup && !store.listProfileIds().includes(request.profileId))) {
      if (!setup) throw invalid();
      setupPayload=setup.privatePayload;
      const saved = JSON.parse(setup.privatePayload) as Record<string, unknown>;
      const prepared = saved.request as MarketplaceProofApprovalRequest | undefined;
      if (!prepared || approvalRequestDigest(prepared) !== approvalRequestDigest(request)
        || !['LOGIN_APPROVAL','SCOPED_KEY_APPROVAL'].includes(setup.state)) throw invalid();
      const identity = (saved.session ?? saved.challenge) as Record<string, unknown>;
      pin = { origin: saved.origin, audience: saved.audience, accountId: identity.accountId,
        identityId: identity.identityId ?? identity.controllerId, controllerNetwork: saved.controllerNetwork ?? 'ATTO',
        controllerAddress: saved.controllerAddress, controllerIndex: saved.controllerIndex };
      if (store.listProfileIds().includes(request.profileId)) {
        const profile = store.getProfile(request.profileId);
        if (profile.accountId !== pin.accountId || profile.identityId !== pin.identityId
          || profile.origin !== pin.origin || profile.audience !== pin.audience
          || profile.controllerNetwork !== pin.controllerNetwork || profile.controllerAddress !== pin.controllerAddress
          || profile.controllerIndex !== pin.controllerIndex) throw invalid();
      }
    } else {
      const profile = store.getProfile(request.profileId);
      if (profile.authMode !== 'controller-session' && !recovery) throw invalid();
      pin = { origin: profile.origin, audience: profile.audience, accountId: profile.accountId, identityId: profile.identityId,
        controllerNetwork: profile.controllerNetwork, controllerAddress: profile.controllerAddress, controllerIndex: profile.controllerIndex };
      if (!(recovery && request.purpose === 'login')) {
        const handoff = store.getHandoff(request.profileId, request.handoffId);
        const prepared = (JSON.parse(handoff.privatePayload) as Record<string, unknown>).request as MarketplaceProofApprovalRequest;
        if (handoff.kind !== 'CONTROLLER_APPROVAL' || !prepared || approvalRequestDigest(prepared) !== approvalRequestDigest(request)) throw invalid();
      }
    }
    if (pin.origin !== request.marketplaceOrigin || pin.audience !== request.audience
      || pin.accountId !== request.accountId || pin.identityId !== request.identityId
      || pin.controllerNetwork !== request.controller.network || pin.controllerAddress !== request.controller.address
      || pin.controllerIndex !== request.controller.index) throw invalid();
    return canonicalJson({...pin,...(setupPayload?{setupPayload}:{})});
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    throw invalid();
  } finally { store.close(); }
}

async function nativeIdentity(env: NodeJS.ProcessEnv, request: MarketplaceProofApprovalRequest): Promise<{
  directory: string; network: string; configuration?: unknown;
}> {
  if (request.controller.network === 'ATTO') {
    const directory = env.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR!;
    const application = createApplication({ directory });
    try {
      const status = await application.call('wallet_status') as { identity: unknown; settings: unknown;
        addresses: { index: number; address: string }[]; messageSigningIndexes: number[] };
      const controller = status.addresses.find(address => address.index === request.controller.index);
      if (!status.identity || controller?.address !== request.controller.address) throw invalid();
      return { directory, network: 'live', configuration: { identity: status.identity,
        settings: status.settings, controller, messageSigningIndexes: status.messageSigningIndexes } };
    } finally { await application.close(); }
  }
  const directory = env.MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR!;
  const configuration = loadConfiguration(directory);
  if (configuration.sourceAddress !== request.controller.address || configuration.derivationIndex !== request.controller.index
    || configuration.origin !== request.marketplaceOrigin || configuration.audience !== request.audience) throw invalid();
  return { directory, network: configuration.network, configuration };
}

async function confirm(preview: string): Promise<boolean> {
  process.stderr.write(`${preview}\n`);
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try { return (await terminal.question('Type APPROVE to confirm: ')).trim() === 'APPROVE'; }
  finally { terminal.close(); }
}
function requireTerminal(): void {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new ProfileError('TERMINAL_REQUIRED', 'Marketplace controller approvals require an interactive local terminal.');
}
function invalid(): ProfileError {
  return new ProfileError('APPROVAL_BINDING', 'Use the exact private typed request prepared by this pinned Marketplace profile or pending setup.');
}
