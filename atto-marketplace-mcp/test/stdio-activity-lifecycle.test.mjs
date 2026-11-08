import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MarketplaceProfileStore } from '../dist/profile-store.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const identityId = '33333333-3333-4333-8333-333333333333';
const taskId = '44444444-4444-4444-8444-444444444444';
const submissionId = '55555555-5555-4555-8555-555555555555';
const activityRequestId = '66666666-6666-4666-8666-666666666666';
const acceptRequestId = '77777777-7777-4777-8777-777777777777';
const closedRequestId = '88888888-8888-4888-8888-888888888888';
const activityPath = `/v1/agent/tasks/${taskId}/activity`;
const engagementPath = `/v1/agent/tasks/${taskId}/engagement`;
const acceptPath = `/v1/agent/tasks/${taskId}/accept`;
const serverMain = join(import.meta.dirname, '../dist/main.js');
const initialActivity = {taskId, requestId: activityRequestId, kind: 'MESSAGE', text: 'Progress before review'};
const closedActivity = {taskId, requestId: closedRequestId, kind: 'STATUS_NOTE', text: 'Late status note'};

test('stdio activity replay stays safe after close and new appends get actionable conflict', async () => {
  // Given
  const requests = [];
  const activities = [];
  const savedByRequestId = new Map();
  let closed = false;
  const http = await listen(async (req, res) => {
    const body = await readBody(req);
    const requestId = req.headers['idempotency-key'];
    requests.push({method: req.method, path: req.url, requestId});
    if (req.method === 'POST' && req.url === activityPath) {
      const saved = savedByRequestId.get(requestId);
      if (saved) {
        if (JSON.stringify(saved.body) !== JSON.stringify(body)) {
          return json(res, 409, {error: 'idempotency_conflict', message: 'Request content changed.'});
        }
        return json(res, 201, saved.result);
      }
      if (closed) return json(res, 409,
        {error: 'task_conflict', message: 'Engagement is no longer active.'});
      const result = {taskId, cursor: activities.length + 1, kind: body.kind,
        actorAgentId: agentId, text: body.text, referenceId: null,
        occurredAt: '2026-10-10T00:00:00Z', credential: 'credential-sentinel',
        proof: 'proof-sentinel', opaqueCursor: 'opaque-cursor-sentinel'};
      activities.push(result);
      savedByRequestId.set(requestId, {body, result});
      return json(res, 201, result);
    }
    if (req.method === 'POST' && req.url === acceptPath) {
      closed = true;
      return json(res, 200, {taskId, outcome: 'ACCEPTED', receiptId: 'receipt-1',
        ledgerTransactionId: 'settlement-1'});
    }
    if (req.method === 'GET' && req.url === engagementPath) {
      return json(res, 200, {taskId, state: closed ? 'COMPLETED' : 'ACTIVE', version: 2});
    }
    if (req.method === 'GET' && req.url.startsWith(activityPath)) return json(res, 200, activities);
    return json(res, 404, {});
  });
  const firstHome = await profileHome(http.origin, 'agent');
  const replayHome = await profileHome(http.origin, 'replay-agent');
  let firstClient = await connect(firstHome.home, 'agent');
  let replayClient;
  try {
    const catalog = await firstClient.listTools();
    const activityTool = catalog.tools.find(tool => tool.name === 'marketplace_activity_add');
    assert.ok(activityTool);
    assert.match(activityTool.description, /IN_PROGRESS.*ACTIVE/);
    assert.match(activityTool.description, /acceptance or dispute blocks ordinary appends/i);
    assert.match(activityTool.description, /previously successful requestId.*saved result identity/i);

    // When
    const appended = await firstClient.callTool({name: 'marketplace_activity_add', arguments: initialActivity});

    // Then
    assert.equal(appended.isError, undefined);
    const appendedResult = JSON.parse(contentText(appended)).result;
    assert.equal(appendedResult.cursor, 1);
    assert.equal(activities.length, 1);

    // When
    const accepted = await firstClient.callTool({name: 'marketplace_work_accept', arguments: {
      taskId, requestId: acceptRequestId, expectedEngagementVersion: 2, submissionId}});

    // Then
    assert.equal(accepted.isError, undefined);
    assert.equal(JSON.parse(contentText(accepted)).result.outcome, 'ACCEPTED');
    assert.equal(closed, true);

    // When
    const localReplay = await firstClient.callTool({name: 'marketplace_activity_add', arguments: initialActivity});

    // Then
    assert.equal(localReplay.isError, undefined);
    const localReplayResult = JSON.parse(contentText(localReplay)).result;
    assert.equal(localReplayResult.recovered, true);
    const savedIdentity = JSON.parse(localReplayResult.resultIdentity);
    assert.deepEqual(savedIdentity, {taskId, cursor: 1, actorAgentId: agentId, referenceId: null},
      'the saved result keeps default safe IDs plus the numeric activity cursor only');
    assert.equal(typeof savedIdentity.cursor, 'number');
    for (const hiddenField of ['credential', 'proof', 'opaqueCursor', 'text', 'kind']) {
      assert.equal(Object.hasOwn(savedIdentity, hiddenField), false,
        `the saved activity replay must not retain ${hiddenField}`);
    }
    assert.equal(requests.filter(request => request.method === 'POST' && request.path === activityPath).length, 1);

    // Given a COMPLETE journal written by the older safe-identity projection, which omitted cursor.
    replaceSavedActivityIdentity(firstHome.home, {
      taskId, actorAgentId: agentId, referenceId: null,
    });

    // When
    const rejectedReplay = await firstClient.callTool({name: 'marketplace_activity_add', arguments: initialActivity});

    // Then
    assert.equal(rejectedReplay.isError, true);
    assert.equal(rejectedReplay.structuredContent.error.code,'MARKETPLACE_PROTOCOL');
    assert.equal(requests.filter(request => request.method === 'POST' && request.path === activityPath).length, 1,
      'unsupported saved activity data never sends another activity request');

    // When
    replayClient = await connect(replayHome.home, 'replay-agent');
    const serverReplay = await replayClient.callTool({name: 'marketplace_activity_add', arguments: initialActivity});

    // Then
    assert.equal(serverReplay.isError, undefined);
    assert.equal(JSON.parse(contentText(serverReplay)).result.cursor, 1,
      'a fresh MCP profile receives the backend saved activity result after close');
    assert.equal(activities.length, 1, 'the backend replay does not append another activity');

    // When
    const rejected = await replayClient.callTool({name: 'marketplace_activity_add', arguments: closedActivity});
    const repeatedRejection = await replayClient.callTool({name: 'marketplace_activity_add', arguments: closedActivity});

    // Then
    for (const result of [rejected, repeatedRejection]) {
      assert.equal(result.isError, true);
      const error = result.structuredContent.error;
      assert.equal(error.code, 'ENGAGEMENT_INACTIVE');
      assert.equal(error.httpStatus, 409);
      assert.equal(error.details.serverCode, 'task_conflict');
      assert.match(error.message, /marketplace_engagement_get/);
      assert.match(error.message, /marketplace_activity_list/);
      assert.match(error.message, /send feedback before acceptance or dispute/i);
      assert.match(error.message, /do not replace the request or try to reopen/i);
      assert.ok(!error.message.includes(closedActivity.text));
    }
    assert.equal(requests.filter(request => request.method === 'POST' && request.path === activityPath).length, 4,
      'one create, one server idempotent replay, and two rejected exact attempts were observed');
    assert.equal(activities.length, 1, 'rejected appends create no extra participant activity');

    // When the actionable error directs the client to inspect current state and the existing feed.
    const currentEngagement = await replayClient.callTool({name: 'marketplace_engagement_get', arguments: {taskId}});
    const currentActivity = await replayClient.callTool({name: 'marketplace_activity_list', arguments: {taskId}});

    // Then
    assert.equal(currentEngagement.isError, undefined);
    assert.equal(JSON.parse(contentText(currentEngagement)).result.state, 'COMPLETED');
    assert.equal(currentActivity.isError, undefined);
    assert.equal(JSON.parse(contentText(currentActivity)).result.length, 1);
    assert.ok(requests.some(request => request.method === 'GET' && request.path.startsWith(activityPath)),
      'the suggested activity read can inspect the existing feed');
    assert.ok(requests.some(request => request.method === 'GET' && request.path === engagementPath),
      'the suggested current engagement read can inspect lifecycle state');
  } finally {
    await firstClient.close();
    if (replayClient) await replayClient.close();
    await close(http);
    firstHome.store.close();
    replayHome.store.close();
    await rm(firstHome.home, {recursive: true, force: true});
    await rm(replayHome.home, {recursive: true, force: true});
  }
});

