import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes, createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {stripVTControlCharacters} from 'node:util';
import test from 'node:test';

const packageDirectory = process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR ?? join(import.meta.dirname, '..');
const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.resolve('@attocash/cli/core')));
const moduleUrl = name => pathToFileURL(join(packageDirectory, 'dist', name)).href;
const targetRequire = createRequire(join(packageDirectory, 'package.json'));
const {Client} = await import(pathToFileURL(targetRequire.resolve('@modelcontextprotocol/client')).href);
const {StdioClientTransport} = await import(pathToFileURL(targetRequire.resolve('@modelcontextprotocol/client/stdio')).href);
const {provisionNanoWallet, inspectNanoWallet} = await import(pathToFileURL(join(packageDirectory, '..', 'atto-marketplace-nano-adapter', 'dist/index.js')).href);
const {AttoApplication} = await import(pathToFileURL(join(cliDirectory, 'dist/application/app.js')).href);
const {runGuidedSetup, runWalletWizard} = await import(moduleUrl('guided-setup.js'));
const {MarketplaceProfileStore} = await import(moduleUrl('profile-store.js'));
const {readWalletSelection, saveWalletSelection} = await import(moduleUrl('wallet-preferences.js'));
const {managedWalletEnvironment} = await import(moduleUrl('wallet-home.js'));
const {validAttoProof} = await import(moduleUrl('atto-proof.js'));
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
const accountId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const identityId = '33333333-3333-4333-8333-333333333333';
const policy = {perRequest: {amount: '5', unit: 'ATTO'}, rolling: [{days: 2, amount: '12', unit: 'ATTO'}]};

async function fixture(t, customWallet = false) {
  const root = await mkdtemp(join(tmpdir(), 'marketplace-guided-onboarding-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const home = join(root, 'selected-configuration');
  const userHome = join(root, 'user-home');
  const wallet = customWallet ? join(root, 'custom-cli-wallet') : process.platform === 'darwin' ? join(userHome, 'Library', 'Application Support', 'Atto CLI') : join(root, 'xdg', 'atto-cli');
  const bin = join(root, 'bin'), keyLog = join(root, 'keyring-access.log');
  await mkdir(bin, {recursive: true, mode: 0o700});
  // A disposable keyring adapter records only service/account lookups, never the phrase.
  await writeFile(join(bin, 'secret-tool'), [
    '#!/bin/sh', `printf '%s\\n' "$*" >> '${keyLog}'`, 'case "$1" in',
    ` lookup) printf '%s\\n' '${phrase}';;`, ' *) exit 77;;', 'esac', '',
  ].join('\n'), {mode: 0o700});
  const env = {PATH: bin + ':' + (process.env.PATH ?? ''), HOME: userHome, XDG_DATA_HOME: join(root, 'xdg'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_RUNTIME_DIR: '', DBUS_SESSION_BUS_ADDRESS: '',
    ATTO_TEST_HOME: userHome, ATTO_TEST_MAIN: moduleUrl('main.js')};
  const open = () => new AttoApplication({directory: wallet, secrets: {get: async () => phrase, set: async () => {}, remove: async () => {}}});
  return {root, home, wallet, keyLog, env, open};
}

async function existingAtto(f) {
  const app = f.open();
  try {
    await app.createWallet(phrase);
    const initial = await app.call('wallet_status');
    app.store.set('settings', {...initial.settings, network: 'LOCAL', nodeUrl: 'http://127.0.0.1:41234', workerUrl: 'http://127.0.0.1:41235', autoReceive: false});
    const {proposal} = await app.call('limits_propose', {policy, access: 'spend', pool: {indexes: [0, 2], consolidate: true}, messageSigningIndexes: [1, 7]});
    await app.approveLimitsProposal(proposal.id);
    app.ledger.reserve({id: 'retained-payment', index: 0, destination: initial.identity.address, raw: '1000', network: 'LOCAL', createdAt: Date.now()});
  } finally {await app.close();}
  await writeFile(join(f.wallet, 'profile.json'), JSON.stringify({version: 1, credentialService: 'Atto CLI', defaultCli: true}), {mode: 0o600});
  return attoSnapshot(f);
}

async function attoSnapshot(f) {
  const app = f.open();
  try {return {identity: app.store.get('identity'), settings: app.store.get('settings'), policy: app.ledger.policy(),
    access: app.ledger.mcpAccess(), pool: app.ledger.pool(), indexes: app.ledger.messageSigningIndexes(), journal: app.store.get('spending.records')};}
  finally {await app.close();}
}

function terminalRun(env, args, steps, timeoutMs = 15_000) {
  const harness = [
    "import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module';",
    'os.homedir=()=>process.env.ATTO_TEST_HOME; syncBuiltinESMExports();',
    "Object.defineProperty(process.stdin,'isTTY',{configurable:true,value:true});",
    "Object.defineProperty(process.stderr,'isTTY',{configurable:true,value:true});",
    "process.stdin.on('resume',()=>process.stdin.ref?.()); process.stdin.on('pause',()=>process.stdin.unref?.());",
    "process.stdin.setRawMode=value=>{process.stdin.isRaw=value;return process.stdin;};",
    'const {run}=await import(process.env.ATTO_TEST_MAIN);',
    "try {await run(JSON.parse(process.env.ATTO_TEST_ARGS),process.env);} catch(error) {process.stdout.write(JSON.stringify({testError:error.code??'UNEXPECTED'})+'\\n');}",
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '--eval', harness], {cwd: packageDirectory,
    env: {...env, ATTO_TEST_ARGS: JSON.stringify(args)}, stdio: ['pipe', 'pipe', 'pipe']});
  let stdout = '', stderr = '', pending = '', index = 0;
  child.stdout.on('data', value => {stdout += value;});
  child.stderr.on('data', value => {
    stderr += value; pending += stripVTControlCharacters(value.toString());
    while (index < steps.length) {
      const step = steps[index], offset = pending.indexOf(step.prompt);
      if (offset < 0) break;
      pending = pending.slice(offset + step.prompt.length); index++;
      child.stdin.write(step.answer + '\n');
    }
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {child.kill('SIGKILL'); reject(new Error(`Guided setup timed out after answering ${index}/${steps.length} prompts.`));}, timeoutMs);
    child.once('error', error => {clearTimeout(timer); reject(error);});
    child.once('close', code => {clearTimeout(timer); resolve({code, index, stdout, stderr: stripVTControlCharacters(stderr),
      output: stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))});});
  });
}

