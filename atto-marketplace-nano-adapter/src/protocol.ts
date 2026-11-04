import { ed25519 } from '@noble/curves/ed25519.js';
import { eddsa } from '@noble/curves/abstract/edwards.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { equalBytes } from '@noble/curves/utils.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { createHmac } from 'node:crypto';

export type NanoNetwork = 'nano:dev' | 'nano:mainnet';
export const ZERO_HASH = '0'.repeat(64);
export const MAX_RAW = (1n << 128n) - 1n;
const ALPHABET = '13456789abcdefghijkmnopqrstuwxyz';
const PREAMBLE = new Uint8Array(32);
PREAMBLE[31] = 6;

// Nano uses Ed25519 with BLAKE2b-512 for both key expansion and signatures.
// Keep the audited curve/EdDSA implementation and change only its supported hash
// and scalar-clamping options; standard Ed25519's SHA-512 is incompatible.
const nanoEd25519 = eddsa(ed25519.Point, blake2b, {
  adjustScalarBytes(bytes) {
    bytes[0] = bytes[0]! & 248;
    bytes[31] = (bytes[31]! & 127) | 64;
    return bytes;
  },
});

export function hexBytes(value: string, expectedBytes?: number): Uint8Array {
  if (typeof value !== 'string' || value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value) ||
      (expectedBytes !== undefined && value.length !== expectedBytes * 2)) {
    throw new Error('Invalid Nano hexadecimal value');
  }
  return Uint8Array.from(Buffer.from(value, 'hex'));
}

export function upperHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex').toUpperCase();
}

export function blake2bHash(size: number, ...inputs: Uint8Array[]): Uint8Array {
  if (!Number.isInteger(size) || size < 1 || size > 64) throw new Error('Invalid BLAKE2b digest size');
  return blake2b(concatBytes(...inputs), { dkLen: size });
}

export function derivePrivateKey(seed: Uint8Array, index: number): Uint8Array {
  if (seed.length !== 32 || !Number.isInteger(index) || index < 0 || index > 0xffff_ffff) {
    throw new Error('Invalid Nano seed or derivation index');
  }
  const encodedIndex = new Uint8Array(4);
  new DataView(encodedIndex.buffer).setUint32(0, index, false);
  return blake2bHash(32, seed, encodedIndex);
}

/** Ed25519 SLIP-0010 accepts only hardened children. This returns the child
 * signing key itself; it is never fed through Nano's native seed derivation. */
export function deriveSlip10PrivateKey(seed: Uint8Array, path: readonly number[]): Uint8Array {
  if (seed.length < 16 || seed.length > 64 || path.some(index => !Number.isSafeInteger(index) || index < 0 || index > 0x7fff_ffff)) {
    throw new Error('Invalid SLIP-0010 seed or hardened path');
  }
  let node = createHmac('sha512', 'ed25519 seed').update(seed).digest();
  try {
    for (const index of path) {
      const data = Buffer.alloc(37);
      try {
        data.set(node.subarray(0, 32), 1);
        data.writeUInt32BE(index + 0x8000_0000, 33);
        const child = createHmac('sha512', node.subarray(32)).update(data).digest();
        node.fill(0);
        node = child;
      } finally { data.fill(0); }
    }
    return Uint8Array.from(node.subarray(0, 32));
  } finally { node.fill(0); }
}

export function deriveNanoRecoveryPrivateKey(seed: Uint8Array, index: number): Uint8Array {
  return deriveSlip10PrivateKey(seed, [44, 165, index]);
}

export function publicKey(privateKey: Uint8Array): Uint8Array {
  return nanoEd25519.getPublicKey(privateKey);
}

export function sign(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
  return nanoEd25519.sign(message, privateKey);
}

function canonicalPrimeOrderPoint(bytes: Uint8Array): boolean {
  const point = ed25519.Point.fromBytes(bytes, false);
  return !point.is0() && point.isTorsionFree() && equalBytes(point.toBytes(), bytes);
}

