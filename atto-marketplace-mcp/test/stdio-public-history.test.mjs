import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MarketplaceApiClient } from '../dist/marketplace-api.js';
import { MarketplaceProfileStore } from '../dist/profile-store.js';
import { signedReceipt } from './support/work-receipt.mjs';

const accountId = '11111111-1111-4111-8111-111111111111';
const buyerAgentId = '22222222-2222-4222-8222-222222222222';
const workerAgentId = '33333333-3333-4333-8333-333333333333';
const identityId = '44444444-4444-4444-8444-444444444444';
const taskId = '77777777-7777-4777-8777-777777777777';
const missingTaskId = '88888888-8888-4888-8888-888888888888';
const serverMain = join(import.meta.dirname, '../dist/main.js');

test('marketplace_tasks_history_search sends strict anonymous filters and validates the public projection', async () => {
  // Given an anonymous history endpoint with published terminal tasks and exact public participant summaries.
  const { receipt } = signedReceipt();
  const page = publicHistoryPage(receipt);
  const xnoPage = structuredClone(page);
  for (const item of xnoPage.items) item.task.asset = 'XNO';
  const requests = [];
  const http = await listen(async (req, res) => {
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
    const url = new URL(req.url ?? '/', 'http://marketplace.test');
    if (url.pathname !== '/v1/discovery/task-history') return json(res, 404, { error: 'not found' });
    if (url.searchParams.get('cursor') === 'cursor-bound-to-other-filters') {
      return json(res, 400, { error: 'invalid_discovery_query',
        message: 'cursor belongs to account 11111111-1111-4111-8111-111111111111 and token private-refresh-secret' });
    }
    if (url.searchParams.get('asset') === 'XNO') return json(res, 200, xnoPage);
    if (url.searchParams.get('q') === 'unsafe') {
      const unsafe = structuredClone(page);
      unsafe.items[0].task.applicationId = 'private-application-id';
      return json(res, 200, unsafe);
    }
    return json(res, 200, page);
  });
  const fixture = await profileHome(http.origin);
  const client = await connect(fixture.home);

  try {
    // When an MCP client inspects the strict filter contract and requests default, filtered, and malformed pages.
    const catalog = await client.listTools();
    const tool = catalog.tools.find((entry) => entry.name === 'marketplace_tasks_history_search');
    assert.ok(tool);
    assert.equal(tool.annotations.readOnlyHint, true);
    const alternatives = tool.inputSchema.anyOf ?? tool.inputSchema.oneOf;
    assert.equal(alternatives.length, 2);
    assert.ok(alternatives.every((schema) => schema.additionalProperties === false));
    assert.ok(alternatives.some((schema) => schema.required?.includes('agentId')
      && schema.properties.role.enum.includes('BUYER') && schema.properties.role.enum.includes('WORKER')));
    assert.ok(alternatives.some((schema) => !schema.required?.includes('agentId')
      && schema.properties.role.not !== undefined));

    const defaultPage = await client.callTool({ name: 'marketplace_tasks_history_search', arguments: {} });
    const filteredPage = await client.callTool({ name: 'marketplace_tasks_history_search', arguments: {
      limit: 7, asset: 'XNO', q: 'contracts', agentId: workerAgentId, role: 'WORKER', state: 'COMPLETED',
    } });
    const roleWithoutAgent = await client.callTool({ name: 'marketplace_tasks_history_search', arguments: { role: 'BUYER' } });
    const unknownFilter = await client.callTool({ name: 'marketplace_tasks_history_search', arguments: { accountId } });
    const malformedAgent = await client.callTool({ name: 'marketplace_tasks_history_search', arguments: { agentId: 'not-a-public-id' } });
    const malformedQuery = await client.callTool({ name: 'marketplace_tasks_history_search', arguments: { q: 'bad\u0000query' } });
    const oversizedQuery = await client.callTool({ name: 'marketplace_tasks_history_search', arguments: { q: '🧭'.repeat(121) } });
    const activeState = await client.callTool({ name: 'marketplace_tasks_history_search', arguments: { state: 'CLOSED' } });
    const oversizedCursor = await client.callTool({ name: 'marketplace_tasks_history_search', arguments: { cursor: 'x'.repeat(513) } });
    const mismatchedCursor = await client.callTool({ name: 'marketplace_tasks_history_search', arguments: {
      cursor: 'cursor-bound-to-other-filters', state: 'REFUNDED',
    } });
    const unsafeProjection = await client.callTool({ name: 'marketplace_tasks_history_search', arguments: { q: 'unsafe' } });

    // Then only public fields pass validation, every request is unauthenticated GET, and filter-bound cursors give fixed restart guidance.
    assert.equal(defaultPage.isError, undefined);
    assert.deepEqual(JSON.parse(contentText(defaultPage)).result, page);
    assert.equal(filteredPage.isError, undefined);
    assert.deepEqual(JSON.parse(contentText(filteredPage)).result, xnoPage);
    const filteredUrl = new URL(requests[1].path, 'http://marketplace.test');
    assert.equal(filteredUrl.pathname, '/v1/discovery/task-history');
    assert.deepEqual(Object.fromEntries(filteredUrl.searchParams), {
      limit: '7', asset: 'XNO', q: 'contracts', agentId: workerAgentId, role: 'WORKER', state: 'COMPLETED',
    });
    assert.equal(new URL(requests[0].path, 'http://marketplace.test').search, '?limit=24');
    for (const item of JSON.parse(contentText(defaultPage)).result.items) {
      assert.deepEqual(Object.keys(item).sort(), ['receipt', 'task', 'worker']);
      assert.deepEqual(Object.keys(item.task).sort(), [
        'acceptanceTerms', 'applicationClosesAt', 'asset', 'closedAt', 'description', 'deliverable', 'dueAt',
        'feeAtomic', 'feeRateBasisPoints', 'funded', 'grossAtomic', 'taskId', 'publishedAt', 'requesterAgentId',
        'requesterDisplayName', 'requesterHandle', 'state', 'title', 'version', 'workerNetAtomic',
      ].sort());
      if (item.worker) assert.deepEqual(Object.keys(item.worker).sort(), ['agentId', 'displayName', 'handle']);
      if (item.receipt) assert.deepEqual(Object.keys(item.receipt).sort(), ['createdAt', 'outcome', 'receiptId']);
    }
    assert.deepEqual(JSON.parse(contentText(defaultPage)).result.items[1].worker, null);
    assert.deepEqual(JSON.parse(contentText(defaultPage)).result.items[1].receipt, null);
    for (const rejected of [roleWithoutAgent, unknownFilter, malformedAgent, malformedQuery, oversizedQuery, activeState, oversizedCursor]) {
      assert.equal(rejected.isError, true);
    }
    assert.equal(mismatchedCursor.structuredContent.error.code, 'INVALID_PUBLIC_HISTORY_QUERY');
    assert.equal(mismatchedCursor.structuredContent.error.httpStatus, 400);
    assert.deepEqual(mismatchedCursor.structuredContent.error.details, {
      serverCode: 'invalid_discovery_query',
      recovery: { action: 'restart-pagination', scope: 'current-filters' },
    });
    assert.match(contentText(mismatchedCursor), /restart from the first page.*current filters/i);
    assert.equal(JSON.stringify(mismatchedCursor).includes('private-refresh-secret'), false);
    assert.equal(JSON.stringify(mismatchedCursor).includes(accountId), false);
    assert.equal(JSON.stringify(mismatchedCursor).includes('cursor-bound-to-other-filters'), false);
    assert.equal(unsafeProjection.isError, true);
    assert.equal(unsafeProjection.structuredContent.error.code, 'MARKETPLACE_PROTOCOL');
    assert.equal(JSON.stringify(unsafeProjection).includes('private-application-id'), false);
    assert.ok(requests.every((request) => request.method === 'GET' && request.authorization === undefined));
    assert.equal(requests.length, 4);
  } finally {
    await close(client, http, fixture);
  }
});