const step = (prompt, answer = '') => ({prompt, answer});
const marketplaceApproval = () => [step('Allow Marketplace funding from this Atto wallet', 'yes'),
  step('Allow external Atto transfers from this wallet', 'no'), step('Type APPROVE to save this Marketplace wallet access:', 'APPROVE')];
const reuseApproval = (answer = 'yes') => [step('Account pool:'), step('Spending policy:'), step('Type yes to approve this exact proposal:', answer)];
function assertPrivateOutput(output) {
  for (const secret of [phrase, 'access-guided-fixture-secret', 'refresh-guided-fixture-secret']) assert.equal(output.includes(secret), false);
}

async function listen(t, handler) {
  const server = createServer((request, response) => {void Promise.resolve(handler(request, response)).catch(() => json(response, 500, {error: 'fixture-failure'}));});
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => {server.closeAllConnections(); return new Promise(resolve => server.close(resolve));});
  return {origin: `http://127.0.0.1:${server.address().port}`};
}
async function body(request) {let text = ''; for await (const chunk of request) text += chunk; return text ? JSON.parse(text) : null;}
function json(response, status, value) {response.writeHead(status, {'content-type': 'application/json'}); response.end(JSON.stringify(value));}
function challenge(address) {
  const challengeId = '44444444-4444-4444-8444-444444444444';
  const issuedAt = new Date(Date.now() - 1000).toISOString(), expiresAt = new Date(Date.now() + 120_000).toISOString();
  const binding = createHash('sha256').update(['signer-controller-enrollment-v1', accountId, identityId].join('\n')).digest('hex');
  return {challengeId, issuedAt, expiresAt, accountId, controllerId: identityId,
    message: ['Marketplace Agent Controller Proof v1', 'Audience: marketplace', 'Network: live', `Address: ${address}`, 'Purpose: login',
      `Request ID: ${challengeId}`, `Binding Hash: ${binding}`, `Nonce: ${'a'.repeat(64)}`, `Issued At: ${issuedAt}`, `Expiration Time: ${expiresAt}`].join('\n')};
}

