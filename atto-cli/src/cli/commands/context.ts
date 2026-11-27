import { type Command, InvalidArgumentError } from 'commander';
import type { AttoApplication } from '../../application/app.js';
import { AttoError } from '../../domain/errors.js';
import type { SendRetry } from '../../network/retry.js';
import type { DestinationBinding } from '../../spending/destination.js';
import type { ReceiveProgress } from '../../wallet/auto-receive.js';

export interface CliContext {
  program: Command;
  activeCommand(): Command;
  app(onReceiveProgress?: (event: ReceiveProgress) => void, sendRetry?: SendRetry, onDestination?: (binding: DestinationBinding) => void): AttoApplication;
  output(result: unknown, operation?: string): void;
  call(name: string, input?: Record<string, unknown>): Promise<void>;
  waitForSignal(work: (signal: AbortSignal) => Promise<void>): Promise<void>;
  diagnose(options?: { globalDirectory?: boolean }): Promise<void>;
  setSendRequestId(requestId: string): void;
}

export function number(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InvalidArgumentError('Use an unsigned integer.');
  return Number(value);
}

export function json(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new AttoError('INVALID_INPUT', 'Input must be a JSON object.');
  }
}

export function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

export function addressOptions(command: Command): Command {
  return command.option('--index <index>', 'Select one saved wallet account', number)
    .option('--addresses <addresses>', 'Comma-separated addresses, including accounts outside this wallet', value => value.split(',').map(entry => entry.trim()));
}

export function listOptions(command: Command): Command {
  return addressOptions(command)
    .option('--limit <count>', 'Maximum returned records (1-1000; default: 100)', number)
    .option('--timeout-ms <milliseconds>', 'Scan window (100-30000 ms; default: 3000)', number);
}

export function streamOptions(command: Command): Command {
  return addressOptions(command)
    .option('--hash <hash>', 'Select one transaction or entry by hash; cannot combine with an account selector')
    .option('--from-height <height>', 'Inclusive starting height for account transaction/entry streams (default: 1)')
    .option('--to-height <height>', 'Inclusive ending height for account transaction/entry streams')
    .option('--min-amount-raw <raw>', 'Minimum receivable amount in RAW (default: 0; receivable events only)');
}
