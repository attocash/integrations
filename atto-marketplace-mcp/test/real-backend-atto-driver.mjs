// Cross-process fixture used only by MarketplaceMcpBackendIntegrationTest.
import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { assertSafeMcpResult } from './support/safe-mcp-result.mjs';
import { MarketplaceProfileStore } from '../dist/profile-store.js';
import { readWalletSelection, saveWalletSelection } from '../dist/wallet-preferences.js';

const [stage, baseDirectory, marketplaceOrigin, nodeOrigin, fundingHash = ''] = process.argv.slice(2);
const marketplaceMain = resolve(import.meta.dirname, '../dist/main.js');
const attoMain = process.env.MKT081_ATTO_MCP_MAIN;
const attoCli = process.env.MKT081_ATTO_CLI_MAIN;
const audience = 'urn:marketplace:agent-api:test';
const profileId = 'agent';
const cliHome = join(baseDirectory, 'wallet');
const marketplaceHome = join(baseDirectory, 'marketplace-profile');
const workerMarketplaceHome = join(baseDirectory, 'worker-marketplace-profile');
const workerSessionFile = join(baseDirectory, 'worker-session.json');
const workerStatePath = join(baseDirectory, 'local-worker.json');
const testKeyringDirectory = join(baseDirectory, 'test-keyring');
const testKeyringAccount = createHash('sha256').update(resolve(cliHome)).digest('hex');
const taskGrossAtomic = '1000000001';

function childEnvironment() {
  return {
    PATH: `${testKeyringDirectory}:${process.env.PATH ?? ''}`,
    HOME: process.env.HOME ?? baseDirectory,
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    USER: process.env.USER ?? '',
    LOGNAME: process.env.LOGNAME ?? '',
    NO_UPDATE_NOTIFIER: '1',
    KOTLIN_LOGGING_STARTUP_MESSAGE: 'false',
    DBUS_SESSION_BUS_ADDRESS: '',
    XDG_RUNTIME_DIR: '',
    MKT081_TEST_KEYRING_ACCOUNT: testKeyringAccount,
    MARKETPLACE_MCP_HOME: marketplaceHome,
    MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR: cliHome,
    MARKETPLACE_MCP_WALLET_HOST_COMMAND: join(testKeyringDirectory, 'marketplace-wallet-host'),
  };
}

async function prepareDisposableKeyring() {
  await mkdir(testKeyringDirectory, { recursive: true, mode: 0o700 });
  await chmod(testKeyringDirectory, 0o700);
  const secretTool = join(testKeyringDirectory, 'secret-tool');
  const source = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const operation = process.argv[2];
const attributes = process.argv.slice(3);
const account = process.env.MKT081_TEST_KEYRING_ACCOUNT;
const expected = ['service', 'Atto MCP', 'account', account, 'key_type', 'mnemonic'];
const credential = path.join(__dirname, 'credential');
function fail() { process.exitCode = 2; }
function attrsMatch(args) { return account && /^[a-f0-9]{64}$/.test(account)
  && args.length === expected.length && args.every((value, index) => value === expected[index]); }
function existingPrivateFile() {
  try {
    const info = fs.lstatSync(credential);
    return info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o600;
  } catch { return false; }
}
if (operation === 'store') {
  if (attributes[0] !== '--label=Atto MCP' || !attrsMatch(attributes.slice(1))) fail();
  else {
    let secret = '';
    let invalid = false;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      secret += chunk;
      if (secret.length > 512 || /[\\r\\n\\0]/.test(secret)) invalid = true;
    });
    process.stdin.on('end', () => {
      if (invalid || !secret) return fail();
      const temporary = path.join(__dirname, '.credential-' + process.pid + '.tmp');
      let descriptor;
      try {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, secret, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, credential);
        fs.chmodSync(credential, 0o600);
      } catch {
        if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
        try { fs.unlinkSync(temporary); } catch {}
        fail();
      }
    });
  }
} else if (operation === 'lookup' && attrsMatch(attributes)) {
  if (!existingPrivateFile()) process.exitCode = 1;
  else process.stdout.write(fs.readFileSync(credential, 'utf8'));
} else if (operation === 'clear' && attrsMatch(attributes)) {
  try { fs.unlinkSync(credential); } catch (error) { if (error.code !== 'ENOENT') fail(); }
} else fail();
`;
  await writeFile(secretTool, source, { mode: 0o700 });
  await chmod(secretTool, 0o700);
  const walletWrapper = join(testKeyringDirectory, 'marketplace-wallet-host');
  const walletWrapperSource = `#!/usr/bin/env node
const { spawn } = require('node:child_process');
process.env.MKT081_TEST_KEYRING_ACCOUNT = ${JSON.stringify(testKeyringAccount)};
const child = spawn(process.execPath, [${JSON.stringify(marketplaceMain)}, '--internal-wallet-host'], { stdio: 'inherit', env: process.env });
child.once('error', () => { process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });
`;
  await writeFile(walletWrapper, walletWrapperSource, { mode: 0o700 });
  await chmod(walletWrapper, 0o700);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function safeObject(value, label) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} result was not an object.`);
  return value;
}

