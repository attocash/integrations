import type { PaymentMetadata } from '../spending/journal.js';

export type NetworkName = 'LIVE' | 'BETA' | 'DEV' | 'LOCAL';
export type AmountUnit = 'ATTO' | 'RAW';
export interface SpendingRule { days: number; amount: string; unit: AmountUnit }
export interface SpendingPolicy {
  perRequest: { amount: string; unit: AmountUnit } | null;
  rolling: SpendingRule[];
}
export interface AccountPool { indexes: number[]; consolidate: boolean }
export interface WalletSettings {
  network: NetworkName;
  nodeUrl: string;
  workerUrl: string;
  representative: string;
  autoReceive: boolean;
  minReceiveRaw: string;
}
export interface WalletAddress { index: number; address: string; publicKey: string; active: boolean }
export interface WalletIdentity { fingerprint: string; address: string }
export type EventKind = 'account' | 'transaction' | 'entry' | 'receivable';
export interface StreamFilter {
  event: EventKind;
  addresses?: string[];
  hash?: string;
  fromHeight?: string;
  toHeight?: string;
  minAmountRaw?: string;
}
export interface ListRequest extends StreamFilter { limit?: number; timeoutMs?: number; cursor?: string }
export interface SendRequest { index?: number; destination?: string; destinationLabel?: string; amount: string; unit?: AmountUnit | 'USD'; requestId: string; metadata?: PaymentMetadata }
export interface ReceiveRequest { index?: number; hash: string; representative?: string }
