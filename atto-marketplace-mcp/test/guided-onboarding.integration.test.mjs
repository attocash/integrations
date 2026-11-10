import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {randomBytes, createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {createRequire, findPackageJSON} from 'node:module';
import {tmpdir} from '../../test/support/temporary-directory.mjs';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify, stripVTControlCharacters} from 'node:util';
import test from 'node:test';

const packageDirectory = process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR ?? join(import.meta.dirname, '..');
const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.resolve('@attocash/cli/core')));
const moduleUrl = name => pathToFileURL(join(packageDirectory, 'dist', name)).href;
const targetRequire = createRequire(join(packageDirectory, 'package.json'));
const adapterManifestPath = findPackageJSON('@attocash/atto-marketplace-nano-adapter', pathToFileURL(join(packageDirectory, 'package.json')));
const adapterManifest = JSON.parse(await readFile(adapterManifestPath, 'utf8'));
const adapterUrl = new URL(adapterManifest.exports['.'].import, pathToFileURL(adapterManifestPath)).href;
const {Client} = await import(pathToFileURL(targetRequire.resolve('@modelcontextprotocol/client')).href);
const {StdioClientTransport} = await import(pathToFileURL(targetRequire.resolve('@modelcontextprotocol/client/stdio')).href);
const {provisionNanoWallet, inspectNanoWallet} = await import(adapterUrl);
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
  const wallet = customWallet ? join(root, 'custom-cli-wallet') : process.platform === 'darwin' ? join(userHome, 'Library', 'Application Support', 'Atto CLI') : process.platform==='win32'?join(userHome,'AppData','Local','Atto CLI'):join(root, 'xdg', 'atto-cli');
  const bin = join(root, 'bin'), keyLog = join(root, 'keyring-access.log');
  await mkdir(bin, {recursive: true, mode: 0o700});
  // A disposable keyring adapter records only service/account lookups, never the phrase.
  await writeFile(join(bin, 'secret-tool'), [
    '#!/bin/sh', `printf '%s\\n' "$*" >> '${keyLog}'`, 'case "$1" in',
    ` lookup) printf '%s\\n' '${phrase}';;`, ' *) exit 77;;', 'esac', '',
  ].join('\n'), {mode: 0o700});
  const env = {ATTO_TEST_KEY_LOG:keyLog, LOCALAPPDATA:join(userHome,'AppData','Local'), PATH: bin + ':' + (process.env.PATH ?? ''), HOME: userHome, XDG_DATA_HOME: join(root, 'xdg'),
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
    access: app.ledger.mcpAccess(), pool: app.ledger.pool(), indexes: app.ledger.messageSigningIndexes(), proposal:app.ledger.proposal(), journal: app.store.get('spending.records')};}
  finally {await app.close();}
}

