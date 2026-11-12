import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? join(import.meta.dirname, '../../../atto-cli');
const { assertPrivatePermissions } = await import(pathToFileURL(join(cliDirectory, 'dist/internal-marketplace.js')).href);

export async function setPermissions(path, mode) {
  if (process.platform !== 'win32') await chmod(path, mode);
}

export function assertPrivate(path, kind) { assertPrivatePermissions(path, kind); }
