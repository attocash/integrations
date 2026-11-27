import { readFileSync } from 'node:fs';
import { Command, CommanderError } from 'commander';
import { AttoApplication } from '../application/app.js';
import { parseOperation } from '../application/operations.js';
import { runDoctor } from '../doctor/doctor.js';
import { errorResult } from '../domain/errors.js';
import type { SendRetry } from '../network/retry.js';
import type { DestinationBinding } from '../spending/destination.js';
import type { ReceiveProgress } from '../wallet/auto-receive.js';
import { type CliContext, compact } from './commands/context.js';
import { registerPaymentCommands } from './commands/payments.js';
import { registerQueryCommands } from './commands/queries.js';
import { registerWalletCommands } from './commands/wallet.js';
import { cliExamples } from './examples.js';
import { commandErrorMessage, configureHelp } from './help.js';
import { formatHumanResult } from './output.js';
import { notifyUpdate } from './updates.js';
export { formatMarketplaceApprovalPreview } from '../marketplace/approval-preview.js';

export async function runCli(argv = process.argv): Promise<void> {
  const program = new Command();
  let activeCommand = program;
  const currentVersion: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  let application: AttoApplication | undefined;
  let sendRequestId: string | undefined;
  const app = (onReceiveProgress?: (event: ReceiveProgress) => void, sendRetry?: SendRetry, onDestination?: (binding: DestinationBinding) => void) =>
    application ??= new AttoApplication({ directory: program.opts().dataDir as string | undefined, onReceiveProgress, sendRetry, onDestination, workExecution: onReceiveProgress ? 'in-process' : 'detached' });
  const jsonOutput = (value: unknown) => { process.stdout.write(`${JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry)}\n`); };
  const output = (result: unknown, operation?: string) => {
    if (program.opts().json) jsonOutput({ result });
    else process.stdout.write(formatHumanResult(result, operation));
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
  const call = async (name: string, input: Record<string, unknown> = {}) => {
    if (name === 'doctor') { parseOperation(name, input); return diagnose(input); }
    const result = await app().call(name, compact(input));
    app().resumeWork();
    output(result, name);
  };

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

  const context: CliContext = {
    program,
    activeCommand: () => activeCommand,
    app,
    output,
    call,
    waitForSignal,
    diagnose,
    setSendRequestId: requestId => { sendRequestId = requestId; },
  };
  registerWalletCommands(context);
  registerQueryCommands(context);
  registerPaymentCommands(context);

  const parserCommand = configureHelp(program, cliExamples);

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
