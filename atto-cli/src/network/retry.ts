import { setTimeout as delay } from 'node:timers/promises';
import { AttoError } from '../domain/errors.js';

export interface SendRetry {
  signal: AbortSignal;
  onRetry: (error: AttoError, delayMs: number) => void;
}

function networkError(error: unknown): AttoError | undefined {
  if (error instanceof AttoError) return error;
  if (!(error instanceof Error)) return;
  // Commons exposes standard Error names, but not a public JS HTTP status
  // accessor. Never inspect Kotlin internals or print dependency messages.
  if (error.name === 'ClientRequestException') return new AttoError('NODE_CLIENT_ERROR', 'The node returned an HTTP 4xx error.');
  if (error.name === 'ServerResponseException') return new AttoError('NODE_SERVER_ERROR', 'The node returned an HTTP 5xx error.');
  if (['HttpRequestTimeoutException', 'ConnectTimeoutException', 'SocketTimeoutException'].includes(error.name)) {
    return new AttoError('NODE_TIMEOUT', 'The node request timed out.');
  }
  if ((error.name === 'TypeError' && error.message === 'fetch failed')
    || (error.cause instanceof Error && error.cause.name === 'TypeError' && error.cause.message === 'fetch failed')
    || error.name === 'EOFException') {
    return new AttoError('NODE_UNAVAILABLE', 'The node connection failed.');
  }
}

function retryable(error: AttoError): boolean {
  const status = (error.details as { httpStatus?: number } | undefined)?.httpStatus;
  if (status !== undefined) return status >= 500 && status <= 599;
  return ['NODE_SERVER_ERROR', 'NODE_TIMEOUT', 'NODE_UNAVAILABLE', 'WORK_TIMEOUT', 'WORK_FAILED', 'MARKET_DATA_UNAVAILABLE'].includes(error.code);
}

/** Retry only a network operation, never rebuild a signed payment. Opt-in for CLI sends. */
export async function retryNetwork<T>(operation: () => Promise<T>, retry?: SendRetry): Promise<T> {
  let delayMs = 1000;
  for (;;) {
    if (retry?.signal.aborted) throw new AttoError('CANCELLED', 'Send cancelled.');
    try { return await operation(); }
    catch (error) {
      if (!retry) throw error;
      if (retry.signal.aborted) throw new AttoError('CANCELLED', 'Send cancelled.');
      const failure = networkError(error);
      if (!failure || !retryable(failure)) throw failure ?? error;
      retry.onRetry(failure, delayMs);
      await delay(delayMs, undefined, { signal: retry.signal }).catch(() => {
        throw new AttoError('CANCELLED', 'Send cancelled.');
      });
      delayMs = Math.min(delayMs * 2, 30_000);
    }
  }
}
