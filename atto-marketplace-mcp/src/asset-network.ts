import { MarketplaceApiError } from './marketplace-api.js';

export const attoNetworks = ['atto:live','atto:beta','atto:dev','atto:local'] as const;
export const nanoNetworks = ['nano:mainnet','nano:beta','nano:dev'] as const;
export const xnoFundingNetworks = ['nano:mainnet','nano:dev'] as const;
export const nativeNetworks = [...attoNetworks,...nanoNetworks] as const;
export const fundingNetworks = [...attoNetworks,...xnoFundingNetworks] as const;

export function validateAssetNetwork(assetName:string,network:unknown,operation:string):void {
  if (network===undefined) return;
  const allowed=assetName==='ATTO'
    ? attoNetworks
    : assetName==='XNO' && operation==='funding'
      ? xnoFundingNetworks
      : assetName==='XNO'
        ? nanoNetworks
        : [];
  if (typeof network!=='string' || !allowed.some(value => value === network)) {
    throw new MarketplaceApiError('NETWORK_ASSET_MISMATCH',`The requested ${operation} network is not available for ${assetName}.`);
  }
}
