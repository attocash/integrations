import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AttoApplication } from '../application/app.js';
import { amountRaw } from '../domain/amount.js';
import { AttoError } from '../domain/errors.js';
import { defaultCliDirectory, dedicatedMcpDirectory, resolveWalletProfile } from '../storage/profiles.js';
import type { AccountPool, SpendingPolicy, WalletIdentity, WalletSettings } from '../wallet/types.js';
import { hiddenPrompt, requireTerminal, showRecovery, terminalPrompt } from './terminal.js';
import { formatHumanResult } from './output.js';
export { formatHumanResult } from './output.js';
export { configureHelp, commandErrorMessage } from './help.js';

interface ProposalOptions { id: string; directory?: string }

function display(value: unknown): void {
  process.stderr.write(formatHumanResult(value));
}

async function confirm(prompt: string): Promise<void> {
  if (await terminalPrompt(prompt) !== 'yes') throw new AttoError('CANCELLED', 'No approval was granted.');
}

async function choose(prompt: string): Promise<'1' | '2'> {
  const answer = await terminalPrompt(prompt) || '1';
  if (answer !== '1' && answer !== '2') throw new AttoError('INVALID_INPUT', 'Choose 1 or 2.');
  return answer;
}

function formatPolicy(policy: SpendingPolicy): string {
  const perPayment = policy.perRequest ? `${policy.perRequest.amount} ${policy.perRequest.unit}` : 'Unlimited';
  const rolling = policy.rolling.length
    ? policy.rolling.map(rule => `${rule.amount} ${rule.unit} / ${rule.days} day${rule.days === 1 ? '' : 's'}`).join(', ')
    : 'Unlimited';
  return `Per payment: ${perPayment}; rolling: ${rolling}`;
}

function showProposal(review: Awaited<ReturnType<AttoApplication['reviewLimitsProposal']>>): void {
  const { proposal } = review;
  process.stderr.write([
    `Wallet: ${review.identity ? JSON.stringify(review.identity.address) : 'Not initialized'}`,
    `Network: ${JSON.stringify(review.network)}`,
    `Profile: ${JSON.stringify(review.directory)}`,
    `Proposal: ${JSON.stringify(proposal.id)} (${proposal.status})`,
    `Expires: ${new Date(proposal.expiresAt).toISOString()}`,
    ...(review.mcpAccess !== 'read-only' || proposal.access !== 'read-only' ? [`MCP access: ${review.mcpAccess} → ${proposal.access}`] : []),
    `Current limits: ${formatPolicy(review.policy)}`,
    `Requested limits: ${formatPolicy(proposal.policy)}`,
    `Current pool: indexes ${review.pool.indexes.join(', ')}; consolidation ${review.pool.consolidate ? 'enabled' : 'disabled'}`,
    `Requested pool: indexes ${(proposal.pool ?? review.pool).indexes.join(', ')}; consolidation ${(proposal.pool ?? review.pool).consolidate ? 'enabled' : 'disabled'}`,
    `Current message-signing indexes: ${review.messageSigningIndexes.join(', ') || 'none'}`,
    `Requested message-signing indexes: ${(proposal.messageSigningIndexes ?? []).join(', ') || 'none'}`,
    '',
  ].join('\n'));
}

async function approve(application: AttoApplication, id: string): Promise<unknown> {
  process.stderr.write('\nReview this exact limits proposal. Spending limits are shared with CLI payments in this profile; message-signing indexes authorize exact-byte ATTO signatures for those keys.\n');
  showProposal(await application.reviewLimitsProposal(id));
  await confirm('Type yes to approve this exact proposal: ');
  return application.approveLimitsProposal(id);
}

/** Deliberately outside the core facade: only local terminal workflows can approve proposals. */
export async function approveLimitsProposal({ id, directory }: ProposalOptions): Promise<unknown> {
  requireTerminal();
  const application = new AttoApplication({ directory });
  try { return await approve(application, id); }
  finally { await application.close(); }
}

export async function rejectLimitsProposal({ id, directory }: ProposalOptions): Promise<unknown> {
  requireTerminal();
  const application = new AttoApplication({ directory });
  try {
    showProposal(await application.reviewLimitsProposal(id));
    await confirm('Type yes to reject this exact proposal: ');
    return await application.rejectLimitsProposal(id);
  } finally { await application.close(); }
}

async function initializeWallet(application: AttoApplication, directory: string): Promise<void> {
  const status = await application.call('wallet_status') as { initialized: boolean };
  if (status.initialized) {
    process.stderr.write('This profile already has a wallet. Setup will reuse its funds and spending history.\n');
    return;
  }
  const method = await choose('Wallet is not initialized. [1] Create a new wallet (default), [2] Import a recovery phrase: ');
  display({ directory, action: method === '1' ? 'Create a new wallet' : 'Import a wallet' });
  await confirm('Type yes to store this wallet in the OS password store: ');
  if (method === '1') {
    await application.createWallet();
    showRecovery(await application.backupMnemonic());
  } else {
    await application.createWallet(await hiddenPrompt('Recovery phrase (hidden): '));
  }
}

