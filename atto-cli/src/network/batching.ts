import { AttoError } from '../domain/errors.js';
import type { WalletSettings } from '../wallet/types.js';

const officialGatekeepers = new Set([
  'gatekeeper.live.application.atto.cash',
  'gatekeeper.beta.application.atto.cash',
  'gatekeeper.dev.application.atto.cash',
]);

export function resolveNodeBatchSize(settings: Pick<WalletSettings, 'nodeUrl' | 'nodeBatchSize'>): number {
  if (settings.nodeBatchSize !== undefined && settings.nodeBatchSize !== null) {
    if (!Number.isInteger(settings.nodeBatchSize) || settings.nodeBatchSize < 1 || settings.nodeBatchSize > 1000) {
      throw new AttoError('INVALID_BATCH_SIZE', 'Node batch size must be an integer from 1 to 1000, or auto.');
    }
    return settings.nodeBatchSize;
  }
  let hostname: string;
  try { hostname = new URL(settings.nodeUrl).hostname.replace(/\.$/, ''); }
  catch { throw new AttoError('INVALID_NODE_URL', 'Configure a valid node URL.'); }
  // Private gateways cannot be identified by hostname; configure their limit explicitly.
  return officialGatekeepers.has(hostname) ? 5 : 1000;
}
