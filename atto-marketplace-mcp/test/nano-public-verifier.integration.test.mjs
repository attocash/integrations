import test from 'node:test';
import assert from 'node:assert/strict';
import { offchainVerify } from '@attocash/atto-marketplace-nano-adapter/protocol';

const address='nano_3noms9a1zytox399kygpge6cc7hu1z79ms1cgzojodz8741qi7w5u3nzb8mn';
const message='Hej Nano!🥦';
const signature='535c745819d0f40056f3c46402b4fae4356b3a8897bde99c955d411920e740d781e6dddcbde228e8b86c4383a1003f9f315519ff73bd356f561d19865dc90f09';

test('the installed public JavaScript verifier accepts the NOMS vector and rejects changed proof bytes',()=>{
  // The verification-only export has no wallet configuration, child process or private key dependency.
  assert.equal(offchainVerify(address,message,signature),true);
  const firstNibble=signature[0]==='0'?'1':'0';
  assert.equal(offchainVerify(address,message,firstNibble+signature.slice(1)),false);
  assert.equal(offchainVerify(address,'Hej Nano?🥦',signature),false);
});
