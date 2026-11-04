import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { addressFromPublicKey, hexBytes, NanoStateBlock, publicKey, sign, upperHex, validWork, ZERO_HASH } from '../dist/protocol.js';
import { DEV_GENESIS_ACCOUNT, DEV_GENESIS_HASH, epochLink, MAIN_GENESIS_ACCOUNT, MAIN_GENESIS_HASH, NanoRpcClient,
  parseJsonObject, requireConfirmedFrontier } from '../dist/rpc.js';

const SOURCE_KEY = new Uint8Array(32).fill(1);
const SOURCE = addressFromPublicKey(publicKey(SOURCE_KEY));
const DEV_KEY = hexBytes('34F0A37AAD20F4A260F0A5B3CB3D7FB50673212263E58A380BC10474BB039CE4');
const ROOT = 'D1E6C3C6B7DF4485B9324AB4DE023B71B5E0CA9AC20616A6F6E80D15AD4CFAC6';
const BLOCK = NanoStateBlock.signed(SOURCE_KEY, ROOT, SOURCE, 100n, 'A'.repeat(64), '0'.repeat(16));
const rpcError = { code: 'RPC_UNAVAILABLE' };
const MAIN_GENESIS_OPEN = {
  type: 'open',
  source: 'E89208DD038FBB269987689621D52292AE9C35941A7484756ECCED92A65093BA',
  representative: MAIN_GENESIS_ACCOUNT,
  account: MAIN_GENESIS_ACCOUNT,
  work: '62f05417dd3fb691',
  signature: '9F0C933C8ADE004D808EA1985FA746A7E95BA2A38F867640F53EC8F180BDFE9E2C1268DEAD7C2664F356E37ABA362BC58E46DBA03E523A7B5A19E4B6EB12BB02',
};

async function serverFixture(t, reply) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const result = await reply(body, response);
    if (result !== undefined && !response.writableEnded) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(typeof result === 'string' || result instanceof Uint8Array ? result : JSON.stringify(result));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { client: new NanoRpcClient(url, 'nano:dev'), url, requests };
}

function snapshot(overrides = {}) {
  return { frontier: BLOCK.hash, confirmed_frontier: BLOCK.hash, balance: '100', confirmed_balance: '100',
    representative: SOURCE, confirmed_representative: SOURCE, account_version: '2', ...overrides };
}

function evidence(block = BLOCK, overrides = {}) {
  return { contents: block.toWire(), confirmed: 'true', block_account: block.account, subtype: 'send', ...overrides };
}

function signedEpoch(epoch, overrides = {}, key = DEV_KEY) {
  const unsigned = new NanoStateBlock(SOURCE, BLOCK.hash, SOURCE, 100n, epochLink(epoch), '0'.repeat(128), '0'.repeat(16));
  const wire = { ...unsigned.toWire(), ...overrides,
    ...(overrides.link ? { link_as_account: addressFromPublicKey(hexBytes(overrides.link)) } : {}) };
  const block = NanoStateBlock.parse(wire);
  for (let nonce = 0n;; nonce++) {
    wire.work = nonce.toString(16).padStart(16, '0');
    if (validWork('nano:dev', epoch, true, block.workRoot(), wire.work)) break;
  }
  return NanoStateBlock.parse({ ...wire, signature: upperHex(sign(key, hexBytes(block.hash))) });
}

test('strict JSON parsing rejects duplicate decoded names, trailing tokens and deep objects', () => {
  assert.deepEqual(parseJsonObject('{"valid":[1,{"a":true}],"text":"a\\\"b"}'), { valid: [1, { a: true }], text: 'a"b' });
  for (const input of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a":{"x":1,"x":2}}',
    '{"a":[{"x":1,"x":2}]}', '{} {}', '[]', 'null', '{"a":1,}', '{"a":NaN}']) {
    assert.throws(() => parseJsonObject(input));
  }
  assert.throws(() => parseJsonObject('{"a":'.repeat(66) + 'null' + '}'.repeat(66)));
  assert.throws(() => parseJsonObject(JSON.stringify({ text: 'x'.repeat(1_000_000) })));
});