function terminalRun(env, args, steps, timeoutMs = 15_000) {
  const nativeFixture='data:text/javascript,'+encodeURIComponent(`
    import {appendFileSync} from 'node:fs';
    export class AsyncEntry {
      constructor(service,account){this.service=service;this.account=account;}
      async getPassword(){appendFileSync(process.env.ATTO_TEST_KEY_LOG,'lookup service '+this.service+' account '+this.account+' key_type mnemonic\\n');return ${JSON.stringify(phrase)};}
      async setPassword(){throw new Error('Read-only credential fixture');}
      async deleteCredential(){throw new Error('Read-only credential fixture');}
    }
  `);
  const harness = [
    "import {registerHooks} from 'node:module';",
    `registerHooks({resolve(specifier,context,next){return specifier==='@napi-rs/keyring'?{url:${JSON.stringify(nativeFixture)},shortCircuit:true}:next(specifier,context);}});`,
    "import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module';",
    'os.homedir=()=>process.env.ATTO_TEST_HOME; syncBuiltinESMExports();',
    "Object.defineProperty(process.stdin,'isTTY',{configurable:true,value:true});",
    "Object.defineProperty(process.stderr,'isTTY',{configurable:true,value:true});",
    "process.stdin.on('resume',()=>process.stdin.ref?.()); process.stdin.on('pause',()=>process.stdin.unref?.());",
    "process.stdin.setRawMode=value=>{process.stdin.isRaw=value;return process.stdin;};",
    // Redirect only the pinned production transport to the isolated HTTP fixture.
    "if(process.env.ATTO_TEST_PRODUCTION_TRANSPORT){const original=globalThis.fetch;globalThis.fetch=async(input,options)=>{const url=new URL(input);if(url.origin!=='https://api.atto.market')throw new Error('Unexpected production origin');const response=await original(process.env.ATTO_TEST_PRODUCTION_TRANSPORT+url.pathname,options);Object.defineProperty(response,'url',{value:url.href});return response;};}",
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
const reuseChoices = () => [step('Account pool:'), step('Spending policy:')];
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
function challenge(address, audience = 'marketplace') {
  const challengeId = '44444444-4444-4444-8444-444444444444';
  const issuedAt = new Date(Date.now() - 1000).toISOString(), expiresAt = new Date(Date.now() + 120_000).toISOString();
  const binding = createHash('sha256').update(['signer-controller-enrollment-v1', accountId, identityId].join('\n')).digest('hex');
  return {challengeId, issuedAt, expiresAt, accountId, controllerId: identityId,
    message: ['Marketplace Agent Controller Proof v1', `Audience: ${audience}`, 'Network: live', `Address: ${address}`, 'Purpose: login',
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

for (const production of [true, false]) {
test(`${production ? 'bare production' : 'custom override'} guided setup verifies a real private-host login proof and survives MCP restart`, async t => {
  // Given an existing CLI wallet and an isolated transport serving the production binding.
  const f = await fixture(t), before = await existingAtto(f), requests = [];
  if (production) f.home = join(f.env.ATTO_TEST_HOME, '.config', 'atto', 'marketplace-mcp');
  const profileId = production ? 'main' : 'agent';
  const audience = production ? 'urn:marketplace:agent-api:live' : 'marketplace';
  let issued, verified = false;
  const http = await listen(t, async (request, response) => {
    const value = await body(request); requests.push({path: request.url, body: value});
    if (request.url === '/v1/agent/auth/challenges') {issued = challenge(value.address, audience); return json(response, 200, issued);}
    if (request.url === '/v1/agent/auth/sessions') {
      verified = value.message === issued.message && await validAttoProof(before.identity.address, value.message, value.signature);
      if (!verified) return json(response, 403, {error: 'invalid-proof'});
      return json(response, 200, {accountId, agentId, identityId, accessToken: 'access-guided-fixture-secret',
        accessExpiresAt: new Date(Date.now() + 120_000).toISOString(), refreshToken: 'refresh-guided-fixture-secret',
        refreshExpiresAt: new Date(Date.now() + 240_000).toISOString()});
    }
    return json(response, 404, {});
  });
  const steps = [step('Configure an Atto wallet?'), step('Atto access:', '2'),
    step('Type APPROVE to save this Marketplace wallet access:', 'APPROVE'), step('Configure a Nano wallet?', 'no'),step('Type APPROVE to confirm:','APPROVE')];
  // When bare setup accepts wallet choices and typed login approval with no environment questions.
  const result = await terminalRun({...f.env, MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR:f.wallet, ...(production ? {ATTO_TEST_PRODUCTION_TRANSPORT: http.origin} : {})},
    production ? ['setup'] : ['setup', '--home', f.home, '--profile', profileId, '--origin', http.origin, '--audience', audience], steps);
  // Then the default private profile binds production and survives a runtime start without --profile.
  assert.doesNotMatch(result.stderr, /Marketplace configuration directory|Marketplace profile name|Marketplace origin \[|Agent API audience/);
  assert.equal(result.code, 0); assert.equal(result.index, steps.length); assert.equal(result.output.some(value => value.testError), false, result.stderr);
  assert.equal(steps.length-1,4,'Exactly four prompts precede the separate login proof approval');
  assert.doesNotMatch(result.stderr,/Type REUSE|Account pool:|Spending policy:|Type yes to approve this exact proposal|Connect this profile|Atto controller account index|Existing Atto CLI wallet directory|walletFingerprint|nodeUrl|workerUrl/);
  assert.equal(verified, true); assert.deepEqual(requests.map(value => value.path), ['/v1/agent/auth/challenges', '/v1/agent/auth/sessions']);
  assertPrivateOutput(result.stdout + result.stderr);
  const ready = result.output.find(value => value.mcpServers);
  assert.equal(ready.status, 'ready');
  const host = ready.mcpServers['atto-marketplace'];
  assert.equal(host.command, process.execPath); assert.deepEqual(host.args, [join(packageDirectory, 'dist/main.js'), '--home', f.home, '--profile', profileId]);
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
  const profiles = await MarketplaceProfileStore.open(f.home);
  try {assert.equal(profiles.getProfile(profileId).origin, production ? 'https://api.atto.market' : http.origin); assert.equal(profiles.getProfile(profileId).audience, audience);} finally {profiles.close();}
  const transport = new StdioClientTransport({command: host.command, args: host.args.slice(0, -2), env: {...f.env, ...host.env, ...(production ? {} : {MARKETPLACE_MCP_PROFILE: profileId})}, stderr: 'pipe'});
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

}

test('compact wallet approval never authorizes the later typed Marketplace login proof',async t=>{
  // Given a selected existing Atto wallet and an isolated login challenge endpoint.
  const f=await fixture(t),before=await existingAtto(f),requests=[];
  const http=await listen(t,async(request,response)=>{
    requests.push(request.url);const input=await body(request);
    if(request.url==='/v1/agent/auth/challenges')return json(response,200,challenge(input.address));
    return json(response,500,{error:'Unexpected signing or login session'});
  });
  const steps=[step('Configure an Atto wallet?'),step('Atto access:','1'),
    step('Type APPROVE to save this Marketplace wallet access:','APPROVE'),step('Configure a Nano wallet?','no'),
    step('Type APPROVE to confirm:','NO')];
  // When wallet access is approved but the separate exact login proof is declined.
  const result=await terminalRun({...f.env,MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR:f.wallet},
    ['setup','--home',f.home,'--origin',http.origin,'--audience','marketplace'],steps);
  // Then the earlier wallet decision never signs or creates a session by itself.
  assert.equal(result.index,5);assert.deepEqual(result.output.filter(value=>value.testError),[{testError:'APPROVAL_DECLINED'}]);
  assert.deepEqual(requests,['/v1/agent/auth/challenges']);
  assert.deepEqual(await attoSnapshot(f),before);
  assert.equal(readWalletSelection(f.home).attoAccess.marketplaceFunding,false);
  assert.equal(readWalletSelection(f.home).attoAccess.externalTransfers,false);
  const profiles=await MarketplaceProfileStore.open(f.home);
  try{assert.deepEqual(profiles.listProfileIds(),[]);assert.equal(profiles.getSetupState('main').state,'LOGIN_APPROVAL');}finally{profiles.close();}
  await assert.rejects(readFile(f.keyLog),{code:'ENOENT'});
});

test('setup --advanced dispatches to the preserved wallet and account chooser',async t=>{
  // Given an existing selected shared CLI wallet.
  const f=await fixture(t),before=await existingAtto(f);
  const steps=[step('Configure an Atto wallet?'),step('Atto wallet:'),step('Atto controller account index'),step('Type REUSE','NO')];
  // When the explicit advanced path is chosen and cancelled before native configuration.
  const result=await terminalRun({...f.env,MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR:f.wallet},['setup','--home',f.home,'--advanced'],steps);
  // Then the normal executable preserves access to account and native-authority configuration.
  assert.equal(result.index,steps.length);assert.deepEqual(result.output,[{testError:'CANCELLED'}]);
  assert.deepEqual(await attoSnapshot(f),before);assert.equal(readWalletSelection(f.home),undefined);
});

test('interactive setup cancellation preserves shared ATTO authority and its existing wallet pointer', async t => {
  // Given the existing wallet and its saved authority.
  const f = await fixture(t), before = await existingAtto(f);
  await mkdir(f.home, {mode: 0o700}); await saveWalletSelection(f.home, {attoDirectory: f.wallet});
  const selection = readWalletSelection(f.home);
  const steps = [step('Configure an Atto wallet?'),step('Atto access:', '4'),
    step('Type APPROVE to save this Marketplace wallet access:', 'DECLINE')];
  // When the person follows the revised wallet prompts.
  const result = await terminalRun(f.env, ['setup', '--home', f.home, '--profile', 'cancelled', '--origin', 'http://localhost:8080', '--audience', 'marketplace'], steps);
  // Then the selected wallet binding and existing authority are preserved.
  assert.equal(result.index, steps.length); assert.deepEqual(result.output, [{testError: 'APPROVAL_DECLINED'}]);
  assert.deepEqual(await attoSnapshot(f), before); assert.deepEqual(readWalletSelection(f.home), selection);
  const store = await MarketplaceProfileStore.open(f.home);
  try {assert.deepEqual(store.listProfileIds(), []); assert.equal(store.getSetupState('cancelled'), undefined);} finally {store.close();}
  assertPrivateOutput(result.stdout + result.stderr);
});

test('full-flag wallet setup cannot overwrite the network or grants of a selected shared CLI wallet', async t => {
  const f = await fixture(t, true), before = await existingAtto(f);
  await mkdir(f.home, {mode: 0o700}); await saveWalletSelection(f.home, {attoDirectory: f.wallet});
  const result = await terminalRun(f.env, ['wallet', 'setup', '--home', f.home, '--network', 'atto:beta',
    '--node-url', 'http://127.0.0.1:51234', '--worker-url', 'http://127.0.0.1:51235'], []);
  assert.deepEqual(result.output, [{testError: 'PROFILE_CONFLICT'}]);
  assert.deepEqual(await attoSnapshot(f), before); assert.equal(readWalletSelection(f.home).attoDirectory, f.wallet);
});

test('full-flag setup with matching settings retains old grants in a custom shared ATTO wallet', async t => {
  // Given a selected shared wallet with its existing bounded native authority.
  const f = await fixture(t, true), before = await existingAtto(f);
  await mkdir(f.home, {mode: 0o700}); await saveWalletSelection(f.home, {attoDirectory: f.wallet});
  const steps = [...reuseChoices(), ...marketplaceApproval()];
  // When the existing pool and limits are retained in explicit full-flag setup.
  const result = await terminalRun(f.env, ['wallet', 'setup', '--home', f.home, '--index', '3', '--network', 'atto:local',
    '--node-url', before.settings.nodeUrl, '--worker-url', before.settings.workerUrl], steps);
  assert.equal(result.index, steps.length); assert.equal(result.output.length, 1); assert.equal(result.output[0].status, 'wallet-configured',JSON.stringify(result.output));
  // Then no no-op native proposal replaces the original authority or proposal.
  assert.doesNotMatch(result.stderr,/Type yes to approve this exact proposal/);
  assert.deepEqual(await attoSnapshot(f),before);
  assert.equal(readWalletSelection(f.home).attoDirectory, f.wallet);
});

test('standalone ATTO reuse saves its default CLI selection into a newly approved configuration home', async t => {
  // Given the existing wallet and its saved authority.
  const f = await fixture(t), before = await existingAtto(f);
  const steps = [step('Atto wallet:'),step('Atto access:', '2'),
    step('Type APPROVE to save this Marketplace wallet access:', 'APPROVE')];
  // When the person follows the revised wallet prompts.
  const result = await terminalRun(f.env, ['wallet', 'setup', '--interactive', '--home', f.home, '--asset', 'ATTO'], steps);
  // Then the selected wallet binding and existing authority are preserved.
  assert.equal(result.index, steps.length); assert.equal(result.output.length, 1); assert.equal(result.output[0].status, 'wallet-configured',JSON.stringify(result.output));
  assert.equal(result.output[0].mcpServers, undefined);
  assert.equal((await stat(f.home)).mode&0o777,0o700);
  assert.deepEqual(await attoSnapshot(f),before);
  assert.equal(managedWalletEnvironment(f.home, {}).MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR, f.wallet);
});

test('standalone Nano reuse creates the approved private home and preserves the existing handoff after restart', async t => {
  // Given the existing wallet and its saved authority.
  const f = await fixture(t), wallet = await nanoWallet(f, 'existing-nano');
  const configuration = await readFile(join(wallet.directory, 'wallet.json'));
  const pendingFile = join(wallet.handoffDirectory, 'retained.request.json'); await writeFile(pendingFile, 'retained private handoff', {mode: 0o600});
  // When the person follows the revised wallet prompts.
  const result = await controlledTerminal(() => runWalletWizard(['--home', f.home, '--asset', 'XNO'], {},
    answers(['reuse', wallet.directory, 'keep', 'APPROVE'])));
  // Then the selected wallet binding and existing authority are preserved.
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
  // Given the existing wallet and its saved authority.
  const f = await fixture(t), wallet = await nanoWallet(f, 'existing-nano');
  const configuration = await readFile(join(wallet.directory, 'wallet.json'));
  // When the person follows the revised wallet prompts.
  await assert.rejects(controlledTerminal(() => runWalletWizard(['--home', f.home, '--asset', 'XNO'], {},
    answers(['reuse', wallet.directory, 'keep', 'NO']))), {code: 'APPROVAL_DECLINED'});
  // Then the selected wallet binding and existing authority are preserved.
  assert.equal(readWalletSelection(f.home), undefined); await assert.rejects(readdir(f.home), {code: 'ENOENT'});
  assert.deepEqual(await readFile(join(wallet.directory, 'wallet.json')), configuration);
});

test('a stale Nano environment selection never connects the controller the user replaced in the wizard', async t => {
  // Given the existing wallet and its saved authority.
  const f = await fixture(t), requested = [];
  const http = await listen(t, async (request, response) => {requested.push(await body(request)); json(response, 503, {error: 'fixture-stop-before-signing'});});
  const old = await nanoWallet(f, 'old-nano', http.origin), selected = await nanoWallet(f, 'chosen-nano', http.origin);
  const oldConfiguration = await readFile(join(old.directory, 'wallet.json'));
  // When the person follows the revised wallet prompts.
  await assert.rejects(controlledTerminal(() => runGuidedSetup(['--home', f.home, '--profile', 'agent', '--origin', http.origin, '--audience', 'marketplace'], {MARKETPLACE_MCP_NANO_WALLET_DATA_DIR: old.directory},
    answers(['no', 'yes', 'reuse', selected.directory, 'keep', 'APPROVE']))));
  // Then the selected wallet binding and existing authority are preserved.
  assert.ok(requested.every(value => value.address === selected.address), 'Login requested a controller different from the explicitly selected wallet');
  const store = await MarketplaceProfileStore.open(f.home);
  try {assert.deepEqual(store.listProfileIds(), []);} finally {store.close();}
  assert.deepEqual(await readFile(join(old.directory, 'wallet.json')), oldConfiguration);
  const preference = readWalletSelection(f.home);
  if (preference) assert.equal(preference.nanoDirectory, selected.directory);
  assert.equal((await inspectNanoWallet(selected.directory)).sourceAddress, selected.address);
});

test('standalone Nano wallet setup preserves a wallet-only path without Marketplace connection', async t => {
  // Given an existing Nano wallet and no Marketplace profile.
  const f = await fixture(t), wallet = await nanoWallet(f, 'existing-nano');
  // When standalone wallet setup selects and approves that wallet.
  const result = await controlledTerminal(() => runWalletWizard(['--home', f.home, '--asset', 'XNO'], {},
    answers(['reuse', wallet.directory, 'keep', 'APPROVE'])));
  const output = JSON.parse(result.output);
  // Then wallet setup saves the wallet without advertising a connected agent.
  assert.equal(output.status, 'wallet-configured'); assert.equal(output.mcpServers, undefined);
  assert.equal(output.address, wallet.address);
  const store = await MarketplaceProfileStore.open(f.home);
  try {assert.deepEqual(store.listProfileIds(), []); assert.equal(store.getSetupState('main'), undefined);} finally {store.close();}
});

test('bare setup reaches wallet decisions on a real terminal using production defaults', {skip: process.platform === 'win32'}, async t => {
  // Given a disposable home and the actual local-terminal input implementation.
  const f = await fixture(t);
  const source = ["import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module';",
    'os.homedir=()=>process.env.ATTO_TEST_HOME; syncBuiltinESMExports();',
    'const {run}=await import(process.env.ATTO_TEST_MAIN);',
    "try{await run(['setup'],process.env);}catch(error){process.stderr.write('Fixture result: '+error.code+'\\n');}"].join('\n');
  const steps = [{prompt:'Configure an Atto wallet?',response:'no'},{prompt:'Configure a Nano wallet?',response:'no'}];
  // When the person declines both wallets at the first two prompts.
  const result = await promisify(execFile)('python3', [join(import.meta.dirname, 'support/run-terminal.py'), JSON.stringify({
    command:[process.execPath,'--input-type=module','--eval',source], environment:f.env, steps, timeoutSeconds:10,
  })], {env:f.env,timeout:15_000,maxBuffer:1_048_576});
  const metadata = JSON.parse(result.stdout);
  const transcript = stripVTControlCharacters(Buffer.from(metadata.transcriptBase64,'base64').toString('utf8'));
  // Then no technical configuration questions or wallet mutation precede those decisions.
  assert.equal(metadata.timedOut,false,transcript); assert.equal(metadata.stepsAnswered,2,transcript);
  assert.match(transcript,/Marketplace: https:\/\/api\.atto\.market/); assert.match(transcript,/Profile: main/);
  assert.ok(transcript.includes(join(f.env.ATTO_TEST_HOME,'.config','atto','marketplace-mcp')));
  assert.doesNotMatch(transcript,/Marketplace configuration directory|Marketplace profile name|Agent API audience/);
  assert.match(transcript,/Fixture result: SETUP_USAGE/);
  await assert.rejects(readdir(join(f.env.ATTO_TEST_HOME,'.config','atto','marketplace-mcp','wallets')),{code:'ENOENT'});
});

for (const options of [
  ['--origin','http://localhost:8080'],
  ['--origin','https://api.other.example'],
  ['--origin','https://user:password@api.atto.market','--audience','custom'],
  ['--origin','https://api.atto.market/path','--audience','custom'],
  ['--origin','https://'+'a'.repeat(2050)+'.example','--audience','custom'],
  ['--audience','bad\naudience'],
]) {
  test(`invalid connection ${JSON.stringify(options).slice(0,100)} fails before wallet prompts or mutation`, async t => {
    // Given a new private home and incomplete or invalid explicit connection settings.
    const f = await fixture(t);
    const prompt = async () => assert.fail('Invalid connection reached wallet prompts');
    // When either guided setup owner validates those overrides.
    await assert.rejects(controlledTerminal(()=>runGuidedSetup(['--home',f.home,...options],{},prompt)),{code:'SETUP_USAGE'});
    await assert.rejects(controlledTerminal(()=>runWalletWizard(['--home',f.home,'--asset','XNO',...options],{},prompt)),{code:'SETUP_USAGE'});
    // Then the wallet selection and private wallet state remain absent.
    assert.equal(readWalletSelection(f.home),undefined);
    await assert.rejects(readdir(join(f.home,'wallets')),{code:'ENOENT'});
  });
}

test('saved non-production profiles and payment journals survive default setup and reject retargeting', async t => {
  // Given an existing custom profile selected through the documented home and profile environment overrides.
  const f = await fixture(t), origin = 'http://localhost:8080';
  const initial = await MarketplaceProfileStore.open(f.home);
  initial.createProfile({id:'custom',origin,audience:'custom-audience',accountId,agentId,identityId,
    controllerNetwork:'ATTO',controllerAddress:`atto://${'a'.repeat(61)}`,controllerIndex:7,
    authMode:'scoped-api-key',apiKey:'retained-private-key',apiScopes:['tasks:read']});
  const mutation={profileId:'custom',requestId:'55555555-5555-4555-8555-555555555555',operation:'marketplace-fund',target:accountId,requestHash:'retained-terms'};
  initial.beginMutation(mutation,'retained-payment');
  const before=initial.getProfile('custom'); initial.close();
  const env={MARKETPLACE_MCP_HOME:f.home,MARKETPLACE_MCP_PROFILE:'custom'};
  // When setup reopens it without overrides, or a caller tries a different binding.
  const result=await controlledTerminal(()=>runGuidedSetup([],env,async()=>assert.fail('Existing profile prompted')));
  for(const overrides of [['--origin','https://api.atto.market'],['--audience','urn:marketplace:agent-api:live']]) {
    await assert.rejects(controlledTerminal(()=>runGuidedSetup(overrides,env,async()=>assert.fail('Conflicting profile prompted'))),{code:'PROFILE_CONFLICT'});
  }
  // Then its original account, controller, connection, credential, and journal remain exact.
  assert.equal(JSON.parse(result.output).profileId,'custom');
  const saved=await MarketplaceProfileStore.open(f.home);
  try{assert.deepEqual(saved.getProfile('custom'),before);assert.deepEqual(saved.beginMutation(mutation),{state:'PENDING',resultIdentity:'retained-payment'});}finally{saved.close();}
});

test('pending custom setup keeps its saved binding and requires consent to resume', async t => {
  // Given a pending login under a custom binding and the default main profile.
  const f=await fixture(t), initial=await MarketplaceProfileStore.open(f.home);
  initial.createSetupState('main','LOGIN_READY',JSON.stringify({profileId:'main',origin:'http://localhost:8080',audience:'custom',
    controllerNetwork:'ATTO',controllerAddress:`atto://${'a'.repeat(61)}`,controllerIndex:7,accountId,identityId}));
  const before=initial.getSetupState('main');initial.close();
  const prompts=[];
  // When bare connection defaults encounter saved setup and the person declines resumption.
  await assert.rejects(controlledTerminal(()=>runGuidedSetup(['--home',f.home],{},async question=>{prompts.push(question);return 'no';})),{code:'CANCELLED'});
  await assert.rejects(controlledTerminal(()=>runGuidedSetup(['--home',f.home,'--origin','https://api.atto.market'],{},async()=>assert.fail('Conflicting pending setup prompted'))),{code:'PROFILE_CONFLICT'});
  // Then only resume consent was requested and no production binding replaced the pending payload.
  assert.equal(prompts.length,1);assert.match(prompts[0],/Resume this profile/);
  const saved=await MarketplaceProfileStore.open(f.home);
  try{assert.deepEqual(saved.getSetupState('main'),before);assert.deepEqual(saved.listProfileIds(),[]);}finally{saved.close();}
});
