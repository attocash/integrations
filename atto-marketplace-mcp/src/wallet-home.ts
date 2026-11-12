import { isAbsolute, join, resolve } from 'node:path';
import { assertWalletDirectory, ProfileError } from './profile-store.js';
import { readWalletSelection } from './wallet-preferences.js';

export { defaultMarketplaceHome } from './defaults.js';

/** One dedicated native wallet tree per Marketplace MCP home. Explicit paths opt into sharing. */
export function managedWalletEnvironment(home: string, env: NodeJS.ProcessEnv,
  handoffDirectory?: string): NodeJS.ProcessEnv {
  const root = privatePath(resolve(home));
  const saved = readWalletSelection(root);
  const nanoDirectory = env.MARKETPLACE_MCP_NANO_WALLET_DATA_DIR ?? saved?.nanoDirectory ?? join(root, 'wallets', 'nano');
  const paths = {
    MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR: env.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR ?? saved?.attoDirectory ?? join(root, 'wallets', 'atto'),
    MARKETPLACE_MCP_NANO_WALLET_DATA_DIR: nanoDirectory,
    MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR: env.MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR ?? saved?.nanoControllerDirectory ?? nanoDirectory,
    MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR: handoffDirectory ?? env.MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR ?? saved?.paymentHandoffDirectory ?? join(root, 'payment-handoffs'),
  };
  for (const value of Object.values(paths)) privatePath(value);
  for (const directory of [paths.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR, paths.MARKETPLACE_MCP_NANO_WALLET_DATA_DIR,
    paths.MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR]) assertWalletDirectory(directory, true);
  return { ...env, ...paths, MARKETPLACE_MCP_HOME: root };
}

function privatePath(value: string): string {
  if (!isAbsolute(value) || value.length > 4096 || resolve(value) !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ProfileError('WALLET_SETUP_REQUIRED', 'Marketplace MCP wallet paths must be explicit absolute local paths.');
  }
  return value;
}
