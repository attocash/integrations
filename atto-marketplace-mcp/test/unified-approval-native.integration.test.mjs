// Real terminal approval and real signatures across the Marketplace stdio boundary.
// Default: independent Kotlin contract vectors served by a disposable HTTP fixture.
// Optional backend: UNIFIED_APPROVAL_REAL_BACKEND=1 UNIFIED_APPROVAL_BACKEND_ORIGIN=http://localhost:8080
//   UNIFIED_APPROVAL_BACKEND_AUDIENCE=urn:marketplace:agent-api:local node --test test/unified-approval-native.integration.test.mjs
// The backend must be LOCAL with a short local payout cooldown and withdrawal minimum <= 1.
// Only fresh, unfunded wallets are created. Live withdrawals are prepared and
// signed, never submitted; no native transfer occurs.
import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createRequire, findPackageJSON} from 'node:module';
import {tmpdir} from '../../test/support/temporary-directory.mjs';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const packageDirectory = process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR ?? join(import.meta.dirname, '..');
const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.resolve('@attocash/cli/core')));
const targetRequire = createRequire(join(packageDirectory, 'package.json'));
const adapterManifestPath = findPackageJSON('@attocash/atto-marketplace-nano-adapter', pathToFileURL(join(packageDirectory, 'package.json')));
const adapterManifest = JSON.parse(await readFile(adapterManifestPath, 'utf8'));
const adapterUrl = new URL(adapterManifest.exports['.'].import, pathToFileURL(adapterManifestPath)).href;
const {Client} = await import(pathToFileURL(targetRequire.resolve('@modelcontextprotocol/client')).href);
const {StdioClientTransport} = await import(pathToFileURL(targetRequire.resolve('@modelcontextprotocol/client/stdio')).href);
const {offchainVerify} = await import(adapterUrl);
const {AttoApplication} = await import(pathToFileURL(join(cliDirectory, 'dist/application/app.js')).href);
const {MarketplaceProfileStore} = await import(pathToFileURL(join(packageDirectory, 'dist/profile-store.js')).href);
const {saveWalletSelection} = await import(pathToFileURL(join(packageDirectory, 'dist/wallet-preferences.js')).href);
const {validAttoProof} = await import(pathToFileURL(join(packageDirectory, 'dist/atto-proof.js')).href);
const {callWallet} = await import(pathToFileURL(join(packageDirectory, 'dist/wallet-process.js')).href);
const {shellQuote} = await import(pathToFileURL(join(packageDirectory, 'dist/shell-quote.js')).href);
const main = join(packageDirectory, 'dist/main.js');
// Published BIP39 test material, never a user's recovery phrase.
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
const accountId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const identityId = '33333333-3333-4333-8333-333333333333';
const destinationId = '44444444-4444-4444-8444-444444444444';
const keyId = '55555555-5555-4555-8555-555555555555';
const withdrawalId = '66666666-6666-4666-8666-666666666666';
const live = process.env.UNIFIED_APPROVAL_REAL_BACKEND === '1';
const hash = fields => createHash('sha256').update(fields.join('\n'), 'utf8').digest('hex');

// Independent transcription of AccountApiKeys.kt canonicalPayload/requestHash,
// PayoutAddresses.kt PayoutCommand.hash and WithdrawalLifecycle.kt WithdrawalCommand.hash.
// Do not import the implementation's approval parser or binding hash helper here.
function binding(request) {
  const {action, accountId: owner, identityId: actor} = request;
  const command = action.command;
  if (action.kind === 'credential') {
    let payload = '';
    if (command.credential) {
      const credential = command.credential;
      const scopes = [...credential.scopes].sort();
      const version = credential.productPublishAttoLimit != null || credential.productPublishXnoLimit != null ? 4
        : scopes.some(scope => /^(files|products|purchases):/.test(scope)) ? 3 : 2;
      const fields = [`agent-credential-v${version}`, credential.name.trim(), String(credential.expiresInDays ?? 90), scopes.join(','),
        credential.publishAttoLimit ?? '', credential.publishXnoLimit ?? '', credential.applyAttoLimit ?? '', credential.applyXnoLimit ?? ''];
      if (version >= 3) fields.push(credential.purchaseAttoLimit ?? '', credential.purchaseXnoLimit ?? '');
      if (version >= 4) fields.push(credential.productPublishAttoLimit ?? '', credential.productPublishXnoLimit ?? '');
      payload = fields.join('\n');
    }
    return hash(['agent-credential-v1', owner, actor, command.operation, command.targetApiKeyId ?? '', command.idempotencyKey, payload]);
  }
  if (action.kind === 'payout-address') return hash(['payout-address-v1', owner, actor, command.action, command.asset,
    action.network, command.destinationId ?? '', action.canonicalTargetAddress, command.expectedSelectionVersion?.toString() ?? '', command.idempotencyKey]);
  assert.equal(action.kind, 'withdrawal');
  return hash(['withdrawal-create-v2', owner, actor, command.asset, BigInt(command.atomicAmount).toString(), action.network,
    command.destinationId, action.destinationAddress, String(command.expectedSelectionVersion), command.idempotencyKey]);
}