function resultOf(response, toolName) {
  if (response?.isError) {
    const code = response.structuredContent?.error?.code;
    const details = response.structuredContent?.error?.details;
    const httpStatus = details && typeof details === 'object' ? details.httpStatus : undefined;
    const status = Number.isInteger(httpStatus) ? ` HTTP ${httpStatus}` : '';
    throw new Error(`${toolName} failed${typeof code === 'string' ? ` (${code})` : ''}${status}.`);
  }
  return response?.structuredContent?.result;
}

function parseJsonOutput(output, label) {
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try { return JSON.parse(lines[index]); } catch { /* Ignore CLI progress lines. */ }
  }
  throw new Error(`${label} did not return machine-readable JSON.`);
}

function safeProcessFailureCode(stderrChunks) {
  const text = Buffer.concat(stderrChunks).toString('utf8');
  if (text.includes('not locally approved for message signing')) return 'MESSAGE_SIGNING_NOT_APPROVED';
  if (text.includes('could not sign the exact Marketplace controller challenge')) return 'CONTROLLER_SIGNING_FAILED';
  return undefined;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { env: childEnvironment(), cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let byteCount = 0;
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on('data', chunk => {
        byteCount += chunk.length;
        if (byteCount > 1_048_576) {
          child.kill('SIGKILL');
          rejectPromise(new Error('A bounded test process emitted too much output.'));
          return;
        }
        chunks.push(chunk);
      });
    }
    child.once('error', () => rejectPromise(new Error(`Could not start the ${options.label ?? 'test'} process.`)));
    child.once('close', code => {
      const output = Buffer.concat(stdout).toString('utf8');
      if (code !== 0) {
        const hint = safeProcessFailureCode(stderr);
        rejectPromise(new Error(`${options.label ?? 'Test'} process exited with code ${code}${hint ? ` (${hint})` : ''}.`));
      }
      else resolvePromise(output);
    });
  });
}

async function runCli(args, label) {
  check(typeof attoCli === 'string' && attoCli.length > 0, 'MKT081_ATTO_CLI_MAIN must name the isolated Atto CLI entrypoint.');
  return runProcess(process.execPath, [attoCli, '--json', '--data-dir', cliHome, ...args], { label });
}

async function runTerminal(args, options) {
  check(typeof attoCli === 'string' && attoCli.length > 0, 'MKT081_ATTO_CLI_MAIN must name the isolated Atto CLI entrypoint.');
  return runTerminalCommand([process.execPath, attoCli, '--json', '--data-dir', cliHome, ...args], options);
}

async function runTerminalCommand(command, { prompt, response, label }) {
  const helper = resolve(import.meta.dirname, 'support/run-terminal.py');
  const request = JSON.stringify({
    command,
    ...(prompt ? { prompt, response } : {}),
    timeoutSeconds: 120,
  });
  const helperOutput = await runProcess('python3', [helper, request], { label: `${label} terminal helper` });
  const envelope = safeObject(parseJsonOutput(helperOutput, `${label} terminal helper`), `${label} terminal helper`);
  check(envelope.timedOut !== true && envelope.exitCode === 0, `${label} did not finish successfully in the local terminal.`);
  if (prompt) check(envelope.promptAnswered === true, `${label} did not receive its expected local confirmation.`);
  return Buffer.from(String(envelope.transcriptBase64 ?? ''), 'base64').toString('utf8');
}

async function runWalletWorker(port = 0) {
  check(typeof attoCli === 'string' && attoCli.length > 0, 'MKT081_ATTO_CLI_MAIN must name the isolated Atto CLI entrypoint.');
  const fixture = resolve(resolve(attoCli, '../../..'), 'test/marketplace-local-work-fixture.mjs');
  const { startLocalAttoWorkServer } = await import(pathToFileURL(fixture).href);
  return startLocalAttoWorkServer(port);
}

async function openMcp(main, args, label) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [main, ...args], env: childEnvironment(), stderr: 'pipe' });
  transport.stderr.on('data', () => { /* Keep process diagnostics out of output, which can contain local paths. */ });
  const client = new Client({ name: `mkt081-${label}`, version: '1.0.0' });
  await client.connect(transport);
  return { client, async close() { await client.close(); } };
}

