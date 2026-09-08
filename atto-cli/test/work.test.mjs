import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const commonsUrl = pathToFileURL(createRequire(join(cliDirectory, 'package.json')).resolve('@attocash/commons-core')).href;
const {
  AttoAccount, AttoAmount, AttoMnemonic, AttoTransaction, AttoUnit, AttoWork,
  attoAccountChange, attoBlockWorkTarget, toAttoIndex,
} = await import(commonsUrl);
const moduleUrl = name => pathToFileURL(join(cliDirectory, 'dist', name)).href;
const { StateStore } = await import(moduleUrl('storage/state.js'));
const { WalletWork } = await import(moduleUrl('wallet/work.js'));
const { derivedSigner, signingWallet } = await import(moduleUrl('wallet/signing.js'));

const computed = new Map();

function stopped(store) {
  const release = store.tryProcessLock('work-daemon');
  release?.();
  return Boolean(release);
}

async function detachedPrepare(f, accounts = f.state.accounts) {
  const source = `
    import { text } from 'node:stream/consumers';
    import { AttoAccount } from ${JSON.stringify(commonsUrl)};
    import { StateStore } from ${JSON.stringify(moduleUrl('storage/state.js'))};
    import { WalletWork } from ${JSON.stringify(moduleUrl('wallet/work.js'))};
    const store = new StateStore(process.argv[1]);
    const work = new WalletWork(store, () => store.get('settings'), 'detached');
    work.prepare(JSON.parse(await text(process.stdin)).map(AttoAccount.fromJson));
    await work.close(); store.close();
    process.stdout.write('launcher-exited');
  `;
  const execution = promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, f.directory], {
    cwd: new URL('../..', import.meta.url), timeout: 5000,
  });
  const [result] = await Promise.all([
    execution,
    pipeline([JSON.stringify(accounts.map(value => value.toJson()))], execution.child.stdin),
  ]);
  return result;
}
function validWork(block, rejectBlock) {
  const key = `${block.network.name}:${attoBlockWorkTarget(block)}:${block.timestamp.toString().slice(0, 4)}`;
  const cached = computed.get(key);
  if (cached && (!rejectBlock || !cached.isValid(rejectBlock))) return cached;
  for (let nonce = 0; nonce < 1_000_000; nonce++) {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setUint32(0, nonce, true);
    const work = new AttoWork(new Int8Array(bytes.buffer));
    if (work.isValid(block) && (!rejectBlock || !work.isValid(rejectBlock))) {
      computed.set(key, work);
      return work;
    }
  }
  throw new Error('No bounded synthetic LOCAL work found.');
}

function account(publicKey = '22'.repeat(32), head = '11'.repeat(32), height = 3) {
  return AttoAccount.fromJson(JSON.stringify({
    network: 'LOCAL', version: 0, algorithm: 'V1', publicKey,
    height, balance: 1000, lastTransactionHash: head,
    lastTransactionTimestamp: 1704616009211, representativeAlgorithm: 'V1', representativePublicKey: publicKey,
  }));
}

function nextBlock(value, timestamp = new Date().toISOString()) {
  return attoAccountChange(value, value.representativeAddress, timestamp).block;
}

