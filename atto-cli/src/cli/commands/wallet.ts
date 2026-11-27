import { AttoError } from '../../domain/errors.js';
import { readMarketplaceProofApprovalRequest, writeMarketplaceProofApprovalResponse } from '../../marketplace/approval-files.js';
import { formatMarketplaceApprovalPreview } from '../../marketplace/approval-preview.js';
import { hiddenPrompt, requireTerminal, showRecovery, terminalPrompt } from '../terminal.js';
import { type CliContext, number } from './context.js';

export function registerWalletCommands(context: CliContext): void {
  const { program, activeCommand, app, output, call, waitForSignal, diagnose } = context;

  program.command('doctor').description('Check runtime, profile, keyring, node, worker, and readiness; diagnose without repairs (up to 60s)')
    .option('--global-directory', 'Also check the public LIVE address directory without updating its cache')
    .action(options => diagnose(options));

  const wallet = program.command('wallet').description('Wallet setup, settings, and automatic receiving');
  wallet.command('status').description('Read public wallet status').action(() => call('wallet_status'));
  wallet.command('configure').description('Update public settings')
    .option('--network <name>', 'LIVE, BETA, DEV, or LOCAL')
    .option('--node-url <url>', 'Node HTTP(S) URL')
    .option('--node-batch-size <size>', 'Accounts/ranges per request (1-1000), or auto: official gateways 5, custom nodes 1000', value => value === 'auto' ? value : number(value))
    .option('--worker-url <url>', 'Work server HTTP(S) URL')
    .option('--representative <address>', 'Default representative for opening accounts; use representative change for existing accounts')
    .option('--auto-receive', 'Enable automatic receiving in receiving sessions')
    .option('--no-auto-receive', 'Disable automatic receiving')
    .option('--min-receive-raw <amount>', 'Minimum automatically received amount in RAW')
    .action(options => call('wallet_configure', { ...options, ...(options.nodeBatchSize === 'auto' ? { nodeBatchSize: null } : {}) }));
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
      if (activeCommand().opts().background) {
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

  const marketplace = program.command('marketplace').description('Connect and approve Marketplace identity requests');
  marketplace.command('connect').description('Connect this wallet to Marketplace in a local terminal')
    .requiredOption('--api-url <url>', 'Marketplace /v1/agent/payments URL')
    .requiredOption('--audience <audience>', 'Exact Marketplace controller-proof audience')
    .option('--browser-origin <origin>', 'Allow this exact browser origin for typed proof approvals (repeatable)',
      (origin: string, previous: string[]) => [...previous, origin], [])
    .option('--controller-index <index>', 'Saved wallet controller account index (default: 0)', number, 0)
    .action(async options => {
      requireTerminal();
      const result = await app().connectMarketplace({ apiUrl: options.apiUrl, audience: options.audience,
        controllerIndex: options.controllerIndex, ...(options.browserOrigin?.length ? { browserOrigins: options.browserOrigin } : {}) });
      output(result, 'marketplace_connect');
    });
  marketplace.command('approve <request-file>').description('Review and sign one exact typed Marketplace controller-proof request')
    .action(async requestFile => {
      requireTerminal();
      const request = readMarketplaceProofApprovalRequest(requestFile);
      const { preview } = app().inspectMarketplaceProofApproval(request);
      process.stderr.write(`${formatMarketplaceApprovalPreview(preview)}\n`);
      if (await terminalPrompt('Type approve to sign this exact Marketplace challenge: ') !== 'approve') {
        throw new AttoError('CANCELLED', 'No Marketplace wallet approval was signed.');
      }
      const response = await app().approveMarketplaceProof(request);
      const responseFile = writeMarketplaceProofApprovalResponse(requestFile, response);
      output({ approved: true, responseFile, handoffId: preview.handoffId,
        challengeId: preview.challengeId, expiresAt: preview.expiresAt }, 'marketplace_approve');
    });
}
