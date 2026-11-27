import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  approvalRequestPath, approvalResponseIsAbsent, createApprovalRequest, parseApprovalRequest,
  readApprovalResponse, validateApprovalResponse, verifyApprovalSignature, writeApprovalRequest,
  type MarketplaceProofApprovalRequest,
} from './approval-files.js';
import { validateTypedApproval } from './approval-validation.js';
import { configureBrowserSignIn } from './browser-sign-in.js';
import { defaultMarketplaceHome, loginAuthorizationGuide } from './defaults.js';
import { apiUrl, MarketplaceApiError, readBounded, signerApiError } from './marketplace-api.js';
import {
  type ApprovalChallenge, canonicalHexSignature, CREDENTIAL_SCOPE_SET, isControllerAddress, isPositiveAtomic,
  isProfileId, isUuid, parseChallengeEnvelope, parseIsoDateMillis, parseMarketplaceOrigin,
  trimAsciiControlAndSpace, validateCredentialCeilingRules,
} from './marketplace-validation.js';
import { MarketplaceProfileStore, type NewProfile, ProfileError } from './profile-store.js';
import {
  type ExpiredLoginApproval, expiredLoginRetry, expiredUnsignedLoginApproval, isUnknownSetupState,
  loginResumeCommand, unknownSetupOutcome, walletConsentRequired,
} from './setup-recovery.js';
import { marketplaceCommand, shellQuote } from './shell-quote.js';
import { takeJsonFlag, terminalText, writeTerminalResult } from './terminal-output.js';
import { managedWalletEnvironment } from './wallet-home.js';

export {
  expiredLoginRetry, expiredUnsignedLoginApproval, isUnknownSetupState, unknownSetupOutcome, walletConsentRequired,
} from './setup-recovery.js';

const requestTimeoutMs = 15_000;
const responseLimit = 1_048_576;

interface SetupOptions {
  profile?: string;
  home?: string;
  browserSignIn?: 'enable' | 'disable' | 'status';
  origin?: string;
  audience?: string;
  controllerAddress?: string;
  controllerIndex?: number;
  controllerNetwork?: 'ATTO' | 'NANO';
  mode?: 'controller-session' | 'scoped-api-key';
  complete: boolean;
  reauthenticate: boolean;
  status: boolean;
  fromProfile?: string;
  credentialId?: string;
  credentialName?: string;
  expiresInDays?: number;
  scopes: string[];
  publishAttoLimit?: string;
  publishXnoLimit?: string;
  productPublishAttoLimit?: string;
  productPublishXnoLimit?: string;
  purchaseAttoLimit?: string;
  purchaseXnoLimit?: string;
}

export interface WalletConsentIntent {
  version: 1;
  nanoControllerDirectory?: string;
  controller?: { directory: string; address: string; index: number; network: string };
  wallets: { asset: 'ATTO' | 'XNO'; intent: Record<string, unknown> }[];
}

interface SetupOutput { json?: boolean; quiet?: boolean; allowLoginRefresh?: boolean; walletConsent?: WalletConsentIntent }
type Output = (value: unknown) => void;

export async function runSetup(argv: string[], env: NodeJS.ProcessEnv, output: SetupOutput = {}): Promise<void> {
  const selected = takeJsonFlag(argv);
  const print: Output = value => { if (!output.quiet) writeTerminalResult(value, output.json ?? selected.json); };
  const options = parseSetupArgs(selected.argv);
  const home = resolve(options.home ?? env.MARKETPLACE_MCP_HOME ?? defaultMarketplaceHome(env));
  if (!options.profile) throw setupUsage('Choose a private profile ID with --profile.');
  const store = await MarketplaceProfileStore.open(home);
  try {
    if (options.browserSignIn) {
      await configureBrowserSignIn(store, options.profile, options.browserSignIn, env, print);
      return;
    }
    env = managedWalletEnvironment(home, env);
    if (options.fromProfile || options.credentialId) {
      activateCredential(store, options, print);
      return;
    }
    if (options.status) {
      reportSetupStatus(store, options.profile, home, print);
      return;
    }
    if (options.reauthenticate) {
      await reauthenticate(store, options.profile, home, env, print);
      return;
    }
    if (options.complete) {
      await completeSetup(store, options.profile, home, env, print, output.allowLoginRefresh ?? true);
      return;
    }
    await beginSetup(store, options, home, env, print, output.walletConsent);
  } finally { store.close(); }
}

async function reauthenticate(store: MarketplaceProfileStore, profileId: string, home: string, env: NodeJS.ProcessEnv, print: Output): Promise<void> {
  const profile = store.getProfile(profileId);
  if (profile.authMode !== 'controller-session') throw new ProfileError('AUTH_MODE', 'Reauthentication requires the original controller-session profile. Scoped credentials must be replaced through their credential workflow.');
  const pending = store.getSetupState(profileId);
  if (pending && asRecord(JSON.parse(pending.privatePayload)).reauthenticate !== true) throw new ProfileError('SETUP_IN_PROGRESS', 'Complete the original setup before reauthenticating this profile.');
  const challenge = parseChallenge(await requestJson(profile.origin, '/v1/agent/auth/challenges', { network: profile.controllerNetwork, address: profile.controllerAddress }));
  validateLoginChallenge(challenge, profile.controllerNetwork, profile.controllerAddress, profile.audience);
  if (challenge.accountId !== profile.accountId || challenge.controllerId !== profile.identityId) throw new ProfileError('PROFILE_CONFLICT', 'Marketplace returned a challenge for a different account or controller. The original profile was preserved.');
  const payload = JSON.stringify({
    profileId, origin: profile.origin, audience: profile.audience, controllerNetwork: profile.controllerNetwork,
    controllerAddress: profile.controllerAddress, controllerIndex: profile.controllerIndex, mode: 'controller-session', reauthenticate: true, challenge,
  });
  store.startReauthentication(profileId, payload, pending?.privatePayload ?? null);
  await completeSetup(store, profileId, home, env, print);
}

