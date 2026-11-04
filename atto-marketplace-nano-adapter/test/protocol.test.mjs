import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addressFromPublicKey, addressPublicKey, canonicalAddress, derivePrivateKey,
  hexBytes, MAX_RAW, NanoStateBlock, offchainDigest, offchainPayload, offchainSign,
  offchainVerify, publicKey, requiredDifficulty, sign, strictReceiveDifficulty,
  upperHex, validWork, verify, ZERO_HASH,
} from '../dist/protocol.js';

// Kotlin NanoProtocolVectorsTest and NanoOffchainMessageTest retain these
// independent vectors; the NOMS vectors are published in OpenRai ORIS-001.
const KEY = hexBytes('9F0E444C69F77A49BD0BE89DB92C38FE713E0963165CCA12FAF5712D7657120F');
const MESSAGE = hexBytes('AEC75F807DCE45AFA787DE7B395BE498A885525569DD614162E0C80FD4F27EE9');
const SIGNATURE = '1123C926EF53B0FFA3585D5F6FA17D05B2AAD486D28CBEED88837B83265F264CBAF3FEA78AF80AAB4C59740546B220ADBE207F6B800FFE864E0934E9C1078401';
const ACCOUNT = 'nano_3igf8hd4sjshoibbbkeitmgkp1o6ug4xads43j6e4gqkj5xk5o83j8ja9php';
const REPRESENTATIVE = 'nano_3p1asma84n8k84joneka776q4egm5wwru3suho9wjsfyuem8j95b3c78nw8j';
const LINK = '1EF0AD02257987B48030CC8D38511D3B2511672F33AF115AD09E18A86A8355A8';
const ROOT = 'D1E6C3C6B7DF4485B9324AB4DE023B71B5E0CA9AC20616A6F6E80D15AD4CFAC6';
const DEV_ACCOUNT = 'nano_3e3j5tkog48pnny9dmfzj1r16pg8t1e76dz5tmac6iq689wyjfpiij4txtdo';
const NOMS_KEY = hexBytes('681fd5ed71a9f81e9d29e3450f6cd8aacb87346fd21a26003389290b9d0cb173');

test('Nano BLAKE2b Ed25519 signature matches the independent Kotlin vector', () => {
  const signature = sign(KEY, MESSAGE);
  assert.equal(upperHex(signature), SIGNATURE);
  assert.equal(verify(publicKey(KEY), MESSAGE, signature), true);
  assert.equal(verify(publicKey(KEY), new Uint8Array(32), signature), false);
});

test('state block preamble, account encoding and uint128 hash match the independent vector', () => {
  const block = new NanoStateBlock(ACCOUNT.replace('nano_', 'xrb_'), ZERO_HASH,
    REPRESENTATIVE, 1n, LINK, '0'.repeat(128), '0'.repeat(16));
  assert.equal(block.hash, 'FC5A7FB777110A858052468D448B2DF22B648943C097C0608D1E2341007438B0');
  assert.equal(block.account, ACCOUNT);
  assert.equal(block.workRoot(), upperHex(addressPublicKey(ACCOUNT)));
  const signed = NanoStateBlock.signed(KEY, ROOT, REPRESENTATIVE, 1n, LINK, '0'.repeat(16));
  assert.equal(signed.validSignature(), true);
  assert.equal(signed.workRoot(), ROOT);
  assert.deepEqual(NanoStateBlock.parse(signed.toWire()), signed);
});

test('the V28.2 dev genesis public key and address match upstream ledger constants', () => {
  // https://github.com/nanocurrency/nano-node/blob/V28.2/nano/secure/common.cpp
  const key = hexBytes('34F0A37AAD20F4A260F0A5B3CB3D7FB50673212263E58A380BC10474BB039CE4');
  const expectedPublicKey = 'B0311EA55708D6A53C75CDBF88300259C6D018522FE3D4D0A242E431F9E8B6D0';
  assert.equal(upperHex(publicKey(key)), expectedPublicKey);
  assert.equal(addressFromPublicKey(publicKey(key)), DEV_ACCOUNT);
  assert.equal(upperHex(addressPublicKey(DEV_ACCOUNT)), expectedPublicKey);
});

