import { AttoAddress } from '@attocash/commons-core';
import { AttoError } from './errors.js';

export function parseAddress(value: string): AttoAddress {
  try { return AttoAddress.parse(value); }
  catch { throw new AttoError('INVALID_ADDRESS', 'Provide a valid Atto address.'); }
}