test('oversized public history pages give a bounded smaller-page retry without widening the reader', async () => {
  // Given a valid public-history page that exceeds the generic byte cap and a smaller page for the same cursor.
  const { receipt } = signedReceipt();
  const base = publicHistoryPage(receipt).items[0];
  const oversized = {
    items: Array.from({ length: 30 }, (_, index) => ({
      ...structuredClone(base),
      task: {
        ...base.task,
        taskId: `77777777-7777-4777-8777-${String(index + 1).padStart(12, '0')}`,
        description: 'd'.repeat(20_000),
        deliverable: 'w'.repeat(8_000),
        acceptanceTerms: 'a'.repeat(8_000),
      },
      receipt: null,
    })),
    nextCursor: 'opaque-next-cursor',
  };
  const small = { items: [base], nextCursor: 'opaque-next-cursor' };
  const maximumSingleItemPage = {
    items: [{ ...structuredClone(base), task: { ...base.task, title: 't'.repeat(160),
      description: 'd'.repeat(20_000), deliverable: 'w'.repeat(8_000),
      acceptanceTerms: 'a'.repeat(8_000) } }],
    nextCursor: null,
  };
  assert.ok(Buffer.byteLength(JSON.stringify(maximumSingleItemPage)) < 1_048_576);
  assert.ok(oversized.items.length <= 100);
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > 1_048_576);
  const requests = [];
  const http = await listen(async (req, res) => {
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
    const url = new URL(req.url ?? '/', 'http://marketplace.test');
    if (url.pathname === '/v1/discovery/task-history' && req.method === 'GET' && url.searchParams.get('limit') === '1') {
      return json(res, 200, small);
    }
    if (url.pathname === '/v1/discovery/task-history' || url.pathname === '/v1/discovery/agents') {
      return json(res, 200, oversized);
    }
    return json(res, 404, { error: 'not found' });
  });
  const fixture = await profileHome(http.origin);
  const client = await connect(fixture.home);

  try {
    // When the same filters and cursor are retried with limit 1 after the page exceeds the response cap.
    const filters = { asset: 'XNO', q: 'contracts', cursor: 'opaque-current-cursor' };
    const tooLarge = await client.callTool({ name: 'marketplace_tasks_history_search', arguments: { ...filters, limit: 100 } });
    assert.equal(tooLarge.isError, true);
    assert.equal(tooLarge.structuredContent.error.code, 'PUBLIC_HISTORY_PAGE_TOO_LARGE');
    assert.deepEqual(tooLarge.structuredContent.error.details, {
      recovery: { action: 'retry-page', scope: 'current-filters', limit: 1 },
    });
    assert.match(contentText(tooLarge), /same filters and cursor with limit:1/i);
    assert.equal(JSON.stringify(tooLarge).includes('opaque-current-cursor'), false);

    const retried = await client.callTool({ name: 'marketplace_tasks_history_search', arguments: { ...filters, limit: 1 } });
    assert.equal(retried.isError, undefined);
    assert.deepEqual(JSON.parse(contentText(retried)).result, small);
    assert.deepEqual(requests.slice(0, 2).map((request) => request.method), ['GET', 'GET']);
    const first = new URL(requests[0].path, 'http://marketplace.test');
    const second = new URL(requests[1].path, 'http://marketplace.test');
    assert.equal(first.pathname, '/v1/discovery/task-history');
    assert.equal(second.pathname, first.pathname);
    for (const key of ['asset', 'q', 'cursor']) assert.equal(second.searchParams.get(key), first.searchParams.get(key));
    assert.equal(second.searchParams.get('limit'), '1');

    // Then an oversized body on a non-history route remains the generic bounded protocol error.
    const api = new MarketplaceApiClient(fixture.store, 'agent');
    await assert.rejects(api.request('/v1/discovery/agents', { auth: 'none' }), (error) => {
      assert.equal(error.code, 'MARKETPLACE_PROTOCOL');
      assert.doesNotMatch(error.message, /retry|limit:1/i);
      return true;
    });
    assert.equal(requests[2].method, 'GET');
    assert.equal(new URL(requests[2].path, 'http://marketplace.test').pathname, '/v1/discovery/agents');

    // The actionable branch also requires an effective GET, not merely the route pathname.
    await assert.rejects(api.request('/v1/discovery/task-history', { auth: 'none', method: 'POST' }), (error) => {
      assert.equal(error.code, 'MARKETPLACE_PROTOCOL');
      assert.doesNotMatch(error.message, /retry|limit:1/i);
      return true;
    });
    assert.equal(requests[3].method, 'POST');
    assert.equal(new URL(requests[3].path, 'http://marketplace.test').pathname, '/v1/discovery/task-history');
    assert.ok(requests.every((request) => request.authorization === undefined));
  } finally {
    await close(client, http, fixture);
  }
});

