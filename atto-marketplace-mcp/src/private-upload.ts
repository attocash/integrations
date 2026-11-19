import { z } from 'zod';
import { MarketplaceApiError, type MarketplaceApiClient } from './marketplace-api.js';
import { mutate } from './marketplace-mutation.js';
import { asRecord, parseMarketplaceDto, uuid } from './marketplace-results.js';
import type { MarketplaceProfile, MarketplaceProfileStore } from './profile-store.js';
import { MAX_PRIVATE_FILE_BYTES, readLocalSource, type LocalPrivateFile } from './submission-files.js';

const fileSize = z.number().int().min(1).max(MAX_PRIVATE_FILE_BYTES);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const privateFileResponse = z.strictObject({
  fileId: uuid, contentVersionId: uuid, filename: z.string().min(1).max(255),
  byteLength: fileSize, mediaType: z.string().min(1).max(255), sha256, state: z.literal('READY'),
});
const privateFileUploadStatus = z.strictObject({
  uploadId: uuid, state: z.enum(['PENDING_UPLOAD', 'SCANNING', 'READY', 'REJECTED', 'EXPIRED']),
  file: privateFileResponse.nullable(),
});
const privateFileTransfer = z.strictObject({
  uploadId: uuid, state: z.literal('PENDING_UPLOAD'), byteLength: fileSize, sha256,
});

type ReadyFile = z.infer<typeof privateFileResponse>;
type UploadOperation = 'submission-file-upload' | 'product-file-upload';
const transferTimeoutMs = 15 * 60 * 1000;

export async function uploadPrivateFile(
  store: MarketplaceProfileStore, profile: MarketplaceProfile, api: MarketplaceApiClient,
  operation: UploadOperation, filesDirectory: string | undefined, sourcePath: string, requestId: string,
): Promise<ReadyFile> {
  const source = readLocalSource(filesDirectory, sourcePath);
  const body = { filename: source.filename, byteLength: source.byteLength, declaredMediaType: null, sha256: source.sha256 };
  const target = JSON.stringify({ marketplaceOrigin: profile.origin, accountId: profile.accountId });
  const headers = { 'Idempotency-Key': requestId };
  const intent = await mutate(store, profile, operation, target, requestId, body,
    () => api.request('/v1/agent/files/uploads', { method: 'POST', body, headers }),
    { validateResult: validateUploadIntent, resultIdentityFields: ['uploadId', 'state'] });
  const uploadId = extractUploadId(intent);
  const path = `/v1/agent/files/uploads/${uploadId}`;
  const deadline = Date.now() + transferTimeoutMs;

  async function readStatus() {
    const response = await api.request(path);
    const status = parseMarketplaceDto(privateFileUploadStatus, response.json, 'private upload status');
    if (status.uploadId !== uploadId) {
      throw new MarketplaceApiError('MARKETPLACE_PROTOCOL', 'Marketplace returned status for a different private upload.');
    }
    return status;
  }

  const current = await readStatus();
  if (current.state === 'READY' && current.file) return verifyReadyFile(current.file, source);
  if (current.state === 'PENDING_UPLOAD') {
    await transferBytes(api, path, uploadId, source);
  } else if (current.state !== 'SCANNING') {
    throw fileNotReady(current.state);
  }

  // A scanner outage may leave a prior finalize in progress. Replay its original key before polling.
  const response = await api.request(`${path}/finalize`, { method: 'POST', headers });
  const label = current.state === 'SCANNING' ? 'private upload finalization recovery' : 'private upload finalization';
  let result = parseMarketplaceDto(privateFileUploadStatus, response.json, label);
  if (result.uploadId !== uploadId) {
    throw new MarketplaceApiError('MARKETPLACE_PROTOCOL', 'Marketplace finalized a different private upload.');
  }
  const waitUntil = Math.min(deadline, Date.now() + 120_000);
  while (result.state === 'SCANNING') {
    if (Date.now() >= waitUntil) {
      throw new MarketplaceApiError('FILE_SCAN_PENDING',
        'Marketplace is still scanning this upload. Retry the original upload tool with the same requestId and unchanged source bytes.');
    }
    await new Promise(resolve => setTimeout(resolve, 500));
    result = await readStatus();
  }
  if (result.state === 'READY' && result.file) return verifyReadyFile(result.file, source);
  throw fileNotReady(result.state);
}

async function transferBytes(api: MarketplaceApiClient, path: string, uploadId: string, source: LocalPrivateFile): Promise<void> {
  const blob = new Blob([new Uint8Array(source.bytes).buffer], { type: 'application/octet-stream' });
  try {
    const response = await api.requestStream(`${path}/content`, {
      method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: blob,
      timeoutMs: transferTimeoutMs, allowStatus: [200],
    });
    const transferred = parseMarketplaceDto(privateFileTransfer, await response.json(), 'private file transfer');
    if (transferred.uploadId !== uploadId || transferred.byteLength !== source.byteLength || transferred.sha256 !== source.sha256) {
      throw new MarketplaceApiError('FILE_INTEGRITY', 'Marketplace returned transfer metadata different from the selected bytes.');
    }
  } catch (error) {
    if (!(error instanceof MarketplaceApiError) || error.httpStatus !== 409) throw error;
  }
}

function verifyReadyFile(file: ReadyFile, source: LocalPrivateFile): ReadyFile {
  if (file.filename !== source.filename || file.byteLength !== source.byteLength || file.sha256 !== source.sha256) {
    throw new MarketplaceApiError('FILE_INTEGRITY', 'Marketplace returned READY file metadata different from the explicitly selected source.');
  }
  return file;
}

function fileNotReady(state: string): MarketplaceApiError {
  return new MarketplaceApiError('FILE_NOT_READY', `Marketplace upload is ${state.toLowerCase()} and cannot be attached.`, 409);
}

function validateUploadIntent(value: unknown): void {
  const result = asRecord(value);
  if (!uuid.safeParse(result.uploadId).success || !['PENDING_UPLOAD', 'SCANNING', 'READY'].includes(String(result.state))) {
    throw new MarketplaceApiError('MARKETPLACE_PROTOCOL', 'Marketplace returned an invalid private upload intent.');
  }
}

function extractUploadId(value: unknown): string {
  const result = asRecord(value);
  const direct = uuid.safeParse(result.uploadId);
  if (direct.success) return direct.data;
  if (result.recovered === true && typeof result.resultIdentity === 'string') {
    try {
      const identity = asRecord(JSON.parse(result.resultIdentity));
      const saved = uuid.safeParse(identity.uploadId);
      if (saved.success) return saved.data;
    } catch { /* Report an invalid saved identity below. */ }
  }
  throw new MarketplaceApiError('MARKETPLACE_PROTOCOL',
    'The saved private upload intent could not be recovered; keep the original requestId.');
}
