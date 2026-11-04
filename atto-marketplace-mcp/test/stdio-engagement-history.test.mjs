import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MarketplaceProfileStore } from '../dist/profile-store.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const identityId = '33333333-3333-4333-8333-333333333333';
const serverMain = join(import.meta.dirname, '../dist/main.js');

const activeBuyer = {
  taskId: '44444444-4444-4444-8444-444444444444',
  title: 'Buyer-side active contract',
  role: 'BUYER',
  counterpartyHandle: 'worker-one',
  counterpartyDisplayName: 'Worker One',
  asset: 'ATTO',
  grossAtomic: '1000000000',
  feeAtomic: '10000000',
  workerNetAtomic: '990000000',
  feeRateBasisPoints: 100,
  state: 'ACTIVE',
  version: 2,
  createdAt: '2026-10-08T08:00:00Z',
};

const completedWorker = {
  taskId: '55555555-5555-4555-8555-555555555555',
  title: 'Worker-side completed contract',
  role: 'WORKER',
  counterpartyHandle: null,
  counterpartyDisplayName: 'Buyer Two',
  asset: 'XNO',
  grossAtomic: '1000',
  feeAtomic: '10',
  workerNetAtomic: '990',
  feeRateBasisPoints: 100,
  state: 'COMPLETED',
  version: 5,
  createdAt: '2026-10-07T08:00:00Z',
};

test('marketplace_engagements_list publishes only page inputs and preserves both role histories across cursor pages', async () => {
  // Given an account with a scoped tasks:read profile and a Marketplace API returning two account-scoped pages.
  const nextCursor = 'opaque-cursor_1';
  const firstPage = { items: [activeBuyer], nextCursor };
  const secondPage = { items: [completedWorker], nextCursor: null };
  const requests = [];
  const http = await listen(async (req, res) => {
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
    const url = new URL(req.url ?? '/', 'http://marketplace.test');
    if (req.method !== 'GET' || url.pathname !== '/v1/agent/engagements') return json(res, 404, {});
    if (url.searchParams.get('cursor') === null) return json(res, 200, firstPage);
    if (url.searchParams.get('cursor') === nextCursor) return json(res, 200, secondPage);
    return json(res, 400, { error: 'invalid_workspace_query' });
  });
  const fixture = await profileHome({ origin: http.origin, apiScopes: ['tasks:read'] });
  const client = await connect(fixture.home);

  try {
    // When an MCP client inspects and calls the named tool through stdio.
    const catalog = await client.listTools();
    const tool = catalog.tools.find((entry) => entry.name === 'marketplace_engagements_list');
    assert.ok(tool);
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['cursor', 'limit']);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.inputSchema.properties.limit.type, 'integer');
    assert.equal(tool.inputSchema.properties.limit.default, 25);
    assert.equal(tool.inputSchema.properties.limit.minimum, 1);
    assert.equal(tool.inputSchema.properties.limit.maximum, 100);
    assert.equal(tool.inputSchema.properties.cursor.type, 'string');
    assert.equal(tool.inputSchema.properties.cursor.minLength, 1);
    assert.equal(tool.inputSchema.properties.cursor.maxLength, 512);
    assert.equal(tool.annotations.readOnlyHint, true);

    const defaultPage = await client.callTool({ name: 'marketplace_engagements_list', arguments: {} });
    const nextPage = await client.callTool({
      name: 'marketplace_engagements_list', arguments: { limit: 3, cursor: nextCursor },
    });

    // Then Marketplace's role labels, active/completed states, amounts, nullable fields, and page cursor reach the caller unchanged.
    assert.equal(defaultPage.isError, undefined);
    assert.deepEqual(JSON.parse(contentText(defaultPage)).result, firstPage);
    assert.equal(nextPage.isError, undefined);
    assert.deepEqual(JSON.parse(contentText(nextPage)).result, secondPage);
    assert.deepEqual(requests.map((request) => request.path), [
      '/v1/agent/engagements?limit=25',
      `/v1/agent/engagements?limit=3&cursor=${nextCursor}`,
    ]);
    assert.deepEqual(requests.map((request) => request.authorization), [
      'Bearer scoped-engagement-read-key', 'Bearer scoped-engagement-read-key',
    ]);
    for (const request of requests) {
      const url = new URL(request.path, 'http://marketplace.test');
      assert.deepEqual([...url.searchParams.keys()], url.searchParams.has('cursor') ? ['limit', 'cursor'] : ['limit']);
      assert.equal(url.searchParams.has('accountId'), false);
      assert.equal(url.searchParams.has('status'), false);
      assert.equal(url.searchParams.has('role'), false);
    }

    // Unknown selectors and malformed page inputs fail at the MCP boundary without reaching Marketplace.
    for (const arguments_ of [
      { accountId }, { status: 'ACTIVE' }, { role: 'BUYER' },
      { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: '' }, { cursor: 'x'.repeat(513) },
    ]) {
      const rejected = await client.callTool({ name: 'marketplace_engagements_list', arguments: arguments_ });
      assert.equal(rejected.isError, true, JSON.stringify(arguments_));
    }
    assert.equal(requests.length, 2);
  } finally {
    await close(client, http, fixture);
  }
});

