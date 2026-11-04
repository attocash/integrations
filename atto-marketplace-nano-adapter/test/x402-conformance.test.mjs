import assert from 'node:assert/strict';
import test from 'node:test';
import { addressFromPublicKey, addressPublicKey, hexBytes, NanoStateBlock, publicKey, upperHex, validWork, verify } from '../dist/protocol.js';
import { canonical, sha256 } from '../dist/configuration.js';
import { ACCOUNT_BINDING, buildPaymentResponse, parsePaymentRequest, paymentBinding, validatePaymentResponse } from '../dist/handoff.js';

const key = hexBytes('01'.repeat(32));
const payer = addressFromPublicKey(publicKey(key));
const destination = addressFromPublicKey(publicKey(hexBytes('02'.repeat(32))));
const now = Date.parse('2026-11-02T12:00:00Z');
const config = { origin: 'https://marketplace.example', audience: 'marketplace', network: 'nano:dev', sourceAddress: payer,
  limits: { maxPaymentAtomic: '100', rolling24hAtomic: '100' } };

function fixture({ extra, binding = false, identifier = false, metadata = false, whitespace = false } = {}) {
  const raw = { version: 1, type: 'marketplace-x402-payment-request', handoffId: 'a'.repeat(32),
    origin: config.origin, audience: config.audience, accountId: '11111111-1111-4111-8111-111111111111', asset: 'XNO', network: config.network,
    amountAtomic: '40', requestId: '22222222-2222-4222-8222-222222222222', paymentIdentifier: '22222222-2222-4222-8222-222222222222',
    intentId: '33333333-3333-4333-8333-333333333333', expiresAt: '2026-11-02T12:05:00Z' };
  raw.resourceUrl = `${raw.origin}/v1/agent/topups/${raw.intentId}`;
  const challenge = { x402Version: 2, resource: { url: raw.resourceUrl }, accepts: [{ scheme: 'exact', network: config.network,
    asset: 'XNO', amount: raw.amountAtomic, payTo: destination, maxTimeoutSeconds: 1, ...(extra === undefined ? {} : { extra }) }] };
  const extensions = {};
  if (binding) extensions[ACCOUNT_BINDING] = { info: { required: true, version: 1, domain: 'marketplace.nano.exact.state.v1',
    accountId: raw.accountId, intentId: raw.intentId, paymentIdentifier: raw.paymentIdentifier, intentExpiresAt: raw.expiresAt },
    schema: { type: 'object', properties: { bindingSignature: { type: 'string', pattern: '^[A-F0-9]{128}$' } } } };
  if (identifier) extensions['payment-identifier'] = { info: { required: true, order: 'order-123' }, schema: { type: 'object' } };
  if (metadata) extensions['merchant-data'] = { info: { order: 123 }, schema: { type: 'object' } };
  if (Object.keys(extensions).length) challenge.extensions = extensions;
  function encode() {
    const bytes = Buffer.from(JSON.stringify(challenge, null, whitespace ? 2 : undefined));
    raw.paymentRequired = bytes.toString('base64'); raw.paymentRequiredSha256 = sha256(bytes);
    delete raw.requestSha256; raw.requestSha256 = sha256(canonical(raw));
    return parsePaymentRequest(raw, config, now);
  }
  return { raw, challenge, encode };
}

let work;
for (let nonce = 0n; work === undefined; nonce++) {
  const candidate = nonce.toString(16).padStart(16, '0');
  if (validWork('nano:dev', 2, false, 'A'.repeat(64), candidate)) work = candidate;
}
const block = NanoStateBlock.signed(key, 'A'.repeat(64), payer, 960n, upperHex(addressPublicKey(destination)), work);
function prepare(f) { const request = f.encode(); return { request, response: buildPaymentResponse(request, block, f.raw.expiresAt, key) }; }
function decode(response) { return JSON.parse(Buffer.from(response.paymentSignature, 'base64')); }
function changed(response, change) { const envelope = decode(response); change(envelope); return { ...response, paymentSignature: Buffer.from(JSON.stringify(envelope)).toString('base64') }; }

