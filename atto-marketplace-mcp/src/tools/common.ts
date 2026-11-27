import { z } from 'zod';
import { fundingNetworks } from '../asset-network.js';
import { MarketplaceApiClient, MarketplaceApiError } from '../marketplace-api.js';
import { uuid } from '../marketplace-results.js';
import { NONNEGATIVE_ATOMIC_PATTERN, POSITIVE_ATOMIC_PATTERN } from '../marketplace-validation.js';
import { ProfileError } from '../profile-error.js';
import type { MarketplaceProfile, MarketplaceProfileStore } from '../profile-store.js';
import { publishVerifiedResponse, resolveDownloadDestination, type ImmutableFileManifestEntry } from '../submission-files.js';

export const positiveAtomic = z.string().regex(POSITIVE_ATOMIC_PATTERN);
export const nonnegativeAtomic = z.string().regex(NONNEGATIVE_ATOMIC_PATTERN);
export const pageLimit = z.number().int().min(1).max(100).default(24);
export const requestId = uuid;
export const asset = z.enum(['ATTO', 'XNO']);
export const fundingNetwork = z.enum(fundingNetworks);

export const workReceipt = z.strictObject({
  receiptId: uuid, taskId: uuid, outcome: z.string(), content: z.record(z.string(), z.string()),
  canonicalBase64: z.string(), contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  signatureBase64: z.string(), keyVersion: z.string(), paymentRequirementId: uuid, createdAt: z.string(),
});

export const receiptVerificationKey = z.strictObject({
  version: z.string().min(1).max(64), algorithm: z.literal('Ed25519'), publicKeyBase64: z.string().min(1).max(256),
});

export const downloadDestinationPath = z.string().min(1).max(4096)
  .describe('Explicit new destination path relative to --files-dir, or an absolute path beneath that directory. The parent folder must already exist and be private.');

export const uploadSourcePath = z.string().min(1).max(4096)
  .describe('Explicit path relative to --files-dir, or an absolute path beneath that directory.');

export interface ToolHints {
  readOnly?: boolean;
  destructive?: boolean;
  preserveCredentialId?: boolean;
  validatedPublicReceipt?: boolean;
}

export type RegisterTool = (
  name: string,
  description: string,
  inputSchema: Record<string, z.ZodType>,
  handler: (args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>,
  hints?: ToolHints,
  strictInput?: boolean,
  schemaFactory?: (shape: Record<string, z.ZodType>) => z.ZodType,
) => void;

export interface ToolContext {
  profiles: MarketplaceProfileStore;
  profileId: string;
  profile: MarketplaceProfile;
  api: MarketplaceApiClient;
  walletEnv: NodeJS.ProcessEnv;
  nanoWork?: ((hash: string, difficulty: string) => Promise<string>) | undefined;
  filesDirectory?: string | undefined;
  register: RegisterTool;
}

function requireScope(profile: MarketplaceProfile, scope: string): void {
  if (profile.authMode === 'controller-session') return;
  if (profile.authMode !== 'scoped-api-key' || !profile.apiKey || !profile.apiScopes.includes(scope)) {
    throw new ProfileError('SCOPE_REQUIRED', `This profile’s scoped API key lacks ${scope}. Reconfigure it in the local terminal.`);
  }
}

export function requireAccess(profile: MarketplaceProfile, scopes: string[]): void {
  if (profile.authMode === 'controller-session') return;
  for (const scope of scopes) requireScope(profile, scope);
}

export function enforcePublishCeiling(profile: MarketplaceProfile, assetName: string, amountText: string): void {
  if (profile.authMode === 'controller-session') return;
  const ceiling = assetName === 'ATTO' ? profile.publishAttoLimit : assetName === 'XNO' ? profile.publishXnoLimit : null;
  if (!ceiling || requireAtomic(amountText) > requireAtomic(ceiling)) {
    throw new ProfileError('CEILING_EXCEEDED', `This scoped API key does not permit publishing this ${assetName} amount.`);
  }
}

export function enforceProductPublishCeiling(profile: MarketplaceProfile, assetName: string, amountText: string): void {
  if (profile.authMode === 'controller-session') return;
  const ceiling = assetName === 'ATTO' ? profile.productPublishAttoLimit : assetName === 'XNO' ? profile.productPublishXnoLimit : null;
  if (!ceiling || requireAtomic(amountText) > requireAtomic(ceiling)) {
    throw new ProfileError('CEILING_EXCEEDED', `This scoped API key does not permit a ${assetName} product publication reservation of that size.`);
  }
}

function requireAtomic(value: string): bigint {
  if (!NONNEGATIVE_ATOMIC_PATTERN.test(value)) {
    throw new MarketplaceApiError('MARKETPLACE_PROTOCOL', 'Marketplace returned an invalid atomic amount.');
  }
  return BigInt(value);
}

export async function downloadVerifiedPrivateFile<TResult>(options: {
  api: MarketplaceApiClient;
  filesDirectory: string | undefined;
  destinationPath: string;
  fileId: string;
  resolveFile: () => Promise<{ entry: ImmutableFileManifestEntry; buildResult: (savedAs: string) => TResult }>;
}): Promise<TResult> {
  const destination = resolveDownloadDestination(options.filesDirectory, options.destinationPath);
  const { entry, buildResult } = await options.resolveFile();
  const body = await options.api.requestStream(`/v1/agent/files/${encodeURIComponent(options.fileId)}/content`, {
    method: 'GET', timeoutMs: 15 * 60 * 1000, allowStatus: [200],
  });
  const savedAs = await publishVerifiedResponse(options.filesDirectory, destination, body, entry);
  return buildResult(savedAs);
}

export function safeError(error: unknown): { code: string; message: string; httpStatus?: number; details?: Record<string, unknown> } {
  if (error instanceof ProfileError || error instanceof MarketplaceApiError) {
    return {
      code: error.code,
      message: error.message,
      ...(error instanceof MarketplaceApiError && error.httpStatus ? { httpStatus: error.httpStatus } : {}),
      ...(error instanceof MarketplaceApiError && error.details ? { details: error.details } : {}),
    };
  }
  return { code: 'INTERNAL_ERROR', message: 'The Marketplace MCP operation failed. Check the local server log for a non-sensitive diagnostic.' };
}