test('network pin requires both exact Nano network name and genesis identifier', async t => {
  let version = { network: 'dev', network_identifier: DEV_GENESIS_HASH.toLowerCase() };
  const { client, requests } = await serverFixture(t, () => version);
  await client.requirePinnedNetwork();
  assert.deepEqual(requests[0], { action: 'version' });
  version = { network: 'live', network_identifier: DEV_GENESIS_HASH };
  await assert.rejects(client.requirePinnedNetwork(), rpcError);
  version = { network: 'dev', network_identifier: MAIN_GENESIS_HASH };
  await assert.rejects(client.requirePinnedNetwork(), rpcError);
});

test('mainnet version without an identifier is anchored to the signed native genesis on the chain RPC', async t => {
  // Given a public mainnet RPC declares live but omits network_identifier.
  let contents = MAIN_GENESIS_OPEN, confirmed = 'true';
  const rpc = await serverFixture(t, body => body.action === 'version'
    ? { network: 'live', node_vendor: 'Nano V28.2' }
    : { confirmed, block_account: MAIN_GENESIS_ACCOUNT, height: '1', contents });
  const work = await serverFixture(t, () => assert.fail('Genesis evidence must never be requested from the work provider'));
  const client = new NanoRpcClient(rpc.url, 'nano:mainnet', work.url);
  // When native genesis contents arrive as either an object or a strict JSON string.
  await client.requirePinnedNetwork();
  contents = JSON.stringify(MAIN_GENESIS_OPEN);
  confirmed = true;
  await client.requirePinnedNetwork();
  // Then the exact native genesis hash is independently recomputed and its signature verified through chain RPC only.
  assert.deepEqual(rpc.requests, [
    { action: 'version' }, { action: 'block_info', hash: MAIN_GENESIS_HASH, json_block: 'true' },
    { action: 'version' }, { action: 'block_info', hash: MAIN_GENESIS_HASH, json_block: 'true' },
  ]);
  assert.deepEqual(work.requests, []);
});

test('mainnet genesis fallback rejects altered confirmation, metadata, native identity, signature and malformed contents', async t => {
  // Given only a missing version identifier permits the native-genesis fallback.
  const valid = { confirmed: 'true', block_account: MAIN_GENESIS_ACCOUNT, height: '1', contents: MAIN_GENESIS_OPEN };
  let anchor = valid;
  const rpc = await serverFixture(t, body => body.action === 'version' ? { network: 'live' } : anchor);
  const client = new NanoRpcClient(rpc.url, 'nano:mainnet');
  // When the endpoint supplies tampered metadata or bytes despite claiming the expected hash.
  const cases = [
    { ...valid, confirmed: false }, { ...valid, confirmed: 'TRUE' }, { ...valid, confirmed: undefined },
    { ...valid, block_account: SOURCE }, { ...valid, height: '2' }, { ...valid, height: 1 }, { ...valid, height: '01' },
    ...[{ type: 'state' }, { source: ROOT }, { representative: SOURCE }, { account: SOURCE },
      { signature: '0'.repeat(128) }, { signature: MAIN_GENESIS_OPEN.signature.slice(2) }].map(fields =>
      ({ ...valid, hash: MAIN_GENESIS_HASH, contents: { ...MAIN_GENESIS_OPEN, ...fields } })),
    { ...valid, contents: '{"type":"open","type":"open"}' },
    { ...valid, contents: JSON.stringify(MAIN_GENESIS_OPEN) + ' {}' },
    { ...valid, contents: [] }, { ...valid, contents: null },
    { error: 'Block not found' },
  ];
  for (const value of cases) {
    anchor = value;
    await assert.rejects(client.requirePinnedNetwork(), rpcError);
  }
  // Then every attempted fallback used the exact mainnet genesis query and every altered response failed closed.
  assert.equal(rpc.requests.length, cases.length * 2);
  assert.equal(rpc.requests.filter(request => request.action === 'block_info')
    .every(request => request.hash === MAIN_GENESIS_HASH && request.json_block === 'true'), true);
});

