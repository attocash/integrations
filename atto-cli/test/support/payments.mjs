import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { AttoAccount, AttoMnemonic, AttoReceivable, AttoSendBlock, AttoTransaction, AttoWork, attoAccountChange, attoBlockWorkTarget } from '@attocash/commons-core';

const applicationUrl = process.env.ATTO_TEST_CLI_PACKAGE_DIR
  ? pathToFileURL(join(process.env.ATTO_TEST_CLI_PACKAGE_DIR, 'dist/application/app.js'))
  : new URL('../../dist/application/app.js', import.meta.url);
const { AttoApplication } = await import(applicationUrl.href);
const { StateStore } = await import(new URL('../storage/state.js', applicationUrl).href);
const { WalletWork } = await import(new URL('../wallet/work.js', applicationUrl).href);
const { BackgroundReceiver } = await import(new URL('../wallet/background-receive.js', applicationUrl).href);
const workCache = new Map();

function validWork(block) {
  const key = attoBlockWorkTarget(block);
  const cached = workCache.get(key);
  if (cached?.isValid(block)) return cached;
  for (let nonce = 0; nonce < 1_000_000; nonce++) {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setUint32(0, nonce, true);
    const work = new AttoWork(new Int8Array(bytes.buffer));
    if (work.isValid(block)) { workCache.set(key, work); return work; }
  }
  throw new Error('No bounded synthetic LOCAL work found.');
}

export async function until(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, 'Expected observable fixture state before deadline.');
    await delay(10);
  }
}

export function gate() {
  let release;
  return { promise: new Promise(resolve => { release = resolve; }), release: () => release() };
}

