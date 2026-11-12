import { assertPrivate, setPermissions } from './support/private-permissions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageDirectory = process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR ?? join(import.meta.dirname, '..');
const {
  ensurePaymentHandoffDirectory, readXnoPaymentRequest, readXnoPaymentResponse, readXnoPaymentResponseForRecovery,
  writeXnoPaymentRequest, writeXnoPaymentResponse,
} = await import(pathToFileURL(join(packageDirectory, 'dist/payment-handoff-files.js')).href);
const { createXnoPaymentRequest } = await import(pathToFileURL(join(packageDirectory, 'dist/payment-handoff.js')).href);

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

    // Then only complete private files are visible in the private directory and retries preserve exact bytes.
    assertPrivate(directory, 'directory');
    for (const suffix of ['request', 'response']) {
      assertPrivate(join(directory, `${request.handoffId}.${suffix}.json`), 'file');
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
  const directoryAlias = join(parent, 'link');
  const outside = join(parent, 'outside.json');
  await mkdir(target, { mode: 0o700 });
  await writeFile(outside, '{}\n', { mode: 0o600 });
  await symlink(target, directoryAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const request = makeRequest();
  try {
    // When callers choose a symlinked handoff directory, or replace a fixed file with a symlink, reads fail closed.
    assert.throws(() => ensurePaymentHandoffDirectory(directoryAlias));
    writeXnoPaymentRequest(target, request);
    const responsePath = join(target, `${request.handoffId}.response.json`);
    // Standard Windows users exercise the same unsafe file-alias refusal with an unknown hardlink.
    if (process.platform === 'win32') await link(outside,responsePath);
    else await symlink(outside, responsePath);
    assert.throws(() => readXnoPaymentResponse(target, request.handoffId));

    // Then a handoff file with group or world permissions is rejected before its contents are read.
    await rm(responsePath);
    await writeFile(responsePath, '{}\n', { mode: 0o600 });
    if (process.platform !== 'win32') {
      await setPermissions(responsePath, 0o644);
      assert.throws(() => readXnoPaymentResponse(target, request.handoffId));
    }
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


test('payment handoff reads reject hardlinked evidence and recover the same immutable request after alias removal', async () => {
  // Given one saved request and an extra hardlink to the same native file identity.
  const directory = await mkdtemp(join(tmpdir(), "marketplace payment O'Brien-"));
  const request = makeRequest();
  try {
    writeXnoPaymentRequest(directory, request);
    const path = join(directory, `${request.handoffId}.request.json`);
    const alias = join(directory, 'unexpected-alias.json');
    await link(path, alias);
    // When the request has more than its single intended directory entry, recovery fails closed.
    assert.throws(() => readXnoPaymentRequest(directory, request.handoffId), {code:'PAYMENT_FILE'});
    await rm(alias);
    // Then recovery and an identical retry still use the original opaque handle and exact content.
    assert.deepEqual(readXnoPaymentRequest(directory, request.handoffId), request);
    assert.deepEqual(writeXnoPaymentRequest(directory, request), request);
  } finally { await rm(directory, {recursive:true,force:true}); }
});


for (const publisher of ['request','response','nano-response']) {
  test(`payment ${publisher} recovers only its exact interrupted publication and preserves immutable retries`, async () => {
    // Given the exact file identity and known temp name left after link() but before unlink().
    const directory = await mkdtemp(join(tmpdir(), 'marketplace-payment-publication-'));
    const request = makeRequest(), response = makeResponse(request);
    try {
      writeXnoPaymentRequest(directory,request);
      const kind = publisher === 'request' ? 'request' : 'response';
      if (kind === 'response') writeXnoPaymentResponse(directory,request.handoffId,response);
      const path = join(directory, `${request.handoffId}.${kind}.json`), bytes = await readFile(path), original = await lstat(path);
      const temporary = join(directory, publisher === 'nano-response' ? `.nano-${'c'.repeat(32)}.tmp`
        : `.${request.handoffId}.${kind}.${'d'.repeat(24)}.tmp`);
      await link(path,temporary);
      // When immutable retry or historical recovery consumes that committed request/response.
      const recovered = kind === 'request' ? writeXnoPaymentRequest(directory,request)
        : readXnoPaymentResponseForRecovery(directory,request.handoffId,request);
      // Then recovery removes only the verified link and retains the original payment content and inode.
      assert.deepEqual(recovered,kind === 'request' ? request : response);
      await assert.rejects(lstat(temporary),{code:'ENOENT'});
      assert.equal((await lstat(path)).ino,original.ino);
      assert.equal((await lstat(path)).nlink,1);
      assert.deepEqual(await readFile(path),bytes);
      if (kind === 'response') assert.deepEqual(writeXnoPaymentResponse(directory,request.handoffId,response),response);
    } finally { await rm(directory,{recursive:true,force:true}); }
  });
}

test('payment handoffs normalize existing POSIX directories and accept owner-readonly input', {skip:process.platform === 'win32'}, async () => {
  // Given an existing handoff directory with the original mutable setup permissions.
  const parent = await mkdtemp(join(tmpdir(), 'atto-payment-mode-compatibility-'));
  const directory = join(parent, 'handoffs');
  await mkdir(directory,{mode:0o755});
  await setPermissions(directory,0o755,'directory');
  const request = makeRequest();
  try {
    // When setup and an external payer leave a valid owner-readonly request.
    ensurePaymentHandoffDirectory(directory);
    assertPrivate(directory,'directory');
    writeXnoPaymentRequest(directory,request);
    const path = join(directory, `${request.handoffId}.request.json`);
    const before = await readFile(path);
    const temporary = join(directory, `.${request.handoffId}.request.${'b'.repeat(24)}.tmp`);
    await link(path,temporary);
    await setPermissions(path,0o400);
    await setPermissions(directory,0o500,'directory');
    // Then the original read normalizes its directory without rejecting or changing the private input bytes.
    assert.deepEqual(readXnoPaymentRequest(directory,request.handoffId),request);
    assertPrivate(directory,'directory');
    assert.equal((await lstat(path)).mode & 0o777,0o400);
    assert.deepEqual(await readFile(path),before);
    assert.equal((await lstat(path)).nlink,1);
    await assert.rejects(lstat(temporary),{code:'ENOENT'});
  } finally { await rm(parent,{recursive:true,force:true}); }
});
