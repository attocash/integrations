import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { join } from 'node:path';
import {
  ensurePaymentHandoffDirectory, readXnoPaymentRequest, readXnoPaymentResponse,
  writeXnoPaymentRequest, writeXnoPaymentResponse,
} from '../dist/payment-handoff-files.js';
import { createXnoPaymentRequest } from '../dist/payment-handoff.js';

test('typed XNO files are atomically private and immutable for the configured handoff directory', async () => {
  // Given a configured private directory and one account-bound challenge.
  const parent = await mkdtemp(join(tmpdir(), 'atto-marketplace-mcp-payment-files-'));
  const directory = join(parent, 'shared handoffs');
  const request = makeRequest();
  try {
    // When Marketplace MCP writes the challenge and the external payer writes one matching response.
    const secured = ensurePaymentHandoffDirectory(directory);
    assert.equal(secured, directory);
    assert.deepEqual(writeXnoPaymentRequest(directory, request), request);
    assert.deepEqual(readXnoPaymentRequest(directory, request.handoffId), request);
    const response = makeResponse(request);
    assert.deepEqual(writeXnoPaymentResponse(directory, request.handoffId, response), response);

    // Then only complete 0600 files are visible in the 0700 directory and retries preserve exact bytes.
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    for (const suffix of ['request', 'response']) {
      assert.equal((await stat(join(directory, `${request.handoffId}.${suffix}.json`))).mode & 0o777, 0o600);
    }
    assert.deepEqual(await readdir(directory), [`${request.handoffId}.request.json`, `${request.handoffId}.response.json`]);
    assert.deepEqual(readXnoPaymentResponse(directory, request.handoffId), response);
    assert.throws(() => writeXnoPaymentResponse(directory, request.handoffId,
      makeResponse(request, { sendHash: 'C'.repeat(64) })));
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('payment handoff reads reject symlinked directories, files, and permissive files', async () => {
  // Given a private directory, an immutable request, and separate attacker-controlled paths.
  const parent = await mkdtemp(join(tmpdir(), 'atto-marketplace-mcp-payment-links-'));
  const target = join(parent, 'target');
  const link = join(parent, 'link');
  const outside = join(parent, 'outside.json');
  await mkdir(target, { mode: 0o700 });
  await writeFile(outside, '{}\n', { mode: 0o600 });
  await symlink(target, link);
  const request = makeRequest();
  try {
    // When callers choose a symlinked handoff directory, or replace a fixed file with a symlink, reads fail closed.
    assert.throws(() => ensurePaymentHandoffDirectory(link));
    writeXnoPaymentRequest(target, request);
    const responsePath = join(target, `${request.handoffId}.response.json`);
    await symlink(outside, responsePath);
    assert.throws(() => readXnoPaymentResponse(target, request.handoffId));

    // Then a handoff file with group or world permissions is rejected before its contents are read.
    await rm(responsePath);
    await writeFile(responsePath, '{}\n', { mode: 0o600 });
    await chmod(responsePath, 0o644);
    assert.throws(() => readXnoPaymentResponse(target, request.handoffId));
  } finally { await rm(parent, { recursive: true, force: true }); }
});

function makeRequest() {
  const requestId = '11111111-1111-4111-8111-111111111111';
  const intentId = '22222222-2222-4222-8222-222222222222';
  const expiresAt = new Date(Date.now() + 180_000).toISOString();
  const requirement = {
    x402Version: 2,
    resource: { url: `https://marketplace.example/v1/agent/topups/${intentId}`, description: 'Fund Marketplace account', mimeType: 'application/json' },
    accepts: [{ scheme: 'exact', network: 'nano:dev', amount: '900719925474099312345', asset: 'XNO', payTo: 'nano_3igf8hd4sjshoibbbkeitmgkp1o6ug4xads43j6e4gqkj5xk5o83j8ja9php',
      maxTimeoutSeconds: 300, extra: { assetTransferMethod: 'native-state', paymentFlow: 'upfront' } }],
    extensions: { 'payment-identifier': { info: { required: true }, schema: { type: 'object' } } },
  };
  return createXnoPaymentRequest({
    version: 1, type: 'marketplace-x402-payment-request', handoffId: 'a'.repeat(32),
    origin: 'https://marketplace.example', audience: 'marketplace-agent-api', accountId: '33333333-3333-4333-8333-333333333333',
    asset: 'XNO', network: 'nano:dev', amountAtomic: '900719925474099312345', requestId, paymentIdentifier: requestId,
    intentId, resourceUrl: requirement.resource.url, expiresAt,
    paymentRequired: Buffer.from(JSON.stringify(requirement)).toString('base64'),
  });
}

function makeResponse(request, overrides = {}) {
  const deadline = request.expiresAt;
  const requirement = JSON.parse(Buffer.from(request.paymentRequired, 'base64').toString('utf8'));
  const payer = 'nano_1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const payload = {
    x402Version: 2, resource: requirement.resource, accepted: requirement.accepts[0],
    payload: { block: { type: 'state', account: payer, previous: 'C'.repeat(64), link_as_account: requirement.accepts[0].payTo, representative: payer, balance: '1', link: 'C1CD33D62CC72FAC1294C990D4DD2B02A4DB85D42F220C48C13AF288FB21D4C1', signature: 'E'.repeat(128), work: 'F'.repeat(16) } },
    extensions: { 'payment-identifier': { schema: requirement.extensions['payment-identifier'].schema,
      info: { required: true, id: request.paymentIdentifier } } },
  };
  return {
    version: 1, type: 'marketplace-x402-payment-response', handoffId: request.handoffId,
    requestSha256: request.requestSha256, intentId: request.intentId, requestId: request.requestId,
    accountId: request.accountId, asset: request.asset, network: request.network, amountAtomic: request.amountAtomic,
    origin: request.origin, paymentIdentifier: request.paymentIdentifier, resourceUrl: request.resourceUrl,
    paymentRequiredSha256: request.paymentRequiredSha256, sendHash: 'A'.repeat(64), payer, signedDeadline: deadline,
    paymentSignature: Buffer.from(JSON.stringify(payload)).toString('base64'), ...overrides,
  };
}
