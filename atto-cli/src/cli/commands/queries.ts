import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { operations } from '../../application/operations.js';
import { AttoError } from '../../domain/errors.js';
import { addressOptions, type CliContext, compact, json, listOptions, number, streamOptions } from './context.js';

export function registerQueryCommands(context: CliContext): void {
  const { program, app, output, call, waitForSignal } = context;

  addressOptions(program.command('account [address]').description('Read full account snapshots by address, key index, or a batch of addresses'))
    .action((address, options) => call('account_get', { address, ...options }));
  addressOptions(program.command('balances').description('Read balances and total for active wallet accounts by default'))
    .option('--all', 'Include every saved address, including inactive accounts').action(options => call('balances_get', options));
  program.command('transaction <hash>').description('Read a raw signed protocol transaction; use entry for action history').action(hash => call('transaction_get', { hash }));
  program.command('entry <hash>').description('Read an action entry with owner, sender/receiver or new representative, and transfer amount').action(hash => call('entry_get', { hash }));
  listOptions(program.command('history [event]').description('Read action entries by default; choose transaction for raw signed protocol records'))
    .option('--last <count>', 'Read the last N heights per selected account within the height range', number)
    .option('--cursor <cursor>', 'Continue a previous history page with the same filters')
    .option('--from-height <height>', 'Inclusive starting height')
    .option('--to-height <height>', 'Inclusive ending height')
    .action((event, options) => call('history_list', { event, ...options }));
  listOptions(program.command('receivables').description('Scan pending payments for active wallet accounts by default; does not receive them'))
    .option('--min-amount-raw <raw>', 'Minimum amount in RAW (default: 0)').action(options => call('receivables_list', options));

  program.command('metrics').description('Read public Atto market metrics').action(() => call('metrics_get'));
  program.command('quote [amount]').description('Preview a conversion between USD and ATTO at the indicative market price')
    .option('--from <currency>', 'Source currency (USD or ATTO); required with a positional amount')
    .option('--to <currency>', 'Target currency (USD or ATTO); required with a positional amount')
    .option('--usd <amount>', 'Shorthand for converting USD to ATTO')
    .action((amount, { from, to, usd }) => {
      if (usd !== undefined) {
        if (amount !== undefined || from !== undefined || to !== undefined) {
          throw new AttoError('INVALID_INPUT', 'Use --usd on its own or supply an amount with --from and --to.');
        }
        return call('price_quote', { amount: usd });
      }
      if (amount === undefined || from === undefined || to === undefined) {
        throw new AttoError('INVALID_INPUT', 'Supply an amount with --from and --to, or use --usd <amount>.');
      }
      return call('price_quote', { amount, from, to });
    });
  const terms = program.command('terms').description('Terms for USD-priced payments');
  terms.command('show').description('Read current terms and required acceptance version').action(() => call('terms_get'));
  terms.command('accept').description('Record explicit acceptance after reading the current terms')
    .requiredOption('--version <version>', 'Exact version returned by terms show')
    .requiredOption('--accepted', 'Confirm that you read and accept those terms')
    .action(options => call('terms_accept', { version: options.version, accepted: options.accepted }));

  const representative = program.command('representative').description('Account representatives and voting weight');
  representative.command('weight <address>').description('Read any representative address voting weight').action(address => call('representative_weight', { address }));
  representative.command('change <address>').description('Publish a representative change for an existing account')
    .option('--index <index>', 'Wallet account index (default: 0)', number)
    .action((target, options) => call('representative_change', { representative: target, ...options }));

  const message = program.command('message').description('Sign or verify exact Atto message bytes');
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
    .option('--address <address>', 'Atto address corresponding to the signing public key')
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
      const visible = operations.filter(operation => !operation.internalOnly);
      if (name === undefined) return output(visible.map(({ name, description, readOnly }) => ({ name, description, readOnly })), 'operations');
      const operation = visible.find(item => item.name === name);
      if (!operation) throw new AttoError('UNKNOWN_OPERATION', 'Unknown Atto operation. Run atto operations to list available names.');
      output({ name: operation.name, description: operation.description, readOnly: operation.readOnly, inputSchema: z.toJSONSchema(operation.schema, { io: 'input' }) });
    });
  program.command('call <operation>').description('Call a single operation with JSON input; use watch for streaming')
    .option('--input <json>', 'Operation arguments as JSON', '{}')
    .action((operation, options) => {
      if (['watch_start', 'watch_list', 'watch_read', 'watch_stop'].includes(operation)) throw new AttoError('SESSION_REQUIRED', 'Use atto watch for terminal streaming, or MCP for persistent watch IDs.');
      return call(operation, json(options.input));
    });
}
