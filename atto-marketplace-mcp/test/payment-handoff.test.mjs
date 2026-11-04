import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createXnoPaymentRequest, parseXnoPaymentRequest, parseXnoPaymentResponse } from '../dist/payment-handoff.js';

const requestId = '11111111-1111-4111-8111-111111111111';
const intentId = '22222222-2222-4222-8222-222222222222';
const accountId = '33333333-3333-4333-8333-333333333333';
const handoffId = 'a'.repeat(32);
const expiresAt = '2026-10-01T00:00:00Z';
const signedDeadline = expiresAt;
const paymentIdentifier = requestId;
const payer = 'nano_1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const destination = 'nano_3igf8hd4sjshoibbbkeitmgkp1o6ug4xads43j6e4gqkj5xk5o83j8ja9php';
const sendHash = 'A'.repeat(64);
const paymentRequiredValue = {
  x402Version: 2,
  resource: { url: `https://marketplace.example/v1/agent/topups/${intentId}`, description: 'Fund this marketplace account', mimeType: 'application/json' },
  accepts: [{ scheme: 'exact', network: 'nano:dev', amount: '900719925474099312345', asset: 'XNO', payTo: destination,
    maxTimeoutSeconds: 300, extra: { assetTransferMethod: 'native-state', paymentFlow: 'upfront' } }],
  extensions: { 'payment-identifier': { info: { required: true }, schema: { type: 'object', properties: { id: { type: 'string' } } } } },
};
const paymentRequired = encode(paymentRequiredValue);
const paymentRequiredSha256 = sha256(Buffer.from(paymentRequired, 'base64'));

function makeRequest(overrides = {}) {
  return createXnoPaymentRequest({
    version: 1,
    type: 'marketplace-x402-payment-request',
    handoffId,
    origin: 'https://marketplace.example',
    audience: 'marketplace-agent-api',
    accountId,
    asset: 'XNO',
    network: 'nano:dev',
    amountAtomic: '900719925474099312345',
    requestId,
    paymentIdentifier,
    intentId,
    resourceUrl: `https://marketplace.example/v1/agent/topups/${intentId}`,
    expiresAt,
    paymentRequired,
    ...overrides,
  });
}

function makeResponse(request, overrides = {}) {
  const requirement = JSON.parse(Buffer.from(request.paymentRequired, 'base64'));
  const extensions = structuredClone(requirement.extensions ?? {});
  if (extensions['payment-identifier']) extensions['payment-identifier'].info.id = request.paymentIdentifier;
  if (extensions['marketplace-account-binding']) extensions['marketplace-account-binding'].info.bindingSignature = 'B'.repeat(128);
  const payload = {
    x402Version: 2,
    resource: requirement.resource,
    accepted: requirement.accepts[0],
    payload: {
      block: { type: 'state', account: payer, previous: 'C'.repeat(64), representative: payer,
        balance: '1', link_as_account: requirement.accepts[0].payTo, link: 'C1CD33D62CC72FAC1294C990D4DD2B02A4DB85D42F220C48C13AF288FB21D4C1', signature: 'E'.repeat(128), work: 'F'.repeat(16) },
    },
    ...(Object.keys(extensions).length ? { extensions } : {}),
  };
  return {
    version: 1,
    type: 'marketplace-x402-payment-response',
    handoffId: request.handoffId,
    requestSha256: request.requestSha256,
    intentId: request.intentId,
    requestId: request.requestId,
    accountId: request.accountId,
    asset: request.asset,
    network: request.network,
    amountAtomic: request.amountAtomic,
    origin: request.origin,
    paymentIdentifier: request.paymentIdentifier,
    resourceUrl: request.resourceUrl,
    paymentRequiredSha256: request.paymentRequiredSha256,
    sendHash,
    payer,
    signedDeadline,
    paymentSignature: encode(payload),
    ...overrides,
  };
}