async function boundedPolicy(): Promise<SpendingPolicy> {
  const perRequest = await terminalPrompt('Maximum ATTO per payment: ');
  amountRaw(perRequest);
  const daily = await terminalPrompt('Maximum ATTO across a rolling 24 hours: ');
  amountRaw(daily);
  return { perRequest: { amount: perRequest, unit: 'ATTO' }, rolling: [{ days: 1, amount: daily, unit: 'ATTO' }] };
}

async function configurePool(current: AccountPool): Promise<AccountPool> {
  process.stderr.write(`Current payment pool: indexes ${current.indexes.join(', ')}; consolidation ${current.consolidate ? 'enabled' : 'disabled'}.\n`);
  if (await choose('Account pool: [1] Keep current pool (default), [2] Configure account pool: ') === '1') return current;
  const input = await terminalPrompt(`Account indexes, separated by commas [${current.indexes.join(',')}]: `) || current.indexes.join(',');
  const indexes = input.split(',').map(value => /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN);
  process.stderr.write('Consolidation allows automatic payments to move funds between pool accounts when no single account has enough. Explicit source indexes never consolidate. Newly approved indexes are derived but are not activated for automatic receiving.\n');
  const consolidate = await choose('Consolidation: [1] Disabled (default), [2] Enabled: ') === '2';
  return { indexes, consolidate };
}

/** Returns only public host configuration; recovery material is displayed directly on the TTY. */
export async function setupMcp({ directory }: { directory?: string }): Promise<unknown> {
  requireTerminal();
  process.stderr.write('Atto MCP setup. Recovery phrases stay in your OS password store and this terminal.\n');
  const wallet = await choose('Wallet: [1] Dedicated MCP wallet (default), [2] Existing CLI wallet: ');
  let selected = directory;
  if (!selected && wallet === '2') {
    const defaultDirectory = defaultCliDirectory();
    selected = await terminalPrompt(`CLI wallet directory [${JSON.stringify(defaultDirectory)}]: `) || defaultDirectory;
  }
  const selectedDirectory = resolve(selected ?? dedicatedMcpDirectory());
  if (wallet === '1' && selectedDirectory === resolve(defaultCliDirectory())) {
    throw new AttoError('PROFILE_CONFLICT', 'This is the default CLI wallet directory. Choose the existing CLI wallet option to share it.');
  }
  const profile = resolveWalletProfile(selectedDirectory);
  display({ directory: profile.directory, credentialService: profile.credentialService });
  if (wallet === '2') process.stderr.write('This shares funds, payment history, and spending limits with that CLI wallet.\n');
  const application = new AttoApplication({ directory: profile.directory });
  try {
    await initializeWallet(application, profile.directory);
    const usage = await application.call('limits_get') as { policy: SpendingPolicy; pool: AccountPool };
    const pool = await configurePool(usage.pool);
    process.stderr.write('Read-only can view data, watch events, and propose limits. Bounded spending also permits wallet changes and payments within approved limits.\n');
    const choice = await choose('MCP access: [1] Read-only (default), [2] Bounded spending: ');
    const access = choice === '1' ? 'read-only' : 'spend';
    const policy = access === 'read-only' ? usage.policy : await boundedPolicy();
    const { proposal } = await application.call('limits_propose', { policy, access, pool }) as { proposal: { id: string } };
    await approve(application, proposal.id);
    process.stderr.write('\nAdd this public configuration to your MCP client. The explicit data directory preserves your wallet selection.\n');
    return { mcpServers: { atto: { command: 'npx', args: ['--yes', '@attocash/mcp@latest', '--data-dir', profile.directory] } } };
  } finally { await application.close(); }
}

