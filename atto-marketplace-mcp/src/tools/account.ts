import { z } from 'zod';
import { MarketplaceApiClient, MarketplaceApiError } from '../marketplace-api.js';
import { mutate } from '../marketplace-mutation.js';
import { asRecord, uuid } from '../marketplace-results.js';
import { canonicalUuid, CREDENTIAL_SCOPES, trimAsciiControlAndSpace, validateCredentialCeilingRules } from '../marketplace-validation.js';
import { type MarketplaceProfile, type MarketplaceProfileStore, requireSession } from '../profile-store.js';
import { freshProofMutation } from '../protected-mutation.js';
import { nonnegativeAtomic, positiveAtomic, requestId, type ToolContext } from './common.js';

const credential = z.strictObject({
  name: z.string().transform(trimAsciiControlAndSpace)
    .pipe(z.string().min(1).max(64).refine(value => !/[\x00-\x1f\x7f]/.test(value))),
  expiresInDays: z.number().int().min(1).max(365).default(90),
  scopes: z.array(z.enum(CREDENTIAL_SCOPES)).min(1).max(CREDENTIAL_SCOPES.length).refine(values => new Set(values).size === values.length),
  publishAttoLimit: positiveAtomic.nullable().optional(),
  publishXnoLimit: positiveAtomic.nullable().optional(),
  productPublishAttoLimit: positiveAtomic.nullable().optional(),
  productPublishXnoLimit: positiveAtomic.nullable().optional(),
  purchaseAttoLimit: positiveAtomic.nullable().optional(),
  purchaseXnoLimit: positiveAtomic.nullable().optional(),
}).superRefine((value, context) => {
  const checks = validateCredentialCeilingRules(value);
  if (checks.publishInvalid) context.addIssue({ code: 'custom', message: 'tasks:publish needs an ATTO and/or XNO ceiling, and irrelevant ceilings are rejected.' });
  if (checks.productPublishInvalid) context.addIssue({ code: 'custom', message: 'Product publication reservation ceilings require products:publish.' });
  if (checks.purchaseInvalid) context.addIssue({ code: 'custom', message: 'products:purchase needs an exact ATTO and/or XNO ceiling, and an unused purchase ceiling is rejected.' });
});

const credentialGrant = z.strictObject({
  scopes: z.array(z.enum(CREDENTIAL_SCOPES)).min(1).max(CREDENTIAL_SCOPES.length),
  publishAttoLimit: positiveAtomic.nullable(),
  publishXnoLimit: positiveAtomic.nullable(),
  productPublishAttoLimit: positiveAtomic.nullable(),
  productPublishXnoLimit: positiveAtomic.nullable(),
  purchaseAttoLimit: positiveAtomic.nullable(),
  purchaseXnoLimit: positiveAtomic.nullable(),
}).superRefine((value, context) => {
  const checks = validateCredentialCeilingRules(value);
  if (new Set(value.scopes).size !== value.scopes.length || checks.publishInvalid || checks.productPublishInvalid || checks.purchaseInvalid) {
    context.addIssue({ code: 'custom', message: 'Invalid credential grant.' });
  }
});

const profilePatch = z.strictObject({
  handle: z.string().min(3).max(30).regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/).nullable().optional(),
  displayName: z.string().min(1).max(60).nullable().optional(),
  bio: z.string().max(500)
    .describe('Long-form profile biography; rendered with CommonMark and GitHub Flavored Markdown when the profile is published.')
    .nullable().optional(),
  capabilities: z.array(z.string().min(1).max(40)).max(12).nullable().optional(),
}).refine(value => Object.keys(value).length > 0, 'Provide at least one profile field.');

function safeCredentialMutation(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  const apiKeyId = typeof record.apiKeyId === 'string' ? record.apiKeyId : undefined;
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey : null;
  return {
    ...(apiKeyId ? { apiKeyId } : {}),
    ...(typeof record.result === 'string' ? { result: record.result } : {}),
    ...(typeof record.replayed === 'boolean' ? { replayed: record.replayed } : {}),
    secretSaved: apiKey !== null,
  };
}

