import { createApplication } from '@attocash/cli/core';
import { isDeepStrictEqual } from 'node:util';
import { defaultMarketplaceHome, managedWalletEnvironment } from './wallet-home.js';
import { readWalletSelection, saveWalletSelection, type AttoWalletAccess } from './wallet-preferences.js';
import { ProfileError } from './profile-store.js';
import { requireSetupTerminal, terminalPrompt, yesNo, type Prompt } from './terminal-input.js';

interface AttoStatus {
  initialized: boolean;
  identity: { fingerprint: string } | null;
  settings: { network: string };
  addresses: { index: number; address: string }[];
  mcpAccess: string;
  pool: { indexes: number[] };
}

function statusValue(value: unknown): AttoStatus {
  const status = value as AttoStatus;
  if (!status?.initialized || !status.identity || typeof status.identity.fingerprint !== 'string'
    || !status.settings || !['LIVE','BETA','DEV','LOCAL'].includes(status.settings.network)
    || !Array.isArray(status.addresses) || !Array.isArray(status.pool?.indexes)
    || !['read-only','spend'].includes(status.mcpAccess)) throw setupRequired();
  return status;
}

export function selectedAttoWallet(env: NodeJS.ProcessEnv, value: unknown): {
  address: string; index: number; network: string;
  permissions: { marketplaceFunding: boolean; externalTransfers: boolean; receive: boolean };
} {
  const status = statusValue(value);
  const selection = env.MARKETPLACE_MCP_HOME ? readWalletSelection(env.MARKETPLACE_MCP_HOME) : undefined;
  const access = selection?.attoAccess;
  if (!access || selection?.attoDirectory !== env.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR
    || access.fingerprint !== status.identity!.fingerprint
    || access.network !== `atto:${status.settings.network.toLowerCase()}`
    || !status.addresses.some(account => account.index === access.index && account.address === access.address)) throw setupRequired();
  const writable = status.mcpAccess === 'spend' && status.pool.indexes.includes(access.index);
  const marketplaceFunding = writable && access.marketplaceFunding;
  const externalTransfers = writable && access.externalTransfers;
  return { address: access.address, index: access.index, network: access.network,
    permissions: { marketplaceFunding, externalTransfers, receive: marketplaceFunding || externalTransfers } };
}

/** Re-read the narrower Marketplace grant at every native admission and signing check. */
export function assertAttoWalletWrite(env: NodeJS.ProcessEnv, status: unknown,
  operation: 'payment.prepare' | 'transfer.send' | 'receive'): void {
  const { permissions } = selectedAttoWallet(env, status);
  const allowed = operation === 'payment.prepare' ? permissions.marketplaceFunding
    : operation === 'transfer.send' ? permissions.externalTransfers : permissions.receive;
  if (!allowed) throw new ProfileError('PERMISSION_DENIED', 'This operation requires local terminal approval for the selected Marketplace wallet.');
}

/** Terminal-owned purpose grants narrow the existing CLI authority without replacing it. */
export async function approveAttoWalletAccess(options: {
  home: string; directory: string; index: number; prompt?: Prompt;
  grants?: { marketplaceFunding: boolean; externalTransfers: boolean };
}): Promise<void> {
  requireSetupTerminal();
  const prompt = options.prompt ?? terminalPrompt;
  const beforeSelection = readWalletSelection(options.home);
  const app = createApplication({ directory: options.directory });
  try {
    const before = statusValue(await app.call('wallet_status', {}));
    const account = before.addresses.find(value => value.index === options.index);
    if (!account || !Number.isInteger(options.index) || options.index < 0 || options.index > 0x7fffffff) throw setupRequired();
    const previous = beforeSelection?.attoDirectory === options.directory
      && beforeSelection.attoAccess?.fingerprint === before.identity!.fingerprint
      && beforeSelection.attoAccess.index === options.index
      && beforeSelection.attoAccess.network === `atto:${before.settings.network.toLowerCase()}`
      ? beforeSelection.attoAccess : undefined;
    const marketplaceFunding = options.grants?.marketplaceFunding
      ?? await yesNo(prompt, 'Allow Marketplace funding from this Atto wallet', previous?.marketplaceFunding ?? false);
    const externalTransfers = options.grants?.externalTransfers
      ?? await yesNo(prompt, 'Allow external Atto transfers from this wallet', previous?.externalTransfers ?? false);
    const access: AttoWalletAccess = { address: account.address, index: account.index,
      network: `atto:${before.settings.network.toLowerCase()}`, fingerprint: before.identity!.fingerprint,
      marketplaceFunding, externalTransfers };
    process.stderr.write(`${JSON.stringify({directory: options.directory, ...access}, null, 2)}\n`
      + 'Marketplace grants only narrow this wallet’s existing CLI permissions and shared spending limits.\n'
      + 'Receiving requires an approved funding or external-transfer grant and CLI spend access.\n');
    if (await prompt('Type APPROVE to save this Marketplace wallet access: ') !== 'APPROVE') {
      throw new ProfileError('APPROVAL_DECLINED', 'Marketplace wallet access approval was declined.');
    }
    requireSetupTerminal();
    if (!isDeepStrictEqual(beforeSelection, readWalletSelection(options.home))
      || !isDeepStrictEqual(before, statusValue(await app.call('wallet_status', {})))) {
      throw new ProfileError('WALLET_CONFIGURATION_CHANGED', 'The selected wallet or its authority changed during review. Repeat approval against its current settings.');
    }
    await saveWalletSelection(options.home, { attoDirectory: options.directory, attoAccess: access }, {expected: beforeSelection});
  } finally { await app.close(); }
}

export async function runAttoWalletAccessCommand(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const command = argv[0];
  const flags = new Set<string>();
  let home: string | undefined;
  let assetSeen = false;
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--asset' && !assetSeen && argv[index + 1] === 'ATTO') { assetSeen = true; index++; continue; }
    if (arg === '--home' && !home && argv[index + 1]) { home = argv[++index]; continue; }
    if (command === 'policy' && ['--allow-marketplace-funding','--allow-external-transfers'].includes(arg ?? '') && !flags.has(arg!)) { flags.add(arg!); continue; }
    throw setupRequired();
  }
  if (!assetSeen) throw setupRequired();
  const selected = managedWalletEnvironment(home ?? env.MARKETPLACE_MCP_HOME ?? defaultMarketplaceHome(), env);
  const selection = readWalletSelection(selected.MARKETPLACE_MCP_HOME!);
  if (!selection?.attoAccess || selection.attoDirectory !== selected.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR) throw setupRequired();
  if (command === 'policy') {
    await approveAttoWalletAccess({ home: selected.MARKETPLACE_MCP_HOME!,
      directory: selection.attoDirectory!, index: selection.attoAccess.index,
      grants: { marketplaceFunding: flags.has('--allow-marketplace-funding'), externalTransfers: flags.has('--allow-external-transfers') } });
  } else if (command !== 'status') throw setupRequired();
  const { callWallet } = await import('./wallet-process.js');
  process.stdout.write(`${JSON.stringify(await callWallet(selected, {asset: 'ATTO', operation: 'identity.list', input: {}}))}\n`);
}

function setupRequired(): ProfileError {
  return new ProfileError('WALLET_SETUP_REQUIRED', 'Configure the selected Atto account and Marketplace wallet permissions in the local terminal.');
}
