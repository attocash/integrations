import { assertPrivatePermissions, securePrivatePermissions } from '@attocash/cli/internal-marketplace';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { ProfileError } from './profile-error.js';

export function ensurePrivateDirectory(directory: string): string {
  if (!directory || directory.includes('\0') || directory.length > 4096 || !isAbsolute(directory)) throw fileError();
  const target = resolve(directory);
  const root = parse(target).root;
  let current = root;
  for (const segment of target.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    let info;
    try { info = lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw fileError();
      try { mkdirSync(current, { mode: 0o700 }); } catch (createError) {
        if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw fileError();
      }
      try { info = lstatSync(current); } catch { throw fileError(); }
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw fileError();
  }
  const info = lstatSync(target);
  if (info.isSymbolicLink() || !info.isDirectory()
    || (process.platform !== 'win32' && typeof process.getuid === 'function' && info.uid !== process.getuid())) throw fileError();
  if (process.platform !== 'win32') chmodSync(target, 0o700);
  const secured = lstatSync(target);
  if (!secured.isDirectory() || secured.isSymbolicLink() || (process.platform !== 'win32' && (secured.mode & 0o077) !== 0)) throw fileError();
  return target;
}

/** Validates public directory metadata without reading any wallet files or secrets. */
export function assertWalletDirectory(path: string, allowMissing = false): boolean {
  if (!isAbsolute(path) || path.length > 4096 || resolve(path) !== path
    || /[\u0000-\u001f\u007f]/.test(path)) throw walletPathError();
  if (process.platform === 'win32') {
    try { assertPrivatePermissions(path, 'directory'); return true; }
    catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw walletPathError();
      // Check existing ancestors from the root before accepting a missing setup target.
    }
  }
  let current = parse(path).root;
  for (const component of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    let info;
    try { info = lstatSync(current); }
    catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw walletPathError();
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw walletPathError();
  }
  const info = lstatSync(path);
  if (process.platform !== 'win32' && (typeof process.getuid !== 'function'
    || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700)) throw walletPathError();
  return true;
}

export function assertPrivateProfileFile(path: string, allowMissing: boolean): boolean {
  let info;
  try { info = lstatSync(path); }
  catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw walletPathError();
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || (process.platform !== 'win32' && (typeof process.getuid !== 'function'
      || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600))) throw walletPathError();
  return true;
}

/** Check existing SQLite artifacts before SQLite opens them. */
export function assertProfileFiles(home: string): void {
  assertWalletDirectory(home);
  const database = join(home, 'profiles.sqlite');
  assertPrivateProfileFile(database, false);
  for (const suffix of ['-journal', '-wal', '-shm']) assertPrivateProfileFile(database + suffix, true);
}

export function ensureProfileHome(home: string): void {
  let current = parse(home).root;
  for (const component of home.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    let created = false;
    try { mkdirSync(current, { mode: 0o700 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ProfileError('PROFILE_PATH', 'The Marketplace MCP profile directory must be a real directory.');
    if (created) securePrivatePermissions(current, 'directory');
  }
}

export function walletPathError(): ProfileError {
  return new ProfileError('WALLET_SETUP_REQUIRED', 'The selected Marketplace wallet or its private profile storage is missing or unsafe. Review the wallet selection in the local terminal.');
}

function fileError(): ProfileError {
  return new ProfileError('PRIVATE_DIRECTORY', 'The private local directory is unavailable or invalid.');
}
