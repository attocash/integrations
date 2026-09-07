import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../../', import.meta.url));
export const moduleUrl = name => pathToFileURL(join(cliDirectory, 'dist', name)).href;
const execute = promisify(execFile);

/** Test-only Node preload. Never reads the user's password store on any OS. */
export async function credentialEnvironment(t, phrase, mode = 'available') {
  const directory = await mkdtemp(join(tmpdir(), 'atto test credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credential = join(directory, 'synthetic-only');
  await writeFile(credential, phrase, { mode: 0o600 });
  const source = `
    import { readFile } from 'node:fs/promises';
    import { OsSecretStore } from ${JSON.stringify(moduleUrl('storage/secrets.js'))};
    import { AttoError } from ${JSON.stringify(moduleUrl('domain/errors.js'))};
    OsSecretStore.prototype.get = async function () {
      if (${JSON.stringify(mode)} === 'unavailable') throw new AttoError('SECRET_STORE_UNAVAILABLE', 'Synthetic unavailable password store.');
      return readFile(${JSON.stringify(credential)}, 'utf8');
    };
    OsSecretStore.prototype.set = OsSecretStore.prototype.remove = async () => { throw new Error('Unexpected test credential mutation'); };
  `;
  const preload = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return { ...process.env, NODE_OPTIONS: `--import=${preload}`, NO_UPDATE_NOTIFIER: '1' };
}

export async function cli(directory, args, env = process.env) {
  const result = await execute(process.execPath, [join(cliDirectory, 'dist/cli/main.js'), '--data-dir', directory, '--json', ...args], {
    env, timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  return JSON.parse(result.stdout).result;
}
