export class AttoError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'AttoError';
  }
}

export function errorResult(error: unknown): { code: string; message: string; details?: unknown } {
  if (error instanceof AttoError) return { code: error.code, message: error.message, details: error.details };
  // Dependency errors can include request headers or key material. Never return their raw messages.
  return { code: 'OPERATION_FAILED', message: 'The operation failed. Check wallet status and endpoint availability.' };
}
