import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const execute = promisify(execFile);
const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../../atto-cli/', import.meta.url));
const mcpDirectory = process.env.ATTO_TEST_MCP_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const { operations } = await import(pathToFileURL(join(cliDirectory, 'dist/application/operations.js')).href);
const { AttoError } = await import(pathToFileURL(join(cliDirectory, 'dist/domain/errors.js')).href);
const { AttoApplication } = await import(pathToFileURL(join(cliDirectory, 'dist/application/app.js')).href);
const { createApplication } = await import(pathToFileURL(join(cliDirectory, 'dist/core.js')).href);
const { createMcpServer } = await import(pathToFileURL(join(mcpDirectory, 'dist/server.js')).href);

async function connected(application, t) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'atto-interface-test', version: '1.0.0' });
  const server = createMcpServer(application);
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test('MCP discovers every shared operation and keeps recovery operations terminal-only', async t => {
  // Given
  const client = await connected({ call: async () => null }, t);
  // When
  const result = await client.listTools();
  // Then
  assert.deepEqual(result.tools.map(tool => tool.name).sort(), operations.map(operation => operation.name).sort());
  assert.equal(result.tools.length, 36);
  assert.equal(result.tools.some(tool => /mnemonic|backup|import|create_wallet/.test(tool.name)), false);
  assert.equal(result.tools.some(tool => /approv|reject/.test(tool.name)), false);
  assert.equal(result.tools.find(tool => tool.name === 'send').annotations.destructiveHint, true);
  assert.equal(result.tools.find(tool => tool.name === 'limits_propose').annotations.idempotentHint, false);
  assert.equal(result.tools.find(tool => tool.name === 'balances_get').annotations.readOnlyHint, true);
  assert.equal(result.tools.find(tool => tool.name === 'watch_start').annotations.readOnlyHint, false);
  assert.equal(result.tools.find(tool => tool.name === 'price_quote').annotations.readOnlyHint, true);
  assert.equal(result.tools.find(tool => tool.name === 'terms_accept').annotations.readOnlyHint, false);
  assert.equal(result.tools.find(tool => tool.name === 'pool_get').annotations.readOnlyHint, true);
  assert.equal(result.tools.find(tool => tool.name === 'address_add').annotations.idempotentHint, false);
  assert.equal(result.tools.find(tool => tool.name === 'address_add').annotations.openWorldHint, false);
  assert.equal(result.tools.find(tool => tool.name === 'limits_get').annotations.openWorldHint, true);
  assert.equal(result.tools.some(tool => ['limits_set', 'voter_weight'].includes(tool.name)), false);
  assert.equal(result.tools.find(tool => tool.name === 'history_list').inputSchema.properties.event.default, 'entry');
  assert.equal(result.tools.find(tool => tool.name === 'receivables_list').inputSchema.properties.cursor, undefined);
  assert.ok(result.tools.find(tool => tool.name === 'send').inputSchema.properties.destinationIndex);
  assert.equal(result.tools.find(tool => tool.name === 'send').inputSchema.required.includes('unit'), false);
  for (const name of ['journal_list', 'journal_get']) {
    assert.equal(result.tools.find(tool => tool.name === name).annotations.readOnlyHint, true);
    assert.equal(result.tools.find(tool => tool.name === name).annotations.openWorldHint, false);
  }
});

test('MCP limit changes only propose, and an existing connection observes terminal approval', async t => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), 'atto-mcp-approval-'));
  let phrase = null;
  let reads = 0;
  const secrets = { get: async () => { reads++; return phrase; }, set: async value => { phrase = value; } };
  const local = new AttoApplication({ directory, secrets });
  const mcp = new AttoApplication({ directory, secrets, access: 'mcp' });
  t.after(async () => {
    await mcp.close();
    await local.close();
    phrase = null;
    await rm(directory, { recursive: true, force: true });
  });
  await local.createWallet();
  const policy = { perRequest: { amount: '25', unit: 'RAW' }, rolling: [] };
  local.ledger.setPolicy(policy);
  const readsBefore = reads;
  const client = await connected(mcp, t);
  const denied = await client.callTool({ name: 'address_deactivate', arguments: { index: 0 } });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error.code, 'MCP_READ_ONLY');
  const requested = { perRequest: null, rolling: [] };
  // When
  const result = await client.callTool({ name: 'limits_propose', arguments: { policy: requested, pool: { indexes: [0], consolidate: true } } });
  // Then
  assert.equal(result.isError, undefined);
  const proposal = result.structuredContent.result.proposal;
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.access, 'spend');
  assert.deepEqual(proposal.policy, requested);
  assert.deepEqual(proposal.pool, { indexes: [0], consolidate: true });
  const before = (await client.callTool({ name: 'limits_get', arguments: {} })).structuredContent.result;
  assert.deepEqual(before.policy, policy);
  assert.deepEqual(before.pool, { indexes: [0], consolidate: false });
  assert.equal(before.mcpAccess, 'read-only');
  assert.equal(before.proposal.id, proposal.id);
  await local.approveLimitsProposal(proposal.id);
  const allowed = await client.callTool({ name: 'address_deactivate', arguments: { index: 0 } });
  assert.equal(allowed.isError, undefined);
  assert.equal(allowed.structuredContent.result.active, false);
  const after = (await client.callTool({ name: 'limits_get', arguments: {} })).structuredContent.result;
  assert.equal(after.mcpAccess, 'spend');
  assert.deepEqual(after.pool, { indexes: [0], consolidate: true });
  assert.equal(after.proposal.status, 'approved');
  assert.equal(reads, readsBefore, 'Proposal, approval, and public address metadata do not read recovery material.');
});

