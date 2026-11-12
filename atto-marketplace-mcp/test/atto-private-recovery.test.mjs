import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { fixture } from '../../atto-cli/test/support/payments.mjs';

const directory = process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR ?? join(import.meta.dirname, '..');
const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? join(import.meta.dirname, '../../atto-cli');
const { attoIntentPaymentStatus, payAttoIntent } = await import(pathToFileURL(join(directory, 'dist/wallet-process.js')).href);
const { saveWalletSelection } = await import(pathToFileURL(join(directory, 'dist/wallet-preferences.js')).href);
const { AttoApplication } = await import(pathToFileURL(join(cliDirectory, 'dist/application/app.js')).href);
const config = { apiUrl: 'http://127.0.0.1:43210/v1/agent/topups', audience: 'private-dto-test' };
function intent(f) {
  const requestId = '00000000-0000-4000-8000-000000000076', intentId = '00000000-0000-4000-8000-000000000079';
  const resourceUrl = `${config.apiUrl}/${intentId}`;
  const requirement = { x402Version: 2, resource: { url: resourceUrl }, accepts: [{ scheme: 'exact', network: 'atto:local', amount: '2',
    asset: 'atto', payTo: f.recipient.address, maxTimeoutSeconds: 300, extra: { assetTransferMethod: 'native', paymentFlow: 'authorization' } }],
    extensions: { 'payment-identifier': { schema: { type: 'object', properties: { id: { type: 'string' } } }, info: { required: true } } } };
  return { requestId, intentId, amountAtomic: '2', paymentIdentifier: requestId, ...config, resourceUrl,
    paymentRequired: Buffer.from(JSON.stringify(requirement)).toString('base64'), expiresAt: new Date(Date.now() + 300_000).toISOString() };
}

async function selectedEnvironment(f) {
  const home = join(f.directory, 'marketplace-home');
  await mkdir(home, {mode: 0o700});
  const status = await f.app.call('wallet_status');
  const account = status.addresses.find(value => value.index === 0);
  await saveWalletSelection(home, {attoDirectory: f.directory, attoAccess: {address: account.address, index: account.index,
    network: `atto:${status.settings.network.toLowerCase()}`, fingerprint: status.identity.fingerprint,
    marketplaceFunding: true, externalTransfers: false}});
  return {MARKETPLACE_MCP_HOME: home, MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR: f.directory};
}

test('actual private producer and stdio consumer agree on interrupted, signed and canonically rejected payments', { timeout: process.platform === 'win32' ? 60_000 : 30_000 }, async t => {
  const f = await fixture(t, [10], undefined, '100', undefined, { internalMarketplacePayment: config });
  const request = intent(f);
  await f.reopen('mcp');
  const env = await selectedEnvironment(f);
  const status = () => attoIntentPaymentStatus({ env, requestId: request.requestId, ...config });
  assert.deepEqual(await status(), { requestId: request.requestId, paymentState: 'NOT_FOUND' });
  const seed = f.app.payments.wallet.seed;
  f.app.payments.wallet.seed = async () => { throw new Error('Synthetic unavailable keyring'); };
  await assert.rejects(f.app.call('marketplace_pay_intent', request), /Synthetic unavailable keyring/);
  f.app.payments.wallet.seed = seed;
  const pending = await f.app.call('marketplace_pay_intent_status', { requestId: request.requestId });
  assert.equal(pending.paymentState, 'PENDING_SIGNATURE');
  assert.deepEqual(await status(), pending);
  assert.equal(f.state.publicationAttempts.length, 0);
  // Drop the initial response, restart, then recover and replay through the real private child.
  const ready = await f.app.call('marketplace_pay_intent', request);
  await f.reopen('mcp');
  assert.deepEqual(await status(), { ...ready, reused: true });
  const replay = await payAttoIntent({ env, ...config, request });
  assert.equal(replay.hash, ready.hash);
  assert.equal(replay.paymentSignature, ready.paymentSignature);
  assert.equal(replay.reused, true);
  assert.equal(f.state.publicationAttempts.length, 0);
  // A separate synthetic wallet publishes a competing block at this exact native height.
  const competitor = new AttoApplication({ directory: join(f.directory, 'competitor'),
    secrets: { get: async () => f.mnemonic(), set: async () => undefined } });
  t.after(() => competitor.close());
  await competitor.createWallet(f.mnemonic());
  await competitor.call('address_derive', { index: 1 });
  await competitor.call('wallet_configure', { network: 'LOCAL', nodeUrl: f.url, workerUrl: f.url,
    representative: f.addresses[0].address, autoReceive: false });
  await competitor.call('send', { destination: f.recipient.address, amount: '1', unit: 'RAW', requestId: 'canonical-competing-block', index: 0 });
  const failed = await status();
  assert.equal(failed.paymentState, 'FAILED');
  assert.equal(failed.failureReason, 'NATIVE_TRANSACTION_REJECTED');
  assert.equal(failed.hash, ready.hash);
  assert.equal(failed.payer, ready.payer);
  assert.equal('paymentSignature' in failed, false);
  assert.deepEqual(failed, await f.app.call('marketplace_pay_intent_status', { requestId: request.requestId }));
  assert.equal(f.state.publicationAttempts.length, 1);
  assert.equal((await f.app.call('wallet_status')).globalDirectory !== undefined, true, 'Public metadata remains available.');
  await competitor.close();
});

