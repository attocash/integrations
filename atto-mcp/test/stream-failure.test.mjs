import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../../atto-cli/', import.meta.url));
const mcpDirectory = process.env.ATTO_TEST_MCP_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const { AttoApplication } = await import(pathToFileURL(join(cliDirectory, 'dist/application/app.js')).href);
const account = JSON.stringify({ publicKey: '11'.repeat(32), network: 'LOCAL', version: 0, algorithm: 'V1', height: 1,
  balance: 100, lastTransactionHash: '22'.repeat(32), lastTransactionTimestamp: 1704616009211,
  representativeAlgorithm: 'V1', representativePublicKey: '33'.repeat(32) });

test('a failed node connection is reported by the watch and reconnects without terminating MCP', { timeout: 8000 }, async t => {
  // Given: an actual MCP subprocess with an empty read-only profile and a node
  // that drops the first connection before sending headers, then serves events.
  const directory = await mkdtemp(join(tmpdir(), 'atto-mcp-stream-failure-'));
  let requests = 0;
  const http = createServer((request, response) => {
    if (++requests === 1) { request.socket.destroy(); return; }
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.write(account + '\n');
  });
  const client = new Client({ name: 'atto-stream-failure-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const local = new AttoApplication({ directory });
  try { await local.configure({ network: 'LOCAL', nodeUrl: `http://127.0.0.1:${http.address().port}`, autoReceive: false }); }
  finally { await local.close(); }
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(mcpDirectory, 'dist/main.js'), '--data-dir', directory], stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', data => { stderr += data.toString(); });
  await client.connect(transport);

  // When: the watch encounters a real fetch failure before HTTP headers arrive.
  const started = await client.callTool({ name: 'watch_start', arguments: { event: 'account', networkWide: true } });
  assert.equal(started.isError, undefined);
  const id = started.structuredContent.result.id;
  const deadline = performance.now() + 5000;
  let observedError = false;
  let received = false;
  while (!received) {
    assert.ok(performance.now() < deadline, `Watch did not recover. Server stderr: ${stderr}`);
    const result = await client.callTool({ name: 'watch_read', arguments: { id } });
    assert.equal(result.isError, undefined);
    const watch = result.structuredContent.result;
    if (watch.lastError) {
      assert.equal(watch.lastError.code, 'NODE_STREAM_ERROR');
      observedError = true;
    }
    received = watch.events.some(event => event.data.publicKey === '11'.repeat(32));
    if (!received) await delay(20);
  }

  // Then: the existing MCP connection still serves tools and the watch recovered.
  assert.equal(observedError, true);
  assert.equal(requests, 2);
  const status = await client.callTool({ name: 'wallet_status', arguments: {} });
  assert.equal(status.isError, undefined);
  assert.equal(status.structuredContent.result.mcpAccess, 'read-only');
  assert.equal((await client.callTool({ name: 'watch_stop', arguments: { id } })).isError, undefined);
  assert.doesNotMatch(stderr, /Fail to fetch|Uncaught|fetch failed/);
});