test('present invalid identifiers, wrong network declarations and missing dev identifiers never trigger a genesis fallback', async t => {
  // Given a provider that could otherwise return a valid native genesis block.
  let version;
  const rpc = await serverFixture(t, body => body.action === 'version' ? version : assert.fail('Unexpected fallback'));
  const mainnet = new NanoRpcClient(rpc.url, 'nano:mainnet'), dev = new NanoRpcClient(rpc.url, 'nano:dev');
  // When an identifier is present but wrong, empty, null, malformed or of the wrong type.
  for (const network_identifier of [DEV_GENESIS_HASH, '', null, false, 123, 'invalid']) {
    version = { network: 'live', network_identifier };
    await assert.rejects(mainnet.requirePinnedNetwork(), rpcError);
  }
  version = { network: 'dev' };
  await assert.rejects(mainnet.requirePinnedNetwork(), rpcError);
  await assert.rejects(dev.requirePinnedNetwork(), rpcError);
  version = { network: 'live', network_identifier: MAIN_GENESIS_HASH };
  await assert.rejects(dev.requirePinnedNetwork(), rpcError);
  // Then a valid present mainnet identifier succeeds directly and no case queried genesis.
  await mainnet.requirePinnedNetwork();
  assert.equal(rpc.requests.length, 10);
  assert.equal(rpc.requests.every(request => request.action === 'version'), true);
});

test('version transport and remote errors never trigger a mainnet genesis fallback', async t => {
  // Given version fails before any network declaration can be trusted.
  let status = 200, reply = { error: 'Version unavailable' };
  const rpc = await serverFixture(t, (_body, response) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(reply));
  });
  const client = new NanoRpcClient(rpc.url, 'nano:mainnet');
  // When version returns a remote error, malformed response or HTTP error.
  await assert.rejects(client.requirePinnedNetwork(), rpcError);
  reply = [];
  await assert.rejects(client.requirePinnedNetwork(), rpcError);
  status = 503;
  await assert.rejects(client.requirePinnedNetwork(), rpcError);
  // Then each failure stops after version without trying an anchor read.
  assert.deepEqual(rpc.requests, [{ action: 'version' }, { action: 'version' }, { action: 'version' }]);
});

test('confirmed account RPC preserves bigint amounts and confirms frontier, balance and representative', async t => {
  let value = snapshot();
  const { client, requests } = await serverFixture(t, () => value);
  const account = await client.confirmedAccount(SOURCE);
  assert.deepEqual(account, { frontier: BLOCK.hash, balance: 100n, representative: SOURCE, epoch: 2 });
  assert.deepEqual(requests[0], { action: 'account_info', account: SOURCE, include_confirmed: 'true', representative: 'true' });
  value = snapshot({ frontier: 'B'.repeat(64) });
  await assert.rejects(client.confirmedAccount(SOURCE), { code: 'SOURCE_FRONTIER_UNCONFIRMED' });
  value = snapshot({ confirmed_balance: '99' });
  await assert.rejects(client.confirmedAccount(SOURCE), { code: 'SOURCE_FRONTIER_UNCONFIRMED' });
  value = snapshot({ confirmed_representative: DEV_GENESIS_ACCOUNT });
  await assert.rejects(client.confirmedAccount(SOURCE), { code: 'SOURCE_FRONTIER_UNCONFIRMED' });
});

test('account-not-found is nullable only for the exact single-field Nano error', async t => {
  let value = { error: 'Account not found' };
  const { client } = await serverFixture(t, () => value);
  assert.equal(await client.accountSnapshotOrNotFound(SOURCE), null);
  for (const error of [{ error: 'Account not found', frontier: ROOT }, { error: 'Bad account number' }, { error: 1 }]) {
    value = error;
    await assert.rejects(client.accountSnapshotOrNotFound(SOURCE), rpcError);
  }
});

