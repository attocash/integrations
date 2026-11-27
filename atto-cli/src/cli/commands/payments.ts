import { randomUUID } from 'node:crypto';
import { InvalidArgumentError } from 'commander';
import { parseOperation } from '../../application/operations.js';
import { AttoError, errorResult } from '../../domain/errors.js';
import type { AccountPool, SpendingPolicy } from '../../wallet/types.js';
import { approveLimitsProposal, rejectLimitsProposal } from '../onboarding.js';
import { formatHumanResult } from '../output.js';
import { requireTerminal } from '../terminal.js';
import { type CliContext, compact, json, number } from './context.js';

export function registerPaymentCommands(context: CliContext): void {
  const { program, app, output, call, waitForSignal, setSendRequestId } = context;

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
      const requestId = input.requestId as string;
      setSendRequestId(requestId);
      const progress = (value: Record<string, unknown>, message?: string) => {
        process.stderr.write(program.opts().json ? `${JSON.stringify({ progress: value })}\n`
          : message ?? formatHumanResult(value));
      };
      progress({ requestId });
      return waitForSignal(async signal => {
        const result = await app(undefined, {
          signal,
          onRetry: (error, delayMs) => progress({ requestId, error: errorResult(error), retryInMs: delayMs },
            `${error.message} Retrying in ${delayMs / 1000}s. Press Ctrl+C to stop.\n`),
        }, binding => progress({ requestId, destination: binding.address, network: binding.network, ...(binding.label ? { personalName: binding.label } : {}) })).call('send', input);
        app().resumeWork();
        output(result, 'send');
      });
    });

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

  const limits = program.command('limits').description('Shared spending budgets and usage');
  limits.command('status').description('Read active limits, spending usage, and pending proposals').action(() => call('limits_get'));
  const proposeAndApprove = async (update: (current: { mcpAccess: string; policy: SpendingPolicy; pool: AccountPool; messageSigningIndexes: number[] }) => { policy?: Record<string, unknown>; access?: string; pool?: AccountPool; messageSigningIndexes?: number[] }) => {
    requireTerminal();
    const current = await app().call('limits_get') as { mcpAccess: string; policy: SpendingPolicy; pool: AccountPool; messageSigningIndexes: number[] };
    const changes = update(current);
    const { proposal } = await app().call('limits_propose', compact({ policy: changes.policy ?? current.policy, access: changes.access ?? current.mcpAccess,
      pool: changes.pool, messageSigningIndexes: changes.messageSigningIndexes })) as { proposal: { id: string } };
    output(await approveLimitsProposal({ id: proposal.id, directory: app().directory }));
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
    .option('--indexes <indexes>', 'Unique comma-separated account indexes, up to 100', value => value.split(',').map(entry => number(entry.trim())))
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
}
