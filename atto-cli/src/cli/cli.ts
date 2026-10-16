import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { z } from 'zod';
import { AttoApplication } from '../application/app.js';
import { operations, parseOperation } from '../application/operations.js';
import type { SendRetry } from '../network/retry.js';
import { AttoError, errorResult } from '../domain/errors.js';
import { hiddenPrompt, requireTerminal, showRecovery, terminalPrompt } from './terminal.js';
import { notifyUpdate } from './updates.js';
import { approveLimitsProposal, rejectLimitsProposal } from './onboarding.js';
import type { DestinationBinding } from '../spending/destination.js';
import { formatHumanResult } from './output.js';
import { configureHelp, commandErrorMessage } from './help.js';
import type { AccountPool, SpendingPolicy } from '../wallet/types.js';
import type { ReceiveProgress } from '../wallet/auto-receive.js';
import { runDoctor } from '../doctor/doctor.js';
import { readMarketProofApprovalRequest, writeMarketProofApprovalResponse } from '../market/approval-files.js';
import { normalizeDisputeText, normalizeEvidenceUrls } from '../market/proof-approval.js';

function number(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InvalidArgumentError('Use an unsigned integer.');
  return Number(value);
}

function json(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new AttoError('INVALID_INPUT', 'Input must be a JSON object.');
  }
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

export function formatMarketApprovalPreview(preview: ReturnType<AttoApplication['inspectMarketProofApproval']>['preview']): string {
  const action = preview.action;
  const command = action.command && typeof action.command === 'object' ? action.command as Record<string, unknown> : {};
  const fields = [
    `Market: ${preview.marketOrigin}`,
    `Transport: ${preview.transport}`,
    `Proof origin: ${preview.proofOrigin ?? '(none; Agent API audience)'}`,
    `Audience: ${preview.audience}`,
    `Purpose: ${preview.purpose}`,
    `Controller: ATTO index ${preview.controller.index}, ${preview.controller.address}`,
    ...(preview.accountId ? [`Account: ${preview.accountId}`, `Identity: ${preview.identityId}`] : []),
    `Challenge: ${preview.challengeId}`,
    `Expires: ${preview.expiresAt}`,
  ];
  if (action.kind === 'withdrawal') {
    fields.push(`Action: withdraw ${String(command.atomicAmount)} ${String(command.asset)} on ${String(action.network)}`,
      `Destination: ${String(action.destinationAddress)} (${String(command.destinationId)})`);
  } else if (action.kind === 'payout-address') {
    fields.push(`Action: ${String(command.action)} ${String(command.asset)} payout address on ${String(action.network)}`,
      `Destination: ${String(action.canonicalTargetAddress)}`);
  } else if (action.kind === 'credential') {
    const credential = command.credential && typeof command.credential === 'object' ? command.credential as Record<string, unknown> : {};
    fields.push(`Action: ${String(command.operation)} scoped credential`,
      ...(typeof credential.name === 'string' ? [`Name: ${credential.name.trim()}`] : []),
      ...(Array.isArray(credential.scopes) ? [`Scopes: ${credential.scopes.join(', ')}`] : []),
      ...(typeof command.targetApiKeyId === 'string' ? [`Credential ID: ${command.targetApiKeyId}`] : []));
    for (const [name, label] of [['publishAttoLimit','ATTO publish ceiling'],['publishXnoLimit','XNO publish ceiling'],['applyAttoLimit','ATTO application ceiling'],['applyXnoLimit','XNO application ceiling']] as const) {
      if (typeof credential[name] === 'string') fields.push(`${label}: ${String(credential[name])} atomic units`);
    }
    if (Array.isArray(credential.scopes) && credential.scopes.includes('products:purchase')) {
      for (const [name, label] of [['purchaseAttoLimit','ATTO product purchase ceiling'],['purchaseXnoLimit','XNO product purchase ceiling']] as const) {
        fields.push(`${label}: ${typeof credential[name] === 'string' ? `${String(credential[name])} atomic units` : 'denied'}`);
      }
    }
  } else if (action.kind === 'identity-link') {
    fields.push(`Action: link controller (${String(action.operation)})`,
      `Link ID: ${String(action.linkId)}`, `Authorizing identity: ${String(action.authorizingIdentityId)}`,
      `Authorizing address: ${String(action.authorizingAddress)}`, `New controller address: ${String(action.newIdentityAddress)}`);
  } else if (action.kind === 'identity-unlink') {
    fields.push('Action: unlink controller', `Controller to remove: ${String(action.targetIdentityId)}`,
      `Authorizing identity: ${String(action.authorizingIdentityId)}`);
  } else if (action.kind === 'adminModeration') {
    fields.push(`Action: ${String(action.action)} ${String(action.targetKind)}`, `Target: ${String(action.targetId)}`,
      `Target version: ${String(action.expectedTargetVersion)}`, `Moderation version: ${String(action.expectedModerationVersion)}`,
      `Reason: ${String(action.reason).replace(/^ +| +$/g, '')}`);
  } else if (action.kind === 'adminJobClose') {
    fields.push(`Action: ${String(action.action)} job`, `Job: ${String(action.jobId)}`,
      `Expected version: ${String(action.expectedVersion)}`, `Reason: ${String(action.reason).replace(/^ +| +$/g, '')}`);
  } else if (action.kind === 'adminDisputeOpen') {
    fields.push('Action: administrator opens dispute', `Job: ${String(action.jobId)}`,
      `Engagement version: ${String(action.expectedEngagementVersion)}`, `Represented agent: ${String(action.representedAgentId)}`,
      `Reason: ${String(action.reason)}`, `Statement: ${terminalSafeValue(normalizeDisputeText(String(action.statement)))}`,
      `Evidence URLs: ${(normalizeEvidenceUrls(action.evidenceUrls) ?? []).map(terminalSafeValue).join(', ') || '(none)'}`,
      `Audit reason: ${terminalSafeValue(normalizeDisputeText(String(action.auditReason)))}`);
  } else if (action.kind === 'adminDisputeResolution') {
    fields.push('Action: administrator resolves dispute', `Dispute: ${String(action.disputeId)}`,
      `Dispute version: ${String(action.expectedDisputeVersion)}`, `Outcome: ${String(action.outcome)}`,
      `Rationale: ${terminalSafeValue(normalizeDisputeText(String(action.rationale)))}`);
  } else if (action.kind === 'login') {
    fields.push(`Action: create a controller session for ${String(action.address)}`);
  }
  return `Review this server-authored Market wallet proof before signing:\n${fields.map(field => `  ${field}`).join('\n')}`;
}

