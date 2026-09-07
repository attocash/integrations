import { AttoBlock, AttoSendBlock, AttoTransaction } from '@attocash/commons-core';
import type { NodeReader } from '../network/reader.js';
import type { SendRecord } from './ledger.js';

export type SendResolution =
  | { status: 'published'; transaction: AttoTransaction }
  | { status: 'rejected' }
  | { status: 'unresolved' };

/** Release a reservation only when the configured node proves a canonical conflict. */
export async function reconcileSend(
  reader: Pick<NodeReader, 'settings' | 'transaction' | 'stream'>,
  record: SendRecord,
  timeoutMs = 10_000,
): Promise<SendResolution> {
  try {
    if (!record.blockJson) return { status: 'unresolved' };
    const block = AttoBlock.fromJson(record.blockJson);
    if (!(block instanceof AttoSendBlock) || block.amount.toString() !== record.raw
      || block.receiverAddress.value !== record.destination
      || (record.sourceAddress && block.address.value !== record.sourceAddress)) return { status: 'unresolved' };
  } catch { return { status: 'unresolved' }; }
  return reconcileBlock(reader, record, timeoutMs);
}

/** The same canonical-position check also protects consolidation receive steps. */
export async function reconcileBlock(
  reader: Pick<NodeReader, 'settings' | 'transaction' | 'stream'>,
  record: { hash?: string; blockJson?: string },
  timeoutMs = 10_000,
): Promise<SendResolution> {
  const unresolved: SendResolution = { status: 'unresolved' };
  const deadline = AbortSignal.timeout(timeoutMs);
  try {
    if (!record.hash || !record.blockJson) return unresolved;
    const block = AttoBlock.fromJson(record.blockJson);
    if (!block.isValid()
      || block.hash.toString() !== record.hash.toUpperCase()
      || block.network.name !== reader.settings.network) return unresolved;

    const samePosition = (transaction: AttoTransaction) => transaction.address.value === block.address.value
      && transaction.block.network.name === block.network.name
      && transaction.height.toString() === block.height.toString();

    const published = await reader.transaction(record.hash, deadline);
    if (published) {
      if (!samePosition(published) || published.hash.toString() !== block.hash.toString()
        || !await published.isValid() || deadline.aborted) return unresolved;
      return { status: 'published', transaction: published };
    }
    if (deadline.aborted) return unresolved;

    // The account's exact-height confirmed transaction stream supplies canonical
    // evidence. A missing hash alone never proves that publication is impossible.
    const received = new AbortController();
    let canonical: AttoTransaction | undefined;
    await reader.stream({
      event: 'transaction', addresses: [block.address.value],
      fromHeight: block.height.toString(), toHeight: block.height.toString(),
    }, (model) => {
      if (model instanceof AttoTransaction) canonical = model;
      received.abort();
    }, AbortSignal.any([deadline, received.signal]));
    if (!canonical || !samePosition(canonical) || !await canonical.isValid() || deadline.aborted) return unresolved;
    return canonical.hash.toString() === block.hash.toString()
      ? { status: 'published', transaction: canonical }
      : { status: 'rejected' };
  } catch {
    // Missing, malformed, unavailable, and timed-out evidence retains allowance.
    return unresolved;
  }
}
