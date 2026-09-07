import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { Command, CommanderError } from 'commander';
import { createApplication, errorResult, runDoctor } from '@attocash/cli/core';
import { dedicatedMcpDirectory } from '@attocash/cli/profiles';
import { approveLimitsProposal, rejectLimitsProposal, setupMcp, formatHumanResult, configureHelp, commandErrorMessage } from '@attocash/cli/terminal';
import { createMcpServer } from './server.js';

export async function runMcp(argv = process.argv): Promise<void> {
  const version: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const program = new Command().name('atto-mcp').description('Local Atto MCP server over stdio')
    .option('--data-dir <directory>', 'Public wallet state directory')
    .option('--json', 'Print JSON for terminal command results; server mode always uses JSON-RPC')
    .version(version)
    .configureOutput({ writeErr: () => {} })
    .exitOverride();
  const directory = () => program.opts().dataDir as string | undefined;
  let serving = false;
  const output = (value: unknown, operation?: string): void => {
    process.stdout.write(program.opts().json ? `${JSON.stringify({ result: value })}\n` : formatHumanResult(value, operation));
  };
  program.action(() => { serving = true; return serve(directory() ?? dedicatedMcpDirectory()); });
  program.command('doctor').description('Check this launch environment, profile, keyring, node, and worker without repairs (up to 60s)')
    .option('--global-directory', 'Also check the public LIVE address directory without updating its cache')
    .action(async options => {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        const report = await runDoctor({ directory: directory() ?? dedicatedMcpDirectory(), access: 'mcp', signal: controller.signal, globalDirectory: options.globalDirectory });
        report.context.mcpVersion = version;
        output(report, 'doctor');
        if (report.status === 'fail') process.exitCode = 1;
      } finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      }
    });
  program.command('setup').description('Choose a wallet and approve MCP access in this terminal')
    .action(async () => { process.stdout.write(`${JSON.stringify(await setupMcp({ directory: directory() }), null, 2)}\n`); });
  const limits = program.command('limits').description('Approve or reject proposed limits in this terminal');
  limits.command('approve <id>').description('Review and approve an immutable proposal')
    .action(async id => output(await approveLimitsProposal({ id, directory: directory() ?? dedicatedMcpDirectory() })));
  limits.command('reject <id>').description('Review and reject an immutable proposal')
    .action(async id => output(await rejectLimitsProposal({ id, directory: directory() ?? dedicatedMcpDirectory() })));
  const parserCommand = configureHelp(program, {
    'atto-mcp': 'atto-mcp setup\n  atto-mcp --data-dir <wallet-directory>',
    'atto-mcp setup': 'npx --yes @attocash/mcp setup',
    'atto-mcp doctor': 'npx --yes @attocash/mcp doctor\n  atto-mcp --json --data-dir <wallet-directory> doctor',
    'atto-mcp limits': 'atto-mcp --data-dir <wallet-directory> limits approve <proposal-id>',
    'atto-mcp limits approve': 'atto-mcp --data-dir <wallet-directory> limits approve <proposal-id>',
    'atto-mcp limits reject': 'atto-mcp --data-dir <wallet-directory> limits reject <proposal-id>',
  });
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
      if (error.exitCode) {
        const failure = { code: 'INVALID_INPUT', message: commandErrorMessage(error) };
        if (program.opts().json) process.stdout.write(`${JSON.stringify({ error: failure })}\n`);
        else process.stderr.write(`Error: ${failure.message}\n\n${parserCommand().helpInformation()}`);
      }
    } else {
      const failure = errorResult(error);
      if (program.opts().json && !serving) process.stdout.write(`${JSON.stringify({ error: failure })}\n`);
      else process.stderr.write(`${failure.code === 'CANCELLED' ? '' : 'Error: '}${failure.message}\n`);
      process.exitCode = 1;
    }
  }
}

async function serve(directory: string): Promise<void> {
  const application = createApplication({ directory, access: 'mcp' });
  const server = createMcpServer(application);
  const transport = new StdioServerTransport();
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.stdin.removeListener('end', onSignal);
    await application.close();
    await server.close();
  })();
  const onSignal = () => { void close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.stdin.once('end', onSignal);
  server.server.onclose = onSignal;
  server.server.onerror = () => process.stderr.write('Atto MCP protocol error.\n');
  try {
    await application.start();
    await server.connect(transport);
  } catch (error) {
    await close();
    throw error;
  }
}