function replaceSavedActivityIdentity(home, identity) {
  const database = new DatabaseSync(join(home, 'profiles.sqlite'));
  try {
    const changed = database.prepare(`UPDATE mutations SET result_identity=?
      WHERE profile_id='agent' AND request_id=? AND operation='activity-add' AND state='COMPLETE'`)
      .run(JSON.stringify(identity), activityRequestId).changes;
    assert.equal(changed, 1, 'the fixture updates exactly the successful activity journal row');
  } finally {
    database.close();
  }
}

async function profileHome(origin, profileId) {
  const home = await mkdtemp(join(tmpdir(), 'atto-marketplace-mcp-activity-lifecycle-'));
  const store = await MarketplaceProfileStore.open(home);
  store.createProfile({id: profileId, origin, audience: 'marketplace', accountId, agentId, identityId,
    controllerNetwork: 'ATTO', controllerAddress: 'atto://' + 'a'.repeat(61),
    authMode: 'controller-session', accessToken: 'valid-controller-access-token',
    accessExpiresAt: Date.now() + 60_000, refreshToken: 'valid-controller-refresh-token',
    refreshExpiresAt: Date.now() + 120_000});
  return {home, store};
}

async function connect(home, profileId) {
  const client = new Client({name: 'test-activity-lifecycle', version: '1.0.0'});
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    typeof value === 'string' && key !== 'NODE_TEST_CONTEXT' && !key.startsWith('NODE_TEST_')));
  await client.connect(new StdioClientTransport({command: process.execPath,
    args: [serverMain, '--profile', profileId, '--home', home], env: environment, stderr: 'pipe'}));
  return client;
}

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

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : null;
}

function json(res, status, body) {
  res.writeHead(status, {'content-type': 'application/json'});
  res.end(JSON.stringify(body));
}

function contentText(result) {
  return result.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? '';
}
