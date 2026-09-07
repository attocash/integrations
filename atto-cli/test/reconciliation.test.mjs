import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AttoBlock, AttoPrivateKey, AttoSignature, AttoTransaction, AttoWork } from '@attocash/commons-core';

const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const { NodeReader } = await import(pathToFileURL(join(cliDirectory, 'dist/network/reader.js')).href);
const { reconcileSend } = await import(pathToFileURL(join(cliDirectory, 'dist/spending/reconcile.js')).href);

// Synthetic keys and precomputed LOCAL-network work; no credentials or funds.
const sender = await new AttoPrivateKey(new Int8Array(32).fill(7)).toSigner();
const receiver = await new AttoPrivateKey(new Int8Array(32).fill(8)).toSigner();
const work = AttoWork.Companion.parse('914C000000000000');

async function transaction(overrides = {}, signer = sender) {
  const block = AttoBlock.fromJson(JSON.stringify({
    type: 'SEND', network: 'LOCAL', version: 0, algorithm: 'V1', publicKey: signer.publicKey.toString(),
    height: 2, balance: 90, timestamp: 1704616009211, previous: '11'.repeat(32),
    receiverAlgorithm: 'V1', receiverPublicKey: receiver.publicKey.toString(), amount: 10, ...overrides,
  }));
  return new AttoTransaction(block, await signer.signBlock(block), work);
}

const original = await transaction();
const record = {
  id: 'synthetic-request', index: 0, destination: original.block.receiverAddress.value,
  raw: original.block.amount.toString(), createdAt: 1704616009211, status: 'unknown',
  hash: original.hash.toString(), blockJson: original.block.toJson(),
};

async function server(t, handler) {
  const requests = [];
  const http = createServer((req, res) => {
    requests.push(req.url);
    Promise.resolve(handler(req, res)).catch(() => { res.statusCode = 500; res.end(); });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(async () => { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); });
  const reader = new NodeReader({ network: 'LOCAL', nodeUrl: `http://127.0.0.1:${http.address().port}`, workerUrl: 'http://127.0.0.1', representative: receiver.address.value, autoReceive: false, minReceiveRaw: '1' });
  return { reader, requests };
}

const notFound = (res) => { res.statusCode = 404; res.end(); };

test('matching valid published transaction completes without a canonical lookup', async (t) => {
  // Given
  assert.equal(await original.isValid(), true);
  const { reader, requests } = await server(t, (_req, res) => res.end(original.toJson()));

  // When
  const outcome = await reconcileSend(reader, record);

  // Then
  assert.equal(outcome.status, 'published');
  assert.equal(outcome.transaction.hash.toString(), record.hash);
  assert.deepEqual(requests, [`/transactions/${record.hash}`]);
});

test('different valid canonical transaction at the same position rejects the unpublished send', async (t) => {
  // Given
  const canonical = await transaction({ balance: 89, amount: 11 });
  assert.equal(await canonical.isValid(), true);
  const snapshot = structuredClone(record);
  const { reader, requests } = await server(t, (req, res) => req.url.startsWith('/transactions/') ? notFound(res) : res.end(`${canonical.toJson()}\n`));

  // When
  const outcome = await reconcileSend(reader, record);

  // Then
  assert.equal(outcome.status, 'rejected');
  assert.deepEqual(record, snapshot);
  assert.deepEqual(requests, [`/transactions/${record.hash}`, `/accounts/${sender.publicKey}/transactions/stream?fromHeight=2&toHeight=2`]);
});

test('canonical lookup can confirm the original hash when the hash endpoint is behind', async (t) => {
  // Given
  const { reader } = await server(t, (req, res) => req.url.startsWith('/transactions/') ? notFound(res) : res.end(`${original.toJson()}\n`));

  // When
  const outcome = await reconcileSend(reader, record);

  // Then
  assert.equal(outcome.status, 'published');
  assert.equal(outcome.transaction.hash.toString(), record.hash);
});

test('missing canonical evidence keeps the send unresolved', async (t) => {
  // Given
  const { reader } = await server(t, (_req, res) => notFound(res));

  // When
  const outcome = await reconcileSend(reader, record);

  // Then
  assert.equal(outcome.status, 'unresolved');
});

test('corrupt journal identity cannot release allowance or query an unrelated account', async (t) => {
  // Given
  const { reader, requests } = await server(t, (_req, res) => res.end(original.toJson()));
  const wrongNetwork = AttoBlock.fromJson(record.blockJson.replace('LOCAL', 'BETA'));
  const invalid = [
    { ...record, hash: undefined }, { ...record, blockJson: 'invalid' }, { ...record, hash: '22'.repeat(32) },
    { ...record, raw: '11' }, { ...record, destination: sender.address.value },
    { ...record, blockJson: wrongNetwork.toJson(), hash: wrongNetwork.hash.toString() },
  ];

  // When / Then
  for (const candidate of invalid) assert.equal((await reconcileSend(reader, candidate)).status, 'unresolved');
  assert.deepEqual(requests, []);
});

test('invalid signature or work and mismatched account, height, or network never prove rejection', async (t) => {
  // Given
  const wrongHeight = await transaction({ height: 3 });
  const wrongAccount = await transaction({ receiverPublicKey: sender.publicKey.toString() }, receiver);
  assert.equal(await wrongHeight.isValid(), true);
  assert.equal(await wrongAccount.isValid(), true);
  const invalidSignature = new AttoTransaction(original.block, new AttoSignature(new Int8Array(64)), work);
  assert.equal(await invalidSignature.isValid(), false);
  const invalidWork = new AttoTransaction(original.block, original.signature, new AttoWork(new Int8Array(8)));
  assert.equal(await invalidWork.isValid(), false);
  const wrongNetwork = AttoTransaction.fromJson(original.toJson().replace('LOCAL', 'BETA'));
  let response;
  const { reader } = await server(t, (req, res) => req.url.startsWith('/transactions/') ? notFound(res) : res.end(response.toJson()));

  // When / Then
  for (const candidate of [wrongHeight, wrongAccount, wrongNetwork, invalidSignature, invalidWork]) {
    response = candidate;
    assert.equal((await reconcileSend(reader, record)).status, 'unresolved');
  }
});

test('a hash endpoint returning the wrong transaction remains unresolved', async (t) => {
  // Given
  const canonical = await transaction({ amount: 11, balance: 89 });
  const { reader, requests } = await server(t, (_req, res) => res.end(canonical.toJson()));

  // When
  const outcome = await reconcileSend(reader, record);

  // Then
  assert.equal(outcome.status, 'unresolved');
  assert.equal(requests.length, 1);
});

test('malformed responses and bounded read deadlines retain uncertain sends', { timeout: 5000 }, async (t) => {
  // Given
  let mode = 'malformed';
  const { reader } = await server(t, (req, res) => {
    if (mode === 'malformed') res.end('invalid JSON');
    else if (mode === 'stream-timeout' && req.url.startsWith('/transactions/')) notFound(res);
    // Other requests remain pending until the helper's abort signal closes them.
  });

  // When / Then
  for (const scenario of ['malformed', 'lookup-timeout', 'stream-timeout']) {
    mode = scenario;
    const snapshot = structuredClone(record);
    assert.equal((await reconcileSend(reader, record, 50)).status, 'unresolved');
    assert.deepEqual(record, snapshot);
  }
});
