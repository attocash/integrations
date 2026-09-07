import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WalletProfile } from '../storage/profiles.js';
import type { WalletIdentity } from '../wallet/types.js';
import type { DoctorCheck } from './types.js';
import type { CredentialRequest, CredentialResult } from './credential-probe.js';

/** Bound native keyring calls too, and terminate any secret-tool subprocess with its parent. */
export function probeCredential(request: CredentialRequest, signal: AbortSignal, env = process.env): Promise<CredentialResult> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve('timeout'); return; }
    const child = spawn(process.execPath, [fileURLToPath(new URL('./credential-probe.js', import.meta.url))], {
      env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: process.platform !== 'win32', windowsHide: true,
    });
    let result: CredentialResult = 'unavailable';
    let stopped = false;
    const stop = () => {
      stopped = true;
      result = 'timeout';
      if (child.pid) {
        try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); }
        catch { /* The child may already have exited. */ }
      }
    };
    const timer = setTimeout(stop, 30_000);
    signal.addEventListener('abort', stop, { once: true });
    child.on('message', value => {
      if (!stopped && !signal.aborted && typeof value === 'string' && ['matched', 'readable', 'missing', 'invalid', 'mismatch', 'unavailable', 'backend_unavailable'].includes(value)) result = value as CredentialResult;
    });
    child.on('error', () => { /* The close event performs cleanup after spawn errors too. */ });
    child.once('close', () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      resolve(result);
    });
    child.once('spawn', () => {
      if (signal.aborted) stop();
      else child.send(request, error => { if (error) child.kill(); });
    });
  });
}

async function secretToolPath(): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory || '.', 'secret-tool');
    try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) return candidate; } catch { /* Try the next PATH entry. */ }
  }
  return undefined;
}

function busPath(address: string | undefined): string | undefined {
  const match = address?.match(/^unix:path=([^,;]+)(?:,guid=[a-f\d]+)?$/i);
  if (!match) return;
  try {
    const path = decodeURIComponent(match[1]!);
    if (isAbsolute(path) && !/[\x00-\x1f\x7f]/.test(path)) return path;
  } catch { /* Other D-Bus address forms are left to the credential adapter. */ }
}

async function ownedSocket(path: string): Promise<boolean> {
  try {
    const [socket, directory] = await Promise.all([stat(path), stat(dirname(path))]);
    return socket.isSocket() && socket.uid === process.getuid?.() && directory.isDirectory() && directory.uid === socket.uid;
  } catch { return false; }
}

