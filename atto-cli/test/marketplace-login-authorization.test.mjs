import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AttoApplication } from '../dist/application/app.js';

const denied = { code: 'MARKETPLACE_LOGIN_AUTHORIZATION_REQUIRED' };

function proof(address, purpose = 'login') {
  const accountId = randomUUID(), identityId = randomUUID(), targetIdentityId = randomUUID();
  const login = purpose === 'login';
  const fields = login ? ['marketplace-login-v1', accountId, identityId] : ['unlink', accountId, targetIdentityId, identityId];
  const binding = createHash('sha256').update(fields.join('\n')).digest('hex');
  const challengeId = randomUUID(), issuedAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 120000).toISOString();
  const message = ['Marketplace Agent Controller Proof v1', 'Audience: marketplace-agent', 'Network: live',
    `Address: ${address}`, `Purpose: ${purpose}`, `Request ID: ${challengeId}`, `Binding Hash: ${binding}`,
    `Nonce: ${'ab'.repeat(32)}`, `Issued At: ${issuedAt}`, `Expiration Time: ${expiresAt}`].join('\n');
  return { version: 1, type: 'marketplace-controller-approval-request', profileId: 'agent', handoffId: 'a'.repeat(32),
    marketplaceOrigin: 'https://marketplace.example', transport: 'AGENT_API', proofOrigin: null, audience: 'marketplace-agent',
    accountId, identityId, controller: { network: 'ATTO', address, index: 0 }, purpose,
    action: login ? { kind: 'login', network: 'ATTO', address } : { kind: 'identity-unlink', targetIdentityId, authorizingIdentityId: identityId },
    challenge: { challengeId, message, issuedAt, expiresAt } };
}

test('deployment login requires a trusted file, exact tuple and valid typed login before reading the key', {
  skip: typeof process.geteuid !== 'function',
}, async t => {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'atto-login-')));
  const directory = join(home, 'wallet'), file = join(home, 'deployment.json');
  let phrase, reads = 0;
  const app = new AttoApplication({ directory, secrets: {
    get: async () => { reads++; return phrase; }, set: async value => { phrase = value; },
  } });
  t.after(async () => { await app.close(); fs.rmSync(home, { recursive: true, force: true }); });
  await app.createWallet();
  const address = (await app.call('wallet_status')).addresses[0].address;
  const request = proof(address);
  const policy = { version: 1, marketplaceHome: home, profileId: request.profileId, walletDirectory: directory,
    origin: request.marketplaceOrigin, audience: request.audience, controllerAddress: address, controllerIndex: 0 };
  const save = value => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  const sign = (input = request, path = file) => app.approvePreauthorizedMarketplaceLogin(input, home, path);
  save(policy);
  const baseline = reads;
  // A real service-owned file fails, as does running the signer as root.
  await assert.rejects(sign(), denied);
  await assert.rejects(sign(request, policy), denied);

  // Exercise a deployment-owned file without requiring privileged test setup.
  const fstat = fs.fstatSync;
  const fake = t.mock.method(fs, 'fstatSync', (...args) => Object.assign(fstat(...args), { uid: 0 }));
  t.mock.method(process, 'getuid', () => 1000);
  t.mock.method(process, 'geteuid', () => 1000);
  syncBuiltinESMExports();
  t.after(() => { fake.mock.restore(); syncBuiltinESMExports(); });
  fs.symlinkSync(file, join(home, 'link'));
  await assert.rejects(sign(request, join(home, 'link')), denied);
  fs.chmodSync(file, 0o620);
  await assert.rejects(sign(), denied);
  fs.chmodSync(file, 0o600);
  for (const [key, value] of Object.entries(policy)) {
    save({ ...policy, [key]: typeof value === 'number' ? value + 1 : value + '-other' });
    await assert.rejects(sign(), denied);
  }
  save({ ...policy, allowAll: true });
  await assert.rejects(sign(), denied);
  save(policy);
  await assert.rejects(sign(proof(address, 'unlink')), denied);
  await assert.rejects(sign({ ...request, challenge: { ...request.challenge,
    message: request.challenge.message.replace(/Binding Hash: [a-f0-9]+/, 'Binding Hash: ' + '0'.repeat(64)) } }),
    { code: 'MARKETPLACE_APPROVAL_PROTOCOL' });
  const settings = app.store.get('settings');
  app.store.set('settings', { ...settings, network: 'LOCAL' });
  await assert.rejects(sign(), { code: 'MARKETPLACE_APPROVAL_PROTOCOL' });
  app.store.set('settings', settings);
  assert.equal(reads, baseline);
  const response = await sign();
  assert.equal(response.message, request.challenge.message);
  assert.equal(response.controllerAddress, address);
  assert.match(response.signature, /^[a-f0-9]{128}$/i);
});