test('account snapshot rejects future epochs and numeric or noncanonical raw balances', async t => {
  let value = snapshot();
  const { client } = await serverFixture(t, () => value);
  for (const fields of [{ account_version: '3' }, { account_version: 2 }, { account_version: '02' },
    { balance: 100 }, { balance: '01' }, { confirmed_balance: (1n << 128n).toString() }, { confirmed_frontier: 'abc' }]) {
    value = snapshot(fields);
    await assert.rejects(client.accountSnapshot(SOURCE), rpcError);
  }
});

test('block evidence recomputes the requested state hash and account independently', async t => {
  let value = evidence();
  const { client } = await serverFixture(t, () => value);
  const verified = await client.blockInfo(BLOCK.hash);
  assert.equal(verified.block.hash, BLOCK.hash);
  assert.equal(verified.confirmed, true);
  value = evidence(BLOCK, { contents: JSON.stringify(BLOCK.toWire()) });
  assert.equal((await client.blockInfo(BLOCK.hash)).block.hash, BLOCK.hash);
  value = evidence(BLOCK, { contents: { ...BLOCK.toWire(), balance: '99' } });
  await assert.rejects(client.blockInfo(BLOCK.hash), rpcError);
  value = evidence(BLOCK, { block_account: DEV_GENESIS_ACCOUNT });
  await assert.rejects(client.blockInfo(BLOCK.hash), rpcError);
});

test('block-not-found accepts only the exact absence error; malformed confirmations are fenced', async t => {
  let value = { error: 'Block not found' };
  const { client } = await serverFixture(t, () => value);
  assert.equal(await client.blockInfo(BLOCK.hash), null);
  value = { error: 'Something went wrong' };
  await assert.rejects(client.blockInfo(BLOCK.hash), rpcError);
  value = evidence(BLOCK, { confirmed: 'TRUE' });
  await assert.rejects(client.blockInfo(BLOCK.hash), rpcError);
  value = evidence(BLOCK, { successor: 'malformed' });
  await assert.rejects(client.blockInfo(BLOCK.hash), rpcError);
});

test('work generation sends only the public root and exact epoch threshold and checks returned work', async t => {
  // Given work has no separate endpoint and uses the configured RPC by default.
  let work = '8e8206e47e15b74b';
  const { client, requests } = await serverFixture(t, () => ({ work }));
  // When SEND and receive work are requested and a provider returns insufficient work.
  assert.equal(await client.generateWork(ROOT, 2), '8E8206E47E15B74B');
  assert.deepEqual(requests[0], { action: 'work_generate', hash: ROOT, difficulty: 'FFC0000000000000' });
  work = 'be46b2e52b34f535';
  await assert.rejects(client.generateWork(ROOT, 2), rpcError);
  work = '8e8206e47e15b74b';
  await client.generateWork(ROOT, 2, true);
  assert.equal(requests.at(-1).difficulty, 'F000000000000000');
  await client.generateOpenWork(ROOT);
  assert.equal(requests.at(-1).difficulty, 'FE00000000000000');
  // Then every work request reached that same RPC endpoint.
  assert.equal(client.workUrl.href, client.rpcUrl.href);
  assert.equal(requests.length, 4);
  assert.equal(requests.every(request => request.action === 'work_generate'), true);
});

