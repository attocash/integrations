// This process receives public identifiers only. Recovery material never leaves it.
process.env.KOTLIN_LOGGING_STARTUP_MESSAGE = 'false';
console.log = console.info = console.debug = console.error = () => {};

export type CredentialResult = 'matched' | 'readable' | 'missing' | 'invalid' | 'mismatch' | 'unavailable' | 'backend_unavailable' | 'timeout';
export interface CredentialRequest { service: 'Atto CLI' | 'Atto MCP'; account: string; address?: string; fingerprint?: string }

process.once('message', async (request: CredentialRequest) => {
  let result: CredentialResult = 'unavailable';
  try {
    if (process.platform !== 'linux') {
      try { await import('@napi-rs/keyring'); }
      catch { process.send?.('backend_unavailable'); process.disconnect?.(); return; }
    }
    const { OsSecretStore } = await import('../storage/secrets.js');
    const phrase = await new OsSecretStore(request.account, request.service).get();
    if (phrase === null) result = 'missing';
    else {
      result = 'invalid';
      const { mnemonicSeed } = await import('../wallet/signing.js');
      const { AttoAlgorithm, toAttoIndex } = await import('@attocash/commons-core');
      const { createHash } = await import('node:crypto');
      const seed = await mnemonicSeed(phrase);
      try {
        const key = await seed.toPrivateKey(toAttoIndex(0));
        try {
          const publicKey = await key.toPublicKey();
          const address = publicKey.toAddress(AttoAlgorithm.V1).value;
          const fingerprint = createHash('sha256').update(publicKey.toString()).digest('hex');
          result = request.address === undefined ? 'readable'
            : request.address === address && request.fingerprint === fingerprint ? 'matched' : 'mismatch';
        } finally { key.value.fill(0); }
      } finally { seed.value.fill(0); }
    }
  } catch { /* Only the allowlisted result is returned, never dependency diagnostics. */ }
  process.send?.(result);
  process.disconnect?.();
});
