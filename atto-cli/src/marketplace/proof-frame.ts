export interface ControllerProofFrame {
  header: string;
  audience: string;
  network: string;
  address: string;
  purpose: string;
  challengeId: string;
  bindingHash?: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

const PROOF_WINDOW_MAX_MS = 300_000;
const PROOF_CLOCK_SKEW_MS = 30_000;

/** Parse a 9- or 10-line Marketplace controller proof frame without interpreting action semantics. */
export function parseControllerProofFrame(
  message: string,
  expectedHeader: string,
  options: { requireBindingHash?: boolean } = {},
): ControllerProofFrame | undefined {
  if (/[\r\0]/.test(message)) return undefined;
  const lines = message.split('\n');
  if (lines.length !== 9 && lines.length !== 10) return undefined;
  if (lines[0] !== expectedHeader || !lines[1]?.startsWith('Audience: ')
    || !lines[2]?.startsWith('Network: ') || !lines[3]?.startsWith('Address: ')
    || !lines[4]?.startsWith('Purpose: ') || !lines[5]?.startsWith('Request ID: ')) {
    return undefined;
  }
  const hasBinding = lines[6]?.startsWith('Binding Hash: ') === true;
  if (options.requireBindingHash && !hasBinding) return undefined;
  if ((hasBinding && lines.length !== 10) || (!hasBinding && lines.length !== 9)) return undefined;
  const nonceIndex = hasBinding ? 7 : 6;
  if (!/^Nonce: [0-9a-f]{64}$/.test(lines[nonceIndex] ?? '')
    || !lines[nonceIndex + 1]?.startsWith('Issued At: ')
    || !lines[nonceIndex + 2]?.startsWith('Expiration Time: ')) {
    return undefined;
  }
  const bindingHash = hasBinding ? lines[6]!.slice('Binding Hash: '.length) : undefined;
  if (bindingHash !== undefined && !/^[0-9a-f]{64}$/.test(bindingHash)) return undefined;
  return {
    header: lines[0]!,
    audience: lines[1]!.slice('Audience: '.length),
    network: lines[2]!.slice('Network: '.length),
    address: lines[3]!.slice('Address: '.length),
    purpose: lines[4]!.slice('Purpose: '.length),
    challengeId: lines[5]!.slice('Request ID: '.length),
    ...(bindingHash !== undefined ? { bindingHash } : {}),
    nonce: lines[nonceIndex]!.slice('Nonce: '.length),
    issuedAt: lines[nonceIndex + 1]!.slice('Issued At: '.length),
    expiresAt: lines[nonceIndex + 2]!.slice('Expiration Time: '.length),
  };
}

export function isProofWindowValid(
  issuedAt: number,
  expiresAt: number,
  options: { now?: number; allowExpired?: boolean; allowFuture?: boolean } = {},
): boolean {
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || issuedAt <= 0 || expiresAt <= 0) return false;
  if (expiresAt <= issuedAt || expiresAt - issuedAt > PROOF_WINDOW_MAX_MS) return false;
  if (!options.allowFuture && issuedAt > now + PROOF_CLOCK_SKEW_MS) return false;
  if (!options.allowExpired && expiresAt <= now) return false;
  return true;
}
