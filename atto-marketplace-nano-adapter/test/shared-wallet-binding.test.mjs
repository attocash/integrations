import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, linkSync, symlinkSync, statSync, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { AttoApplication } from '../../atto-cli/dist/application/app.js';
import { inspectWalletProfile } from '@attocash/cli/profiles';
import { provisionNanoWallet, loadConfiguration, NanoWallet } from '../dist/index.js';

const execute = promisify(execFile), phrase = `${'abandon '.repeat(23)}art`;
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'nano-shared-binding-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), app = new AttoApplication({ directory: source, secrets: { get: async () => phrase, set: async () => {} } });
  try { await app.createWallet(phrase); } finally { await app.close(); }
  const profile = inspectWalletProfile(source), bin = join(root, 'bin'); mkdirSync(bin, { mode: 0o700 });
  const log = join(root, 'keyring-lookups');
  writeFileSync(join(bin, 'secret-tool'), `#!/bin/sh\n[ "$*" = "$BINDING_TEST_LOOKUP" ] || exit 77\nprintf '%s\\n' lookup >> "$BINDING_TEST_LOG"\nprintf '%s' "$BINDING_TEST_PHRASE"\n`, { mode: 0o700 });
  const environment = { PATH: `${bin}:${process.env.PATH}`, BINDING_TEST_LOOKUP: `lookup service ${profile.credentialService} account ${profile.credentialAccount} key_type mnemonic`, BINDING_TEST_PHRASE: phrase, BINDING_TEST_LOG: log };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]])); Object.assign(process.env, environment);
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const options = name => ({ dataDir: join(root, name), recoveryWalletDirectory: source, derivationIndex: 0, network: 'nano:dev', rpcUrl: 'http://localhost:1', origin: 'http://localhost:8080', audience: 'binding-test', handoffDirectory: join(root, name, 'handoffs'), terminalConfirmed: true });
  const claim = config => join(source, 'marketplace-nano-wallets', `${createHash('sha256').update(config.network).update('\0').update(config.sourceAddress).digest('hex')}.json`);
  return { root, source, options, claim, environment, log };
}
function noJournal(directory) { assert.equal(existsSync(join(directory, 'nano-wallet.sqlite3')), false); }
function deniedOpen(directory) {
  let called = false;
  const rpc = new Proxy({}, { get() { called = true; throw Error('RPC must not be inspected before rejecting the binding.'); } });
  assert.throws(() => NanoWallet.open({ dataDir: directory, rpc }), { code: 'WALLET_JOURNAL_BINDING' });
  assert.equal(called, false); noJournal(directory);
}
async function childProvision(options, environment) {
  const code = `import {provisionNanoWallet} from './dist/index.js'; try { const result=await provisionNanoWallet(JSON.parse(process.argv[1])); process.stdout.write(JSON.stringify({ok:true,result})); } catch(error) { process.stdout.write(JSON.stringify({ok:false,code:error.code,message:error.message})); }`;
  const env = { ...process.env, ...environment }; delete env.NODE_TEST_CONTEXT;
  const result = await execute(process.execPath, ['--input-type=module', '--eval', code, JSON.stringify(options)], { cwd: join(import.meta.dirname, '..'), env, timeout: 15_000 });
  return JSON.parse(result.stdout);
}

test('one shared account owns one exact journal directory; retries, restarts and separate accounts preserve its claim', async t => {
  const f = await fixture(t), options = f.options('original'), first = await provisionNanoWallet(options), config = loadConfiguration(options.dataDir);
  const claimPath = f.claim(config), originalClaim = readFileSync(claimPath), originalConfig = readFileSync(first.configurationPath);
  assert.equal(statSync(claimPath).mode & 0o777, 0o600); assert.equal(statSync(dirname(claimPath)).mode & 0o777, 0o700);
  assert.deepEqual(await provisionNanoWallet(options), first); assert.deepEqual(readFileSync(claimPath), originalClaim);
  const wallet = NanoWallet.open({ dataDir: options.dataDir }); wallet.close();
  assert.deepEqual(readFileSync(first.configurationPath), originalConfig);
  const second = f.options('other-home');
  await assert.rejects(async()=>provisionNanoWallet(second), error => error.code === 'WALLET_JOURNAL_BINDING' && error.message.includes(options.dataDir));
  assert.equal(existsSync(second.dataDir), false);
  const nextIndex = await provisionNanoWallet({ ...f.options('index-one'), derivationIndex: 1 }); assert.notEqual(nextIndex.address, first.address);
  const mainnet = await provisionNanoWallet({ ...f.options('mainnet'), network: 'nano:mainnet' }); assert.equal(mainnet.address, first.address);
  assert.equal(readdirSync(dirname(claimPath)).filter(name => name.endsWith('.json')).length, 3);
  assert.deepEqual(readFileSync(claimPath), originalClaim);
});

