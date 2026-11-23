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
      payload=['marketplace-credential-v1',credential.name.trim(),String(credential.expiresInDays??90),scopes.join(','),credential.publishAttoLimit??'',credential.publishXnoLimit??'',credential.purchaseAttoLimit??'',credential.purchaseXnoLimit??'',credential.productPublishAttoLimit??'',credential.productPublishXnoLimit??''].join('\n');
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
  if (accepted && transcript.includes('Review this exact Marketplace controller action:')) {
    // Given the exact typed request and a successful production terminal review.
    const request=JSON.parse(await readFile(requestPath,'utf8'));
    // When the default human approval preview is shown.
    // Then the trusted destination, wallet identity and expiry remain visible without raw request JSON.
    assert.ok(transcript.includes(`Marketplace: ${request.marketplaceOrigin}`));
    assert.ok(transcript.includes(`Audience: ${request.audience}`));
    assert.ok(transcript.includes(`Controller address: ${request.controller.address}`));
    assert.ok(transcript.includes(`Controller index: ${request.controller.index}`));
    assert.ok(transcript.includes(`Controller network: ${request.controller.network}`));
    assert.ok(transcript.includes(`Purpose: ${request.purpose}`));
    assert.ok(transcript.includes(`Expires At: ${request.challenge.expiresAt}`) || transcript.includes(`Expires at: ${request.challenge.expiresAt}`));
    assert.doesNotMatch(transcript,/"marketplaceOrigin"|"challengeId"|"requestDigest"/);
  }
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
  let attoStatus;
  try {await app.createWallet(actualBackend ? undefined : phrase); attoStatus = await app.call('wallet_status', {});}
  finally {await app.close();}
  const atto = attoStatus.identity.address;
  assert.match(fixturePhrase, /^[a-z]+(?: [a-z]+){23}$/);
  await writeFile(join(bin, 'secret-tool'), `#!/bin/sh\n[ "$*" = 'lookup service Atto MCP account ${credentialAccount} key_type mnemonic' ] || exit 77\nprintf '%s' '${fixturePhrase}'\n`, {mode: 0o700});
  const assertPrivateOutput = output => assert.equal(output.includes(fixturePhrase), false, 'Recovery phrase leaked into terminal output.');
  const originalAttoState = await readFile(join(wallet, 'state.sqlite'));
  const env = {PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: root, DBUS_SESSION_BUS_ADDRESS: '', XDG_RUNTIME_DIR: '',
    MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR: wallet, MARKETPLACE_MCP_NANO_WALLET_DATA_DIR: nano};
  const audience = actualBackend ? process.env.UNIFIED_APPROVAL_BACKEND_AUDIENCE ?? 'urn:marketplace:agent-api:local' : origin === 'https://api.atto.market' ? 'urn:marketplace:agent-api:live' : 'unified-approval-fixture';
  const nanoOptions = {dataDir: nano, recoveryWalletDirectory: wallet, derivationIndex: 1, network: origin === 'https://api.atto.market' ? 'nano:mainnet' : 'nano:dev', rpcUrl: 'http://localhost:17076', origin,
    audience,  grants: { externalTransfers: false,
      controllerPurposes: actualBackend ? ['login'] : []},
    limits: {maxPaymentAtomic: '0', rolling24hAtomic: '0'}, terminalConfirmed: true};
  const provision = `import {provisionNanoWallet} from ${JSON.stringify(adapterUrl)};process.stdout.write(JSON.stringify(await provisionNanoWallet(JSON.parse(process.argv[1]))));`;
  const nanoConfig = JSON.parse(await run(process.execPath, ['--input-type=module', '--eval', provision, JSON.stringify(nanoOptions)], env));
  const savedNano = JSON.parse(await readFile(nanoConfig.configurationPath, 'utf8'));
  assert.equal(savedNano.version, 1); assert.equal(savedNano.keySource.seedFile, undefined);
  assert.equal(savedNano.keySource.recoverySource.directory, wallet);
  assertPrivateOutput(JSON.stringify(savedNano));
  await assert.rejects(readFile(join(nano, 'seed.hex')), {code: 'ENOENT'});
  await saveWalletSelection(home, {attoDirectory: wallet, nanoDirectory: nano, ...(actualBackend && {
    attoAccess: {address: atto, index: 0, fingerprint: attoStatus.identity.fingerprint,
      network: `atto:${attoStatus.settings.network.toLowerCase()}`, externalTransfers: false},
  })});
  const address = network === 'ATTO' ? atto : nanoConfig.address;
  let profile;
  if (actualBackend) {
    const setup = ['setup', '--json', '--home', home, '--profile', 'acceptance', '--origin', origin, '--audience', audience,
      '--controller-network', network, '--controller-address', address, '--controller-index', network === 'ATTO' ? '0' : '1', '--mode', 'controller-session'];
    let result = JSON.parse((await run(process.execPath, [main, ...setup], env)).trim());
    if (result.status === 'approval_required') {
      const path = join(home, 'approvals', 'acceptance', `${result.handoffId}.request.json`);
      await terminalApprove({home, env, assertPrivateOutput}, path);
      result = JSON.parse((await run(process.execPath, [main, 'setup', '--home', home, '--profile', 'acceptance', '--complete', '--json'], env)).trim());
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
  if(request.action.kind==='credential' && request.action.command.credential){
    // Given a real credential grant prepared through stdio and the native typed approval boundary.
    const grant=request.action.command.credential;
    // When the default terminal review is accepted.
    // Then its complete scopes and exact monetary ceilings are visible beside their meanings.
    assert.ok(transcript.includes(`Name: ${grant.name}`));
    assert.ok(transcript.includes(`Expires In Days: ${grant.expiresInDays}`));
    assert.match(transcript,/Scopes:/);
    for(const scope of grant.scopes)assert.ok(transcript.includes(`- ${scope}`),`Missing reviewed scope ${scope}`);
    for(const [field,label] of [['purchaseAttoLimit','Purchase Atto Limit'],['productPublishAttoLimit','Product Publish Atto Limit'],['productPublishXnoLimit','Product Publish Xno Limit']]){
      if(grant[field]!==undefined)assert.ok(transcript.includes(`${label}: ${grant[field]}`),`Missing reviewed exact ceiling ${field}`);
    }
  }
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

for (const network of ['ATTO', 'NANO']) test(`${network}: real terminal approvals cross stdio with current Kotlin credential bindings`,
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
    assert.equal(posts, 3, 'Same-request process restarts must not resubmit completed protected operations.');
    assert.equal(challenges, 3, 'Same-request process restarts must not mint fresh approval challenges.');
    const login = challenge(network, f.address, 'login', hash(['marketplace-login-v1', accountId, identityId]));
    const raw = network === 'ATTO' ? {index: 0, address: f.address, message: login.message}
      : {origin: f.profile.origin, network: 'nano:dev', address: f.address, index: 1, audience: f.profile.audience, purpose: 'login', message: login.message};
    await assert.rejects(callWallet(f.env, {asset, operation: 'controller.sign', input: raw}),
      error => ['LOCAL_SIGNER', 'PERMISSION_DENIED', 'MCP_READ_ONLY'].includes(error.code), 'One-off typed consent must not grant raw headless signing.');
    await f.assertStandalonePreserved();
  });

for (const network of ['ATTO','NANO']) test(`${network}: terminal browser sign-in enrollment, revocation and retry`,
  {skip: process.platform !== 'linux', timeout: 60_000}, async t => {
    const f = await fixture(t, network, 'https://api.atto.market');
    const helper = fileURLToPath(new URL('./support/browser-grant-terminal.mjs', import.meta.url));
    const terminal = fileURLToPath(new URL('./support/run-terminal.py', import.meta.url));
    const args = {command:[process.execPath, helper, packageDirectory, f.home], prompt:'Type APPROVE to confirm: ',
      response:'APPROVE', timeoutSeconds:30};
    const result = JSON.parse(await run('python3', [terminal, JSON.stringify(args)], f.env));
    const output = Buffer.from(result.transcriptBase64,'base64').toString();
    f.assertPrivateOutput(output);
    assert.equal(result.exitCode, 0, 'Browser sign-in terminal fixture failed.');
    assert.match(output, /"browserSignIn":"enabled"/);
    assert.match(output, /"browserSignIn":"disabled"/);
    assert.ok(output.includes(accountId) && output.includes(f.address) && output.includes('Browser origin: https://atto.market'));
    assert.doesNotMatch(output, /Binding Hash:|Nonce:|fixture-access-token/);
    await f.assertStandalonePreserved();
  });

for (const network of ['ATTO', 'NANO']) test(`${network}: two local wallets link through stdio and the real Marketplace API`,
  {skip: !live || process.platform !== 'linux', timeout: 120_000}, async t => {
    const origin = process.env.UNIFIED_APPROVAL_BACKEND_ORIGIN ?? 'http://localhost:8080';
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname));
    const f = await fixture(t, network, origin, true);
    const client = await f.connect();
    t.after(() => client.close());
    const listIdentities = async () => {
      const response = await fetch(new URL('/v1/account/identities', origin), {
        headers: {authorization: `Bearer ${f.profile.accessToken}`},
      });
      assert.equal(response.status, 200);
      return response.json();
    };

    // Given an account with one controller and a separate, unfunded local wallet.
    assert.equal((await listIdentities()).length, 1);
    const requestId = randomUUID();
    const started = await tool(client, 'marketplace_identity_link_start', {
      requestId, asset: network === 'ATTO' ? 'XNO' : 'ATTO',
    });
    assert.equal(started.status, 'approval_required');
    assert.equal(started.approvals.length, 2);

    // When each wallet reviews and signs its own server-issued challenge.
    for (const approval of started.approvals) {
      assert.equal((await listIdentities()).length, 1);
      const path = join(f.home, 'approvals', 'acceptance', `${approval.handoffId}.request.json`);
      await terminalApprove(f, path);
    }
    const completed = await tool(client, 'marketplace_identity_link_complete', {requestId});

    // Then Marketplace lists exactly the two reviewed controllers, including after a retry.
    assert.equal(completed.status, 'completed');
    assert.equal(completed.linkId, started.linkId);
    const replay = await tool(client, 'marketplace_identity_link_complete', {requestId});
    assert.equal(replay.identity.identityId, completed.identity.identityId);
    const linked = await listIdentities();
    assert.deepEqual(linked.map(identity => identity.address).sort(), started.approvals.map(item => item.address).sort());
    assert.equal(linked.find(identity => identity.identityId === completed.identity.identityId)?.network, network === 'ATTO' ? 'NANO' : 'ATTO');
    await f.assertStandalonePreserved();
  });
