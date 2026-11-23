import { z } from 'zod';
import type { NanoNetwork, NanoWalletConfiguration } from '@attocash/atto-marketplace-nano-adapter';
import { isProductionMarketplace } from './defaults.js';

export const nanoWorkMethod = 'marketplace/nanoWork';
export const nanoWorkRequest = z.object({
  hash: z.string().regex(/^[a-fA-F0-9]{64}$/),
  difficulty: z.string().regex(/^[a-fA-F0-9]{16}$/),
});
export const nanoWorkResult = z.object({ work: z.string().regex(/^[a-fA-F0-9]{16}$/) });

export function defaultNanoRpcUrl(network: NanoNetwork): string {
  return network === 'nano:mainnet' ? 'https://rpc.nano.to' : 'http://localhost:17076';
}

type WorkConfiguration = Pick<NanoWalletConfiguration, 'network' | 'rpcUrl' | 'origin' | 'audience'>
  & {workUrl?: string | undefined};

export function usesMarketplaceWork(config: WorkConfiguration): boolean {
  return config.workUrl === undefined && config.network === 'nano:mainnet'
    && new URL(config.rpcUrl).href === new URL(defaultNanoRpcUrl(config.network)).href
    && isProductionMarketplace(config);
}

export function nanoWorkDescription(config: WorkConfiguration): string {
  return usesMarketplaceWork(config)
    ? `Marketplace when signed in, otherwise ${config.rpcUrl}`
    : config.workUrl ?? config.rpcUrl;
}