test('a separate work endpoint receives only public send and receive roots while chain and publish actions stay on RPC', async t => {
  // Given independent RPC and work providers with observable HTTP requests.
  const rpc = await serverFixture(t, body => {
    switch (body.action) {
      case 'version': return { network: 'dev', network_identifier: DEV_GENESIS_HASH };
      case 'account_info': return snapshot();
      case 'block_info': return evidence();
      case 'blocks_info': return { blocks: { [BLOCK.hash]: { ...evidence(), pending: '1' } } };
      case 'receivable': return { blocks: { [BLOCK.hash]: { amount: '10', source: SOURCE } } };
      case 'process': return { hash: BLOCK.hash };
      default: assert.fail(`Unexpected RPC action: ${body.action}`);
    }
  });
  const work = await serverFixture(t, body => {
    assert.equal(body.action, 'work_generate');
    return { work: '8e8206e47e15b74b' };
  });
  const client = new NanoRpcClient(new URL(rpc.url), 'nano:dev', new URL(work.url));
  // When SEND, receive and open work are requested alongside chain checks and publication.
  await client.requirePinnedNetwork();
  await client.confirmedAccount(SOURCE);
  await client.blockInfo(BLOCK.hash);
  await client.receivableExists(BLOCK.hash);
  await client.receivable(SOURCE);
  assert.equal(await client.generateWork(ROOT, 2), '8E8206E47E15B74B');
  assert.equal(await client.generateWork(ROOT, 2, true), '8E8206E47E15B74B');
  assert.equal(await client.generateOpenWork(ROOT), '8E8206E47E15B74B');
  await client.process(BLOCK, 'send');
  await client.process(BLOCK, 'receive');
  // Then the work provider sees no account, block, signature, publication or version request.
  assert.deepEqual(work.requests, [
    { action: 'work_generate', hash: ROOT, difficulty: 'FFC0000000000000' },
    { action: 'work_generate', hash: ROOT, difficulty: 'F000000000000000' },
    { action: 'work_generate', hash: ROOT, difficulty: 'FE00000000000000' },
  ]);
  assert.deepEqual(rpc.requests.map(request => request.action),
    ['version', 'account_info', 'block_info', 'blocks_info', 'receivable', 'process', 'process']);
});

test('invalid work and remote errors from an explicit provider reject without retrying the chain RPC', async t => {
  // Given a working chain RPC and an explicitly selected but untrusted work provider.
  const rpc = await serverFixture(t, () => ({ network: 'dev', network_identifier: DEV_GENESIS_HASH }));
  let reply;
  const work = await serverFixture(t, () => reply);
  const client = new NanoRpcClient(rpc.url, 'nano:dev', work.url);
  // When the provider returns insufficient or malformed proof, malformed JSON, or a remote error.
  for (const response of [{ work: 'be46b2e52b34f535' }, { work: 'not-work' }, { work: 123 },
    { error: 'Work generation is disabled' }, '{"work":"8e8206e47e15b74b","work":"8e8206e47e15b74b"}']) {
    reply = response;
    await assert.rejects(client.generateWork(ROOT, 2), rpcError);
  }
  reply = { work: 'not-work' };
  await assert.rejects(client.generateOpenWork(ROOT), rpcError);
  // Then all failures remain at the work endpoint with no fallback; chain verification still works.
  assert.equal(work.requests.length, 6);
  assert.equal(rpc.requests.length, 0);
  await client.requirePinnedNetwork();
  assert.deepEqual(rpc.requests, [{ action: 'version' }]);
});

test('an explicit work provider cannot redirect requests or fail over after an HTTP error', async t => {
  // Given the work provider points a redirect at the separate chain RPC.
  const rpc = await serverFixture(t, () => ({ work: '8e8206e47e15b74b' }));
  let status = 307;
  const work = await serverFixture(t, (_body, response) => {
    response.writeHead(status, { Location: rpc.url });
    response.end('{}');
  });
  const client = new NanoRpcClient(rpc.url, 'nano:dev', work.url);
  // When the provider redirects or returns an HTTP error.
  await assert.rejects(client.generateWork(ROOT, 2), rpcError);
  status = 503;
  await assert.rejects(client.generateOpenWork(ROOT), rpcError);
  // Then no redirect or fallback reaches the chain RPC.
  assert.equal(work.requests.length, 2);
  assert.equal(rpc.requests.length, 0);
});

test('an explicit work provider timeout rejects without fallback and retains the work and chain timeout budgets', async t => {
  // Given a work provider that accepts a request but never returns a response.
  const rpc = await serverFixture(t, () => ({ network: 'dev', network_identifier: DEV_GENESIS_HASH }));
  const work = await serverFixture(t, () => undefined);
  const client = new NanoRpcClient(rpc.url, 'nano:dev', work.url);
  const timeout = AbortSignal.timeout.bind(AbortSignal), budgets = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    budgets.push(milliseconds);
    return timeout(milliseconds === 90_000 ? 250 : milliseconds);
  });
  // When the real HTTP work request reaches its shortened test deadline.
  await assert.rejects(client.generateWork(ROOT, 2), rpcError);
  // Then the production budget remains 90 seconds, with no retry on the working chain RPC.
  assert.equal(work.requests.length, 1);
  assert.equal(rpc.requests.length, 0);
  await client.requirePinnedNetwork();
  assert.deepEqual(budgets, [90_000, 15_000]);
  assert.deepEqual(rpc.requests, [{ action: 'version' }]);
});

