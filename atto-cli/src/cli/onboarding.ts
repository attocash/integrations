import { resolve } from 'node:path';
import { AttoApplication } from '../application/app.js';
import { amountRaw } from '../domain/amount.js';
import { AttoError } from '../domain/errors.js';
import { defaultCliDirectory, dedicatedMcpDirectory, resolveWalletProfile } from '../storage/profiles.js';
import type { AccountPool, SpendingPolicy } from '../wallet/types.js';
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
    '',
  ].join('\n'));
}

async function approve(application: AttoApplication, id: string): Promise<unknown> {
  process.stderr.write('\nReview this exact limits proposal. These spending limits are shared with CLI payments in this profile.\n');
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