test('seed derivation uses BLAKE2b-256 and a big-endian unsigned 32-bit index', () => {
  const seed = hexBytes('01'.repeat(32));
  assert.equal(upperHex(derivePrivateKey(seed, 0)), '2DD1CCEA5B1D02D46B19803B55F7DE8EE5DABC951FAF617C28C7933DAE30719C');
  assert.notDeepEqual(derivePrivateKey(seed, 1), derivePrivateKey(seed, 2));
  assert.equal(derivePrivateKey(seed, 0xffff_ffff).length, 32);
  for (const index of [-1, 0x1_0000_0000, NaN, Infinity, 1.1]) assert.throws(() => derivePrivateKey(seed, index));
  assert.throws(() => derivePrivateKey(new Uint8Array(31), 0));
});

test('address parser verifies checksum and canonicalizes legacy xrb addresses', () => {
  assert.equal(canonicalAddress(ACCOUNT.replace('nano_', 'xrb_')), ACCOUNT);
  assert.equal(addressFromPublicKey(addressPublicKey(ACCOUNT)), ACCOUNT);
  assert.throws(() => canonicalAddress(`${ACCOUNT.slice(0, -1)}1`));
  assert.throws(() => canonicalAddress(`nano_5${ACCOUNT.slice(6)}`));
  assert.throws(() => canonicalAddress(` ${ACCOUNT}`));
  assert.throws(() => canonicalAddress(ACCOUNT.toUpperCase()));
});

test('state parser rejects malformed uint128 values, mismatched link accounts and malformed hex', () => {
  const wire = { type: 'state', account: ACCOUNT, previous: ZERO_HASH, representative: REPRESENTATIVE,
    balance: MAX_RAW.toString(), link: LINK, signature: 'A'.repeat(128), work: 'B'.repeat(16) };
  assert.equal(NanoStateBlock.parse(wire).balance, MAX_RAW);
  assert.equal(NanoStateBlock.parse({ ...wire, link_as_account: addressFromPublicKey(hexBytes(LINK)) }).link, LINK);
  for (const balance of [(MAX_RAW + 1n).toString(), '-1', '01', '1e30', '1.0', 1, '']) {
    assert.throws(() => NanoStateBlock.parse({ ...wire, balance }));
  }
  assert.throws(() => NanoStateBlock.parse({ ...wire, link_as_account: DEV_ACCOUNT }));
  assert.throws(() => NanoStateBlock.parse({ ...wire, signature: 'Z'.repeat(128) }));
  assert.throws(() => NanoStateBlock.parse({ ...wire, work: '0' }));
  assert.throws(() => new NanoStateBlock(ACCOUNT, ZERO_HASH, REPRESENTATIVE, -1n, LINK, wire.signature, wire.work));
});

test('verification rejects noncanonical signature scalars S + L and boundaries', () => {
  const original = hexBytes(SIGNATURE);
  const originalS = BigInt(`0x${upperHex(original.subarray(32).slice().reverse())}`);
  const order = 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn;
  for (const scalar of [originalS + order, order, (1n << 256n) - 1n]) {
    const candidate = original.slice();
    candidate.set(hexBytes(scalar.toString(16).padStart(64, '0')).reverse(), 32);
    assert.equal(verify(publicKey(KEY), MESSAGE, candidate), false);
  }
});

test('verification rejects identity, torsion and noncanonical account and R encodings', () => {
  const identity = new Uint8Array(32); identity[0] = 1;
  const noncanonical = hexBytes(`ED${'FF'.repeat(30)}7F`);
  const validKey = publicKey(KEY);
  for (const key of [new Uint8Array(32), identity, noncanonical, new Uint8Array(31)]) {
    assert.equal(verify(key, MESSAGE, new Uint8Array(64)), false);
  }
  for (const point of [new Uint8Array(32), identity, noncanonical]) {
    const candidate = hexBytes(SIGNATURE); candidate.set(point);
    assert.equal(verify(validKey, MESSAGE, candidate), false);
  }
  assert.equal(verify(validKey, MESSAGE, new Uint8Array(63)), false);
});

