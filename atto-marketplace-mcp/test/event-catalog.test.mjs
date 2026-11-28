import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { readEventCatalog } from '../dist/account-events.js';
import { runListener } from '../dist/event-listener.js';
import { MarketplaceApiError } from '../dist/marketplace-api.js';

const origin = 'https://marketplace.example';

test('catalog network failures preserve their type and malformed or oversized responses remain terminal', async t => {
  let fetchResponse;
  t.mock.method(globalThis, 'fetch', () => fetchResponse());
  for (const [respond, code, status] of [
    [() => { throw new Error('private network diagnostic'); }, 'MARKETPLACE_UNAVAILABLE', undefined],
    [() => new Response(new ReadableStream({start(controller) { controller.error(new Error('private body diagnostic')); }})), 'MARKETPLACE_UNAVAILABLE', 200],
    [() => new Response(new Uint8Array([0xff])), 'MARKETPLACE_PROTOCOL', 200],
    [() => new Response('x'.repeat(256 * 1024 + 1)), 'MARKETPLACE_PROTOCOL', 200],
    [() => Response.json({types: [{type: 'bad', audience: 'PUBLIC'}]}), 'MARKETPLACE_PROTOCOL', 200],
  ]) {
    fetchResponse = respond;
    await assert.rejects(readEventCatalog(origin), error => {
      assert.ok(error instanceof MarketplaceApiError);
      assert.equal(error.code, code);
      assert.equal(error.httpStatus, status);
      assert.doesNotMatch(error.message, /private .* diagnostic/);
      return true;
    });
  }
});

async function listenerFixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'marketplace-event-catalog-'));
  t.after(() => rm(home, {recursive:true, force:true}));
  const errors = [];
  t.mock.method(process.stderr, 'write', text => { errors.push(String(text)); return true; });
  const listen = () => runListener(['--home', home, '--types', 'task.published', '--', process.execPath], {});
  return {listen, errors};
}

test('persistent discovery retries throttling and a body timeout after headers, then stops on malformed JSON', {timeout:10_000}, async t => {
  const {listen, errors} = await listenerFixture(t);
  let calls = 0;
  // Simulate the real fetch binding a response body to its 15s timeout signal.
  let timeout;
  t.mock.method(AbortSignal, 'timeout', () => { timeout = new AbortController(); return timeout.signal; });
  t.mock.method(globalThis, 'fetch', (_url, {signal}) => {
    if (++calls === 1) return new Response(null, {status:429});
    if (calls === 3) return new Response('malformed');
    return new Response(new ReadableStream({start(controller) {
      controller.enqueue(Buffer.from('{"types":'));
      signal.addEventListener('abort', () => controller.error(signal.reason), {once:true});
      queueMicrotask(() => timeout.abort(new DOMException('private transport timeout', 'TimeoutError')));
    }}));
  });
  await assert.rejects(listen(), {code:'MARKETPLACE_PROTOCOL',httpStatus:200});
  assert.equal(calls, 3);
  assert.equal(errors.filter(line => line.includes('Retrying discovery')).length, 2);
  assert.doesNotMatch(errors.join(''), /private transport timeout/);
});

test('shutdown during public catalog discovery is silent', async t => {
  const home = await mkdtemp(join(tmpdir(), 'marketplace-catalog-stop-'));
  t.after(() => rm(home, {recursive:true, force:true}));
  // Deliver the signal in a separate process so the test runner's own SIGTERM handler stays installed.
  const {stderr} = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import {runListener} from ${JSON.stringify(new URL('../dist/event-listener.js', import.meta.url).href)};
    globalThis.fetch = (_url, {signal}) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {once:true});
      queueMicrotask(() => process.emit('SIGTERM'));
    });
    await runListener(['--home', process.argv[1], '--types', 'task.published', '--', process.execPath], {});
  `, home], {timeout:10_000});
  assert.doesNotMatch(stderr, /Retrying discovery/);
});
