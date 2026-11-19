import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// An exported entry may be several directories below its owning manifest.
export async function installedPackage(name, entry) {
  let directory = dirname(await realpath(entry));
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (manifest.name === name) return { directory, manifest };
    } catch { /* Continue past directories without a package manifest. */ }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate the installed manifest for ${name}.`);
    directory = parent;
  }
}

export function localCommonsVersion() {
  const version = process.env.ATTO_COMMONS_LOCAL_VERSION;
  if (version && !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) {
    throw new Error('ATTO_COMMONS_LOCAL_VERSION must be an exact semantic version, such as 8.1.0-local.0.');
  }
  return version;
}