async function until(predicate, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Expected observable condition before deadline.');
    await delay(10);
  }
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'atto work-'));
  const store = new StateStore(directory);
  const state = { accounts: [account()], workRequests: [], publications: [], blocked: false, invalid: false, fail: false, publishFail: false, redirectRequests: 0 };
  const http = createServer((request, response) => {
    const run = async () => {
      let body = '';
      for await (const chunk of request) body += chunk;
      response.setHeader('content-type', 'application/json');
      if (request.url === '/accounts') return response.end(`[${state.accounts.map(value => value.toJson()).join(',')}]`);
      if (request.url.startsWith('/instants/')) {
        const now = new Date().toISOString();
        return response.end(JSON.stringify({ clientInstant: now, serverInstant: now, differenceMillis: 0 }));
      }
      if (request.url === '/redirect') { state.redirectRequests++; return response.end('{}'); }
      if (request.url === '/works') {
        const input = JSON.parse(body);
        const source = state.accounts.find(value => value.lastTransactionHash.toString() === input.target);
        assert.ok(source, 'Work must refer to a known public account head.');
        const block = nextBlock(source, new Date(input.timestamp).toISOString());
        const reply = () => {
          if (state.fail) { response.statusCode = 503; return response.end(); }
          if (state.redirect) {
            response.statusCode = 307;
            response.setHeader('location', '/redirect');
            return response.end();
          }
          if (state.response !== undefined) return response.end(state.response);
          const work = state.invalid ? '0000000000000000' : validWork(block).toString();
          response.end(JSON.stringify({ work }));
        };
        state.workRequests.push({ input, reply, socket: request.socket });
        if (!state.blocked) reply();
        return;
      }
      if (request.url === '/transactions/stream') {
        const transaction = AttoTransaction.fromJson(body);
        assert.equal(await transaction.isValid(), true);
        state.publications.push(transaction);
        if (state.publishFail) { response.statusCode = 503; return response.end(); }
        response.setHeader('content-type', 'application/x-ndjson');
        return response.end(`${transaction.toJson()}\n`);
      }
      response.statusCode = 404;
      response.end();
    };
    void run().catch(error => { state.error = error; response.statusCode = 500; response.end(); });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const url = `http://127.0.0.1:${http.address().port}`;
  const settings = { network: 'LOCAL', nodeUrl: url, workerUrl: url, representative: state.accounts[0].representativeAddress.value, autoReceive: false, minReceiveRaw: '1' };
  store.set('settings', settings);
  const work = new WalletWork(store, () => settings);
  t.after(async () => {
    await work.cancel();
    http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
    assert.equal(state.error, undefined);
  });
  return { directory, store, state, settings, work };
}

test('prepared public work survives reopening state and is reused without a second worker request', async t => {
  // Given a public account and an initially empty persistent cache.
  const f = await fixture(t);
  const source = f.state.accounts[0];
  assert.equal(f.work.isReady(source), false);

  // When one owner prepares its current head and another opens the same profile.
  f.work.prepare([source]);
  // The synthetic worker computes real proof of work; parallel suites can
  // consume the shorter default wait before its first response is processed.
  await until(() => f.work.isReady(source), 10_000);
  const script = `
    import { AttoAccount, attoAccountChange } from ${JSON.stringify(commonsUrl)};
    import { StateStore } from ${JSON.stringify(moduleUrl('storage/state.js'))};
    import { WalletWork } from ${JSON.stringify(moduleUrl('wallet/work.js'))};
    const store = new StateStore(process.argv[1]);
    const account = AttoAccount.fromJson(process.argv[2]);
    const work = new WalletWork(store, () => JSON.parse(process.argv[3]));
    const block = attoAccountChange(account, account.representativeAddress, new Date().toISOString()).block;
    const result = await work.worker().workBlock(block);
    process.stdout.write(JSON.stringify({ready: work.isReady(account), valid: result.isValid(block)}));
    await work.close(); store.close();
  `;
  const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, f.directory, source.toJson(), JSON.stringify(f.settings)], {
    cwd: new URL('../..', import.meta.url), timeout: 5000,
  });

  // Then the verified public work is shared and contains no recovery material.
  assert.deepEqual(JSON.parse(child.stdout), { ready: true, valid: true });
  assert.equal(f.state.workRequests.length, 1);
  const record = f.store.get(`work.LOCAL.${source.publicKey}`);
  assert.deepEqual(Object.keys(record).sort(), ['height', 'scope', 'target', 'work']);
});