function terminalSafeValue(value: string): string {
  const escaped = [...value].map(character => {
    const point = character.codePointAt(0)!;
    if (point <= 0x1f || (point >= 0x7f && point <= 0x9f)
      || point === 0x2028 || point === 0x2029 || /\p{Cf}/u.test(character)) {
      return `\\u{${point.toString(16).toUpperCase()}}`;
    }
    return character;
  }).join('');
  return JSON.stringify(escaped);
}

function addressOptions(command: Command): Command {
  return command.option('--index <index>', 'Select one saved wallet account', number)
    .option('--addresses <addresses>', 'Comma-separated addresses, including accounts outside this wallet', value => value.split(',').map(value => value.trim()));
}

function listOptions(command: Command): Command {
  return addressOptions(command)
    .option('--limit <count>', 'Maximum returned records (1-1000; default: 100)', number)
    .option('--timeout-ms <milliseconds>', 'Scan window (100-30000 ms; default: 3000)', number);
}

function streamOptions(command: Command): Command {
  return addressOptions(command)
    .option('--hash <hash>', 'Select one transaction or entry by hash; cannot combine with an account selector')
    .option('--from-height <height>', 'Inclusive starting height for account transaction/entry streams (default: 1)')
    .option('--to-height <height>', 'Inclusive ending height for account transaction/entry streams')
    .option('--min-amount-raw <raw>', 'Minimum receivable amount in RAW (default: 0; receivable events only)');
}

