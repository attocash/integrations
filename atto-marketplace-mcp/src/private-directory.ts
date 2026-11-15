import {chmodSync,lstatSync,mkdirSync} from 'node:fs';
import {isAbsolute,join,parse,resolve,sep} from 'node:path';
import {ProfileError} from './profile-store.js';
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

function fileError():ProfileError{return new ProfileError('PRIVATE_DIRECTORY','The private local directory is unavailable or invalid.');}