test('readiness rejects a changed account head, network, corrupted work, and work below the current threshold', async t => {
  // Given genuine work prepared for an account's current head.
  const f = await fixture(t);
  const source = f.state.accounts[0];
  await f.work.worker().workBlock(nextBlock(source));
  const key = `work.LOCAL.${source.publicKey}`;
  const ready = f.store.get(key);

  // When the head, configured network, persisted bytes, or threshold changes.
  const newHead = account(source.publicKey.toString(), '33'.repeat(32), 4);
  assert.equal(f.work.isReady(newHead), false);
  f.settings.network = 'LIVE';
  assert.equal(f.work.isReady(source), false);
  f.settings.network = 'LOCAL';
  f.store.set(key, { ...ready, work: 'not-work' });
  assert.equal(f.work.isReady(source), false);
  const current = nextBlock(source);
  const older = nextBlock(source, '2024-01-08T00:00:00Z');
  const expired = validWork(older, current);
  f.store.set(key, { ...ready, work: expired.toString() });

  // Then validity comes from Commons for this target and time, not cache presence.
  assert.equal(expired.isValid(older), true);
  assert.equal(expired.isValid(current), false);
  assert.equal(f.work.isReady(source), false);
});

test('preparation bounds concurrent work and continues queued accounts as requests finish', async t => {
  // Given three pool accounts and a worker that holds requests open.
  const f = await fixture(t);
  f.state.accounts = [account(), account('44'.repeat(32), '33'.repeat(32)), account('66'.repeat(32), '55'.repeat(32))];
  f.state.blocked = true;

  // When the pool is prepared, including duplicate preparation requests.
  f.work.prepare(f.state.accounts);
  f.work.prepare(f.state.accounts);
  await until(() => f.state.workRequests.length === 2);
  await delay(30);
  assert.equal(f.state.workRequests.length, 2);
  f.state.workRequests[0].reply();
  await until(() => f.state.workRequests.length === 3);
  f.state.workRequests[1].reply();
  f.state.workRequests[2].reply();

  // Then every account becomes ready with one request per distinct head.
  await until(() => f.state.accounts.every(value => f.work.isReady(value)));
  assert.equal(f.state.workRequests.length, 3);
});

test('an older preparation completion cannot replace work already stored for a newer account head', async t => {
  // Given two observed heads for the same account and independently delayed jobs.
  const f = await fixture(t);
  const old = f.state.accounts[0];
  const newer = account(old.publicKey.toString(), '33'.repeat(32), 4);
  f.state.accounts.push(newer);
  f.state.blocked = true;
  f.work.prepare([old]);
  f.work.prepare([newer]);
  await until(() => f.state.workRequests.length === 2);

  // When the newer head completes first and the obsolete job completes later.
  f.state.workRequests[1].reply();
  await until(() => f.work.isReady(newer));
  f.state.workRequests[0].reply();
  await f.work.worker().workBlock(nextBlock(old));

  // Then the persisted cache still serves the newer head.
  assert.equal(f.work.isReady(newer), true);
  assert.equal(f.work.isReady(old), false);
});

test('invalid remote work is rejected and later preparation can obtain valid work', async t => {
  // Given a worker responding with invalid work for this verified target.
  const f = await fixture(t);
  const source = f.state.accounts[0];
  assert.equal(AttoWork.Companion.parse('0000000000000000').isValid(nextBlock(source)), false);
  f.state.invalid = true;

  // When preparation fails and a later request reaches a functioning worker.
  await assert.rejects(f.work.worker().workBlock(nextBlock(source)), { code: 'INVALID_WORK' });
  assert.equal(f.work.isReady(source), false);
  f.state.invalid = false;
  f.work.prepare([source]);

  // Then failure is not persisted as usable work and the next attempt succeeds.
  await until(() => f.work.isReady(source));
  assert.equal(f.state.workRequests.length, 2);
});