function challenge(network, address, purpose, bindingHash) {
  const issuedAt = new Date(Date.now() - 1000).toISOString(), expiresAt = new Date(Date.now() + 240000).toISOString();
  const challengeId = randomUUID();
  return {challengeId, issuedAt, expiresAt, message: [network === 'NANO' ? 'Nano Marketplace Agent Controller Proof v1' : 'Marketplace Agent Controller Proof v1',
    'Audience: unified-approval-fixture', `Network: ${network === 'NANO' ? 'nano:dev' : 'live'}`, `Address: ${address}`, `Purpose: ${purpose}`,
    `Request ID: ${challengeId}`, `Binding Hash: ${bindingHash}`, `Nonce: ${'a'.repeat(64)}`, `Issued At: ${issuedAt}`, `Expiration Time: ${expiresAt}`].join('\n')};
}

async function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {env, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '', length = 0;
    const timer = setTimeout(() => {child.kill('SIGKILL'); reject(Error('Bounded acceptance child timed out.'));}, 45000);
    child.stdout.on('data', bytes => {length += bytes.length; output += bytes; if (length > 1048576) child.kill('SIGKILL');});
    child.stderr.on('data', bytes => {length += bytes.length; if (length > 1048576) child.kill('SIGKILL');});
    child.once('error', error => {clearTimeout(timer); reject(error);});
    child.once('close', code => {clearTimeout(timer); code === 0 ? resolve(output) : reject(Error(`Acceptance child exited ${code}; private diagnostics suppressed.`));});
  });
}

async function terminalApprove(fixture, requestPath, accepted = true) {
  const terminal = fileURLToPath(new URL('./support/run-terminal.py', import.meta.url));
  // Invoke the production helper in a real PTY; only the test prompt is injected.
  const source = `import {createInterface} from 'node:readline/promises';
    import {approveMarketplaceController} from ${JSON.stringify(pathToFileURL(join(packageDirectory, 'dist/approval-terminal.js')).href)};
    const terminal=createInterface({input:process.stdin,output:process.stderr});
    try {const value=await approveMarketplaceController(process.argv[1],{home:process.argv[2],env:process.env,
      prompt:async preview=>{process.stderr.write(preview+'\\n');return (await terminal.question('APPROVE THIS FIXTURE: ')).trim()==='APPROVE';}});
      process.stdout.write(JSON.stringify({approved:true,recovered:value.recovered})+'\\n');}
    finally {terminal.close();}`;
  const output = await run('python3', [terminal, JSON.stringify({command: [process.execPath, '--input-type=module', '--eval', source, requestPath, fixture.home],
    prompt: 'APPROVE THIS FIXTURE: ', response: 'APPROVE', timeoutSeconds: 30})], fixture.env);
  const envelope = JSON.parse(output);
  assert.equal(envelope.timedOut, false);
  if (accepted) assert.equal(envelope.exitCode, 0, 'The production terminal helper rejected the exact fixture approval.');
  else assert.notEqual(envelope.exitCode, 0, 'The production terminal helper signed a changed fixture approval.');
  const transcript = Buffer.from(envelope.transcriptBase64, 'base64').toString('utf8');
  if (fixture.assertPrivateOutput) fixture.assertPrivateOutput(transcript);
  else assert.equal(transcript.includes(phrase), false, 'Recovery phrase leaked into terminal output.');
  if (accepted) assert.match(transcript, /"approved":true/);
  else assert.equal(transcript.includes('"approved":true'), false);
  return transcript;
}