async function beginSetup(store: MarketplaceProfileStore, options: SetupOptions, home: string, env: NodeJS.ProcessEnv, print: Output, walletConsent?: WalletConsentIntent): Promise<void> {
  const profileId = required(options.profile, 'profile');
  if (store.listProfileIds().includes(profileId)) throw new ProfileError('PROFILE_EXISTS', 'This profile ID is already configured. Use --reauthenticate to renew its controller session while keeping its journals.');
  const pending = store.getSetupState(profileId);
  if (pending && isUnknownSetupState(pending.state)) throw unknownSetupOutcome(store, profileId, home);
  if (pending) throw new ProfileError('SETUP_IN_PROGRESS', `This setup has a pending private approval. Continue with: ${marketplaceCommand} setup --profile ${profileId} --complete --home ${shellQuote(home)}`);
  const origin = normalizeOrigin(required(options.origin, 'origin'));
  const audience = required(options.audience, 'audience');
  if (audience.length > 255 || /[\r\n\0]/.test(audience) || audience.trim() !== audience) throw setupUsage('Use the exact configured Agent API audience as one nonempty line of at most 255 characters.');
  const controllerAddress = required(options.controllerAddress, 'controller address');
  const controllerNetwork = options.controllerNetwork ?? 'ATTO';
  if (!isControllerAddress(controllerNetwork, controllerAddress)) {
    throw setupUsage(`The controller address must be a canonical ${controllerNetwork === 'ATTO' ? 'Atto' : 'Nano'} address.`);
  }
  const controllerIndex = options.controllerIndex;
  const maximumIndex = controllerNetwork === 'ATTO' ? 0x7fff_ffff : 0xffff_ffff;
  if (!Number.isSafeInteger(controllerIndex) || controllerIndex === undefined || controllerIndex < 0 || controllerIndex > maximumIndex) {
    throw setupUsage(`Choose the selected ${controllerNetwork === 'ATTO' ? 'Atto' : 'Nano'} wallet derivation index from 0 through ${maximumIndex}.`);
  }
  const mode = options.mode;
  if (!mode) throw setupUsage('Choose one explicit auth mode: --mode controller-session or --mode scoped-api-key.');
  const credential = mode === 'scoped-api-key' ? parseCredentialSetup(options) : undefined;
  if (mode === 'controller-session' && (options.scopes.length || options.credentialName || options.publishAttoLimit || options.publishXnoLimit
    || options.productPublishAttoLimit || options.productPublishXnoLimit
    || options.purchaseAttoLimit || options.purchaseXnoLimit)) {
    throw setupUsage('Scoped API grants and ceilings can only be supplied with --mode scoped-api-key.');
  }
  const challenge = await requestJson(origin, '/v1/agent/auth/challenges', { network: controllerNetwork, address: controllerAddress });
  const loginChallenge = parseChallenge(challenge);
  validateLoginChallenge(loginChallenge, controllerNetwork, controllerAddress, audience);
  store.createSetupState(profileId, 'LOGIN_READY', JSON.stringify({
    profileId, origin, audience, controllerNetwork, controllerAddress, controllerIndex, mode,
    ...(credential ? { credential } : {}), ...(walletConsent ? { walletConsent } : {}), challenge: loginChallenge,
  }));
  await completeSetup(store, profileId, home, env, print);
}

