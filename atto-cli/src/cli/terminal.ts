import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { AttoError } from '../domain/errors.js';

export function requireTerminal(): void {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new AttoError('TERMINAL_REQUIRED', 'This operation requires an interactive terminal.');
  }
}

/** Public choices and confirmations stay on the terminal; stdout remains machine-readable. */
export async function terminalPrompt(prompt: string): Promise<string> {
  requireTerminal();
  const wasPaused = process.stdin.isPaused();
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  terminal.once('SIGINT', cancel);
  terminal.once('close', cancel);
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    return (await terminal.question(prompt, { signal: controller.signal })).trim();
  } catch (error) {
    if (controller.signal.aborted) throw new AttoError('CANCELLED', 'Terminal operation cancelled.');
    throw error;
  } finally {
    terminal.removeListener('SIGINT', cancel);
    terminal.removeListener('close', cancel);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    terminal.close();
    if (wasPaused) process.stdin.pause();
  }
}

/** Recovery input is read in raw mode without echoing or entering shell history. */
export async function hiddenPrompt(prompt: string): Promise<string> {
  requireTerminal();
  const input = process.stdin;
  const wasRaw = input.isRaw;
  const wasFlowing = input.readableFlowing === true;
  emitKeypressEvents(input);
  process.stderr.write(prompt);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      input.removeListener('keypress', onKey);
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
      input.setRawMode(wasRaw);
      if (!wasFlowing) input.pause();
      process.stderr.write('\n');
    };
    const cancel = () => {
      value = '';
      cleanup();
      reject(new AttoError('CANCELLED', 'Wallet import cancelled.'));
    };
    const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) return cancel();
      if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        const result = value.trim().replace(/\s+/g, ' ');
        value = '';
        resolve(result);
      } else if (key.name === 'backspace') {
        value = value.slice(0, -1);
      } else if (key.ctrl && key.name === 'u') {
        value = '';
      } else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) {
        if (value.length + text.length <= 2048) value += text;
      }
    };
    input.on('keypress', onKey);
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
  });
}

export function showRecovery(mnemonic: string): void {
  requireTerminal();
  process.stderr.write(`\nRecovery phrase (keep a private offline copy):\n${mnemonic}\n\n`);
}