async function fixture(t, network, origin, actualBackend = false) {
  const root = await mkdtemp(join(tmpdir(), 'unified-approval-acceptance-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const home = join(root, 'marketplace'), wallet = join(root, 'atto'), nano = join(root, 'nano'), bin = join(root, 'bin');
  await mkdir(home, {mode: 0o700}); await mkdir(bin, {mode: 0o700});
  // Disposable lookup-only credential-store fixture; it cannot access a real keyring.
  const credentialAccount = createHash('sha256').update(wallet).digest('hex');
  let fixturePhrase = actualBackend ? null : phrase;
  const app = new AttoApplication({directory: wallet, secrets: {get: async () => fixturePhrase, set: async value => {fixturePhrase = value;}, remove: async () => {}}});
  let atto;
  try {await app.createWallet(actualBackend ? undefined : phrase); atto = (await app.call('wallet_status', {})).identity.address;}
  finally {await app.close();}
  assert.match(fixturePhrase, /^[a-z]+(?: [a-z]+){23}$/);
  await writeFile(join(bin, 'secret-tool'), `#!/bin/sh\n[ "$*" = 'lookup service Atto MCP account ${credentialAccount} key_type mnemonic' ] || exit 77\nprintf '%s' '${fixturePhrase}'\n`, {mode: 0o700});
  const assertPrivateOutput = output => assert.equal(output.includes(fixturePhrase), false, 'Recovery phrase leaked into terminal output.');
  const originalAttoState = await readFile(join(wallet, 'state.sqlite'));
  const env = {PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: root, DBUS_SESSION_BUS_ADDRESS: '', XDG_RUNTIME_DIR: '',
    MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR: wallet, MARKETPLACE_MCP_NANO_WALLET_DATA_DIR: nano};
  const audience = actualBackend ? process.env.UNIFIED_APPROVAL_BACKEND_AUDIENCE ?? 'urn:marketplace:agent-api:local' : 'unified-approval-fixture';
  const nanoOptions = {dataDir: nano, recoveryWalletDirectory: wallet, derivationIndex: 1, network: 'nano:dev', rpcUrl: 'http://localhost:17076', origin,
    audience, handoffDirectory: join(root, 'handoffs'), grants: {marketplaceFunding: false, externalTransfers: false,
      controllerPurposes: actualBackend ? ['login'] : []},
    limits: {maxPaymentAtomic: '0', rolling24hAtomic: '0'}, terminalConfirmed: true};
  const provision = `import {provisionNanoWallet} from ${JSON.stringify(adapterUrl)};process.stdout.write(JSON.stringify(await provisionNanoWallet(JSON.parse(process.argv[1]))));`;
  const nanoConfig = JSON.parse(await run(process.execPath, ['--input-type=module', '--eval', provision, JSON.stringify(nanoOptions)], env));
  const savedNano = JSON.parse(await readFile(nanoConfig.configurationPath, 'utf8'));
  assert.equal(savedNano.version, 1); assert.equal(savedNano.keySource.seedFile, undefined);
  assert.equal(savedNano.keySource.recoverySource.directory, wallet);
  assertPrivateOutput(JSON.stringify(savedNano));
  await assert.rejects(readFile(join(nano, 'seed.hex')), {code: 'ENOENT'});
  await saveWalletSelection(home, {attoDirectory: wallet, nanoDirectory: nano, paymentHandoffDirectory: join(root, 'handoffs')});
  const address = network === 'ATTO' ? atto : nanoConfig.address;
  let profile;
  if (actualBackend) {
    const setup = ['setup', '--home', home, '--profile', 'acceptance', '--origin', origin, '--audience', audience,
      '--controller-network', network, '--controller-address', address, '--controller-index', network === 'ATTO' ? '0' : '1', '--mode', 'controller-session'];
    let result = JSON.parse((await run(process.execPath, [main, ...setup], env)).trim());
    if (result.status === 'approval_required') {
      const path = join(home, 'approvals', 'acceptance', `${result.handoffId}.request.json`);
      await terminalApprove({home, env, assertPrivateOutput}, path);
      result = JSON.parse((await run(process.execPath, [main, 'setup', '--home', home, '--profile', 'acceptance', '--complete'], env)).trim());
    }
    assert.equal(result.status, 'ready');
    const store = await MarketplaceProfileStore.open(home);
    try {profile = store.getProfile('acceptance');} finally {store.close();}
  } else {
    profile = {id: 'acceptance', origin, audience, accountId, agentId, identityId, controllerNetwork: network, controllerAddress: address,
      controllerIndex: network === 'ATTO' ? 0 : 1, authMode: 'controller-session', accessToken: 'fixture-access-token', accessExpiresAt: Date.now() + 3600000};
    const store = await MarketplaceProfileStore.open(home);
    try {store.createProfile(profile);} finally {store.close();}
  }
  const connect = async () => {
    const client = new Client({name: 'unified-approval-native-acceptance', version: '1.0.0'});
    await client.connect(new StdioClientTransport({command: process.execPath, args: [main, '--home', home, '--profile', 'acceptance'], env, stderr: 'pipe'}));
    return client;
  };
  const assertStandalonePreserved = async () => {
    assert.deepEqual(await readFile(join(wallet, 'state.sqlite')), originalAttoState, 'Marketplace typed approvals mutated standalone Atto state.');
    assert.deepEqual(JSON.parse(await readFile(nanoConfig.configurationPath, 'utf8')), savedNano, 'Typed approvals widened Nano recurring grants.');
  };
  return {root, home, env, network, address, profile, connect, assertStandalonePreserved, assertPrivateOutput};
}

async function tool(client, name, args) {
  const response = await client.callTool({name, arguments: args}, {timeout: 45000});
  assert.notEqual(response.isError, true, `${name} rejected: ${response.structuredContent?.error?.code ?? 'unknown'}`);
  return response.structuredContent.result;
}

async function approveAndRetry(f, name, args) {
  let client = await f.connect();
  let first;
  try {first = await tool(client, name, args);} finally {await client.close();}
  assert.equal(first.status, 'approval_required');
  const requestPath = join(f.home, 'approvals', 'acceptance', `${first.handoffId}.request.json`);
  assert.equal(first.walletCommand, `${process.platform==='win32'?'& ':''}${shellQuote(process.execPath)} ${shellQuote(main)} approve ${shellQuote(requestPath)}`);
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  assert.equal(request.accountId, f.profile.accountId); assert.equal(request.identityId, f.profile.identityId);
  assert.equal(request.challenge.message.split('\n')[6], `Binding Hash: ${binding(request)}`);
  // Files alone are not authority: profile and durable pending request pin every
  // reviewed field, including action fields that are absent from native framing.
  if (name === 'marketplace_credentials_create' && args.credential.name === 'legacy reader') {
    for (const mutate of [
      value => {value.accountId = randomUUID();}, value => {value.identityId = randomUUID();},
      value => {value.marketplaceOrigin = 'https://other.example';}, value => {value.audience = 'wrong-audience';},
      value => {value.controller.index++;}, value => {value.action.command.credential.name = 'changed grant';},
      value => {value.challenge.message += '\n';},
    ]) {
      const changed = structuredClone(request); mutate(changed);
      await writeFile(requestPath, `${JSON.stringify(changed)}\n`, {mode: 0o600});
      await terminalApprove(f, requestPath, false);
    }
    await writeFile(requestPath, `${JSON.stringify(request)}\n`, {mode: 0o600});
  }
  const transcript = await terminalApprove(f, requestPath);
  const response = JSON.parse(await readFile(requestPath.replace('.request.json', '.response.json'), 'utf8'));
  assert.equal(transcript.includes(response.signature), false, 'Protected proof leaked into terminal output.');
  assert.equal(f.network === 'ATTO' ? await validAttoProof(f.address, response.message, response.signature)
    : offchainVerify(f.address, response.message, response.signature), true);
  // A completed approval recovers without a second signing prompt.
  assert.match(await terminalApprove(f, requestPath), /"recovered":true/);
  client = await f.connect();
  let result;
  try {
    result = await tool(client, name, args);
    assert.equal(JSON.stringify(result).includes(response.signature), false);
  } finally {await client.close();}
  client = await f.connect();
  try {
    const replay = await tool(client, name, args);
    assert.equal(replay.recovered, true);
    if (result.apiKeyId) assert.equal(replay.apiKeyId, result.apiKeyId);
    if (result.destinationId) assert.equal(replay.destinationId, result.destinationId);
    if (result.withdrawalId) assert.equal(replay.withdrawalId, result.withdrawalId);
  } finally {await client.close();}
  return result;
}

for (const network of ['ATTO', 'NANO']) test(`${network}: real terminal approvals cross stdio with Kotlin credential/payout/withdrawal bindings`,
  {skip: process.platform !== 'linux', timeout: 120000}, async t => {
    let f, selection = null, withdrawal, posts = 0, challenges = 0;
    const server = createServer(async (req, res) => {
      try {
        let text = ''; for await (const bytes of req) text += bytes;
        const body = text ? JSON.parse(text) : null, path = new URL(req.url, 'http://localhost').pathname;
        const json = (value, status = 200) => {res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(value));};
        const asset = network === 'ATTO' ? 'ATTO' : 'XNO', route = network === 'ATTO' ? 'atto:local' : 'nano:dev';
        if (path.endsWith('/selection')) return json(selection);
        if (path === '/v1/agent/payout-addresses' && req.method === 'GET') return json(selection ? [{destinationId, asset, network: route, address: f.address, state: 'ACTIVE'}] : []);
        if (path.endsWith('/challenges')) {
          challenges++;
          const kind = path.includes('/credentials/') ? 'credential' : path.includes('/withdrawals/') ? 'withdrawal' : 'payout-address';
          const action = {kind, command: body, network: route, canonicalTargetAddress: f.address, destinationAddress: f.address};
          const purpose = kind === 'credential' ? 'API-key creation' : kind === 'withdrawal' ? 'withdrawal creation' : 'payout address enrollment';
          return json(challenge(network, f.address, purpose, binding({action, accountId, identityId})));
        }
        if (req.method === 'POST') {
          posts++;
          assert.equal(network === 'ATTO' ? await validAttoProof(f.address, body.proof.message, body.proof.signature)
            : offchainVerify(f.address, body.proof.message, body.proof.signature), true);
          if (path === '/v1/agent/credentials') return json({apiKeyId: randomUUID(), result: 'CREATED', replayed: false, apiKey: 'fixture-issued-private-key'}, 201);
          if (path === '/v1/agent/payout-addresses') {selection = {asset, network: route, destinationId, version: 1, usableAfter: new Date(0).toISOString()}; return json({destinationId, network: route, selectionVersion: 1, replayed: false}, 201);}
          if (path === '/v1/agent/withdrawals') {withdrawal = {withdrawalId, requestId: body.command.idempotencyKey, asset, network: route, atomicAmount: body.command.atomicAmount,
            destinationId, destinationVersion: 1, destinationAddress: f.address, state: 'PENDING', nativeSend: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), replayed: false}; return json(withdrawal, 201);}
        }
        if (path === `/v1/agent/withdrawals/${withdrawalId}`) return json(withdrawal);
        return json({}, 404);
      } catch {res.writeHead(500); res.end('{}');}
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {server.closeAllConnections(); return new Promise(resolve => server.close(resolve));});
    f = await fixture(t, network, `http://127.0.0.1:${server.address().port}`);
    for (const credential of [
      {name: 'legacy reader', expiresInDays: 90, scopes: ['tasks:read']},
      {name: 'shop buyer', expiresInDays: 90, scopes: ['products:purchase', 'files:read'], purchaseAttoLimit: '900'},
      {name: 'shop publisher', expiresInDays: 90, scopes: ['products:publish'], productPublishAttoLimit: '20', productPublishXnoLimit: '30'},
    ]) await approveAndRetry(f, 'marketplace_credentials_create', {requestId: randomUUID(), credential});
    const asset = network === 'ATTO' ? 'ATTO' : 'XNO', route = network === 'ATTO' ? 'atto:local' : 'nano:dev';
    await approveAndRetry(f, 'marketplace_payout_address_mutate', {action: 'ENROLL', asset, network: route, address: f.address, requestId: randomUUID()});
    await approveAndRetry(f, 'marketplace_withdrawal_create', {asset, network: route, destinationId, expectedSelectionVersion: 1, atomicAmount: '1', requestId: randomUUID()});
    assert.equal(posts, 5, 'Same-request process restarts must not resubmit completed protected operations.');
    assert.equal(challenges, 5, 'Same-request process restarts must not mint fresh approval challenges.');
    const login = challenge(network, f.address, 'login', hash(['signer-controller-enrollment-v1', accountId, identityId]));
    const raw = network === 'ATTO' ? {index: 0, address: f.address, message: login.message}
      : {origin: f.profile.origin, network: 'nano:dev', address: f.address, index: 1, audience: f.profile.audience, purpose: 'login', message: login.message};
    await assert.rejects(callWallet(f.env, {asset, operation: 'controller.sign', input: raw}),
      error => ['LOCAL_SIGNER', 'PERMISSION_DENIED', 'MCP_READ_ONLY'].includes(error.code), 'One-off typed consent must not grant raw headless signing.');
    await f.assertStandalonePreserved();
  });

// Live compatibility gate intentionally excludes money movement: fresh credentials,
// payout registration and a server-authored withdrawal proof with an unfunded account.
for (const network of ['ATTO', 'NANO']) test(`${network}: actual LOCAL backend accepts typed credential and payout proofs`,
  {skip: !live || process.platform !== 'linux', timeout: 120000}, async t => {
    const origin = process.env.UNIFIED_APPROVAL_BACKEND_ORIGIN;
    assert.ok(origin, 'Choose an explicitly authorized LOCAL backend origin.');
    const url = new URL(origin);
    assert.ok(url.origin === origin && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Only an exact loopback HTTP origin is allowed.');
    const f = await fixture(t, network, origin, true);
    await approveAndRetry(f, 'marketplace_credentials_create', {requestId: randomUUID(), credential: {name: 'fresh acceptance reader', scopes: ['tasks:read'], expiresInDays: 1}});
    const asset = network === 'ATTO' ? 'ATTO' : 'XNO', route = network === 'ATTO' ? 'atto:local' : 'nano:dev';
    const destination = await approveAndRetry(f, 'marketplace_payout_address_mutate', {action: 'ENROLL', asset, network: route, address: f.address, requestId: randomUUID()});
    const args = {asset, network: route, destinationId: destination.destinationId, expectedSelectionVersion: destination.selectionVersion, atomicAmount: '1', requestId: randomUUID()};
    const client = await f.connect();
    try {
      const selection = await tool(client, 'marketplace_payout_selection_get', {asset, network: route});
      const remaining = Date.parse(selection.usableAfter) - Date.now();
      assert.ok(Number.isFinite(remaining) && remaining <= 15000, 'The live gate requires the short LOCAL payout cooldown.');
      if (remaining > 0) await delay(remaining + 50);
      const pending = await tool(client, 'marketplace_withdrawal_create', args);
      assert.equal(pending.status, 'approval_required');
      const path = join(f.home, 'approvals', 'acceptance', `${pending.handoffId}.request.json`);
      const request = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(request.challenge.message.split('\n')[6], `Binding Hash: ${binding(request)}`);
      await terminalApprove(f, path);
      const proof = JSON.parse(await readFile(path.replace('.request.json', '.response.json'), 'utf8'));
      assert.equal(network === 'ATTO' ? await validAttoProof(f.address, proof.message, proof.signature) : offchainVerify(f.address, proof.message, proof.signature), true);
      // Do not submit this valid withdrawal against an unfunded account. The live
      // gate covers backend-authored exact bytes; default tests cover MCP submission.
      assert.match(await terminalApprove(f, path), /"recovered":true/);
      assert.deepEqual(await tool(client, 'marketplace_withdrawals_list', {}), [], 'The fresh live account must have no submitted withdrawals.');
      await f.assertStandalonePreserved();
    } finally {await client.close();}
  });