async function completeSetup(store: MarketplaceProfileStore, profileId: string, home: string, env: NodeJS.ProcessEnv, print: Output, allowLoginRefresh = true): Promise<void> {
  const existing = store.listProfileIds().includes(profileId) ? store.getProfile(profileId) : undefined;
  const pending = store.getSetupState(profileId);
  if (!pending) {
    if (!existing) throw new ProfileError('SETUP_REQUIRED', `No pending setup exists for this profile ID. Start with ${marketplaceCommand} setup --profile ${profileId} --home ${shellQuote(home)} and a fresh controller challenge.`);
    if (store.needsReauthentication(profileId)) throw new ProfileError('REAUTH_REQUIRED', 'Run setup --profile ' + profileId + ' --reauthenticate with the same --home to renew this session and retain its payment journals.');
    print({ status: 'ready', profileId: existing.id, origin: existing.origin, accountId: existing.accountId, authMode: existing.authMode });
    return;
  }
  if (isUnknownSetupState(pending.state)) throw unknownSetupOutcome(store, profileId, home);
  const saved = asRecord(JSON.parse(pending.privatePayload));
  const expectedPayload = pending.privatePayload;
  if (pending.state === 'LOGIN_READY') {
    const challenge = parseChallenge(saved.challenge);
    const controllerNetwork = saved.controllerNetwork === 'NANO' ? 'NANO' : 'ATTO';
    const controllerAddress = String(saved.controllerAddress);
    const controllerIndex = Number(saved.controllerIndex);
    validateLoginChallenge(challenge, controllerNetwork, controllerAddress, String(saved.audience));
    const handle = randomBytes(16).toString('hex');
    const request = createApprovalRequest({
      profileId, handoffId: handle, origin: String(saved.origin), audience: String(saved.audience),
      controllerNetwork, controllerAddress, controllerIndex, accountId: challenge.accountId!, identityId: challenge.controllerId!,
      purpose: 'login', action: { kind: 'login', network: controllerNetwork, address: controllerAddress }, challenge,
    });
    if (!store.transitionSetupState(profileId, 'LOGIN_READY', 'LOGIN_APPROVAL', JSON.stringify({ ...saved, request }), expectedPayload)) {
      throw new ProfileError('SETUP_BUSY', 'Another local setup process is preparing this exact login challenge. Retry after it finishes.');
    }
    const path = await writeApprovalRequest(home, profileId, handle, request);
    if (saved.walletConsent) print({ status: 'wallet_consent_required', profileId, resumeCommand: `${marketplaceCommand} setup --home ${shellQuote(home)} --profile ${shellQuote(profileId)}`, next: 'Ask the operator to approve the reviewed wallet permissions and exact login in guided setup.' });
    else printApprovalInstructions(request, path, home,
      'Ask the operator to approve this exact login. After explicit authorization, the agent may enter the confirmation and complete this setup.',
      print, saved.mode === 'controller-session' && controllerNetwork === 'ATTO');
    return;
  }
  if (pending.state === 'LOGIN_APPROVAL') {
    const expired = expiredUnsignedLoginApproval(store, profileId, home);
    if (expired) {
      if (!allowLoginRefresh) throw expiredLoginRetry(home, profileId);
      await refreshExpiredLoginApproval(store, profileId, home, expired);
      await completeSetup(store, profileId, home, env, print, false);
      return;
    }
    if (saved.walletConsent) throw walletConsentRequired(home, profileId);
    const request = parseSetupApprovalRequest(saved.request);
    const challenge = parseChallenge({ ...request.challenge, accountId: request.accountId, controllerId: request.identityId });
    validateLoginChallenge(challenge, request.controller.network, request.controller.address, request.audience);
    await writeApprovalRequest(home, profileId, request.handoffId, request);
    const response = await readAndValidateResponse(home, profileId, request, env);
    if (!store.transitionSetupState(profileId, 'LOGIN_APPROVAL', 'LOGIN_SUBMITTING', pending.privatePayload, expectedPayload)) {
      throw new ProfileError('SETUP_BUSY', 'Another local setup process is consuming this exact login approval. Retry after it finishes.');
    }
    let session: Record<string, unknown>;
    try {
      session = asRecord(await requestJson(String(saved.origin), '/v1/agent/auth/sessions', proofBody(response)));
    } catch (error) {
      if (error instanceof MarketplaceApiError && (error.code === 'SIGNER_REQUEST_REJECTED' || error.code === 'SIGNER_UNAVAILABLE')) {
        if (!store.transitionSetupState(profileId, 'LOGIN_SUBMITTING', 'LOGIN_APPROVAL', pending.privatePayload, expectedPayload)) throw new ProfileError('SETUP_BUSY', 'This result no longer owns the saved setup. Continue its current approval.');
        throw new ProfileError(error.code, `${error.message} Resume this same setup with --complete while its challenge is valid.`);
      }
      if (!store.transitionSetupState(profileId, 'LOGIN_SUBMITTING', 'LOGIN_UNKNOWN', pending.privatePayload, expectedPayload)) throw new ProfileError('SETUP_BUSY', 'This result no longer owns the saved setup. Continue its current approval.');
      throw new ProfileError('SETUP_UNKNOWN', unknownSetupOutcome(store, profileId, home).message);
    }
    const parsedSession = parseSession(session);
    if (parsedSession.accountId !== challenge.accountId || parsedSession.identityId !== challenge.controllerId) throw setupFailure();
    if (saved.mode === 'controller-session') {
      const profile = profileFromSetup(saved, parsedSession);
      if (saved.reauthenticate === true) store.completeReauthentication(profile, pending.privatePayload);
      else store.createProfile(profile, { state: 'LOGIN_SUBMITTING', privatePayload: expectedPayload });
      print({
        status: 'ready', profileId, origin: profile.origin, accountId: profile.accountId, authMode: profile.authMode,
        controllerNetwork: profile.controllerNetwork, controllerAddress: profile.controllerAddress, controllerIndex: profile.controllerIndex,
      });
      return;
    }
    if (saved.mode !== 'scoped-api-key' || !saved.credential) throw new ProfileError('SETUP_STATE', 'The pending setup has an invalid explicit auth mode.');
    const credential = asRecord(saved.credential);
    const command = { operation: 'CREATE', idempotencyKey: randomUUID(), credential };
    const setupWithSession = { ...saved, session: parsedSession, credentialCommand: command };
    if (!store.transitionSetupState(profileId, 'LOGIN_SUBMITTING', 'SCOPED_KEY_PREPARING', JSON.stringify(setupWithSession), expectedPayload)) {
      throw new ProfileError('SETUP_BUSY', 'The completed login no longer owns this scoped-profile setup. Inspect local setup state.');
    }
    await continueScopedSetup(store, profileId, home, 'SCOPED_KEY_PREPARING', setupWithSession, JSON.stringify(setupWithSession), print);
    return;
  }
  if (pending.state === 'SCOPED_KEY_PREPARING') {
    await continueScopedSetup(store, profileId, home, pending.state, saved, expectedPayload, print);
    return;
  }
  if (pending.state === 'SCOPED_KEY_APPROVAL') {
    const request = parseSetupApprovalRequest(saved.request);
    await writeApprovalRequest(home, profileId, request.handoffId, request);
    const response = await readAndValidateResponse(home, profileId, request, env);
    if (!store.transitionSetupState(profileId, 'SCOPED_KEY_APPROVAL', 'SCOPED_KEY_SUBMITTING', pending.privatePayload, expectedPayload)) {
      throw new ProfileError('SETUP_BUSY', 'Another local setup process is consuming this exact credential approval. Retry after it finishes.');
    }
    let result: Record<string, unknown>;
    try {
      result = asRecord(await requestJson(String(saved.origin), '/v1/agent/credentials', {
        idempotencyKey: asRecord(saved.credentialCommand).idempotencyKey,
        credential: asRecord(saved.credentialCommand).credential, proof: proofBody(response),
      }, String(asRecord(saved.session).accessToken)));
    } catch {
      if (!store.transitionSetupState(profileId, 'SCOPED_KEY_SUBMITTING', 'SCOPED_KEY_UNKNOWN', pending.privatePayload, expectedPayload)) throw new ProfileError('SETUP_BUSY', 'This result no longer owns the saved setup. Continue its current approval.');
      throw unknownSetupOutcome(store, profileId, home);
    }
    if (typeof result.apiKey !== 'string' || typeof result.apiKeyId !== 'string') {
      if (!store.transitionSetupState(profileId, 'SCOPED_KEY_SUBMITTING', 'SCOPED_KEY_UNKNOWN', pending.privatePayload, expectedPayload)) throw new ProfileError('SETUP_BUSY', 'This result no longer owns the saved setup. Continue its current approval.');
      throw unknownSetupOutcome(store, profileId, home);
    }
    if (result.apiKey.length < 16 || result.apiKey.length > 8192 || /[\r\n\0]/.test(result.apiKey)) {
      if (!store.transitionSetupState(profileId, 'SCOPED_KEY_SUBMITTING', 'SCOPED_KEY_UNKNOWN', pending.privatePayload, expectedPayload)) throw new ProfileError('SETUP_BUSY', 'This result no longer owns the saved setup. Continue its current approval.');
      throw unknownSetupOutcome(store, profileId, home);
    }
    const session = asRecord(saved.session);
    const spec = asRecord(asRecord(saved.credentialCommand).credential);
    const profile = profileFromSetup({ ...saved, credential: spec }, session, result.apiKey);
    store.createProfile(profile, { state: 'SCOPED_KEY_SUBMITTING', privatePayload: expectedPayload });
    print({
      status: 'ready', profileId, origin: profile.origin, accountId: profile.accountId, authMode: profile.authMode,
      apiKeyId: result.apiKeyId, scopes: profile.apiScopes, publishAttoLimit: profile.publishAttoLimit,
      publishXnoLimit: profile.publishXnoLimit,
      productPublishAttoLimit: profile.productPublishAttoLimit, productPublishXnoLimit: profile.productPublishXnoLimit,
      purchaseAttoLimit: profile.purchaseAttoLimit, purchaseXnoLimit: profile.purchaseXnoLimit,
    });
    return;
  }
  throw new ProfileError('SETUP_STATE', 'This setup state cannot be resumed automatically. Inspect it in the local terminal and use a fresh profile ID if the result is uncertain.');
}

