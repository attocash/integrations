import { AttoAlgorithm, AttoPublicKey } from '@attocash/commons-core';
import { parseAddress } from '../network/reader.js';
import type { NetworkName } from '../wallet/types.js';
import { GlobalDirectory, DIRECTORY_URL } from './directory.js';
import { PersonalLabels } from './personal.js';

export function modelAddress(value: Record<string, unknown>, prefix = ''): string | undefined {
  const publicKey = value[prefix ? `${prefix}PublicKey` : 'publicKey'];
  const algorithm = value[prefix ? `${prefix}Algorithm` : 'algorithm'];
  if (typeof publicKey !== 'string' || typeof algorithm !== 'string') return;
  try { return AttoPublicKey.Companion.parse(publicKey).toAddress(AttoAlgorithm.valueOf(algorithm)).value; }
  catch { return; }
}

/** Read protocol keys without rewriting network objects or interpreting metadata. */
export function resultAddresses(value: unknown): string[] {
  const addresses = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string' && value.startsWith('atto://')) {
      try { addresses.add(parseAddress(value).value); } catch { /* Not an address. */ }
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      for (const prefix of ['', 'receiver', 'representative', 'subject']) {
        const address = modelAddress(object, prefix);
        if (address) addresses.add(address);
      }
      for (const [key, child] of Object.entries(object)) {
        if (!['metadata', 'blockJson', 'destinationBinding', 'addressLabels', 'globalDirectory'].includes(key)) visit(child);
      }
    }
  };
  visit(value);
  return [...addresses];
}

export class AddressLabels {
  constructor(private readonly personal: PersonalLabels, readonly global: GlobalDirectory) {}
  dictionary(network: NetworkName, addresses: string[]) {
    const personal = new Map(this.personal.list(network).map(row => [row.address, row.label]));
    const { snapshot, status } = this.global.cached();
    const entries = network === 'LIVE' && snapshot ? [
      ...snapshot.addresses.map(value => ({ ...value, kind: 'address' as const })),
      ...snapshot.voters.map(value => ({ ...value, kind: 'voter' as const })),
    ] : [];
    const entities = new Map(snapshot?.entities.map(value => [value.entity, value]));
    return Object.fromEntries([...new Set(addresses)].map(address => [address, {
      ...(personal.has(address) ? { personal: { source: 'personal', label: personal.get(address)! } } : {}),
      global: entries.filter(entry => entry.address === address).map(entry => ({ ...entry, source: DIRECTORY_URL,
        entityInfo: entities.get(entry.entity), stale: status.stale })),
      // A payout relationship says nothing about ownership of its destination.
      payoutFor: entries.filter(entry => 'payToAddress' in entry && entry.payToAddress === address)
        .map(entry => ({ voterAddress: entry.address, label: entry.label, entity: entry.entity, source: DIRECTORY_URL, stale: status.stale })),
    }]));
  }
  status(network: NetworkName) { return network === 'LIVE' ? this.global.cached().status : { network: 'LIVE', applicable: false }; }
  list(network: NetworkName, all = false, search?: string) {
    const addresses = this.personal.list(network).map(row => row.address);
    if (all && network === 'LIVE') {
      const snapshot = this.global.cached().snapshot;
      addresses.push(...(snapshot?.addresses.map(row => row.address) ?? []), ...(snapshot?.voters.map(row => row.address) ?? []));
    }
    const dictionary = this.dictionary(network, addresses);
    const term = search?.trim().toLowerCase();
    const items = Object.entries(dictionary).filter(([address, labels]) => !term || [address, labels.personal?.label,
      ...labels.global.flatMap(row => [row.label, row.entity, row.entityInfo?.label, row.entityInfo?.organization])]
      .some(value => value?.toLowerCase().includes(term))).map(([address]) => ({ address }));
    return { network, items, addressLabels: Object.fromEntries(items.map(({ address }) => [address, dictionary[address]])), globalDirectory: this.status(network) };
  }
  decorate(result: unknown, network: NetworkName): unknown {
    if (Array.isArray(result)) return result.map(value => this.decorate(value, network));
    const addresses = resultAddresses(result);
    if (!addresses.length || !result || typeof result !== 'object' || Array.isArray(result)) return result;
    return { ...result, addressLabels: this.dictionary(network, addresses), globalDirectory: this.status(network) };
  }
}
