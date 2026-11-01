import { AttoAlgorithm, AttoPublicKey } from '@attocash/commons-core';
import { amountOutput } from '../domain/amount.js';

const subjectRoles = { SEND: 'receiver', OPEN: 'sender', RECEIVE: 'sender', CHANGE: 'representative' } as const;

/** Add action details to an exact, serialized account entry without changing protocol fields. */
export function publicEntry(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const entry = value as Record<string, unknown>;
  if (typeof entry.blockType !== 'string' || !Object.hasOwn(subjectRoles, entry.blockType)
    || typeof entry.hash !== 'string' || typeof entry.height !== 'string'
    || !/^\d+$/.test(entry.height) || !['number', 'string'].includes(typeof entry.timestamp)
    || typeof entry.algorithm !== 'string' || typeof entry.publicKey !== 'string'
    || typeof entry.subjectAlgorithm !== 'string' || typeof entry.subjectPublicKey !== 'string'
    || typeof entry.previousBalance !== 'string' || !/^\d+$/.test(entry.previousBalance)
    || typeof entry.balance !== 'string' || !/^\d+$/.test(entry.balance)) return value;

  let address: string;
  let subjectAddress: string;
  try {
    address = AttoPublicKey.Companion.parse(entry.publicKey).toAddress(AttoAlgorithm.valueOf(entry.algorithm)).value;
    subjectAddress = AttoPublicKey.Companion.parse(entry.subjectPublicKey).toAddress(AttoAlgorithm.valueOf(entry.subjectAlgorithm)).value;
  } catch { return value; }

  const action = entry.blockType as keyof typeof subjectRoles;
  const previous = BigInt(entry.previousBalance);
  const balance = BigInt(entry.balance);
  const raw = action === 'SEND' ? previous - balance : balance - previous;
  return {
    address, subjectAddress, subjectRole: subjectRoles[action],
    ...(action !== 'CHANGE' ? { amount: amountOutput(raw.toString()) } : {}),
    ...entry,
  };
}
