import { AttoApplication } from './application/app.js';
import { AttoError } from './domain/errors.js';
import { internalOperations } from './application/operations.js';
import type { ApplicationSession } from './core.js';
import type { InternalMarketplacePaymentConfig } from './spending/payments.js';

export { internalOperations };
export type { InternalMarketplacePaymentConfig };
export type { MarketplaceIntentPayment, MarketplaceIntentPaymentFailure, MarketplaceIntentPendingSignature,
  MarketplaceIntentPaymentStatus } from './spending/payments.js';

const marketplaceWalletOperations = new Set([
  'wallet_status', 'balances_get', 'receivables_list', 'send', 'journal_get', 'limits_get', 'receive',
  'marketplace_pay_intent', 'marketplace_pay_intent_status', 'message_sign',
]);

/** Narrow private child facade. Additional authority can only restrict the normal MCP grants. */
export function createInternalMarketplaceWalletApplication(options: {
  directory?: string;
  authorizeWrite: (status: unknown) => void;
  internalMarketplacePayment?: InternalMarketplacePaymentConfig;
}): ApplicationSession {
  if (typeof options.authorizeWrite !== 'function') throw new AttoError('INVALID_INPUT', 'Private wallet write authorization is required.');
  const application = new AttoApplication({
    directory: options.directory, access: 'mcp', internalMarketplaceReceiveSafety: true, receivingAllowed: () => false,
    internalMarketplaceAuthorizeWrite: options.authorizeWrite,
    ...(options.internalMarketplacePayment ? { internalMarketplacePayment: options.internalMarketplacePayment } : {}),
  });
  return {
    async call(name, input) {
      if (!marketplaceWalletOperations.has(name)) throw new AttoError('UNKNOWN_OPERATION', 'Unknown private Marketplace wallet operation.');
      return application.call(name, input);
    },
    start: application.start.bind(application),
    close: application.close.bind(application),
  };
}

/** Runtime facade reserved for the configured Marketplace MCP private stdio child. */
export function createInternalMarketplacePaymentApplication(options: {
  directory?: string;
  internalMarketplacePayment: InternalMarketplacePaymentConfig;
}): ApplicationSession {
  const application = new AttoApplication({ ...options, access: 'mcp' });
  return {
    call: application.call.bind(application),
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

export { inspectMarketplaceWalletSetup, withUnchangedMarketplaceWalletSetup, type MarketplaceWalletSetupSnapshot } from './marketplace/wallet-setup.js';

export { assertPrivatePermissions, assertPrivatePermissionsBatch, securePrivatePermissions, securePrivatePermissionsBatch, syncPrivateDirectory, type PrivatePath } from './storage/private-permissions.js';