test('MCP rejects forged approval fields and the public core facade cannot approve proposals', async t => {
  // Given
  const calls = [];
  const client = await connected({ call: async (name, input) => { calls.push({ name, input }); return null; } }, t);
  for (const extra of [{ approved: true }, { trusted: true }, { baseRevision: 0 }, { directory: '/another-profile' }]) {
    // When
    const result = await client.callTool({ name: 'limits_propose', arguments: { policy: { perRequest: null, rolling: [] }, ...extra } });
    // Then
    assert.equal(result.isError, true);
  }
  assert.equal(calls.length, 0, 'Invalid approval fields must be rejected before the application is invoked.');
  await assert.rejects(client.callTool({ name: 'limits_approve', arguments: { id: 'not-an-approval-capability' } }), { code: -32602 });
  assert.equal(calls.length, 0);
  const directory = await mkdtemp(join(tmpdir(), 'atto-mcp-core-approval-'));
  const session = createApplication({ directory, access: 'mcp' });
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true }); });
  assert.deepEqual(Object.keys(session).sort(), ['call', 'close', 'start']);
  for (const name of ['approveLimitsProposal', 'reviewLimitsProposal', 'rejectLimitsProposal']) {
    assert.equal(name in session, false);
    await assert.rejects(session.call(name, { id: 'not-an-approval-capability' }), { code: 'UNKNOWN_OPERATION' });
  }
  await assert.rejects(session.call('wallet_configure', { autoReceive: true }), { code: 'MCP_READ_ONLY' });
});

test('MCP forwards automatic sources and caller metadata without inventing an index', async t => {
  // Given
  const calls = [];
  const client = await connected({ call: async (name, input) => { calls.push({ name, input }); return null; } }, t);
  const payment = { destination: 'atto_test', amount: '0.1', requestId: 'invoice-1', metadata: { reason: 'Invoice', invoice: { id: '1' } } };

  // When
  const automatic = await client.callTool({ name: 'send', arguments: payment });
  const explicit = await client.callTool({ name: 'send', arguments: { ...payment, index: 0 } });
  const journal = await client.callTool({ name: 'journal_get', arguments: { requestId: 'invoice-1' } });

  // Then
  assert.equal(automatic.isError, undefined);
  assert.equal(explicit.isError, undefined);
  assert.equal(journal.isError, undefined);
  assert.equal(Object.hasOwn(calls[0].input, 'index'), false);
  assert.deepEqual(calls[0].input.metadata, payment.metadata);
  assert.equal(calls[1].input.index, 0);
  assert.deepEqual(calls[2], { name: 'journal_get', input: { requestId: 'invoice-1' } });
});

test('MCP preserves exact values and reports application errors without dependency details', async t => {
  const calls = [];
  const client = await connected({ call: async (name, input) => {
    calls.push({ name, input });
    if (name === 'transaction_get') throw new Error('private secret mnemonic must never reach the client');
    if (name === 'send') throw new AttoError('SPENDING_LIMIT', 'Payment exceeds the configured allowance.');
    return [{ address: 'atto_test', raw: '18446744073709551616' }];
  } }, t);
  const balance = await client.callTool({ name: 'balances_get', arguments: {} });
  assert.deepEqual(balance.structuredContent, { result: [{ address: 'atto_test', raw: '18446744073709551616' }] });
  assert.deepEqual(JSON.parse(balance.content[0].text), balance.structuredContent);
  const payment = await client.callTool({ name: 'send', arguments: { destination: 'atto_test', amount: '0.000000000000000001', requestId: 'payment-1' } });
  assert.equal(payment.isError, true);
  assert.equal(payment.structuredContent.error.code, 'SPENDING_LIMIT');
  assert.equal(calls.at(-1).input.unit, 'ATTO');
  const dependencyFailure = await client.callTool({ name: 'transaction_get', arguments: { hash: 'A'.repeat(64) } });
  assert.equal(dependencyFailure.isError, true);
  assert.equal(dependencyFailure.structuredContent.error.code, 'OPERATION_FAILED');
  assert.doesNotMatch(JSON.stringify(dependencyFailure), /private secret|mnemonic must/);
});

