import { AttoApplication } from './application/app.js';
import { AttoError } from './domain/errors.js';
import type { ApplicationSession } from './core.js';

const marketplaceWalletOperations = new Set([
  'wallet_status', 'balances_get', 'receivables_list', 'send', 'journal_get', 'limits_get', 'receive',
  'message_sign',
  'payment_prepare', 'payment_status',
]);

/** Narrow private child facade. Additional authority can only restrict the normal MCP grants. */
export function createInternalMarketplaceWalletApplication(options: {
  directory?: string;
  authorizeWrite: (status: unknown) => void;
}): ApplicationSession {
  if (typeof options.authorizeWrite !== 'function') throw new AttoError('INVALID_INPUT', 'Private wallet write authorization is required.');
  const application = new AttoApplication({
    directory: options.directory, access: 'mcp', internalMarketplaceReceiveSafety: true, receivingAllowed: () => false,
    internalMarketplaceAuthorizeWrite: options.authorizeWrite,
  });
  return {
    async call(name, input) {
      if (!marketplaceWalletOperations.has(name)) throw new AttoError('UNKNOWN_OPERATION', 'Unknown private Marketplace wallet operation.');
      if (name.startsWith('payment_')) return application.marketplaceRelay(name, input ?? {});
      return application.call(name, input);
    },
    start: application.start.bind(application),
    close: application.close.bind(application),
  };
}

export { withMarketplaceRecoverySeed, initializeMarketplaceRecoveryWallet, type MarketplaceRecoverySource } from './storage/recovery-seed.js';
export { validateMarketplaceUserProofApproval, type MarketplaceUserProofApprovalRequest } from './marketplace/proof-approval.js';

/** Private, terminal-only typed signer. Public CLI/MCP operations remain unchanged. */
export async function signMarketplaceAttoController(options: { directory: string; request: unknown; terminalConfirmed: true }) {
  if (options.terminalConfirmed !== true || !process.stdin.isTTY || !process.stderr.isTTY) throw new Error('Local terminal approval is required.');
  const application = new AttoApplication({ directory: options.directory });
  try { return await application.approveMarketplaceOwnedProof(options.request); }
  finally { await application.close(); }
}

/** Private deployment path for a typed login to one preauthorized profile. */
export async function signPreauthorizedMarketplaceAttoLogin(options: {
  directory: string; marketplaceHome: string; request: unknown; authorizationFile: string;
}) {
  const application = new AttoApplication({ directory: options.directory });
  try { return await application.approvePreauthorizedMarketplaceLogin(options.request, options.marketplaceHome, options.authorizationFile); }
  finally { await application.close(); }
}

export { inspectMarketplaceWalletSetup, withUnchangedMarketplaceWalletSetup, marketplacePaymentsUsable,
  marketplaceSpendingPolicyBounded, validateMarketplacePaymentCap, inspectMarketplacePaymentIntent, prepareMarketplacePayments,
  type MarketplaceWalletSetupSnapshot, type MarketplacePaymentMode, type MarketplacePaymentIntent, type MarketplacePaymentPlan } from './marketplace/wallet-setup.js';

export { assertPrivatePermissions, assertPrivatePermissionsBatch, securePrivatePermissions, syncPrivateDirectory, type PrivatePath } from './storage/private-permissions.js';
export { parseRelayOffer, decodePaymentHeader, relayPaymentPayload, validateRetainedRelayPayload, validateRelayOfferRefresh,
  type RelayRequest, type RelayTerms, type RelayRecord, type RelayOffer } from './marketplace/relay.js';
export { parseJsonObject } from './marketplace/strict-json.js';