for (const [name, mode, code] of [
  ['an HTTP error', { fail: true }, 'WORK_FAILED'],
  ['a redirect', { redirect: true }, 'WORK_FAILED'],
  ['malformed JSON', { response: '{' }, 'INVALID_WORK'],
  ['a non-string nonce', { response: '{"work":42}' }, 'INVALID_WORK'],
  ['an oversized response', { response: JSON.stringify({ work: '0000000000000000', extra: 'x'.repeat(2048) }) }, 'INVALID_WORK'],
]) {
  test(`worker transport rejects ${name} without persisting or forwarding it`, async t => {
    // Given an untrusted worker response at an isolated endpoint.
    const f = await fixture(t);
    const source = f.state.accounts[0];
    Object.assign(f.state, mode);

    // When requesting public work for a known account head.
    await assert.rejects(f.work.worker().workBlock(nextBlock(source)), { code });

    // Then neither cache state nor a redirect target receives accepted data.
    assert.equal(f.work.isReady(source), false);
    assert.equal(f.store.get(`work.LOCAL.${source.publicKey}`), undefined);
    assert.equal(f.state.redirectRequests, 0);
  });
}

test('closing during preparation forbids late persistence and further work requests', async t => {
  // Given an unfinished background request and a signing worker borrowing it.
  const f = await fixture(t);
  const source = f.state.accounts[0];
  f.state.blocked = true;
  f.work.prepare([source]);
  await until(() => f.state.workRequests.length === 1);
  const borrowed = f.work.worker();
  borrowed.close();
  assert.equal(f.work.isReady(source), false);

  // When the lifecycle owner closes before the request completes.
  await f.work.close();
  await until(() => f.state.workRequests[0].socket.destroyed);
  f.state.workRequests[0].reply();

  // Then the late response cannot touch the closed profile or restart work.
  assert.equal(f.store.get(`work.LOCAL.${source.publicKey}`), undefined);
  await assert.rejects(borrowed.workBlock(nextBlock(source)), { code: 'WORK_CLOSED' });
  f.work.prepare([source]);
  assert.equal(f.state.workRequests.length, 1);
});

test('the background deadline cancels an unresponsive worker request', { timeout: 15_000 }, async t => {
  // Given a real loopback worker that accepts the request without replying.
  const f = await fixture(t);
  const source = f.state.accounts[0];
  f.state.blocked = true;
  const started = Date.now();
  f.work.prepare([source]);
  await until(() => f.state.workRequests.length === 1);

  // When the speculative work deadline expires without a response.
  await until(() => f.state.workRequests[0].socket.destroyed, 12_000);
  await f.work.close();

  // Then the deadline releases shutdown and no incomplete work is persisted.
  assert.ok(Date.now() - started < 12_000);
  assert.equal(f.store.get(`work.LOCAL.${source.publicKey}`), undefined);
});

test('foreground work gets its normal request after an awaited speculative request times out', { timeout: 15_000 }, async t => {
  // Given a background job stalled at a real worker and a foreground consumer.
  const f = await fixture(t);
  const source = f.state.accounts[0];
  f.state.blocked = true;
  f.work.prepare([source]);
  await until(() => f.state.workRequests.length === 1);
  const result = f.work.worker().workBlock(nextBlock(source));

  // When the shorter speculative deadline expires, the foreground budget applies.
  await until(() => f.state.workRequests.length === 2, 12_000);
  await until(() => f.state.workRequests[0].socket.destroyed);
  f.state.workRequests[1].reply();
  const ready = await result;

  // Then the transaction receives valid work without inheriting a speculative failure.
  assert.equal(ready.isValid(nextBlock(source)), true);
  assert.equal(f.work.isReady(source), true);
  assert.equal(f.state.workRequests.length, 2);
});

