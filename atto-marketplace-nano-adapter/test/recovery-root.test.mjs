import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { join } from 'node:path';
import { AttoApplication } from '../../atto-cli/dist/application/app.js';
import { inspectWalletProfile } from '@attocash/cli/profiles';
import { withMarketplaceRecoverySeed } from '@attocash/cli/internal-marketplace';
import { AttoMnemonic } from '@attocash/commons-core';
import { withPrivateKey } from '../dist/configuration.js';
import { upperHex,
  inspectNanoRecoveryWallet, provisionNanoWallet, inspectNanoWallet, loadConfiguration, approveNanoWalletPolicy, NanoWallet } from '../dist/index.js';

const phrase = `${'abandon '.repeat(23)}art`;
const nanoAddress = 'nano_1ago7jdaipwf9jycz7fjn7s7sc7qz5gqdwrmqhham7fhfih1x9no74r15gwr';
const attoAddress = 'atto://adxseu7ne6h3h5avlrmapalc6qw2dsygbungfscakf6re44prhufjy7syamqo';

test('shared source stays in original OS namespace, pins identity on every use and never writes a Nano seed', {skip: process.platform !== 'linux' && 'Requires the isolated Linux secret-tool fixture.'}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'shared-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'original-atto');
  const app = new AttoApplication({ directory, secrets: { get: async () => phrase, set: async () => {} } });
  try { await app.createWallet(phrase); } finally { await app.close(); }
  const profile = inspectWalletProfile(directory);
  const bin = join(root, 'bin'); mkdirSync(bin, { mode: 0o700 });
  writeFileSync(join(bin, 'secret-tool'), `#!/bin/sh\n[ "$*" = "$RECOVERY_TEST_LOOKUP" ] || exit 2\nprintf '%s\\n' "$RECOVERY_TEST_PHRASE"\n`, { mode: 0o700 });
  const originalEnv = { PATH: process.env.PATH, RECOVERY_TEST_LOOKUP: process.env.RECOVERY_TEST_LOOKUP, RECOVERY_TEST_PHRASE: process.env.RECOVERY_TEST_PHRASE };
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, RECOVERY_TEST_LOOKUP: `lookup service ${profile.credentialService} account ${profile.credentialAccount} key_type mnemonic`, RECOVERY_TEST_PHRASE: phrase });
  t.after(() => { for (const [key, value] of Object.entries(originalEnv)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const originalState = readFileSync(join(directory, 'state.sqlite'));
  const originalFiles = readdirSync(directory).filter(name => !/-wal$|-shm$/.test(name)).sort();
  let retained;
  const source = await withMarketplaceRecoverySeed(directory, async (seed, source) => { retained = seed; await Promise.resolve(); assert.notEqual(upperHex(seed), '0'.repeat(128)); return source; });
  assert.deepEqual([...retained], Array(64).fill(0));

  assert.deepEqual(source, { ...profile, identityAddress: attoAddress });
  await assert.rejects(withMarketplaceRecoverySeed(source, async seed => { retained = seed; throw Error('callback failure'); }), /callback failure/);
  assert.deepEqual([...retained], Array(64).fill(0));
  const inspected = await inspectNanoRecoveryWallet(directory, 0);
  assert.equal(inspected.address, nanoAddress);
  assert.deepEqual(readFileSync(join(directory, 'state.sqlite')), originalState);
  assert.deepEqual(readdirSync(directory).filter(name => !/-wal$|-shm$/.test(name)).sort(), originalFiles);
  await withMarketplaceRecoverySeed(source, async () => {
    let removed = false;
    const reset = new AttoApplication({ directory, secrets: { get: async () => phrase, set: async () => {}, remove: async () => { removed = true; } } });
    try { await assert.rejects(reset.resetWallet(null), { code: 'WALLET_BUSY' }); } finally { await reset.close(); }
    assert.equal(removed, false);
  });
  const dataDir = join(root, 'nano'), handoffDirectory = join(root, 'handoff');
  const options = { dataDir, recoveryWalletDirectory: directory, derivationIndex: 0, network: 'nano:dev', rpcUrl: 'http://localhost:17076', origin: 'http://localhost:8080', audience: 'marketplace', handoffDirectory, expectedAddress: inspected.address, terminalConfirmed: true };
  const provisioned = await provisionNanoWallet(options), config = await inspectNanoWallet(dataDir);
  assert.equal(provisioned.address, nanoAddress); assert.equal(config.version, 1);
  assert.equal(config.keySource.derivationVersion, 'bip39-ed25519-slip10-nano-v1');
  assert.deepEqual(config.keySource.recoverySource, source); assert.equal('seedFile' in config, false);
  assert.equal(existsSync(join(dataDir, 'seed.hex')), false);
  assert.equal(readFileSync(provisioned.configurationPath, 'utf8').includes(phrase), false);
  assert.equal(readFileSync(provisioned.configurationPath, 'utf8').includes('E340E759'), false);
  await withPrivateKey(config, async key => { retained = key; await Promise.resolve(); assert.equal(upperHex(key).length, 64); assert.notEqual(upperHex(key), '0'.repeat(64)); });
  assert.deepEqual([...retained], Array(32).fill(0));
  const savedConfig = readFileSync(provisioned.configurationPath);
  assert.deepEqual(await provisionNanoWallet(options), provisioned);
  assert.deepEqual(readFileSync(provisioned.configurationPath), savedConfig);
  const wallet = NanoWallet.open({ dataDir });
  try { assert.deepEqual(await wallet.call('identity.list'), { identities: [{ address: nanoAddress, index: 0, network: 'nano:dev' }] }); } finally { wallet.close(); }
  await approveNanoWalletPolicy({ dataDir, grants: { marketplaceFunding: false, externalTransfers: true, controllerPurposes: ['login'] }, limits: { maxPaymentAtomic: '2', rolling24hAtomic: '3' }, terminalConfirmed: true });
  assert.deepEqual(loadConfiguration(dataDir).keySource.recoverySource, source);
  assert.equal((await inspectNanoWallet(dataDir)).sourceAddress, nanoAddress);
  await assert.rejects(withMarketplaceRecoverySeed({ ...source, credentialAccount: 'different' }, () => {}), { code: 'WALLET_MISMATCH' });
  process.env.RECOVERY_TEST_PHRASE = '';
  await assert.rejects(inspectNanoWallet(dataDir), { code: 'WALLET_CREDENTIAL_MISSING' });
  process.env.RECOVERY_TEST_PHRASE = (await AttoMnemonic.generate()).phrase;
  await assert.rejects(inspectNanoWallet(dataDir), { code: 'WALLET_MISMATCH' });
  process.env.RECOVERY_TEST_PHRASE = phrase;
  const changed = { ...loadConfiguration(dataDir), derivationIndex: 1 };
  writeFileSync(provisioned.configurationPath, JSON.stringify(changed), { mode: 0o600 });
  await assert.rejects(inspectNanoWallet(dataDir), { code: 'WALLET_JOURNAL_BINDING' });
  renameSync(join(directory, 'state.sqlite'), join(directory, 'state.sqlite.saved'));
  const absent = join(root, 'absent');
  await assert.rejects(provisionNanoWallet({ ...options, dataDir: absent }), { code: 'WALLET_NOT_INITIALIZED' });
  assert.equal(existsSync(absent), false); assert.equal(existsSync(join(directory, 'state.sqlite')), false);
});
