import { z } from 'zod';
import { amountRaw } from '../domain/amount.js';

export const paymentMetadataSchema = z.record(z.string().min(1).max(128), z.json()).superRefine((metadata, context) => {
  let nodes = 0;
  const bounded = (value: unknown, depth: number): boolean => {
    if (++nodes > 256 || depth > 5) return false;
    if (value !== null && typeof value === 'object') return Object.values(value).every(child => bounded(child, depth + 1));
    return true;
  };
  if (!bounded(metadata, 0) || Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 4096) {
    context.addIssue({ code: 'custom', message: 'Payment metadata must fit 4096 bytes, 256 values, and five nesting levels.' });
  }
});

export type PaymentMetadata = z.infer<typeof paymentMetadataSchema>;
export type PaymentStepStatus = 'planned' | 'signed' | 'published' | 'unknown' | 'failed';

export interface ConsolidationStep {
  id: string;
  kind: 'send' | 'receive';
  index: number;
  sourceAddress: string;
  destination: string;
  raw: string;
  sourceStepId?: string;
  status: PaymentStepStatus;
  hash?: string;
  blockJson?: string;
  result?: unknown;
  publishedAt?: number;
}

export interface PaymentPlan {
  indexes: number[];
  steps: ConsolidationStep[];
}

/** Check durable structure here; the payment engine verifies derived addresses
 * and the exact transaction content again before each signature. */
export function validatePaymentPlan(plan: PaymentPlan, parent: { index: number; sourceAddress?: string }): void {
  if (!plan || !Array.isArray(plan.indexes) || plan.indexes.length < 1 || plan.indexes.length > 100
    || plan.indexes.some(index => !Number.isSafeInteger(index) || index < 0 || index > 0x7fff_ffff)
    || new Set(plan.indexes).size !== plan.indexes.length || !plan.indexes.includes(parent.index)
    || !Array.isArray(plan.steps) || plan.steps.length > 200 || !parent.sourceAddress) throw new Error('Invalid payment plan.');
  const steps = new Map<string, ConsolidationStep>();
  const received = new Set<string>();
  const accountAddresses = new Map<number, string>([[parent.index, parent.sourceAddress]]);
  let sentRaw = 0n;
  let receivedRaw = 0n;
  let unfinished = false;
  for (const step of plan.steps) {
    if (!step || typeof step.id !== 'string' || !step.id || step.id.length > 200 || steps.has(step.id)
      || !['send', 'receive'].includes(step.kind) || !plan.indexes.includes(step.index)
      || typeof step.sourceAddress !== 'string' || !step.sourceAddress || step.sourceAddress.length > 128
      || step.destination !== parent.sourceAddress || amountRaw(step.raw, 'RAW') !== step.raw
      || !['planned', 'signed', 'published', 'unknown', 'failed'].includes(step.status)) throw new Error('Invalid consolidation step.');
    if (accountAddresses.has(step.index) && accountAddresses.get(step.index) !== step.sourceAddress) throw new Error('Inconsistent step account.');
    accountAddresses.set(step.index, step.sourceAddress);
    if (step.hash !== undefined && (typeof step.hash !== 'string' || !step.hash || typeof step.blockJson !== 'string' || !step.blockJson)) throw new Error('Invalid recorded step.');
    if (['signed', 'published', 'unknown'].includes(step.status) && !step.hash) throw new Error('Missing step block.');
    if (step.status === 'planned' && step.hash !== undefined) throw new Error('Planned step already has a block.');
    if (unfinished && step.status !== 'planned') throw new Error('Consolidation steps advanced out of order.');
    if (step.status !== 'published') unfinished = true;
    if (step.status === 'published' && (!Number.isSafeInteger(step.publishedAt) || (step.publishedAt ?? -1) < 0)) throw new Error('Invalid publication timestamp.');
    if (step.kind === 'send') {
      if (step.index === parent.index || step.sourceAddress === parent.sourceAddress || step.sourceStepId !== undefined) throw new Error('Invalid consolidation source.');
      sentRaw += BigInt(step.raw);
    } else {
      const source = step.sourceStepId === undefined ? undefined : steps.get(step.sourceStepId);
      if (!source || source.kind !== 'send' || received.has(source.id) || source.raw !== step.raw
        || source.destination !== step.destination || step.index !== parent.index || step.sourceAddress !== parent.sourceAddress) throw new Error('Invalid consolidation receipt.');
      received.add(source.id);
      receivedRaw += BigInt(step.raw);
    }
    steps.set(step.id, step);
  }
  if (sentRaw !== receivedRaw || [...steps.values()].some(step => step.kind === 'send' && !received.has(step.id))) throw new Error('Incomplete consolidation plan.');
}