/** Configure the local wallet profile used by Marketplace's private MCP integration. */
export async function setupMarketplaceWallet({
  directory,
  controllerIndex,
  reuseExisting = false,
  configuration,
  typedControllerApprovals = false,
}: {
  directory: string;
  controllerIndex: number;
  reuseExisting?: boolean;
  configuration?: Pick<WalletSettings, 'network' | 'nodeUrl' | 'workerUrl'>;
  typedControllerApprovals?: boolean;
}): Promise<{ directory: string; address: string; index: number }> {
  requireTerminal();
  if (!directory || !isAbsolute(directory)) {
    throw new AttoError('INVALID_INPUT', 'Marketplace wallet setup requires an explicit absolute wallet directory.');
  }
  if (!Number.isSafeInteger(controllerIndex) || controllerIndex < 0 || controllerIndex > 2_147_483_647) {
    throw new AttoError('INVALID_INPUT', 'The Marketplace controller index must be a nonnegative integer.');
  }
  const selectedDirectory = resolve(directory);
  if (!reuseExisting && selectedDirectory === resolve(defaultCliDirectory())) {
    throw new AttoError('PROFILE_CONFLICT', 'Marketplace wallet setup cannot use the default CLI wallet directory. Choose a dedicated absolute directory.');
  }

  if (reuseExisting && !existsSync(join(selectedDirectory, 'state.sqlite'))) {
    throw new AttoError('WALLET_NOT_INITIALIZED', 'The selected CLI wallet is not initialized. Choose an existing wallet or use dedicated wallet setup.');
  }
  const profile = resolveWalletProfile(selectedDirectory);
  display({ directory: profile.directory, action: 'Configure local Marketplace wallet' });
  const application = new AttoApplication({ directory: profile.directory });
  try {
    const status = await application.call('wallet_status') as { initialized: boolean; identity: WalletIdentity | null; settings: WalletSettings };
    if (reuseExisting && !status.initialized) {
      throw new AttoError('WALLET_NOT_INITIALIZED', 'The selected CLI wallet is not initialized. Choose an existing wallet or use dedicated wallet setup.');
    }
    if (reuseExisting && configuration
      && (configuration.network !== status.settings.network || configuration.nodeUrl !== status.settings.nodeUrl
        || configuration.workerUrl !== status.settings.workerUrl)) {
      throw new AttoError('PROFILE_CONFLICT', 'The selected CLI wallet settings do not match the requested Marketplace network, node, and worker. Reuse preserves existing wallet settings.');
    }
    if (reuseExisting) {
      process.stderr.write('This reuses the existing CLI wallet in place and shares its funds, spending grants, payment journals, and account pool. Keys and wallet settings stay in this profile.\n');
      display({ identity: status.identity, settings: status.settings, credentialService: profile.credentialService });
    } else {
      await initializeWallet(application, profile.directory);
      if (configuration) await application.call('wallet_configure', configuration);
    }
    const controller = await application.call('address_derive', { index: controllerIndex }) as { index: number; address: string };
    process.stderr.write([
      typedControllerApprovals
        ? 'This setup proposes bounded native spending. Marketplace controller actions require separate terminal approval.'
        : 'This setup proposes bounded MCP spending and message signing for one controller account.',
      ...(typedControllerApprovals ? [] : ['ATTO message_sign requires spend access; read-only access cannot use it.']),
      'Marketplace controller account: index ' + String(controller.index) + ' (' + JSON.stringify(controller.address) + ').',
      '',
    ].join('\n'));

    // Reading limits_get reconciles payments. Reuse onboarding only inspects
    // saved authority, leaving existing payment journals untouched.
    const usage = reuseExisting ? {
      policy: application.ledger.policy(), pool: application.ledger.pool(),
      access: application.ledger.mcpAccess(), messageSigningIndexes: application.ledger.messageSigningIndexes(),
    } : await application.call('limits_get') as { policy: SpendingPolicy; pool: AccountPool; access: 'read-only' | 'spend'; messageSigningIndexes: number[] };
    if (reuseExisting) {
      process.stderr.write([
        `Current MCP access: ${usage.access}`,
        `Current limits: ${formatPolicy(usage.policy)}`,
        `Current message-signing indexes: ${usage.messageSigningIndexes.join(', ') || 'none'}`,
        '',
      ].join('\n'));
    }
    const pool = await configurePool(usage.pool);
    const hasBoundedPolicy = usage.policy.perRequest !== null || usage.policy.rolling.length > 0;
    const keepPolicy = reuseExisting && hasBoundedPolicy
      && await choose('Spending policy: [1] Keep current bounded limits (default), [2] Set new bounded limits: ') === '1';
    if (reuseExisting && !hasBoundedPolicy) process.stderr.write('The current policy is unlimited. Marketplace setup requires explicit bounded spending limits and spend access approval.\n');
    const policy = keepPolicy ? usage.policy : await boundedPolicy();
    const messageSigningIndexes = typedControllerApprovals ? usage.messageSigningIndexes : reuseExisting
      ? [...new Set([...usage.messageSigningIndexes, controllerIndex])].sort((a, b) => a - b) : [controllerIndex];
    const proposal = reuseExisting ? await application.store.withWalletLock(async () => {
      // Fail rather than replacing authority changed by another CLI/MCP session
      // while the user was answering terminal prompts.
      if (!isDeepStrictEqual(usage, {
        policy: application.ledger.policy(), pool: application.ledger.pool(),
        access: application.ledger.mcpAccess(), messageSigningIndexes: application.ledger.messageSigningIndexes(),
      }) || !isDeepStrictEqual(status.settings, application.store.get('settings'))
        || !isDeepStrictEqual(status.identity, application.store.get('identity'))) {
        throw new AttoError('PROPOSAL_STALE', 'The shared wallet settings or authority changed during setup. Review the current wallet and run setup again.');
      }
      return application.ledger.proposePolicy(policy, 'spend', {
        directory: profile.directory, walletFingerprint: status.identity!.fingerprint, network: status.settings.network,
      }, pool, messageSigningIndexes);
    }) : (await application.call('limits_propose', {
      policy, access: 'spend', pool, messageSigningIndexes,
    }) as { proposal: { id: string } }).proposal;
    await approve(application, proposal.id);
    return { directory: profile.directory, address: controller.address, index: controller.index };
  } finally { await application.close(); }
}
