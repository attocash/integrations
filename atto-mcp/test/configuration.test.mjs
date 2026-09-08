import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { fixture, gate, until } from '../../atto-cli/test/support/payments.mjs';

const serverUrl = process.env.ATTO_TEST_MCP_PACKAGE_DIR
  ? pathToFileURL(join(process.env.ATTO_TEST_MCP_PACKAGE_DIR, 'dist/server.js'))
  : new URL('../dist/server.js', import.meta.url);
const { createMcpServer } = await import(serverUrl.href);

async function wallet(t, onReceiveProgress) {
  let phrase;
  const credential = { available: true, reads: 0, hold: undefined, waiting: false };
  t.after(() => credential.hold?.release());
  const f = await fixture(t, ['100', '10'], { indexes: [0], consolidate: false }, '100', undefined, {
    secrets: {
      async get() {
        credential.reads++;
        if (credential.hold) {
          credential.waiting = true;
          await credential.hold.promise;
          credential.waiting = false;
        }
        return credential.available ? phrase ?? null : null;
      },
      async set(value) { phrase = value; },
    },
    onReceiveProgress: event => onReceiveProgress?.(event, credential),
  });
  await f.app.call('address_activate', { index: 1 });
  const app = f.open('mcp');
  const server = createMcpServer(app);
  const client = new Client({ name: 'atto-configuration-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); phrase = undefined; });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.equal(response.isError, undefined, JSON.stringify({ response: response.structuredContent,
      pending: [...f.state.receivables.keys()], requests: f.state.requests.map(request => request.path) }));
    return response.structuredContent.result;
  };
  const send = () => ({ destination: f.addresses[1].address, amount: '0.000000001', requestId: randomUUID() });
  return { ...f, app, client, call, send, credential };
}

for (const receiver of ['idle', 'busy', 'reading credential']) {
  test(`same-network configuration preserves sending with receiver ${receiver}`, { timeout: 20_000 }, async t => {
    // Given an approved MCP wallet and a published payment to its second active account.
    const f = await wallet(t, (event, credential) => {
      if (receiver === 'reading credential' && event.event === 'receiving') {
        credential.hold = gate();
      }
    });
    let release;
    // Release account contention before the fixture closes its sessions.
    try {
      if (receiver === 'busy') release = f.app.store.tryAccountLocks([1]);
      if (receiver === 'busy') assert.equal(typeof release, 'function');
      await f.call('wallet_configure', { autoReceive: true });
      if (receiver !== 'idle') await f.app.start();
      const first = await f.call('send', f.send());
      if (receiver === 'busy') await until(async () => (await f.call('wallet_status')).autoReceive.lastError?.code === 'WALLET_BUSY');
      if (receiver === 'reading credential') await until(() => f.credential.waiting);
      const before = await f.call('wallet_status');
      const reads = f.credential.reads;

      // When every current setting is supplied again, changing only automatic receiving.
      await f.call('wallet_configure', { ...before.settings, autoReceive: false });
      const after = await f.call('wallet_status');

      // Then public identity and credential access survive, including omitted source and unit.
      assert.equal(after.initialized, true);
      assert.deepEqual(after.identity, before.identity);
      assert.deepEqual(after.addresses, before.addresses);
      assert.deepEqual(after.settings, { ...before.settings, autoReceive: false });
      assert.equal(after.mcpAccess, 'spend');
      assert.deepEqual(after.pendingSends, []);
      assert.equal(f.credential.reads, reads, 'Configuration and status must not read credentials.');
      f.credential.hold?.release();
      const sent = await f.call('send', f.send());
      release?.();
      release = undefined;
      if (receiver !== 'idle') await until(async () => !(await f.call('wallet_status')).autoReceive.running);
      assert.notEqual(sent.hash, first.hash);
      assert.equal(sent.status, 'published');
      assert.equal(f.state.publications.length, 2, 'Disabling automatic receiving leaves both payments pending.');
      await f.call('receive', { index: 1, hash: first.hash });
      assert.equal(f.state.receivables.has(sent.hash), true);
      await f.call('receive', { index: 1, hash: sent.hash });
      assert.equal((await f.call('balances_get')).total.raw, '110');
      assert.equal(f.state.receivables.size, 0);
    } finally { release?.(); f.credential.hold?.release(); }
  });
}

test('an initialized wallet reports missing credentials without claiming it needs onboarding', { timeout: 20_000 }, async t => {
  // Given a working initialized wallet whose external credential lookup later returns empty.
  const f = await wallet(t);
  await f.call('send', f.send());
  const before = await f.call('wallet_status');
  await f.call('wallet_configure', { ...before.settings, autoReceive: false });
  f.credential.available = false;

  // When a new payment reaches signing with the default source selection and ATTO unit.
  const failed = await f.client.callTool({ name: 'send', arguments: f.send() });
  const status = await f.call('wallet_status');

  // Then it explains credential access, preserves wallet identity, and publishes nothing further.
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.error.code, 'WALLET_CREDENTIAL_MISSING');
  assert.match(failed.structuredContent.error.message, /doctor/i);
  assert.doesNotMatch(failed.structuredContent.error.message, /create or import/i);
  assert.equal(status.initialized, true);
  assert.deepEqual(status.identity, before.identity);
  assert.equal(f.state.publications.length, 1);

  // When credential access returns, a fresh request succeeds in the same MCP session.
  f.credential.available = true;
  assert.equal((await f.call('send', f.send())).status, 'published');
  assert.equal(f.state.publications.length, 2);
});
