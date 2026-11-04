import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSafeMcpResult } from './support/safe-mcp-result.mjs';

test('allows only the documented public receive transaction signature path', () => {
  assert.doesNotThrow(() => assertSafeMcpResult({
    hash: 'public-hash', transaction: { signature: 'public-chain-signature' },
  }, 'wallet receive', ['transaction.signature']));

  assert.throws(() => assertSafeMcpResult({ other: { signature: 'public-chain-signature' } }, 'wallet receive'),
    /wallet receive exposed prohibited field path\(s\): other\.signature/);
});

test('rejects private credentials and signed payment material by field path', () => {
  for (const key of ['mnemonic', 'privateKey', 'seed', 'accessToken', 'refreshToken', 'apiKey',
    'paymentSignature', 'transactionJson', 'signedPayload', 'signature']) {
    assert.throws(() => assertSafeMcpResult({ payment: { [key]: 'sentinel' } }, 'payment result'),
      new RegExp(`payment result exposed prohibited field path\\(s\\): payment\\.${key}`));
  }
});