async function continueScopedSetup(store: MarketplaceProfileStore, profileId: string, home: string, state: string, saved: Record<string, unknown>, expectedPayload: string, print: Output): Promise<void> {
  if (state !== 'SCOPED_KEY_PREPARING') throw new ProfileError('SETUP_STATE', 'The scoped-key setup is not ready for a new approval challenge.');
  const credentialCommand = asRecord(saved.credentialCommand);
  if (!store.transitionSetupState(profileId, 'SCOPED_KEY_PREPARING', 'SCOPED_KEY_CHALLENGE_IN_FLIGHT', expectedPayload, expectedPayload)) {
    throw new ProfileError('SETUP_BUSY', 'Another local setup process is requesting this scoped-key challenge. Retry after it completes.');
  }
  let challenge: unknown;
  try { challenge = await requestJson(String(saved.origin), '/v1/agent/credentials/challenges', credentialCommand, String(asRecord(saved.session).accessToken)); }
  catch (error) {
    if (!store.transitionSetupState(profileId, 'SCOPED_KEY_CHALLENGE_IN_FLIGHT', 'SCOPED_KEY_PREPARING', expectedPayload, expectedPayload)) throw new ProfileError('SETUP_BUSY', 'This challenge result no longer owns the saved setup. Continue its current approval.');
    throw error;
  }
  const parsedChallenge = parseChallenge(challenge);
  const controllerIndex = Number(saved.controllerIndex);
  const handle = randomBytes(16).toString('hex');
  const request = createApprovalRequest({
    profileId, handoffId: handle, origin: String(saved.origin), audience: String(saved.audience),
    accountId: String(asRecord(saved.session).accountId), identityId: String(asRecord(saved.session).identityId),
    controllerNetwork: saved.controllerNetwork === 'NANO' ? 'NANO' : 'ATTO', controllerAddress: String(saved.controllerAddress), controllerIndex, purpose: 'API-key creation',
    action: { kind: 'credential', operation: 'CREATE', command: credentialCommand }, challenge: parsedChallenge,
  });
  const pending = { ...saved, request };
  if (!store.transitionSetupState(profileId, 'SCOPED_KEY_CHALLENGE_IN_FLIGHT', 'SCOPED_KEY_APPROVAL', JSON.stringify(pending), expectedPayload)) {
    throw new ProfileError('SETUP_BUSY', 'The challenge response no longer owns this setup. Inspect local setup state.');
  }
  const path = await writeApprovalRequest(home, profileId, handle, request);
  printApprovalInstructions(request, path, home, 'Sign the exact scoped credential grant in the local wallet terminal. Marketplace MCP stores the returned API key directly in this private profile; no secret is printed.', print);
}

