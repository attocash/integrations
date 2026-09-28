import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(workspace, 'atto-cli', 'package.json'));

async function packageDirectory(name) {
  let entry = require.resolve(name);
  let directory = dirname(entry);
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (manifest.name === name) return { directory, manifest };
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate installed package ${name}.`);
    directory = parent;
  }
}

const expected = process.env.ATTO_COMMONS_LOCAL_VERSION;
if (expected && !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(expected)) {
  throw new Error('ATTO_COMMONS_LOCAL_VERSION must be an exact semantic version, such as 8.1.0-local.0.');
}

const { directory, manifest } = await packageDirectory('@attocash/commons-core');
const versionOkay = expected ? manifest.version === expected : manifest.version !== '8.0.0';
if (!versionOkay) {
  throw new Error(`@attocash/commons-core ${manifest.version} does not expose the required AttoSignature.isValidMessage API. Install the complete local Commons package set first (for example 8.1.0-local.0) and set ATTO_COMMONS_LOCAL_VERSION to that exact version; do not use a type cast or the published 8.0.0 package.`);
}
const declarationPath = join(directory, manifest.types ?? '');
if (!manifest.types || !/isValidMessage\s*\(/.test(await readFile(declarationPath, 'utf8'))) {
  throw new Error(`Installed @attocash/commons-core ${manifest.version} is missing isValidMessage in ${manifest.types ?? 'its type declarations'}. Rebuild and install the Commons JS package set.`);
}
