import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { interruptCli, sigintHarness } from './support/signals.mjs';
import { AttoBlock, AttoMnemonic, AttoPublicKey, AttoTransaction, AttoWork } from '@attocash/commons-core';
import { AttoNodeClientAsyncBuilder } from '@attocash/commons-node-remote';
const applicationUrl = process.env.ATTO_TEST_CLI_PACKAGE_DIR
  ? pathToFileURL(join(process.env.ATTO_TEST_CLI_PACKAGE_DIR, 'dist/application/app.js'))
  : new URL('../dist/application/app.js', import.meta.url);
const { AttoApplication } = await import(applicationUrl.href);
const { retryNetwork } = await import(new URL('../network/retry.js', applicationUrl).href);

test('Commons request timeouts retry through its public error contract', { timeout: 10_000 }, async t => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    if (requests > 1) { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const client = new AttoNodeClientAsyncBuilder(`http://127.0.0.1:${server.address().port}`).build();
  const retries = [];
  const result = await retryNetwork(() => client.accountByPublicKey(new AttoPublicKey(new Int8Array(32).fill(17))), {
    signal: AbortSignal.timeout(5000), onRetry: error => retries.push(error.code),
  });
  assert.equal(result, null);
  assert.equal(requests, 2);
  assert.deepEqual(retries, ['NODE_TIMEOUT']);
});

// LOCAL work is inexpensive and depends on the previous block, not the generated
// mnemonic. Use Commons verification rather than substituting signature/work checks.
function validWork(block) {
  const candidate = AttoWork.Companion.parse('914C000000000000');
  if (candidate.isValid(block)) return candidate;
  for (let nonce = 0; nonce < 1_000_000; nonce++) {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setUint32(0, nonce, true);
    const work = new AttoWork(new Int8Array(bytes.buffer));
    if (work.isValid(block)) return work;
  }
  throw new Error('Could not generate bounded synthetic LOCAL work.');
}