function activateCredential(store: MarketplaceProfileStore, options: SetupOptions, print: Output): void {
  const newProfileId = required(options.profile, 'new profile');
  const sourceProfileId = required(options.fromProfile, 'source profile');
  const credentialId = required(options.credentialId, 'credential ID');
  if (!isUuid(credentialId)) throw setupUsage('Choose a canonical API key ID from the local credential-creation result.');
  if (store.listProfileIds().includes(newProfileId)) throw new ProfileError('PROFILE_EXISTS', 'This profile ID is already configured. Choose a new name for the scoped profile.');
  const source = store.getProfile(sourceProfileId);
  if (source.authMode !== 'controller-session') throw new ProfileError('AUTH_MODE', 'A new scoped API profile can be copied only from an explicitly configured controller-session profile.');
  const saved = store.getIssuedCredential(sourceProfileId, credentialId);
  store.createProfile({
    id: newProfileId, origin: source.origin, audience: source.audience, accountId: source.accountId,
    agentId: source.agentId, identityId: source.identityId, controllerNetwork: source.controllerNetwork, controllerAddress: source.controllerAddress,
    controllerIndex: source.controllerIndex, authMode: 'scoped-api-key', apiKey: saved.apiKey, apiScopes: saved.scopes,
    publishAttoLimit: saved.publishAttoLimit, publishXnoLimit: saved.publishXnoLimit,
    productPublishAttoLimit: saved.productPublishAttoLimit, productPublishXnoLimit: saved.productPublishXnoLimit,
    purchaseAttoLimit: saved.purchaseAttoLimit, purchaseXnoLimit: saved.purchaseXnoLimit,
  });
  store.deleteIssuedCredential(sourceProfileId, credentialId);
  const profile = store.getProfile(newProfileId);
  print({
    status: 'ready', profileId: newProfileId, origin: profile.origin, accountId: profile.accountId, authMode: profile.authMode,
    scopes: profile.apiScopes, publishAttoLimit: profile.publishAttoLimit, publishXnoLimit: profile.publishXnoLimit,
    productPublishAttoLimit: profile.productPublishAttoLimit, productPublishXnoLimit: profile.productPublishXnoLimit,
    purchaseAttoLimit: profile.purchaseAttoLimit, purchaseXnoLimit: profile.purchaseXnoLimit,
  });
}

function reportSetupStatus(store: MarketplaceProfileStore, profileId: string, home: string, print: Output): void {
  const state = store.getSetupState(profileId);
  if (!state) {
    const profile = store.getProfile(profileId);
    print({ status: 'ready', profileId: profile.id, origin: profile.origin, accountId: profile.accountId, authMode: profile.authMode });
    return;
  }
  const saved = asRecord(JSON.parse(state.privatePayload));
  const request = saved.request ? parseSetupApprovalRequest(saved.request) : undefined;
  print({
    status: state.state, profileId,
    ...(saved.walletConsent ? { walletConsentPending: true, resumeCommand: `${marketplaceCommand} setup --home ${shellQuote(home)} --profile ${shellQuote(profileId)}` } : {}),
    ...(request ? {
      handoffId: request.handoffId, purpose: request.purpose, expiresAt: request.challenge.expiresAt,
      ...(!saved.walletConsent ? { walletCommand: `${marketplaceCommand} approve ${shellQuote(approvalRequestPath(home, profileId, request.handoffId))} --home ${shellQuote(home)}` } : {}),
    } : {}),
    ...(state.state === 'LOGIN_READY' ? { resumeCommand: `${marketplaceCommand} setup --profile ${profileId} --complete --home ${shellQuote(home)}` } : {}),
    ...(typeof saved.controllerNetwork === 'string' ? { controllerNetwork: saved.controllerNetwork } : {}),
  });
}

async function readAndValidateResponse(home: string, profileId: string, request: MarketplaceProofApprovalRequest, env: NodeJS.ProcessEnv): Promise<{ challengeId: string; message: string; signature: string }> {
  if (request.profileId !== profileId) throw new ProfileError('APPROVAL_BINDING', 'The signed wallet approval belongs to a different local profile.');
  validateTypedApproval(request);
  const response = validateApprovalResponse(request, readApprovalResponse(home, profileId, request.handoffId));
  await verifyApprovalSignature(request, response, env);
  const signature = canonicalHexSignature(response.signature, () => {
    throw new ProfileError('APPROVAL_FILE', 'The private Marketplace wallet-approval handoff file is unavailable or invalid.');
  });
  return { challengeId: request.challenge.challengeId, message: request.challenge.message, signature };
}

