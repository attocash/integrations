import assert from 'node:assert/strict';
import test from 'node:test';
import { mnemonicSeed, derivedSigner } from '../../atto-cli/dist/wallet/signing.js';
import { deriveSlip10PrivateKey, deriveNanoRecoveryPrivateKey, derivePrivateKey, publicKey, addressFromPublicKey, upperHex } from '../dist/index.js';

const phrase = `${'abandon '.repeat(23)}art`;
const nanoAddress = 'nano_1ago7jdaipwf9jycz7fjn7s7sc7qz5gqdwrmqhham7fhfih1x9no74r15gwr';
const attoAddress = 'atto://adxseu7ne6h3h5avlrmapalc6qw2dsygbungfscakf6re44prhufjy7syamqo';

test('shared BIP39 empty-passphrase and SLIP-0010 vectors match custody keys and rail-specific addresses', async () => {
  const vector = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  assert.equal(upperHex(deriveSlip10PrivateKey(vector, [])), '2B4BE7F19EE27BBF30C667B642D5F4AA69FD169872F8FC3059C08EBAE2EB19E7');
  assert.equal(upperHex(deriveSlip10PrivateKey(vector, [0])), '68E0FE46DFB67E368C75379ACEC591DAD19DF3CDE26E63B93A8E704F1DADE7A3');
  assert.equal(upperHex(deriveSlip10PrivateKey(vector, [0, 1, 2, 2, 1_000_000_000])), '8F94D394A8E8FD6B1BC2F3F49F5C47E385281D5C17E65324B0F62483E37E8793');
  const seed = await mnemonicSeed(phrase);
  try {
    const bytes = new Uint8Array(seed.value.buffer, seed.value.byteOffset, seed.value.byteLength);
    assert.equal(upperHex(bytes), '408B285C123836004F4B8842C89324C1F01382450C0D439AF345BA7FC49ACF705489C6FC77DBD4E3DC1DD8CC6BC9F043DB8ADA1E243C4A0EAFB290D399480840');
    const nano = deriveNanoRecoveryPrivateKey(bytes, 0), atto = deriveSlip10PrivateKey(bytes, [44, 1869902945, 0]);
    try {
      assert.equal(upperHex(nano), 'E340E759FFB408B34F95DA5D247C8A22C333F5D75A48794E5AC158C23811B3C5');
      assert.equal(upperHex(atto), 'A785C2C528FFFC88D02C1F1C8597002FC1D90F2AA7CECED5956A49DFFC9B6E20');
      assert.notDeepEqual(atto, nano);
      assert.equal(addressFromPublicKey(publicKey(nano)), nanoAddress);
      assert.equal((await derivedSigner(seed, 0)).address.value, attoAddress);
      assert.notEqual(addressFromPublicKey(publicKey(derivePrivateKey(nano, 0))), nanoAddress);
      assert.notEqual(addressFromPublicKey(publicKey(deriveNanoRecoveryPrivateKey(bytes, 1))), nanoAddress);
    } finally { nano.fill(0); atto.fill(0); }
    for (const index of [-1, 0x80000000, 0.5, NaN]) assert.throws(() => deriveNanoRecoveryPrivateKey(bytes, index));
  } finally { seed.value.fill(0); }
});