async function fixture(t, mode, sendRetry) {
  const directory = await mkdtemp(join(tmpdir(), 'atto-send-failure-'));
  let phrase;
  const secrets = { get: async () => phrase ?? null, set: async value => { phrase = value; } };
  let app = new AttoApplication({ directory, secrets, sendRetry });
  const created = await app.createWallet((await AttoMnemonic.generate()).phrase);
  const sender = created.addresses[0];
  const recipient = await app.call('address_derive', { index: 1 });
  const account = {
    network: 'LOCAL', version: 0, algorithm: 'V1', publicKey: sender.publicKey,
    height: 3, balance: 1000, lastTransactionHash: '11'.repeat(32),
    lastTransactionTimestamp: 1704616009211, representativeAlgorithm: 'V1', representativePublicKey: sender.publicKey,
  };
  const request = { destination: recipient.address, amount: '10', unit: 'RAW', requestId: 'journal-payment' };
  const state = { mode, requests: [], workJournal: [], publicationJournal: [], published: [], showPublished: false, serverError: undefined };
  const http = createServer((req, res) => {
    state.requests.push({ method: req.method, path: req.url });
    const handle = async () => {
      let body = '';
      for await (const chunk of req) body += chunk;
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === `/accounts/${sender.publicKey}`) {
        if (state.mode === 'account-failure') { res.statusCode = 503; return res.end(); }
        if (state.mode === 'account-client-failure') { res.statusCode = 429; return res.end(); }
        return res.end(JSON.stringify(account));
      }
      if (req.method === 'POST' && req.url === '/accounts') {
        if (state.mode === 'open-failure') { res.statusCode = 503; return res.end(); }
        if (state.mode === 'open-client-failure') { res.statusCode = 400; return res.end('private-server-message'); }
        return res.end(JSON.stringify([account]));
      }
      if (req.url.startsWith('/instants/')) {
        if (state.mode === 'time-failure') { res.statusCode = 503; return res.end(); }
        if (state.mode === 'time-client-failure') { res.statusCode = 401; return res.end(); }
        const now = new Date().toISOString();
        return res.end(JSON.stringify({ clientInstant: now, serverInstant: now, differenceMillis: 0 }));
      }
      if (req.method === 'POST' && req.url === '/works') {
        const record = app.ledger.get(request.requestId);
        state.workJournal.push(structuredClone(record));
        if (state.mode === 'work-failure') { res.statusCode = 503; return res.end(); }
        if (state.mode === 'work-client-failure') { res.statusCode = 403; return res.end(); }
        const block = AttoBlock.fromJson(record.blockJson);
        // Commons may prefetch work for the next block. It is unrelated to this
        // send and is rejected immediately rather than computed by the fixture.
        if (JSON.parse(body).target !== block.previous.toString()) { res.statusCode = 503; return res.end(); }
        return res.end(JSON.stringify({ work: validWork(block).toString() }));
      }
      if (req.method === 'POST' && req.url === '/transactions/stream') {
        state.publicationJournal.push(structuredClone(app.ledger.get(request.requestId)));
        const transaction = AttoTransaction.fromJson(body);
        assert.equal(await transaction.isValid(), true, 'Publication must carry an actual valid Commons signature and work.');
        state.published.push(transaction);
        if (state.mode === 'success') return res.end(`${transaction.toJson()}\n`);
        if (state.mode === 'publish-client-failure') { res.statusCode = 422; return res.end(); }
        if (state.mode === 'publish-disconnect') return req.socket.destroy();
        // The response fails after a valid transaction reached the node boundary.
        // Whether it was committed is intentionally unknown to the application.
        res.statusCode = 503;
        return res.end();
      }
      if (req.method === 'GET' && req.url.startsWith('/transactions/')) {
        const transaction = state.published.find(value => req.url === `/transactions/${value.hash}`);
        if (state.showPublished && transaction) return res.end(transaction.toJson());
      }
      // Missing exact-height evidence closes promptly; a 404 never proves rejection.
      res.statusCode = 404;
      res.end();
    };
    void handle().catch(error => {
      state.serverError = error;
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const url = `http://127.0.0.1:${http.address().port}`;
  t.after(async () => {
    await app.close();
    http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
    phrase = undefined;
    await rm(directory, { recursive: true, force: true });
    assert.equal(state.serverError, undefined);
  });
  await app.call('wallet_configure', { network: 'LOCAL', nodeUrl: url, workerUrl: url, representative: sender.address, autoReceive: false });
  app.ledger.setPolicy({ perRequest: null, rolling: [{ days: 1, amount: '100', unit: 'RAW' }] });
  return {
    get app() { return app; }, directory, request, state,
    async reopen() { await app.close(); app = new AttoApplication({ directory, secrets, sendRetry }); return app; },
  };
}

for (const mode of ['open-failure', 'time-failure']) {
  test(`send failure before signing (${mode}) releases the reservation and cannot retry the failed ID`, { timeout: 10_000 }, async t => {
    const f = await fixture(t, mode);
    await assert.rejects(f.app.call('send', f.request));
    const failed = f.app.ledger.get(f.request.requestId);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.hash, undefined);
    const allowance = await f.app.call('limits_get');
    assert.equal(allowance.pendingRaw, '0');
    assert.equal(allowance.rolling[0].remainingRaw, '100');
    assert.equal(f.state.workJournal.length, 0);
    assert.equal(f.state.published.length, 0);
    const attempts = f.state.requests.length;
    await assert.rejects(f.app.call('send', f.request), { code: 'REQUEST_FAILED' });
    assert.equal(f.state.requests.length, attempts);
    await f.reopen();
    assert.equal(f.app.ledger.get(f.request.requestId).status, 'failed');
    await assert.rejects(f.app.call('send', f.request), { code: 'REQUEST_FAILED' });
  });
}

test('worker failure after signing retains the hash and reservation across retries and application restart', { timeout: 10_000 }, async t => {
  const f = await fixture(t, 'work-failure');
  await assert.rejects(f.app.call('send', f.request), { code: 'PUBLICATION_UNCERTAIN' });
  assert.equal(f.state.workJournal.length, 1);
  assert.equal(f.state.workJournal[0].status, 'signed');
  const original = f.app.ledger.get(f.request.requestId);
  assert.equal(original.status, 'unknown');
  assert.match(original.hash, /^[A-F0-9]{64}$/);
  assert.equal(AttoBlock.fromJson(original.blockJson).hash.toString(), original.hash);
  assert.equal(f.state.published.length, 0);
  await f.reopen();
  const allowance = await f.app.call('limits_get');
  assert.equal(allowance.pendingRaw, '10');
  assert.equal(allowance.rolling[0].remainingRaw, '90');
  await assert.rejects(f.app.call('send', f.request), { code: 'PUBLICATION_UNCERTAIN' });
  assert.equal(f.app.ledger.get(f.request.requestId).hash, original.hash);
  assert.equal(f.state.workJournal.length, 1, 'Same-ID retries must not sign or request work again.');
  assert.equal(f.state.published.length, 0);
  await assert.rejects(f.app.call('send', { ...f.request, requestId: 'over-budget', amount: '100' }), { code: 'SPENDING_LIMIT' });
});

for (const mode of ['account-failure', 'open-failure', 'time-failure', 'work-failure', 'publish-failure', 'publish-disconnect']) {
  test(`automatic send recovers from ${mode} with one request and one block`, { timeout: 20_000 }, async t => {
    const controller = new AbortController();
    t.after(() => controller.abort());
    const retries = [];
    const f = await fixture(t, mode, { signal: controller.signal, onRetry: (error, delayMs) => {
      retries.push({ error, delayMs });
      f.state.mode = 'success';
    } });
    const result = await f.app.call('send', f.request);
    assert.equal(result.status, 'published');
    assert.equal(result.requestId, f.request.requestId);
    assert.equal(retries.length, 1);
    assert.equal(retries[0].delayMs, 1000);
    assert.equal(new Set(f.state.published.map(tx => tx.hash.toString())).size, 1);
    assert.equal(new Set(f.state.published.map(tx => tx.toJson())).size, 1);
    assert.equal(f.state.published.length, mode.startsWith('publish-') ? 2 : 1);
    assert.equal(f.app.ledger.journalList().items.length, 1);
    assert.equal(f.app.ledger.get(f.request.requestId).status, 'published');
    assert.equal((await f.app.call('limits_get')).rolling[0].publishedRaw, '10');
  });
}

for (const mode of ['account-client-failure', 'open-client-failure', 'time-client-failure', 'work-client-failure', 'publish-client-failure']) {
  test(`automatic send stops on HTTP 4xx at ${mode}`, { timeout: 10_000 }, async t => {
    const f = await fixture(t, mode, { signal: new AbortController().signal, onRetry: () => assert.fail('4xx must not retry') });
    await assert.rejects(f.app.call('send', f.request), error => {
      assert.ok(['NODE_HTTP_ERROR', 'NODE_CLIENT_ERROR', 'WORK_FAILED'].includes(error.code), error.code);
      assert.doesNotMatch(JSON.stringify(error), /private-server-message/);
      return true;
    });
    assert.ok(f.state.published.length <= 1);
    if (mode === 'publish-client-failure' || mode === 'work-client-failure') {
      assert.equal(f.app.ledger.get(f.request.requestId).status, 'unknown');
      assert.equal(f.app.ledger.usage().pendingRaw, '10');
    }
  });
}

test('automatic publication retry recognizes confirmation after a lost response without republishing', { timeout: 15_000 }, async t => {
  const f = await fixture(t, 'publish-failure', { signal: new AbortController().signal, onRetry: () => { f.state.showPublished = true; } });
  const result = await f.app.call('send', f.request);
  assert.equal(result.status, 'published');
  assert.equal(result.hash, f.state.published[0].hash.toString());
  assert.equal(f.state.published.length, 1);
});

test('cancelling publication backoff keeps the original reservation and stops further attempts', { timeout: 10_000 }, async t => {
  const controller = new AbortController();
  const f = await fixture(t, 'publish-failure', { signal: controller.signal, onRetry: () => controller.abort() });
  await assert.rejects(f.app.call('send', f.request), { code: 'CANCELLED' });
  assert.equal(f.state.published.length, 1);
  assert.equal(f.app.ledger.get(f.request.requestId).status, 'unknown');
  assert.equal(f.app.ledger.usage().pendingRaw, '10');
});

test('a tightened spending policy during backoff prevents another publication', { timeout: 15_000 }, async t => {
  const f = await fixture(t, 'publish-failure', { signal: new AbortController().signal, onRetry: () => {
    f.state.mode = 'success';
    f.app.ledger.setPolicy({ perRequest: { amount: '1', unit: 'RAW' }, rolling: [] });
  } });
  await assert.rejects(f.app.call('send', f.request), { code: 'SPENDING_LIMIT' });
  assert.equal(f.state.published.length, 1);
  assert.equal(f.app.ledger.usage().pendingRaw, '10');
});

for (const json of [false, true]) {
  for (const mode of ['account-failure', 'account-client-failure']) {
    test(`real CLI ${json ? 'JSON' : 'plain'} send ${mode === 'account-failure' ? 'cancels retry on SIGINT' : 'stops on 429'} and retains its generated ID`, { timeout: 15_000 }, async t => {
      const f = await fixture(t, mode);
      const harness = `
        ${sigintHarness}
        const { OsSecretStore } = await import(process.env.ATTO_TEST_SECRETS_MODULE);
        let secretAccesses = 0;
        OsSecretStore.prototype.get = async () => { secretAccesses++; throw new Error('No keyring access in this test.'); };
        process.argv = [process.execPath, 'atto', ...JSON.parse(process.env.ATTO_TEST_ARGUMENTS)];
        await import(process.env.ATTO_TEST_MAIN);
        process.send({ secretAccesses, sigintListeners: process.listenerCount('SIGINT'), sigtermListeners: process.listenerCount('SIGTERM') });
        process.disconnect();
      `;
      const child = spawn(process.execPath, ['--input-type=module', '--eval', harness], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1',
          ATTO_TEST_SECRETS_MODULE: new URL('../storage/secrets.js', applicationUrl).href,
          ATTO_TEST_MAIN: new URL('../cli/main.js', applicationUrl).href,
          ATTO_TEST_ARGUMENTS: JSON.stringify(['--data-dir', f.directory, ...(json ? ['--json'] : []), 'send', f.request.destination, '10', '--unit', 'RAW']),
        },
      });
      t.after(() => child.kill('SIGKILL'));
      let stdout = '', stderr = '', trace;
      let interrupted = false;
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => {
        stderr += chunk;
        if (!interrupted && /Retrying in|retryInMs/.test(stderr)) { interrupted = true; interruptCli(child); }
      });
      child.on('message', message => { trace = message; });
      const [code, signal] = await once(child, 'close');
      assert.equal(code, 1);
      assert.equal(signal, null);
      assert.deepEqual(trace, { secretAccesses: 0, sigintListeners: 0, sigtermListeners: 0 });
      const id = stderr.match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/)?.[0];
      assert.ok(id, 'The generated ID must be visible before any retry.');
      assert.equal(interrupted, mode === 'account-failure');
      assert.equal(f.state.requests.length, 1);
      if (json) {
        assert.equal(stdout.trim().split('\n').length, 1);
        const result = JSON.parse(stdout);
        assert.equal(result.error.code, interrupted ? 'CANCELLED' : 'NODE_HTTP_ERROR');
        assert.equal(result.error.details.requestId, id);
      } else {
        assert.equal(stdout, '');
        assert.match(stderr, interrupted ? /Send cancelled/ : /HTTP 429/);
        assert.doesNotMatch(stderr, /\{"(?:error|progress)"/);
      }
    });
  }
}

