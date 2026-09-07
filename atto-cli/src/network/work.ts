import { AttoBlock, AttoWork, attoBlockWorkTarget } from '@attocash/commons-core';
import { AttoError } from '../domain/errors.js';

const RESPONSE_LIMIT = 2048;

/** Request and validate public work without caching, signing, or wallet state. */
export async function requestWork(block: AttoBlock, url: string, signal: AbortSignal): Promise<AttoWork> {
  try {
    const timestamp = Number(block.timestamp.toEpochMilliseconds());
    if (!Number.isSafeInteger(timestamp)) throw new AttoError('INVALID_WORK', 'The work timestamp cannot be represented exactly.');
    // Commons WorkerOperations.Request serializes this public network/time/
    // target tuple. Fetch supplies cancellation absent from its JS worker API.
    const response = await fetch(`${url.replace(/\/+$/, '')}/works`, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ network: block.network.name, timestamp, target: attoBlockWorkTarget(block) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AttoError('WORK_FAILED', `The worker returned HTTP ${response.status}.`, { httpStatus: response.status });
    }
    const value = await readResponse(response);
    if (typeof value !== 'object' || value === null || !('work' in value)
      || typeof value.work !== 'string' || !/^[0-9a-f]{16}$/i.test(value.work)) {
      throw new AttoError('INVALID_WORK', 'The worker returned malformed proof of work.');
    }
    const work = AttoWork.Companion.parse(value.work);
    if (!work.isValid(block)) throw new AttoError('INVALID_WORK', 'The worker returned invalid proof of work.');
    return work;
  } catch (error) {
    if (signal.aborted) throw new AttoError('WORK_TIMEOUT', 'The work request was cancelled or timed out.');
    if (error instanceof AttoError) throw error;
    throw new AttoError('WORK_FAILED', 'Proof-of-work generation failed. Check the worker endpoint. Run doctor for diagnostics.');
  }
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new AttoError('INVALID_WORK', 'The worker returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) throw new AttoError('INVALID_WORK', 'The worker response exceeds the allowed size.');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new AttoError('INVALID_WORK', 'The worker returned malformed JSON.'); }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