test('ORIS-001 Unicode payload, digest, signature and address match published vector', () => {
  const message = 'Hej Nano!🥦';
  assert.equal(upperHex(offchainPayload(message)), '184E616E6F204F66662D636861696E204D6573736167653A0A0000000D48656A204E616E6F21F09FA5A6');
  assert.equal(upperHex(offchainDigest(message)), '33CE285B257DF1BA87E1A91F32211A3B900AB4FDF68BEBB3F75BEF4B85AEF951');
  assert.equal(upperHex(offchainSign(NOMS_KEY, message)), '535C745819D0F40056F3C46402B4FAE4356B3A8897BDE99C955D411920E740D781E6DDDCBDE228E8B86C4383A1003F9F315519FF73BD356F561D19865DC90F09');
  const key = publicKey(NOMS_KEY);
  assert.equal(addressFromPublicKey(key), 'nano_3noms9a1zytox399kygpge6cc7hu1z79ms1cgzojodz8741qi7w5u3nzb8mn');
  assert.equal(offchainVerify(key, message, offchainSign(NOMS_KEY, message)), true);
  assert.equal(offchainVerify(key, `${message} `, offchainSign(NOMS_KEY, message)), false);
  assert.equal(offchainVerify(addressFromPublicKey(key), message, upperHex(offchainSign(NOMS_KEY, message))), true);
  assert.equal(offchainVerify('invalid-address', message, upperHex(offchainSign(NOMS_KEY, message))), false);
});

test('ORIS-001 empty vector preserves its four-byte zero length field', () => {
  assert.equal(offchainPayload('').length, 29);
  assert.equal(upperHex(offchainDigest('')), '977A10E19A7857EEFAD986D73B071BBB7DAD60846C7785F6D0CCFFE0D7BD40B9');
  assert.equal(upperHex(offchainSign(NOMS_KEY, '')), '8FCA45D1490A276AC9D4376D9251DF3A1069F673013C33D49F3490077066F174D7FB6795B966E1D9078952AD065F836B35CD82D402CBEB63F9ACE94B2123C506');
});

test('work difficulty interprets digest and nonce as little-endian unsigned integers', () => {
  assert.equal(validWork('nano:dev', 2, false, ROOT, '8e8206e47e15b74b'), true);
  assert.equal(validWork('nano:dev', 2, false, ROOT, 'be46b2e52b34f535'), false);
  assert.equal(validWork('nano:unknown', 2, false, ROOT, '8e8206e47e15b74b'), false);
  assert.equal(validWork('nano:dev', 2, false, ROOT, '8e8206e47e15b74'), false);
  assert.equal(validWork('nano:dev', -1, false, ROOT, '8e8206e47e15b74b'), false);
});

test('work thresholds distinguish main/dev, account epochs and receive/send operations', () => {
  assert.equal(requiredDifficulty('nano:dev', 1), 'FE00000000000000');
  assert.equal(requiredDifficulty('nano:dev', 2), 'FFC0000000000000');
  assert.equal(requiredDifficulty('nano:dev', 2, true), 'F000000000000000');
  assert.equal(requiredDifficulty('nano:mainnet', 1), 'FFFFFFC000000000');
  assert.equal(requiredDifficulty('nano:mainnet', 2), 'FFFFFFF800000000');
  assert.equal(requiredDifficulty('nano:mainnet', 2, true), 'FFFFFE0000000000');
  assert.equal(strictReceiveDifficulty('nano:mainnet'), 'FFFFFFC000000000');
  assert.throws(() => requiredDifficulty('nano:beta', 2));
  assert.throws(() => requiredDifficulty('nano:mainnet', 3));
});