async function makeWallet() {
  await runTerminal(['wallet', 'create'], { label: 'wallet creation' });
  const worker = await runWalletWorker();
  try {
    const initial = await openMcp(attoMain, ['--data-dir', cliHome], 'atto-bootstrap');
    let address;
    let walletToolCount=0;
    try {
      const walletTools=(await initial.client.listTools()).tools.map(tool=>tool.name);
      walletToolCount=walletTools.length;
      check(walletTools.includes('marketplace_topup') && walletTools.includes('marketplace_topup_status')
        && !walletTools.some(name=>name.startsWith('marketplace_task_')),
        'The wallet MCP funding capability is missing or unexpectedly exposes Marketplace task tools.');
      const listed = safeObject(resultOf(await initial.client.callTool({ name: 'address_list', arguments: {} }), 'address_list'), 'address list');
      const addresses = listed.addresses;
      check(Array.isArray(addresses) && addresses.length > 0, 'The wallet MCP did not expose a saved controller address.');
      address = safeObject(addresses.find(value => value.index === 0), 'controller address').address;
    } finally { await initial.close(); }
    check(typeof address === 'string' && address.startsWith('atto://'), 'The wallet MCP returned an invalid controller address.');

    await runCli(['wallet', 'configure', '--network', 'LOCAL', '--node-url', nodeOrigin,
      '--worker-url', worker.origin, '--representative', address, '--no-auto-receive'], 'LOCAL wallet configuration');
    await runCli(['call', 'address_derive', '--input', JSON.stringify({index: 1})], 'native recipient derivation');
    const proposed = parseJsonOutput(await runCli(['call', 'limits_propose', '--input', JSON.stringify({
      policy: { perRequest: { amount: '3', unit: 'ATTO' }, rolling: [{ days: 1, amount: '3', unit: 'ATTO' }] },
      access: 'spend', pool: { indexes: [0, 1], consolidate: false }, messageSigningIndexes: [0],
    })], 'bounded wallet grant'), 'bounded wallet grant');
    const proposalId = proposed?.result?.proposal?.id;
    check(typeof proposalId === 'string', 'The terminal could not create the bounded wallet MCP grant.');
    await runTerminal(['limits', 'approve', proposalId], {
      prompt: 'Type yes to approve this exact proposal:', response: 'yes', label: 'wallet MCP spending approval',
    });
    // The fixture explicitly selects its account and Marketplace purposes after CLI consent.
    // Standalone wallet authority alone does not authorize Marketplace-native operations.
    const status = parseJsonOutput(await runCli(['call', 'wallet_status'], 'wallet selection status'), 'wallet selection status').result;
    check(status?.identity?.fingerprint && status.addresses.some(value => value.index === 0 && value.address === address),
      'The native fixture could not bind its Marketplace selection to the configured CLI wallet.');
    await mkdir(marketplaceHome, {recursive: true, mode: 0o700});
    await saveWalletSelection(marketplaceHome, {attoDirectory: cliHome, attoAccess: {address, index: 0,
      network: 'atto:local', fingerprint: status.identity.fingerprint, marketplaceFunding: true, externalTransfers: false}});
    const connected = parseJsonOutput(await runTerminal(['marketplace', 'connect', '--api-url', `${marketplaceOrigin}/v1/agent/topups`,
      '--audience', audience, '--controller-index', '0'], { label: 'wallet Marketplace connection' }), 'wallet Marketplace connection');
    const connectedAccountId = connected?.result?.accountId;
    check(typeof connectedAccountId === 'string', 'The local wallet did not connect to the exact test Marketplace origin.');
    const workerAddress = worker.server.address();
    check(workerAddress && typeof workerAddress === 'object', 'The LOCAL work fixture lost its listening address.');
    await writeFile(workerStatePath, JSON.stringify({ port: workerAddress.port }), { mode: 0o600, flag: 'wx' });

    const setupText = await runProcess(process.execPath, [marketplaceMain, 'setup', '--profile', profileId, '--home', marketplaceHome,
      '--origin', marketplaceOrigin, '--audience', audience, '--controller-network', 'ATTO', '--controller-address', address,
      '--controller-index', '0', '--mode', 'controller-session'], { label: 'Marketplace controller setup' });
    const setup = safeObject(parseJsonOutput(setupText, 'Marketplace controller setup'), 'Marketplace controller setup');
    check(setup.status === 'approval_required' && setup.profileId === profileId && /^[a-f0-9]{32}$/.test(setup.handoffId),
      'Marketplace setup did not prepare the current typed login approval.');
    const requestPath = join(marketplaceHome, 'approvals', profileId, `${setup.handoffId}.request.json`);
    const request = JSON.parse(await readFile(requestPath, 'utf8'));
    assert.deepEqual(request.controller, {network:'ATTO',address,index:0});
    assert.deepEqual(request.action, {kind:'login',network:'ATTO',address});
    assert.equal(request.purpose, 'login');
    assert.equal(request.marketplaceOrigin, marketplaceOrigin);
    assert.equal(request.accountId, connectedAccountId);
    assert.equal(request.audience, audience);
    const approved = parseJsonOutput(await runTerminalCommand([process.execPath, marketplaceMain, 'approve', requestPath,
      '--home', marketplaceHome], {prompt:'Type APPROVE to confirm: ',response:'APPROVE',label:'Marketplace typed login approval'}),
      'Marketplace typed login approval');
    assert.equal(approved.responsePath, requestPath.replace('.request.json', '.response.json'));
    assert.equal(approved.recovered, false);
    const ready = safeObject(parseJsonOutput(await runProcess(process.execPath, [marketplaceMain, 'setup', '--profile', profileId,
      '--home', marketplaceHome, '--complete'], { label: 'Marketplace controller setup completion' }), 'Marketplace controller setup completion'), 'Marketplace setup completion');
    check(ready.status === 'ready' && ready.authMode === 'controller-session' && ready.accountId === connectedAccountId
      && ready.origin === marketplaceOrigin && ready.controllerNetwork === 'ATTO'
      && ready.controllerAddress === address && ready.controllerIndex === 0,
      'The Marketplace MCP controller session did not persist the wallet account and selected origin.');

    const marketplace = await openMcp(marketplaceMain, ['--profile', profileId, '--home', marketplaceHome], 'marketplace');
    try {
      const tools = (await marketplace.client.listTools()).tools.map(tool => tool.name);
      check(tools.includes('marketplace_fund') && tools.includes('marketplace_task_draft_create')
        && tools.includes('marketplace_task_publish'), 'The real Marketplace MCP stdio catalogue is incomplete.');
      const updated = resultOf(await marketplace.client.callTool({ name: 'marketplace_profile_update', arguments: {
        requestId: randomUUID(), patch: { handle: `mkt081-${randomUUID().slice(0, 8)}`, displayName: 'Marketplace MCP test agent' },
      } }), 'marketplace_profile_update');
      assertSafeMcpResult(updated, 'Marketplace profile update');
      const handle = updated.handle ?? updated.profile?.handle;
      const publishedProfile = resultOf(await marketplace.client.callTool({ name: 'marketplace_profile_publish', arguments: {
        requestId: randomUUID(),
      } }), 'marketplace_profile_publish');
      check(typeof handle === 'string' && (publishedProfile.status === 'PUBLISHED'
        || publishedProfile.profile?.status === 'PUBLISHED'), 'The real Marketplace MCP did not publish the test agent profile.');
      const profile = resultOf(await marketplace.client.callTool({ name: 'marketplace_profile_get', arguments: {} }), 'marketplace_profile_get');
      assertSafeMcpResult(profile, 'Marketplace profile');
      const publicAgent = resultOf(await marketplace.client.callTool({ name: 'marketplace_agent_get', arguments: { handle } }), 'marketplace_agent_get');
      check(publicAgent.handle === handle || publicAgent.profile?.handle === handle, 'The public Marketplace MCP lookup did not return the published agent.');
      const unpublished = safeObject(resultOf(await marketplace.client.callTool({ name: 'marketplace_profile_unpublish', arguments: {
        requestId: randomUUID(),
      } }), 'marketplace_profile_unpublish'), 'unpublished profile');
      check(unpublished.status === 'DRAFT', 'The Marketplace MCP did not unpublish the test profile using the supported controller route.');
      return { address, accountId: ready.accountId, profileId, profileUpdated: true, profilePublished: true,
        profileUnpublished: true,
        testCredentialStore: 'disposable-secret-tool',
        marketplaceStdioTools: tools.length, walletStdioTools: walletToolCount, controllerTransport: 'AGENT_API' };
    } finally { await marketplace.close(); }
  } finally {
    await new Promise(resolvePromise => worker.server.close(resolvePromise));
  }
}


