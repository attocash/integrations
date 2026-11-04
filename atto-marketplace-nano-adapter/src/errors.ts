export class NanoWalletError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
        this.name = 'NanoWalletError';
    }
}
export function fail(code: string, message = 'The private Nano wallet rejected this operation.'): never {
    throw new NanoWalletError(code, message);
}
