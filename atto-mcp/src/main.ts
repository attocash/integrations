#!/usr/bin/env node
// stdout belongs exclusively to JSON-RPC, including during dependency imports.
process.env.KOTLIN_LOGGING_STARTUP_MESSAGE = 'false';
console.log = console.info = console.debug = console.error.bind(console);

try {
  const { runMcp } = await import('./stdio.js');
  await runMcp();
} catch {
  process.stderr.write('Atto MCP could not start. Check runtime, password store, and state directory availability.\n');
  process.exitCode = 1;
}