test('engagement history passes through empty pages and Marketplace cursor errors', async () => {
  // Given a Marketplace endpoint that returns safe cursor-validation codes and may return arbitrary unknown errors.
  const requests = [];
  const http = await listen(async (req, res) => {
    requests.push(req.url);
    const url = new URL(req.url ?? '/', 'http://marketplace.test');
    if (url.pathname !== '/v1/agent/engagements') return json(res, 404, {});
    if (url.searchParams.get('cursor') === 'fixture-nonparticipant') {
      return json(res, 200, { items: [], nextCursor: null });
    }
    if (url.searchParams.get('cursor') === 'fixture-other-account-cursor') {
      return json(res, 400, { error: 'invalid_workspace_query',
        message: 'The engagement cursor is invalid or belongs to a different account.' });
    }
    if (url.searchParams.get('cursor') === 'malformed-cursor-with-secret') {
      return json(res, 400, { error: 'invalid_workspace_query',
        message: 'Invalid cursor for account 11111111-1111-4111-8111-111111111111 using bearer refresh-token-secret.' });
    }
    if (url.searchParams.get('cursor') === 'unknown-server-error') {
      return json(res, 400, { error: 'unbounded_internal_error',
        message: 'account 11111111-1111-4111-8111-111111111111 token secret-token cursor secret-cursor' });
    }
    return json(res, 404, {});
  });
  const fixture = await profileHome({ origin: http.origin, apiScopes: ['tasks:read'] });
  const client = await connect(fixture.home);

  try {
    // When the MCP client requests an empty page, cross-account and malformed cursors, and an unknown server error.
    const emptyPage = await client.callTool({
      name: 'marketplace_engagements_list', arguments: { cursor: 'fixture-nonparticipant' },
    });
    const foreignCursor = await client.callTool({
      name: 'marketplace_engagements_list', arguments: { cursor: 'fixture-other-account-cursor' },
    });
    const malformedCursor = await client.callTool({
      name: 'marketplace_engagements_list', arguments: { cursor: 'malformed-cursor-with-secret' },
    });
    const unknownError = await client.callTool({
      name: 'marketplace_engagements_list', arguments: { cursor: 'unknown-server-error' },
    });

    // Then cursor failures include bounded restart guidance while unknown server details stay hidden.
    assert.equal(emptyPage.isError, undefined);
    assert.deepEqual(JSON.parse(contentText(emptyPage)).result, { items: [], nextCursor: null });
    for (const rejected of [foreignCursor, malformedCursor]) {
      assert.equal(rejected.isError, true);
      assert.equal(rejected.structuredContent.error.code, 'INVALID_WORKSPACE_QUERY');
      assert.equal(rejected.structuredContent.error.httpStatus, 400);
      assert.deepEqual(rejected.structuredContent.error.details, {
        serverCode: 'invalid_workspace_query',
        recovery: { action: 'restart-pagination', scope: 'current-account' },
      });
      assert.match(contentText(rejected), /restart pagination.*current account/i);
      assert.equal(JSON.stringify(rejected).includes('11111111-1111-4111-8111-111111111111'), false);
      assert.equal(JSON.stringify(rejected).includes('refresh-token-secret'), false);
      assert.equal(JSON.stringify(rejected).includes('malformed-cursor-with-secret'), false);
      assert.equal(JSON.stringify(rejected).includes('fixture-other-account-cursor'), false);
    }
    assert.equal(unknownError.isError, true);
    assert.equal(unknownError.structuredContent.error.code, 'MARKETPLACE_HTTP');
    assert.equal(unknownError.structuredContent.error.httpStatus, 400);
    assert.equal(JSON.stringify(unknownError).includes('unbounded_internal_error'), false);
    assert.equal(JSON.stringify(unknownError).includes('secret-token'), false);
    assert.equal(JSON.stringify(unknownError).includes('secret-cursor'), false);
    assert.deepEqual(requests, [
      '/v1/agent/engagements?limit=25&cursor=fixture-nonparticipant',
      '/v1/agent/engagements?limit=25&cursor=fixture-other-account-cursor',
      '/v1/agent/engagements?limit=25&cursor=malformed-cursor-with-secret',
      '/v1/agent/engagements?limit=25&cursor=unknown-server-error',
    ]);
  } finally {
    await close(client, http, fixture);
  }
});

test('marketplace_engagements_list requires tasks:read before making an HTTP request', async () => {
  let requests = 0;
  const http = await listen(async (_req, res) => { requests++; json(res, 500, {}); });
  const fixture = await profileHome({ origin: http.origin, apiScopes: ['applications:read'] });
  const client = await connect(fixture.home);

  try {
    const denied = await client.callTool({ name: 'marketplace_engagements_list', arguments: {} });
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent.error.code, 'SCOPE_REQUIRED');
    assert.equal(requests, 0);
  } finally {
    await close(client, http, fixture);
  }
});

async function profileHome({ origin, apiScopes }) {
  const home = await mkdtemp(join(tmpdir(), 'atto-marketplace-mcp-engagement-history-'));
  const store = await MarketplaceProfileStore.open(home);
  store.createProfile({
    id: 'agent', origin, audience: 'marketplace', accountId, agentId, identityId,
    controllerNetwork: 'ATTO', controllerAddress: `atto://${'a'.repeat(61)}`,
    authMode: 'scoped-api-key', apiKey: 'scoped-engagement-read-key', apiScopes,
    applyAttoLimit: null, applyXnoLimit: null,
  });
  return { home, store };
}

async function connect(home) {
  const client = new Client({ name: 'test-marketplace-engagement-history', version: '1.0.0' });
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    typeof value === 'string' && key !== 'NODE_TEST_CONTEXT' && !key.startsWith('NODE_TEST_')));
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [serverMain, '--profile', 'agent', '--home', home],
    env: environment,
    stderr: 'pipe',
  }));
  return client;
}

async function listen(handler) {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(() => {
      if (!res.destroyed) json(res, 500, {});
    });
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return Object.assign(server, { origin: `http://127.0.0.1:${address.port}` });
}

async function close(client, http, fixture) {
  await client.close();
  await new Promise((resolve) => http.close(resolve));
  fixture.store.close();
  await rm(fixture.home, { recursive: true, force: true });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function contentText(result) {
  return result.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? '';
}
