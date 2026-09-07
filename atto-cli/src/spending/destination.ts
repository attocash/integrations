import { AttoError } from '../domain/errors.js';
import { PersonalLabels, nameKey, personalNameSchema } from '../labels/personal.js';
import { parseAddress } from '../network/reader.js';
import type { StateStore } from '../storage/state.js';
import type { NetworkName } from '../wallet/types.js';
import type { SpendLedger } from './ledger.js';

export interface DestinationBinding { address: string; network: NetworkName; label?: string }
export function validateDestinationBinding(binding: DestinationBinding): void {
  if (!binding || !['LIVE', 'BETA', 'DEV', 'LOCAL'].includes(binding.network) || parseAddress(binding.address).value !== binding.address
    || (binding.label !== undefined && personalNameSchema.parse(binding.label) !== binding.label)) throw new Error('Invalid payment destination binding.');
}

/** Pins destinations even when selection/pricing fails before a reservation.
 * The label lookup and first binding share one SQLite write transaction. */
export function bindDestination(store: StateStore, ledger: SpendLedger, network: NetworkName,
  request: { requestId: string; destination?: string; destinationLabel?: string }): DestinationBinding {
  return store.transaction(() => {
    const key = `send.destination.${request.requestId}`;
    const saved = store.get<DestinationBinding>(key);
    const record = ledger.get(request.requestId);
    const prior = saved ?? record?.destinationBinding;
    if (prior) {
      try { validateDestinationBinding(prior); }
      catch { throw new AttoError('INVALID_STATE', 'The saved payment destination is invalid. Restore verified profile state.'); }
      if (prior.network !== network) throw new AttoError('NETWORK_MISMATCH', 'This request ID belongs to another network.');
      if (request.destinationLabel !== undefined
        ? prior.label === undefined || nameKey(prior.label) !== nameKey(request.destinationLabel)
        : parseAddress(request.destination!).value !== prior.address) {
        throw new AttoError('REQUEST_CONFLICT', 'This request ID belongs to a different destination. Use its original personal name or full address.');
      }
      return prior;
    }
    const local = request.destinationLabel === undefined ? undefined : new PersonalLabels(store).resolve(network, request.destinationLabel);
    const binding: DestinationBinding = { network, address: local?.address ?? parseAddress(request.destination!).value,
      ...(local ? { label: local.label } : {}) };
    if (record && (record.destination !== binding.address || (record.network && record.network !== network))) {
      throw new AttoError('REQUEST_CONFLICT', 'This request ID belongs to a different payment destination or network.');
    }
    store.set(key, binding);
    return binding;
  });
}
