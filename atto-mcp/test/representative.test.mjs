import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { fixture } from '../../atto-cli/test/support/payments.mjs';

const serverUrl = process.env.ATTO_TEST_MCP_PACKAGE_DIR
  ? pathToFileURL(join(process.env.ATTO_TEST_MCP_PACKAGE_DIR, 'dist/server.js'))
  : new URL('../dist/server.js', import.meta.url);
const { createMcpServer } = await import(serverUrl.href);

test('representative changes distinguish an unchanged representative and preserve valid changes', { timeout: 20_000 }, async t => {
  // Given two opened accounts with the same representative and an approved MCP session.
  const f = await fixture(t, ['100', '10']);
  const server = createMcpServer(f.open('mcp'));
  const client = new Client({ name: 'atto-representative-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const change = args => client.callTool({ name: 'representative_change', arguments: args });

  // When the current representative is selected using both default and explicit indexes.
  for (const selector of [{}, { index: 1 }]) {
    const response = await change({ ...selector, representative: f.addresses[0].address });

    // Then rejection is specific and no work, signature publication, or chain change occurs.
    assert.equal(response.isError, true);
    assert.equal(response.structuredContent.error.code, 'REPRESENTATIVE_UNCHANGED');
    assert.match(response.structuredContent.error.message, /already/i);
  }
  assert.equal(f.state.works.length, 0);
  assert.equal(f.state.publicationAttempts.length, 0);
  for (const account of f.state.accounts.values()) assert.equal(account.height.toString(), '3');

  // When an unopened account is selected, then its existing domain error is preserved.
  const unopened = await change({ index: f.recipient.index, representative: f.addresses[0].address });
  assert.equal(unopened.structuredContent.error.code, 'ACCOUNT_NOT_OPEN');

  // When a different representative is selected, then exactly one valid change is published.
  const changed = await change({ representative: f.addresses[1].address });
  assert.equal(changed.isError, undefined, JSON.stringify(changed.structuredContent));
  assert.equal(changed.structuredContent.result.status, 'representative_changed');
  assert.equal(f.state.publications.length, 1);
  const account = f.state.accounts.get(f.addresses[0].publicKey);
  assert.equal(account.representativeAddress.value, f.addresses[1].address);
  assert.equal(account.balance.toString(), '100');
  const repeated = await change({ representative: f.addresses[1].address });
  assert.equal(repeated.structuredContent.error.code, 'REPRESENTATIVE_UNCHANGED');
  assert.equal(f.state.publications.length, 1);
});
