import { amountOutput, amountRaw } from '../domain/amount.js';
import { AttoError } from '../domain/errors.js';

export const DEFAULT_METRICS_URL = 'https://gatekeeper.live.application.atto.cash/projections/metrics';
const MAX_RESPONSE_BYTES = 1_048_576;
// Projections are dated daily, so accept a UTC metric date at most 72 hours old.
const MAX_PRICE_AGE_MS = 72 * 60 * 60 * 1000;
const RAW_PER_ATTO = 1_000_000_000n;

export interface MarketMetric { name: string; date: string; value: string }
export interface MarketMetrics { metrics: MarketMetric[]; source: string; fetchedAt: string }

function decimal(value: string): { coefficient: bigint; scale: bigint } {
  // Bound parsing work while preserving substantially more precision than RAW.
  if (typeof value !== 'string' || !/^\d{1,40}(?:\.\d{1,40})?$/.test(value)) throw new Error('Invalid decimal');
  const [whole, fraction = ''] = value.split('.');
  return { coefficient: BigInt(`${whole}${fraction}`), scale: 10n ** BigInt(fraction.length) };
}

export class MarketData {
  private readonly source: string;

  constructor(url = DEFAULT_METRICS_URL, private readonly fetchImpl: typeof fetch = fetch) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new AttoError('INVALID_MARKET_URL', 'Market data requires an HTTPS URL without credentials.'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new AttoError('INVALID_MARKET_URL', 'Market data requires an HTTPS URL without credentials.');
    this.source = parsed.href;
  }

  async metrics(signal?: AbortSignal): Promise<MarketMetrics> {
    let payload: unknown;
    try {
      const response = await this.fetchImpl(this.source, {
        signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        redirect: 'error',
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new AttoError('MARKET_DATA_UNAVAILABLE', 'Market data is currently unavailable.', { httpStatus: response.status });
      }
      if (Number(response.headers.get('content-length') ?? 0) > MAX_RESPONSE_BYTES) {
        await response.body.cancel();
        throw new AttoError('MARKET_DATA_INVALID', 'The market-data response exceeds the supported size.');
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new AttoError('MARKET_DATA_INVALID', 'The market-data response exceeds the supported size.');
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw new AttoError('MARKET_DATA_INVALID', 'The market-data response is not valid JSON.'); }
    } catch (error) {
      if (error instanceof AttoError) throw error;
      throw new AttoError('MARKET_DATA_UNAVAILABLE', 'Market data could not be retrieved within ten seconds.');
    }
    if (!payload || typeof payload !== 'object' || !('metrics' in payload) || !Array.isArray(payload.metrics)) {
      throw new AttoError('MARKET_DATA_INVALID', 'The market-data response must contain a metrics array.');
    }
    const metrics: MarketMetric[] = payload.metrics.map((metric: unknown) => {
      if (!metric || typeof metric !== 'object' || !('name' in metric) || typeof metric.name !== 'string'
        || !('date' in metric) || typeof metric.date !== 'string' || !('value' in metric) || typeof metric.value !== 'string') {
        throw new AttoError('MARKET_DATA_INVALID', 'Each market metric requires a name, date, and string value.');
      }
      return { name: metric.name, date: metric.date, value: metric.value };
    });
    return { metrics, source: this.source, fetchedAt: new Date().toISOString() };
  }

  async quoteUsd(amount: string, signal?: AbortSignal) {
    let usd: ReturnType<typeof decimal>;
    try {
      usd = decimal(amount);
      if (usd.coefficient <= 0n) throw new Error();
    } catch { throw new AttoError('INVALID_USD_AMOUNT', 'USD amount must be a positive decimal string with at most 40 digits on either side of the decimal point.'); }
    const snapshot = await this.metrics(signal);
    const prices = snapshot.metrics.filter((metric) => metric.name === 'price.usd');
    const price = prices[0];
    if (prices.length !== 1 || !price) throw new AttoError('INVALID_PRICE', 'Market data must contain exactly one USD price.');
    let ratio: ReturnType<typeof decimal>;
    try {
      ratio = decimal(price.value);
      if (ratio.coefficient <= 0n) throw new Error();
    } catch { throw new AttoError('INVALID_PRICE', 'The USD price must be a positive decimal string.'); }
    const priceTime = Date.parse(`${price.date}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(price.date) || !Number.isFinite(priceTime) || new Date(priceTime).toISOString().slice(0, 10) !== price.date) {
      throw new AttoError('INVALID_PRICE', 'The USD price requires a valid UTC calendar date.');
    }
    const age = Date.parse(snapshot.fetchedAt) - priceTime;
    if (age < 0) throw new AttoError('PRICE_FUTURE', 'The USD price has a future date.');
    if (age > MAX_PRICE_AGE_MS) throw new AttoError('PRICE_STALE', 'The daily USD price is more than 72 hours old.');
    const raw = usd.coefficient * ratio.scale * RAW_PER_ATTO / (usd.scale * ratio.coefficient);
    if (raw === 0n) throw new AttoError('INVALID_USD_AMOUNT', 'The USD amount converts to less than 1 RAW.');
    let converted: string;
    try { converted = amountRaw(raw.toString(), 'RAW'); }
    catch { throw new AttoError('INVALID_USD_AMOUNT', 'The USD amount converts to more than the Atto amount range allows.'); }
    return {
      usd: amount,
      priceUsd: price.value,
      priceDate: price.date,
      source: snapshot.source,
      fetchedAt: snapshot.fetchedAt,
      amount: amountOutput(converted),
      informational: true as const,
    };
  }
}