export function verify(key: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (key.length !== 32 || signature.length !== 64) return false;
  try {
    // RFC8032 decoding rejects noncanonical points; prime-order checks also fence
    // torsion components and identity R. Noble checks the canonical S < L scalar.
    return canonicalPrimeOrderPoint(key) && canonicalPrimeOrderPoint(signature.subarray(0, 32)) &&
      nanoEd25519.verify(signature, message, key, { zip215: false });
  } catch {
    return false;
  }
}

function toBigEndian(value: bigint, size: number): Uint8Array {
  if (value < 0n || value >= 1n << BigInt(size * 8)) throw new Error('Nano integer out of range');
  return hexBytes(value.toString(16).padStart(size * 2, '0'), size);
}

function fromBigEndian(bytes: Uint8Array): bigint {
  return bytes.length === 0 ? 0n : BigInt(`0x${upperHex(bytes)}`);
}

function encodeBase32(bytes: Uint8Array, width: number): string {
  let value = fromBigEndian(bytes);
  let text = '';
  for (let i = 0; i < width; i++) {
    text = ALPHABET[Number(value & 31n)]! + text;
    value >>= 5n;
  }
  if (value !== 0n) throw new Error('Nano address value exceeds encoding width');
  return text;
}

function decodeBase32(text: string, size: number): Uint8Array {
  let value = 0n;
  for (const character of text) {
    const digit = ALPHABET.indexOf(character);
    if (digit < 0) throw new Error('Invalid Nano address character');
    value = (value << 5n) | BigInt(digit);
  }
  return toBigEndian(value, size);
}

export function addressFromPublicKey(key: Uint8Array): string {
  if (key.length !== 32) throw new Error('Nano public key must contain 32 bytes');
  return `nano_${encodeBase32(key, 52)}${encodeBase32(blake2bHash(5, key).reverse(), 8)}`;
}

export function canonicalAddress(address: string): string {
  if (typeof address !== 'string' || !/^(?:nano|xrb)_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/.test(address)) {
    throw new Error('Invalid Nano address');
  }
  const encoded = address.slice(address.indexOf('_') + 1);
  const key = decodeBase32(encoded.slice(0, 52), 32);
  if (!equalBytes(decodeBase32(encoded.slice(52), 5), blake2bHash(5, key).reverse())) {
    throw new Error('Invalid Nano address checksum');
  }
  return `nano_${encoded}`;
}

export function addressPublicKey(address: string): Uint8Array {
  return decodeBase32(canonicalAddress(address).slice(5, 57), 32);
}

export function canonicalHash(hash: string): string {
  hexBytes(hash, 32);
  return hash.toUpperCase();
}

export function rawAmount(text: unknown): bigint {
  if (typeof text !== 'string' || !/^(0|[1-9][0-9]{0,38})$/.test(text)) throw new Error('Invalid Nano raw amount');
  const value = BigInt(text);
  if (value > MAX_RAW) throw new Error('Nano raw amount exceeds uint128');
  return value;
}

function textField(fields: Record<string, unknown>, name: string): string {
  if (typeof fields[name] !== 'string') throw new Error(`Missing Nano ${name}`);
  return fields[name];
}

export class NanoStateBlock {
  readonly account: string;
  readonly previous: string;
  readonly representative: string;
  readonly balance: bigint;
  readonly link: string;
  readonly signature: string;
  readonly work: string;
  readonly hash: string;

  constructor(account: string, previous: string, representative: string, balance: bigint,
      link: string, signature: string, work: string) {
    this.account = canonicalAddress(account);
    this.previous = canonicalHash(previous);
    this.representative = canonicalAddress(representative);
    if (typeof balance !== 'bigint' || balance < 0n || balance > MAX_RAW) throw new Error('Invalid Nano raw balance');
    this.balance = balance;
    this.link = canonicalHash(link);
    hexBytes(signature, 64);
    hexBytes(work, 8);
    this.signature = signature.toUpperCase();
    this.work = work.toUpperCase();
    this.hash = upperHex(blake2bHash(32, PREAMBLE, addressPublicKey(this.account),
      hexBytes(this.previous, 32), addressPublicKey(this.representative), toBigEndian(balance, 16), hexBytes(this.link, 32)));
    Object.freeze(this);
  }