test('marketplace_public_receipt_get verifies a public signature without participant authorization', async () => {
  // Given the anonymous public receipt route, the pinned public key route, and receipt failures.
  const { receipt, key } = signedReceipt();
  let successfulReceiptReads = 0;
  const requests = [];
  const http = await listen(async (req, res) => {
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
    const url = new URL(req.url ?? '/', 'http://marketplace.test');
    if (url.pathname === `/v1/tasks/${taskId}/receipt`) {
      successfulReceiptReads++;
      if (successfulReceiptReads === 2) {
        return json(res, 200, { ...receipt, signatureBase64: Buffer.alloc(64, 1).toString('base64') });
      }
      return json(res, 200, receipt);
    }
    if (url.pathname === `/v1/tasks/${missingTaskId}/receipt`) {
      return json(res, 404, { error: 'hidden_receipt', accountId, message: 'private-worker-refresh-token' });
    }
    if (url.pathname === '/v1/tasks/99999999-9999-4999-8999-999999999999/receipt') {
      return json(res, 200, receipt);
    }
    if (url.pathname === '/v1/tasks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/receipt') {
      return json(res, 500, { error: 'private_internal_error', message: 'account secret and cursor hidden' });
    }
    if (url.pathname === '/v1/tasks/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/receipt') {
      return json(res, 200, { ...receipt, accountId: 'private-account-id' });
    }
    if (url.pathname === `/v1/receipts/keys/${key.version}`) return json(res, 200, key);
    return json(res, 404, { error: 'not found' });
  });
  const fixture = await profileHome(http.origin);
  const client = await connect(fixture.home);

  try {
    // When a profile with no participant scopes reads, tampers with, mismatches, or cannot access a receipt.
    const catalog = await client.listTools();
    const names = catalog.tools.map((entry) => entry.name);
    assert.ok(names.includes('marketplace_receipt_get'));
    const publicTool = catalog.tools.find((entry) => entry.name === 'marketplace_public_receipt_get');
    assert.ok(publicTool);
    assert.equal(publicTool.annotations.readOnlyHint, true);
    assert.deepEqual(Object.keys(publicTool.inputSchema.properties), ['taskId']);
    assert.equal(publicTool.inputSchema.additionalProperties, false);

    const extraInput = await client.callTool({ name: 'marketplace_public_receipt_get', arguments: { taskId, accountId } });
    const valid = await client.callTool({ name: 'marketplace_public_receipt_get', arguments: { taskId } });
    const tampered = await client.callTool({ name: 'marketplace_public_receipt_get', arguments: { taskId } });
    const mismatch = await client.callTool({ name: 'marketplace_public_receipt_get', arguments: {
      taskId: '99999999-9999-4999-8999-999999999999',
    } });
    const missing = await client.callTool({ name: 'marketplace_public_receipt_get', arguments: { taskId: missingTaskId } });
    const unknownFailure = await client.callTool({ name: 'marketplace_public_receipt_get', arguments: {
      taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    } });
    const malformedReceipt = await client.callTool({ name: 'marketplace_public_receipt_get', arguments: {
      taskId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    } });

    // Then the exact validated signature survives output redaction and unknown or ineligible server bodies remain hidden.
    assert.equal(valid.isError, undefined);
    assert.equal(extraInput.isError, true);
    const exported = JSON.parse(contentText(valid)).result;
    assert.equal(exported.signatureBase64, receipt.signatureBase64);
    assert.equal(exported.canonicalBase64, receipt.canonicalBase64);
    assert.deepEqual(tampered.structuredContent.error.code, 'RECEIPT_INVALID');
    assert.deepEqual(mismatch.structuredContent.error.code, 'RECEIPT_INVALID');
    assert.equal(missing.structuredContent.error.code, 'MARKETPLACE_HTTP');
    assert.equal(missing.structuredContent.error.httpStatus, 404);
    assert.equal(unknownFailure.structuredContent.error.code, 'MARKETPLACE_HTTP');
    assert.equal(unknownFailure.structuredContent.error.httpStatus, 500);
    assert.equal(malformedReceipt.structuredContent.error.code, 'MARKETPLACE_PROTOCOL');
    for (const failure of [tampered, mismatch, missing, unknownFailure, malformedReceipt]) {
      assert.equal(JSON.stringify(failure).includes(accountId), false);
      assert.equal(JSON.stringify(failure).includes('private-worker-refresh-token'), false);
      assert.equal(JSON.stringify(failure).includes('private-account-id'), false);
      assert.equal(JSON.stringify(failure).includes('private_internal_error'), false);
      assert.equal(JSON.stringify(failure).includes('cursor hidden'), false);
    }
    assert.ok(requests.every((request) => request.method === 'GET' && request.authorization === undefined));
    assert.equal(requests.length, 9);
    assert.equal(requests.filter((request) => request.path === `/v1/receipts/keys/${key.version}`).length, 3);
    assert.equal(successfulReceiptReads, 2);
  } finally {
    await close(client, http, fixture);
  }
});

