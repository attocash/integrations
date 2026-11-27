import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { privateKeyToSigner, toAttoIndex } from '@attocash/commons-core';
import { AttoError } from '../domain/errors.js';
import { mnemonicSeed } from '../wallet/signing.js';
import { inspectWalletProfile, type WalletProfile } from './profiles.js';
import { OsSecretStore } from './secrets.js';
import { openReadOnlyState } from './state.js';

/** Public source binding only. The original profile and credential namespace stay authoritative. */
export interface MarketplaceRecoverySource extends WalletProfile {
  identityAddress: string;
}

/** Trusted Marketplace library boundary, never an MCP operation or key export.
 * Hold the existing lifecycle read lease while validating the credential and
 * consuming its temporary BIP39 seed. Opening read-only avoids initializing a
 * missing source or changing its public state and journals. */
export async function withMarketplaceRecoverySeed<T>(
  source: string | MarketplaceRecoverySource,
  action: (seed: Uint8Array, source: MarketplaceRecoverySource) => T | Promise<T>,
): Promise<T> {
  const profile = inspectWalletProfile(typeof source === 'string' ? source : source.directory);
  if (typeof source !== 'string' && (profile.directory !== source.directory ||
      profile.credentialAccount !== source.credentialAccount || profile.credentialService !== source.credentialService)) {
    throw new AttoError('WALLET_MISMATCH', 'The selected recovery source no longer matches its original profile.');
  }
  if (!existsSync(join(profile.directory, 'state.sqlite')) || !existsSync(join(profile.directory, 'lifecycle.sqlite'))) {
    throw new AttoError('WALLET_NOT_INITIALIZED', 'The selected recovery source is unavailable. Restore the original wallet before continuing.');
  }
  const state = openReadOnlyState(profile.directory, { holdLifecycleLease: true });
  try {
    if (state.get('wallet.reset')) throw new AttoError('WALLET_RESET_REQUIRED', 'Finish the interrupted recovery source reset before continuing.');
    const identity = state.get<{ address?: unknown }>('identity');
    if (!identity || typeof identity.address !== 'string') throw new AttoError('WALLET_NOT_INITIALIZED', 'The selected recovery source is not initialized.');
    const binding: MarketplaceRecoverySource = { ...profile, identityAddress: identity.address };
    if (typeof source !== 'string' && source.identityAddress !== binding.identityAddress) {
      throw new AttoError('WALLET_MISMATCH', 'The selected recovery source identity changed. Restore the original wallet before continuing.');
    }
    const phrase = await new OsSecretStore(profile.credentialAccount, profile.credentialService).get();
    if (!phrase) throw new AttoError('WALLET_CREDENTIAL_MISSING', 'The OS password store has no recovery phrase for the selected source. Unlock or restore that original credential.');
    const seed = await mnemonicSeed(phrase);
    try {
      const identityKey = await seed.toPrivateKey(toAttoIndex(0));
      try {
        if ((await privateKeyToSigner(identityKey)).address.value !== binding.identityAddress) throw new AttoError('WALLET_MISMATCH', 'The recovery credential does not match the selected wallet.');
      } finally { identityKey.value.fill(0); }
      // Int8Array and Uint8Array share the same zeroized backing allocation.
      const bytes = new Uint8Array(seed.value.buffer, seed.value.byteOffset, seed.value.byteLength);
      return await action(bytes, binding);
    } finally { seed.value.fill(0); }
  } finally {
    state.close();
  }
}
