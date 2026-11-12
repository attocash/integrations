import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageDirectory = process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR ?? join(import.meta.dirname, '..');
const { marketplaceCommand, shellQuote } = await import(pathToFileURL(join(packageDirectory, 'dist/shell-quote.js')).href);
const { parseCommandPointer } = await import(pathToFileURL(join(packageDirectory, 'dist/marketplace-api.js')).href);

const id='55555555-5555-4555-8555-555555555555';

test('durable command pointers are distinct from x402 top-up status locations',()=>{
  assert.deepEqual(parseCommandPointer({commandId:id,status:'PENDING',statusUrl:`/v1/agent/commands/${id}`}),
    {commandId:id,statusUrl:`/v1/agent/commands/${id}`});
  assert.equal(parseCommandPointer({commandId:id,intentId:id,state:'PENDING',
    statusUrl:`/v1/agent/topups/${id}`}),undefined);
  assert.throws(()=>parseCommandPointer({commandId:id,statusUrl:'/v1/agent/tasks/other'}),{code:'COMMAND_PROTOCOL'});
});


test('terminal remediation quotes spaces, apostrophes and literal command syntax for the current shell', () => {
  // Given an explicitly selected private home containing shell metacharacters.
  const path = String.raw`C:\Users\O'Brien\Marketplace & $(literal)`;
  // When a local approval command is rendered for PowerShell or a POSIX shell.
  const windows = shellQuote(path, 'win32');
  const posix = shellQuote(path, 'linux');
  // Then PowerShell doubles apostrophes and both shells preserve literal path bytes.
  assert.equal(windows, String.raw`'C:\Users\O''Brien\Marketplace & $(literal)'`);
  assert.equal(posix, String.raw`'C:\Users\O'\''Brien\Marketplace & $(literal)'`);
});

test('terminal literals preserve private path arguments through the current shell', () => {
  // Given paths with spaces, apostrophes, and ampersands with and without adjacent spaces.
  const paths = [String.raw`C:\Users\O'Brien\Marketplace & $(literal)`, String.raw`C:\Users\O'Brien&Wallet\request.json`];
  const command = `${process.platform === 'win32' ? '& ' : ''}${shellQuote(process.execPath)} -e ${shellQuote('process.stdout.write(JSON.stringify(process.argv.slice(1)))')} ${paths.map(path => shellQuote(path)).join(' ')}`;
  // When the recommended shell passes those literals to an ordinary Node process.
  const stdout = process.platform === 'win32'
    ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {encoding:'utf8', timeout:15_000})
    : execFileSync('/bin/sh', ['-c', command], {encoding:'utf8', timeout:15_000});
  // Then the receiving process observes the exact original path bytes.
  assert.deepEqual(JSON.parse(stdout), paths);
});

test('generated terminal command launches the current installed entrypoint', () => {
  // Given the current package's generated command, with absolute Node and entrypoint paths.
  const command = `${marketplaceCommand} --help`;
  // When the recommended shell runs its harmless help command using the current execution policy.
  const stdout = process.platform === 'win32'
    ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {encoding:'utf8', timeout:15_000})
    : execFileSync('/bin/sh', ['-c', command], {encoding:'utf8', timeout:15_000});
  // Then it launches this Marketplace entrypoint without depending on an npm bin directory in PATH.
  assert.match(stdout, /^Marketplace MCP/);
});