test('engagement cursor guidance applies only to effective GET requests', async () => {
  // Given a mock engagement route that returns its exact bounded cursor error for GET and POST.
  const requests = [];
  const http = await listen(async (req, res) => {
    requests.push({ method: req.method, path: req.url });
    return json(res, 400, { error: 'invalid_workspace_query', message: 'account token cursor details' });
  });
  const fixture = await profileHome(http.origin);

  try {
    // When the API client uses its default GET and an explicit POST on the same route.
    const api = new MarketplaceApiClient(fixture.store, 'agent');
    await assert.rejects(api.request('/v1/agent/engagements', { auth: 'none', query: { cursor: 'opaque' } }),
      (error) => error.code === 'INVALID_WORKSPACE_QUERY');
    let postError;
    await assert.rejects(api.request('/v1/agent/engagements', {
      auth: 'none', method: 'POST', query: { cursor: 'opaque' },
    }), (error) => { postError = error; return error.code === 'MARKETPLACE_HTTP'; });

    // Then POST cannot be misclassified as a GET cursor failure and server details stay absent.
    assert.deepEqual(requests.map((request) => request.method), ['GET', 'POST']);
    assert.equal(postError.message.includes('account token cursor details'), false);
  } finally {
    await close(null, http, fixture);
  }
});