test('separate work endpoint validation rejects credentials, fragments and non-HTTP schemes', () => {
  // Given a valid chain endpoint, the work endpoint must satisfy the same URL constraints.
  for (const url of ['https://user:password@work.example', 'https://work.example/#fragment',
    'file:///tmp/work', 'ftp://work.example']) {
    // When an invalid work endpoint is supplied, construction fails before any request.
    assert.throws(() => new NanoRpcClient('https://rpc.example', 'nano:mainnet', url), rpcError);
  }
  // Then accepted work URLs retain their path and query without changing the RPC URL.
  const client = new NanoRpcClient('https://rpc.example/rpc', 'nano:mainnet', 'https://work.example/work?key=test');
  assert.equal(client.workUrl.href, 'https://work.example/work?key=test');
  assert.equal(client.rpcUrl.href, 'https://rpc.example/rpc');
});

test('process publishes only a valid locally signed block and requires the exact returned hash', async t => {
  let response = { hash: BLOCK.hash.toLowerCase() };
  const { client, requests } = await serverFixture(t, () => response);
  await client.process(BLOCK, 'send');
  assert.deepEqual(requests[0], { action: 'process', json_block: 'true', subtype: 'send', block: BLOCK.toWire() });
  response = { hash: ROOT };
  await assert.rejects(client.process(BLOCK, 'send'), rpcError);
  const malformed = NanoStateBlock.parse({ ...BLOCK.toWire(), signature: '0'.repeat(128) });
  const count = requests.length;
  await assert.rejects(client.process(malformed, 'send'), rpcError);
  await assert.rejects(client.process(BLOCK, 'open'), rpcError);
  assert.equal(requests.length, count);
});

test('receivable requests confirmed sends only and returns validated exact raw amounts', async t => {
  let value = { blocks: { [BLOCK.hash]: { amount: '10', source: SOURCE } } };
  const { client, requests } = await serverFixture(t, () => value);
  assert.deepEqual(await client.receivable(SOURCE, 10), [{ hash: BLOCK.hash, amount: 10n, source: SOURCE }]);
  assert.deepEqual(requests[0], { action: 'receivable', account: SOURCE, count: '10', source: 'true', include_only_confirmed: 'true' });
  for (const blocks of ['', [], {}]) {
    value = { blocks };
    assert.deepEqual(await client.receivable(SOURCE), []);
  }
  for (const data of [{ amount: '0', source: SOURCE }, { amount: 10, source: SOURCE }, { amount: '10', source: 'bad' }]) {
    value = { blocks: { [BLOCK.hash]: data } };
    await assert.rejects(client.receivable(SOURCE), rpcError);
  }
});

test('confirmed evidence uses the pinned network epoch signer rather than the account key', () => {
  const client = new NanoRpcClient('http://127.0.0.1:1', 'nano:dev');
  const block = signedEpoch(2);
  const valid = { block, confirmed: true, subtype: 'epoch', blockAccount: SOURCE };
  assert.equal(block.validSignature(), false);
  assert.equal(client.validConfirmedBlock(valid, SOURCE), true);
  assert.equal(client.validSourceBlock(valid, SOURCE, 100n, SOURCE, 2), true);
  for (const altered of [signedEpoch(2, {}, SOURCE_KEY), signedEpoch(2, { balance: '101' }),
    signedEpoch(2, { representative: DEV_GENESIS_ACCOUNT }), signedEpoch(2, { previous: ZERO_HASH }),
    signedEpoch(2, { link: epochLink(1) })]) {
    assert.equal(client.validSourceBlock({ ...valid, block: altered }, SOURCE, 100n, SOURCE, 2), false);
  }
  assert.equal(client.validSourceBlock(valid, SOURCE, 100n, SOURCE, 1), false);
  assert.equal(client.validConfirmedBlock({ ...valid, confirmed: false }, SOURCE), false);
  assert.equal(new NanoRpcClient('https://rpc.example', 'nano:mainnet').validConfirmedBlock(valid, SOURCE), false);
});

