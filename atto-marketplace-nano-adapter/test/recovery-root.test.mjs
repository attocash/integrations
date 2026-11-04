import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttoApplication } from '../../atto-cli/dist/application/app.js';
import { mnemonicSeed, derivedSigner } from '../../atto-cli/dist/wallet/signing.js';
import { inspectWalletProfile } from '@attocash/cli/profiles';
import { withMarketplaceRecoverySeed } from '@attocash/cli/internal-marketplace';
import { AttoMnemonic } from '@attocash/commons-core';
import { withPrivateKey } from '../dist/configuration.js';
import { deriveSlip10PrivateKey, deriveNanoRecoveryPrivateKey, derivePrivateKey, publicKey, addressFromPublicKey, upperHex,
  inspectNanoRecoveryWallet, provisionNanoWallet, inspectNanoWallet, loadConfiguration, approveNanoWalletPolicy, NanoWallet } from '../dist/index.js';

const phrase = `${'abandon '.repeat(23)}art`;
const nanoAddress = 'nano_1ago7jdaipwf9jycz7fjn7s7sc7qz5gqdwrmqhham7fhfih1x9no74r15gwr';
const attoAddress = 'atto://adxseu7ne6h3h5avlrmapalc6qw2dsygbungfscakf6re44prhufjy7syamqo';

test('shared BIP39 empty-passphrase and SLIP-0010 vectors match custody keys and rail-specific addresses', async () => {
  const vector = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  assert.equal(upperHex(deriveSlip10PrivateKey(vector, [])), '2B4BE7F19EE27BBF30C667B642D5F4AA69FD169872F8FC3059C08EBAE2EB19E7');
  assert.equal(upperHex(deriveSlip10PrivateKey(vector, [0])), '68E0FE46DFB67E368C75379ACEC591DAD19DF3CDE26E63B93A8E704F1DADE7A3');
  assert.equal(upperHex(deriveSlip10PrivateKey(vector, [0, 1, 2, 2, 1_000_000_000])), '8F94D394A8E8FD6B1BC2F3F49F5C47E385281D5C17E65324B0F62483E37E8793');
  const seed = await mnemonicSeed(phrase);
  try {
    const bytes = new Uint8Array(seed.value.buffer, seed.value.byteOffset, seed.value.byteLength);
    assert.equal(upperHex(bytes), '408B285C123836004F4B8842C89324C1F01382450C0D439AF345BA7FC49ACF705489C6FC77DBD4E3DC1DD8CC6BC9F043DB8ADA1E243C4A0EAFB290D399480840');
    const nano = deriveNanoRecoveryPrivateKey(bytes, 0), atto = deriveSlip10PrivateKey(bytes, [44, 1869902945, 0]);
    try {
      assert.equal(upperHex(nano), 'E340E759FFB408B34F95DA5D247C8A22C333F5D75A48794E5AC158C23811B3C5');
      assert.equal(upperHex(atto), 'A785C2C528FFFC88D02C1F1C8597002FC1D90F2AA7CECED5956A49DFFC9B6E20');
      assert.notDeepEqual(atto, nano);
      assert.equal(addressFromPublicKey(publicKey(nano)), nanoAddress);
      assert.equal((await derivedSigner(seed, 0)).address.value, attoAddress);
      assert.notEqual(addressFromPublicKey(publicKey(derivePrivateKey(nano, 0))), nanoAddress);
      assert.notEqual(addressFromPublicKey(publicKey(deriveNanoRecoveryPrivateKey(bytes, 1))), nanoAddress);
    } finally { nano.fill(0); atto.fill(0); }
    for (const index of [-1, 0x80000000, 0.5, NaN]) assert.throws(() => deriveNanoRecoveryPrivateKey(bytes, index));
  } finally { seed.value.fill(0); }
});

test('shared source stays in original OS namespace, pins identity on every use and never writes a Nano seed', async t => {
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