test('versioned XNO request preserves exact challenge bytes and raw atomic strings', () => {
  // Given the exact Base64 PAYMENT-REQUIRED bytes returned by Marketplace.
  const request = makeRequest();

  // When another process loads the immutable request contract.
  const parsed = parseXnoPaymentRequest(JSON.parse(JSON.stringify(request)), Date.parse('2026-09-30T12:00:00Z'));

  // Then the digest covers the exact decoded bytes, audience, account, amount, and intent resource.
  assert.equal(parsed.paymentRequired, paymentRequired);
  assert.equal(parsed.paymentRequiredSha256, paymentRequiredSha256);
  assert.equal(parsed.paymentRequiredSha256, 'a870f3d9dc41c638af28023fed6aeddb35bf5e04be32ae474e823795cdc29e08');
  assert.equal(parsed.requestSha256, '4cd255424fe8b16a0f382af6b543b1c17523463bd18267beccbc325683f6f155');
  assert.equal(parsed.amountAtomic, '900719925474099312345');
  assert.equal(parsed.requestSha256, request.requestSha256);
  assert.throws(() => parseXnoPaymentRequest({ ...request, audience: 'another-audience' }, Date.parse('2026-09-30T12:00:00Z')));
  assert.throws(() => parseXnoPaymentRequest({ ...request, accountId: '44444444-4444-4444-8444-444444444444' }, Date.parse('2026-09-30T12:00:00Z')));
  assert.throws(() => parseXnoPaymentRequest({ ...request, amountAtomic: '900719925474099312346' }, Date.parse('2026-09-30T12:00:00Z')));
  assert.throws(() => parseXnoPaymentRequest({ ...request, resourceUrl: 'https://attacker.example/collect' }, Date.parse('2026-09-30T12:00:00Z')));
  assert.throws(() => parseXnoPaymentRequest({ ...request, paymentRequiredSha256: '0'.repeat(64) }, Date.parse('2026-09-30T12:00:00Z')));
});

test('MCP handoff accepts a base Nano offer without extras or extensions and optional work support', () => {
  for (const extra of [undefined, {}, { workOptional: true }, { workOptional: false }]) {
    const requirement = structuredClone(paymentRequiredValue);
    delete requirement.extensions;
    delete requirement.accepts[0].extra;
    if (extra !== undefined) requirement.accepts[0].extra = extra;
    const request = makeRequest({ paymentRequired: encode(requirement) });
    const response = makeResponse(request);
    assert.equal(parseXnoPaymentResponse(response, request, handoffId, Date.parse('2026-09-30T12:00:00Z')).paymentSignature, response.paymentSignature);
    assert.deepEqual(Object.keys(JSON.parse(Buffer.from(response.paymentSignature, 'base64')).payload), ['block']);
  }
});

test('MCP handoff pins offered account binding authority, schema and response metadata', () => {
  const requirement = structuredClone(paymentRequiredValue);
  requirement.extensions['marketplace-account-binding'] = { info: { required: true, version: 1,
    domain: 'marketplace.nano.exact.state.v1', accountId, intentId, paymentIdentifier, intentExpiresAt: expiresAt },
    schema: { type: 'object', properties: { bindingSignature: { type: 'string' } } } };
  const request = makeRequest({ paymentRequired: encode(requirement) }), response = makeResponse(request);
  const validNow = Date.parse('2026-09-30T12:00:00Z');
  assert.equal(parseXnoPaymentResponse(response, request, handoffId, validNow).sendHash, sendHash);
  for (const mutate of [
    value => { delete value.extensions['marketplace-account-binding']; },
    value => { value.extensions['marketplace-account-binding'].info.accountId = intentId; },
    value => { value.extensions['marketplace-account-binding'].schema = {}; },
    value => { value.extensions['marketplace-account-binding'].info.bindingSignature = 'invalid'; },
    value => { value.payload.signedDeadline = signedDeadline; },
    value => { value.payload.block.link_as_account = payer; },
    value => { value.payload.block.link = 'D'.repeat(64); },
  ]) {
    const envelope = JSON.parse(Buffer.from(response.paymentSignature, 'base64')); mutate(envelope);
    assert.throws(() => parseXnoPaymentResponse({ ...response, paymentSignature: encode(envelope) }, request, handoffId, validNow));
  }
  for (const [field, value] of Object.entries({ accountId: intentId, intentId: accountId, paymentIdentifier: 'foreign-id',
    intentExpiresAt: '2026-10-02T00:00:00Z', domain: 'foreign-domain', version: 2, required: false, bindingSignature: 'B'.repeat(128) })) {
    const altered = structuredClone(requirement); altered.extensions['marketplace-account-binding'].info[field] = value;
    assert.throws(() => makeRequest({ paymentRequired: encode(altered) }));
  }
});

