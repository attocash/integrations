import type { AttoAccount } from '@attocash/commons-core';
import { AttoError } from '../domain/errors.js';
import type { WalletAddress } from '../wallet/types.js';
import type { ConsolidationStep, PaymentPlan } from './ledger.js';

export interface PoolAccount {
  address: WalletAddress;
  account: AttoAccount;
  workReady: boolean;
}

/** Prefer a single debit; otherwise move only the shortfall from the fewest donors. */
export function planPayment(accounts: readonly PoolAccount[], raw: string, consolidate: boolean): { source: PoolAccount; plan: PaymentPlan } {
  const amount = BigInt(raw);
  const byBalance = (a: PoolAccount, b: PoolAccount) => {
    const left = BigInt(a.account.balance.toString());
    const right = BigInt(b.account.balance.toString());
    return left === right ? a.address.index - b.address.index : left > right ? -1 : 1;
  };
  const funded = accounts.filter(candidate => BigInt(candidate.account.balance.toString()) >= amount)
    .sort((a, b) => Number(b.workReady) - Number(a.workReady) || byBalance(a, b));
  if (funded[0]) return { source: funded[0], plan: { indexes: [funded[0].address.index], steps: [] } };

  const ordered = [...accounts].filter(candidate => BigInt(candidate.account.balance.toString()) > 0n).sort(byBalance);
  if (ordered.reduce((sum, candidate) => sum + BigInt(candidate.account.balance.toString()), 0n) < amount) {
    throw new AttoError('INSUFFICIENT_BALANCE', 'The available source accounts cannot cover this payment.');
  }
  if (!consolidate) throw new AttoError('CONSOLIDATION_REQUIRED', 'The pool has enough funds across accounts. Approve consolidation or fund one account before sending.');

  const source = ordered[0]!;
  let missing = amount - BigInt(source.account.balance.toString());
  const indexes = [source.address.index];
  const steps: ConsolidationStep[] = [];
  for (const donor of ordered.slice(1)) {
    if (missing === 0n) break;
    const balance = BigInt(donor.account.balance.toString());
    const transfer = balance < missing ? balance : missing;
    const id = `consolidate-${donor.address.index}`;
    indexes.push(donor.address.index);
    steps.push({ id, kind: 'send', index: donor.address.index, sourceAddress: donor.address.address,
      destination: source.address.address, raw: transfer.toString(), status: 'planned' });
    steps.push({ id: `${id}-receive`, kind: 'receive', index: source.address.index, sourceAddress: source.address.address,
      destination: source.address.address, raw: transfer.toString(), sourceStepId: id, status: 'planned' });
    missing -= transfer;
  }
  return { source, plan: { indexes: indexes.sort((a, b) => a - b), steps } };
}
