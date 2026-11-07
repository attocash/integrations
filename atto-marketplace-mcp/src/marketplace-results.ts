import { MarketplaceApiError } from './marketplace-api.js';

export function asRecord(value: unknown): Record<string, unknown> {
  if (value===null || typeof value!=='object' || Array.isArray(value)) throw new MarketplaceApiError('MARKETPLACE_PROTOCOL','Marketplace returned an unexpected response.');
  return value as Record<string,unknown>;
}

export function redact(value: unknown, preserveCredentialId = false): unknown {
  if (Array.isArray(value)) return value.map(item => redact(item, preserveCredentialId));
  if (value && typeof value==='object') {
    return Object.fromEntries(Object.entries(value).filter(([key])=>(preserveCredentialId && (key==='apiKeyId' || key==='targetApiKeyId'))
      || !/(?:access|refresh)?token|apiKey|signature|paymentSignature|paymentPayload|privatePayload/i.test(key))
      .map(([key,item])=>[key,redact(item, preserveCredentialId)]));
  }
  return value;
}
