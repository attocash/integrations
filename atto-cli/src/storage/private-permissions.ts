import { chmodSync, closeSync, constants, fsyncSync, lstatSync, openSync, type Stats } from 'node:fs';
import { dirname, resolve, win32 } from 'node:path';

export type PrivatePathKind = 'file' | 'directory';
export interface PrivatePath {
  path: string;
  kind: PrivatePathKind;
  /** Missing sidecars are allowed; existing artifacts always require validation. */
  optional?: boolean;
}

/** Check ordinary file metadata and POSIX ownership/modes. Windows uses the
 * permissions inherited from the user's directory; Node does not verify ACLs. */
export function assertPrivatePermissionsBatch(paths: readonly PrivatePath[]): void {
  privatePermissionsBatch(paths, false);
}

export function assertPrivatePermissions(path: string, kind: PrivatePathKind): void {
  assertPrivatePermissionsBatch([{ path, kind }]);
}

/** Apply POSIX owner-only modes before writing; check metadata on Windows. */
export function securePrivatePermissions(path: string, kind: PrivatePathKind): void {
  privatePermissionsBatch([{ path, kind }], true);
}

function privatePermissionsBatch(paths: readonly PrivatePath[], secure: boolean): void {
  for (const entry of paths) {
    if (entry.kind !== 'file' && entry.kind !== 'directory') throw privatePermissionsError();
    const path = checkedPath(entry.path);
    try {
      const info = inspectPath(path, entry.kind);
      if (process.platform !== 'win32') {
        const mode = entry.kind === 'directory' ? 0o700 : 0o600;
        if (secure) chmodSync(path, mode);
        else if ((info.mode & 0o777) !== mode) throw privatePermissionsError();
      }
    } catch (error) {
      if (!entry.optional || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/**
 * POSIX persists directory entries. Windows has no portable directory-fsync
 * equivalent: callers must fsync the published file, including after a rename
 * or link. This does not promise power-loss durability of the parent namespace.
 */
export function syncPrivateDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function checkedPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) throw privatePermissionsError();
  if (process.platform !== 'win32') return resolve(path);
  // Exclude DOS devices, alternate streams and Win32 name aliases. They do not
  // identify an ordinary local file with the same semantics as our callers.
  if (!/^[a-z]:[\\/]/i.test(path) || /[\u0000-\u001f\u007f]/.test(path)) throw privatePermissionsError();
  for (const component of path.slice(3).split(/[\\/]/)) {
    if (component === '.' || component === '..' || /[<>:"|?*]/.test(component) || /[. ]$/.test(component)
      || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(component)) throw privatePermissionsError();
  }
  return win32.resolve(path);
}

function inspectPath(path: string, kind: PrivatePathKind): Stats {
  const parentDirectory = process.platform === 'win32' ? win32.dirname : dirname;
  let ancestor = parentDirectory(path);
  for (;;) {
    if (lstatSync(ancestor).isSymbolicLink()) throw privatePermissionsError();
    const parent = parentDirectory(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const info = lstatSync(path);
  if (info.isSymbolicLink() || (kind === 'directory' ? !info.isDirectory() : !info.isFile())) throw privatePermissionsError();
  if (process.platform !== 'win32' && (typeof process.getuid !== 'function' || info.uid !== process.getuid())) throw privatePermissionsError();
  return info;
}

function privatePermissionsError(): Error & { code: string } {
  return Object.assign(new Error('Private file metadata or permissions could not be verified.'), { code: 'PRIVATE_PERMISSIONS' });
}
