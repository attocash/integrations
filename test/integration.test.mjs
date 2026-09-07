import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { AttoMnemonic, AttoTransaction, toAttoIndex } from '@attocash/commons-core';
import { AttoNodeMockAsyncBuilder, AttoWorkerMockAsyncBuilder } from '@attocash/commons-test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { check, fakeKeyring } from '../atto-cli/test/support/doctor.mjs';
const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../atto-cli/', import.meta.url));
const mcpDirectory = process.env.ATTO_TEST_MCP_PACKAGE_DIR ?? fileURLToPath(new URL('../atto-mcp/', import.meta.url));
const { AttoApplication } = await import(pathToFileURL(join(cliDirectory, 'dist/application/app.js')).href);
const { createMcpServer } = await import(pathToFileURL(join(mcpDirectory, 'dist/server.js')).href);

globalThis.require ??= createRequire(import.meta.url);
const execute = promisify(execFile);

async function eventually(operation, predicate, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await operation();
    if (predicate(value)) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

test('real Commons node/worker exercise the shared wallet, CLI and MCP', {
  skip: process.env.ATTO_TEST_INTEGRATION !== '1' ? 'Set ATTO_TEST_INTEGRATION=1 to run isolated Docker/Podman containers.' : false,
  timeout: 300_000,
}, async t => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const socket = uid === undefined ? undefined : `/run/user/${uid}/podman/podman.sock`;
  if (!process.env.DOCKER_HOST && socket && existsSync(socket)) {
    process.env.DOCKER_HOST = `unix://${socket}`;
    process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';
    process.env.TESTCONTAINERS_CHECKS_DISABLE ??= 'true';
  }

  const mnemonic = await AttoMnemonic.generate();
  const seed = await mnemonic.toSeedAsync();
  const genesisKey = await seed.toPrivateKey(toAttoIndex(0));
  seed.value.fill(0);
  const node = await new AttoNodeMockAsyncBuilder(genesisKey)
    .image(process.env.ATTO_NODE_MOCK_IMAGE ?? 'ghcr.io/attocash/node:live')
    .mysqlImage(process.env.ATTO_NODE_MYSQL_IMAGE ?? 'mysql:8.4')
    .pullImages(false).logOutput(false).build();
  const worker = await new AttoWorkerMockAsyncBuilder()
    .image(process.env.ATTO_WORK_MOCK_IMAGE ?? 'ghcr.io/attocash/work-server:cpu')
    .pullImage(false).logOutput(false).build();
  const directory = await mkdtemp(join(tmpdir(), 'atto-network-integration-'));
  let storedPhrase;
  const secrets = {
    get: async () => storedPhrase ?? null,
    set: async phrase => { storedPhrase = phrase; },
    available: async () => true,
  };
  const receiveProgress = [];
  const app = new AttoApplication({ directory, secrets, onReceiveProgress: event => receiveProgress.push(event) });
  let other;
  let mcp;
  let client;
  let server;
  t.after(async () => {
    await client?.close();
    await server?.close();
    await Promise.all([app.close(), other?.close(), mcp?.close()]);
    const cleanup = await Promise.allSettled([worker.stop(), node.stop()]);
    storedPhrase = undefined;
    genesisKey.value.fill(0);
    await rm(directory, { recursive: true, force: true });
    for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
  });

  t.diagnostic('Starting isolated AttoNodeMock, MySQL and CPU worker containers.');
  await node.start();
  await worker.start();
  const initialized = await app.createWallet(mnemonic.phrase);
  const address0 = initialized.addresses[0].address;
  await app.call('wallet_configure', { network: 'LOCAL', nodeUrl: node.baseUrl, workerUrl: worker.baseUrl, representative: address0, autoReceive: false });
  const address1 = (await app.call('address_add')).address;
  const address2 = (await app.call('address_activate', { index: 2 })).address;
  assert.equal((await app.call('address_list')).addresses.length, 3);
  const initial = await eventually(() => app.call('account_get', { index: 0 }), value => value.account !== null, 'genesis account');
  assert.equal(initial.account.height, '1');
  const supply = BigInt(initial.account.balance);
  assert.ok(supply > BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal((await app.call('account_get', { index: 1 })).account, null);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'atto-real-network-integration', version: '1.0.0' });
  mcp = new AttoApplication({ directory, secrets, access: 'mcp' });
  server = createMcpServer(mcp);
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  await t.test('doctor checks the real AttoNodeMock and worker without changing the genesis account', { skip: process.platform !== 'linux' }, async doctorTest => {
    // Given a local genesis wallet and a fake keyring holding only its test mnemonic.
    const fake = await fakeKeyring(doctorTest, mnemonic.phrase);
    const before = await app.call('account_get', { index: 0 });
    const journal = await app.call('journal_list');

    // When the packaged CLI probes real time, account, stream, and worker APIs.
    const result = await execute(process.execPath, [join(cliDirectory, 'dist/cli/main.js'), '--data-dir', directory, '--json', 'doctor'], {
      env: { ...process.env, ...fake.env }, timeout: 60_000,
    });
    const report = JSON.parse(result.stdout).result;

    // Then Commons validates the response and fresh work without any publication.
    assert.equal(report.status, 'pass', JSON.stringify(report));
    for (const id of ['node.time', 'node.account', 'node.network', 'node.stream', 'worker.work', 'keyring.credential']) assert.equal(check(report, id).status, 'pass');
    assert.deepEqual(await app.call('account_get', { index: 0 }), before);
    assert.deepEqual(await app.call('journal_list'), journal);
    assert.equal((await fake.trace()).length, 1);
    assert.ok(!result.stdout.includes(mnemonic.phrase) && !result.stderr.includes(mnemonic.phrase));
  });

  await t.test('MCP sends an exact amount; repeating request IDs preserves the published transaction', async () => {
    // Given: the MCP tool can only propose access and cannot spend before approval.
    const named = await client.callTool({ name: 'labels_set', arguments: { index: 1, label: 'Integration savings' } });
    assert.equal(named.isError, undefined);
    const request = { destinationLabel: 'integration SAVINGS', amount: '1.000000001', unit: 'ATTO', requestId: 'integration-first' };
    const denied = await client.callTool({ name: 'send', arguments: request });
    assert.equal(denied.structuredContent.error.code, 'MCP_READ_ONLY');
    const proposed = await client.callTool({ name: 'limits_propose', arguments: {
      policy: { perRequest: { amount: '2', unit: 'ATTO' }, rolling: [{ days: 1, amount: '10', unit: 'ATTO' }] },
    } });
    await app.approveLimitsProposal(proposed.structuredContent.result.proposal.id);
    // When
    const response = await client.callTool({ name: 'send', arguments: request });
    // Then
    assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
    const send = response.structuredContent.result;
    assert.equal(send.status, 'published');
    assert.equal(send.transaction.block.amount, '1000000001');
    await app.call('labels_set', { index: 1, label: 'Current recipient' });
    await app.call('labels_set', { index: 2, label: 'Integration savings' });
    const repeat = await app.call('send', request);
    assert.equal(repeat.hash, send.hash);
    assert.deepEqual(send.destinationBinding, { network: 'LOCAL', address: address1, label: 'Integration savings' });
    assert.deepEqual(repeat.destinationBinding, send.destinationBinding);
    assert.equal((await app.call('send', { destination: address1, amount: request.amount, requestId: request.requestId })).hash, send.hash);
    await assert.rejects(app.call('send', { ...request, destinationLabel: undefined, destinationIndex: 99, requestId: 'missing-destination' }), { code: 'ADDRESS_NOT_DERIVED' });
    await assert.rejects(app.call('send', { ...request, amount: '2' }), { code: 'REQUEST_CONFLICT' });
    assert.equal((await app.call('account_get', { index: 0 })).account.height, '2');
    assert.equal((await app.call('account_get', { index: 0 })).account.balance, (supply - 1000000001n).toString());
    assert.deepEqual((await app.call('transaction_get', { hash: send.hash })).transaction, send.transaction);
    assert.equal((await app.call('entry_get', { hash: send.hash })).entry.hash, send.hash);
    const pending = await app.call('receivables_list', { addresses: [address1], limit: 1, timeoutMs: 10_000 });
    assert.equal(pending.items[0].hash, send.hash);
    assert.equal(pending.limitReached, true);
    const received = await app.call('receive', { index: 1, hash: send.hash });
    assert.equal(received.status, 'received');
    assert.equal(received.transaction.block.type, 'OPEN');
    assert.equal((await app.call('receive', { index: 1, hash: send.hash })).hash, received.hash);
    assert.equal((await app.call('account_get', { index: 1 })).account.balance, '1000000001');
    const balances = await app.call('balances_get');
    assert.equal(balances.total.raw, supply.toString());
    assert.equal(balances.balances.find(value => value.address === address1).balance.atto, '1.000000001');
    const cli = await execute(process.execPath, [join(cliDirectory, 'dist/cli/main.js'), '--json', '--data-dir', directory, 'balances']);
    assert.deepEqual(JSON.parse(cli.stdout).result, balances);
    assert.equal(cli.stdout.includes(mnemonic.phrase), false);
    assert.equal(cli.stderr.includes(mnemonic.phrase), false);
    const human = await execute(process.execPath, [join(cliDirectory, 'dist/cli/main.js'), '--data-dir', directory, 'transaction', send.hash], { env: { ...process.env, NO_UPDATE_NOTIFIER: '1' } });
    assert.ok(human.stdout.includes(address0));
    assert.ok(human.stdout.includes(address1));
    assert.ok(human.stdout.includes(send.hash));
    assert.match(human.stdout, /1\.000000001 ATTO \(1000000001 RAW\)/);
    assert.doesNotMatch(human.stdout, /Signature:|Work:|Public key:/);
    const history = await app.call('history_list', { index: 1, timeoutMs: 10_000 });
    assert.equal(history.addressLabels[address1].personal.label, 'Current recipient');
    assert.equal(history.items[0].hash, received.hash);
    assert.equal(history.items[0].block, undefined, 'History defaults to entries, rather than full transactions.');
    // Restore the local test wallet's budget for the remaining network scenarios.
    const restored = await app.call('limits_propose', { policy: { perRequest: null, rolling: [] }, access: 'read-only' });
    await app.approveLimitsProposal(restored.proposal.id);
  });

  await t.test('all four watch types deliver a payment published after subscription', async () => {
    await app.call('labels_set', { index: 0, label: 'Sender' });
    await app.call('labels_set', { index: 2, label: 'Watch recipient' });
    const watches = new Map();
    for (const event of ['receivable', 'account', 'transaction', 'entry']) {
      const filter = { event, addresses: [event === 'receivable' ? address2 : address0], ...(['transaction', 'entry'].includes(event) ? { fromHeight: '1' } : {}) };
      watches.set(event, await app.call('watch_start', filter));
    }
    try {
      await eventually(() => app.call('watch_read', { id: watches.get('account').id }), page => page.events.length > 0, 'initial account snapshot');
      const sent = await app.call('send', { destinationLabel: 'Watch recipient', amount: '11', unit: 'RAW', requestId: 'integration-watch' });
      for (const [event, watch] of watches) {
        const page = await eventually(() => app.call('watch_read', { id: watch.id }), page => page.events.some(({ data }) => {
          if (event === 'account') return data.lastTransactionHash === sent.hash;
          if (event === 'transaction') return data.block?.height === sent.transaction.block.height;
          return data.hash === sent.hash;
        }), `${event} event`);
        assert.equal(page.gapDetected, false);
        assert.equal(page.addressLabels[event === 'account' ? address0 : address2].personal.label, event === 'account' ? 'Sender' : 'Watch recipient');
        await app.call('watch_read', { id: watch.id, cursor: page.nextCursor });
      }
      assert.equal((await app.call('watch_list')).length, 4);
      const second = await app.call('send', { destination: address2, amount: '13', unit: 'RAW', requestId: 'integration-receive-all' });
      const all = await app.call('receive_all', { index: 2, limit: 2, timeoutMs: 10_000 });
      assert.equal(all.results.length, 2);
      assert.equal((await app.call('account_get', { index: 2 })).account.balance, '24');
      assert.ok(second.hash);
    } finally {
      for (const watch of watches.values()) await app.call('watch_stop', { id: watch.id });
    }
  });

  await t.test('representative changes and entry/transaction pages use actual network account history', async () => {
    const changed = await app.call('representative_change', { index: 1, representative: address2 });
    assert.equal(changed.status, 'representative_changed');
    const account1 = (await app.call('account_get', { index: 1 })).account;
    assert.equal(account1.representativePublicKey, changed.transaction.block.representativePublicKey);
    assert.equal(account1.balance, '1000000001');
    for (const event of ['entry', 'transaction']) {
      let cursor;
      const items = [];
      do {
        const page = await app.call('history_list', { event, addresses: [address0, address1, address2], limit: 2, timeoutMs: 10_000, ...(cursor ? { cursor } : {}) });
        assert.equal(page.timedOut, false);
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      const heights = items.map(value => event === 'entry' ? `${value.publicKey}:${value.height}` : `${value.block.publicKey}:${value.block.height}`);
      assert.equal(new Set(heights).size, heights.length);
      const accounts = await Promise.all([0, 1, 2].map(index => app.call('account_get', { index })));
      assert.equal(items.length, accounts.reduce((sum, value) => sum + Number(value.account.height), 0));
    }
  });

  await t.test('two application sessions share spending reservations and the account mutation lock', async () => {
    // Given: local approval applies the policy used by both wallet sessions.
    other = new AttoApplication({ directory, secrets });
    const initial = await app.call('limits_propose', { policy: { perRequest: null, rolling: [{ days: 1, amount: supply.toString(), unit: 'RAW' }] }, access: 'read-only' });
    await app.approveLimitsProposal(initial.proposal.id);
    const used = BigInt((await app.call('limits_get')).rolling[0].usedRaw);
    const bounded = await app.call('limits_propose', { policy: { perRequest: null, rolling: [{ days: 1, amount: (used + 10n).toString(), unit: 'RAW' }] }, access: 'read-only' });
    await app.approveLimitsProposal(bounded.proposal.id);
    // When
    const results = await Promise.allSettled([
      app.call('send', { destination: address1, amount: '7', unit: 'RAW', requestId: 'integration-concurrent-a' }),
      other.call('send', { destination: address2, amount: '7', unit: 'RAW', requestId: 'integration-concurrent-b' }),
    ]);
    // Then
    assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(results.find(value => value.status === 'rejected').reason.code, 'SPENDING_LIMIT');
    assert.equal((await other.call('limits_get')).rolling[0].remainingRaw, '3');
    const unlimited = await app.call('limits_propose', { policy: { perRequest: null, rolling: [] }, access: 'read-only' });
    await app.approveLimitsProposal(unlimited.proposal.id);
    await app.call('receive_all', { index: 1, timeoutMs: 300 });
    await app.call('receive_all', { index: 2, timeoutMs: 300 });
  });

  await t.test('idle auto-receive stays subscribed, then serializes mutations with a second session and conserves balances', async () => {
    const before1 = BigInt((await app.call('account_get', { index: 1 })).account.balance);
    const before2 = BigInt((await app.call('account_get', { index: 2 })).account.balance);
    await app.call('wallet_configure', { autoReceive: true });
    await app.start();
    await eventually(() => app.call('wallet_status'), value => value.autoReceive.running, 'automatic receiver startup');
    const idleStart = receiveProgress.length;
    // The node can withhold headers until a payment arrives. A connected empty
    // stream must survive beyond the old ten-second response-header deadline.
    await delay(11_000);
    assert.equal(receiveProgress.slice(idleStart).some(event => event.event === 'reconnecting'), false);
    const sends = await Promise.all([
      other.call('send', { destination: address1, amount: '17', unit: 'RAW', requestId: 'integration-auto-a' }),
      other.call('send', { destination: address2, amount: '19', unit: 'RAW', requestId: 'integration-auto-b' }),
    ]);
    assert.equal(sends.length, 2);
    await eventually(() => app.call('account_get', { index: 1 }), value => value.account.balance === (before1 + 17n).toString(), 'automatic receive at index 1');
    await eventually(() => app.call('account_get', { index: 2 }), value => value.account.balance === (before2 + 19n).toString(), 'automatic receive at index 2');
    await eventually(async () => receiveProgress, events => sends.every(send => events.some(event => event.event === 'received' && event.sendHash === send.hash)), 'confirmed receiving progress');
    for (const [offset, send] of sends.entries()) {
      const events = receiveProgress.filter(event => event.sendHash === send.hash);
      assert.equal(events[0].event, 'pending');
      assert.ok(events.some(event => event.event === 'receiving'));
      const received = events.at(-1);
      assert.equal(received.event, 'received');
      assert.equal(received.index, offset + 1);
      assert.equal(received.amount.raw, offset === 0 ? '17' : '19');
      const transaction = (await app.call('transaction_get', { hash: received.receiveHash })).transaction;
      assert.equal(transaction.block.sendHash, send.hash);
    }
    assert.equal((await app.call('balances_get')).total.raw, supply.toString());
    assert.equal((await app.call('wallet_status')).autoReceive.lastError, null);
  });
  await t.test('MCP consolidates an approved pool into one payment and persists its metadata and internal hashes', async () => {
    // Given: two owned accounts each hold 100 RAW; the recipient must receive 200 RAW once.
    await app.call('wallet_configure', { autoReceive: false });
    const addresses = new Map();
    for (const index of [3, 4, 5]) addresses.set(index, (await app.call('address_derive', { index })).address);
    for (const index of [3, 4]) {
      const funding = await app.call('send', { index: 0, destination: addresses.get(index), amount: '100', unit: 'RAW', requestId: `pool-funding-${index}` });
      await app.call('receive', { index, hash: funding.hash });
    }
    const proposal = await app.call('limits_propose', { policy: { perRequest: { amount: '200', unit: 'RAW' }, rolling: [] }, access: 'spend', pool: { indexes: [3, 4], consolidate: true } });
    await app.approveLimitsProposal(proposal.proposal.id);
    const request = { destination: addresses.get(5), amount: '200', unit: 'RAW', requestId: 'integration-consolidation', metadata: { reason: 'Synthetic integration invoice', invoice: 'TEST-200' } };

    // When: the actual MCP tool drives Commons block construction, work and node confirmation.
    const response = await client.callTool({ name: 'send', arguments: request });

    // Then: there is one recipient transfer and two linked internal steps.
    assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
    const payment = response.structuredContent.result;
    assert.equal(payment.transaction.block.amount, '200');
    assert.equal(payment.index, 3);
    assert.deepEqual(payment.metadata, request.metadata);
    assert.equal(payment.consolidation.length, 2);
    assert.deepEqual(payment.consolidation.map(step => step.kind), ['send', 'receive']);
    assert.equal(new Set([payment.hash, ...payment.consolidation.map(step => step.hash)]).size, 3);
    const journal = (await client.callTool({ name: 'journal_get', arguments: { requestId: request.requestId } })).structuredContent.result.record;
    assert.equal(journal.status, 'published');
    assert.equal(journal.sourceAddress, addresses.get(3));
    assert.deepEqual(journal.plan.indexes, [3, 4]);
    assert.ok(journal.plan.steps.every(step => step.status === 'published'));
    assert.equal((await app.call('account_get', { index: 3 })).account.balance, '0');
    assert.equal((await app.call('account_get', { index: 4 })).account.balance, '0');
    const repeat = await app.call('send', { ...request, metadata: undefined });
    assert.equal(repeat.hash, payment.hash);
    await assert.rejects(app.call('send', { ...request, metadata: { reason: 'Changed' } }), { code: 'REQUEST_CONFLICT' });
    await app.call('receive', { index: 5, hash: payment.hash });
    assert.equal((await app.call('account_get', { index: 5 })).account.balance, '200');
    const cli = await execute(process.execPath, [join(cliDirectory, 'dist/cli/main.js'), '--json', '--data-dir', directory, 'journal', 'show', request.requestId]);
    assert.deepEqual(JSON.parse(cli.stdout).result.record, journal);
  });
  await t.test('automatic retries recover before and after real node publication with exactly one debit', async () => {
    // Given real services behind a proxy that can fail selection or publication.
    let mode, publications = 0, proxyError, remapped = false;
    let publicationHashes = [];
    const remapLabel = async () => {
      if (remapped) return;
      remapped = true;
      await app.call('labels_remove', { index: 1 });
      await app.call('labels_set', { index: 2, label: 'Retry recipient' });
    };
    const proxy = createServer((request, response) => {
      void (async () => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const publication = request.method === 'POST' && request.url === '/transactions/stream';
        if (publication) { publications++; publicationHashes.push(AttoTransaction.fromJson(Buffer.concat(chunks).toString()).hash.toString()); }
        if (mode === 'selection' && !remapped && /^\/accounts(?:\/[a-f0-9]+)?$/i.test(request.url)) {
          await remapLabel();
          response.writeHead(503); response.end(); return;
        }
        if (publication && publications === 1 && mode === 'before') {
          await remapLabel();
          response.writeHead(503); response.end(); return;
        }
        const upstream = await fetch(`${node.baseUrl.replace(/\/$/, '')}${request.url}`, {
          method: request.method, headers: { 'content-type': 'application/json', accept: request.headers.accept ?? 'application/json' },
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        });
        if (publication && publications === 1 && mode === 'after') {
          assert.equal(upstream.status, 200);
          const reader = upstream.body.getReader();
          assert.equal((await reader.read()).done, false, 'The real node must acknowledge the transaction before the proxy loses the response.');
          await reader.cancel();
          await remapLabel();
          response.writeHead(503); response.end(); return;
        }
        response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
        if (!upstream.body) { response.end(); return; }
        const stream = Readable.fromWeb(upstream.body);
        response.on('close', () => stream.destroy());
        stream.on('error', error => { proxyError = error; response.destroy(); });
        stream.pipe(response);
      })().catch(error => { proxyError = error; response.destroy(); });
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    try {
      for (mode of ['selection', 'before', 'after']) {
        publications = 0; remapped = false; publicationHashes = [];
        await app.call('labels_remove', { index: 2 });
        await app.call('labels_set', { index: 1, label: 'Retry recipient' });
        const before = BigInt((await app.call('account_get', { index: 0 })).account.balance);
        await app.call('wallet_configure', { nodeUrl: `http://127.0.0.1:${proxy.address().port}` });
        const retries = [];
        const retryApp = new AttoApplication({ directory, secrets, sendRetry: {
          signal: AbortSignal.timeout(30_000), onRetry: (error, delayMs) => retries.push({ code: error.code, delayMs }),
        } });
        let payment;
        try {
          // When the proxy fails and reassigns the label before retrying.
          payment = await retryApp.call('send', { index: 0, destinationLabel: 'Retry recipient', amount: '1', unit: 'RAW', requestId: `integration-retry-${mode}` });
        } finally { await retryApp.close(); }
        // Then every retry uses the original address and signed hash.
        assert.equal(payment.status, 'published');
        assert.equal(payment.destination, address1);
        assert.deepEqual(payment.destinationBinding, { network: 'LOCAL', address: address1, label: 'Retry recipient' });
        assert.equal(new Set(publicationHashes).size, 1);
        assert.equal(publicationHashes[0], payment.hash);
        assert.equal((await app.call('send', { index: 0, destinationLabel: 'Retry recipient', amount: '1', unit: 'RAW', requestId: `integration-retry-${mode}` })).hash, payment.hash);
        assert.deepEqual(retries, [{ code: mode === 'selection' ? 'NODE_HTTP_ERROR' : 'NODE_SERVER_ERROR', delayMs: 1000 }]);
        assert.equal(publications, mode === 'before' ? 2 : 1);
        await app.call('wallet_configure', { nodeUrl: node.baseUrl });
        const after = BigInt((await app.call('account_get', { index: 0 })).account.balance);
        assert.equal(before - after, 1n);
        await app.call('receive', { index: 1, hash: payment.hash });
        const addresses = (await app.call('address_list')).addresses.map(value => value.address);
        assert.equal((await app.call('balances_get', { addresses })).total.raw, supply.toString());
      }
      assert.equal(proxyError, undefined);
    } finally {
      proxy.closeAllConnections();
      await new Promise(resolve => proxy.close(resolve));
    }
  });
  t.diagnostic('Finished network, retry, pool, journal, CLI and MCP scenarios; cleaning up test containers.');
});
