import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { MarketplaceApiClient, MarketplaceApiError } from '../dist/marketplace-api.js';

const taskId = '44444444-4444-4444-8444-444444444444';
const activityPath = `/v1/agent/tasks/${taskId}/activity`;
const inactiveResponse = {error: 'task_conflict', message: 'Engagement is no longer active.'};
const fixedMessage = 'This new activity was not appended because the task or engagement is no longer active. Read marketplace_engagement_get and marketplace_activity_list. New activity requires IN_PROGRESS/ACTIVE; for future work, send feedback before acceptance or dispute. Do not replace the request or try to reopen the contract.';

test('inactive activity mapping requires the exact route, status, API code, and message', async () => {
  // Given
  let nextResponse;
  const http = await listen(async (_req, res) => {
    const response = nextResponse;
    if (response.raw !== undefined) {
      res.writeHead(response.status, {'content-type': 'application/json'});
      res.end(response.raw);
    } else {
      json(res, response.status, response.body);
    }
  });
  const profile = {id: 'agent', origin: http.origin, audience: 'marketplace', accountId: 'account',
    agentId: 'agent-id', identityId: 'identity', authMode: 'controller-session',
    accessToken: 'test-access-token', accessExpiresAt: Date.now() + 60_000,
    refreshToken: 'test-refresh-token', refreshExpiresAt: Date.now() + 120_000};
  const api = new MarketplaceApiClient({getProfile: () => profile}, 'agent');
  const cases = [
    {name: 'exact inactive activity conflict', path: activityPath, method: 'POST', status: 409,
      body: inactiveResponse, expected: 'ENGAGEMENT_INACTIVE'},
    {name: 'different server message', path: activityPath, method: 'POST', status: 409,
      body: {error: 'task_conflict', message: 'untrusted diagnostic must not leak'}, expected: 'MARKETPLACE_HTTP'},
    {name: 'idempotency conflict', path: activityPath, method: 'POST', status: 409,
      body: {error: 'idempotency_conflict', message: inactiveResponse.message}, expected: 'MARKETPLACE_HTTP'},
    {name: 'unrelated route', path: `/v1/agent/tasks/${taskId}/submissions`, method: 'POST', status: 409,
      body: inactiveResponse, expected: 'MARKETPLACE_HTTP'},
    {name: 'wrong status', path: activityPath, method: 'POST', status: 400,
      body: inactiveResponse, expected: 'MARKETPLACE_HTTP'},
    {name: 'query-bearing route', path: activityPath, method: 'POST', status: 409,
      query: {after: 1}, body: inactiveResponse, expected: 'MARKETPLACE_HTTP'},
    {name: 'read method', path: activityPath, method: 'GET', status: 409,
      body: inactiveResponse, expected: 'MARKETPLACE_HTTP'},
    {name: 'malformed response body', path: activityPath, method: 'POST', status: 409,
      raw: 'not-json', expected: 'MARKETPLACE_PROTOCOL'},
  ];
  try {
    // When
    for (const scenario of cases) {
      nextResponse = scenario;
      const error = await api.request(scenario.path, {method: scenario.method,
        ...(scenario.method === 'POST' ? {body: {kind: 'MESSAGE', text: 'test'}} : {}),
        ...(scenario.query ? {query: scenario.query} : {})}).then(
        () => assert.fail(`${scenario.name} unexpectedly succeeded`), cause => cause);

      // Then
      assert.ok(error instanceof MarketplaceApiError, scenario.name);
      assert.equal(error.code, scenario.expected, scenario.name);
      if (scenario.expected === 'ENGAGEMENT_INACTIVE') {
        assert.equal(error.httpStatus, 409);
        assert.equal(error.message, fixedMessage);
        assert.equal(error.details.serverCode, 'task_conflict');
        assert.equal(error.details.terminal, true);
      } else if (scenario.body?.message) {
        assert.equal(error.message, `Marketplace returned HTTP ${scenario.status} for the requested operation.`);
        assert.ok(!error.message.includes(scenario.body.message), 'untrusted API prose must not be echoed');
      }
    }
  } finally {
    await close(http);
  }
});

async function listen(handler) {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(() => {
      if (!res.destroyed) json(res, 500, {});
    });
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return Object.assign(server, {origin: `http://127.0.0.1:${server.address().port}`});
}

async function close(server) {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function json(res, status, body) {
  res.writeHead(status, {'content-type': 'application/json'});
  res.end(JSON.stringify(body));
}