function profileFromSetup(saved: Record<string, unknown>, session: Record<string, unknown>, apiKey?: string): NewProfile {
  const credential = saved.credential ? asRecord(saved.credential) : undefined;
  const controllerNetwork = saved.controllerNetwork === 'NANO' ? 'NANO' : 'ATTO';
  return {
    id: String(saved.profileId ?? ''), origin: String(saved.origin), audience: String(saved.audience), accountId: String(session.accountId),
    agentId: String(session.agentId), identityId: String(session.identityId), controllerNetwork,
    controllerAddress: String(saved.controllerAddress), controllerIndex: Number(saved.controllerIndex),
    authMode: apiKey ? 'scoped-api-key' : 'controller-session',
    ...(apiKey ? {
      apiKey, apiScopes: credential?.scopes as string[] ?? [],
      publishAttoLimit: typeof credential?.publishAttoLimit === 'string' ? credential.publishAttoLimit : null,
      publishXnoLimit: typeof credential?.publishXnoLimit === 'string' ? credential.publishXnoLimit : null,
      productPublishAttoLimit: typeof credential?.productPublishAttoLimit === 'string' ? credential.productPublishAttoLimit : null,
      productPublishXnoLimit: typeof credential?.productPublishXnoLimit === 'string' ? credential.productPublishXnoLimit : null,
      purchaseAttoLimit: typeof credential?.purchaseAttoLimit === 'string' ? credential.purchaseAttoLimit : null,
      purchaseXnoLimit: typeof credential?.purchaseXnoLimit === 'string' ? credential.purchaseXnoLimit : null,
    } : {}),
    ...(apiKey ? {} : {
      accessToken: String(session.accessToken), accessExpiresAt: timestampMillis(session.accessExpiresAt),
      refreshToken: String(session.refreshToken), refreshExpiresAt: timestampMillis(session.refreshExpiresAt),
    }),
  };
}

function parseSession(input: Record<string, unknown>): Record<string, unknown> {
  for (const name of ['accountId', 'agentId', 'identityId']) if (typeof input[name] !== 'string' || !isUuid(input[name])) throw setupFailure();
  for (const name of ['accessToken', 'refreshToken']) if (typeof input[name] !== 'string' || (input[name] as string).length < 16
    || (input[name] as string).length > 8192 || /[\r\n\0]/.test(input[name] as string)) throw setupFailure();
  const accessExpiresAt = dateMillis(input.accessExpiresAt);
  const refreshExpiresAt = dateMillis(input.refreshExpiresAt);
  if (accessExpiresAt <= Date.now() || refreshExpiresAt < accessExpiresAt) throw setupFailure();
  return { ...input, accessExpiresAt, refreshExpiresAt };
}

function parseChallenge(input: unknown): ApprovalChallenge {
  return parseChallengeEnvelope(input, () => { throw setupFailure(); });
}

function parseSetupApprovalRequest(input: unknown): MarketplaceProofApprovalRequest {
  return parseApprovalRequest(input, () => { throw setupFailure(); });
}

function validateLoginChallenge(challenge: ApprovalChallenge,
  network: 'ATTO' | 'NANO', address: string, audience: string): void {
  const lines = challenge.message.split('\n');
  if (lines.length !== 10 || !isUuid(challenge.accountId) || !isUuid(challenge.controllerId) || lines[0] !== `${network === 'ATTO' ? '' : 'Nano '}Marketplace Agent Controller Proof v1`
    || proofField(lines[1] ?? '', 'Audience') !== audience || proofField(lines[3] ?? '', 'Address') !== address
    || proofField(lines[4] ?? '', 'Purpose') !== 'login' || proofField(lines[5] ?? '', 'Request ID') !== challenge.challengeId
    || proofField(lines[6] ?? '', 'Binding Hash') !== enrollmentHash(challenge.accountId, challenge.controllerId)
    || !/^[0-9a-f]{64}$/.test(proofField(lines[7] ?? '', 'Nonce'))
    || Date.parse(proofField(lines[8] ?? '', 'Issued At')) !== Date.parse(challenge.issuedAt)
    || Date.parse(proofField(lines[9] ?? '', 'Expiration Time')) !== Date.parse(challenge.expiresAt)) throw setupFailure();
  const proofNetwork = proofField(lines[2] ?? '', 'Network');
  if (network === 'ATTO' ? !['live', 'beta', 'dev', 'local'].includes(proofNetwork) : !['nano:mainnet', 'nano:beta', 'nano:dev'].includes(proofNetwork)) throw setupFailure();
}

function enrollmentHash(accountId: string, controllerId: string): string {
  return createHash('sha256').update(['marketplace-login-v1', accountId, controllerId].join('\n'), 'utf8').digest('hex');
}

function proofField(line: string, label: string): string {
  const prefix = `${label}: `;
  if (!line.startsWith(prefix) || line.length === prefix.length || /[\r\0]/.test(line)) throw setupFailure();
  return line.slice(prefix.length);
}

