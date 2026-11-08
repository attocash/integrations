import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addressFromPublicKey, addressPublicKey, derivePrivateKey, NanoStateBlock, NanoWallet,
  provisionNanoWallet, publicKey, upperHex, ZERO_HASH } from '../dist/index.js';
import { DEV_GENESIS_HASH } from '../dist/rpc.js';

async function endpoint(t, reply) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(reply(body)));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

test('a provisioned wallet sends transfer and receive work only to its configured work provider', async t => {
  // Given a private dev wallet with separate HTTP chain and work endpoints and synthetic signed evidence.
  const directory = mkdtempSync(join(tmpdir(), 'nano-wallet-transport-'));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const seed = Buffer.from('01'.repeat(32), 'hex'), key = derivePrivateKey(seed, 1);
  const source = addressFromPublicKey(publicKey(key));
  const remoteKey = new Uint8Array(32).fill(2), remote = addressFromPublicKey(publicKey(remoteKey));
  const frontier = NanoStateBlock.signed(key, 'A'.repeat(64), source, 1000n, ZERO_HASH, '0'.repeat(16));
  const previous = NanoStateBlock.signed(remoteKey, 'B'.repeat(64), remote, 1000n, ZERO_HASH, '0'.repeat(16));
  const send = NanoStateBlock.signed(remoteKey, previous.hash, remote, 900n, upperHex(addressPublicKey(source)), '0'.repeat(16));
  const blocks = new Map([frontier, previous, send].map(block => [block.hash, block]));
  const evidence = block => ({ contents: block.toWire(), block_account: block.account, confirmed: 'true', subtype: 'send' });
  const rpc = await endpoint(t, body => {
    switch (body.action) {
      case 'version': return { network: 'dev', network_identifier: DEV_GENESIS_HASH };
      case 'account_info': return { frontier: frontier.hash, confirmed_frontier: frontier.hash,
        balance: '1000', confirmed_balance: '1000', representative: source,
        confirmed_representative: source, account_version: '2' };
      case 'block_info': return evidence(blocks.get(body.hash));
      case 'blocks_info': return { blocks: { [send.hash]: { ...evidence(send), pending: '1' } } };
      default: assert.fail(`Unexpected chain request: ${body.action}`);
    }
  });
  // A controlled refusal proves routing without generating PoW or publishing a candidate.
  const work = await endpoint(t, () => ({ error: 'Controlled work-provider refusal' }));
  const seedFile = join(directory, 'seed.hex');
  writeFileSync(seedFile, seed.toString('hex') + '\n', { mode: 0o600 });
  await provisionNanoWallet({ dataDir: directory, seedFile, derivationIndex: 1, network: 'nano:dev',
    rpcUrl: rpc.url, workUrl: work.url, origin: 'http://localhost:8080', audience: 'marketplace',
    handoffDirectory: join(directory, 'handoffs'), grants: { externalTransfers: true, marketplaceFunding: true },
    limits: { maxPaymentAtomic: '100', rolling24hAtomic: '100' }, terminalConfirmed: true });
  const wallet = NanoWallet.open({ dataDir: directory });
  try {
    // When normal wallet operations request SEND and receive work through the configured client.
    await assert.rejects(wallet.call('transfer.send', { network: 'nano:dev', destination: remote,
      amountAtomic: '10', requestId: randomUUID() }), { code: 'RPC_UNAVAILABLE' });
    await assert.rejects(wallet.call('receive', { network: 'nano:dev', hash: send.hash }), { code: 'RPC_UNAVAILABLE' });
    // Then only exact public work roots reach the provider, with no fallback or publication on refusal.
    assert.deepEqual(work.requests, [
      { action: 'work_generate', hash: frontier.hash, difficulty: 'FFC0000000000000' },
      { action: 'work_generate', hash: frontier.hash, difficulty: 'FE00000000000000' },
    ]);
    assert.equal(rpc.requests.some(body => ['work_generate', 'process'].includes(body.action)), false);
    assert.deepEqual(new Set(rpc.requests.map(body => body.action)),
      new Set(['version', 'account_info', 'block_info', 'blocks_info']));
  } finally { wallet.close(); }

  // Given the same configuration, an explicitly injected RPC continues to own wallet requests.
  let pinned = 0, snapshots = 0;
  const injected = NanoWallet.open({ dataDir: directory, rpc: {
    async requirePinnedNetwork() { pinned++; },
    async accountSnapshotOrNotFound() { snapshots++; return null; },
  } });
  const chainCount = rpc.requests.length, workCount = work.requests.length;
  try {
    // When balance is read through that injected client.
    assert.equal((await injected.call('balance.get', { network: 'nano:dev' })).balanceAtomic, '0');
    // Then the injected implementation is used without accessing either configured endpoint.
    assert.equal(pinned, 1);
    assert.equal(snapshots, 1);
    assert.equal(rpc.requests.length, chainCount);
    assert.equal(work.requests.length, workCount);
  } finally { injected.close(); }
});
