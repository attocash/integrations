import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AttoApplication } from '../application/app.js';
import { AttoError } from '../domain/errors.js';
import { inspectWalletProfile } from '../storage/profiles.js';
import { withMarketplaceRecoverySeed, type MarketplaceRecoverySource } from '../storage/recovery-seed.js';
import { hiddenPrompt, requireTerminal, showRecovery, terminalPrompt } from './terminal.js';

/** Offline initialization for an explicitly selected Marketplace recovery root.
 * Recovery words remain in the existing protected terminal workflow. */
export async function initializeMarketplaceRecoveryWallet(
  directory: string,
  options: { method?: 'create' | 'import' } = {},
): Promise<MarketplaceRecoverySource> {
  requireTerminal();
  const profile = inspectWalletProfile(directory);
  // Existing source failures must never become an implicit replacement wallet.
  if (existsSync(join(profile.directory, 'state.sqlite'))) {
    return withMarketplaceRecoverySeed(profile.directory, (_seed, binding) => binding);
  }
  const method = options.method ? (options.method === 'import' ? '2' : '1')
    : await terminalPrompt('Recovery phrase: [1] Create new (default), [2] Import existing: ') || '1';
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
