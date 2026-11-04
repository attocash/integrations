#!/usr/bin/env node
// Opt-in acceptance against an already-onboarded, unfunded local Nano dev wallet.
// Never creates, resets, or reprovisions the selected source wallet or Marketplace profile.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { NanoRpcClient, NanoStateBlock, addressPublicKey, hexBytes, inspectNanoWallet, provisionNanoWallet, upperHex } from '@attocash/atto-marketplace-nano-adapter';
import { DEV_GENESIS_ACCOUNT } from '../../atto-marketplace-nano-adapter/dist/rpc.js';
import { managedWalletEnvironment } from '../dist/wallet-home.js';
import { readWalletSelection } from '../dist/wallet-preferences.js';
import { callWallet } from '../dist/wallet-process.js';

assert.equal(process.env.GUIDED_NATIVE_MARKETPLACE_TEST, '1', 'Set GUIDED_NATIVE_MARKETPLACE_TEST=1 to authorize retained-wallet local Nano dev payments.');
const args = process.argv.slice(2), flags = new Map();
for (let i = 0; i < args.length; i += 2) {
  assert.ok(['--home', '--profile'].includes(args[i]) && args[i + 1] && !flags.has(args[i]), 'Use --home <existing-private-home> --profile <existing-profile>.');
  flags.set(args[i], args[i + 1]);
}
assert.ok(flags.has('--home') && flags.has('--profile'), 'Supply the existing home and profile explicitly.');
const home = resolve(flags.get('--home')), profileId = flags.get('--profile');
assert.ok(isAbsolute(flags.get('--home')) && realpathSync(home) === home, 'Use the exact existing absolute home without symbolic links.');
assert.match(profileId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/);
function localUrl(value) {
  const url = new URL(value);
  assert.ok(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    && !url.username && !url.password && !url.hash, 'Only loopback HTTP development endpoints are accepted.');
  return url;
}
function profilePublic() {
  const db = new DatabaseSync(join(home, 'profiles.sqlite'), { readOnly: true });
  try {
    const profile = db.prepare('SELECT id,origin,audience,account_id,identity_id,controller_network,controller_address,controller_index,auth_mode FROM profiles WHERE id=?').get(profileId);
    assert.ok(profile, 'The selected profile must already be onboarded.');
    return { ...profile };
  } finally { db.close(); }
}
const profile = profilePublic(), origin = localUrl(profile.origin).origin;
assert.equal(profile.auth_mode, 'controller-session');
assert.equal(profile.controller_network, 'NANO');
const selected = managedWalletEnvironment(home, {}), directory = selected.MARKETPLACE_MCP_NANO_WALLET_DATA_DIR;
const config = await inspectNanoWallet(directory);
assert.equal(config.network, 'nano:dev');
assert.equal(config.origin, origin);
assert.equal(config.audience, profile.audience);
assert.equal(config.sourceAddress, profile.controller_address);
assert.equal(config.derivationIndex, profile.controller_index);
assert.equal(selected.MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR, directory);
assert.equal(selected.MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR, config.handoffDirectory);
assert.deepEqual(config.limits, { maxPaymentAtomic: '1000', rolling24hAtomic: '1000' });
assert.equal(config.grants.marketplaceFunding, true);
assert.equal(config.grants.externalTransfers, true);
assert.ok(config.grants.controllerPurposes.includes('login'));
const rpcUrl = localUrl(config.rpcUrl), rpc = new NanoRpcClient(rpcUrl, 'nano:dev');
const evidence = join(home, 'guided-native-acceptance');
mkdirSync(evidence, { mode: 0o700 }); // Create-only: an admitted run cannot be accidentally funded twice.
const main = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const bin = join(evidence, 'bin'); mkdirSync(bin, { mode: 0o700 }); symlinkSync(process.execPath, join(bin, 'node'));
const mcpEnv = { PATH: bin };
assert.equal(Object.keys(mcpEnv).some(key => key.startsWith('MARKETPLACE_')), false);
assert.equal(spawnSync('java', ['-version'], { env: mcpEnv }).error?.code, 'ENOENT');
const report = { state: 'RUNNING', evidence, home, profileId, origin, rpc: rpcUrl.href, network: 'nano:dev',
  accountId: profile.account_id, sourceAddress: config.sourceAddress, controllerIndex: config.derivationIndex,
  mcpArguments: ['--home', home, '--profile', profileId], mcpWalletEnvironmentOverrides: [], javaExecutableAvailable: false,
  startedAt: new Date().toISOString(), events: [] };