  static parse(fields: Record<string, unknown>): NanoStateBlock {
    if (fields.type !== 'state') throw new Error('Expected Nano state block');
    const block = new NanoStateBlock(textField(fields, 'account'), textField(fields, 'previous'),
      textField(fields, 'representative'), rawAmount(fields.balance), textField(fields, 'link'),
      textField(fields, 'signature'), textField(fields, 'work'));
    if (Object.hasOwn(fields, 'link_as_account') &&
        upperHex(addressPublicKey(textField(fields, 'link_as_account'))) !== block.link) {
      throw new Error('Contradictory Nano link address');
    }
    return block;
  }

  static signed(privateKey: Uint8Array, previous: string, representative: string, balance: bigint,
      link: string, work: string): NanoStateBlock {
    const account = addressFromPublicKey(publicKey(privateKey));
    const unsigned = new NanoStateBlock(account, previous, representative, balance, link, '0'.repeat(128), work);
    return new NanoStateBlock(account, previous, representative, balance, link,
      upperHex(sign(privateKey, hexBytes(unsigned.hash, 32))), work);
  }

  validSignature(): boolean {
    return verify(addressPublicKey(this.account), hexBytes(this.hash, 32), hexBytes(this.signature, 64));
  }

  workRoot(): string {
    return this.previous === ZERO_HASH ? upperHex(addressPublicKey(this.account)) : this.previous;
  }

  toWire(): Record<string, string> {
    return { type: 'state', account: this.account, previous: this.previous, representative: this.representative,
      balance: this.balance.toString(), link: this.link, link_as_account: addressFromPublicKey(hexBytes(this.link, 32)), signature: this.signature, work: this.work };
  }
}

export function requiredDifficulty(network: NanoNetwork, epoch: number, receive = false): string {
  if (!Number.isInteger(epoch) || epoch < 0 || epoch > 2) throw new Error('Unsupported Nano epoch');
  if (network === 'nano:dev') return epoch < 2 ? 'FE00000000000000' : receive ? 'F000000000000000' : 'FFC0000000000000';
  if (network === 'nano:mainnet') return epoch < 2 ? 'FFFFFFC000000000' : receive ? 'FFFFFE0000000000' : 'FFFFFFF800000000';
  throw new Error('Unsupported Nano work network');
}

export function strictReceiveDifficulty(network: NanoNetwork): string {
  return requiredDifficulty(network, 0, true);
}

export function validWork(network: NanoNetwork, epoch: number, receive: boolean, root: string, work: string): boolean {
  try {
    const threshold = BigInt(`0x${requiredDifficulty(network, epoch, receive)}`);
    const nonce = hexBytes(work, 8).reverse();
    const difficulty = fromBigEndian(blake2bHash(8, nonce, hexBytes(root, 32)).reverse());
    return difficulty >= threshold;
  } catch {
    return false;
  }
}

const OFFCHAIN_HEADER = hexBytes('184E616E6F204F66662D636861696E204D6573736167653A0A');

export function offchainPayload(message: string): Uint8Array {
  const bytes = new TextEncoder().encode(message);
  if (bytes.length > 0xffff_ffff) throw new Error('NOMS message exceeds uint32 length');
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, bytes.length, false);
  return concatBytes(OFFCHAIN_HEADER, length, bytes);
}

export function offchainDigest(message: string): Uint8Array {
  return blake2bHash(32, offchainPayload(message));
}

export function offchainSign(privateKey: Uint8Array, message: string): Uint8Array {
  return sign(privateKey, offchainDigest(message));
}

export function offchainVerify(key: Uint8Array | string, message: string, signature: Uint8Array | string): boolean {
  try {
    return verify(typeof key === 'string' ? addressPublicKey(key) : key, offchainDigest(message),
      typeof signature === 'string' ? hexBytes(signature, 64) : signature);
  } catch {
    return false;
  }
}
