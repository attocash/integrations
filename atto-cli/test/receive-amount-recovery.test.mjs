import assert from 'node:assert/strict';
import test from 'node:test';
import { AttoTransaction } from '@attocash/commons-core';
import { fixture, until } from './support/payments.mjs';

const privateOptions = { internalMarketplaceReceiveSafety: true, receivingAllowed: () => false };
const keyFor = hash => `receive.LOCAL.${hash}`;
async function incoming(f, requestId = 'receive-amount-incoming', amount = '7') {
  return f.app.call('send', { index: 0, destination: f.addresses[1].address, amount, unit: 'RAW', requestId });
}
async function standaloneCompleted(t) {
  const f = await fixture(t, [100, 0]);
  const sent = await incoming(f);
  const received = await f.app.call('receive', { index: 1, hash: sent.hash });
  return { f, sent, received, key: keyFor(sent.hash), saved: f.app.store.get(keyFor(sent.hash)) };
}
function exactAmount(result, raw = '7') {
  assert.equal(result.amountAtomic ?? result.amount?.raw, raw);
}
function unchangedRecovery(f, before, reads, publications) {
  assert.deepEqual(f.app.store.get(before.key), before.saved);
  assert.equal(f.secretReads, reads);
  assert.equal(f.state.publicationAttempts.length, publications);
}

test('private RECEIVE saves its exact amount before publication and retains it through uncertain restart', { timeout: 30_000 }, async t => {
  // Given a private wallet with an incoming SEND and a worker failure before publication.
  const f = await fixture(t, [100, 0], undefined, '100', undefined, privateOptions);
  const sent = await incoming(f);
  f.state.failWork = true;
  const mcp = f.open('mcp', privateOptions);
  const receiving = mcp.call('receive', { index: 1, hash: sent.hash });
  let pending;
  try {
    await until(() => f.app.store.get(keyFor(sent.hash)));
    // When the pre-sign journal is durable but native publication has not begun.
    const saved = f.app.store.get(keyFor(sent.hash));
    // Then the exact amount is already bound to this candidate.
    assert.equal(saved.amountAtomic, '7');
    assert.equal(f.state.publicationAttempts.length, 1);
  } finally { pending = await receiving; }
  exactAmount(pending);
  assert.equal(pending.status, 'unknown');
  const saved = f.app.store.get(keyFor(sent.hash));
  await mcp.close();
  f.forbidSecrets();
  const reads = f.secretReads, requests = f.state.requests.length;
  const restarted = f.open('mcp');
  const replay = await restarted.call('receive', { index: 1, hash: sent.hash });
  assert.equal(replay.hash, pending.hash);
  exactAmount(replay);
  unchangedRecovery(f, { key: keyFor(sent.hash), saved }, reads, 1);
  assert.equal(f.state.requests.slice(requests).some(value => value.path === `/transactions/${sent.hash}`), false);
});

test('legacy interrupted standalone RECEIVE recovers the original signed SEND amount without keys or replacement', { timeout: 30_000 }, async t => {
  // Given an original standalone candidate whose publication was accepted but acknowledgement was lost.
  const { f, sent, key, saved } = await standaloneCompleted(t);
  const legacy = { hash: saved.hash, index: saved.index, blockHash: saved.blockHash };
  f.app.store.set(key, legacy);
  f.state.hiddenTransactionHashes.add(saved.blockHash);
  await f.reopen();
  f.forbidSecrets();
  const reads = f.secretReads;
  const mcp = f.open('mcp', privateOptions);
  // When Marketplace resumes this original candidate after restart.
  const result = await mcp.call('receive', { index: 1, hash: sent.hash });
  // Then signed source history supplies its exact amount and retains the original candidate unchanged.
  assert.equal(result.status, 'unknown');
  assert.equal(result.hash, saved.blockHash);
  exactAmount(result);
  unchangedRecovery(f, { key, saved: legacy }, reads, 2);
  assert.ok(f.state.requests.some(value => value.path === `/transactions/${sent.hash}`));
});

test('completed standalone recovery enriches a missing amount without rewriting the original record', { timeout: 30_000 }, async t => {
  // Given a valid original signed RECEIVE whose saved result predates amount output.
  const { f, sent, key, saved } = await standaloneCompleted(t);
  const legacy = structuredClone(saved);
  delete legacy.result.amount;
  f.app.store.set(key, legacy);
  await f.reopen();
  f.forbidSecrets();
  const reads = f.secretReads;
  const mcp = f.open('mcp', privateOptions);
  // When Marketplace resumes the completed original operation.
  const recovered = await mcp.call('receive', { index: 1, hash: sent.hash });
  // Then the returned amount comes from the signed SEND, with no record migration or native side effects.
  exactAmount(recovered);
  assert.equal(recovered.status, 'received');
  assert.equal(recovered.hash, saved.blockHash);
  unchangedRecovery(f, { key, saved: legacy }, reads, 2);
});