test('the signing adapter awaits approval, consumes prepared work, and advances its head only after confirmed publication', async t => {
  // Given a synthetic signer, prepared public work, and asynchronous approval.
  const f = await fixture(t);
  const seed = await (await AttoMnemonic.generate()).toSeedAsync();
  t.after(() => seed.value.fill(0));
  const signer = await derivedSigner(seed, 0);
  const recipient = await derivedSigner(seed, 1);
  const source = account(signer.publicKey.toString());
  f.state.accounts = [source];
  await f.work.worker().workBlock(nextBlock(source));
  let approve;
  let proposed;
  const approval = new Promise(resolve => { approve = resolve; });
  const execution = await signingWallet(seed, 0, f.settings, async block => { proposed = block; await approval; }, f.work.worker());
  t.after(() => execution.wallet.close());

  // When sending pauses for approval and publication first fails.
  f.state.publishFail = true;
  const payment = execution.wallet.sendByIndex(toAttoIndex(0), recipient.address, AttoAmount.from(AttoUnit.RAW, '1'), null);
  await until(() => proposed !== undefined);
  assert.equal(f.state.publications.length, 0);
  assert.equal(f.state.workRequests.length, 1);
  approve();
  await assert.rejects(payment);
  assert.equal((await execution.wallet.getAccountByIndex(toAttoIndex(0))).lastTransactionHash.toString(), source.lastTransactionHash.toString());
  f.state.publishFail = false;
  const transaction = await execution.wallet.change(toAttoIndex(0), recipient.address, null);

  // Then Commons signatures/work validate and only confirmed publication advances state.
  assert.equal(await transaction.isValid(), true);
  assert.equal(f.state.workRequests.length, 1);
  assert.equal((await execution.wallet.getAccountByIndex(toAttoIndex(0))).lastTransactionHash.toString(), transaction.hash.toString());
  execution.wallet.close();
  assert.equal(f.work.isReady(source), true, 'A signing wallet does not close shared work.');
});

test('the signing adapter rejects an account response for a different signer before approval or work', async t => {
  // Given a synthetic signer and a node returning another account.
  const f = await fixture(t);
  const seed = await (await AttoMnemonic.generate()).toSeedAsync();
  t.after(() => seed.value.fill(0));
  let approvals = 0;

  // When opening the signing operation.
  await assert.rejects(signingWallet(seed, 0, f.settings, () => { approvals++; }, f.work.worker()), { code: 'ACCOUNT_MISMATCH' });

  // Then the account mismatch cannot reach signing, work, or publication.
  assert.equal(approvals, 0);
  assert.equal(f.state.workRequests.length, 0);
  assert.equal(f.state.publications.length, 0);
});

test('detached preparation outlives its launcher and a foreground process shares its computation', { timeout: 15000 }, async t => {
  // Given an isolated profile with spaces in its path and a blocked worker.
  const f = await fixture(t);
  f.state.blocked = true;
  const source = f.state.accounts[0];

  // When the real launcher exits while its detached worker is still requesting work.
  assert.equal((await detachedPrepare(f)).stdout, 'launcher-exited');
  await until(() => f.state.workRequests.length === 1);
  assert.equal(stopped(f.store), false);
  const foreground = f.work.worker().workBlock(nextBlock(source));
  await delay(150);
  assert.equal(f.state.workRequests.length, 1);
  f.state.workRequests[0].reply();

  // Then foreground work shares the nonce, and the drained worker exits promptly.
  assert.equal((await foreground).isValid(nextBlock(source)), true);
  await until(() => stopped(f.store));
  assert.deepEqual(f.store.get('work.queue'), []);
  assert.equal(f.work.isReady(source), true);
  assert.equal(f.state.workRequests.length, 1);
});

test('concurrent detached enqueues preserve all accounts and the global two-request limit', { timeout: 15000 }, async t => {
  // Given five distinct public accounts and overlapping launch requests.
  const f = await fixture(t);
  f.state.accounts = Array.from({ length: 5 }, (_, index) => account((index + 4).toString(16).padStart(2, '0').repeat(32), (index + 20).toString(16).padStart(2, '0').repeat(32)));
  f.state.blocked = true;

  // When two CLI processes concurrently enqueue overlapping account sets.
  await Promise.all([detachedPrepare(f, f.state.accounts.slice(0, 3)), detachedPrepare(f, f.state.accounts.slice(2))]);
  await until(() => f.state.workRequests.length === 2);
  await delay(100);
  assert.equal(f.state.workRequests.length, 2);
  for (let index = 0; index < 5; index++) {
    await until(() => f.state.workRequests.length > index);
    f.state.workRequests[index].reply();
  }

  // Then no enqueue is lost and each target is requested only once.
  await until(() => f.state.accounts.every(value => f.work.isReady(value)), 10000);
  await until(() => stopped(f.store));
  assert.equal(new Set(f.state.workRequests.map(value => value.input.target)).size, 5);
  assert.equal(f.state.workRequests.length, 5);
});