function parseCredentialSetup(options: SetupOptions): Record<string, unknown> {
  const name = options.credentialName === undefined ? undefined : trimAsciiControlAndSpace(options.credentialName);
  const scopes = options.scopes;
  const expiresInDays = options.expiresInDays ?? 90;
  if (!name || name.length > 64 || /[\x00-\x1f\x7f]/.test(name) || scopes.length === 0 || new Set(scopes).size !== scopes.length
    || scopes.some(scope => !CREDENTIAL_SCOPE_SET.has(scope)) || !Number.isSafeInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) {
    throw setupUsage('Scoped setup needs --credential-name, one or more exact --scope values, and --expires-in-days from 1 through 365.');
  }
  for (const limit of [options.publishAttoLimit, options.publishXnoLimit, options.productPublishAttoLimit, options.productPublishXnoLimit,
    options.purchaseAttoLimit, options.purchaseXnoLimit]) {
    if (limit !== undefined && !isPositiveAtomic(limit)) throw setupUsage('Credential ceilings must be positive exact decimal atomic strings.');
  }
  const checks = validateCredentialCeilingRules({
    scopes, publishAttoLimit: options.publishAttoLimit, publishXnoLimit: options.publishXnoLimit,
    productPublishAttoLimit: options.productPublishAttoLimit, productPublishXnoLimit: options.productPublishXnoLimit,
    purchaseAttoLimit: options.purchaseAttoLimit, purchaseXnoLimit: options.purchaseXnoLimit,
  });
  if (checks.publishInvalid || checks.productPublishInvalid || checks.purchaseInvalid) {
    throw setupUsage('tasks:publish and products:purchase require their matching ATTO and/or XNO ceiling; product publication ceilings require products:publish. Irrelevant ceilings are rejected.');
  }
  return {
    name, expiresInDays, scopes: [...scopes].sort(),
    ...(options.publishAttoLimit ? { publishAttoLimit: options.publishAttoLimit } : {}),
    ...(options.publishXnoLimit ? { publishXnoLimit: options.publishXnoLimit } : {}),
    ...(options.productPublishAttoLimit ? { productPublishAttoLimit: options.productPublishAttoLimit } : {}),
    ...(options.productPublishXnoLimit ? { productPublishXnoLimit: options.productPublishXnoLimit } : {}),
    ...(options.purchaseAttoLimit ? { purchaseAttoLimit: options.purchaseAttoLimit } : {}),
    ...(options.purchaseXnoLimit ? { purchaseXnoLimit: options.purchaseXnoLimit } : {}),
  };
}

function proofBody(response: { challengeId: string; message: string; signature: string }): Record<string, string> {
  return { challengeId: response.challengeId, message: response.message, signature: response.signature };
}

async function requestJson(origin: string, path: string, body: unknown, bearer?: string): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  let response: Response;
  try {
    response = await fetch(apiUrl(normalizeOrigin(origin), path), { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(requestTimeoutMs) });
  } catch { throw new ProfileError('SETUP_NETWORK', 'The pinned Marketplace setup endpoint could not be reached. The request was not automatically replayed.'); }
  if (response.url && new URL(response.url).origin !== normalizeOrigin(origin)) { await response.body?.cancel().catch(() => undefined); throw setupFailure(); }
  let text: string;
  try { text = await readBounded(response, undefined, responseLimit); }
  catch { throw setupFailure(); }
  let value: unknown = null;
  if (text) { try { value = JSON.parse(text); } catch { throw setupFailure(); } }
  const signerError = signerApiError(response.status, value);
  if (signerError) throw signerError;
  if (![200, 201].includes(response.status)) throw new ProfileError('SETUP_HTTP', `Marketplace setup returned HTTP ${response.status}. Check the pinned origin, audience and local approval, then reconcile before retrying.`);
  return value;
}

function parseSetupArgs(argv: string[]): SetupOptions {
  const result: SetupOptions = { complete: false, reauthenticate: false, status: false, scopes: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const value = () => { const next = argv[++index]; if (!next) throw setupUsage(`Missing value for ${arg}.`); return next; };
    switch (arg) {
      case '--browser-sign-in': {
        const operation = value();
        if (operation !== 'enable' && operation !== 'disable' && operation !== 'status') throw setupUsage('Choose --browser-sign-in enable, disable, or status.');
        result.browserSignIn = operation;
        break;
      }
      case '--profile': result.profile = value(); break;
      case '--home': result.home = value(); break;
      case '--origin': result.origin = value(); break;
      case '--audience': result.audience = value(); break;
      case '--controller-address': result.controllerAddress = value(); break;
      case '--controller-index': { const number = Number(value()); if (!Number.isSafeInteger(number)) throw setupUsage('Controller index must be an integer.'); result.controllerIndex = number; break; }
      case '--controller-network': { const network = value(); if (network !== 'ATTO' && network !== 'NANO') throw setupUsage('Controller network must be ATTO or NANO.'); result.controllerNetwork = network; break; }
      case '--mode': { const mode = value(); if (mode !== 'controller-session' && mode !== 'scoped-api-key') throw setupUsage('Choose controller-session or scoped-api-key.'); result.mode = mode; break; }
      case '--complete': result.complete = true; break;
      case '--reauthenticate': result.reauthenticate = true; break;
      case '--status': result.status = true; break;
      case '--from-profile': result.fromProfile = value(); break;
      case '--credential-id': result.credentialId = value(); break;
      case '--credential-name': result.credentialName = value(); break;
      case '--expires-in-days': { const number = Number(value()); if (!Number.isSafeInteger(number)) throw setupUsage('Expiry must be an integer.'); result.expiresInDays = number; break; }
      case '--scope': result.scopes.push(value()); break;
      case '--publish-atto-limit': result.publishAttoLimit = value(); break;
      case '--publish-xno-limit': result.publishXnoLimit = value(); break;
      case '--product-publish-atto-limit': result.productPublishAttoLimit = value(); break;
      case '--product-publish-xno-limit': result.productPublishXnoLimit = value(); break;
      case '--purchase-atto-limit': result.purchaseAttoLimit = value(); break;
      case '--purchase-xno-limit': result.purchaseXnoLimit = value(); break;
      default: throw setupUsage(`Unknown setup option: ${arg}`);
    }
  }
  if (result.browserSignIn && argv.some((arg, index) => index % 2 === 0 && !['--browser-sign-in', '--profile', '--home'].includes(arg))) {
    throw setupUsage('Browser sign-in setup takes --profile, --browser-sign-in and optional --home.');
  }
  if (result.profile && !isProfileId(result.profile)) throw setupUsage('Profile IDs must be 1 to 48 letters, digits, underscores or hyphens.');
  if (result.fromProfile && !isProfileId(result.fromProfile)) throw setupUsage('Source profile IDs must be 1 to 48 letters, digits, underscores or hyphens.');
  if (result.home && (result.home.includes('\0') || result.home.length > 2048)) throw setupUsage('Private profile directory path is invalid.');
  if (result.reauthenticate && argv.some(arg => !['--reauthenticate', '--profile', '--home', result.profile, result.home].includes(arg))) throw setupUsage('Reauthentication only takes --profile, --reauthenticate and optional --home; it preserves the saved account and controller.');
  if (result.complete && result.status) throw setupUsage('Choose either --complete or --status.');
  if ((result.fromProfile || result.credentialId) && !(result.fromProfile && result.credentialId)) throw setupUsage('Credential activation needs both --from-profile and --credential-id.');
  if ((result.fromProfile || result.credentialId) && (result.complete || result.status || result.origin || result.audience || result.mode || result.controllerAddress || result.controllerIndex !== undefined || result.controllerNetwork)) {
    throw setupUsage('Credential activation only takes --profile, --from-profile, --credential-id and optional --home.');
  }
  return result;
}