for (const completed of [false, true]) {
  test(`missing source history preserves the ${completed ? 'completed' : 'interrupted'} original RECEIVE and returns a retryable error`, { timeout: 30_000 }, async t => {
    // Given a legacy record without an amount whose original source SEND is unavailable.
    const { f, sent, key, saved } = await standaloneCompleted(t);
    const legacy = structuredClone(saved);
    if (completed) delete legacy.result.amount;
    else delete legacy.result;
    f.app.store.set(key, legacy);
    f.state.hideHashLookup = true;
    f.forbidSecrets();
    const reads = f.secretReads;
    const mcp = f.open('mcp', privateOptions);
    // When recovery cannot obtain authoritative source history.
    await assert.rejects(mcp.call('receive', { index: 1, hash: sent.hash }), { code: 'RECEIVE_RECOVERY_UNAVAILABLE' });
    // Then the original identity remains available for retry, without signing or publishing a replacement.
    unchangedRecovery(f, { key, saved: legacy }, reads, 2);
  });
}

for (const corruption of ['hash', 'network', 'receiver', 'type', 'signature', 'work']) {
  test(`historical SEND recovery rejects a wrong source ${corruption} without replacing the candidate`, { timeout: 30_000 }, async t => {
    // Given genuine signed SEND and RECEIVE transactions, with only the node history boundary or saved identity altered.
    const { f, sent, saved } = await standaloneCompleted(t);
    const originalSend = f.state.publications[0];
    const originalReceive = f.state.publications[1];
    let hash = sent.hash, network = 'LOCAL', index = 1, blockHash = saved.blockHash;
    let response = originalSend.toJson();
    if (corruption === 'hash') response = originalReceive.toJson();
    if (corruption === 'network') {
      network = 'BETA';
      f.app.store.set('settings', { ...f.app.store.get('settings'), network });
    }
    if (corruption === 'receiver') index = 0;
    if (corruption === 'type') {
      hash = originalReceive.hash.toString();
      blockHash = originalSend.hash.toString();
      response = originalReceive.toJson();
    }
    if (corruption === 'signature') {
      const json = JSON.parse(response);
      json.signature = '00'.repeat(64);
      response = JSON.stringify(json);
      assert.equal(await AttoTransaction.fromJson(response).isValid(), false);
    }
    if (corruption === 'work') {
      const json = JSON.parse(response);
      // Alter work only, keeping the source block and its real signature intact.
      for (let nonce = 0; ; nonce++) {
        json.work = nonce.toString(16).padStart(16, '0');
        response = JSON.stringify(json);
        if (!AttoTransaction.fromJson(response).work.isValid(originalSend.block)) break;
      }
      assert.equal(await AttoTransaction.fromJson(response).isValid(), false);
    }
    const key = `receive.${network}.${hash}`;
    const legacy = { hash, index, blockHash };
    f.app.store.set(key, legacy);
    f.state.hiddenTransactionHashes.add(blockHash);
    f.state.transactionResponses.set(hash, response);
    f.forbidSecrets();
    const reads = f.secretReads;
    const mcp = f.open('mcp', privateOptions);
    // When the original amount must be recovered through untrusted history.
    await assert.rejects(mcp.call('receive', { index, hash }), { code: 'TRANSACTION_MISMATCH' });
    // Then neither wrong native evidence nor corrupt cryptographic material can supply an amount.
    unchangedRecovery(f, { key, saved: legacy }, reads, 2);
  });
}

test('malformed saved amounts reject instead of falling back to otherwise valid signed history', { timeout: 30_000 }, async t => {
  // Given a valid original operation and independently corrupted persisted amount values.
  const { f, sent, key, saved } = await standaloneCompleted(t);
  f.state.hiddenTransactionHashes.add(saved.blockHash);
  f.forbidSecrets();
  const reads = f.secretReads;
  const mcp = f.open('mcp', privateOptions);
  for (const amountAtomic of [null, 7, '', '0', '-7', '7.5', '7e0', '18446744073709551616']) {
    const corrupted = { hash: saved.hash, index: saved.index, blockHash: saved.blockHash, amountAtomic };
    f.app.store.set(key, corrupted);
    const requests = f.state.requests.length;
    // When a present saved amount is malformed, recovery must not replace its meaning using history.
    await assert.rejects(mcp.call('receive', { index: 1, hash: sent.hash }), { code: 'INVALID_STATE' });
    // Then the exact corrupt record is preserved for repair and no source history or credentials are accessed.
    unchangedRecovery(f, { key, saved: corrupted }, reads, 2);
    assert.equal(f.state.requests.length, requests);
  }
});