test('the consumer accepts proven unsigned expiry but strictly rejects extra or changed financial fields', { timeout: 30_000 }, async t => {
  const f = await fixture(t, [10], undefined, '100', undefined, { internalMarketplacePayment: config });
  const request = intent(f);
  await f.reopen('mcp');
  const seed = f.app.payments.wallet.seed;
  f.app.payments.wallet.seed = async () => { throw new Error('Synthetic unavailable keyring'); };
  await assert.rejects(f.app.call('marketplace_pay_intent', request), /Synthetic unavailable keyring/);
  f.app.payments.wallet.seed = seed;
  const now = Date.now;
  const offset = Date.parse(request.expiresAt) - now() + 1;
  t.mock.method(Date, 'now', () => now() + offset);
  const expired = await f.app.call('marketplace_pay_intent_status', { requestId: request.requestId });
  t.mock.restoreAll();
  assert.equal(expired.failureReason, 'MARKETPLACE_CHALLENGE_EXPIRED');
  assert.equal(expired.hash, null);
  const env = await selectedEnvironment(f);
  assert.deepEqual(await attoIntentPaymentStatus({ env, requestId: request.requestId, ...config }), expired);
  // Replay only returned public DTOs to exercise parser rejection without corrupting a journal.
  const replayDirectory = join(f.directory, 'dto-replay');
  await mkdir(replayDirectory, { mode: 0o700 });
  const response = join(replayDirectory, 'response.json'), host = join(replayDirectory, 'host.mjs');
  const require = createRequire(import.meta.url);
  const source = `#!${process.execPath}\nimport {readFileSync} from 'node:fs';\nimport {McpServer} from ${JSON.stringify(pathToFileURL(require.resolve('@modelcontextprotocol/server')).href)};\nimport {StdioServerTransport} from ${JSON.stringify(pathToFileURL(require.resolve('@modelcontextprotocol/server/stdio')).href)};\nconst server=new McpServer({name:'dto-replay',version:'1'});\nserver.registerTool('wallet_call',{inputSchema:{}},async()=>{const structuredContent={result:JSON.parse(readFileSync(${JSON.stringify(response)},'utf8'))};return {structuredContent,content:[{type:'text',text:JSON.stringify(structuredContent)}]};});\nawait server.connect(new StdioServerTransport());\n`;
  await writeFile(host, source, { mode: 0o700 });
  const parse = () => attoIntentPaymentStatus({ env: { MARKETPLACE_MCP_WALLET_HOST_COMMAND: host }, requestId: request.requestId, ...config });
  for (const change of [ { requestId: '00000000-0000-4000-8000-000000000088' }, { intentId: 'bad' }, { network: 'atto:foreign' },
    { amountAtomic: '0' }, { payer: 'invalid\npayer' }, { hash: 'A'.repeat(64) }, { nativeState: 'rejected' },
    { paymentIdentifier: 'different-payment-identifier' }, { addressLabels: {} }, { paymentSignature: 'unexpected-signed-bytes' } ]) {
    await writeFile(response, JSON.stringify({ ...expired, ...change }), { mode: 0o600 });
    await assert.rejects(parse(), { code: 'LOCAL_SIGNER' });
  }
  assert.equal(f.state.publicationAttempts.length, 0);
});
