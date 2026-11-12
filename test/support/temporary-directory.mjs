import { realpathSync } from 'node:fs';
import { tmpdir as operatingSystemTmpdir } from 'node:os';

// Resolve macOS and other operating-system temporary-directory aliases.
export function tmpdir() { return realpathSync(operatingSystemTmpdir()); }
