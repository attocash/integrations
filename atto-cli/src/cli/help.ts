import { Command, CommanderError } from 'commander';

/** Keep nested parser errors attached to the command whose input was invalid. */
export function configureHelp(program: Command, examples: Record<string, string>): () => Command {
  let failedCommand = program;
  function visit(command: Command, prefix = '') {
    const path = `${prefix} ${command.name()}`.trim();
    command.exitOverride(error => { failedCommand = command; throw error; });
    if (examples[path]) command.addHelpText('after', `\nExample:\n  ${examples[path]}`);
    for (const argument of command.registeredArguments) {
      if (!argument.description) argument.description = {
        address: 'Atto address', destination: 'Recipient Atto address', amount: 'Exact amount (default unit: ATTO)',
        hash: '64-character transaction hash', id: 'Proposal ID', 'request-id': 'Saved payment request ID',
        'address-or-index': 'Atto address or existing saved wallet index',
        event: 'Event type', name: command.parent?.name() === 'labels' ? 'Personal name (1–128 characters after trimming)' : 'Shared operation name', operation: 'Shared operation name; inspect it with atto operations <name>',
      }[argument.name()] ?? argument.name();
    }
    for (const option of command.options) {
      if (option.long === '--unit') option.choices(command.name() === 'send' ? ['ATTO', 'RAW', 'USD'] : ['ATTO', 'RAW']);
      if (option.long === '--network') option.choices(['LIVE', 'BETA', 'DEV', 'LOCAL']);
      if (option.long === '--access') option.choices(['read-only', 'spend']);
      if (option.long === '--status') option.choices(['reserved', 'signed', 'published', 'unknown', 'failed']);
    }
    if (command.name() === 'history') command.registeredArguments[0]?.choices(['entry', 'transaction']).default('entry');
    if (command.name() === 'watch') command.registeredArguments[0]?.choices(['account', 'transaction', 'entry', 'receivable']);
    command.commands.forEach(child => visit(child, path));
  }
  visit(program);
  return () => failedCommand;
}

export function commandErrorMessage(error: CommanderError): string {
  if (['commander.missingArgument', 'commander.optionMissingArgument', 'commander.missingMandatoryOptionValue'].includes(error.code)) {
    return error.message.replace(/^error: /, '');
  }
  // Other Commander messages can contain supplied values, including secrets.
  return {
    'commander.help': 'Missing subcommand. Choose one of the available commands.',
    'commander.unknownCommand': 'Unknown command.',
    'commander.unknownOption': 'Unknown option.',
    'commander.invalidArgument': 'Invalid argument value. Check the accepted values in this command\'s help.',
    'commander.excessArguments': 'Too many arguments.',
  }[error.code] ?? 'Invalid command arguments.';
}