test('real stdio MCP discovers tools, matches CLI results, and closes on disconnect', { timeout: 30_000 }, async t => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), 'atto-mcp-interface-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(mcpDirectory, 'dist/main.js'), '--data-dir', directory],
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', data => { stderr += data.toString(); });
  const client = new Client({ name: 'atto-stdio-test', version: '1.0.0' });
  t.after(() => client.close());
  // When
  await client.connect(transport);
  // Then
  assert.equal((await client.listTools()).tools.length, operations.length);
  const result = await client.callTool({ name: 'address_list', arguments: {} });
  const cli = await execute(process.execPath, [join(cliDirectory, 'dist/cli/main.js'), '--json', '--data-dir', directory, 'address', 'list']);
  assert.deepEqual(result.structuredContent, JSON.parse(cli.stdout));
  const journal = await client.callTool({ name: 'journal_list', arguments: {} });
  const cliJournal = await execute(process.execPath, [join(cliDirectory, 'dist/cli/main.js'), '--json', '--data-dir', directory, 'journal', 'list']);
  assert.deepEqual(journal.structuredContent, JSON.parse(cliJournal.stdout));
  assert.deepEqual(journal.structuredContent.result.items, []);
  const missing = await client.callTool({ name: 'journal_get', arguments: { requestId: 'absent' } });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.error.code, 'JOURNAL_NOT_FOUND');
  const status = await client.callTool({ name: 'wallet_status', arguments: {} });
  assert.equal(status.isError, undefined);
  assert.equal(status.structuredContent.result.mcpAccess, 'read-only');
  assert.doesNotMatch(JSON.stringify(status.structuredContent), /"mnemonic"\s*:/);
  const configure = await client.callTool({ name: 'wallet_configure', arguments: { autoReceive: true } });
  assert.equal(configure.isError, true);
  assert.equal(configure.structuredContent.error.code, 'MCP_READ_ONLY', 'The actual stdio entry point must create an MCP-restricted session.');
  const pid = transport.pid;
  await client.close();
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  assert.doesNotMatch(stderr, /kotlin-logging: initializing/);
});

test('MCP exposes personal label CRUD without spending approval and enforces destination exclusivity', async t => {
  // Given an uninitialized read-only MCP profile with one saved public index.
  const directory = await mkdtemp(join(tmpdir(), 'atto-mcp-labels-'));
  const app = new AttoApplication({ directory, access: 'mcp', secrets: { get: async () => assert.fail('No credentials expected') } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const address = 'atto://aaswdsyo5pv2pigz3557r7pncks3duwvxpklr6sndcj4kdlcgxpfsowc2hsuk';
  app.store.set('settings', { ...app.store.get('settings'), network: 'LOCAL' });
  app.store.set('addresses', [{ index: 0, address, publicKey: 'unused', active: true }]);
  const client = await connected(app, t);
  const tools = (await client.listTools()).tools;
  for (const name of ['labels_set', 'labels_remove']) {
    assert.equal(tools.find(tool => tool.name === name).annotations.readOnlyHint, false);
    assert.equal(tools.find(tool => tool.name === name).annotations.openWorldHint, false);
    assert.equal(tools.find(tool => tool.name === name).annotations.idempotentHint, true);
  }
  assert.ok(tools.find(tool => tool.name === 'send').inputSchema.properties.destinationLabel);
  assert.ok(tools.find(tool => tool.name === 'doctor').inputSchema.properties.globalDirectory);

  // When managing labels and trying ambiguous send destinations through MCP.
  assert.equal((await client.callTool({ name: 'labels_set', arguments: { index: 0, label: ' Savings ' } })).isError, undefined);
  const shown = await client.callTool({ name: 'labels_get', arguments: { address } });
  assert.equal(shown.structuredContent.result.addressLabels[address].personal.label, 'Savings');
  assert.equal((await client.callTool({ name: 'labels_list', arguments: { search: 'SAV' } })).structuredContent.result.items.length, 1);
  for (const arguments_ of [{}, { destination: address, destinationLabel: 'Savings' }, { destinationIndex: 0, destinationLabel: 'Savings' }]) {
    assert.equal((await client.callTool({ name: 'send', arguments: { ...arguments_, amount: '1', requestId: 'invalid' } })).isError, true);
  }
  const denied = await client.callTool({ name: 'send', arguments: { destinationLabel: 'Savings', amount: '1', requestId: 'denied' } });
  // Then sending remains approval-gated and label removal remains available.
  assert.equal(denied.structuredContent.error.code, 'MCP_READ_ONLY');
  assert.equal((await client.callTool({ name: 'labels_remove', arguments: { index: 0 } })).isError, undefined);
  assert.equal(app.ledger.mcpAccess(), 'read-only');
});
