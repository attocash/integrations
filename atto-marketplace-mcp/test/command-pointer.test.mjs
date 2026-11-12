import { shellQuote } from '../dist/shell-quote.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCommandPointer } from '../dist/marketplace-api.js';

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
  const path = "C:\Users\O'Brien\Marketplace $(literal)";
  // When a local approval command is rendered for PowerShell or a POSIX shell.
  const windows = shellQuote(path, 'win32');
  const posix = shellQuote(path, 'linux');
  // Then PowerShell doubles apostrophes and both shells preserve literal path bytes.
  assert.equal(windows, "'C:\Users\O''Brien\Marketplace $(literal)'");
  assert.equal(posix, "'C:\Users\O'\\''Brien\Marketplace $(literal)'");
});