async function profileHome(origin) {
  const home = await mkdtemp(join(tmpdir(), 'atto-marketplace-mcp-public-history-'));
  const store = await MarketplaceProfileStore.open(home);
  store.createProfile({
    id: 'agent', origin, audience: 'marketplace', accountId, agentId: buyerAgentId, identityId,
    controllerNetwork: 'ATTO', controllerAddress: `atto://${'a'.repeat(61)}`,
    authMode: 'scoped-api-key', apiKey: 'no-participant-grants', apiScopes: [],
    applyAttoLimit: null, applyXnoLimit: null,
  });
  return { home, store };
}

async function connect(home) {
  const client = new Client({ name: 'test-marketplace-public-history', version: '1.0.0' });
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    typeof value === 'string' && key !== 'NODE_TEST_CONTEXT' && !key.startsWith('NODE_TEST_')));
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [serverMain, '--profile', 'agent', '--home', home], env: environment, stderr: 'pipe',
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
  if (client) await client.close();
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

function publicHistoryPage(receipt) {
  const task = (id, state, requesterHandle, requesterDisplayName, version) => ({
    taskId: id,
    requesterAgentId: buyerAgentId,
    requesterHandle,
    requesterDisplayName,
    title: 'Published public history task',
    description: 'A bounded public description.',
    deliverable: 'A completed deliverable.',
    acceptanceTerms: 'The published acceptance terms.',
    asset: 'ATTO',
    grossAtomic: '100',
    feeAtomic: '1',
    workerNetAtomic: '99',
    feeRateBasisPoints: 100,
    dueAt: null,
    applicationClosesAt: null,
    state,
    funded: true,
    version,
    publishedAt: '2026-10-01T00:00:00Z',
    closedAt: '2026-10-02T00:00:00Z',
  });
  return {
    items: [
      {
        task: task(receipt.taskId, 'COMPLETED', 'buyer-one', 'Buyer One', 3),
        worker: { agentId: workerAgentId, handle: 'worker-one', displayName: 'Worker One' },
        receipt: { receiptId: receipt.receiptId, outcome: receipt.outcome, createdAt: receipt.createdAt },
      },
      {
        task: task('99999999-9999-4999-8999-999999999999', 'CANCELLED', null, null, 2),
        worker: null,
        receipt: null,
      },
    ],
    nextCursor: 'opaque-history-cursor',
  };
}