async function controlledTerminal(action) {
  const stdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), stderr = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  const writeOut = process.stdout.write, writeError = process.stderr.write;
  let output = '';
  Object.defineProperty(process.stdin, 'isTTY', {configurable: true, value: true});
  Object.defineProperty(process.stderr, 'isTTY', {configurable: true, value: true});
  process.stdout.write = chunk => {output += chunk; return true;}; process.stderr.write = () => true;
  try {return {result: await action(), output};}
  finally {
    process.stdout.write = writeOut; process.stderr.write = writeError;
    if (stdin) Object.defineProperty(process.stdin, 'isTTY', stdin); else delete process.stdin.isTTY;
    if (stderr) Object.defineProperty(process.stderr, 'isTTY', stderr); else delete process.stderr.isTTY;
  }
}
function answers(values) {return async () => {assert.ok(values.length, 'Unexpected onboarding prompt'); return values.shift();};}
async function nanoWallet(f, name, origin = 'http://localhost:8080') {
  const directory = join(f.root, name), handoffDirectory = join(f.root, name + '-handoffs');
  const seedFile=join(f.root,name+'-seed.hex');
  await writeFile(seedFile,randomBytes(32).toString('hex')+'\n',{mode:0o600});
  const wallet = await provisionNanoWallet({seedFile,dataDir: directory, derivationIndex: 3, network: 'nano:dev', rpcUrl: 'http://localhost:17076',
    origin, audience: 'marketplace', handoffDirectory, grants: {marketplaceFunding: true, externalTransfers: false, controllerPurposes: ['login']},
    limits: {maxPaymentAtomic: '100', rolling24hAtomic: '1000'}, terminalConfirmed: true});
  return {...wallet, directory, handoffDirectory};
}

test('bare guided setup reuses the default CLI wallet, verifies a real private-host login proof, and survives MCP restart', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t), before = await existingAtto(f), requests = [];
  let issued, verified = false;
  const http = await listen(t, async (request, response) => {
    const value = await body(request); requests.push({path: request.url, body: value});
    if (request.url === '/v1/agent/auth/challenges') {issued = challenge(value.address); return json(response, 200, issued);}
    if (request.url === '/v1/agent/auth/sessions') {
      verified = value.message === issued.message && await validAttoProof(before.identity.address, value.message, value.signature);
      if (!verified) return json(response, 403, {error: 'invalid-proof'});
      return json(response, 200, {accountId, agentId, identityId, accessToken: 'access-guided-fixture-secret',
        accessExpiresAt: new Date(Date.now() + 120_000).toISOString(), refreshToken: 'refresh-guided-fixture-secret',
        refreshExpiresAt: new Date(Date.now() + 240_000).toISOString()});
    }
    return json(response, 404, {});
  });
  const steps = [step('Marketplace configuration directory', f.home), step('Marketplace profile name', 'agent'),
    step('Marketplace origin', http.origin), step('Agent API audience', 'marketplace'), step('Configure an Atto wallet?'),
    step('Atto wallet:', '2'), step('Existing Atto CLI wallet directory'), step('Atto controller account index'),
    step('Type REUSE', 'REUSE'), ...reuseApproval(), ...marketplaceApproval(), step('Configure a Nano wallet?', 'no'), step('Connect this profile to Marketplace now?'),step('Type APPROVE to confirm:','APPROVE')];
  const result = await terminalRun(f.env, ['setup'], steps);
  assert.equal(result.code, 0); assert.equal(result.index, steps.length); assert.equal(result.output.some(value => value.testError), false, result.stderr);
  assert.equal(verified, true); assert.deepEqual(requests.map(value => value.path), ['/v1/agent/auth/challenges', '/v1/agent/auth/sessions']);
  assertPrivateOutput(result.stdout + result.stderr);
  const ready = result.output.find(value => value.mcpServers);
  assert.equal(ready.status, 'ready');
  const host = ready.mcpServers['atto-marketplace'];
  assert.equal(host.command, process.execPath); assert.deepEqual(host.args, [join(packageDirectory, 'dist/main.js'), '--home', f.home, '--profile', 'agent']);
  assert.equal(host.env.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR, f.wallet);
  assert.ok(Object.keys(host.env).every(name => name.startsWith('MARKETPLACE_MCP_') && (name === 'MARKETPLACE_MCP_HOME' || name.endsWith('_DATA_DIR') || name.endsWith('_HANDOFF_DIR'))));
  const after = await attoSnapshot(f);
  assert.deepEqual(after,before);
  assert.equal(readWalletSelection(f.home).attoDirectory, f.wallet);
  assert.deepEqual(readWalletSelection(f.home).attoAccess, {address: before.identity.address, index: 0, network: 'atto:local',
    fingerprint: before.identity.fingerprint, marketplaceFunding: true, externalTransfers: false});
  assert.equal(host.env.MARKETPLACE_MCP_HOME, f.home);
  assert.equal(managedWalletEnvironment(f.home, {}).MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR, f.wallet);
  const lookups = (await readFile(f.keyLog, 'utf8')).trim().split('\n');
  assert.ok(lookups.length >= 1);
  assert.ok(lookups.every(value => value === `lookup service Atto CLI account ${createHash('sha256').update(f.wallet).digest('hex')} key_type mnemonic`));
  const transport = new StdioClientTransport({command: host.command, args: host.args, env: {...f.env, ...host.env}, stderr: 'pipe'});
  const client = new Client({name: 'guided-restart-test', version: '1.0.0'});
  try {
    await client.connect(transport);
    const status = await client.callTool({name: 'wallet_status', arguments: {asset: 'ATTO'}});
    assert.equal(status.isError, undefined);
    const saved = JSON.parse(status.content.find(value => value.type === 'text').text).result;
    assert.deepEqual(saved, {asset: 'ATTO', network: 'atto:local', address: before.identity.address, index: 0,
      permissions: {marketplaceFunding: true, externalTransfers: false, receive: true}});
  } finally {await client.close();}
  assert.deepEqual(await attoSnapshot(f), after);
});

