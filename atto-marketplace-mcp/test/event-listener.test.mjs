import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { MarketplaceProfileStore } from '../dist/profile-store.js';
import { readAccountEvents } from '../dist/account-events.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const applicationId = '22222222-2222-4222-8222-222222222222';
const taskId = '33333333-3333-4333-8333-333333333333';
const secondApplication = '44444444-4444-4444-8444-444444444444';
const credential = 'private-event-profile-credential';
const command = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const wake = fileURLToPath(new URL('./support/enqueue-event.mjs', import.meta.url));
const literalArg = 'argument with $HOME & spaces';
const hire = (id, application = applicationId) => ({id, type: 'application.hired', accountId, applicationId: application, taskId});
const frame = event => `id: ${event.id}\r\nevent: marketplace\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;

const catalog = [
  {type:'application.hired', audience:'ACCOUNT', scope:'applications:read'},
  {type:'application.created', audience:'ACCOUNT', scope:'applications:read'},
  {type:'milestone.submitted', audience:'ACCOUNT', scope:'submissions:read'},
  {type:'shop.order.paid', audience:'ACCOUNT', scope:'products:read'},
  {type:'task.dispute.opened', audience:'ACCOUNT', controllerOnly:true},
  {type:'service.quote.revised', audience:'ACCOUNT', scope:'services:read'},
  {type:'task.published', audience:'PUBLIC'},
  {type:'service.listing.closed', audience:'PUBLIC'},
];

async function until(predicate) {
  for (let i = 0; i < 400; i++) {
    if (await predicate()) return;
    await delay(25);
  }
  assert.fail('Timed out waiting for listener or queue');
}

async function fixture(t, serve, profileOverrides = {}) {
  const advertised = [...catalog];
  const home = await mkdtemp(join(tmpdir(), 'marketplace-event-listener-'));
  const requests = [];
  const catalogHeaders = [];
  const server = createServer((req, res) => {
    if (req.url === '/v1/discovery/event-types') {
      catalogHeaders.push(req.headers.authorization);
      res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({types:advertised})); return;
    }
    const types = new URL(req.url, 'http://localhost').searchParams.get('types');
    requests.push({path: req.url.split('?')[0], types, cursor: req.headers['last-event-id'], authorization: req.headers.authorization});
    serve(req, res, requests);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const store = await MarketplaceProfileStore.open(home);
  store.createProfile({id:'main', origin:`http://127.0.0.1:${server.address().port}`, audience:'events',
    accountId,agentId:applicationId,identityId:taskId,controllerNetwork:'ATTO',controllerAddress:`atto://${'a'.repeat(61)}`,
    authMode:'scoped-api-key', apiKey:credential, apiScopes:['applications:read','products:read','submissions:read'], ...profileOverrides});
  store.close();
  const children = [];
  function start(extra = []) {
    const handler = extra.includes('--list-types') ? [] : ['--', process.execPath, wake, home, literalArg];
    const child = spawn(process.execPath, [command, 'listen', ...extra, ...handler], {
      env: {...process.env, MARKETPLACE_TEST_SECRET: credential, MARKETPLACE_MCP_HOME: home,
        UNRELATED_ALIAS: 'Bearer ' + credential, MARKETPLACE_API_KEY: 'other-legacy-key', LEGACY_ALIAS: 'other-legacy-key', HOST_QUEUE_DIR: home}, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = { child, stdout: '', stderr: '', done: once(child, 'exit') };
    child.stdout.on('data', chunk => { result.stdout += chunk; });
    child.stderr.on('data', chunk => { result.stderr += chunk; });
    children.push(result);
    return result;
  }
  t.after(async () => {
    for (const {child, done} of children) {
      if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
      await done;
    }
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    await rm(home, {recursive:true, force:true});
  });
  return {home, start, requests, catalogHeaders, advertised};
}

function stream(res) {
  res.writeHead(200, {'content-type': 'text/event-stream; charset=utf-8'});
  res.write(': ready\n\n');
}

test('idle worker receives hires, retries failed enqueue, and replays an offline hire from its durable cursor', {timeout:30_000}, async t => {
  const history = [];
  let live;
  const {home, start, requests} = await fixture(t, (req, res) => {
    stream(res);
    for (const event of history) if (BigInt(event.id) > BigInt(req.headers['last-event-id'] ?? '0')) res.write(frame(event));
    live = res;
  });
  const first = start();
  await until(() => first.stderr.includes('listener connected'));
  const other = start();
  assert.equal((await other.done)[0], 1);
  assert.match(other.stderr, /already owns/);
  const fail = join(home, 'fail-1');
  await writeFile(fail, '');
  history.push(hire('1'));
  live.write(frame(history[0]));
  await until(() => first.stderr.includes('did not acknowledge'));
  assert.equal(existsSync(join(home, 'job-' + applicationId)), false);
  await rm(fail);
  await until(() => existsSync(join(home, 'job-' + applicationId)));
  // Force a reconnect to observe the saved cursor before stopping the listener.
  live.end();
  await until(() => requests.at(-1).cursor === '1');
  first.child.kill('SIGTERM');
  await first.done;
  history.push(hire('2', secondApplication));
  const restarted = start(['--types', 'application.hired']);
  await until(() => existsSync(join(home, 'job-' + secondApplication)));
  live.end();
  await until(() => requests.at(-1).cursor === '2');
  assert.deepEqual(requests.map(r => r.cursor), [undefined, undefined, '1', '1', '2']);
  for (const request of requests) {
    assert.equal(request.path, '/v1/agent/events');
    assert.equal(request.types, 'application.hired');
    assert.equal(request.authorization, 'Bearer ' + credential);
  }
  const attempts = (await readFile(join(home, 'attempts'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(attempts.map(a => a.event.id), ['1','1','2']);
  for (const attempt of attempts) {
    assert.deepEqual(attempt.args, [attempt.event.applicationId, taskId]);
    assert.equal(attempt.fixedArg, literalArg);
    assert.equal(attempt.leaking, false);
  }
  assert.ok(!first.stderr.includes(credential) && !restarted.stderr.includes(credential));
});

test('existing argv-only hire command keeps its queue configuration and can close stdin', {timeout:30_000}, async t => {
  const {home,start,requests} = await fixture(t, (req, res) => {
    stream(res);
    if (!req.headers['last-event-id']) res.end(frame(hire('1')));
  });
  await writeFile(join(home, 'argv-only'), '');
  start();
  await until(() => requests.at(-1)?.cursor === '1');
  assert.deepEqual(JSON.parse(await readFile(join(home, 'queued-' + applicationId), 'utf8')), [applicationId, taskId]);
});

test('crash after durable enqueue replays the same event into a deduplicating queue', {timeout:30_000}, async t => {
  const {home, start, requests} = await fixture(t, (req, res) => {
    stream(res);
    if (!req.headers['last-event-id']) res.end(frame(hire('3')));
  });
  const hold = join(home, 'hold-3');
  await writeFile(hold, '');
  const original = start();
  try {
    await until(() => existsSync(join(home, 'enqueued')));
    original.child.kill('SIGKILL');
    await original.done;
  } finally { await rm(hold, {force:true}); }
  start();
  await until(() => requests.at(-1).cursor === '3');
  assert.deepEqual(requests.map(r => r.cursor), [undefined, undefined, '3']);
  assert.deepEqual((await readdir(home)).filter(f => f.startsWith('job-')), ['job-' + applicationId]);
  assert.equal((await readFile(join(home,'attempts'),'utf8')).trim().split('\n').length, 2);
});

test('canonical filters share a cursor, and other subscriptions start independently', {timeout:30_000}, async t => {
  const events = [
    {...hire('9007199254740993'), type:'application.created'},
    {id:'9007199254740994', type:'milestone.submitted', accountId, taskId, milestoneId:applicationId, submissionId:secondApplication},
    {id:'9007199254740995', type:'shop.order.paid', accountId, productId:taskId, purchaseId:applicationId, status:'PAID_UNFULFILLED'},
  ];
  const {home,start,requests} = await fixture(t, (req, res) => {
    if (requests.length >= 3) { res.writeHead(403); res.end(credential); return; }
    stream(res);
    if (!req.headers['last-event-id']) res.end(events.map(frame).join(''));
  });
  const types = events.map(e => e.type);
  const first = start(['--types', types.toReversed().join(',')]);
  await until(() => requests.at(-1)?.cursor === events.at(-1).id);
  first.child.kill('SIGTERM');
  await first.done;
  const next = start(['--types', types.join(',')]);
  assert.equal((await next.done)[0], 1);
  assert.match(next.stderr, /HTTP 403/);
  assert.ok(!next.stderr.includes(credential));
  const different = start();
  assert.equal((await different.done)[0], 1);
  assert.deepEqual(requests.map(r => r.cursor), [undefined,events.at(-1).id,events.at(-1).id,undefined]);
  assert.equal(requests[0].types, types.join(','));
  const attempts = (await readFile(join(home, 'attempts'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(attempts.map(a => a.event), events);
  assert.deepEqual(attempts.map(a => a.args), [[],[],[]]);
});

test('runtime catalog lists grants and all opens independent public and authorized account streams', {timeout:30_000}, async t => {
  const publicEvent = {id:'1', type:'service.listing.closed'};
  const {start, requests, catalogHeaders, home} = await fixture(t, (req, res) => {
    stream(res);
    if (!req.headers['last-event-id']) res.end(frame(req.url.startsWith('/v1/discovery/') ? publicEvent : hire('1')));
  });
  const listed = start(['--list-types']);
  assert.equal((await listed.done)[0], 0);
  const entries = JSON.parse(listed.stdout).types;
  assert.deepEqual(entries.find(e => e.type === 'task.dispute.opened'),
    {type:'task.dispute.opened',audience:'ACCOUNT',scope:null,controllerOnly:true});
  assert.deepEqual(entries.find(e => e.type === 'service.quote.revised'),
    {type:'service.quote.revised',audience:'ACCOUNT',scope:'services:read',controllerOnly:false});
  const denied = start(['--types', 'service.quote.revised']);
  assert.equal((await denied.done)[0], 1);
  assert.match(denied.stderr, /requires services:read/i);
  assert.equal(requests.length, 0);
  start(['--types', 'all']);
  await until(() => requests.filter(r => r.cursor === '1').length === 2);
  assert.deepEqual(catalogHeaders,[undefined,undefined,undefined]);
  const publicRequests = requests.filter(r => r.path === '/v1/discovery/events');
  const privateRequests = requests.filter(r => r.path === '/v1/agent/events');
  assert.deepEqual(publicRequests.map(r => r.authorization),[undefined,undefined]);
  assert.equal(publicRequests[0].types,'service.listing.closed,task.published');
  assert.deepEqual(privateRequests.map(r => r.authorization),['Bearer ' + credential,'Bearer ' + credential]);
  assert.equal(privateRequests[0].types,'application.created,application.hired,milestone.submitted,shop.order.paid');
  const attempts = (await readFile(join(home, 'attempts'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(attempts.map(a => a.event).sort((a,b)=>a.type.localeCompare(b.type)), [hire('1'), publicEvent]);
});

test('saved selections pause, replace the feed after enqueue, and resume the original checkpoint', {timeout:30_000}, async t => {
  const {start, requests, home} = await fixture(t, (req,res) => {
    stream(res);
    if (!req.headers['last-event-id'] && req.url.startsWith('/v1/agent/')) res.write(frame(hire('1')));
  });
  const store = await MarketplaceProfileStore.open(home);

  const profile = store.getProfile('main');
  store.writeSavedEventTypes(profile, []);
  const listener = start(['--types','saved']);
  await until(() => listener.stderr.includes('waiting for a saved event selection'));
  assert.deepEqual(requests, []);
  await writeFile(join(home, 'hold-1'), '');
  try {
    store.writeSavedEventTypes(profile, ['application.hired']);
    await until(() => existsSync(join(home,'enqueued')));
    store.writeSavedEventTypes(profile, ['task.published']);
    await delay(1500);
    assert.equal(requests.length,1);
  } finally { await rm(join(home,'hold-1'), {force:true}); }
  await until(() => requests.at(-1)?.path === '/v1/discovery/events');
  assert.equal(requests.at(-1).authorization, undefined);
  store.writeSavedEventTypes(profile, ['application.hired']);
  await until(() => requests.at(-1)?.cursor === '1');
  assert.equal((await readFile(join(home,'attempts'),'utf8')).trim().split('\n').length,1);
  listener.child.kill('SIGTERM');
  await listener.done;
  store.close();
});

test('all drops controller-only subscriptions when the local profile hands off to a scoped key', {timeout:30_000}, async t => {
  const controller = 'live-controller-access';
  const {home, start, requests} = await fixture(t, (_req, res) => stream(res), {
    authMode:'controller-session', apiKey:undefined, apiScopes:[], accessToken:controller,
    accessExpiresAt:Date.now() + 300_000, refreshToken:'test-refresh', refreshExpiresAt:Date.now() + 600_000,
  });
  const listener = start(['--types','all']);
  await until(() => requests.some(r => r.types.includes('task.dispute.opened') && r.authorization === 'Bearer ' + controller));
  const store = await MarketplaceProfileStore.open(home);
  try {
    store.replaceSessionWithApiKey('main', credential, ['services:read'], {});
    await until(() => requests.some(r => r.path === '/v1/agent/events' && r.types === 'service.quote.revised'
      && r.authorization === 'Bearer ' + credential));
    assert.equal(requests.filter(r => r.path === '/v1/agent/events').length, 2);
    assert.equal(listener.child.exitCode, null);
  } finally { store.close(); }
});

test('saved mode starts paused without hire permission and reloads the catalog when a newly advertised type is selected', {timeout:30_000}, async t => {
  const {home, start, requests, advertised} = await fixture(t, (_req, res) => stream(res), {apiScopes:['services:read']});
  const store = await MarketplaceProfileStore.open(home);
  try {
    const profile = store.getProfile('main');
    assert.deepEqual(store.readSavedEventTypes(profile), []);
    const listener = start(['--types','saved']);
    await until(() => listener.stderr.includes('waiting for a saved event selection'));
    assert.deepEqual(requests, []);
    advertised.push({type:'service.message.created', audience:'ACCOUNT', scope:'services:read'});
    store.writeSavedEventTypes(profile, ['service.message.created']);
    await until(() => requests.some(r => r.types === 'service.message.created' && r.authorization === 'Bearer ' + credential));
    assert.equal(listener.child.exitCode, null);
  } finally { store.close(); }
});

test('bounded SSE parser rejects mismatched identity, malformed payloads and oversize lines, and discards incomplete frames', async () => {
  const parse = async wire => {
    const stream = new ReadableStream({start(controller) {
      for (let i = 0; i < wire.length; i += 7) controller.enqueue(Buffer.from(wire.slice(i, i + 7)));
      controller.close();
    }});
    return Array.fromAsync(readAccountEvents(stream, accountId, ['application.hired']));
  };
  assert.deepEqual(await parse(': heartbeat\r\n\r\n' + frame(hire('1')) + 'id: 2\ndata: par'), [hire('1')]);
  for (const invalid of [frame({...hire('1'),accountId:taskId}), frame(hire('1')).replace('id: 1','id: 2'),
    frame({...hire('1'),taskId:'invalid'}), frame({...hire('1'),type:'application.created'}), 'data: ' + 'x'.repeat(65536)]) {
    await assert.rejects(parse(invalid), /invalid event/);
  }
});
