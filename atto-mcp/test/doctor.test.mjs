import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { check, doctorFixture, filesSnapshot, moduleUrl } from '../../atto-cli/test/support/doctor.mjs';

const mcpDirectory = process.env.ATTO_TEST_MCP_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const main = join(mcpDirectory, 'dist/main.js');
const { AttoApplication } = await import(moduleUrl('application/app.js'));

test('MCP doctor diagnoses its actual launch environment in read-only mode and returns failures as reports', { skip: process.platform !== 'linux', timeout: 20_000 }, async t => {
  // Given a usable terminal environment and an MCP launch with a failing synthetic keyring.
  const f = await doctorFixture(t);
  const terminal = await f.run(['--json', 'doctor'], {}, main);
  assert.equal(terminal.code, 0, terminal.stdout + terminal.stderr);
  assert.equal(terminal.report.context.interface, 'mcp');
  assert.ok(terminal.report.context.mcpVersion);
  assert.equal(check(terminal.report, 'wallet.mcpAccess').code, 'MCP_READ_ONLY');
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [main, '--data-dir', f.directory], env: { ...f.env, ATTO_FAKE_MODE: 'failure' }, stderr: 'pipe' });
  const client = new Client({ name: 'atto-doctor-test', version: '1.0.0' });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  const doctor = tools.tools.find(tool => tool.name === 'doctor');
  assert.equal(doctor.annotations.readOnlyHint, true);
  assert.equal(doctor.annotations.destructiveHint, false);
  const status = (await client.callTool({ name: 'wallet_status', arguments: {} })).structuredContent.result;
  assert.equal(status.mcpAccess, 'read-only');
  assert.equal(status.autoReceive.running, false);
  const before = await filesSnapshot(f.directory);

  // When the tool is called, its own keyring access fails but other probes complete.
  const result = await client.callTool({ name: 'doctor', arguments: {} });
  const report = result.structuredContent.result;

  // Then the failed diagnostic is a valid result, and no approval or receiver starts.
  assert.equal(result.isError, undefined);
  assert.equal(report.status, 'fail');
  assert.equal(check(report, 'keyring.credential').code, 'KEYRING_UNAVAILABLE');
  assert.equal(check(report, 'worker.work').status, 'pass');
  assert.equal(check(report, 'node.stream').status, 'pass');
  assert.equal(check(report, 'wallet.mcpAccess').code, 'MCP_READ_ONLY');
  assert.equal(report.context.directory, f.directory);
  assert.equal(report.context.mcpVersion, terminal.report.context.mcpVersion);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.deepEqual(await filesSnapshot(f.directory), before);
  const after = (await client.callTool({ name: 'wallet_status', arguments: {} })).structuredContent.result;
  assert.equal(after.mcpAccess, 'read-only');
  assert.equal(after.autoReceive.running, false);
  const invalid = await client.callTool({ name: 'doctor', arguments: { fix: true } });
  assert.equal(invalid.isError, true);
  assert.ok(!stderr.includes('synthetic-private-keyring-diagnostic'));
});

test('Closing an MCP application cancels outstanding doctor work without waiting for probe deadlines', { timeout: 10_000 }, async t => {
  const f = await doctorFixture(t);
  f.state.worker = 'hang';
  f.state.time = 'hang';
  const previousPath = process.env.PATH;
  process.env.PATH = join(f.directory, 'absent-bin');
  t.after(() => { process.env.PATH = previousPath; });
  if (process.platform !== 'linux') return;
  const app = new AttoApplication({ directory: f.directory, access: 'mcp' });
  t.after(() => app.close());
  const pending = app.call('doctor');
  const deadline = Date.now() + 3000;
  while (!f.state.works.length) { assert.ok(Date.now() < deadline); await delay(10); }
  const started = Date.now();
  await app.close();
  const report = await pending;
  assert.ok(Date.now() - started < 1500);
  assert.equal(check(report, 'worker.work').code, 'CHECK_TIMEOUT');
  assert.equal(check(report, 'node.time').code, 'CHECK_TIMEOUT');
});