test('confirmed frontier evidence must agree with snapshot amount, representative and epoch', async t => {
  const block = signedEpoch(2);
  const { client } = await serverFixture(t, () => evidence(block, { subtype: 'epoch' }));
  const account = { frontier: block.hash, balance: 100n, representative: SOURCE, epoch: 2 };
  assert.equal((await client.verifyFrontierState(account, SOURCE)).block.hash, block.hash);
  for (const altered of [{ ...account, balance: 99n }, { ...account, representative: DEV_GENESIS_ACCOUNT }, { ...account, epoch: 1 }]) {
    await assert.rejects(client.verifyFrontierState(altered, SOURCE), rpcError);
  }
});

test('an opened zero-balance account retains verifiable frontier evidence for receiving', async t => {
  const block = NanoStateBlock.signed(SOURCE_KEY, ROOT, SOURCE, 0n, 'A'.repeat(64), '0'.repeat(16));
  const { client } = await serverFixture(t, () => evidence(block));
  assert.equal((await client.verifyFrontierState({ frontier: block.hash, balance: 0n, representative: SOURCE, epoch: 2 }, SOURCE)).block.hash, block.hash);
});

test('malformed, duplicate-key, oversized and invalid UTF-8 RPC responses fail closed', async t => {
  let value = '{"network":"dev","network":"live","network_identifier":"' + DEV_GENESIS_HASH + '"}';
  const { client } = await serverFixture(t, () => value);
  await assert.rejects(client.requirePinnedNetwork(), rpcError);
  for (const malformed of ['[]', '{} {}', 'not json', Buffer.from([0xff, 0xfe]),
    JSON.stringify({ padding: 'x'.repeat(1_000_000) })]) {
    value = malformed;
    await assert.rejects(client.requirePinnedNetwork(), rpcError);
  }
});

test('RPC rejects redirects and HTTP error statuses', async t => {
  let status = 302;
  const { client, requests } = await serverFixture(t, (_body, response) => {
    response.writeHead(status, { Location: '/different' }); response.end('{}');
  });
  await assert.rejects(client.requirePinnedNetwork(), rpcError);
  assert.equal(requests.length, 1);
  status = 500;
  await assert.rejects(client.requirePinnedNetwork(), rpcError);
});

test('development-only opening rejects nonloopback, TLS, main and unsupported networks', () => {
  new NanoRpcClient('http://127.0.0.1:1234', 'nano:dev').requireLoopbackDevelopmentEndpoint();
  new NanoRpcClient('http://[::1]:1234', 'nano:dev').requireLoopbackDevelopmentEndpoint();
  for (const [url, network] of [['https://127.0.0.1:1234', 'nano:dev'], ['http://rpc.example', 'nano:dev'], ['http://127.0.0.1:1234', 'nano:mainnet']]) {
    assert.throws(() => new NanoRpcClient(url, network).requireLoopbackDevelopmentEndpoint(), { code: 'LOCAL_DEV_REQUIRED' });
  }
  assert.throws(() => new NanoRpcClient('http://rpc.example', 'nano:beta'), rpcError);
  assert.throws(() => new NanoRpcClient('https://user:password@rpc.example', 'nano:mainnet'), rpcError);
});

