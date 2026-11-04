import test from 'node:test';
import assert from 'node:assert/strict';
import { AttoPrivateKey } from '@attocash/commons-core';
import { validAttoProof } from '../dist/atto-proof.js';

test('Commons verifies only the exact ATTO controller proof bytes and key', async () => {
  const signer = await AttoPrivateKey.Companion.generate().toSigner();
  const other = await AttoPrivateKey.Companion.generate().toSigner();
  const message = 'Marketplace Agent Controller Proof v1\nPurpose: login\nNote: café 🚀';
  const signature = (await signer.signMessage(Int8Array.from(Buffer.from(message, 'utf8')))).toString();

  assert.equal(await validAttoProof(signer.address.toString(), message, signature), true);
  assert.equal(await validAttoProof(signer.address.toString(), `${message} `, signature), false);
  assert.equal(await validAttoProof(other.address.toString(), message, signature), false);
  assert.equal(await validAttoProof(signer.address.toString(), message, '00'.repeat(64)), false);
});