export async function checkKeyring(profile: WalletProfile, identity: WalletIdentity | undefined, signal: AbortSignal): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  if (process.platform === 'linux') {
    const executable = await secretToolPath();
    checks.push({ id: 'keyring.backend', status: executable ? 'pass' : 'fail', code: executable ? 'KEYRING_BACKEND_FOUND' : 'SECRET_TOOL_MISSING',
      message: executable ? 'secret-tool is executable in this process PATH.' : 'secret-tool is not executable in this process PATH.',
      ...(executable ? { evidence: { executable } } : { remediation: { steps: ['Install secret-tool using your OS package manager, or expose its installed directory in the MCP launch PATH.', 'Rerun doctor from the failing environment.'] } }) });
    const configuredBus = busPath(process.env.DBUS_SESSION_BUS_ADDRESS);
    const socketFound = configuredBus ? await ownedSocket(configuredBus) : false;
    checks.push({ id: 'keyring.environment', status: 'pass', code: 'KEYRING_ENVIRONMENT',
      message: 'Environment observations only; the credential check below verifies actual access.',
      evidence: { sessionBusAddressPresent: Boolean(process.env.DBUS_SESSION_BUS_ADDRESS), runtimeDirectoryPresent: Boolean(process.env.XDG_RUNTIME_DIR), configuredUserSocketFound: socketFound } });
    if (!executable) return [...checks, { id: 'keyring.credential', status: 'skipped', code: 'KEYRING_BACKEND_REQUIRED', message: 'Credential verification requires secret-tool.' }];
  }
  const request: CredentialRequest = { service: profile.credentialService, account: profile.credentialAccount,
    ...(identity ? { address: identity.address, fingerprint: identity.fingerprint } : {}) };
  const result = await probeCredential(request, signal);
  const outcomes: Record<CredentialResult, Pick<DoctorCheck, 'status' | 'code' | 'message'>> = {
    matched: { status: 'pass', code: 'KEYRING_CREDENTIAL_MATCHED', message: 'The stored credential is readable and matches this wallet.' },
    readable: { status: 'warn', code: 'KEYRING_CREDENTIAL_WITHOUT_WALLET', message: 'A valid stored credential exists, but this profile has no initialized wallet.' },
    missing: { status: identity ? 'fail' : 'warn', code: 'KEYRING_CREDENTIAL_MISSING', message: 'No credential was found for this profile.' },
    invalid: { status: 'fail', code: 'KEYRING_CREDENTIAL_INVALID', message: 'The stored credential is not a valid Atto recovery phrase.' },
    mismatch: { status: 'fail', code: 'KEYRING_CREDENTIAL_MISMATCH', message: 'The stored credential does not match the saved wallet identity.' },
    unavailable: { status: 'fail', code: 'KEYRING_UNAVAILABLE', message: 'Credential access failed. The service may be unavailable, locked, or denying access.' },
    backend_unavailable: { status: 'fail', code: 'KEYRING_BACKEND_UNAVAILABLE', message: 'The native password-store backend could not load.' },
    timeout: { status: 'fail', code: 'KEYRING_TIMEOUT', message: 'The password-store check timed out or was cancelled.' },
  };
  const check: DoctorCheck = { id: 'keyring.credential', ...outcomes[result] };
  if (['unavailable', 'timeout'].includes(result)) {
    check.remediation = { steps: ['Unlock the OS password store and allow this application to access it.',
      ...(process.platform === 'linux' ? ['In a working desktop terminal, inspect DBUS_SESSION_BUS_ADDRESS and XDG_RUNTIME_DIR with printenv. Supply the actual session values in the MCP server env configuration.'] : []),
      'Restart the MCP connection after changing its launch environment, then rerun its doctor tool.'] };
    if (process.platform === 'linux' && !signal.aborted) {
      const directories = [...new Set([process.env.XDG_RUNTIME_DIR, `/run/user/${process.getuid!()}`])];
      for (const directory of directories) {
        if (!directory || !isAbsolute(directory) || /[\x00-\x1f\x7f]/.test(directory)) continue;
        const path = join(directory, 'bus');
        if (!await ownedSocket(path)) continue;
        const suggestedEnv = { DBUS_SESSION_BUS_ADDRESS: `unix:path=${encodeURIComponent(path).replace(/%2F/g, '/')}`, XDG_RUNTIME_DIR: directory };
        if (Object.entries(suggestedEnv).every(([key, value]) => process.env[key] === value)) continue;
        const retried = await probeCredential(request, signal, { ...process.env, ...suggestedEnv });
        // An absent credential does not prove the suggested environment fixes this wallet.
        if (retried === 'matched' || (!identity && retried === 'readable')) {
          check.remediation = { steps: ['Credential access succeeded only in an isolated probe with these environment overrides.',
            'Add suggestedEnv to the MCP server env configuration, restart the connection, and rerun doctor. The current process was not changed.'], suggestedEnv, restartRequired: true };
          check.code = 'KEYRING_ENVIRONMENT_FIX_VERIFIED';
          break;
        }
        // Try at most one alternative session, within the overall doctor deadline.
        break;
      }
    }
  } else if (result !== 'matched') {
    check.remediation = { steps: result === 'backend_unavailable'
      ? ['Reinstall the package for this OS and architecture, then rerun doctor.']
      : !identity && result === 'missing'
        ? ['Create or import a wallet in your local terminal using this same data directory.']
        : ['Verify the selected data directory and credential service/account.', 'Preserve the original public wallet profile and recover its matching credential from your private backup. Do not reset or replace the wallet to repair access.'] };
  }
  checks.push(check);
  return checks;
}