async function nativeWalletJourney(marketplace) {
  const tool = async (name, args) => safeObject(resultOf(await marketplace.client.callTool({name, arguments: args}), name), name);
  const native = async (name, args = {}) => tool(name, {asset: 'ATTO', ...args});
  const selection = readWalletSelection(marketplaceHome);
  const access = selection.attoAccess;
  const status = parseJsonOutput(await runCli(['call', 'wallet_status'], 'native wallet status'), 'native wallet status').result;
  const recipient = status.addresses.find(value => value.index === 1);
  check(recipient && recipient.address !== access.address, 'The derived native recipient must be a distinct account.');
  assert.deepEqual(await native('wallet_status'), {asset: 'ATTO', network: 'atto:local', address: access.address, index: 0,
    permissions: {marketplaceFunding: true, externalTransfers: false, receive: true}});
  const initialIncoming = await native('wallet_receivables', {network: 'atto:local', limit: 10});
  assert.equal(initialIncoming.address, access.address);
  assert.ok(initialIncoming.items.some(value => value.hash === fundingHash.toUpperCase() && value.amountAtomic === '2000000000'));
  const initialReceive = await native('wallet_receive', {network: 'atto:local', hash: fundingHash});
  assert.equal(initialReceive.state, 'SETTLED'); assert.equal(initialReceive.sendHash, fundingHash.toUpperCase());
  assert.equal(initialReceive.amountAtomic, '2000000000');
  assert.deepEqual(await native('wallet_receive', {network: 'atto:local', hash: fundingHash}), initialReceive);
  const balance = await native('wallet_balance', {network: 'atto:local'});
  assert.deepEqual(balance, {asset: 'ATTO', network: 'atto:local', address: access.address, index: 0, balanceAtomic: '2000000000'});

  // A missing Marketplace external-transfer grant leaves neither a candidate nor a native account change.
  const outbound = {asset: 'ATTO', network: 'atto:local', destination: recipient.address, amountAtomic: '1', requestId: randomUUID()};
  const beforeJournal = parseJsonOutput(await runCli(['call', 'journal_list'], 'journal before denial'), 'journal before denial').result;
  const beforeAccount = parseJsonOutput(await runCli(['call', 'account_get', '--input', JSON.stringify({index: 0})], 'account before denial'), 'account before denial').result;
  const denied = await marketplace.client.callTool({name: 'wallet_transfer', arguments: outbound});
  assert.equal(denied.isError, true); assert.equal(denied.structuredContent.error.code, 'PERMISSION_DENIED');
  assert.deepEqual(parseJsonOutput(await runCli(['call', 'journal_list'], 'journal after denial'), 'journal after denial').result, beforeJournal);
  assert.deepEqual(parseJsonOutput(await runCli(['call', 'account_get', '--input', JSON.stringify({index: 0})], 'account after denial'), 'account after denial').result, beforeAccount);
  assert.deepEqual(await native('wallet_balance', {network: 'atto:local'}), balance);

  const approveTransfers = () => runTerminalCommand([process.execPath, marketplaceMain, 'wallet', 'policy', '--asset', 'ATTO',
    '--home', marketplaceHome, '--allow-marketplace-funding', '--allow-external-transfers'],
  {prompt: 'Type APPROVE to save this Marketplace wallet access: ', response: 'APPROVE', label: 'native external transfer policy'});
  await approveTransfers();
  const sent = await tool('wallet_transfer', outbound);
  assert.deepEqual(sent, {asset: 'ATTO', network: 'atto:local', index: 0, sourceAddress: access.address,
    destination: recipient.address, amountAtomic: '1', requestId: outbound.requestId, state: 'SETTLED', hash: sent.hash});
  assert.match(sent.hash, /^[A-F0-9]{64}$/);
  assert.deepEqual(await native('wallet_transfer_status', {requestId: outbound.requestId}), sent);
  assert.deepEqual(await tool('wallet_transfer', outbound), sent);

  // Both accounts retain the original wallet, seed, limits and durable journal.
  await saveWalletSelection(marketplaceHome, {attoDirectory: cliHome, attoAccess: {...access, address: recipient.address, index: 1}});
  assert.deepEqual(await native('wallet_status'), {asset: 'ATTO', network: 'atto:local', address: recipient.address, index: 1,
    permissions: {marketplaceFunding: true, externalTransfers: false, receive: true}});
  const incoming = await native('wallet_receivables', {network: 'atto:local', limit: 10});
  assert.equal(incoming.address, recipient.address);
  assert.ok(incoming.items.some(value => value.hash === sent.hash && value.sourceAddress === access.address && value.amountAtomic === '1'));
  const opened = await native('wallet_receive', {network: 'atto:local', hash: sent.hash});
  assert.equal(opened.state, 'SETTLED'); assert.equal(opened.sendHash, sent.hash); assert.equal(opened.amountAtomic, '1');
  assert.equal(opened.address, recipient.address); assert.equal(opened.index, 1);
  assert.deepEqual(await native('wallet_receive', {network: 'atto:local', hash: sent.hash}), opened);
  assert.equal((await native('wallet_balance', {network: 'atto:local'})).balanceAtomic, '1');
  await approveTransfers();
  const returned = {asset: 'ATTO', network: 'atto:local', destination: access.address, amountAtomic: '1', requestId: randomUUID()};
  const returnedSend = await tool('wallet_transfer', returned);
  assert.equal(returnedSend.state, 'SETTLED'); assert.equal(returnedSend.sourceAddress, recipient.address);
  assert.deepEqual(await native('wallet_transfer_status', {requestId: returned.requestId}), returnedSend);
  assert.deepEqual(await tool('wallet_transfer', returned), returnedSend);
  await saveWalletSelection(marketplaceHome, selection);
  const receivedBack = await native('wallet_receive', {network: 'atto:local', hash: returnedSend.hash});
  assert.equal(receivedBack.state, 'SETTLED'); assert.equal(receivedBack.sendHash, returnedSend.hash); assert.equal(receivedBack.amountAtomic, '1');
  assert.deepEqual(await native('wallet_receive', {network: 'atto:local', hash: returnedSend.hash}), receivedBack);
  assert.deepEqual(await native('wallet_balance', {network: 'atto:local'}), balance);
  assert.equal((await native('wallet_receivables', {network: 'atto:local', limit: 10})).items.length, 0);
  return {marketplaceMcpNativeStatus: true, marketplaceMcpNativeBalance: true, marketplaceMcpExternalTransferDenied: true,
    marketplaceMcpExternalTransfer: true, marketplaceMcpTransferReplay: true, marketplaceMcpReceivables: true,
    marketplaceMcpReceiveOpen: true, marketplaceMcpReceiveReplay: true};
}