test('exact-hash receivability uses one bounded blocks_info response and rejects ambiguous or fake evidence', async t => {
  let value = { blocks: { [BLOCK.hash]: { ...evidence(), pending: '1' } } };
  const { client, requests } = await serverFixture(t, () => value);
  assert.equal(await client.receivableExists(BLOCK.hash), true);
  assert.deepEqual(requests[0], { action: 'blocks_info', hashes: [BLOCK.hash], json_block: 'true', pending: 'true' });
  value.blocks[BLOCK.hash].pending = '0';
  assert.equal(await client.receivableExists(BLOCK.hash), false);
  for (const entry of [evidence(), { ...evidence(), pending: true }, { ...evidence(), pending: '01' },
    { ...evidence(), pending: '1', confirmed: false }, { ...evidence(), pending: '1', subtype: 'receive' },
    { ...evidence(), pending: '1', block_account: DEV_GENESIS_ACCOUNT },
    { ...evidence(), pending: '1', contents: { ...BLOCK.toWire(), signature: '0'.repeat(128) } },
    { ...evidence(), pending: '1', contents: { ...BLOCK.toWire(), balance: '99' } }]) {
    value = { blocks: { [BLOCK.hash]: entry } };
    await assert.rejects(client.receivableExists(BLOCK.hash), rpcError);
  }
  for (const malformed of [ { error: 'Unknown command' }, { blocks: {} },
    { blocks: { [ROOT]: { ...evidence(), pending: '1' } } },
    { blocks: { [BLOCK.hash]: { ...evidence(), pending: '1' }, [ROOT]: { ...evidence(), pending: '1' } } } ]) {
    value = malformed;
    await assert.rejects(client.receivableExists(BLOCK.hash), rpcError);
  }
});
test('epoch-open requires zero economics, pinned signer, supported epoch and valid epoch work', async t => {
  const zero = addressFromPublicKey(new Uint8Array(32));
  function epochOpen(epoch, fields = {}, signer = DEV_KEY) {
    const wire = { account: SOURCE, previous: ZERO_HASH, representative: zero, balance: '0', link: epochLink(epoch),
      signature: '0'.repeat(128), work: '0'.repeat(16), type: 'state', ...fields };
    let block = NanoStateBlock.parse(wire);
    if (!Object.hasOwn(fields, 'work')) {
      for (let nonce = 0n;; nonce++) {
        wire.work = nonce.toString(16).padStart(16, '0');
        if (validWork('nano:dev', epoch, true, block.workRoot(), wire.work)) break;
      }
    }
    block = NanoStateBlock.parse(wire);
    return NanoStateBlock.parse({ ...wire, signature: upperHex(sign(signer, hexBytes(block.hash))) });
  }
  const block = epochOpen(2), valid = { block, confirmed: true, subtype: 'epoch', blockAccount: SOURCE };
  const { client } = await serverFixture(t, () => evidence(block, { subtype: 'epoch' }));
  assert.equal(client.validConfirmedBlock(valid, SOURCE), true);
  assert.equal((await client.verifyFrontierState({ frontier: block.hash, balance: 0n, representative: zero, epoch: 2 }, SOURCE)).block.hash, block.hash);
  assert.equal(client.validConfirmedBlock({ ...valid, block: epochOpen(1) }, SOURCE), true);
  let invalidWork = '0'.repeat(16);
  for (let nonce = 0n; validWork('nano:dev', 2, true, block.workRoot(), invalidWork); nonce++) invalidWork = nonce.toString(16).padStart(16, '0');
  for (const invalid of [epochOpen(2, { balance: '1' }), epochOpen(2, { representative: SOURCE }),
    epochOpen(2, {}, SOURCE_KEY), epochOpen(2, { work: invalidWork }),
    epochOpen(2, { account: zero }), epochOpen(2, { link: 'A'.repeat(64) })]) {
    assert.equal(client.validConfirmedBlock({ ...valid, block: invalid, blockAccount: invalid.account }, invalid.account), false);
  }
  assert.equal(client.validConfirmedBlock({ ...valid, confirmed: false }, SOURCE), false);
  assert.equal(new NanoRpcClient('https://rpc.example', 'nano:mainnet').validConfirmedBlock(valid, SOURCE), false);
  await assert.rejects(client.verifyFrontierState({ frontier: block.hash, balance: 0n, representative: zero, epoch: 3 }, SOURCE), rpcError);
});
