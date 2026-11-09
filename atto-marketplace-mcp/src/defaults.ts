import { homedir } from 'node:os';
import { join } from 'node:path';
import { ProfileError } from './profile-store.js';

export const productionMarketplaceOrigin = 'https://api.atto.market';
export const productionMarketplaceAudience = 'urn:marketplace:agent-api:live';
export const defaultMarketplaceProfile = 'main';
export function defaultMarketplaceHome(): string { return join(homedir(), '.config', 'atto', 'marketplace-mcp'); }

/** Resolve a new connection before wallet setup can change local state. */
export function marketplaceConnection(options: {origin?: string; audience?: string}): {origin: string; audience: string} {
  const origin = options.origin ?? productionMarketplaceOrigin;
  let url: URL;
  try { url = new URL(origin); } catch { throw usage('Use an exact HTTPS Marketplace origin or HTTP loopback development origin.'); }
  if (origin.length > 2048 || /[\x00-\x20\x7f]/.test(origin) || url.origin !== origin || url.username || url.password
    || !['https:', 'http:'].includes(url.protocol)
    || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw usage('Use an exact HTTPS Marketplace origin without credentials, path, query or trailing slash; HTTP is allowed only for loopback development.');
  }
  if (origin !== productionMarketplaceOrigin && !options.audience) throw usage('A custom Marketplace --origin requires its exact matching --audience.');
  const audience = options.audience ?? productionMarketplaceAudience;
  if (!audience || audience.length > 255 || audience.trim() !== audience || /[\x00-\x1f\x7f]/.test(audience)) {
    throw usage('Supply the exact Agent API audience as one nonempty line of at most 255 characters.');
  }
  return {origin, audience};
}
function usage(message: string): ProfileError { return new ProfileError('SETUP_USAGE', message); }
