import { AttoAmount, AttoUnit } from '@attocash/commons-core';
import { AttoError } from './errors.js';
import type { AmountUnit } from '../wallet/types.js';

export function amountRaw(value: string, unit: AmountUnit = 'ATTO', allowZero = false): string {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value) || !['ATTO', 'RAW'].includes(unit)) {
    throw new AttoError('INVALID_AMOUNT', 'Use a nonnegative decimal string with an ATTO or RAW unit.');
  }
  const fraction = (value.split('.')[1] ?? '').replace(/0+$/, '');
  if (fraction.length > (unit === 'ATTO' ? 9 : 0)) {
    throw new AttoError('INVALID_AMOUNT', 'ATTO supports nine decimal places; RAW must be a whole number.');
  }
  try {
    const normalized = `${value.split('.')[0]}${fraction ? `.${fraction}` : ''}`;
    const amount = AttoAmount.from(unit === 'RAW' ? AttoUnit.RAW : AttoUnit.ATTO, normalized);
    const raw = amount.toString();
    if (!allowZero && BigInt(raw) === 0n) throw new Error();
    return raw;
  } catch {
    throw new AttoError('INVALID_AMOUNT', 'Amount is outside the Atto range or precision.');
  }
}

export function amountOutput(raw: string) {
  const value = BigInt(raw);
  const fraction = (value % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return { raw, atto: `${value / 1_000_000_000n}${fraction ? `.${fraction}` : ''}` };
}