function saveCredentialResult(store: MarketplaceProfileStore, profile: MarketplaceProfile, response: Record<string, unknown>, credentialSpec: Record<string, unknown>): Record<string, unknown> {
  const apiKeyId = typeof response.apiKeyId === 'string' ? response.apiKeyId : '';
  const apiKey = typeof response.apiKey === 'string' ? response.apiKey : null;
  if (!Array.isArray(credentialSpec.scopes) || credentialSpec.scopes.length === 0) {
    throw new MarketplaceApiError('CREDENTIAL_GRANT', 'The new credential has no verified grant.');
  }
  if (apiKey && apiKeyId) {
    store.putIssuedCredential(profile.id, {
      apiKeyId, apiKey,
      scopes: credentialSpec.scopes as string[],
      publishAttoLimit: typeof credentialSpec.publishAttoLimit === 'string' ? credentialSpec.publishAttoLimit : null,
      publishXnoLimit: typeof credentialSpec.publishXnoLimit === 'string' ? credentialSpec.publishXnoLimit : null,
      productPublishAttoLimit: typeof credentialSpec.productPublishAttoLimit === 'string' ? credentialSpec.productPublishAttoLimit : null,
      productPublishXnoLimit: typeof credentialSpec.productPublishXnoLimit === 'string' ? credentialSpec.productPublishXnoLimit : null,
      purchaseAttoLimit: typeof credentialSpec.purchaseAttoLimit === 'string' ? credentialSpec.purchaseAttoLimit : null,
      purchaseXnoLimit: typeof credentialSpec.purchaseXnoLimit === 'string' ? credentialSpec.purchaseXnoLimit : null,
    });
  }
  const safe = safeCredentialMutation(response);
  return { ...safe, ...(apiKeyId ? { next: `The new key is saved privately. Activate it only in a separate scoped profile with: atto-marketplace-mcp setup --profile <new-profile-id> --from-profile ${profile.id} --credential-id ${apiKeyId}` } : {}) };
}

function rotationGrant(value: unknown): z.infer<typeof credentialGrant> {
  const parsed = credentialGrant.safeParse(value);
  if (!parsed.success) throw new MarketplaceApiError('CREDENTIAL_GRANT', 'The rotation target has invalid or unavailable authority metadata.');
  return parsed.data;
}

async function credentialGrantForRotation(api: MarketplaceApiClient, apiKeyId: string): Promise<z.infer<typeof credentialGrant>> {
  const metadata = credentialMetadata((await api.request('/v1/agent/credentials')).json) as Record<string, unknown>[];
  const target = metadata.find(row => row.apiKeyId === apiKeyId);
  if (!target || target.revokedAt !== null) throw new MarketplaceApiError('CREDENTIAL_GRANT', 'The active rotation target was not found in this account.');
  return rotationGrant({
    scopes: target.scopes, publishAttoLimit: target.publishAttoLimit,
    publishXnoLimit: target.publishXnoLimit, productPublishAttoLimit: target.productPublishAttoLimit,
    productPublishXnoLimit: target.productPublishXnoLimit,
    purchaseAttoLimit: target.purchaseAttoLimit, purchaseXnoLimit: target.purchaseXnoLimit,
  });
}

function credentialMetadata(input: unknown): unknown {
  const metadata = z.array(z.object({
    apiKeyId: uuid,
    agentId: uuid.nullable(),
    name: z.string().max(120),
    prefix: z.string().max(120),
    scopes: z.array(z.string().max(100)).max(64),
    publishAttoLimit: nonnegativeAtomic.nullable(),
    publishXnoLimit: nonnegativeAtomic.nullable(),
    productPublishAttoLimit: nonnegativeAtomic.nullable().optional().transform(value => value ?? null),
    productPublishXnoLimit: nonnegativeAtomic.nullable().optional().transform(value => value ?? null),
    purchaseAttoLimit: nonnegativeAtomic.nullable().optional().transform(value => value ?? null),
    purchaseXnoLimit: nonnegativeAtomic.nullable().optional().transform(value => value ?? null),
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    revokedAt: z.string().datetime({ offset: true }).nullable(),
  })).safeParse(input);
  if (!metadata.success) throw new MarketplaceApiError('MARKETPLACE_PROTOCOL', 'Marketplace returned invalid credential metadata.');
  return metadata.data;
}

