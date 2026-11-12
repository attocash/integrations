import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { readMarketplaceProofApprovalRequest, writeMarketplaceProofApprovalResponse } from '../dist/marketplace/approval-files.js';
import { assertPrivatePermissions } from '../dist/storage/private-permissions.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'atto-approval-files-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const handoffId = 'a'.repeat(32), requestPath = join(directory, `${handoffId}.request.json`);
  const request = { version: 1, handoffId, challenge: { message: 'exact challenge\nbytes' } };
  writeFileSync(requestPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
  const response = { version: 1, type: 'marketplace-controller-approval-response', profileId: 'agent', handoffId,
    requestDigest: 'b'.repeat(64), challengeId: '00000000-0000-4000-8000-000000000001', message: request.challenge.message,
    signature: 'c'.repeat(128), controllerAddress: 'public-controller', controllerIndex: 0 };
  return { directory, requestPath, request, response };
}

test('private approval publication preserves exact signed bytes and rejects replacement', t => {
  // Given an exact private approval request and a synthetic signed response.
  const f = fixture(t);
  assert.deepEqual(readMarketplaceProofApprovalRequest(f.requestPath), f.request);
  // When the terminal publishes its create-only response.
  const responsePath = writeMarketplaceProofApprovalResponse(f.requestPath, f.response);
  const bytes = readFileSync(responsePath);
  // Then it remains private, has one link, leaves no temporary files and cannot be replaced.
  assertPrivatePermissions(responsePath, 'file');
  assert.equal(lstatSync(responsePath).nlink, 1);
  assert.equal(bytes.toString(), `${JSON.stringify(f.response)}\n`);
  assert.equal(readdirSync(f.directory).some(name => name.endsWith('.tmp')), false);
  assert.throws(() => writeMarketplaceProofApprovalResponse(f.requestPath, { ...f.response, signature: 'd'.repeat(128) }),
    { code: 'MARKETPLACE_APPROVAL_EXISTS' });
  assert.deepEqual(readFileSync(responsePath), bytes);
});

test('POSIX approval requests retain readable-file and response-parent mode compatibility', {skip:process.platform === 'win32'}, t => {
  // Given a request readable by other users in an owned parent that is not writable by them.
  const f = fixture(t);
  chmodSync(f.directory,0o755);
  chmodSync(f.requestPath,0o644);
  // When the original read contract consumes either readable or owner-readonly request bytes.
  assert.deepEqual(readMarketplaceProofApprovalRequest(f.requestPath),f.request);
  chmodSync(f.requestPath,0o400);
  assert.deepEqual(readMarketplaceProofApprovalRequest(f.requestPath),f.request);
  const responsePath = writeMarketplaceProofApprovalResponse(f.requestPath,f.response);
  // Then publication in the original 0755 parent retains exact private signed bytes without normalizing inputs.
  assert.equal(lstatSync(f.directory).mode & 0o777,0o755);
  assert.equal(lstatSync(f.requestPath).mode & 0o777,0o400);
  assertPrivatePermissions(responsePath,'file');
  assert.equal(readFileSync(responsePath,'utf8'),`${JSON.stringify(f.response)}\n`);
});

test('POSIX approval boundaries reject requests or response parents writable by other users', {skip:process.platform === 'win32'}, t => {
  // Given a request with group/other write permission.
  const f = fixture(t);
  chmodSync(f.requestPath,0o666);
  // When reading the request, its original write-protection guard rejects it.
  assert.throws(() => readMarketplaceProofApprovalRequest(f.requestPath), {code:'MARKETPLACE_APPROVAL_FILE'});
  chmodSync(f.requestPath,0o600);
  chmodSync(f.directory,0o777);
  assert.deepEqual(readMarketplaceProofApprovalRequest(f.requestPath),f.request);
  // Then a separately writable response parent also prevents signed publication.
  assert.throws(() => writeMarketplaceProofApprovalResponse(f.requestPath,f.response), {code:'MARKETPLACE_APPROVAL_FILE'});
  assert.equal(readdirSync(f.directory).length,1);
});

test('approval files reject a symbolic-link or junction ancestor', t => {
  // Given an otherwise private request reached through a redirected directory.
  const f = fixture(t), alias = join(f.directory, 'alias');
  symlinkSync(f.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const requestPath = join(alias, `${f.response.handoffId}.request.json`);
  // When either terminal boundary receives the redirected path.
  assert.throws(() => readMarketplaceProofApprovalRequest(requestPath), { code: 'MARKETPLACE_APPROVAL_FILE' });
  assert.throws(() => writeMarketplaceProofApprovalResponse(requestPath, f.response), { code: 'MARKETPLACE_APPROVAL_FILE' });
  // Then no response was published through the redirected directory.
  assert.equal(existsSync(join(f.directory, `${f.response.handoffId}.response.json`)), false);
});
