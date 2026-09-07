import { z } from 'zod';
import { AttoError } from '../domain/errors.js';
import { parseAddress } from '../network/reader.js';
import type { StateStore } from '../storage/state.js';
import type { NetworkName } from '../wallet/types.js';

// Count Unicode code points, not UTF-16 units. Formatting controls are rejected
// too, so invisible direction changes cannot disguise a payment destination.
export const personalNameSchema = z.string().refine(value => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value), 'Labels cannot contain control characters.')
  .transform(value => value.trim()).refine(value => [...value].length >= 1 && [...value].length <= 128, 'Labels must contain 1–128 characters after trimming.');
export const nameKey = (name: string): string => name.trim().toLowerCase();
export interface PersonalLabel { address: string; label: string }

export class PersonalLabels {
  constructor(private readonly store: StateStore) {}
  list(network: NetworkName): PersonalLabel[] {
    const rows = this.store.get<PersonalLabel[]>(`labels.personal.${network}`) ?? [];
    try {
      if (!Array.isArray(rows)) throw new Error();
      const names = new Set<string>();
      const addresses = new Set<string>();
      for (const row of rows) {
        if (parseAddress(row.address).value !== row.address || personalNameSchema.parse(row.label) !== row.label
          || names.has(nameKey(row.label)) || addresses.has(row.address)) throw new Error();
        names.add(nameKey(row.label)); addresses.add(row.address);
      }
      return rows;
    } catch { throw new AttoError('INVALID_STATE', 'The saved personal labels are invalid. Restore verified profile state.'); }
  }
  set(network: NetworkName, address: string, input: string): PersonalLabel {
    const label = personalNameSchema.parse(input);
    address = parseAddress(address).value;
    return this.store.transaction(() => {
      const rows = this.list(network);
      if (rows.some(row => nameKey(row.label) === nameKey(label) && row.address !== address)) {
        throw new AttoError('LABEL_EXISTS', 'This personal name already belongs to another address on this network.');
      }
      const row = { address, label };
      this.store.set(`labels.personal.${network}`, [...rows.filter(row => row.address !== address), row]);
      return row;
    });
  }
  remove(network: NetworkName, address: string): void {
    this.store.transaction(() => this.store.set(`labels.personal.${network}`, this.list(network).filter(row => row.address !== address)));
  }
  resolve(network: NetworkName, label: string): PersonalLabel {
    const row = this.list(network).find(row => nameKey(row.label) === nameKey(label));
    if (!row) throw new AttoError('LABEL_NOT_FOUND', 'No personal label matches this name on this network. Global names cannot be used for payments.');
    return row;
  }
}