test('interactive setup cancellation preserves shared ATTO authority and its existing wallet pointer', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t), before = await existingAtto(f);
  await mkdir(f.home, {mode: 0o700}); await saveWalletSelection(f.home, {attoDirectory: f.wallet});
  const selection = readWalletSelection(f.home);
  const steps = [step('Marketplace configuration directory'), step('Marketplace profile name', 'cancelled'),
    step('Marketplace origin', 'http://localhost:8080'), step('Agent API audience', 'marketplace'), step('Configure an Atto wallet?'),
    step('Atto wallet:'), step('Atto controller account index', '3'), step('Type REUSE', 'REUSE'), ...reuseApproval('no')];
  const result = await terminalRun(f.env, ['setup', '--interactive', '--home', f.home], steps);
  assert.equal(result.index, steps.length); assert.deepEqual(result.output, [{testError: 'CANCELLED'}]);
  assert.deepEqual(await attoSnapshot(f), before); assert.deepEqual(readWalletSelection(f.home), selection);
  const store = await MarketplaceProfileStore.open(f.home);
  try {assert.deepEqual(store.listProfileIds(), []); assert.equal(store.getSetupState('cancelled'), undefined);} finally {store.close();}
  assertPrivateOutput(result.stdout + result.stderr);
});

test('full-flag wallet setup cannot overwrite the network or grants of a selected shared CLI wallet', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t, true), before = await existingAtto(f);
  await mkdir(f.home, {mode: 0o700}); await saveWalletSelection(f.home, {attoDirectory: f.wallet});
  const result = await terminalRun(f.env, ['wallet', 'setup', '--home', f.home, '--network', 'atto:beta',
    '--node-url', 'http://127.0.0.1:51234', '--worker-url', 'http://127.0.0.1:51235'], []);
  assert.deepEqual(result.output, [{testError: 'PROFILE_CONFLICT'}]);
  assert.deepEqual(await attoSnapshot(f), before); assert.equal(readWalletSelection(f.home).attoDirectory, f.wallet);
});

test('full-flag setup with matching settings retains old grants in a custom shared ATTO wallet', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t, true), before = await existingAtto(f);
  await mkdir(f.home, {mode: 0o700}); await saveWalletSelection(f.home, {attoDirectory: f.wallet});
  const steps = [...reuseApproval(), ...marketplaceApproval()];
  const result = await terminalRun(f.env, ['wallet', 'setup', '--home', f.home, '--index', '3', '--network', 'atto:local',
    '--node-url', before.settings.nodeUrl, '--worker-url', before.settings.workerUrl], steps);
  assert.equal(result.index, steps.length); assert.equal(result.output.length, 1); assert.equal(result.output[0].status, 'wallet-configured');
  assert.deepEqual(await attoSnapshot(f),before);
  assert.equal(readWalletSelection(f.home).attoDirectory, f.wallet);
});

test('standalone ATTO reuse saves its default CLI selection into a newly approved configuration home', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t), before = await existingAtto(f);
  const steps = [step('Marketplace configuration directory'), step('Atto wallet:', '2'), step('Existing Atto CLI wallet directory'),
    step('Atto controller account index', '3'), step('Type REUSE', 'REUSE'), ...reuseApproval(), ...marketplaceApproval()];
  const result = await terminalRun(f.env, ['wallet', 'setup', '--interactive', '--home', f.home, '--asset', 'ATTO'], steps);
  assert.equal(result.index, steps.length); assert.equal(result.output.length, 1); assert.equal(result.output[0].status, 'wallet-configured');
  assert.equal(result.output[0].mcpServers, undefined);
  assert.deepEqual(await attoSnapshot(f),before);
  assert.equal(managedWalletEnvironment(f.home, {}).MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR, f.wallet);
});

