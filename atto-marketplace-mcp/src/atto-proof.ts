import { AttoAddress, AttoSignature } from '@attocash/commons-core';

/** Verify the exact controller challenge before a one-use proof leaves this process. */
export async function validAttoProof(address: string, message: string, signature: string): Promise<boolean> {
  try {
    const publicKey = AttoAddress.parse(address).publicKey;
    return await AttoSignature.Companion.parse(signature).isValidMessage(
      publicKey, Int8Array.from(Buffer.from(message, 'utf8')));
  } catch {
    return false;
  }
}
