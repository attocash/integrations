import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { MarketplaceProfileStore } from '../dist/profile-store.js';

test('an MCP agent discovers its allowed types, replaces its selection and pauses its listener', async t => {
  const catalog = [
    { type: 'task.published', audience: 'PUBLIC', scope: null, controllerOnly: false },
    { type: 'service.milestone.submitted', audience: 'ACCOUNT', scope: 'services:read', controllerOnly: false },
    { type: 'task.dispute.opened', audience: 'ACCOUNT', scope: null, controllerOnly: true },
  ];
  const requests = [];
  const discovery = res => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ types: catalog }));
  let respond = discovery;
  const http = createServer((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization });
    respond(res);
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(() => new Promise(resolve => http.close(resolve)));

  const home = await mkdtemp(join(tmpdir(), 'marketplace-event-selection-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await MarketplaceProfileStore.open(home);
  store.createProfile({ id: 'main', origin: 'http://127.0.0.1:' + http.address().port,
    audience: 'events', accountId: '11111111-1111-4111-8111-111111111111', agentId: '22222222-2222-4222-8222-222222222222',
    identityId: '33333333-3333-4333-8333-333333333333', controllerNetwork: 'ATTO', controllerAddress: 'atto://' + 'a'.repeat(61),
    authMode: 'scoped-api-key', apiKey: 'test-read-only-key', apiScopes: ['services:read'] });
  const profile = store.getProfile('main');
  const client = new Client({ name: 'event-selection-test', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [join(import.meta.dirname, '../dist/main.js'), '--home', home], stderr: 'pipe' }));
    const call = (name, args = {}) => client.callTool({ name, arguments: args });
    const get = async () => (await call('marketplace_event_subscription_get')).structuredContent.result.types;
    const set = types => call('marketplace_event_subscription_set', { types });
    assert.deepEqual(await get(), []);
    const list = async args => (await call('marketplace_event_types_list', args)).structuredContent.result;
    assert.deepEqual(await list(), { available: { public: ['task.published'], 'services:read': ['service.milestone.submitted'] } });
    assert.deepEqual(await list({ prefix: 'service.milestone' }), { available: { 'services:read': ['service.milestone.submitted'] } });
    assert.deepEqual(await list({ prefix: 'task.dispute', includeUnavailable: true }), {
      available: {}, unavailable: { 'controller-session': ['task.dispute.opened'] },
    });
    const chosen = ['service.milestone.submitted', 'task.published'];
    assert.deepEqual((await set(chosen.toReversed())).structuredContent.result.types, chosen);
    assert.deepEqual(store.readSavedEventTypes(profile), chosen);
    assert.equal((await set(['task.dispute.opened'])).isError, true);
    assert.equal((await set(['unknown.event'])).isError, true);
    assert.deepEqual(await get(), chosen);
    // Both public catalog consumers must preserve the API failure and keep the old selection.
    for (const [status, code] of [[404, 'MARKETPLACE_HTTP'], [503, 'MARKETPLACE_HTTP'], [403, 'AUTHORIZATION_DENIED'], [200, 'MARKETPLACE_PROTOCOL']]) {
      respond = res => res.writeHead(status).end('private upstream diagnostic');
      for (const failure of [await call('marketplace_event_types_list'), await set(['task.published'])]) {
        assert.equal(failure.isError, true);
        assert.equal(failure.structuredContent.error.code, code);
        assert.equal(failure.structuredContent.error.httpStatus, status);
        assert.doesNotMatch(JSON.stringify(failure), /private upstream diagnostic/);
      }
      assert.deepEqual(await get(), chosen);
    }
    respond = discovery;
    assert.deepEqual((await set([])).structuredContent.result.types, []);
    assert.deepEqual(store.readSavedEventTypes(profile), []);
    const db = new DatabaseSync(join(home, 'profiles.sqlite'));
    try {
      for (const invalid of ['{', '{}', '["bad event name"]']) {
        db.prepare('UPDATE event_preferences SET types=? WHERE profile_id=?').run(invalid, 'main');
        assert.equal((await call('marketplace_event_subscription_get')).structuredContent.error.code, 'EVENT_SUBSCRIPTION');
      }
    } finally { db.close(); }
    assert.deepEqual((await set(chosen)).structuredContent.result.types, chosen);

    assert.ok(requests.every(req => req.path === '/v1/discovery/event-types' && req.authorization === undefined));
  } finally {
    await client.close();
    store.close();
  }
});
