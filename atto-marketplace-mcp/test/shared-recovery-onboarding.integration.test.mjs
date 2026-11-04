import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const packageDirectory = process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR ?? join(import.meta.dirname, '..');
const main = join(packageDirectory, 'dist/main.js');
const attoDirectory=process.env.ATTO_TEST_CLI_PACKAGE_DIR;
const attoMain=attoDirectory?join(attoDirectory,'dist','cli','main.js'):join(dirname(fileURLToPath(import.meta.resolve('@attocash/cli/core'))),'cli/main.js');
const tty = join(import.meta.dirname, 'support/run-terminal.py');
const phrase = `${'abandon '.repeat(23)}art`;
const attoAddress = 'atto://adxseu7ne6h3h5avlrmapalc6qw2dsygbungfscakf6re44prhufjy7syamqo';
const nanoAddress = 'nano_1ago7jdaipwf9jycz7fjn7s7sc7qz5gqdwrmqhham7fhfih1x9no74r15gwr';
const setup = ['wallet', 'setup', '--asset', 'XNO', '--network', 'nano:dev', '--rpc-url', 'http://localhost:1',
  '--origin', 'http://localhost:8080', '--audience', 'shared-recovery-test'];
const consent = { prompt: 'Type APPROVE to confirm: ', response: 'APPROVE' };

function childEnvironment(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.NODE_TEST_CONTEXT;
  return env;
}
async function terminal(command, environment, steps) {
  const result = await execute('python3', [tty, JSON.stringify({ command, environment, steps, timeoutSeconds: 15 })], { env: childEnvironment(), timeout: 20_000, maxBuffer: 1_048_576 });
  const metadata = JSON.parse(result.stdout);
  const transcript = Buffer.from(metadata.transcriptBase64, 'base64').toString('utf8').replaceAll('\r', '');
  assert.equal(metadata.timedOut, false, transcript.replaceAll(phrase, '[fixture phrase]'));
  assert.equal(metadata.stepsAnswered, steps.length, transcript.replaceAll(phrase, '[fixture phrase]'));
  assert.equal(transcript.includes(phrase), false, 'Hidden recovery input must not be echoed.');
  return { ...metadata, transcript };
}
async function walletStatus(directory, environment) {
  const code = "import {createApplication} from '@attocash/cli/core'; const app=createApplication({directory:process.argv[1]}); try {process.stdout.write(JSON.stringify(await app.call('wallet_status')));} finally {await app.close();}";
  const result = await execute(process.execPath, ['--input-type=module', '--eval', code, directory], { cwd: packageDirectory, env: childEnvironment(environment) });
  assert.ok(result.stdout.length, 'Empty status output; stderr: '+result.stderr);
  return JSON.parse(result.stdout);
}
async function snapshot(directory) {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && !/-wal$|-shm$/.test(entry.name)) files[entry.name] = (await readFile(join(directory, entry.name))).toString('hex');
    if (entry.isDirectory()) files[entry.name] = await snapshot(join(directory, entry.name));
  }
  return files;
}
function assertNoAttoAuthority(status) {
  assert.equal(status.identity.address, attoAddress);
  assert.equal(status.mcpAccess, 'read-only'); assert.deepEqual(status.messageSigningIndexes, []);
  assert.equal(status.backgroundReceive.state, 'stopped');
  assert.deepEqual(status.pendingSends, []);
}