function save() {
  const path = join(evidence, 'results.json');
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); chmodSync(path, 0o600);
}
function event(name, values = {}) { report.events.push({ name, at: new Date().toISOString(), ...values }); save(); console.log(JSON.stringify({ name, ...values })); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function fileIdentity(path) { const st = lstatSync(path); return { inode: st.ino, device: st.dev, mode: st.mode & 0o777, size: st.size, modifiedAt: st.mtimeMs }; }
function sourceIdentity() { return { configSha256: digest(readFileSync(join(directory, 'wallet.json'))), keySource: config.keySource.type==='native-seed'?{...config.keySource,seedFile:fileIdentity(config.keySource.seedFile)}:config.keySource, selection: readWalletSelection(home), profile: profilePublic() }; }
function journal() {
  const db = new DatabaseSync(join(directory, 'nano-wallet.sqlite3'), { readOnly: true });
  try { return db.prepare('SELECT id,kind,digest,state,blockHash,blockJson,amount,destination FROM operations ORDER BY id').all()
    .map(({ blockJson, ...row }) => ({ ...row, blockDigest: blockJson === null ? null : digest(blockJson) })); }
  finally { db.close(); }
}
function availableXno(result) {
  const balances = result.balances?.balances ?? result.balances;
  assert.ok(Array.isArray(balances), 'Expected the public Marketplace balance list.');
  const xno = balances.find(row => row.asset === 'XNO'); assert.ok(xno, 'Expected the XNO balance.');
  return xno.availableAtomic;
}
async function confirmed(hash) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) { const info = await rpc.blockInfo(hash); if (info?.confirmed) return info; await delay(200); }
  throw Error(`Development confirmation timed out for ${hash}`);
}
let client;
async function connect() {
  client = new Client({ name: 'guided-retained-native-acceptance', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [main, '--home', home, '--profile', profileId], env: mcpEnv, stderr: 'pipe' });
  await client.connect(transport);
}
async function tool(name, arguments_, denial) {
  const value = await client.callTool({ name, arguments: arguments_ }, { timeout: 180000 });
  if (denial) {
    assert.equal(value.isError, true, `Expected ${name} to reject.`);
    assert.equal(value.structuredContent?.error?.code, denial, `Expected ${denial} from ${name}.`);
    return value.structuredContent;
  }
  assert.notEqual(value.isError, true, `${name} rejected with ${value.structuredContent?.error?.code ?? 'unknown error'}.`);
  assert.ok(value.structuredContent?.result, `${name} omitted its public result.`);
  return value.structuredContent.result;
}
async function funding(arguments_) {
  let result = await tool('marketplace_fund', arguments_);
  const deadline = Date.now() + 120000;
  while (!['ACCEPTED', 'SETTLED'].includes(result.status?.state) && Date.now() < deadline) {
    assert.ok(!['FAILED', 'REJECTED', 'EXPIRED'].includes(result.status?.state), 'Marketplace rejected the original development funding request.');
    await delay(300); result = await tool('marketplace_funding_status', { requestId: arguments_.requestId });
  }
  assert.ok(['ACCEPTED', 'SETTLED'].includes(result.status?.state), 'Marketplace funding did not reach confirmed SEND plus credit.');
  await confirmed(result.status.sendHash);
  result = await tool('marketplace_funding_status', { requestId: arguments_.requestId });
  assert.equal(result.status.payer, config.sourceAddress);
  return result;
}
async function genesisSend() {
  const current = await rpc.accountSnapshot(DEV_GENESIS_ACCOUNT);
  assert.equal(current.frontier, current.confirmedFrontier);
  const work = await rpc.generateWork(current.frontier, 2);
  // The canonical public Nano DEV genesis key is test fixture material, never a retained wallet secret.
  const key = hexBytes('34F0A37AAD20F4A260F0A5B3CB3D7FB50673212263E58A380BC10474BB039CE4');
  let block;
  try { block = NanoStateBlock.signed(key, current.frontier, current.representative, current.balance - 10000n, upperHex(addressPublicKey(config.sourceAddress)), work); }
  finally { key.fill(0); }
  writeFileSync(join(evidence, 'genesis-send.json'), `${JSON.stringify({ hash: block.hash, block: block.toWire() })}\n`, { mode: 0o600, flag: 'wx' });
  await rpc.process(block, 'send'); await confirmed(block.hash); return block.hash;
}
try {
  await rpc.requirePinnedNetwork(); rpc.requireLoopbackDevelopmentEndpoint();
  assert.equal(await rpc.accountSnapshotOrNotFound(config.sourceAddress), null, 'The retained onboarding source must still be unfunded and unopened.');
  assert.equal(journal().length, 0, 'The retained source already has native operations; do not replay this fresh-source acceptance.');
  const identityBefore = sourceIdentity();
  report.sourceIdentity = identityBefore;
  report.sourceHashes = Object.fromEntries(['./guided-native-marketplace.mjs', '../dist/main.js', '../dist/wallet-host.js', '../dist/wallet-process.js', '../dist/server.js', '../../atto-marketplace-nano-adapter/dist/wallet.js']
    .map(path => [path, digest(readFileSync(new URL(path, import.meta.url)))]));
  save();
  const recipientDirectory = join(evidence, 'recipient'), recipientHandoffs = join(recipientDirectory, 'handoffs');
  mkdirSync(recipientDirectory, { mode: 0o700 }); mkdirSync(recipientHandoffs, { mode: 0o700 });
  const recipientSeed=join(recipientDirectory,'seed.hex');writeFileSync(recipientSeed,randomBytes(32).toString('hex')+'\n',{mode:0o600,flag:'wx'});
  const recipient = await provisionNanoWallet({ seedFile:recipientSeed, dataDir: recipientDirectory, derivationIndex: 1, network: 'nano:dev', rpcUrl: rpcUrl.href,
    origin, audience: profile.audience, handoffDirectory: recipientHandoffs,
    grants: { marketplaceFunding: true, externalTransfers: false, controllerPurposes: [] }, limits: { maxPaymentAtomic: '0', rolling24hAtomic: '0' }, terminalConfirmed: true });
  const firstArgs = { asset: 'XNO', network: 'nano:dev', amountAtomic: '700', requestId: randomUUID() };
  const transferArgs = { asset: 'XNO', network: 'nano:dev', destination: recipient.address, amountAtomic: '200', requestId: randomUUID() };
  const secondArgs = { asset: 'XNO', network: 'nano:dev', amountAtomic: '100', requestId: randomUUID() };
  writeFileSync(join(evidence, 'requests.json'), `${JSON.stringify({ firstArgs, transferArgs, secondArgs }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await connect();
  const status = await tool('wallet_status', { asset: 'XNO' });
  assert.deepEqual(status, {asset: 'XNO', network: 'nano:dev', address: config.sourceAddress, index: config.derivationIndex,
    permissions: {marketplaceFunding: true, externalTransfers: true, receive: true}});
  assert.equal(availableXno(await tool('marketplace_balances_get', {})), '0');
  const catalog = (await client.listTools()).tools.map(row => row.name);
  for (const name of ['wallet_receivables', 'wallet_receive', 'wallet_transfer', 'marketplace_fund']) assert.ok(catalog.includes(name));
  assert.equal(catalog.includes('wallet_call'), false);
  event('retained profile starts through saved selections with a Node-only PATH', { sourceAddress: config.sourceAddress, accountId: profile.account_id });
  const genesisHash = await genesisSend();
  const incoming = await tool('wallet_receivables', { asset: 'XNO', network: 'nano:dev', limit: 10 });
  assert.equal(incoming.address, config.sourceAddress);
  const payment = incoming.items.find(row => row.hash === genesisHash);
  assert.ok(payment, 'Public wallet_receivables did not discover the exact development SEND.'); assert.equal(payment.amountAtomic, '10000');
  let opened = await tool('wallet_receive', { asset: 'XNO', network: 'nano:dev', hash: genesisHash });
  assert.equal(opened.sendHash, genesisHash);
  assert.equal(opened.address, config.sourceAddress);
  assert.equal(opened.amountAtomic, '10000');
  await confirmed(opened.hash);
  const openHash = opened.hash;
  opened = await tool('wallet_receive', { asset: 'XNO', network: 'nano:dev', hash: genesisHash });
  assert.equal(opened.state, 'SETTLED'); assert.equal(opened.hash, openHash); assert.equal(opened.sendHash, genesisHash);
  assert.equal((await tool('wallet_receivables', { asset: 'XNO', network: 'nano:dev', limit: 10 })).items.length, 0);
  event('public receivables discovery and exact receive open the retained wallet once', { fundingSendHash: genesisHash, openHash, amountAtomic: '10000' });
  const first = await funding(firstArgs); assert.equal(availableXno(first), '700');
  const firstRow = journal().find(row => row.kind === 'payment' && row.amount === '700');
  assert.equal(firstRow?.state, 'CONFIRMED'); assert.equal(firstRow.blockHash, first.status.sendHash.toUpperCase());
  event('first Marketplace funding uses the onboarded source', { requestId: firstArgs.requestId, sendHash: first.status.sendHash, availableAtomic: '700' });
  let transfer = await tool('wallet_transfer', transferArgs); await confirmed(transfer.hash);
  transfer = await tool('wallet_transfer_status', { asset: 'XNO', requestId: transferArgs.requestId });
  assert.equal(transfer.state, 'SETTLED'); assert.equal(transfer.sourceAddress, config.sourceAddress);
  event('external native transfer shares the source and journal', { requestId: transferArgs.requestId, sendHash: transfer.hash, amountAtomic: '200', recipient: recipient.address });
  const second = await funding(secondArgs); assert.equal(availableXno(second), '800');
  const rowsBeforeLimits = journal(), frontierBeforeLimits = (await rpc.accountSnapshot(config.sourceAddress)).frontier;
  assert.equal(rowsBeforeLimits.filter(row => ['payment', 'transfer'].includes(row.kind) && row.state === 'CONFIRMED').reduce((sum, row) => sum + BigInt(row.amount), 0n), 1000n);
  event('second Marketplace funding reaches the shared rolling ceiling', { requestId: secondArgs.requestId, sendHash: second.status.sendHash, availableAtomic: '800', totalRollingSpendAtomic: '1000' });
  await tool('wallet_transfer', { ...transferArgs, amountAtomic: '1', requestId: randomUUID() }, 'SPENDING_LIMIT');
  await tool('wallet_transfer', { ...transferArgs, amountAtomic: '1001', requestId: randomUUID() }, 'SPENDING_LIMIT');
  assert.deepEqual(journal(), rowsBeforeLimits);
  assert.equal((await rpc.accountSnapshot(config.sourceAddress)).frontier, frontierBeforeLimits);
  assert.equal(availableXno(await tool('marketplace_balances_get', {})), '800');
  event('shared rolling and per-payment ceilings reject without native candidates or account effects', { denial: 'SPENDING_LIMIT', checkedLimits: ['rolling24h', 'perPayment'] });
  await client.close(); client = undefined; await connect();
  const firstReplay = await funding(firstArgs), secondReplay = await funding(secondArgs), transferReplay = await tool('wallet_transfer', transferArgs);
  const openReplay = await tool('wallet_receive', { asset: 'XNO', network: 'nano:dev', hash: genesisHash });
  assert.equal(firstReplay.status.sendHash, first.status.sendHash); assert.equal(secondReplay.status.sendHash, second.status.sendHash);
  assert.equal(transferReplay.hash, transfer.hash); assert.equal(openReplay.hash, openHash);
  assert.equal(availableXno(firstReplay), '800'); assert.equal(availableXno(secondReplay), '800');
  assert.deepEqual(journal(), rowsBeforeLimits); assert.equal((await rpc.accountSnapshot(config.sourceAddress)).frontier, frontierBeforeLimits);
  const native = await tool('wallet_balance', { asset: 'XNO', network: 'nano:dev' });
  assert.equal(native.address, config.sourceAddress); assert.equal(native.balanceAtomic, '9000');
  assert.deepEqual(sourceIdentity(), identityBefore, 'Onboarding selection, source configuration, key file identity or controller changed.');
  event('MCP restart without wallet overrides preserves exact hashes, digests and balances', { availableMarketplaceAtomic: '800', nativeSourceAtomic: '9000', sourceIdentityPreserved: true });
  const recipientEnv = { PATH: bin, MARKETPLACE_MCP_NANO_WALLET_DATA_DIR: recipientDirectory };
  let received = await callWallet(recipientEnv, { asset: 'XNO', operation: 'receive', input: { network: 'nano:dev', hash: transfer.hash } });
  await confirmed(received.hash);
  const recipientReceiveHash = received.hash;
  received = await callWallet(recipientEnv, { asset: 'XNO', operation: 'receive', input: { network: 'nano:dev', hash: transfer.hash } });
  assert.equal(received.state, 'SETTLED'); assert.equal(received.hash, recipientReceiveHash);
  assert.equal(received.sendHash, transfer.hash); assert.equal(received.amountAtomic, '200');
  assert.equal((await rpc.accountSnapshot(recipient.address)).confirmedBalance.toString(), '200');
  event('private dev recipient receives the original external SEND once', { recipient: recipient.address, receiveHash: recipientReceiveHash, amountAtomic: '200' });
  report.operations = journal(); report.state = 'PASSED'; report.completedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ state: report.state, evidence: join(evidence, 'results.json') }));
} catch (error) {
  report.state = 'FAILED'; report.error = error instanceof Error ? error.message : 'Unknown retained-wallet acceptance failure.';
  report.completedAt = new Date().toISOString(); save();
  console.error(JSON.stringify({ state: report.state, error: report.error, evidence: join(evidence, 'results.json') })); process.exitCode = 1;
} finally { await client?.close(); }