export async function runCli(argv = process.argv): Promise<void> {
  const program = new Command();
  let activeCommand = program;
  const currentVersion: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  let application: AttoApplication | undefined;
  let sendRequestId: string | undefined;
  const app = (onReceiveProgress?: (event: ReceiveProgress) => void, sendRetry?: SendRetry, onDestination?: (binding: DestinationBinding) => void) => application ??= new AttoApplication({ directory: program.opts().dataDir as string | undefined, onReceiveProgress, sendRetry, onDestination, workExecution: onReceiveProgress ? 'in-process' : 'detached' });
  const jsonOutput = (value: unknown) => { process.stdout.write(`${JSON.stringify(value, (_, value) => typeof value === 'bigint' ? value.toString() : value)}\n`); };
  const output = (result: unknown, operation?: string) => {
    if (program.opts().json) jsonOutput({ result });
    else process.stdout.write(formatHumanResult(result, operation));
  };
  const call = async (name: string, input: Record<string, unknown> = {}) => {
    if (name === 'doctor') { parseOperation(name, input); return diagnose(input); }
    const result = await app().call(name, compact(input));
    app().resumeWork();
    output(result, name);
  };
  const waitForSignal = async (work: (signal: AbortSignal) => Promise<void>) => {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await work(controller.signal);
    } finally {
      controller.abort();
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  };
  const diagnose = (options: { globalDirectory?: boolean } = {}) => waitForSignal(async signal => {
    const report = await runDoctor({ directory: program.opts().dataDir, signal, globalDirectory: options.globalDirectory });
    output(report, 'doctor');
    if (report.status === 'fail') process.exitCode = 1;
  });

  program.name('atto').description('Atto wallet: manage accounts, send funds, and receive payments.')
    .version(currentVersion)
    .option('--json', 'Print machine-readable JSON instead of plain text')
    .option('--no-update-notifier', 'Skip update checks and notifications')
    .option('--data-dir <directory>', 'Public wallet state directory; secrets remain in the OS password store')
    .configureOutput({ writeErr: () => {} })
    .hook('preAction', (_command, command) => {
      activeCommand = command;
      if (!['doctor', 'send'].includes(command.name()) && !(command.name() === 'call' && ['doctor', 'send'].includes(command.args[0] ?? '')) && !program.opts().json && program.opts().updateNotifier !== false) notifyUpdate(currentVersion);
    });

  program.command('doctor').description('Check runtime, profile, keyring, node, worker, and readiness; diagnose without repairs (up to 60s)')
    .option('--global-directory', 'Also check the public LIVE address directory without updating its cache')
    .action(options => diagnose(options));

  const wallet = program.command('wallet').description('Wallet setup, settings, and automatic receiving');
  wallet.command('status').description('Read public wallet status').action(() => call('wallet_status'));
  wallet.command('configure').description('Update public settings')
    .option('--network <name>', 'LIVE, BETA, DEV, or LOCAL')
    .option('--node-url <url>', 'Node HTTP(S) URL')
    .option('--worker-url <url>', 'Work server HTTP(S) URL')
    .option('--representative <address>', 'Default representative for opening accounts; use representative change for existing accounts')
    .option('--auto-receive', 'Enable automatic receiving in receiving sessions')
    .option('--no-auto-receive', 'Disable automatic receiving')
    .option('--min-receive-raw <amount>', 'Minimum automatically received amount in RAW')
    .action(options => call('wallet_configure', options));
  wallet.command('create').description('Create and store a new mnemonic; display recovery words in this terminal')
    .action(async () => {
      requireTerminal();
      const result = await app().createWallet();
      showRecovery(await app().backupMnemonic());
      output(result, 'wallet_create');
    });
  wallet.command('import').description('Import a mnemonic through a hidden terminal prompt')
    .action(async () => {
      requireTerminal();
      const status = await app().call('wallet_status') as { initialized: boolean; resetPending: boolean };
      if (status.resetPending) {
        throw new AttoError('WALLET_RESET_REQUIRED', 'Wallet reset is unfinished. Run wallet reset for this profile before importing a wallet.');
      }
      if (status.initialized) {
        throw new AttoError('WALLET_EXISTS', 'This wallet is already initialized. Use wallet reset for this profile to clear it, or --data-dir to choose another profile.');
      }
      const mnemonic = await hiddenPrompt('Recovery phrase (hidden): ');
      output(await app().createWallet(mnemonic), 'wallet_import');
    });
  wallet.command('reset').description('Delete this local wallet and its stored recovery phrase after terminal confirmation')
    .action(async () => {
      requireTerminal();
      const review = await app().reviewWalletReset();
      process.stderr.write([
        `Profile: ${JSON.stringify(review.directory)}`,
        `Wallet: ${review.identity ? JSON.stringify(review.identity.address) : 'Not initialized'}`,
        `Network: ${JSON.stringify(review.network)}`,
        '',
        'This removes the recovery phrase from the OS password store and clears this profile\'s',
        'addresses, personal labels, payment journal, spending limits, and access permissions.',
        'Back up your recovery phrase and public wallet profile before continuing.',
        'You need an offline backup of the recovery phrase to recover any funds.',
        'Stop other sessions using this wallet before resetting.',
        '',
      ].join('\n'));
      if (await terminalPrompt('Type reset to delete this local wallet: ') !== 'reset') {
        throw new AttoError('CANCELLED', 'Wallet reset cancelled.');
      }
      const result = await app().resetWallet(review.identity?.fingerprint ?? null);
      if (program.opts().json) output(result);
      else process.stderr.write('Local wallet reset. You can now create or import a wallet.\n');
    });
  wallet.command('backup').description('Display recovery words in this terminal only')
    .action(async () => {
      requireTerminal();
      showRecovery(await app().backupMnemonic());
      if (program.opts().json) output({ displayed: true });
    });
  const receiveCommand = wallet.command('receive').description('Keep automatic receiving running until Ctrl+C')
    .option('--background', 'Keep receiving after this terminal exits; restart manually after reboot')
    .action(async () => {
      if (activeCommand.opts().background) {
        const status = await app().startBackgroundReceiver();
        output({ backgroundReceive: status }, 'wallet_receive');
        return;
      }
      const receiving = app(event => output(event, 'receive_progress'));
      const status = await receiving.call('wallet_status') as { initialized: boolean; settings: { autoReceive: boolean }; addresses: { active: boolean }[] };
      if (!status.initialized) throw new AttoError('WALLET_NOT_INITIALIZED', 'Create or import a wallet before receiving: atto wallet create or atto wallet import.');
      if (!status.settings.autoReceive) throw new AttoError('AUTO_RECEIVE_DISABLED', 'Automatic receiving is disabled. Enable it with atto wallet configure --auto-receive.');
      if (!status.addresses.some(address => address.active)) throw new AttoError('NO_ACTIVE_ACCOUNTS', 'Add an active address with atto address add, or activate a saved account with atto address activate <index>.');
      output(status, 'wallet_receive');
      await waitForSignal(async signal => {
        await receiving.start();
        if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      });
    });
  receiveCommand.command('status').description('Read detached receiver status').action(() => call('wallet_status'));
  receiveCommand.command('stop').description('Request detached receiver shutdown').action(async () => output({ backgroundReceive: await app().stopBackgroundReceiver() }, 'wallet_receive'));

  const address = program.command('address').description('Manage mnemonic-derived public addresses');
  address.command('list').description('List all saved addresses and their activation state').action(() => call('address_list'));
  address.command('add').description('Add and activate the next account address; receiving funds opens it on the network').action(() => call('address_add'));
  address.command('derive').description('Save a specific address without activating it; an existing address keeps its state').argument('[index]', 'Key index (defaults to zero)', number).action(index => call('address_derive', { index }));
  address.command('activate').description('Include an account in default balances and receiving; derive it if needed').argument('<index>', 'Key index', number).action(index => call('address_activate', { index }));
  address.command('deactivate').description('Exclude an account from default balances and receiving; funds remain visible with balances --all').argument('<index>', 'Key index', number).action(index => call('address_deactivate', { index }));
  const labels = program.command('labels').description('Personal address names and informational global labels');
  const labelTarget = (target: string) => /^\d+$/.test(target) ? { index: number(target) } : { address: target };
  labels.command('set <address-or-index> <name>').description('Set a unique personal name in this profile and network')
    .action((target, label) => call('labels_set', { ...labelTarget(target), label }));
  labels.command('remove <address-or-index>').description('Remove a personal name; existing request IDs keep their destination')
    .action(target => call('labels_remove', labelTarget(target)));
  labels.command('show <address-or-index>').description('Show personal and global labels with their sources')
    .option('--refresh', 'Refresh global data, bypassing freshness and retry backoff')
    .action((target, options) => call('labels_get', { ...labelTarget(target), ...options }));
  labels.command('list').description('List personal labels in this profile and network')
    .option('--all', 'Include informational LIVE global address and voter names')
    .option('--search <text>', 'Match addresses, names, and entity names case-insensitively')
    .option('--refresh', 'Refresh global data, bypassing freshness and retry backoff')
    .action(options => call('labels_list', options));
  program.command('account [address]').description('Read an account by address or key index')
    .option('--index <index>', 'Saved wallet account index (default: 0)', number).action((address, options) => call('account_get', { address, ...options }));
  addressOptions(program.command('balances').description('Read balances and total for active wallet accounts by default'))
    .option('--all', 'Include every saved address, including inactive accounts').action(options => call('balances_get', options));
  program.command('transaction <hash>').description('Read a network transaction').action(hash => call('transaction_get', { hash }));
  program.command('entry <hash>').description('Read an account entry').action(hash => call('entry_get', { hash }));
  listOptions(program.command('history [event]').description('Read wallet account entries by default; event can be entry or transaction'))
    .option('--cursor <cursor>', 'Continue a previous history page with the same filters')
    .option('--from-height <height>', 'Inclusive starting height')
    .option('--to-height <height>', 'Inclusive ending height')
    .action((event, options) => call('history_list', { event, ...options }));
  listOptions(program.command('receivables').description('Scan pending payments for active wallet accounts by default; does not receive them'))
    .option('--min-amount-raw <raw>', 'Minimum amount in RAW (default: 0)').action(options => call('receivables_list', options));
  program.command('send [destination] [amount]').description('Send funds; retry temporary network failures until success, HTTP 4xx, or Ctrl+C')
    .option('--request-id <id>', 'Payment ID (generated if omitted); reuse to check an existing payment')
    .option('--index <index>', 'Source account index (defaults to 0 unless --pool is used)', number)
    .option('--pool', 'Automatically select a source from the approved account pool; cannot combine with --index')
    .option('--destination <address>', 'Destination instead of a positional argument')
    .option('--to-index <index>', 'Send to an existing saved account instead of a destination address; use --amount or --usd', number)
    .option('--to-label <name>', 'Send to an exact personal name in this profile and network; use --amount or --usd')
    .option('--amount <amount>', 'Exact amount instead of a positional argument')
    .option('--usd <amount>', 'USD amount converted using the indicative market price')
    .option('--unit <unit>', 'ATTO (default), RAW, or USD')
    .option('--metadata <json>', 'Local payment metadata as a JSON object; never published on the network')
    .option('--reason <text>', 'Local payment reason; shorthand for metadata.reason')
    .action((destination, amount, options) => {
      if (options.pool && options.index !== undefined) {
        throw new AttoError('INVALID_INPUT', 'Choose either --pool or --index.');
      }
      if ([destination, options.destination, options.toIndex, options.toLabel].filter(value => value !== undefined).length !== 1 || [amount, options.amount, options.usd].filter(value => value !== undefined).length !== 1 || (options.usd && options.unit)) {
        throw new AttoError('INVALID_INPUT', 'Specify one destination and one amount: positional, --amount with --unit, or --usd.');
      }
      let metadata = options.metadata === undefined ? undefined : json(options.metadata);
      if (options.reason !== undefined) {
        if (Object.hasOwn(metadata ?? {}, 'reason')) throw new AttoError('INVALID_INPUT', 'Specify the payment reason once: --reason or metadata.reason.');
        metadata = { ...metadata, reason: options.reason };
      }
      const input = compact({ destination: destination ?? options.destination, destinationIndex: options.toIndex, destinationLabel: options.toLabel, amount: options.usd ?? options.amount ?? amount, unit: options.usd !== undefined ? 'USD' : options.unit, index: options.pool ? undefined : options.index ?? 0, requestId: options.requestId ?? randomUUID(), metadata });
      parseOperation('send', input);
      sendRequestId = input.requestId as string;
      const progress = (value: Record<string, unknown>, message?: string) => {
        process.stderr.write(program.opts().json ? `${JSON.stringify({ progress: value })}\n`
          : message ?? formatHumanResult(value));
      };
      progress({ requestId: sendRequestId });
      return waitForSignal(async signal => {
        const result = await app(undefined, {
          signal,
          onRetry: (error, delayMs) => progress({ requestId: sendRequestId, error: errorResult(error), retryInMs: delayMs },
            `${error.message} Retrying in ${delayMs / 1000}s. Press Ctrl+C to stop.\n`),
        }, binding => progress({ requestId: sendRequestId, destination: binding.address, network: binding.network, ...(binding.label ? { personalName: binding.label } : {}) })).call('send', input);
        app().resumeWork();
        output(result, 'send');
      });
    });
  program.command('metrics').description('Read public Atto market metrics').action(() => call('metrics_get'));
  const market = program.command('market').description('Fund and inspect the configured Market account');
  market.command('connect').description('Connect this wallet to Market in a local terminal')
    .requiredOption('--api-url <url>', 'Market /v1/agent/topups URL')
    .requiredOption('--audience <audience>', 'Exact Market controller-proof audience')
    .option('--browser-origin <origin>', 'Allow this exact browser origin for typed proof approvals (repeatable)',
      (origin: string, previous: string[]) => [...previous, origin], [])
    .option('--controller-index <index>', 'Saved wallet controller account index (default: 0)', number, 0)
    .action(async options => {
      requireTerminal();
      const result = await app().connectMarket({ apiUrl: options.apiUrl, audience: options.audience,
        controllerIndex: options.controllerIndex, ...(options.browserOrigin?.length ? { browserOrigins: options.browserOrigin } : {}) });
      output(result, 'market_connect');
    });
  market.command('topup <amount>').description('Fund the configured Market ATTO account under wallet spending limits')
    .option('--unit <unit>', 'ATTO (default) or RAW')
    .option('--request-id <id>', 'Payment ID (generated if omitted); reuse it after uncertainty')
    .option('--index <index>', 'Source account index (defaults to the approved pool)', number)
    .action(async (amount, options) => {
      const requestId = options.requestId ?? randomUUID();
      const input = compact({ amount, unit: options.unit, requestId, index: options.index });
      parseOperation('market_topup', input);
      sendRequestId = requestId;
      process.stderr.write(program.opts().json ? `${JSON.stringify({ progress: { requestId } })}\n`
        : `Market top-up request ID: ${requestId}\n`);
      await call('market_topup', input);
    });
  market.command('status <request-id>').description('Read and reconcile a Market top-up by its original request ID')
    .action(requestId => call('market_topup_status', { requestId }));
  market.command('approve <request-file>').description('Review and sign one exact typed Market controller-proof request')
    .action(async requestFile => {
      requireTerminal();
      const request = readMarketProofApprovalRequest(requestFile);
      const { preview } = app().inspectMarketProofApproval(request);
      process.stderr.write(`${formatMarketApprovalPreview(preview)}\n`);
      if (await terminalPrompt('Type approve to sign this exact Market challenge: ') !== 'approve') {
        throw new AttoError('CANCELLED', 'No Market wallet approval was signed.');
      }
      const response = await app().approveMarketProof(request);
      const responseFile = writeMarketProofApprovalResponse(requestFile, response);
      output({ approved: true, responseFile, handoffId: preview.handoffId,
        challengeId: preview.challengeId, expiresAt: preview.expiresAt }, 'market_approve');
    });
  program.command('quote').description('Preview a USD-to-Atto conversion using the indicative market price; does not send funds')
    .requiredOption('--usd <amount>', 'Exact USD amount')
    .action(options => call('price_quote', { amount: options.usd }));
  const terms = program.command('terms').description('Terms for USD-priced payments');
  terms.command('show').description('Read current terms and required acceptance version').action(() => call('terms_get'));
  terms.command('accept').description('Record explicit acceptance after reading the current terms')
    .requiredOption('--version <version>', 'Exact version returned by terms show')
    .requiredOption('--accepted', 'Confirm that you read and accept those terms')
    .action(options => call('terms_accept', { version: options.version, accepted: options.accepted }));
  program.command('receive <hash>').description('Receive one pending payment')
    .option('--index <index>', 'Receiving wallet account index (default: 0)', number)
    .option('--representative <address>', 'Representative when opening an account')
    .action((hash, options) => call('receive', { hash, ...options }));
  program.command('receive-all').description('Receive a bounded batch for account 0 by default; use wallet receive for continuous receiving')
    .option('--index <index>', 'Receiving wallet account index (default: 0)', number)
    .option('--limit <count>', 'Maximum payments to receive (1-1000; default: 100)', number)
    .option('--timeout-ms <milliseconds>', 'Pending-payment scan window (100-30000 ms; default: 2000)', number)
    .option('--representative <address>', 'Representative when opening an account')
    .action(options => call('receive_all', options));
  const representative = program.command('representative').description('Account representatives and voting weight');
  representative.command('weight <address>').description('Read any representative address voting weight').action(address => call('representative_weight', { address }));
  representative.command('change <address>').description('Publish a representative change for an existing account')
    .option('--index <index>', 'Wallet account index (default: 0)', number)
    .action((representative, options) => call('representative_change', { representative, ...options }));
  const message = program.command('message').description('Sign or verify exact ATTO message bytes');
  const messageSource = (options: { text?: string; hex?: string }) => {
    if ((options.text !== undefined) === (options.hex !== undefined)) {
      throw new AttoError('INVALID_INPUT', 'Supply exactly one of --text or --hex.');
    }
    return options.text !== undefined ? { message: options.text } : { messageHex: options.hex };
  };
  message.command('sign').description('Sign a UTF-8 message or exact bytes using a locally approved account index')
    .requiredOption('--index <index>', 'Saved wallet account index', number)
    .option('--text <message>', 'Exact UTF-8 message; whitespace is preserved')
    .option('--hex <bytes>', 'Exact message bytes as even-length hexadecimal; empty bytes are allowed')
    .action(options => call('message_sign', { index: options.index, ...messageSource(options) }));
  message.command('verify').description('Verify exact UTF-8 message or byte hex without wallet credentials')
    .option('--address <address>', 'ATTO address corresponding to the signing public key')
    .option('--public-key <hex>', '64-character public key in hexadecimal')
    .requiredOption('--signature <hex>', '128-character signature in hexadecimal')
    .option('--text <message>', 'Exact UTF-8 message; whitespace is preserved')
    .option('--hex <bytes>', 'Exact message bytes as even-length hexadecimal; empty bytes are allowed')
    .action(options => {
      if ((options.address !== undefined) === (options.publicKey !== undefined)) {
        throw new AttoError('INVALID_INPUT', 'Supply exactly one of --address or --public-key.');
      }
      return call('message_verify', { ...(options.address !== undefined ? { address: options.address } : { publicKey: options.publicKey }),
        signature: options.signature, ...messageSource(options) });
    });
  const limits = program.command('limits').description('Shared spending budgets and usage');
  limits.command('status').description('Read active limits, spending usage, and pending proposals').action(() => call('limits_get'));
  const proposeAndApprove = async (update: (current: { mcpAccess: string; policy: SpendingPolicy; pool: AccountPool; messageSigningIndexes: number[] }) => { policy?: Record<string, unknown>; access?: string; pool?: AccountPool; messageSigningIndexes?: number[] }) => {
    requireTerminal();
    const current = await app().call('limits_get') as { mcpAccess: string; policy: SpendingPolicy; pool: AccountPool; messageSigningIndexes: number[] };
    const changes = update(current);
    const { proposal } = await app().call('limits_propose', compact({ policy: changes.policy ?? current.policy, access: changes.access ?? current.mcpAccess,
      pool: changes.pool, messageSigningIndexes: changes.messageSigningIndexes })) as { proposal: { id: string } };
    output(await approveLimitsProposal({ id: proposal.id, directory: app().store.directory }));
  };
  limits.command('set').description('Review and confirm limit changes; omitted rules are preserved')
    .option('--per-payment <amount>', 'Maximum amount per payment')
    .option('--daily <amount>', 'Maximum total across a rolling 24 hours; preserves other windows')
    .option('--unit <unit>', 'ATTO (default) or RAW for the supplied amount flags')
    .option('--input <json>', 'Replace the entire policy using JSON: {"perRequest":null,"rolling":[]}')
    .option('--access <mode>', 'MCP access: read-only or spend; defaults to current access')
    .option('--message-signing-indexes <indexes>', 'Grant message signing for comma-separated indexes, or use none to clear', value => {
      const trimmed = value.trim();
      if (trimmed.toLowerCase() === 'none') return [];
      if (!trimmed) throw new InvalidArgumentError('Use comma-separated indexes or none.');
      return trimmed.split(',').map(entry => number(entry.trim()));
    })
    .action(async options => {
      if (options.input !== undefined && [options.perPayment, options.daily, options.unit].some(value => value !== undefined)) throw new AttoError('INVALID_INPUT', 'Choose policy JSON or amount flags, not both.');
      if ([options.input, options.perPayment, options.daily, options.access, options.messageSigningIndexes].every(value => value === undefined)) throw new AttoError('INVALID_INPUT', 'Supply --per-payment, --daily, --input, --access, or --message-signing-indexes.');
      if (options.unit !== undefined && options.perPayment === undefined && options.daily === undefined) throw new AttoError('INVALID_INPUT', '--unit requires --per-payment or --daily.');
      return proposeAndApprove(current => ({
        policy: options.input !== undefined ? json(options.input) : {
          perRequest: options.perPayment === undefined ? current.policy.perRequest : { amount: options.perPayment, unit: options.unit ?? 'ATTO' },
          rolling: options.daily === undefined ? current.policy.rolling : [...current.policy.rolling.filter(rule => rule.days !== 1), { days: 1, amount: options.daily, unit: options.unit ?? 'ATTO' }],
        }, access: options.access, messageSigningIndexes: options.messageSigningIndexes,
      }));
    });
  limits.command('clear').description('Remove all spending limits, preserving historical usage')
    .action(() => proposeAndApprove(() => ({ policy: { perRequest: null, rolling: [] } })));
  limits.command('approve <id>').description('Review and approve an immutable proposal in this terminal')
    .action(async id => output(await approveLimitsProposal({ id, directory: program.opts().dataDir })));
  limits.command('reject <id>').description('Review and reject an immutable proposal in this terminal')
    .action(async id => output(await rejectLimitsProposal({ id, directory: program.opts().dataDir })));

  const pool = program.command('pool').description('Accounts available for automatic payment selection');
  pool.command('status').description('Read pool membership, balances, and readiness').action(() => call('pool_get'));
  pool.command('configure').description('Propose and locally approve account-pool settings')
    .option('--indexes <indexes>', 'Unique comma-separated account indexes, up to 100', value => value.split(',').map(value => number(value.trim())))
    .option('--consolidate', 'Allow moving pool funds together before an automatic payment')
    .option('--no-consolidate', 'Disable consolidation; omission preserves the current setting')
    .action(async options => {
      if (options.indexes === undefined && options.consolidate === undefined) throw new AttoError('INVALID_INPUT', 'Supply --indexes, --consolidate, or --no-consolidate.');
      return proposeAndApprove(current => ({ pool: { indexes: options.indexes ?? current.pool.indexes, consolidate: options.consolidate ?? current.pool.consolidate } }));
    });

  const journal = program.command('journal').description('Local payment history, metadata, and progress');
  journal.command('list').description('List newest payment records first')
    .option('--status <status>', 'reserved, signed, published, unknown, or failed')
    .option('--limit <count>', 'Maximum returned records (1-100; defaults to 50)', number)
    .option('--cursor <cursor>', 'Continue a previous journal page with the same status filter')
    .action(options => call('journal_list', options));
  journal.command('show <request-id>').description('Read one payment record by request ID')
    .action(requestId => call('journal_get', { requestId }));

  streamOptions(program.command('watch <event>').description('Observe events for active wallet accounts by default until Ctrl+C; does not receive funds'))
    .option('--network-wide', 'Watch the whole network instead of active wallet accounts; unavailable for receivables')
    .action(async (event, options) => {
      const watch = await app().call('watch_start', compact({ event, ...options })) as { id: string };
      output(watch, 'watch_start');
      try {
        await waitForSignal(async signal => {
          let cursor: number | undefined;
          let lastStatus: string | undefined;
          while (!signal.aborted) {
            const result = await app().call('watch_read', compact({ id: watch.id, cursor })) as { events: unknown[]; nextCursor: number; gapDetected: boolean; status: string; lastError?: unknown };
            const status = JSON.stringify([result.status, result.lastError]);
            if (result.events.length || result.gapDetected || status !== lastStatus) output(result, 'watch_read');
            lastStatus = status;
            cursor = result.nextCursor;
            if (['stopped', 'completed'].includes(result.status) && result.events.length === 0) break;
            await delay(250, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
          }
        });
      } finally {
        await app().call('watch_stop', { id: watch.id });
      }
    });

  program.command('operations [name]').description('List shared operations or inspect one input schema')
    .action(name => {
      const visible = operations;
      if (name === undefined) return output(visible.map(({ name, description, readOnly }) => ({ name, description, readOnly })), 'operations');
      const operation = visible.find(operation => operation.name === name);
      if (!operation) throw new AttoError('UNKNOWN_OPERATION', 'Unknown Atto operation. Run atto operations to list available names.');
      output({ name: operation.name, description: operation.description, readOnly: operation.readOnly, inputSchema: z.toJSONSchema(operation.schema, { io: 'input' }) });
    });
  program.command('call <operation>').description('Call a single operation with JSON input; use watch for streaming')
    .option('--input <json>', 'Operation arguments as JSON', '{}')
    .action((operation, options) => {
      if (['watch_start', 'watch_list', 'watch_read', 'watch_stop'].includes(operation)) throw new AttoError('SESSION_REQUIRED', 'Use atto watch for terminal streaming, or MCP for persistent watch IDs.');
      return call(operation, json(options.input));
    });

  const parserCommand = configureHelp(program, {
    atto: 'atto wallet create\n  atto balances\n  atto send <address> 1\n  atto wallet receive',
    'atto doctor': 'atto doctor\n  atto --json --data-dir <wallet-directory> doctor',
    'atto wallet': 'atto wallet status', 'atto wallet status': 'atto wallet status',
    'atto wallet configure': 'atto wallet configure --node-url https://node-public.live.application.atto.cash --auto-receive',
    'atto wallet create': 'atto wallet create', 'atto wallet import': 'atto wallet import',
    'atto wallet reset': 'atto wallet reset', 'atto wallet backup': 'atto wallet backup', 'atto wallet receive': 'atto wallet receive',
    'atto wallet receive status': 'atto wallet receive status', 'atto wallet receive stop': 'atto wallet receive stop',
    'atto address': 'atto address add\n  atto address list', 'atto address list': 'atto address list',
    'atto address add': 'atto address add', 'atto address derive': 'atto address derive 3',
    'atto address activate': 'atto address activate 1', 'atto address deactivate': 'atto address deactivate 1',
    'atto account': 'atto account --index 0', 'atto balances': 'atto balances\n  atto balances --all',
    'atto transaction': 'atto transaction <hash>', 'atto entry': 'atto entry <hash>',
    'atto history': 'atto history --index 0\n  atto history transaction --addresses <address>',
    'atto receivables': 'atto receivables --index 1',
    'atto labels': 'atto labels set 1 \"Savings\"\n  atto labels list --all',
    'atto labels set': 'atto labels set 1 \"Savings\"', 'atto labels remove': 'atto labels remove 1',
    'atto labels show': 'atto labels show 1', 'atto labels list': 'atto labels list --all --search treasury',
    'atto message': 'atto message sign --index 0 --text "exact challenge"\n  atto message verify --public-key <hex> --signature <hex> --hex <bytes>',
    'atto message sign': 'atto message sign --index 0 --text "exact challenge"',
    'atto message verify': 'atto message verify --public-key <hex> --signature <hex> --text "exact challenge"',
    'atto send': 'atto send <address> 1\n  atto send --to-index 1 --amount 1\n  atto send --to-label "Savings" --amount 1\n  atto send <address> --usd 1',
    'atto market': 'atto market connect --api-url https://market.example/v1/agent/topups --audience marketplace --controller-index 0 --browser-origin https://site.example\n  atto market topup 1 --request-id marketplace-funding-001\n  atto market status marketplace-funding-001',
    'atto market connect': 'atto market connect --api-url https://market.example/v1/agent/topups --audience marketplace --controller-index 0 --browser-origin https://site.example',
    'atto market topup': 'atto market topup 1 --request-id marketplace-funding-001',
    'atto market status': 'atto market status marketplace-funding-001',
    'atto market approve': 'atto market approve ./market-approval-request.json',
    'atto metrics': 'atto metrics', 'atto quote': 'atto quote --usd 1',
    'atto terms': 'atto terms show', 'atto terms show': 'atto terms show',
    'atto terms accept': 'atto terms accept --version <version-shown-by-terms-show> --accepted',
    'atto receive': 'atto receive <send-hash> --index 1', 'atto receive-all': 'atto receive-all --index 1',
    'atto representative': 'atto representative weight <address>',
    'atto representative weight': 'atto representative weight <address>',
    'atto representative change': 'atto representative change <address> --index 0',
    'atto limits': 'atto limits status', 'atto limits status': 'atto limits status',
    'atto limits set': 'atto limits set --per-payment 10 --daily 25\n  atto limits set --message-signing-indexes 0,1\n  atto limits set --message-signing-indexes none', 'atto limits clear': 'atto limits clear',
    'atto limits approve': 'atto limits approve <proposal-id>', 'atto limits reject': 'atto limits reject <proposal-id>',
    'atto pool': 'atto pool status', 'atto pool status': 'atto pool status',
    'atto pool configure': 'atto pool configure --indexes 0,1 --consolidate\n  atto pool configure --no-consolidate',
    'atto journal': 'atto journal list', 'atto journal list': 'atto journal list --status unknown',
    'atto journal show': 'atto journal show <request-id>',
    'atto watch': 'atto watch transaction\n  atto watch account --addresses <address>\n  atto watch transaction --network-wide',
    'atto operations': 'atto operations send',
    'atto call': 'atto --json call account_get --input \'{"index":0}\'',
  });

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
      if (!error.exitCode) return;
      if (error.code === 'commander.help' && parserCommand() === program && !program.opts().json) {
        program.outputHelp();
        process.exitCode = 0;
        return;
      }
      const message = commandErrorMessage(error);
      if (program.opts().json) {
        jsonOutput({ error: { code: 'INVALID_INPUT', message } });
      } else {
        process.stderr.write(`Error: ${message}\n\n${parserCommand().helpInformation({ error: true })}`);
      }
    } else {
      const failure = errorResult(error);
      if (sendRequestId) failure.details = { ...failure.details as object, requestId: sendRequestId };
      if (program.opts().json) jsonOutput({ error: failure });
      else {
        process.stderr.write(`${failure.code === 'CANCELLED' ? '' : 'Error: '}${failure.message}\n`);
        if (['INVALID_INPUT', 'INVALID_ADDRESS', 'INVALID_AMOUNT', 'INVALID_POLICY', 'INVALID_FILTER', 'INVALID_HEIGHT', 'INVALID_CURSOR'].includes(failure.code)) {
          const fields = (failure.details as { fields?: string[] } | undefined)?.fields;
          if (fields?.length) process.stderr.write(`Check fields: ${fields.join(', ')}.\n`);
          process.stderr.write(`\n${activeCommand.helpInformation()}`);
        }
      }
      process.exitCode = 1;
    }
  } finally {
    await application?.close();
  }
}
