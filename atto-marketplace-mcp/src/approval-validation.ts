import { AttoAddress } from '@attocash/commons-core';
import { validateMarketplaceUserProofApproval } from '@attocash/cli/internal-marketplace';
import { canonicalAddress } from '@attocash/atto-marketplace-nano-adapter/protocol';
import { ProfileError } from './profile-store.js';
import type { MarketplaceProofApprovalRequest } from './approval-files.js';

/** Validate backend-owned typed frames and binding hashes without opening any key store. */
export function validateTypedApproval(input: unknown, options: {
  nativeNetwork?: string; allowExpired?: boolean; now?: number;
} = {}): MarketplaceProofApprovalRequest {
  try {
    const candidate = input as MarketplaceProofApprovalRequest;
    const network = candidate?.controller?.network;
    if (network !== 'ATTO' && network !== 'NANO') throw invalid();
    const frameNetwork = candidate.challenge?.message?.split('\n')[2]?.replace(/^Network: /, '');
    const nativeNetwork = options.nativeNetwork ?? frameNetwork;
    if (!nativeNetwork) throw invalid();
    const request = validateMarketplaceUserProofApproval(input, { network, nativeNetwork,
      ...(options.allowExpired === undefined ? {} : { allowExpired: options.allowExpired }),
      ...(options.now === undefined ? {} : { now: options.now }) });
    if (canonicalController(request.controller.address) !== request.controller.address) throw invalid();
    const action = request.action;
    if (action.kind === 'payout-address' || action.kind === 'withdrawal') {
      const command = action.command as Record<string, unknown>;
      const address = action.kind === 'payout-address' ? action.canonicalTargetAddress : action.destinationAddress;
      const route = action.network;
      if (typeof address !== 'string' || canonicalController(address) !== address
        || (command.asset === 'ATTO' ? !['atto:live','atto:beta','atto:dev','atto:local'].includes(String(route))
          : !['nano:mainnet','nano:beta','nano:dev'].includes(String(route)))
        || (command.asset === 'ATTO') !== address.startsWith('atto://')
        || (action.kind === 'payout-address' && command.action === 'ENROLL'
          && (typeof command.address !== 'string' || canonicalController(command.address) !== address))) throw invalid();
    }
    if (action.kind === 'identity-link') {
      for (const address of [action.authorizingAddress, action.newIdentityAddress]) {
        if (typeof address !== 'string' || canonicalController(address) !== address) throw invalid();
      }
    }
    return request;
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    if (error && typeof error === 'object' && 'code' in error && error.code === 'MARKETPLACE_APPROVAL_EXPIRED') {
      throw new ProfileError('APPROVAL_EXPIRED', 'This exact Marketplace approval has expired. Recover the existing response or request a fresh challenge.');
    }
    throw invalid();
  }
}

function canonicalController(address: string): string {
  return address.startsWith('atto://') ? AttoAddress.parse(address).value : canonicalAddress(address);
}
function invalid(): ProfileError {
  return new ProfileError('APPROVAL_BINDING', 'The typed Marketplace request does not match its exact controller, action, challenge, and binding hash.');
}
