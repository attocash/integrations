import { mutationHash } from './canonical-json.js';
import type { ApiResponse } from './marketplace-api.js';
import { asRecord } from './marketplace-results.js';
import { ProfileError, type MarketplaceProfile, type MarketplaceProfileStore } from './profile-store.js';

interface MutationOptions {
  prepare?: () => Promise<void>;
  pendingResultIdentity?: string;
  validateResult?: (result: unknown, source: 'response' | 'saved') => void;
  resultIdentityFields?: string[];
}

export async function mutate(
  store: MarketplaceProfileStore, profile: MarketplaceProfile, operation: string, target: string,
  requestId: string, payload: unknown, send: () => Promise<ApiResponse>, options: MutationOptions = {},
): Promise<unknown> {
  const requestHash = mutationHash({ operation, target, payload, accountId: profile.accountId });
  const identity = { profileId: profile.id, requestId, operation, target, requestHash };
  if (!store.getMutation(identity)) await options.prepare?.();
  const { pendingResultIdentity } = options;
  const reserved = JSON.stringify({ kind: 'MARKETPLACE_MUTATION_RECOVERY', pendingResultIdentity });
  const previous = store.beginMutation(identity, reserved);
  if (previous.state === 'COMPLETE') {
    options.validateResult?.(previous.resultIdentity === null ? null : JSON.parse(previous.resultIdentity), 'saved');
    return { requestId, recovered: true, resultIdentity: previous.resultIdentity };
  }
  const pending = savedPendingIdentity(previous.resultIdentity);
  if (pendingResultIdentity !== undefined && pending !== pendingResultIdentity) {
    throw new ProfileError('IDEMPOTENCY_CONFLICT', 'This pending request is bound to different application content.');
  }

  const { json: result } = await send();
  options.validateResult?.(result, 'response');
  const safeIdentity = Object.fromEntries(Object.entries(asRecord(result)).filter(([key]) =>
    /(?:id|state|version|replayed)$/i.test(key) || options.resultIdentityFields?.includes(key)));
  store.completeMutation(profile.id, requestId, requestHash, JSON.stringify(safeIdentity));
  return result;
}

function savedPendingIdentity(value: string | null): string | undefined {
  try {
    const parsed = asRecord(value === null ? {} : JSON.parse(value));
    if (parsed.kind !== 'MARKETPLACE_MUTATION_RECOVERY' || parsed.command !== undefined
      || (parsed.pendingResultIdentity !== undefined && typeof parsed.pendingResultIdentity !== 'string')) {
      throw new Error('Invalid recovery record');
    }
    return parsed.pendingResultIdentity;
  } catch {
    throw new ProfileError('RECOVERY_REQUIRED', 'The saved Marketplace request has an invalid recovery record.');
  }
}