async function fundAndPublish() {
  check(/^[a-f0-9]{64}$/i.test(fundingHash), 'The fixture SEND hash is invalid.');
  const savedWorker = safeObject(JSON.parse(await readFile(workerStatePath, 'utf8')), 'LOCAL work fixture state');
  check(Number.isInteger(savedWorker.port) && savedWorker.port > 0 && savedWorker.port < 65536, 'The saved LOCAL work fixture port is invalid.');
  const worker = await runWalletWorker(savedWorker.port);
  let atto;
  let marketplace;
  let workerMarketplace;
  try {
    atto = await openMcp(attoMain, ['--data-dir', cliHome], 'atto-payment');
    marketplace = await openMcp(marketplaceMain, ['--profile', profileId, '--home', marketplaceHome], 'marketplace-payment');
    const walletStatus = safeObject(resultOf(await atto.client.callTool({ name: 'wallet_status', arguments: {} }), 'wallet_status'), 'wallet status');
    check(walletStatus.mcpAccess === 'spend' && walletStatus.settings?.network === 'LOCAL', 'The actual wallet MCP is not configured for bounded LOCAL spending.');
    const nativeJourney = await nativeWalletJourney(marketplace);
    const received = resultOf(await atto.client.callTool({ name: 'receive', arguments: { index: 0, hash: fundingHash } }), 'receive');
    assertSafeMcpResult(received, 'Wallet receive', ['transaction.signature']);

    const requestId = randomUUID();
    const paid = safeObject(resultOf(await marketplace.client.callTool({ name: 'marketplace_fund', arguments: {
      asset:'ATTO',requestId,amountAtomic:'2000000000',network:'atto:local',
    } }), 'marketplace_fund'), 'ATTO funding');
    assertSafeMcpResult(paid, 'Marketplace funding');
    check(paid.requestId===requestId && paid.network==='atto:local' && paid.amountAtomic==='2000000000'
      && paid.statusTool==='marketplace_funding_status', 'Funding did not bind the exact amount, network, and request ID.');
    const funding = safeObject(resultOf(await marketplace.client.callTool({ name: 'marketplace_funding_status', arguments: {
      requestId,
    } }), 'marketplace_funding_status'), 'Marketplace funding status');
    check(funding.requestId === requestId && ['ACCEPTED','SETTLED'].includes(funding.status?.state),
      'The real Marketplace API did not confirm the account-private ATTO top-up.');
    assertSafeMcpResult(funding, 'Marketplace top-up status');

    const draftRequestId = randomUUID();
    const draft = {
        title: 'LOCAL MCP funded integration task',
        description: 'Disposable end-to-end fixture task funded by a confirmed native LOCAL wallet top-up.',
        deliverable: 'A short integration-test result.',
        acceptanceTerms: 'A valid test submission is accepted.',
        asset: 'ATTO', grossAtomic: taskGrossAtomic,
      };
    const created = safeObject(resultOf(await marketplace.client.callTool({ name: 'marketplace_task_draft_create', arguments: {
      requestId: draftRequestId, draft,
    } }), 'marketplace_task_draft_create'), 'task draft');
    const taskId = created.taskId ?? created.id;
    const version = created.version;
    check(typeof taskId === 'string' && Number.isInteger(version), 'The real Marketplace MCP did not create a funded-task draft.');
    const replay = safeObject(resultOf(await marketplace.client.callTool({ name:'marketplace_task_draft_create', arguments:{
      requestId:draftRequestId, draft,
    } }), 'marketplace_task_draft_create replay'), 'draft replay');
    const replayIdentity = safeObject(JSON.parse(String(replay.resultIdentity)), 'draft replay identity');
    check(replay.recovered === true && replayIdentity.taskId === taskId,
      'Replaying the exact draft request did not recover the original task identity.');
    const published = safeObject(resultOf(await marketplace.client.callTool({ name: 'marketplace_task_publish', arguments: {
      taskId, requestId: randomUUID(), expectedVersion: version,
    } }), 'marketplace_task_publish'), 'published task');
    check(published.taskId === taskId || published.id === taskId, 'The real Marketplace MCP published a different task.');
    const publicTask = safeObject(resultOf(await marketplace.client.callTool({ name: 'marketplace_task_get', arguments: { taskId } }), 'marketplace_task_get'), 'public task');
    check((publicTask.task?.id ?? publicTask.id ?? publicTask.taskId) === taskId, 'The public Marketplace MCP lookup did not return the published task.');
    assertSafeMcpResult(created, 'Task draft');
    assertSafeMcpResult(published, 'Published task');
    assertSafeMcpResult(publicTask, 'Public task');
    workerMarketplace = await openMcp(marketplaceMain, ['--profile', 'worker', '--home', workerMarketplaceHome], 'marketplace-worker');
    const found = safeObject(resultOf(await workerMarketplace.client.callTool({name:'marketplace_tasks_search',arguments:{
      asset:'ATTO',q:'LOCAL MCP funded integration task',limit:10,
    }}),'marketplace_tasks_search'),'public task search');
    check(Array.isArray(found.items) && found.items.some(item => item.taskId === taskId),
      'The worker Marketplace MCP did not discover the published funded task.');
    const workerPublicTask = safeObject(resultOf(await workerMarketplace.client.callTool({name:'marketplace_task_get',arguments:{taskId}}),
      'marketplace_task_get'),'worker public task');
    check(workerPublicTask.taskId === taskId, 'The worker Marketplace MCP did not read the published task.');
    const buyerPrivateTask = safeObject(resultOf(await marketplace.client.callTool({name:'marketplace_tasks_private_get',arguments:{taskId}}),
      'marketplace_tasks_private_get'),'buyer private task');
    check(buyerPrivateTask.version === published.version, 'The buyer private task version differs from publication.');
    const application = safeObject(resultOf(await workerMarketplace.client.callTool({name:'marketplace_application_create',arguments:{
      taskId,requestId:randomUUID(),expectedTaskVersion:buyerPrivateTask.version,
      proposal:'I will deliver the tested workflow.',asset:'ATTO',
    }}),'marketplace_application_create'),'worker application');
    check(typeof application.applicationId === 'string' && application.asset === 'ATTO'
      && /^[1-9][0-9]*$/.test(String(application.amountAtomic)),
      'The worker MCP did not create the direct ATTO application with its committed reservation.');
    const buyerApplications = resultOf(await marketplace.client.callTool({name:'marketplace_task_applications_list',arguments:{taskId}}),
      'marketplace_task_applications_list');
    check(Array.isArray(buyerApplications) && buyerApplications.some(row => row.applicationId === application.applicationId),
      'The buyer MCP did not list the worker application.');
    const hired = safeObject(resultOf(await marketplace.client.callTool({name:'marketplace_application_hire',arguments:{
      taskId,requestId:randomUUID(),expectedVersion:buyerPrivateTask.version,applicationId:application.applicationId,
    }}),'marketplace_application_hire'),'buyer hire');
    check(hired.acceptedApplicationId === application.applicationId, 'The buyer MCP did not hire the selected applicant.');
    const workerEngagement = safeObject(resultOf(await workerMarketplace.client.callTool({name:'marketplace_engagement_get',arguments:{taskId}}),
      'marketplace_engagement_get'),'worker engagement');
    check(workerEngagement.acceptedApplicationId === application.applicationId,
      'The worker MCP did not read the accepted engagement.');
    const submission = safeObject(resultOf(await workerMarketplace.client.callTool({name:'marketplace_submission_add',arguments:{
      taskId,requestId:randomUUID(),expectedEngagementVersion:workerEngagement.version,
      text:'The disposable MCP fulfillment workflow passed.',urls:[],
    }}),'marketplace_submission_add'),'worker submission');
    check(typeof submission.submissionId === 'string' && submission.state === 'CURRENT',
      'The worker MCP did not create the current submission.');
    const submissions = resultOf(await marketplace.client.callTool({name:'marketplace_submissions_list',arguments:{taskId}}),
      'marketplace_submissions_list');
    check(Array.isArray(submissions) && submissions.some(row => row.submissionId === submission.submissionId),
      'The buyer MCP did not read the worker submission.');
    const activityAdded = safeObject(resultOf(await workerMarketplace.client.callTool({name:'marketplace_activity_add',arguments:{
      taskId,requestId:randomUUID(),kind:'STATUS_NOTE',text:'Submission is ready for review.',
    }}),'marketplace_activity_add'),'worker activity');
    check(activityAdded.kind === 'STATUS_NOTE', 'The worker MCP did not append a participant activity note.');
    const activity = resultOf(await marketplace.client.callTool({name:'marketplace_activity_list',arguments:{taskId}}),'marketplace_activity_list');
    check(Array.isArray(activity) && activity.some(row => row.text === 'Submission is ready for review.'),
      'The buyer MCP did not read the participant activity note.');
    const buyerEngagement = safeObject(resultOf(await marketplace.client.callTool({name:'marketplace_engagement_get',arguments:{taskId}}),
      'marketplace_engagement_get'),'buyer engagement');
    check(buyerEngagement.currentSubmissionId === submission.submissionId,
      'The buyer MCP did not observe the exact current submission.');
    const accepted = safeObject(resultOf(await marketplace.client.callTool({name:'marketplace_work_accept',arguments:{
      taskId,requestId:randomUUID(),expectedEngagementVersion:buyerEngagement.version,submissionId:submission.submissionId,
    }}),'marketplace_work_accept'),'buyer acceptance');
    check(accepted.taskId === taskId && accepted.outcome === 'ACCEPTED', 'The buyer MCP did not accept the exact current work.');
    const receipt = safeObject(resultOf(await workerMarketplace.client.callTool({name:'marketplace_receipt_get',arguments:{taskId}}),
      'marketplace_receipt_get'),'worker receipt');
    const verificationKey = safeObject(resultOf(await workerMarketplace.client.callTool({name:'marketplace_receipt_key_get',arguments:{
      version:receipt.keyVersion,
    }}),'marketplace_receipt_key_get'),'receipt verification key');
    check(verificationKey.version === receipt.keyVersion && verificationKey.algorithm === 'Ed25519'
      && receipt.content.taskId === taskId && receipt.content.outcome === 'ACCEPTED',
      'The worker MCP did not return the exact receipt and matching public key.');
    const receiptBytes = Buffer.from(receipt.canonicalBase64,'base64');
    check(receiptBytes.toString('base64') === receipt.canonicalBase64, 'The signed receipt payload is not canonical base64.');
    const receiptDigest = createHash('sha256').update(receiptBytes).digest();
    check(receiptDigest.toString('hex') === receipt.contentSha256, 'The signed receipt digest does not match its payload.');
    const receiptPublicKey = createPublicKey({key:Buffer.from(verificationKey.publicKeyBase64,'base64'),format:'der',type:'spki'});
    const receiptFormatVersion=receipt.content.schema==='marketplace-work-receipt-v2'?2:1;
    const signatureValid = verify(null,Buffer.concat([Buffer.from(`marketplace-work-receipt-signature-v${receiptFormatVersion}\0`,'utf8'),receiptDigest]),
      receiptPublicKey,Buffer.from(receipt.signatureBase64,'base64'));
    check(signatureValid, 'The Marketplace MCP receipt signature did not verify against the published public key.');
    assertSafeMcpResult(receipt, 'Work receipt');
    const profileStore=await MarketplaceProfileStore.open(marketplaceHome);
    let accountId;
    try {accountId=profileStore.getProfile(profileId).accountId;} finally {profileStore.close();}
    return { ...nativeJourney, accountId, intentId: funding.intentId, paymentHash: funding.status.sendHash,
      creditedState: funding.status.state, taskId, taskGrossAtomic, nativeNetwork: 'LOCAL',
      testCredentialStore: 'disposable-secret-tool',
      marketplaceMcpFunding: true, marketplaceMcpFundingRecoveryRead: true, marketplaceMcpDraftReplay: true, marketplaceMcpPublishedTask: true,
      marketplaceMcpApplication: true, marketplaceMcpHire: true, marketplaceMcpSubmission: true, marketplaceMcpActivity: true,
      marketplaceMcpAcceptance: true, marketplaceMcpReceiptVerified: true };
  } finally {
    if (atto) await atto.close();
    if (workerMarketplace) await workerMarketplace.close();
    if (marketplace) await marketplace.close();
    await new Promise(resolvePromise => worker.server.close(resolvePromise));
  }
}

