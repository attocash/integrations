import { approvalResponseIsAbsent, type MarketplaceProofApprovalRequest } from './approval-files.js';
import { validateTypedApproval } from './approval-validation.js';
import { ProfileError } from './profile-error.js';
import type { MarketplaceProfileStore } from './profile-store.js';
import { marketplaceCommand, shellQuote } from './shell-quote.js';

export interface ExpiredLoginApproval {
  privatePayload: string;
  saved: Record<string, unknown>;
  request: MarketplaceProofApprovalRequest;
}

export function isUnknownSetupState(state: string): boolean {
  return ['LOGIN_UNKNOWN', 'LOGIN_SUBMITTING', 'SCOPED_KEY_UNKNOWN', 'SCOPED_KEY_SUBMITTING', 'SCOPED_KEY_CHALLENGE_IN_FLIGHT'].includes(state);
}

/** A read-only recovery instruction: never resubmit or create the suggested profile here. */
export function unknownSetupOutcome(store: MarketplaceProfileStore, profileId: string, home: string, reason: 'unknown' | 'expired-response' = 'unknown'): ProfileError {
  const pending = store.getSetupState(profileId);
  if (!pending) throw new ProfileError('SETUP_STATE', 'The uncertain setup state is unavailable.');
  const saved = recordOf(JSON.parse(pending.privatePayload));
  if (store.listProfileIds().includes(profileId) && saved.reauthenticate === true) {
    return new ProfileError('REAUTH_REQUIRED', `${reason === 'unknown' ? 'The last login outcome is unknown.' : 'The expired login already has a saved response.'} Check your account sessions first. Its previous request will not be replayed. Keep this profile and its payment journals; request a fresh proof with: ${marketplaceCommand} setup --home ${shellQuote(home)} --profile ${shellQuote(profileId)} --reauthenticate`);
  }
  let suffix = 1, newProfile = `${profileId.slice(0, 40)}-retry`;
  while (store.listProfileIds().includes(newProfile) || store.getSetupState(newProfile)) newProfile = `${profileId.slice(0, 36)}-retry-${++suffix}`;
  const args = ['--home', home, '--profile', newProfile, '--origin', String(saved.origin), '--audience', String(saved.audience),
    '--controller-network', String(saved.controllerNetwork), '--controller-address', String(saved.controllerAddress),
    '--controller-index', String(saved.controllerIndex), '--mode', String(saved.mode)];
  if (saved.mode === 'scoped-api-key') {
    const credential = recordOf(saved.credential);
    args.push('--credential-name', String(credential.name), '--expires-in-days', String(credential.expiresInDays));
    for (const scope of credential.scopes as string[]) args.push('--scope', scope);
    for (const key of ['publishAttoLimit', 'publishXnoLimit', 'productPublishAttoLimit', 'productPublishXnoLimit', 'purchaseAttoLimit', 'purchaseXnoLimit']) {
      if (credential[key] !== undefined) args.push('--' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()), String(credential[key]));
    }
  }
  return new ProfileError(reason === 'unknown' ? 'SETUP_UNKNOWN' : 'APPROVAL_EXPIRED', `${reason === 'unknown' ? 'The previous request may have completed.' : 'The expired login already has a saved response and cannot be refreshed as unsigned.'} Check your account sessions${saved.mode === 'scoped-api-key' ? ' and credentials' : ''} first. It will not be replayed; the original setup, wallets and journals are preserved. After checking, start a fresh setup with this unused profile: ${marketplaceCommand} setup ${args.map(value => shellQuote(value)).join(' ')}`);
}

/** Classify only a fully validated, expired, unsigned current login; no key or network access. */
export function expiredUnsignedLoginApproval(store: MarketplaceProfileStore, profileId: string, home: string): ExpiredLoginApproval | undefined {
  const pending = store.getSetupState(profileId);
  if (pending?.state !== 'LOGIN_APPROVAL') return undefined;
  const saved = recordOf(JSON.parse(pending.privatePayload));
  const request = validateTypedApproval(saved.request, { allowExpired: true });
  const challenge = recordOf(saved.challenge);
  if (request.purpose !== 'login' || request.action.kind !== 'login' || request.profileId !== profileId || saved.profileId !== profileId
    || !['controller-session', 'scoped-api-key'].includes(String(saved.mode))
    || request.marketplaceOrigin !== saved.origin || request.audience !== saved.audience
    || request.controller.network !== saved.controllerNetwork || request.controller.address !== saved.controllerAddress || request.controller.index !== saved.controllerIndex
    || request.accountId !== challenge.accountId || request.identityId !== challenge.controllerId
    || ['challengeId', 'message', 'issuedAt', 'expiresAt'].some(key => request.challenge[key as keyof typeof request.challenge] !== challenge[key])) {
    throw new ProfileError('APPROVAL_BINDING', 'The saved login request differs from this profile’s exact setup intent.');
  }
  if (Date.parse(request.challenge.expiresAt) > Date.now()) return undefined;
  if (!approvalResponseIsAbsent(home, profileId, request.handoffId)) throw unknownSetupOutcome(store, profileId, home, 'expired-response');
  return { privatePayload: pending.privatePayload, saved, request };
}

export function loginResumeCommand(home: string, profileId: string): string {
  return `${marketplaceCommand} setup --home ${shellQuote(home)} --profile ${shellQuote(profileId)} --complete`;
}

export function expiredLoginRetry(home: string, profileId: string): ProfileError {
  return new ProfileError('APPROVAL_EXPIRED', `This exact login approval expired. No proof was submitted. Request a fresh approval with: ${loginResumeCommand(home, profileId)}`);
}

export function walletConsentRequired(home: string, profileId: string): ProfileError {
  return new ProfileError('WALLET_CONSENT_REQUIRED', `The selected wallet permissions still require their combined terminal review. Continue with: ${marketplaceCommand} setup --home ${shellQuote(home)} --profile ${shellQuote(profileId)}`);
}

function recordOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProfileError('SETUP_PROTOCOL', 'Marketplace setup returned an invalid response. Check the pinned origin and repeat only after confirming the previous action had no effect.');
  }
  return value as Record<string, unknown>;
}
