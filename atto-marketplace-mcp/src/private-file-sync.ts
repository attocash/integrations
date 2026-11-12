import { dirname, join } from 'node:path';
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readdirSync, unlinkSync, type Stats } from 'node:fs';
import { syncPrivateDirectory } from '@attocash/cli/internal-marketplace';

/** Flush file metadata after publication where directory fsync is unavailable. */
export function syncPublishedPrivateFile(path: string): void {
  if (process.platform !== 'win32') return;
  const before = lstatSync(path);
  const descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) {
      throw new Error('The published private file identity changed.');
    }
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
}

/** Recover only the precise temporary hardlink left by a known publisher.
 * The caller validates its own file and directory policy before invoking this. */
export function recoverPrivatePublication(path: string, temporaryName: RegExp): void {
  const original = lstatSync(path);
  if (original.nlink === 1) return;
  if (!original.isFile() || original.isSymbolicLink() || original.nlink !== 2) throw publicationError();
  const directory = dirname(path);
  const candidates = readdirSync(directory).filter(name => {
    if (!temporaryName.test(name)) return false;
    try { return sameFile(lstatSync(join(directory, name)), original); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  });
  // The original writer may finish its own cleanup during enumeration.
  const current = lstatSync(path);
  if (!sameFile(current, original)) throw publicationError();
  if (current.nlink === 1) return;
  if (current.nlink !== 2 || candidates.length !== 1) throw publicationError();
  const temporary = join(directory, candidates[0]!);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, (process.platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!sameFile(opened, original) || opened.nlink !== 2) throw publicationError();
    const finalPath = lstatSync(path), temporaryPath = lstatSync(temporary);
    if (!sameFile(finalPath, original) || finalPath.nlink !== 2
      || !sameFile(temporaryPath, original) || temporaryPath.nlink !== 2) throw publicationError();
    unlinkSync(temporary);
    const recovered = lstatSync(path);
    if (!sameFile(recovered, original) || recovered.nlink !== 1) throw publicationError();
    fsyncSync(descriptor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const final = lstatSync(path);
    if (!sameFile(final, original) || final.nlink !== 1) throw publicationError();
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
  syncPublishedPrivateFile(path);
  syncPrivateDirectory(directory);
}

function sameFile(candidate: Stats, original: Stats): boolean {
  return candidate.isFile() && !candidate.isSymbolicLink() && candidate.dev === original.dev && candidate.ino === original.ino;
}

function publicationError(): Error { return new Error('The private publication file identity changed.'); }