test('an older detached completion preserves the newer queued head and rejects obsolete cache writes', async t => {
  // Given a speculative request already running for an old head.
  const f = await fixture(t);
  const old = f.state.accounts[0];
  const newer = account(old.publicKey.toString(), '33'.repeat(32), 4);
  f.state.accounts.push(newer);
  f.state.blocked = true;
  await detachedPrepare(f, [old]);
  await until(() => f.state.workRequests.length === 1);

  // When another process observes the next head before the old result arrives.
  await detachedPrepare(f, [newer]);
  await until(() => f.state.workRequests.length === 2);
  f.state.workRequests[0].reply();
  await delay(100);

  // Then completing the old target cannot delete or replace the newer request.
  assert.equal(f.store.get('work.queue')[0].target, newer.lastTransactionHash.toString());
  assert.equal(f.work.isReady(old), false);
  f.state.workRequests[1].reply();
  await until(() => f.work.isReady(newer));
  await until(() => stopped(f.store));
});

test('failed detached jobs remain eligible for a later invocation without an in-process retry loop', async t => {
  // Given a worker returning a temporary error.
  const f = await fixture(t);
  f.state.fail = true;
  await detachedPrepare(f);
  await until(() => f.state.workRequests.length === 1 && stopped(f.store));
  assert.equal(f.store.get('work.queue').length, 1);
  await delay(200);
  assert.equal(f.state.workRequests.length, 1);

  // When a later invocation encounters a functioning worker.
  f.state.fail = false;
  await detachedPrepare(f);

  // Then that invocation completes the retained job and exits.
  await until(() => f.work.isReady(f.state.accounts[0]));
  await until(() => stopped(f.store));
  assert.equal(f.state.workRequests.length, 2);
});

test('reset cancellation stops detached work promptly and an old launch token cannot resume it', async t => {
  // Given an unresponsive detached request and its launch generation.
  const f = await fixture(t);
  f.state.blocked = true;
  await detachedPrepare(f);
  await until(() => f.state.workRequests.length === 1);
  const epoch = f.store.get('work.epoch');

  // When reset cancels the public queue and the previous launcher is replayed.
  const began = Date.now();
  await f.work.cancel();
  assert.ok(Date.now() - began < 3000);
  await promisify(execFile)(process.execPath, [join(cliDirectory, 'dist/wallet/work-daemon.js'), f.directory, epoch], { timeout: 5000 });

  // Then all work has stopped, the queue is empty, and no obsolete request resumes.
  assert.equal(stopped(f.store), true);
  assert.deepEqual(f.store.get('work.queue'), []);
  assert.equal(f.state.workRequests.length, 1);
  assert.equal(f.store.get(`work.LOCAL.${f.state.accounts[0].publicKey}`), undefined);
});

test('work caches and queued jobs are rejected after profile identity or endpoint changes', async t => {
  // Given valid cached work and the same public head in another profile identity.
  const f = await fixture(t);
  const source = f.state.accounts[0];
  f.work.prepare([source]);
  await until(() => f.work.isReady(source));
  f.store.set('identity', { address: source.address.value, fingerprint: 'replacement-public-identity' });
  assert.equal(f.work.isReady(source), false);

  // When a request begun under that identity completes after an endpoint change.
  f.state.blocked = true;
  f.work.prepare([source]);
  await until(() => f.state.workRequests.length === 2);
  f.settings.nodeUrl += '/changed';
  f.state.workRequests[1].reply();
  await delay(100);

  // Then it cannot populate a cache usable under the changed configuration.
  assert.equal(f.work.isReady(source), false);
});

