import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { join } from 'node:path';
import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';

const directory = process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR ?? join(import.meta.dirname, '..');
const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? join(import.meta.dirname, '../../atto-cli');
const { AttoApplication } = await import(pathToFileURL(join(cliDirectory, 'dist/application/app.js')).href);
const { mnemonicSeed } = await import(pathToFileURL(join(cliDirectory, 'dist/wallet/signing.js')).href);
const { OsSecretStore } = await import(pathToFileURL(join(cliDirectory, 'dist/storage/secrets.js')).href);
const { MarketplaceProfileStore } = await import(pathToFileURL(join(directory, 'dist/profile-store.js')).href);
const { approveMarketplaceController, runApproval } = await import(pathToFileURL(join(directory, 'dist/approval-terminal.js')).href);
const { approvalRequestDigest, approvalResponsePath, writeApprovalRequest, writeApprovalResponse } =
  await import(pathToFileURL(join(directory, 'dist/approval-files.js')).href);
const adapterManifestPath = findPackageJSON('@attocash/atto-marketplace-nano-adapter', pathToFileURL(join(directory, 'package.json')));
const adapterManifest = JSON.parse(await readFile(adapterManifestPath, 'utf8'));
const { provisionNanoWallet, derivePrivateKey, deriveNanoRecoveryPrivateKey, offchainSign, upperHex } =
  await import(new URL(adapterManifest.exports['.'].import, pathToFileURL(adapterManifestPath)).href);

const phrase = `${'abandon '.repeat(23)}art`;
const accountId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const identityId = '33333333-3333-4333-8333-333333333333';
const targetId = '44444444-4444-4444-8444-444444444444';

