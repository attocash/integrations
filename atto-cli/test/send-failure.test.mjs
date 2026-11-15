import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { interruptCli, sigintHarness } from './support/signals.mjs';
import { AttoAccount, AttoBlock, AttoMnemonic, AttoPublicKey, AttoTransaction, AttoWork, attoAccountChange } from '@attocash/commons-core';
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
  const state = { mode, requests: [], workJournal: [], publicationJournal: [], offered: [], published: [], showPublished: false, serverError: undefined };
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
        if (state.mode === 'hold-work') return;
        const input = JSON.parse(body);
        const current = AttoAccount.fromJson(JSON.stringify(account));
        const block = attoAccountChange(current, current.representativeAddress, new Date(input.timestamp).toISOString()).block;
        // Commons may prefetch work for the next block. It is unrelated to this
        // send and is rejected immediately rather than computed by the fixture.
        if (JSON.parse(body).target !== block.previous.toString()) { res.statusCode = 503; return res.end(); }
        return res.end(JSON.stringify({ work: validWork(block).toString() }));
      }
      if (req.method === 'POST' && req.url === '/transactions/stream') {
        // Read a separate SQLite connection at the actual HTTP boundary: no in-memory journal substitute.
        const db = new DatabaseSync(join(directory, 'state.sqlite'), { readOnly: true });
        let durable;
        try { durable = JSON.parse(db.prepare('SELECT value FROM settings WHERE key = ?').get('spending.records').value).find(value => value.id === request.requestId); }
        finally { db.close(); }
        state.publicationJournal.push(durable);
        const transaction = AttoTransaction.fromJson(body);
        assert.equal(await transaction.isValid(), true, 'Publication must carry an actual valid Commons signature and work.');
        assert.equal(durable.transactionJson, body, 'The exact offered signature/work/block must be committed before HTTP.');
        assert.equal(durable.hash, transaction.hash.toString());
        state.offered.push(transaction);
        if (state.mode === 'before-forward') return;
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
    get app() { return app; }, phrase: () => phrase, directory, request, state,
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

test('work failure before candidate persistence is never recorded as signed or offered for publication', { timeout: 10_000 }, async t => {
  // Given a wallet whose worker fails before a complete native candidate exists.
  const f = await fixture(t, 'work-failure');
  // When work fails and the wallet is reopened.
  await assert.rejects(f.app.call('send', f.request));
  const original = f.app.ledger.get(f.request.requestId);
  await f.reopen();
  // Then there is no misleading signed hash and no publication or uncertain debit.
  assert.equal(f.state.workJournal[0].status, 'reserved');
  assert.equal(original.status, 'failed');
  assert.equal(original.hash, undefined);
  assert.equal(original.transactionJson, undefined);
  assert.equal(f.state.offered.length, 0);
  assert.equal((await f.app.call('limits_get')).pendingRaw, '0');
  await assert.rejects(f.app.call('send', f.request), { code: 'REQUEST_FAILED' });
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
    if (mode === 'publish-client-failure') {
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

test('explicit replay retains exact bytes through repeated uncertainty and canonical confirmation completes without duplicate publication', { timeout: 20_000 }, async t => {
  // Given an unresolved, fully retained valid transaction and the original request metadata.
  const f = await fixture(t, 'publish-failure');
  await assert.rejects(f.app.call('send', f.request), { code: 'PUBLICATION_UNCERTAIN' });
  const original = f.app.ledger.get(f.request.requestId);
  const initialWorkRequests = f.state.workJournal.length;
  // When observation, restart and an explicit original-request retry occur before confirmation is visible.
  await f.reopen();
  assert.equal((await f.app.call('limits_get')).pendingRaw, '10');
  assert.equal(f.state.offered.length, 1, 'Limits/reconciliation never publish.');
  await assert.rejects(f.app.call('send', f.request), { code: 'PUBLICATION_UNCERTAIN' });
  assert.equal(f.state.offered.length, 2);
  assert.equal(f.app.ledger.get(f.request.requestId).transactionJson, original.transactionJson);
  await f.reopen();
  f.state.showPublished = true;
  const resolved = await f.app.call('send', f.request);
  // Then the one reservation completes from canonical proof, without new work or another publication.
  assert.equal(resolved.status, 'published');
  assert.equal(resolved.hash, original.hash);
  assert.equal(resolved.requestId, f.request.requestId);
  assert.equal((await f.app.call('limits_get')).rolling[0].publishedRaw, '10');
  assert.deepEqual(await f.app.call('send', f.request), resolved);
  await assert.rejects(f.app.call('send', { ...f.request, amount: '11' }), { code: 'REQUEST_CONFLICT' });
  assert.equal(f.state.workJournal.length, initialWorkRequests);
  assert.deepEqual(f.state.offered.map(value => value.toJson()), [original.transactionJson, original.transactionJson]);
});

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'Expected the held native boundary.'); await delay(10); }
}
function childSend(t, f) {
  const harness = `
    const { OsSecretStore } = await import(process.env.ATTO_TEST_SECRETS_MODULE);
    OsSecretStore.prototype.get = async () => process.env.ATTO_TEST_PHRASE;
    process.argv = [process.execPath, 'atto', '--data-dir', process.env.ATTO_TEST_DIRECTORY, '--json', 'send',
      process.env.ATTO_TEST_DESTINATION, '10', '--unit', 'RAW', '--request-id', 'journal-payment'];
    await import(process.env.ATTO_TEST_MAIN);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', harness], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_UPDATE_NOTIFIER: '1',
      ATTO_TEST_SECRETS_MODULE: new URL('../storage/secrets.js', applicationUrl).href,
      ATTO_TEST_MAIN: new URL('../cli/main.js', applicationUrl).href,
      ATTO_TEST_PHRASE: f.phrase(), ATTO_TEST_DIRECTORY: f.directory, ATTO_TEST_DESTINATION: f.request.destination },
  });
  child.stdout.resume(); child.stderr.resume();
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  return child;
}

for (const boundary of ['before-forward', 'hold-work']) {
  test(`process death at ${boundary} resumes the original request safely`, { timeout: 20_000 }, async t => {
    // Given an actual CLI process held at either the pre-persistence work boundary or pre-forward HTTP boundary.
    const f = await fixture(t, boundary);
    const child = childSend(t, f);
    await until(() => boundary === 'before-forward' ? f.state.offered.length === 1 : f.state.workJournal.length === 1);
    const original = f.app.ledger.get(f.request.requestId);
    // When the process dies and a new session retries the exact original request/settings.
    const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
    f.state.mode = 'success';
    await f.reopen();
    const result = await f.app.call('send', f.request);
    // Then exactly one native SEND is forwarded and the durable operation/budget remains singular.
    assert.equal(result.requestId, original.id);
    assert.equal(f.state.published.length, 1);
    assert.equal(f.app.ledger.journalList().items.length, 1);
    assert.equal((await f.app.call('limits_get')).rolling[0].publishedRaw, '10');
    if (boundary === 'before-forward') {
      assert.equal(result.hash, original.hash);
      assert.equal(f.state.published[0].toJson(), original.transactionJson);
      assert.deepEqual(f.state.offered.map(value => value.toJson()), [original.transactionJson, original.transactionJson]);
      assert.equal(f.state.workJournal.length, 1);
    } else {
      assert.equal(original.status, 'reserved'); assert.equal(original.hash, undefined);
      assert.equal(original.transactionJson, undefined);
    }
  });
}

test('candidate persistence failure prevents every native publication', async t => {
  // Given a concrete storage failure at the new candidate commit.
  const f = await fixture(t, 'success');
  const set = f.app.store.set.bind(f.app.store);
  f.app.store.set = (key, value) => {
    if (key === 'spending.records' && value.some(record => record.transactionJson)) throw new Error('Synthetic candidate commit failure');
    return set(key, value);
  };
  // When signing/work finish but SQLite cannot retain the complete candidate.
  await assert.rejects(f.app.call('send', f.request), /Synthetic candidate commit failure/);
  f.app.store.set = set;
  // Then HTTP never receives a candidate and no unsigned signed state is left behind.
  assert.equal(f.state.offered.length, 0);
  assert.equal(f.app.ledger.get(f.request.requestId).hash, undefined);
});

for (const mutation of ['signature', 'work', 'block', 'binding', 'metadata', 'oversized']) {
  test(`a corrupt retained ${mutation} fails closed without new work, publication or allowance release`, async t => {
    // Given an uncertain native candidate and corrupted persisted recovery material.
    const f = await fixture(t, 'publish-failure');
    await assert.rejects(f.app.call('send', f.request), { code: 'PUBLICATION_UNCERTAIN' });
    const records = f.app.store.get('spending.records');
    const saved = structuredClone(records[0]);
    const candidate = JSON.parse(records[0].transactionJson);
    if (mutation === 'signature') candidate.signature = '00'.repeat(64);
    if (mutation === 'work') candidate.work = '00'.repeat(8);
    if (['signature', 'work'].includes(mutation)) records[0].transactionJson = JSON.stringify(candidate);
    if (mutation === 'block') records[0].blockJson = records[0].blockJson.replace('10', '11');
    if (mutation === 'binding') records[0].candidateBinding = 'f'.repeat(64);
    if (mutation === 'metadata') records[0].metadata = { altered: true };
    if (mutation === 'oversized') records[0].transactionJson = 'x'.repeat(65_537);
    f.app.store.set('spending.records', records);
    const work = f.state.workJournal.length;
    // When explicit recovery is requested.
    await assert.rejects(f.app.call('send', f.request));
    // Then neither observation nor retry can send a substitute or free the operation.
    assert.equal(f.state.offered.length, 1); assert.equal(f.state.workJournal.length, work);
    assert.notEqual(f.app.store.get('spending.records')[0].status, 'failed');
    f.app.store.set('spending.records', [saved]);
    assert.equal(f.app.ledger.usage().pendingRaw, '10');
  });
}

test('historical block-only candidates remain fenced and canonically recoverable with an explicit replay limitation', async t => {
  // Given an actual uncertain transaction represented in the released block-only journal format.
  const f = await fixture(t, 'publish-failure');
  await assert.rejects(f.app.call('send', f.request), { code: 'PUBLICATION_UNCERTAIN' });
  const records = f.app.store.get('spending.records');
  delete records[0].transactionJson; delete records[0].candidateBinding;
  f.app.store.set('spending.records', records);
  await f.reopen();
  // When the original request cannot yet obtain canonical proof.
  await assert.rejects(f.app.call('send', f.request), error => error.code === 'PUBLICATION_UNCERTAIN' && /historical journal lacks.*signed transaction and work/.test(error.message));
  // Then it retains its old shape, account and amount fence; later canonical proof can complete it.
  assert.equal(f.app.ledger.get(f.request.requestId).transactionJson, undefined);
  assert.equal(f.app.ledger.usage().pendingRaw, '10');
  assert.throws(() => f.app.ledger.assertAccountAvailable(records[0].index), { code: 'ACCOUNT_RESERVED' });
  assert.equal(f.state.offered.length, 1);
  f.state.showPublished = true;
  assert.equal((await f.app.call('send', f.request)).status, 'published');
  assert.equal(f.state.offered.length, 1);
});
