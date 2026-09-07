import { createRequire } from 'node:module';
import {
  AttoMnemonic, AttoSeed, AttoBlock, AttoSigner, AttoAccount, AttoAddress, AttoAmount,
  AttoInstant, AttoKeyIndex, AttoReceivable, AttoTransaction, AccountUpdate,
  attoAccountSend, attoAccountReceive, attoAccountOpen, attoAccountChange,
  privateKeyToSigner, toAttoIndex, toSeedAsync,
} from '@attocash/commons-core';
import { AttoNodeClientAsyncBuilder } from '@attocash/commons-node-remote';
import { AttoWorkerAsyncBuilder } from '@attocash/commons-worker-remote';
import { AttoError } from '../domain/errors.js';
import { NodeReader } from '../network/reader.js';
import { retryNetwork, type SendRetry } from '../network/retry.js';
import type { WalletSettings } from './types.js';
import type { BlockWorker } from './work.js';

// Ktor's Node transport calls require even when the package is imported as ESM.
Object.assign(globalThis, { require: createRequire(import.meta.url) });

export async function mnemonicSeed(phrase: string): Promise<AttoSeed> {
  const normalized = phrase.normalize('NFKD').trim().replace(/\s+/g, ' ');
  try {
    if (normalized.split(' ').length !== 24) throw new Error();
    return await toSeedAsync(await AttoMnemonic.fromPhrase(normalized));
  } catch {
    throw new AttoError('INVALID_MNEMONIC', 'Enter a valid 24-word Atto mnemonic.');
  }
}

export async function derivedSigner(seed: AttoSeed, index: number): Promise<AttoSigner> {
  if (!Number.isSafeInteger(index) || index < 0 || index > 0x7fff_ffff) {
    throw new AttoError('INVALID_INDEX', 'Key index must be between 0 and 2147483647.');
  }
  return privateKeyToSigner(await seed.toPrivateKey(toAttoIndex(index)));
}

export async function signingWallet(
  seed: AttoSeed, index: number, settings: WalletSettings,
  beforeSign: (block: AttoBlock) => void | Promise<void>,
  suppliedWorker?: BlockWorker,
  retry?: SendRetry,
) {
  const client = new AttoNodeClientAsyncBuilder(settings.nodeUrl).build();
  const worker = suppliedWorker ?? new AttoWorkerAsyncBuilder(settings.workerUrl).cached(false).timeoutSeconds(60n).build();
  let signer: AttoSigner | undefined = await derivedSigner(seed, index);
  const address = signer.address;
  const found = await retryNetwork(() => client.accountByAddresses([address]), retry);
  for (const value of found) {
    if (value.address.value !== address.value) throw new AttoError('ACCOUNT_MISMATCH', 'The node returned a different wallet account.');
    if (value.network.name !== settings.network) throw new AttoError('NETWORK_MISMATCH', 'Account network differs from the configured wallet network.');
  }
  if (found.length > 1) throw new AttoError('ACCOUNT_MISMATCH', 'The node returned duplicate wallet accounts.');
  let account: AttoAccount | undefined = found[0];
  let queue = Promise.resolve();

  function requireIndex(value: AttoKeyIndex): void {
    if (value.toInt() !== index) throw new AttoError('INVALID_INDEX', 'This signing operation belongs to a different account.');
  }

  function requireAccount(): AttoAccount {
    if (!account) throw new AttoError('ACCOUNT_NOT_OPEN', 'Receive funds to open this account before sending.');
    return account;
  }

  async function perform(build: (timestamp: string) => AccountUpdate, timestamp?: AttoInstant | null): Promise<AttoTransaction> {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      if (!signer) throw new AttoError('WALLET_CLOSED', 'This signing operation is closed.');
      const update = build((timestamp ?? await retryNetwork(() => client.now(), retry)).toString());
      const block = update.block;
      if (block.address.value !== address.value) throw new AttoError('ACCOUNT_MISMATCH', 'The constructed block belongs to a different wallet account.');
      if (block.network.name !== settings.network) throw new AttoError('NETWORK_MISMATCH', 'Account network differs from the configured wallet network.');
      if (!block.isValid()) throw new AttoError('INVALID_TRANSACTION', 'The constructed transaction is invalid.');
      await beforeSign(block);
      const signature = await signer.signBlock(block);
      const work = await retryNetwork(() => suppliedWorker ? suppliedWorker.workBlock(block, retry?.signal) : worker.workBlock(block), retry);
      const transaction = new AttoTransaction(block, signature, work);
      if (!await transaction.isValid()) throw new AttoError('INVALID_TRANSACTION', 'The signed transaction is invalid.');
      let attempted = false;
      await retryNetwork(async () => {
        if (attempted) {
          const confirmed = await new NodeReader(settings).transaction(transaction.hash.toString(), retry?.signal);
          if (confirmed) {
            if (confirmed.hash.toString() !== transaction.hash.toString() || !await confirmed.isValid()) {
              throw new AttoError('INVALID_NODE_RESPONSE', 'The node returned a different or invalid transaction.');
            }
            return;
          }
        }
        // Approval may have changed while waiting for work or during backoff.
        // Recheck that the journal still permits this exact block.
        if (retry) await beforeSign(block);
        if (retry?.signal.aborted) throw new AttoError('CANCELLED', 'Send cancelled.');
        attempted = true;
        await client.publish(transaction);
      }, retry);
      account = update.account;
      return transaction;
    } finally { release(); }
  }

  // Commons' wallet builder calls its private Kotlin worker interface directly.
  // Compose its public block, signing, validation, and publication APIs so the
  // persistent JS work cache has an explicit supported boundary.
  const wallet = {
    async sendByIndex(value: AttoKeyIndex, destination: AttoAddress, amount: AttoAmount, timestamp?: AttoInstant | null) {
      requireIndex(value);
      return perform(time => attoAccountSend(requireAccount(), destination, amount, time), timestamp);
    },
    async receive(receivable: AttoReceivable, representative?: AttoAddress | null, timestamp?: AttoInstant | null) {
      if (receivable.receiverAddress.value !== address.value) throw new AttoError('WRONG_RECEIVER', 'The payment belongs to a different address.');
      return perform(time => {
        if (account) return attoAccountReceive(account, receivable, time);
        if (!representative) throw new AttoError('REPRESENTATIVE_REQUIRED', 'Choose a representative to open this account.');
        return attoAccountOpen(representative, receivable, time);
      }, timestamp);
    },
    async change(value: AttoKeyIndex, representative: AttoAddress, timestamp?: AttoInstant | null) {
      requireIndex(value);
      return perform(time => attoAccountChange(requireAccount(), representative, time), timestamp);
    },
    async getAccountByIndex(value: AttoKeyIndex) { requireIndex(value); return account ?? null; },
    close() { signer = undefined; },
  };
  return { wallet, client, address };
}
