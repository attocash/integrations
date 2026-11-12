import { chmod } from 'node:fs/promises';
import { assertPrivatePermissions } from '@attocash/cli/internal-marketplace';

export async function setPermissions(path, mode) {
  if (process.platform !== 'win32') await chmod(path, mode);
}

export function assertPrivate(path, kind) { assertPrivatePermissions(path, kind); }