test('versioned XNO payer response is bound to one request and exact x402 payload', () => {
  // Given a valid immutable request and the exact x402 v2 PAYMENT-SIGNATURE header bytes.
  const request = makeRequest();
  const response = makeResponse(request);

  // When the Marketplace MCP imports the response for that opaque handle.
  const parsed = parseXnoPaymentResponse(response, request, handoffId, Date.parse('2026-09-30T12:00:00Z'));

  // Then the original payment header, SEND identity, and request digest remain available for exact replay.
  assert.equal(parsed.paymentSignature, response.paymentSignature);
  assert.equal(sha256(parsed.paymentSignature), '8911f33f2bf1be47735cbcd8e64074a1467ff64235e61ec9bff68e629e1dd85b');
  assert.equal(parsed.sendHash, sendHash);
  assert.equal(parsed.payer, payer);
  assert.equal(parsed.requestSha256, request.requestSha256);
});

test('XNO response rejects changed identity fields, expired deadlines, and altered payment binding', () => {
  // Given one immutable Marketplace challenge and a structurally valid Nano payload.
  const request = makeRequest();
  const response = makeResponse(request);
  const validNow = Date.parse('2026-09-30T12:00:00Z');

  // When a payer response changes any request identity or the signed payload binding.
  for (const altered of [
    { handoffId: 'b'.repeat(32) },
    { requestSha256: '0'.repeat(64) },
    { intentId: '44444444-4444-4444-8444-444444444444' },
    { requestId: '44444444-4444-4444-8444-444444444444' },
    { accountId: '44444444-4444-4444-8444-444444444444' },
    { amountAtomic: '1' },
    { origin: 'https://other.example' },
    { paymentIdentifier: 'different-payment-identifier' },
    { resourceUrl: 'https://marketplace.example/v1/agent/topups/other' },
    { paymentRequiredSha256: '0'.repeat(64) },
    { payer: 'nano_1cccccccccccccccccccccccccccccccccccccccccccccccccccc' },
    { signedDeadline: '2026-10-01T00:00:01Z' },
  ]) assert.throws(() => parseXnoPaymentResponse({ ...response, ...altered }, request, handoffId, validNow));

  const alteredPayload = JSON.parse(Buffer.from(response.paymentSignature, 'base64').toString('utf8'));
  alteredPayload.extensions['payment-identifier'].info.id = 'another-payment-identifier';
  assert.throws(() => parseXnoPaymentResponse({ ...response, paymentSignature: encode(alteredPayload) }, request, handoffId, validNow));
  assert.throws(() => parseXnoPaymentResponse(response, request, 'b'.repeat(32), validNow));
  assert.throws(() => parseXnoPaymentResponse(response, request, handoffId, Date.parse('2026-10-01T00:00:00Z')));
});

test('XNO challenge rejects a changed destination even if the top-level request remains unchanged', () => {
  // Given a Marketplace request with an immutable account deposit destination.
  const changedRequirement = structuredClone(paymentRequiredValue);
  changedRequirement.accepts[0].payTo = 'nano_1cccccccccccccccccccccccccccccccccccccccccccccccccccc';

  // When the challenge body changes but its saved byte digest does not.
  const changedBytes = Buffer.from(JSON.stringify(changedRequirement));
  const altered = { ...makeRequest(), paymentRequired: changedBytes.toString('base64') };

  // Then request parsing rejects the changed challenge before any payer can sign it.
  assert.throws(() => parseXnoPaymentRequest(altered, Date.parse('2026-09-30T12:00:00Z')));
});

function encode(value) { return Buffer.from(JSON.stringify(value)).toString('base64'); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