function profilePublicationTransition(
  context: ToolContext,
  operation: 'profile-publish' | 'profile-unpublish',
  path: '/v1/agent/profile/publish' | '/v1/agent/profile/unpublish',
  expectedStatus: 'PUBLISHED' | 'DRAFT',
  requestIdValue: string,
) {
  const { profiles, profile, api } = context;
  requireSession(profile);
  return mutate(profiles, profile, operation, profile.accountId, requestIdValue, {}, async () => {
    try { return await api.request(path, { method: 'POST', body: {} }); }
    catch (error) {
      if (!(error instanceof MarketplaceApiError) || error.httpStatus !== 409) throw error;
      const current = await api.request('/v1/agent/profile');
      if (asRecord(current.json).status !== expectedStatus) throw error;
      return current;
    }
  });
}

export function registerAccountTools(context: ToolContext): void {
  const { register, api, profiles, profile, walletEnv } = context;

  register('marketplace_profile_get', 'Read this account’s private agent profile. Controller-session mode only.', {}, async () => {
    requireSession(profile); return (await api.request('/v1/agent/profile')).json;
  }, { readOnly: true });
  register('marketplace_profile_link_set', 'Set the website or GitHub link on this profile. Editing invalidates its ownership proof.', { kind: z.enum(['WEBSITE', 'GITHUB']), url: z.string().url().max(2048) }, async args => {
    requireSession(profile); return (await api.request(`/v1/agent/profile/links/${args.kind}`, { method: 'PUT', body: { url: args.url } })).json;
  });
  register('marketplace_profile_link_remove', 'Remove a profile link and its ownership proof.', { kind: z.enum(['WEBSITE', 'GITHUB']) }, async args => {
    requireSession(profile); await api.request(`/v1/agent/profile/links/${args.kind}`, { method: 'DELETE' }); return { removed: true };
  }, { destructive: true });
  register('marketplace_profile_link_challenge', 'Get the exact ownership proof to publish on your website or GitHub profile README. Expires after 24 hours; defaults to the current login controller.', { kind: z.enum(['WEBSITE', 'GITHUB']), controllerIdentityId: uuid.optional() }, async args => {
    requireSession(profile); return (await api.request(`/v1/agent/profile/links/${args.kind}/challenges`, { method: 'POST', body: args.controllerIdentityId ? { controllerIdentityId: args.controllerIdentityId } : {} })).json;
  });
  register('marketplace_profile_link_verify', 'Check the exact public proof source and record ownership evidence time.', { kind: z.enum(['WEBSITE', 'GITHUB']), challengeId: uuid }, async args => {
    requireSession(profile); return (await api.request(`/v1/agent/profile/links/${args.kind}/verify`, { method: 'POST', body: { challengeId: args.challengeId } })).json;
  });
  register('marketplace_profile_update', 'Update this account’s private profile fields. bio is long-form Markdown and appears publicly only when the profile is published; handle, displayName, and capabilities remain plain fields. Controller-session mode only.', { requestId, patch: profilePatch }, async args => {
    requireSession(profile);
    return mutate(profiles, profile, 'profile-update', profile.accountId, String(args.requestId), args.patch,
      () => api.request('/v1/agent/profile', { method: 'PATCH', body: args.patch }));
  });
  register('marketplace_profile_publish', 'Publish this account’s profile for public discovery. Controller-session mode only.', { requestId },
    args => profilePublicationTransition(context, 'profile-publish', '/v1/agent/profile/publish', 'PUBLISHED', String(args.requestId)),
    { destructive: true });
  register('marketplace_profile_unpublish', 'Unpublish this account’s profile from public discovery. Controller-session mode only.', { requestId },
    args => profilePublicationTransition(context, 'profile-unpublish', '/v1/agent/profile/unpublish', 'DRAFT', String(args.requestId)),
    { destructive: true });

  register('marketplace_credentials_list', 'List this account’s scoped credential metadata. Controller-session mode only; secrets are never returned.', {}, async () => {
    requireSession(profile); return credentialMetadata((await api.request('/v1/agent/credentials')).json);
  }, { readOnly: true, preserveCredentialId: true });
  register('marketplace_credentials_create', 'Create one scoped credential after a local typed controller approval. The one-time API key is saved only in the private profile database; use the printed local setup command to activate a separate scoped profile.', {
    requestId, credential,
  }, async args => {
    requireSession(profile);
    const value = args.credential as Record<string, unknown>;
    const command = { operation: 'CREATE', idempotencyKey: String(args.requestId), credential: value };
    return freshProofMutation({
      store: profiles, profile, api, env: walletEnv, home: profiles.home,
      operation: 'credential-create', target: profile.accountId, requestId: String(args.requestId), payload: command,
      purpose: 'API-key creation', challengePath: '/v1/agent/credentials/challenges', challengeBody: command,
      makeAction: () => ({ kind: 'credential', operation: 'CREATE', command }),
      send: proof => api.request('/v1/agent/credentials', { method: 'POST', body: { idempotencyKey: args.requestId, credential: value, proof } }),
      result: response => saveCredentialResult(profiles, profile, asRecord(response), value),
    });
  }, { destructive: true, preserveCredentialId: true });
  register('marketplace_credentials_rotate', 'Rotate one scoped credential after a local typed controller approval. The new one-time key stays in the private profile database until explicitly activated in a separate scoped profile.', {
    requestId, apiKeyId: uuid,
  }, async args => {
    requireSession(profile);
    const targetId = canonicalUuid(args.apiKeyId);
    const command = { operation: 'ROTATE', idempotencyKey: String(args.requestId), targetApiKeyId: targetId };
    return freshProofMutation({
      store: profiles, profile, api, env: walletEnv, home: profiles.home,
      operation: 'credential-rotate', target: targetId, requestId: String(args.requestId), payload: command,
      purpose: 'API-key rotation', challengePath: '/v1/agent/credentials/challenges', challengeBody: command,
      prepare: async () => credentialGrantForRotation(api, targetId),
      makeAction: () => ({ kind: 'credential', operation: 'ROTATE', command }),
      send: proof => api.request(`/v1/agent/credentials/${targetId}/rotate`, { method: 'POST', body: { idempotencyKey: args.requestId, proof } }),
      result: (response, persistedContext) => {
        const saved = saveCredentialResult(profiles, profile, asRecord(response), rotationGrant(persistedContext));
        profiles.deleteIssuedCredential(profile.id, targetId);
        return saved;
      },
    });
  }, { destructive: true, preserveCredentialId: true });
  register('marketplace_credentials_revoke', 'Revoke one scoped credential after a local typed controller approval.', {
    requestId, apiKeyId: uuid,
  }, async args => {
    requireSession(profile);
    const targetId = canonicalUuid(args.apiKeyId);
    const command = { operation: 'REVOKE', idempotencyKey: String(args.requestId), targetApiKeyId: targetId };
    return freshProofMutation({
      store: profiles, profile, api, env: walletEnv, home: profiles.home,
      operation: 'credential-revoke', target: targetId, requestId: String(args.requestId), payload: command,
      purpose: 'API-key revocation', challengePath: '/v1/agent/credentials/challenges', challengeBody: command,
      makeAction: () => ({ kind: 'credential', operation: 'REVOKE', command }),
      send: proof => api.request(`/v1/agent/credentials/${targetId}/revoke`, { method: 'POST', body: { idempotencyKey: args.requestId, proof } }),
      result: response => { profiles.deleteIssuedCredential(profile.id, targetId); return safeCredentialMutation(response); },
    });
  }, { destructive: true, preserveCredentialId: true });
}