export async function fixture(t, balances, pool = { indexes: balances.map((_, index) => index), consolidate: false }, limit = '100', market, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'atto pool payments-'));
  let phrase;
  const secrets = { get: async () => phrase ?? null, set: async value => { phrase = value; } };
  const applications = new Set();
  const open = access => {
    const application = new AttoApplication({ directory, secrets, market, ...options, ...(access ? { access } : {}) });
    applications.add(application);
    return application;
  };
  let app = open();
  await app.createWallet((await AttoMnemonic.generate()).phrase);
  const addresses = [];
  for (let index = 0; index < balances.length; index++) addresses.push(await app.call('address_derive', { index }));
  const recipient = await app.call('address_derive', { index: balances.length });
  const accounts = new Map();
  const heads = new Map();
  const saveAccount = account => {
    accounts.set(account.publicKey.toString(), account);
    heads.set(account.lastTransactionHash.toString(), account);
  };
  addresses.forEach((address, index) => saveAccount(AttoAccount.fromJson(JSON.stringify({
    network: 'LOCAL', version: 0, algorithm: 'V1', publicKey: address.publicKey,
    height: 3, balance: balances[index], lastTransactionHash: (index + 1).toString(16).padStart(2, '0').repeat(32),
    lastTransactionTimestamp: 1704616009211, representativeAlgorithm: 'V1', representativePublicKey: addresses[0].publicKey,
  }))));
  const state = { accounts, publications: [], publicationAttempts: [], receivables: new Map(), requests: [], works: [],
    failPublication: 0, hideHashLookup: false, holdPublications: undefined, error: undefined };
  state.streams = new Set();
  const http = createServer((request, response) => {
    const handle = async () => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const url = new URL(request.url, 'http://fixture.local');
      state.requests.push({ method: request.method, path: url.pathname, body });
      response.setHeader('content-type', 'application/json');
      const json = value => response.end(JSON.stringify(value));
      const stream = values => { response.setHeader('content-type', 'application/x-ndjson'); response.end(values.map(value => `${value.toJson()}\n`).join('')); };
      if (url.pathname === '/accounts/receivables/stream') {
        if (state.failStreams) { response.statusCode = 503; return response.end(); }
        const requested = JSON.parse(body);
        const addresses = Array.isArray(requested) ? requested : requested.addresses;
        const emit = value => {
          if (addresses.includes(value.receiverAddress.value)) response.write(`${value.toJson()}\n`);
        };
        response.setHeader('content-type', 'application/x-ndjson');
        response.flushHeaders();
        for (const value of state.receivables.values()) emit(value);
        state.streams.add({ response, emit });
        response.on('close', () => { for (const value of state.streams) if (value.response === response) state.streams.delete(value); });
        return;
      }
      const accountKey = /^\/accounts\/([A-Fa-f0-9]{64})$/.exec(url.pathname)?.[1].toUpperCase();
      if (request.method === 'GET' && accountKey && accounts.has(accountKey)) return response.end(accounts.get(accountKey).toJson());
      if (request.method === 'POST' && url.pathname === '/accounts') {
        const input = JSON.parse(body);
        const requested = Array.isArray(input) ? input : input.addresses;
        assert.ok(Array.isArray(requested), 'Account requests must include addresses.');
        return response.end(`[${[...accounts.values()].filter(account => requested.includes(account.address.value)).map(account => account.toJson()).join(',')}]`);
      }
      if (url.pathname.startsWith('/instants/')) {
        const now = new Date().toISOString();
        return json({ clientInstant: now, serverInstant: now, differenceMillis: 0 });
      }
      if (request.method === 'POST' && url.pathname === '/works') {
        const input = JSON.parse(body);
        const account = heads.get(input.target);
        assert.ok(account, 'Work must target an observed account head.');
        const block = attoAccountChange(account, account.representativeAddress, new Date(input.timestamp).toISOString()).block;
        assert.equal(attoBlockWorkTarget(block), input.target);
        state.works.push(input);
        if (state.failWork) { response.statusCode = 503; return response.end(); }
        if (state.holdWork) await state.holdWork.promise;
        return json({ work: validWork(block).toString() });
      }
      if (request.method === 'POST' && url.pathname === '/transactions/stream') {
        const transaction = AttoTransaction.fromJson(body);
        assert.equal(await transaction.isValid(), true, 'Every publication must contain valid Commons signatures and work.');
        const block = transaction.block;
        const key = block.publicKey.toString();
        const prior = accounts.get(key);
        assert.ok(prior, 'These fixtures only spend from opened synthetic accounts.');
        state.publicationAttempts.push(transaction);
        assert.equal(state.publications.some(value => value.hash.toString() === transaction.hash.toString()), false, 'A retry must never republish a committed transfer.');
        assert.equal(block.previous.toString(), prior.lastTransactionHash.toString());
        assert.equal(BigInt(block.height.toString()), BigInt(prior.height.toString()) + 1n);
        if (block instanceof AttoSendBlock) {
          assert.equal(BigInt(prior.balance.toString()) - BigInt(block.balance.toString()), BigInt(block.amount.toString()));
          const receivable = new AttoReceivable(block.network, transaction.hash, block.version, block.algorithm,
            block.publicKey, block.timestamp, block.receiverAlgorithm, block.receiverPublicKey, block.amount);
          state.receivables.set(transaction.hash.toString(), receivable);
          for (const subscription of state.streams) subscription.emit(receivable);
        } else {
          const receivable = state.receivables.get(block.sendHash.toString());
          assert.ok(receivable, 'Receives must consume a published pending transfer.');
          assert.equal(receivable.receiverAddress.value, block.address.value);
          assert.equal(BigInt(block.balance.toString()) - BigInt(prior.balance.toString()), BigInt(receivable.amount.toString()));
          state.receivables.delete(block.sendHash.toString());
        }
        const next = JSON.parse(prior.toJson());
        Object.assign(next, { height: Number(block.height.toString()), balance: Number(block.balance.toString()),
          lastTransactionHash: transaction.hash.toString(), lastTransactionTimestamp: Number(block.timestamp.toEpochMilliseconds()) });
        saveAccount(AttoAccount.fromJson(JSON.stringify(next)));
        state.publications.push(transaction);
        if (state.failPublication === state.publications.length) { response.statusCode = 503; return response.end(); }
        if (state.holdPublications) await state.holdPublications.promise;
        return stream([transaction]);
      }
      const receivableKey = /^\/accounts\/([A-Fa-f0-9]{64})\/receivables\/stream$/.exec(url.pathname)?.[1].toUpperCase();
      if (receivableKey) return stream([...state.receivables.values()].filter(value => value.receiverPublicKey.toString() === receivableKey));
      const transactionHash = /^\/transactions\/([A-Fa-f0-9]{64})$/.exec(url.pathname)?.[1].toUpperCase();
      const transaction = state.publications.find(value => value.hash.toString() === transactionHash);
      if (transaction && !state.hideHashLookup) return response.end(transaction.toJson());
      const historyKey = /^\/accounts\/([A-Fa-f0-9]{64})\/transactions\/stream$/.exec(url.pathname)?.[1].toUpperCase();
      if (historyKey) return stream(state.publications.filter(value => value.block.publicKey.toString() === historyKey
        && BigInt(value.height.toString()) >= BigInt(url.searchParams.get('fromHeight') ?? '1')
        && BigInt(value.height.toString()) <= BigInt(url.searchParams.get('toHeight') ?? '18446744073709551615')));
      response.statusCode = 404;
      response.end();
    };
    void handle().catch(error => { state.error ??= error; if (!response.headersSent) response.statusCode = 500; response.end(); });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const url = `http://127.0.0.1:${http.address().port}`;
  const policy = { perRequest: { amount: limit, unit: 'RAW' }, rolling: [{ days: 1, amount: limit, unit: 'RAW' }] };
  const approve = async (nextPool = pool, access = 'spend') => {
    const { proposal } = await app.call('limits_propose', { policy, access, pool: nextPool });
    await app.approveLimitsProposal(proposal.id);
  };
  t.after(async () => {
    state.holdPublications?.release();
    state.holdWork?.release();
    state.releaseExecution?.();
    await Promise.allSettled([...applications].map(application => application.close()));
    const cleanup = new StateStore(directory);
    const receiver = new BackgroundReceiver(cleanup);
    await receiver.stop();
    await until(() => receiver.status().state === 'stopped', 15_000);
    await new WalletWork(cleanup, () => cleanup.get('settings')).cancel();
    cleanup.close();
    http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
    phrase = undefined;
    // A stopped detached process may still be closing SQLite handles on Windows.
    // Retry transient deletion failures without hiding a persistent lock.
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    assert.equal(state.error, undefined);
  });
  await app.call('wallet_configure', { network: 'LOCAL', nodeUrl: url, workerUrl: url, representative: addresses[0].address, autoReceive: false });
  await approve();
  return { get app() { return app; }, directory, mnemonic: () => phrase, state, addresses, recipient, open, approve,
    request: (id, amount = '1', extra = {}) => ({ destination: recipient.address, amount, unit: 'RAW', requestId: id, ...extra }),
    async reopen() { await app.close(); applications.delete(app); app = open(); return app; } };
}