for (const source of ['native-seed', 'os-keystore']) {
  test(`cached Nano approval recovers without its unavailable ${source}`, async t => {
    // Given one exact historical signed response and its original pinned profile and native configuration.
    const root = await mkdtemp(join(tmpdir(), 'marketplace-approval-recovery-'));
    const home = join(root, 'marketplace'), native = join(root, 'nano'), recovery = join(root, 'atto'), handoffs = join(root, 'handoffs');
    const descriptors = [process.stdin, process.stderr].map(stream => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
    const originalGet = OsSecretStore.prototype.get;
    let store, privateKey;
    try {
      await mkdir(home, {mode: 0o700});
      await mkdir(native, {mode: 0o700});
      let sourceOptions;
      if (source === 'native-seed') {
        const seedFile = join(native, 'seed.hex');
        await writeFile(seedFile, `${'01'.repeat(32)}\n`, {mode: 0o600});
        privateKey = derivePrivateKey(Buffer.from('01'.repeat(32), 'hex'), 1);
        sourceOptions = {seedFile};
      } else {
        const app = new AttoApplication({directory: recovery, secrets: {get: async () => phrase, set: async () => {}}});
        try { await app.createWallet(phrase); } finally { await app.close(); }
        OsSecretStore.prototype.get = async () => phrase;
        const seed = await mnemonicSeed(phrase);
        try { privateKey = deriveNanoRecoveryPrivateKey(new Uint8Array(seed.value.buffer, seed.value.byteOffset, seed.value.byteLength), 1); }
        finally { seed.value.fill(0); }
        sourceOptions = {recoveryWalletDirectory: recovery};
      }
      const wallet = await provisionNanoWallet({dataDir: native, ...sourceOptions, derivationIndex: 1, network: 'nano:dev',
        rpcUrl: 'http://localhost:17076', origin: 'https://marketplace.example', audience: 'marketplace', handoffDirectory: handoffs,
        grants: {marketplaceFunding: false, externalTransfers: false, controllerPurposes: []},
        limits: {maxPaymentAtomic: '0', rolling24hAtomic: '0'}, terminalConfirmed: true});
      store = await MarketplaceProfileStore.open(home);
      store.createProfile({id: 'agent', origin: 'https://marketplace.example', audience: 'marketplace', accountId, agentId, identityId,
        controllerNetwork: 'NANO', controllerAddress: wallet.address, controllerIndex: 1, authMode: 'controller-session',
        accessToken: 'fixture-session-token', accessExpiresAt: Date.now() + 120000,
        refreshToken: 'fixture-refresh-token', refreshExpiresAt: Date.now() + 240000});
      const cached = request(wallet.address, Date.now() - 600000);
      saveHandoff(store, cached);
      const path = await writeApprovalRequest(home, 'agent', cached.handoffId, cached);
      const response = {version: 1, type: 'marketplace-controller-approval-response', profileId: 'agent', handoffId: cached.handoffId,
        requestDigest: approvalRequestDigest(cached), challengeId: cached.challenge.challengeId, message: cached.challenge.message,
        controllerAddress: wallet.address, controllerIndex: 1, signature: upperHex(offchainSign(privateKey, cached.challenge.message))};
      const responsePath = await writeApprovalResponse(home, cached, response);
      const originalResponse = await readFile(responsePath);
      let keyReads = 0, prompts = 0;
      OsSecretStore.prototype.get = async () => { keyReads++; throw Object.assign(new Error('Fixture keystore unavailable'), {code: 'SECRET_STORE_UNAVAILABLE'}); };
      if (source === 'native-seed') await rm(sourceOptions.seedFile);
      for (const stream of [process.stdin, process.stderr]) Object.defineProperty(stream, 'isTTY', {configurable: true, value: true});
      const options = {home, env: {MARKETPLACE_MCP_NANO_WALLET_DATA_DIR: native}, prompt: () => { prompts++; return true; }};

      // When the identical request is recovered after expiration with no signing material available.
      assert.deepEqual(await approveMarketplaceController(path, options), {responsePath, recovered: true});
      // The terminal command also infers this same private home from its native request path.
      const output = [];
      const write = t.mock.method(process.stdout, 'write', chunk => { output.push(String(chunk)); return true; });
      try { await runApproval([path], options.env); }
      finally { write.mock.restore(); }
      assert.deepEqual(JSON.parse(output.join('')), {responsePath, recovered: true});

      // Then its exact response is retained without a key read or another consent prompt.
      assert.deepEqual(await readFile(responsePath), originalResponse);
      assert.equal(keyReads, 0); assert.equal(prompts, 0);
      await writeFile(responsePath, JSON.stringify({...response, signature: '0'.repeat(128)}));
      await assert.rejects(approveMarketplaceController(path, options), {code: 'APPROVAL_FILE'});
      await writeFile(responsePath, originalResponse);
      await writeFile(path, JSON.stringify({...cached, action: {...cached.action, command: {...cached.action.command, targetApiKeyId: agentId}}}));
      await assert.rejects(approveMarketplaceController(path, options), {code: 'APPROVAL_BINDING'});
      await writeFile(path, JSON.stringify({...cached, purpose: 'administrator public moderation', action: {kind: 'adminModeration'}}));
      await assert.rejects(approveMarketplaceController(path, options), {code: 'APPROVAL_FILE'});
      await writeFile(path, JSON.stringify(cached));
      assert.equal(keyReads, 0); assert.equal(prompts, 0);

      // A new approval still requires a working key source after explicit terminal consent.
      const fresh = request(wallet.address, Date.now());
      saveHandoff(store, fresh);
      const freshPath = await writeApprovalRequest(home, 'agent', fresh.handoffId, fresh);
      await assert.rejects(approveMarketplaceController(freshPath, options),
        {code: source === 'native-seed' ? 'PRIVATE_FILE' : 'SECRET_STORE_UNAVAILABLE'});
      assert.equal(prompts, 1);
      assert.equal(keyReads, source === 'native-seed' ? 0 : 1);
      await assert.rejects(readFile(approvalResponsePath(home, 'agent', fresh.handoffId)), {code: 'ENOENT'});
    } finally {
      OsSecretStore.prototype.get = originalGet;
      privateKey?.fill(0);
      [process.stdin, process.stderr].forEach((stream, index) => {
        if (descriptors[index]) Object.defineProperty(stream, 'isTTY', descriptors[index]);
        else delete stream.isTTY;
      });
      store?.close();
      await rm(root, {recursive: true, force: true});
    }
  });
}

function saveHandoff(store, envelope) {
  store.putHandoff('agent', envelope.handoffId, 'CONTROLLER_APPROVAL', approvalRequestDigest(envelope), 'WAITING_APPROVAL',
    JSON.stringify({request: envelope}), Date.parse(envelope.challenge.expiresAt));
}
function request(address, now) {
  const challengeId = randomUUID(), handoffId = randomUUID().replaceAll('-', ''), idempotencyKey = randomUUID();
  const issuedAt = new Date(now - 1000).toISOString(), expiresAt = new Date(now + 120000).toISOString();
  const binding = createHash('sha256').update(['agent-credential-v1', accountId, identityId, 'REVOKE', targetId, idempotencyKey, ''].join('\n')).digest('hex');
  return {version: 1, type: 'marketplace-controller-approval-request', profileId: 'agent', handoffId,
    marketplaceOrigin: 'https://marketplace.example', transport: 'AGENT_API', proofOrigin: null, audience: 'marketplace', accountId, identityId,
    controller: {network: 'NANO', address, index: 1}, purpose: 'API-key revocation',
    action: {kind: 'credential', operation: 'REVOKE', command: {operation: 'REVOKE', targetApiKeyId: targetId, idempotencyKey}},
    challenge: {challengeId, issuedAt, expiresAt, message: `Nano Marketplace Agent Controller Proof v1\nAudience: marketplace\nNetwork: nano:dev\nAddress: ${address}\nPurpose: API-key revocation\nRequest ID: ${challengeId}\nBinding Hash: ${binding}\nNonce: ${'a'.repeat(64)}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`}};
}
