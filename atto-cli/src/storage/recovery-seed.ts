import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { inspectWalletProfile, type WalletProfile } from './profiles.js';
import { OsSecretStore } from './secrets.js';
import { mnemonicSeed } from '../wallet/signing.js';
import { privateKeyToSigner, toAttoIndex } from '@attocash/commons-core';
import { AttoError } from '../domain/errors.js';
import { AttoApplication } from '../application/app.js';
import { requireTerminal, terminalPrompt, hiddenPrompt, showRecovery } from '../cli/terminal.js';

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
  const lifecycle = new DatabaseSync(join(profile.directory, 'lifecycle.sqlite'), { readOnly: true });
  let state: DatabaseSync | undefined;
  try {
    lifecycle.exec('PRAGMA busy_timeout = 0; BEGIN; SELECT COUNT(*) FROM lease;');
    state = new DatabaseSync(join(profile.directory, 'state.sqlite'), { readOnly: true });
    const read = (key: string): unknown => {
      const row = state!.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? JSON.parse(row.value as string) : undefined;
    };
    if (read('wallet.reset')) throw new AttoError('WALLET_RESET_REQUIRED', 'Finish the interrupted recovery source reset before continuing.');
    const identity = read('identity') as { address?: unknown } | undefined;
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
    state?.close();
    lifecycle.close();
  }
}

/** Offline initialization for an explicitly selected Marketplace recovery root.
 * Recovery words remain in the existing protected terminal workflow. */
export async function initializeMarketplaceRecoveryWallet(directory: string): Promise<MarketplaceRecoverySource> {
  requireTerminal();
  const profile = inspectWalletProfile(directory);
  // Existing source failures must never become an implicit replacement wallet.
  if (existsSync(join(profile.directory, 'state.sqlite'))) return withMarketplaceRecoverySeed(profile.directory, (_seed, binding) => binding);
  const method = await terminalPrompt('Recovery phrase: [1] Create new (default), [2] Import existing: ') || '1';
  if (method !== '1' && method !== '2') throw new AttoError('INVALID_INPUT', 'Choose 1 or 2.');
  if (await terminalPrompt('Type yes to store this shared recovery phrase in the OS password store: ') !== 'yes') {
    throw new AttoError('CANCELLED', 'No approval was granted.');
  }
  const imported = method === '2' ? await hiddenPrompt('Recovery phrase (hidden): ') : undefined;
  const application = new AttoApplication({ directory });
  try {
    await application.createWallet(imported);
    if (method === '1') showRecovery(await application.backupMnemonic());
  } finally { await application.close(); }
  return withMarketplaceRecoverySeed(directory, (_seed, binding) => binding);
}