test('standalone Nano reuse creates the approved private home and preserves the existing handoff after restart', async t => {
  const f = await fixture(t), wallet = await nanoWallet(f, 'existing-nano');
  const configuration = await readFile(join(wallet.directory, 'wallet.json'));
  const pendingFile = join(wallet.handoffDirectory, 'retained.request.json'); await writeFile(pendingFile, 'retained private handoff', {mode: 0o600});
  const result = await controlledTerminal(() => runWalletWizard(['--home', f.home, '--asset', 'XNO'], {},
    answers(['', 'reuse', wallet.directory, 'keep', 'APPROVE'])));
  assert.equal(JSON.parse(result.output).status, 'wallet-configured');
  assert.equal((await stat(f.home)).mode & 0o777, 0o700);
  const restart = managedWalletEnvironment(f.home, {});
  assert.equal(restart.MARKETPLACE_MCP_NANO_WALLET_DATA_DIR, wallet.directory);
  assert.equal(restart.MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR, wallet.directory);
  assert.equal(restart.MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR, wallet.handoffDirectory);
  assert.deepEqual(await readFile(join(wallet.directory, 'wallet.json')), configuration);
  assert.equal(await readFile(pendingFile, 'utf8'), 'retained private handoff');
});

test('cancelled standalone Nano reuse leaves a new configuration home and selection absent', async t => {
  const f = await fixture(t), wallet = await nanoWallet(f, 'existing-nano');
  const configuration = await readFile(join(wallet.directory, 'wallet.json'));
  await assert.rejects(controlledTerminal(() => runWalletWizard(['--home', f.home, '--asset', 'XNO'], {},
    answers(['', 'reuse', wallet.directory, 'keep', 'NO']))), {code: 'APPROVAL_DECLINED'});
  assert.equal(readWalletSelection(f.home), undefined); await assert.rejects(readdir(f.home), {code: 'ENOENT'});
  assert.deepEqual(await readFile(join(wallet.directory, 'wallet.json')), configuration);
});

test('a stale Nano environment selection never connects the controller the user replaced in the wizard', async t => {
  const f = await fixture(t), requested = [];
  const http = await listen(t, async (request, response) => {requested.push(await body(request)); json(response, 503, {error: 'fixture-stop-before-signing'});});
  const old = await nanoWallet(f, 'old-nano', http.origin), selected = await nanoWallet(f, 'chosen-nano', http.origin);
  const oldConfiguration = await readFile(join(old.directory, 'wallet.json'));
  await assert.rejects(controlledTerminal(() => runGuidedSetup(['--home', f.home], {MARKETPLACE_MCP_NANO_WALLET_DATA_DIR: old.directory},
    answers(['', 'agent', http.origin, 'marketplace', 'no', 'yes', 'reuse', selected.directory, 'keep', 'APPROVE', 'yes']))));
  assert.ok(requested.every(value => value.address === selected.address), 'Login requested a controller different from the explicitly selected wallet');
  const store = await MarketplaceProfileStore.open(f.home);
  try {assert.deepEqual(store.listProfileIds(), []);} finally {store.close();}
  assert.deepEqual(await readFile(join(old.directory, 'wallet.json')), oldConfiguration);
  const preference = readWalletSelection(f.home);
  if (preference) assert.equal(preference.nanoDirectory, selected.directory);
  assert.equal((await inspectNanoWallet(selected.directory)).sourceAddress, selected.address);
});

test('wallet-only guided setup never prints a ready Marketplace profile or usable MCP registration', async t => {
  const f = await fixture(t), wallet = await nanoWallet(f, 'existing-nano');
  const result = await controlledTerminal(() => runGuidedSetup(['--home', f.home], {},
    answers(['', 'agent', 'http://localhost:8080', 'marketplace', 'no', 'yes', 'reuse', wallet.directory, 'keep', 'APPROVE', 'no'])));
  const output = JSON.parse(result.output);
  assert.equal(output.status, 'wallets-configured'); assert.equal(output.mcpServers, undefined);
  assert.equal(output.nano.address, wallet.address);
  const store = await MarketplaceProfileStore.open(f.home);
  try {assert.deepEqual(store.listProfileIds(), []); assert.equal(store.getSetupState('agent'), undefined);} finally {store.close();}
});