async function seedWorkerProfile() {
  const raw = await readFile(workerSessionFile, 'utf8');
  const session = safeObject(JSON.parse(raw), 'seeded worker AGENT_API session');
  try {
    const store = await MarketplaceProfileStore.open(workerMarketplaceHome);
    try {
      store.createProfile({id:'worker',origin:marketplaceOrigin,audience,accountId:session.accountId,agentId:session.agentId,
        identityId:session.identityId,controllerNetwork:'ATTO',controllerAddress:session.controllerAddress,controllerIndex:0,
        authMode:'controller-session',accessToken:session.accessToken,accessExpiresAt:session.accessExpiresAt,
        refreshToken:session.refreshToken,refreshExpiresAt:session.refreshExpiresAt});
    } finally { store.close(); }
    return {accountId:session.accountId,authMode:'seeded AGENT_API test session'};
  } finally { await unlink(workerSessionFile); }
}

async function cleanup() {
  if (!attoMain || !attoCli) return;
  try {
    await runTerminal(['wallet', 'reset'], { prompt: 'Type reset to delete this local wallet:', response: 'reset', label: 'disposable wallet cleanup' });
  } catch {
    // The disposable profile remains under the isolated temporary directory;
    // avoid echoing the terminal transcript, which contains recovery material.
  }
}

async function main() {
  check(stage === 'setup' || stage === 'seed-worker' || stage === 'payment' || stage === 'cleanup', 'Unknown integration stage.');
  check(typeof baseDirectory === 'string' && baseDirectory.length > 0 && typeof marketplaceOrigin === 'string'
    && typeof nodeOrigin === 'string', 'The disposable integration context is incomplete.');
  check(typeof attoMain === 'string' && typeof attoCli === 'string', 'Set MKT081_ATTO_MCP_MAIN and MKT081_ATTO_CLI_MAIN to the isolated integrations clone.');
  await mkdir(baseDirectory, { recursive: true, mode: 0o700 });
  await chmod(baseDirectory, 0o700);
  await prepareDisposableKeyring();
  if (stage === 'setup') {
    const result = await makeWallet();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (stage === 'seed-worker') {
    const result = await seedWorkerProfile();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (stage === 'payment') {
    const result = await fundAndPublish();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  await cleanup();
}

main().catch(error => {
  process.stderr.write(`MKT-081 disposable stdio journey failed: ${error instanceof Error ? error.message : 'unknown test failure'}\n`);
  process.exitCode = 1;
});