test('copied, missing, corrupted and source-tampered bindings fail before creating a journal or consulting RPC', async t => {
  const f = await fixture(t), options = f.options('original'), result = await provisionNanoWallet(options), config = loadConfiguration(options.dataDir);
  const claimPath = f.claim(config), claimBytes = readFileSync(claimPath), configBytes = readFileSync(result.configurationPath);
  const copied = f.options('copied').dataDir; mkdirSync(copied, { mode: 0o700 }); writeFileSync(join(copied, 'wallet.json'), configBytes, { mode: 0o600 });
  deniedOpen(copied); assert.deepEqual(readFileSync(claimPath), claimBytes);
  const lookups = readFileSync(f.log);
  writeFileSync(result.configurationPath, JSON.stringify({ ...config, keySource: { ...config.keySource, recoverySource: { ...config.keySource.recoverySource, credentialAccount: 'different' } } }), { mode: 0o600 });
  deniedOpen(options.dataDir); assert.deepEqual(readFileSync(f.log), lookups); assert.deepEqual(readFileSync(claimPath), claimBytes);
  writeFileSync(result.configurationPath, JSON.stringify({ ...config, keySource: { ...config.keySource, recoverySource: { ...config.keySource.recoverySource, directory: join(f.root,'missing-source') } } }), { mode: 0o600 });
  deniedOpen(options.dataDir); assert.equal(existsSync(join(f.root,'missing-source')),false);
  writeFileSync(result.configurationPath, configBytes);
  for (const corruption of ['{', JSON.stringify({ ...JSON.parse(claimBytes), dataDirectory: '/unverified' })]) {
    writeFileSync(claimPath, corruption); deniedOpen(options.dataDir);
  }
  writeFileSync(claimPath, claimBytes); unlinkSync(claimPath);
  const linked=join(f.root,'other-binding.json');writeFileSync(linked,claimBytes,{mode:0o600});symlinkSync(linked,claimPath);
  deniedOpen(options.dataDir);assert.deepEqual(readFileSync(f.log),lookups);unlinkSync(claimPath);
  deniedOpen(options.dataDir);
  await assert.rejects(async()=>provisionNanoWallet(options), { code: 'WALLET_JOURNAL_BINDING' });
  assert.equal(existsSync(claimPath), false); noJournal(options.dataDir);
});

test('claim-before-config crashes resume only the original directory and recover an exact interrupted hardlink publication', async t => {
  const f = await fixture(t), options = f.options('original'), result = await provisionNanoWallet(options), config = loadConfiguration(options.dataDir);
  const claimPath = f.claim(config), bytes = readFileSync(claimPath);
  unlinkSync(result.configurationPath);
  await assert.rejects(async()=>provisionNanoWallet(f.options('replacement')), { code: 'WALLET_JOURNAL_BINDING' });
  assert.deepEqual(await provisionNanoWallet(options), result);
  const temporary = join(dirname(claimPath), `.nano-${'a'.repeat(32)}.tmp`); linkSync(claimPath, temporary);
  assert.equal(statSync(claimPath).nlink, 2); assert.deepEqual(loadConfiguration(options.dataDir), config);
  assert.equal(existsSync(temporary), false); assert.equal(statSync(claimPath).nlink, 1); assert.deepEqual(readFileSync(claimPath), bytes);
  const configBytes=readFileSync(result.configurationPath), configTemporary=join(options.dataDir,`.nano-${'b'.repeat(32)}.tmp`);
  linkSync(result.configurationPath,configTemporary);assert.equal(statSync(result.configurationPath).nlink,2);
  assert.deepEqual(loadConfiguration(options.dataDir),config);assert.equal(existsSync(configTemporary),false);
  assert.deepEqual(readFileSync(result.configurationPath),configBytes);
  const occupied = f.options('occupied'); mkdirSync(occupied.dataDir, { mode: 0o700 }); writeFileSync(join(occupied.dataDir, 'wallet.json'), '{}', { mode: 0o600 });
  const before = readdirSync(dirname(claimPath)).sort();
  await assert.rejects(async()=>provisionNanoWallet({ ...occupied, derivationIndex: 9 }));
  assert.deepEqual(readdirSync(dirname(claimPath)).sort(), before); assert.deepEqual(readFileSync(claimPath), bytes);
  const orphan=f.options('orphan');mkdirSync(orphan.dataDir,{mode:0o700});
  const retained=Buffer.from('retained unknown native candidate journal');writeFileSync(join(orphan.dataDir,'nano-wallet.sqlite3'),retained,{mode:0o600});
  await assert.rejects(async()=>provisionNanoWallet({...orphan,derivationIndex:10}));
  assert.deepEqual(readdirSync(dirname(claimPath)).sort(),before);assert.equal(existsSync(join(orphan.dataDir,'wallet.json')),false);
  assert.deepEqual(readFileSync(join(orphan.dataDir,'nano-wallet.sqlite3')),retained);
  unlinkSync(result.configurationPath);writeFileSync(join(options.dataDir,'nano-wallet.sqlite3'),retained,{mode:0o600});
  await assert.rejects(async()=>provisionNanoWallet(options),{code:'WALLET_CONFIGURATION_EXISTS'});
  assert.deepEqual(readFileSync(join(options.dataDir,'nano-wallet.sqlite3')),retained);assert.deepEqual(readFileSync(claimPath),bytes);
});

test('concurrent processes cannot claim different journal directories; exact same-directory setup is idempotent', async t => {
  const f = await fixture(t), left = f.options('left'), right = f.options('right');
  const outcomes = await Promise.all([childProvision(left, f.environment), childProvision(right, f.environment)]);
  assert.equal(outcomes.filter(value => value.ok).length, 1);
  const winner = outcomes[0].ok ? left : right, loser = outcomes[0].ok ? right : left;
  assert.equal(outcomes.find(value => !value.ok).code, 'WALLET_JOURNAL_BINDING');
  assert.equal(outcomes.find(value => !value.ok).message.includes(winner.dataDir), true);
  assert.equal(existsSync(join(loser.dataDir, 'wallet.json')), false); noJournal(loser.dataDir);
  const same = { ...f.options('same'), derivationIndex: 2 };
  const repeats = await Promise.all([childProvision(same, f.environment), childProvision(same, f.environment)]);
  assert.deepEqual(repeats.map(value => value.ok), [true, true]); assert.deepEqual(repeats[0].result, repeats[1].result);
  const replay = await childProvision(winner, f.environment); assert.equal(replay.ok, true);
});
