import assert from 'node:assert/strict';
import test from 'node:test';
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
const taskId = '44444444-4444-4444-8444-444444444444';
const applicationId = '55555555-5555-4555-8555-555555555555';
const requestId = '66666666-6666-4666-8666-666666666666';
const commandId = '77777777-7777-4777-8777-777777777777';
const statusUrl = '/v1/agent/commands/' + commandId;
const hirePath = '/v1/agent/tasks/' + taskId + '/hire';
const engagementPath = '/v1/agent/tasks/' + taskId + '/engagement';
const serverMain = join(import.meta.dirname, '../dist/main.js');
const hireArgs = {taskId, applicationId, expectedVersion: 1, requestId};

test('direct hire conflict remains a 409 and cannot become success from an engagement read', async () => {
  const requests = [];
  const http = await listen(async (req, res) => {
    const body = await readBody(req);
    requests.push({method: req.method, path: req.url, body});
    if (req.method === 'POST' && req.url === hirePath) {
      return json(res, 409, {error: 'task_conflict', message: 'The task is no longer open at that version.'});
    }
    if (req.method === 'GET' && req.url === engagementPath) {
      return json(res, 200, {taskId, acceptedApplicationId: applicationId, state: 'ACTIVE', version: 0});
    }
    return json(res, 404, {});
  });
  const fixture = await profileHome(http.origin);
  const client = await connect(fixture.home);
  try {
    const result = await client.callTool({name: 'marketplace_application_hire', arguments: hireArgs});
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'MARKETPLACE_HTTP');
    assert.equal(result.structuredContent.error.httpStatus, 409);

    const catalog = await client.listTools();
    const tool = catalog.tools.find(value => value.name === 'marketplace_application_hire');
    assert.ok(tool);
    assert.match(tool.description, /current task version from marketplace_task_get/i);
    assert.match(tool.inputSchema.properties.expectedVersion.description,
      /task version.*marketplace_task_get.*independent.*application\.version/i);
    assert.equal(requests.filter(value => value.method === 'POST' && value.path === hirePath).length, 1);
    assert.equal(requests.filter(value => value.method === 'GET' && value.path === engagementPath).length, 0,
      'a conflict must not trigger an engagement lookup that can synthesize success');
  } finally {
    await client.close();
    http.close();
    fixture.store.close();
    await rm(fixture.home, {recursive: true, force: true});
  }
});

test('terminal asynchronous hire rejection survives restart and replay without another POST', async () => {
  const requests = [];
  let commandStatus = 'PENDING';
  const http = await listen(async (req, res) => {
    const body = await readBody(req);
    requests.push({method: req.method, path: req.url, body});
    if (req.method === 'POST' && req.url === hirePath) {
      return json(res, 202, {commandId, status: 'PENDING', statusUrl,
        result: null, errorCode: null, httpStatus: null});
    }
    if (req.method === 'GET' && req.url === statusUrl) {
      if (commandStatus === 'REJECTED') {
        return json(res, 200, {commandId, status: 'REJECTED', statusUrl,
          result: {error: 'task_conflict', message: 'The task is no longer open at that version.'},
          errorCode: 'task_conflict', httpStatus: 409});
      }
      return json(res, 200, {commandId, status: 'PENDING', statusUrl,
        result: null, errorCode: null, httpStatus: null});
    }
    if (req.method === 'GET' && req.url === engagementPath) {
      return json(res, 200, {taskId, acceptedApplicationId: applicationId, state: 'ACTIVE', version: 0});
    }
    return json(res, 404, {});
  });
  const fixture = await profileHome(http.origin);
  let client = await connect(fixture.home, 300);
  try {
    const pending = await client.callTool({name: 'marketplace_application_hire', arguments: hireArgs});
    assert.equal(pending.isError, true);
    assert.equal(pending.structuredContent.error.code, 'COMMAND_PENDING');
    assert.equal(pending.structuredContent.error.details.commandId, commandId);
    assert.equal(pending.structuredContent.error.details.statusUrl, statusUrl);
    assert.equal(requests.filter(value => value.method === 'POST' && value.path === hirePath).length, 1);

    await client.close();
    commandStatus = 'REJECTED';
    client = await connect(fixture.home, 5_000);
    const rejected = await client.callTool({name: 'marketplace_application_hire', arguments: hireArgs});
    assert.equal(rejected.isError, true);
    assert.equal(rejected.structuredContent.error.code, 'COMMAND_REJECTED');
    assert.equal(rejected.structuredContent.error.httpStatus, 409);
    assert.equal(rejected.structuredContent.error.details.commandId, commandId);
    assert.equal(rejected.structuredContent.error.details.statusUrl, statusUrl);
    assert.equal(rejected.structuredContent.error.details.terminal, true);

    const replay = await client.callTool({name: 'marketplace_application_hire', arguments: hireArgs});
    assert.equal(replay.isError, true);
    assert.equal(replay.structuredContent.error.code, 'COMMAND_REJECTED');
    assert.equal(replay.structuredContent.error.details.commandId, commandId);
    assert.equal(requests.filter(value => value.method === 'POST' && value.path === hirePath).length, 1,
      'restart and replay must resume the saved command pointer, never resubmit hire');
    assert.ok(requests.some(value => value.method === 'GET' && value.path === statusUrl));
    assert.equal(requests.filter(value => value.method === 'GET' && value.path === engagementPath).length, 0);
    assert.deepEqual(requests.find(value => value.method === 'POST' && value.path === hirePath).body,
      {expectedVersion: 1, applicationId});
  } finally {
    await client.close();
    http.close();
    fixture.store.close();
    await rm(fixture.home, {recursive: true, force: true});
  }
});

