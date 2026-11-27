export const attoNetworks = ['atto:live', 'atto:beta', 'atto:dev', 'atto:local'] as const;
export const nanoNetworks = ['nano:mainnet', 'nano:beta', 'nano:dev'] as const;
export const xnoFundingNetworks = ['nano:mainnet', 'nano:dev'] as const;
export const fundingNetworks = [...attoNetworks, ...xnoFundingNetworks] as const;
