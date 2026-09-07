#!/usr/bin/env node
// Set this before dynamic imports: Commons' Kotlin logger initializes lazily.
process.env.KOTLIN_LOGGING_STARTUP_MESSAGE = 'false';
console.log = console.info = console.debug = console.error.bind(console);

try {
  const { runCli } = await import('./cli.js');
  await runCli();
} catch {
  process.stderr.write('Atto could not start. Check runtime, password store, and state directory availability.\n');
  process.exitCode = 1;
}
