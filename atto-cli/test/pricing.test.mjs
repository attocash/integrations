import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketData, DEFAULT_METRICS_URL } from '../dist/pricing/market.js';
import { marketTerms } from '../dist/pricing/terms.js';

const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const dateOffset = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
const metric = (overrides = {}) => ({ name: 'price.usd', date: today(), value: '0.00003594', ...overrides });
const client = (metrics) => new MarketData(DEFAULT_METRICS_URL, async () => Response.json({ metrics }));

test('USD conversion floors exactly at the published sample price', async () => {
  // Given
  const market = client([metric()]);

  // When
  const quote = await market.quoteUsd('1');

  // Then
  assert.equal(quote.amount.raw, '27824151363383');
  assert.equal(quote.amount.atto, '27824.151363383');
  assert.equal(quote.priceUsd, '0.00003594');
  assert.equal(quote.priceDate, today());
  assert.equal(quote.source, DEFAULT_METRICS_URL);
  assert.equal(quote.informational, true);
  assert.ok(Number.isFinite(Date.parse(quote.fetchedAt)));
  const raw = BigInt(quote.amount.raw);
  assert.ok(raw * 3594n <= 100_000_000_000_000_000n);
  assert.ok((raw + 1n) * 3594n > 100_000_000_000_000_000n);
});

test('USD conversion preserves decimal and integer precision', async () => {
  // Given
  const market = client([metric({ value: '1000000000' })]);
  const fractional = client([metric({ value: '0.1000000000000000000000000000000000000001' })]);

  // When
  const largeQuote = await market.quoteUsd('9007199254740993');
  const fractionQuote = await fractional.quoteUsd('0.1');

  // Then
  assert.equal(largeQuote.amount.raw, '9007199254740993');
  assert.equal(fractionQuote.amount.raw, '999999999');
});

test('metrics return public data with source and freshness metadata and omit credentials', async () => {
  // Given
  const expected = [metric(), { name: 'accounts.count', date: today(), value: '42' }];
  let called;
  const market = new MarketData(DEFAULT_METRICS_URL, async (url, options) => { called = { url, options }; return Response.json({ metrics: expected }); });

  // When
  const result = await market.metrics();

  // Then
  assert.deepEqual(result.metrics, expected);
  assert.equal(result.source, DEFAULT_METRICS_URL);
  assert.equal(called.options.credentials, 'omit');
  assert.equal(called.options.redirect, 'error');
  assert.equal(called.options.signal.aborted, false);
  assert.equal(called.options.headers.Authorization, undefined);
});

test('quotes reject missing, duplicate, malformed, and zero prices', async () => {
  // Given
  const cases = [[], [metric(), metric()], [metric({ value: '0' })], [metric({ value: '-1' })],
    [metric({ value: '1e-4' })], [metric({ value: 'NaN' })], [metric({ date: '2026-02-30' })],
    [metric({ date: `${today()}T00:00:00Z` })]];

  // When / Then
  for (const metrics of cases) await assert.rejects(client(metrics).quoteUsd('1'), { code: 'INVALID_PRICE' });
});

test('quotes reject stale and future daily prices', async () => {
  // Given
  const stale = client([metric({ date: dateOffset(-4) })]);
  const future = client([metric({ date: dateOffset(1) })]);

  // When / Then
  await assert.rejects(stale.quoteUsd('1'), { code: 'PRICE_STALE' });
  await assert.rejects(future.quoteUsd('1'), { code: 'PRICE_FUTURE' });
});

test('invalid USD amounts and conversions outside RAW range fail', async () => {
  // Given
  const market = client([metric({ value: '1' })]);

  // When / Then
  for (const amount of ['0', '-1', 'NaN', '1e3', '1.00000000000000000000000000000000000000001', '0.0000000001', '18446744073709551616']) {
    await assert.rejects(market.quoteUsd(amount), { code: 'INVALID_USD_AMOUNT' });
  }
});

test('malformed and oversized market responses fail within the bounded reader', async () => {
  // Given
  const responses = [Response.json({}), Response.json({ metrics: [metric({ value: 1 })] }), new Response('invalid json'),
    new Response(' '.repeat(1_048_577)), new Response('{}', { headers: { 'content-length': '1048577' } })];

  // When / Then
  for (const response of responses) {
    await assert.rejects(new MarketData(DEFAULT_METRICS_URL, async () => response).metrics(), { code: 'MARKET_DATA_INVALID' });
  }
});

test('network errors and endpoint credentials are rejected without exposing diagnostics', async () => {
  // Given
  const failing = new MarketData(DEFAULT_METRICS_URL, async () => { throw new Error('private dependency diagnostic'); });
  const unavailable = new MarketData(DEFAULT_METRICS_URL, async () => new Response('no', { status: 503 }));

  // When / Then
  await assert.rejects(failing.metrics(), (error) => error.code === 'MARKET_DATA_UNAVAILABLE' && !error.message.includes('private dependency diagnostic'));
  await assert.rejects(unavailable.metrics(), { code: 'MARKET_DATA_UNAVAILABLE' });
  assert.throws(() => new MarketData('https://user:secret@example.test/'), { code: 'INVALID_MARKET_URL' });
  assert.throws(() => new MarketData('http://example.test/'), { code: 'INVALID_MARKET_URL' });
});

test('market acknowledgement identifies dated indicative conversion and self-custody', () => {
  // Given / When
  const terms = marketTerms;

  // Then
  assert.equal(terms.version, '2026-09-05');
  assert.match(terms.text, /daily/);
  assert.match(terms.text, /transactions send ATTO, not USD/);
  assert.match(terms.text, /self-custody/);
  assert.match(terms.text, /not financial/);
});