test('base Nano draft offer requires no private extras or extensions and preserves native signed identity', () => {
  for (const extra of [undefined, {}, { workOptional: true }, { workOptional: false }]) {
    const f = fixture({ extra }), { request, response } = prepare(f), envelope = decode(response);
    assert.deepEqual(Object.keys(envelope.payload), ['block']);
    assert.equal(envelope.extensions, undefined);
    assert.equal(envelope.accepted.asset, 'XNO');
    assert.equal(envelope.payload.block.link_as_account, destination);
    assert.equal(response.signedDeadline, f.raw.expiresAt, 'confirmation budget does not become native expiration');
    assert.deepEqual(envelope.payload.block, block.toWire());
    assert.equal(validatePaymentResponse(response, request, config, 1000n, 2).hash, block.hash);
    assert.equal(envelope.payload.block.signature, block.signature);
    assert.equal(envelope.payload.block.work, block.work);
  }
});

test('offered account binding signs exact challenge bytes and retains all metadata outside payload', () => {
  const f = fixture({ binding: true, identifier: true, metadata: true, whitespace: true });
  const { request, response } = prepare(f), envelope = decode(response);
  const offered = f.challenge.extensions[ACCOUNT_BINDING], actual = envelope.extensions[ACCOUNT_BINDING];
  assert.deepEqual(actual.schema, offered.schema);
  const { bindingSignature, ...info } = actual.info;
  assert.deepEqual(info, offered.info);
  assert.equal(verify(addressPublicKey(payer), paymentBinding(request, block.hash, f.raw.expiresAt), hexBytes(bindingSignature, 64)), true);
  assert.equal(envelope.extensions['payment-identifier'].info.order, 'order-123');
  assert.deepEqual(envelope.extensions['merchant-data'], f.challenge.extensions['merchant-data']);
  assert.deepEqual(Object.keys(envelope.payload), ['block']);
  assert.equal(validatePaymentResponse(response, request, config, 1000n, 2).hash, block.hash);
});

test('account binding rejects changes to authority, schema, signature, native bytes and challenge bytes', () => {
  const f = fixture({ binding: true, identifier: true }), { request, response } = prepare(f);
  for (const mutate of [
    value => { delete value.extensions[ACCOUNT_BINDING]; },
    value => { value.extensions[ACCOUNT_BINDING].info.accountId = '44444444-4444-4444-8444-444444444444'; },
    value => { value.extensions[ACCOUNT_BINDING].info.intentExpiresAt = '2026-11-02T12:06:00Z'; },
    value => { value.extensions[ACCOUNT_BINDING].schema = {}; },
    value => { value.extensions[ACCOUNT_BINDING].info.bindingSignature = '0'.repeat(128); },
    value => { value.payload.block.balance = '959'; },
    value => { value.payload.block.signature = '0'.repeat(128); },
    value => { value.payload.block.work = '0'.repeat(16); },
    value => { value.payload.block.link_as_account = payer; },
    value => { delete value.payload.block.link_as_account; },
    value => { value.payload.send = value.payload.block; delete value.payload.block; },
    value => { value.payload.mechanismVersion = 'marketplace-nano-exact-state-v1'; },
  ]) assert.throws(() => validatePaymentResponse(changed(response, mutate), request, config, 1000n, 2));
  const original = request.challengeText;
  request.challengeText = `${original}\n`;
  assert.throws(() => validatePaymentResponse(response, request, config, 1000n, 2), { code: 'JOURNAL_CONFLICT' });
});

test('offered binding must match private intent authority before any second signature is issued', () => {
  for (const [field, value] of Object.entries({ accountId: '44444444-4444-4444-8444-444444444444', intentId: '44444444-4444-4444-8444-444444444444',
    paymentIdentifier: 'another-identifier', intentExpiresAt: '2026-11-02T12:06:00Z', version: 2, domain: 'another-domain', required: false,
    bindingSignature: 'A'.repeat(128) })) {
    const f = fixture({ binding: true }); f.challenge.extensions[ACCOUNT_BINDING].info[field] = value;
    assert.throws(() => f.encode(), { code: 'INVALID_REQUEST' });
  }
  for (const mutate of [value => { value.accepts[0].asset = 'xno'; }, value => { value.accepts[0].network = 'nano:main'; },
    value => { value.accepts[0].extra = { workOptional: 'true' }; }]) {
    const f = fixture(); mutate(f.challenge); assert.throws(() => f.encode(), { code: 'INVALID_REQUEST' });
  }
});