test('successful hire replay returns the saved result without another command or engagement read', async () => {
  const requests = [];
  const engagement = {taskId, acceptedApplicationId: applicationId, state: 'ACTIVE', version: 0,
    asset: 'ATTO', grossAtomic: '1000', feeAtomic: '10', workerNetAtomic: '990', feeRateBasisPoints: 100};
  const http = await listen(async (req, res) => {
    const body = await readBody(req);
    requests.push({method: req.method, path: req.url, body});
    if (req.method === 'POST' && req.url === hirePath) {
      return json(res, 202, {commandId, status: 'PENDING', statusUrl,
        result: null, errorCode: null, httpStatus: null});
    }
    if (req.method === 'GET' && req.url === statusUrl) {
      return json(res, 200, {commandId, status: 'SETTLED', statusUrl,
        result: engagement, errorCode: null, httpStatus: 200});
    }
    if (req.method === 'GET' && req.url === engagementPath) {
      return json(res, 200, engagement);
    }
    return json(res, 404, {});
  });
  const fixture = await profileHome(http.origin);
  const client = await connect(fixture.home);
  try {
    const first = await client.callTool({name: 'marketplace_application_hire', arguments: hireArgs});
    assert.equal(first.isError, undefined);
    assert.deepEqual(JSON.parse(contentText(first)).result, engagement);
    const postCount = requests.filter(value => value.method === 'POST' && value.path === hirePath).length;
    const statusCount = requests.filter(value => value.method === 'GET' && value.path === statusUrl).length;

    const replay = await client.callTool({name: 'marketplace_application_hire', arguments: hireArgs});
    assert.equal(replay.isError, undefined);
    const replayResult = JSON.parse(contentText(replay)).result;
    assert.equal(replayResult.recovered, true);
    assert.deepEqual(JSON.parse(replayResult.resultIdentity), {taskId, acceptedApplicationId: applicationId, state: 'ACTIVE', version: 0});
    assert.equal(requests.filter(value => value.method === 'POST' && value.path === hirePath).length, postCount);
    assert.equal(requests.filter(value => value.method === 'GET' && value.path === statusUrl).length, statusCount);
    assert.equal(requests.filter(value => value.method === 'GET' && value.path === engagementPath).length, 0);
  } finally {
    await client.close();
    http.close();
    fixture.store.close();
    await rm(fixture.home, {recursive: true, force: true});
  }
});

async function profileHome(origin) {
  const home = await mkdtemp(join(tmpdir(), 'atto-marketplace-mcp-hire-recovery-'));
  const store = await MarketplaceProfileStore.open(home);
  store.createProfile({id: 'agent', origin, audience: 'marketplace', accountId, agentId, identityId,
    controllerNetwork: 'ATTO', controllerAddress: 'atto://' + 'a'.repeat(61),
    authMode: 'controller-session', accessToken: 'valid-controller-access-token',
    accessExpiresAt: Date.now() + 60_000, refreshToken: 'valid-controller-refresh-token',
    refreshExpiresAt: Date.now() + 120_000});
  return {home, store};
}

async function connect(home, commandWaitMs = 30_000) {
  const client = new Client({name: 'test-application-hire-recovery', version: '1.0.0'});
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    typeof value === 'string' && key !== 'NODE_TEST_CONTEXT' && !key.startsWith('NODE_TEST_')));
  environment.MARKETPLACE_COMMAND_WAIT_MS = String(commandWaitMs);
  await client.connect(new StdioClientTransport({command: process.execPath,
    args: [serverMain, '--profile', 'agent', '--home', home], env: environment, stderr: 'pipe'}));
  return client;
}

async function listen(handler) {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(() => {
      if (!res.destroyed) json(res, 500, {});
    });
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return Object.assign(server, {origin: 'http://127.0.0.1:' + server.address().port});
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
