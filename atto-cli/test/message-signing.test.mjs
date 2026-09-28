import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(cliDirectory, 'package.json'));
const { AttoSignature } = require('@attocash/commons-core');
const applicationUrl = pathToFileURL(join(cliDirectory, 'dist/application/app.js'));
const { AttoApplication } = await import(applicationUrl.href);
const { mnemonicSeed, derivedSigner } = await import(pathToFileURL(join(cliDirectory, 'dist/wallet/signing.js')).href);

async function fixture(t, prefix = 'atto-message-signing-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  let phrase = null;
  let reads = 0;
  const secrets = { get: async () => { reads++; return phrase; }, set: async value => { phrase = value; } };
  const sessions = [];
  const open = access => {
    const app = new AttoApplication({ directory, secrets, ...(access ? { access } : {}) });
    sessions.push(app);
    return app;
  };
  t.after(async () => {
    for (const app of sessions.reverse()) await app.close();
    phrase = null;
    await rm(directory, { recursive: true, force: true });
  });
  const app = open();
  await app.createWallet();
  await app.call('address_derive', { index: 1 });
  return { app, open, directory, get phrase() { return phrase; }, get reads() { return reads; } };
}

async function approveMessageIndexes(app, indexes, access = 'read-only') {
  const { proposal } = await app.call('limits_propose', {
    policy: { perRequest: null, rolling: [] }, access, messageSigningIndexes: indexes,
  });
  await app.approveLimitsProposal(proposal.id);
}

test('message signing preserves empty, Unicode, multiline, whitespace, and binary bytes', async t => {
  // Given a new wallet with no message-signing grant.
  const f = await fixture(t);
  assert.deepEqual(f.app.ledger.messageSigningIndexes(), []);
  const beforeDenied = f.reads;
  // When an unapproved request is attempted and a local grant is approved.
  await assert.rejects(f.app.call('message_sign', { index: 0, message: 'not approved' }), { code: 'SIGNING_NOT_APPROVED' });
  assert.equal(f.reads, beforeDenied, 'an unapproved message signature does not read credentials');
  await approveMessageIndexes(f.app, [0, 1]);

  // Then every signature verifies over the exact original bytes.
  const seed = await mnemonicSeed(f.phrase);
  try {
    const expectedSigner = await derivedSigner(seed, 0);
    const cases = [
      { input: { message: '' }, bytes: Buffer.alloc(0) },
      { input: { message: 'Καλημέρα 🌍' }, bytes: Buffer.from('Καλημέρα 🌍', 'utf8') },
      { input: { message: 'first line\nsecond line\n' }, bytes: Buffer.from('first line\nsecond line\n', 'utf8') },
      { input: { message: '  tabs\t and spaces  ' }, bytes: Buffer.from('  tabs\t and spaces  ', 'utf8') },
      { input: { messageHex: '00ff807f10' }, bytes: Buffer.from([0x00, 0xff, 0x80, 0x7f, 0x10]) },
      { input: { messageHex: '' }, bytes: Buffer.alloc(0) },
    ];
    for (const { input, bytes } of cases) {
      const signed = await f.app.call('message_sign', { index: 0, ...input });
      assert.equal(signed.index, 0);
      assert.equal(signed.address, expectedSigner.address.value);
      assert.equal(signed.publicKey, expectedSigner.publicKey.toString());
      assert.equal(signed.signature.length, 128);
      assert.equal(signed.signature, (await expectedSigner.signMessage(new Int8Array(bytes))).toString());
      assert.deepEqual(await f.app.call('message_verify', {
        publicKey: signed.publicKey, signature: signed.signature, ...input,
      }), { valid: true });
      assert.deepEqual(await f.app.call('message_verify', {
        address: signed.address, signature: signed.signature, ...input,
      }), { valid: true });
      const changed = Buffer.concat([bytes, Buffer.from([0x20])]).toString('hex');
      assert.deepEqual(await f.app.call('message_verify', {
        publicKey: signed.publicKey, signature: signed.signature, messageHex: changed,
      }), { valid: false });
      assert.equal(await AttoSignature.Companion.parse(signed.signature).isValidMessage(expectedSigner.publicKey, new Int8Array(bytes)), true);
    }
  } finally { seed.value.fill(0); }
});

test('signing grants are profile-specific and MCP cannot use terminal proposal as approval', async t => {
  // Given separate terminal and MCP sessions for the same wallet profile.
  const f = await fixture(t);
  const mcp = f.open('mcp');
  // When a proposal grants an index and the local terminal approves it.
  const proposal = await mcp.call('limits_propose', {
    policy: { perRequest: null, rolling: [] }, access: 'spend', messageSigningIndexes: [1],
  });
  // Then only that profile can use the approved grant and read-only access still blocks signing.
  assert.deepEqual(f.app.ledger.messageSigningIndexes(), []);
  await assert.rejects(mcp.call('message_sign', { index: 1, message: 'challenge' }), { code: 'MCP_READ_ONLY' });
  await f.app.approveLimitsProposal(proposal.proposal.id);
  assert.deepEqual(f.app.ledger.messageSigningIndexes(), [1]);
  assert.equal(f.app.ledger.mcpAccess(), 'spend');
  const signed = await mcp.call('message_sign', { index: 1, message: 'challenge' });
  assert.equal(signed.index, 1);
  assert.equal(signed.signature.length, 128);

  const otherDirectory = await mkdtemp(join(tmpdir(), 'atto-message-other-profile-'));
  const other = new AttoApplication({ directory: otherDirectory, secrets: { get: async () => null, set: async () => {} } });
  t.after(async () => { await other.close(); await rm(otherDirectory, { recursive: true, force: true }); });
  assert.deepEqual(other.ledger.messageSigningIndexes(), []);
});

test('message verification never reads wallet credentials and byte inputs are capped at 64 KiB', async t => {
  // Given a valid public key/signature pair and a credential-read counter.
  const f = await fixture(t);
  const signerSeed = await mnemonicSeed(f.phrase);
  let signature;
  let publicKey;
  try {
    const signer = await derivedSigner(signerSeed, 0);
    publicKey = signer.publicKey.toString();
    signature = (await signer.signMessage(new Int8Array(Buffer.from('verify only', 'utf8')))).toString();
  } finally { signerSeed.value.fill(0); }
  // When exact UTF-8 and address-based verification run.
  const reads = f.reads;
  assert.deepEqual(await f.app.call('message_verify', { publicKey, signature, message: 'verify only' }), { valid: true });
  const savedAddress = f.app.store.get('addresses').find(value => value.publicKey === publicKey).address;
  assert.deepEqual(await f.app.call('message_verify', { address: savedAddress, signature, message: 'verify only' }), { valid: true });
  // Then public verification does not read credentials and the byte cap is enforced exactly.
  assert.equal(f.reads, reads);
  assert.deepEqual(await f.app.call('message_verify', { publicKey, signature, messageHex: 'aa'.repeat(65_536) }), { valid: false });
  await assert.rejects(f.app.call('message_verify', { publicKey, signature, messageHex: 'aa'.repeat(65_537) }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.app.call('message_verify', { publicKey, signature, message: 'x', messageHex: '78' }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.app.call('message_verify', { address: savedAddress, publicKey, signature, message: 'verify only' }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.app.call('message_verify', { publicKey, signature, messageHex: 'f' }), { code: 'INVALID_INPUT' });
});
