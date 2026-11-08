import {realpathSync} from 'node:fs';
import {tmpdir as operatingSystemTmpdir} from 'node:os';

// macOS exposes temporary directories through /var, which is a symlink.
// Resolve only the fixture root; wallet paths must still reject symlink ancestors.
export function tmpdir() {
  return realpathSync(operatingSystemTmpdir());
}