test('work computation and process locks are released on worker death and another invocation resumes', { timeout: 15_000 }, async t => {
  // Given a persisted public job and a worker child owned directly by this test.
  const f = await fixture(t);
  f.state.blocked = true;
  f.work.prepare(f.state.accounts);
  await f.work.close();
  const child = spawn(process.execPath, [join(cliDirectory, 'dist/wallet/work-daemon.js'), f.directory, f.store.get('work.epoch')], {
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await until(() => f.state.workRequests.length >= 1 && !stopped(f.store));
  // When that verified process dies in the middle of work generation.
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  await exit;
  assert.equal(stopped(f.store), true);
  const before = f.state.workRequests.length;
  f.state.blocked = false;
  await detachedPrepare(f);
  const observer = new WalletWork(f.store, () => f.settings);
  // Then a new invocation obtains the released lock and completes the same job.
  await until(() => observer.isReady(f.state.accounts[0]));
  await until(() => stopped(f.store));
  assert.equal(f.state.workRequests.length, before + 1);
  await observer.close();
});

test('separate profiles compute independently even for the same network and account head', async t => {
  // Given identical public accounts in two independent profiles.
  const first = await fixture(t);
  const second = await fixture(t);
  first.state.blocked = true;
  // When the first profile's worker is blocked and the second starts preparation.
  await detachedPrepare(first);
  await until(() => first.state.workRequests.length === 1);
  await detachedPrepare(second);
  // Then neither the process lock nor the cached nonce leaks across profiles.
  await until(() => second.work.isReady(second.state.accounts[0]));
  assert.equal(first.work.isReady(first.state.accounts[0]), false);
  assert.equal(second.state.workRequests.length, 1);
  first.state.workRequests[0].reply();
  await until(() => first.work.isReady(first.state.accounts[0]));
});

test('the first foreground computation and a concurrent detached preparation share the same work generation', async t => {
  // Given a profile with no prior work epoch and foreground generation in flight.
  const f = await fixture(t);
  f.state.blocked = true;
  const foreground = f.work.worker().workBlock(nextBlock(f.state.accounts[0]));
  foreground.catch(() => {});
  await until(() => f.state.workRequests.length === 1);
  // When another process prepares the same head for the first time.
  await detachedPrepare(f);
  await delay(300);
  const requests = f.state.workRequests.length;
  for (const request of f.state.workRequests) request.reply();
  await foreground;
  // Then initialization does not change the work-lock identity or duplicate work.
  await until(() => f.work.isReady(f.state.accounts[0]));
  await until(() => stopped(f.store));
  assert.equal(requests, 1);
});

test('the finite worker budget stops an unresponsive queue at sixty seconds and retains at most 100 accounts', { timeout: 70_000 }, async t => {
  // Given an unresponsive worker and a batch exceeding the queue and Windows command-line limits.
  const f = await fixture(t);
  f.state.blocked = true;
  f.state.accounts = Array.from({ length: 110 }, (_, index) => account((index + 1).toString(16).padStart(64, '0'), (index + 111).toString(16).padStart(64, '0')));
  assert.ok(JSON.stringify(f.state.accounts.map(value => value.toJson())).length > 32_767);
  const began = Date.now();
  // When one detached worker attempts the retained jobs.
  await detachedPrepare(f);
  await until(() => f.state.workRequests.length === 2);
  assert.equal(f.store.get('work.queue').length, 100);
  await until(() => stopped(f.store), 63_000);
  // Then it exits within its lifetime budget without discarding unfinished jobs.
  assert.ok(Date.now() - began < 65_000);
  assert.equal(f.store.get('work.queue').length, 100);
  assert.ok(f.state.workRequests.length >= 10 && f.state.workRequests.length <= 12);
});