test('an uncertain publication reconciles its captured valid transaction without sending again', { timeout: 20_000 }, async t => {
  const f = await fixture(t, 'publish-failure');
  await assert.rejects(f.app.call('send', f.request), { code: 'PUBLICATION_UNCERTAIN' });
  assert.equal(f.state.published.length, 1);
  const published = f.state.published[0];
  assert.equal(await published.isValid(), true);
  assert.equal(f.state.publicationJournal[0].status, 'signed');
  assert.equal(f.state.publicationJournal[0].hash, published.hash.toString());
  const initialWorkRequests = f.state.workJournal.length;
  const pending = await f.app.call('limits_get');
  assert.equal(pending.pendingRaw, '10');
  assert.equal(pending.rolling[0].remainingRaw, '90');
  await assert.rejects(f.app.call('send', f.request), { code: 'PUBLICATION_UNCERTAIN' });
  assert.equal(f.state.published.length, 1);
  await f.reopen();
  f.state.showPublished = true;
  const resolved = await f.app.call('send', f.request);
  assert.equal(resolved.status, 'published');
  assert.equal(resolved.hash, published.hash.toString());
  assert.equal(resolved.requestId, f.request.requestId);
  assert.equal(f.app.ledger.get(f.request.requestId).status, 'published');
  const settled = await f.app.call('limits_get');
  assert.equal(settled.pendingRaw, '0');
  assert.equal(settled.rolling[0].publishedRaw, '10');
  assert.equal(settled.rolling[0].remainingRaw, '90');
  assert.deepEqual(await f.app.call('send', f.request), resolved);
  await assert.rejects(f.app.call('send', { ...f.request, amount: '11' }), { code: 'REQUEST_CONFLICT' });
  assert.equal(f.state.workJournal.length, initialWorkRequests, 'Retries must not request further work.');
  assert.equal(f.state.published.length, 1, 'Reconciliation must never perform a second publication.');
});