test('fresh Nano-only terminal onboarding imports one OS-protected recovery root and explicit Nano setup reuses an existing Atto root', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'marketplace-shared-recovery-terminal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); await mkdir(bin, { mode: 0o700 });
  // The disposable OS-store stand-in accepts only the published BIP39 vector
  // and exact selected namespace. Operation logs never contain recovery words.
  await writeFile(join(bin, 'secret-tool'), `#!/bin/sh
operation="$1"
case "$operation" in store) shift 2 ;; lookup) shift ;; *) exit 77 ;; esac
[ "$*" = "service Atto MCP account $ATTO_TEST_RECOVERY_ACCOUNT key_type mnemonic" ] || exit 78
printf '%s\\n' "$operation" >> "$ATTO_TEST_RECOVERY_OPERATIONS"
case "$operation" in
 lookup) [ -f "$ATTO_TEST_RECOVERY_STORE" ] || exit 1; cat "$ATTO_TEST_RECOVERY_STORE" ;;
 store) IFS= read -r value || [ -n "$value" ]; [ "$value" = "$ATTO_TEST_RECOVERY_PHRASE" ] || exit 79; umask 077; printf '%s' "$value" > "$ATTO_TEST_RECOVERY_STORE" ;;
esac
`, { mode: 0o700 });
  const environment = (home, source, name) => ({ MARKETPLACE_MCP_HOME: home, PATH: `${bin}:${process.env.PATH}`,
    ATTO_TEST_RECOVERY_ACCOUNT: createHash('sha256').update(source).digest('hex'), ATTO_TEST_RECOVERY_PHRASE: phrase,
    ATTO_TEST_RECOVERY_STORE: join(root, `${name}.fixture-keyring`), ATTO_TEST_RECOVERY_OPERATIONS: join(root, `${name}.operations`) });
  const home = join(root, 'fresh-home'), source = join(home, 'wallets/atto'), nano = join(home, 'wallets/nano');
  const env = environment(home, source, 'fresh');
  const created = await terminal([process.execPath, main, ...setup], env, [consent,
    { prompt: 'Recovery phrase: [1] Create new (default), [2] Import existing: ', response: '2' },
    { prompt: 'Type yes to store this shared recovery phrase in the OS password store: ', response: 'yes' },
    { prompt: 'Recovery phrase (hidden): ', response: phrase, hidden: true }]);
  assert.equal(created.exitCode, 0, created.transcript);
  assert.doesNotMatch(created.transcript, /Maximum ATTO|Maximum ATTO across|Node URL|Worker URL|approve this exact proposal/i);
  const configBytes = await readFile(join(nano, 'wallet.json')), config = JSON.parse(configBytes);
  assert.equal(config.version, 1); assert.equal(config.derivationIndex, 0); assert.equal(config.sourceAddress, nanoAddress);
  assert.equal(config.keySource.derivationVersion, 'bip39-ed25519-slip10-nano-v1');
  assert.deepEqual(config.keySource.recoverySource, { directory: source, credentialAccount: env.ATTO_TEST_RECOVERY_ACCOUNT, credentialService: 'Atto MCP', identityAddress: attoAddress });
  assert.deepEqual(config.grants, { marketplaceFunding: false, externalTransfers: false, controllerPurposes: [] });
  assert.equal('seedFile' in config, false); assert.equal(existsSync(join(nano, 'seed.hex')), false);
  assert.equal(configBytes.includes(Buffer.from(phrase)), false); assert.equal(await readFile(env.ATTO_TEST_RECOVERY_STORE, 'utf8'), phrase);
  const storeCount = async environment => (await readFile(environment.ATTO_TEST_RECOVERY_OPERATIONS, 'utf8')).trim().split('\n').filter(op => op === 'store').length;
  assert.equal(await storeCount(env), 1);
  assertNoAttoAuthority(await walletStatus(source, env));
  const status = await execute(process.execPath, [main, 'wallet', 'status', '--asset', 'XNO'], { env: childEnvironment(env) });
  assert.deepEqual(JSON.parse(status.stdout), {asset: 'XNO', address: nanoAddress, index: 0, network: 'nano:dev',
    permissions: {marketplaceFunding: false, externalTransfers: false, receive: false}});
  const sourceBefore = await snapshot(source);
  const replayed = await terminal([process.execPath, main, ...setup], env, [consent]);
  assert.equal(replayed.exitCode, 0, replayed.transcript);
  assert.deepEqual(await readFile(join(nano, 'wallet.json')), configBytes); assert.deepEqual(await snapshot(source), sourceBefore);
  assertNoAttoAuthority(await walletStatus(source, env));

  const originalSource=await snapshot(source),originalNano=await snapshot(nano);
  const secondHome=join(root,'second-home'),secondNano=join(secondHome,'wallets/nano');
  const duplicate=await terminal([process.execPath,main,...setup,'--recovery-wallet-dir',source],
    {...env,MARKETPLACE_MCP_HOME:secondHome},[consent]);
  assert.notEqual(duplicate.exitCode,0);
  assert.equal(duplicate.transcript.includes(nano),true,'The conflict must identify the original wallet directory.');
  assert.match(duplicate.transcript,/Reuse that wallet directory and its original journal/);
  assert.equal(existsSync(join(secondNano,'wallet.json')),false);
  assert.equal(existsSync(join(secondNano,'nano-wallet.sqlite3')),false);
  assert.deepEqual(await snapshot(source),originalSource);
  assert.deepEqual(await snapshot(nano),originalNano);
  assert.deepEqual(await readFile(join(nano,'wallet.json')),configBytes);
  assert.equal(await storeCount(env),1);

  const existingSource = join(root, 'existing-atto'), existingHome = join(root, 'existing-home');
  const existingEnv = environment(existingHome, existingSource, 'existing');
  const imported = await terminal([process.execPath, attoMain, '--json', '--no-update-notifier', '--data-dir', existingSource, 'wallet', 'import'], existingEnv,
    [{ prompt: 'Recovery phrase (hidden): ', response: phrase, hidden: true }]);
  assert.equal(imported.exitCode, 0, imported.transcript); assertNoAttoAuthority(await walletStatus(existingSource, existingEnv));
  const original = await snapshot(existingSource);
  const reused = await terminal([process.execPath, main, ...setup, '--recovery-wallet-dir', existingSource], existingEnv, [consent]);
  assert.equal(reused.exitCode, 0, reused.transcript); assert.match(reused.transcript, new RegExp(`Public address: ${nanoAddress}`));
  const existingNano = JSON.parse(await readFile(join(existingHome, 'wallets/nano/wallet.json'), 'utf8'));
  const afterSource=await snapshot(existingSource);
  const {'marketplace-nano-wallets':markers,...originalSourceFiles}=afterSource;
  assert.deepEqual(originalSourceFiles,original);
  const markerName=`${createHash('sha256').update('nano:dev').update('\0').update(nanoAddress).digest('hex')}.json`;
  assert.deepEqual(Object.keys(markers),[markerName]);
  assert.deepEqual(JSON.parse(Buffer.from(markers[markerName],'hex').toString('utf8')),{
    version:1,network:'nano:dev',address:nanoAddress,derivationIndex:0,keySource:existingNano.keySource,dataDirectory:join(existingHome,'wallets/nano'),
  });
  assert.equal(existingNano.sourceAddress, nanoAddress); assert.equal(existingNano.keySource.recoverySource.directory, existingSource);
  assert.equal(existsSync(join(existingHome, 'wallets/nano/seed.hex')), false); assertNoAttoAuthority(await walletStatus(existingSource, existingEnv));
  assert.equal(await storeCount(existingEnv), 1);

  const declinedHome = join(root, 'declined-home'), declinedSource = join(declinedHome, 'wallets/atto');
  const declinedEnv = environment(declinedHome, declinedSource, 'declined');
  const declined = await terminal([process.execPath, main, ...setup], declinedEnv, [consent,
    { prompt: 'Recovery phrase: [1] Create new (default), [2] Import existing: ', response: '2' },
    { prompt: 'Type yes to store this shared recovery phrase in the OS password store: ', response: 'no' }]);
  assert.notEqual(declined.exitCode, 0); assert.equal(existsSync(declinedHome), false); assert.equal(existsSync(declinedEnv.ATTO_TEST_RECOVERY_STORE), false);
});