function normalizeOrigin(value: string): string {
  return parseMarketplaceOrigin(value, reason => {
    throw setupUsage(reason === 'syntax'
      ? 'Marketplace origin must be an absolute HTTPS origin.'
      : 'Marketplace origin must be HTTPS; HTTP is allowed only for loopback development.');
  });
}

function dateMillis(value: unknown): number {
  return parseIsoDateMillis(value, () => { throw setupFailure(); });
}

function timestampMillis(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  return dateMillis(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw setupFailure();
  return value as Record<string, unknown>;
}

function required(value: string | undefined, label: string): string {
  if (!value) throw setupUsage(`Provide --${label.replaceAll(' ', '-')}.`);
  return value;
}

function printApprovalInstructions(request: MarketplaceProofApprovalRequest, path: string, home: string, next: string, print: Output, preauthorizedLoginSupported = false): void {
  const { profileId, handoffId, purpose } = request;
  print({
    status: 'approval_required', profileId, handoffId, purpose,
    walletCommand: `${marketplaceCommand} approve ${shellQuote(path)} --home ${shellQuote(home)}`,
    resumeCommand: `${marketplaceCommand} setup --profile ${profileId} --complete --home ${shellQuote(home)}`, next,
    ...(preauthorizedLoginSupported ? {
      preauthorizedLogin: `If your deployment provides a matching Login only authorization, add --login-authorization <deployment-file> to the approval command. See the deployment instructions and JSON example at ${loginAuthorizationGuide}`,
    } : {}),
  });
}

function setupUsage(message: string): ProfileError { return new ProfileError('SETUP_USAGE', message); }
function setupFailure(): ProfileError { return new ProfileError('SETUP_PROTOCOL', 'Marketplace setup returned an invalid response. Check the pinned origin and repeat only after confirming the previous action had no effect.'); }

async function refreshExpiredLoginApproval(store: MarketplaceProfileStore, profileId: string, home: string, expired: ExpiredLoginApproval): Promise<void> {
  const { request, saved } = expired;
  let challenge: ApprovalChallenge;
  try {
    challenge = parseChallenge(await requestJson(String(saved.origin), '/v1/agent/auth/challenges', {
      network: request.controller.network, address: request.controller.address,
    }));
    validateLoginChallenge(challenge, request.controller.network, request.controller.address, request.audience);
    if (challenge.accountId !== request.accountId || challenge.controllerId !== request.identityId
      || challenge.message.split('\n')[2] !== request.challenge.message.split('\n')[2]) {
      throw new ProfileError('PROFILE_CONFLICT', 'The fresh challenge belongs to a different account, controller or native network. The expired setup was preserved.');
    }
  } catch (error) {
    process.stderr.write(`The expired login setup was preserved. Continue with: ${terminalText(loginResumeCommand(home, profileId))}\n`);
    throw error;
  }
  if (!approvalResponseIsAbsent(home, profileId, request.handoffId)) {
    throw new ProfileError('SETUP_BUSY', 'A response for the old login appeared during refresh. It was preserved; inspect the current setup before continuing.');
  }
  const replacement: Record<string, unknown> = { ...saved, challenge };
  delete replacement.request;
  if (!store.transitionSetupState(profileId, 'LOGIN_APPROVAL', 'LOGIN_READY', JSON.stringify(replacement), expired.privatePayload)) {
    throw new ProfileError('SETUP_BUSY', 'Another login generation replaced the expired setup. Its current approval was preserved.');
  }
}