test('saved candidate and completed result amounts must agree before offline replay', { timeout: 30_000 }, async t => {
  // Given a valid signed completed RECEIVE with contradictory saved amount metadata.
  const { f, sent, key, saved } = await standaloneCompleted(t);
  const corrupted = { ...saved, amountAtomic: '8' };
  f.app.store.set(key, corrupted);
  f.forbidSecrets();
  const reads = f.secretReads, requests = f.state.requests.length;
  const mcp = f.open('mcp', privateOptions);
  // When Marketplace recovers the saved result.
  await assert.rejects(mcp.call('receive', { index: 1, hash: sent.hash }), { code: 'INVALID_STATE' });
  // Then contradictory persisted evidence rejects without history fallback or mutation.
  unchangedRecovery(f, { key, saved: corrupted }, reads, 2);
  assert.equal(f.state.requests.length, requests);
});

test('complete standalone records replay offline with their original shape and exact result', { timeout: 30_000 }, async t => {
  // Given the normal standalone journal and its complete exact result.
  const { f, sent, received, key, saved } = await standaloneCompleted(t);
  assert.deepEqual(Object.keys(saved).sort(), ['blockHash', 'hash', 'index', 'result']);
  const { addressLabels, globalDirectory, ...nativeResult } = received;
  assert.deepEqual(saved.result, nativeResult);
  assert.deepEqual(received.amount, { raw: '7', atto: '0.000000007' });
  f.state.hideHashLookup = true;
  await f.reopen();
  f.forbidSecrets();
  const reads = f.secretReads, requests = f.state.requests.length;
  const mcp = f.open('mcp', privateOptions);
  // When Marketplace replays the original complete operation without node history.
  const replay = await mcp.call('receive', { index: 1, hash: sent.hash });
  // Then the existing standalone result and journal remain byte-for-byte compatible.
  assert.deepEqual(replay, received);
  unchangedRecovery(f, { key, saved }, reads, 2);
  assert.equal(f.state.requests.length, requests);
});

test('signed source recovery retains RAW precision above the JavaScript safe integer limit', { timeout: 30_000 }, async t => {
  // Given an exactly representable initial balance and a transfer whose RAW amount cannot be a JS number.
  const amount = '9007199254740993';
  const f = await fixture(t, [18014398509481984, 0], undefined, '18014398509481984');
  const sent = await incoming(f, 'receive-amount-large-incoming', amount);
  await f.app.call('receive', { index: 1, hash: sent.hash });
  const key = keyFor(sent.hash), saved = f.app.store.get(key);
  const legacy = { hash: saved.hash, index: saved.index, blockHash: saved.blockHash };
  f.app.store.set(key, legacy);
  f.state.hiddenTransactionHashes.add(saved.blockHash);
  f.forbidSecrets();
  const reads = f.secretReads;
  const mcp = f.open('mcp', privateOptions);
  // When the original signed SEND supplies the missing amount.
  const recovered = await mcp.call('receive', { index: 1, hash: sent.hash });
  // Then the exact raw integer survives parsing, recovery and return without rounding or new publication.
  exactAmount(recovered, amount);
  unchangedRecovery(f, { key, saved: legacy }, reads, 2);
});

test('completed recovery refuses an outward hash that differs from the original signed candidate', { timeout: 30_000 }, async t => {
  // Given a valid signed saved RECEIVE with a conflicting outward result hash.
  const { f, sent, key, saved } = await standaloneCompleted(t);
  const corrupted = { ...saved, result: { ...saved.result, hash: 'AB'.repeat(32) } };
  f.app.store.set(key, corrupted);
  f.forbidSecrets();
  const reads = f.secretReads, requests = f.state.requests.length;
  const mcp = f.open('mcp', privateOptions);
  // When the completed operation is replayed through the private Marketplace path.
  await assert.rejects(mcp.call('receive', { index: 1, hash: sent.hash }), { code: 'TRANSACTION_MISMATCH' });
  // Then the conflicting identity is rejected without changing its record or reaching the node.
  unchangedRecovery(f, { key, saved: corrupted }, reads, 2);
  // Earlier confirmed transactions may still trigger speculative worker requests.
  assert.deepEqual(f.state.requests.slice(requests).filter(request => !(request.method === 'POST' && request.path === '/works')), []);
});
