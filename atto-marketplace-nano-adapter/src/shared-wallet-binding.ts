import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { NanoWalletConfiguration } from './configuration.js';
import { absolutePath, privateDirectory, publishPrivate, readPrivate, recoverPublication } from './private-files.js';
import { fail } from './errors.js';
import { parseJsonObject } from './json.js';

type SharedConfiguration = NanoWalletConfiguration & { keySource: Extract<NanoWalletConfiguration['keySource'], { type: 'shared-recovery' }> };
function isShared(config: NanoWalletConfiguration): config is SharedConfiguration {
    return config.keySource.type === 'shared-recovery';
}

function bindingPath(config: SharedConfiguration): string {
    const account = createHash('sha256').update(config.network).update('\0').update(config.sourceAddress).digest('hex');
    return join(config.keySource.recoverySource.directory, 'marketplace-nano-wallets', `${account}.json`);
}

function binding(config: SharedConfiguration, dataDir: string) {
    const source = config.keySource.recoverySource;
    return {
        version: 1,
        network: config.network,
        address: config.sourceAddress,
        derivationIndex: config.derivationIndex,
        keySource: {
            type: config.keySource.type,
            derivationVersion: config.keySource.derivationVersion,
            recoverySource: {
                directory: source.directory,
                credentialAccount: source.credentialAccount,
                credentialService: source.credentialService,
                identityAddress: source.identityAddress,
            },
        },
        dataDirectory: absolutePath(dataDir),
    };
}

function bindingBytes(config: SharedConfiguration, dataDir: string): Buffer {
    return Buffer.from(`${JSON.stringify(binding(config, dataDir))}\n`);
}

/** The account's original journal directory is immutable. A missing or damaged
 * claim cannot establish that another directory has no unpublished candidate. */
export function requireSharedWalletBinding(config: NanoWalletConfiguration, dataDir: string): void {
    if (!isShared(config)) return;
    const path = bindingPath(config);
    let actual: Buffer;
    try {
        privateDirectory(join(config.keySource.recoverySource.directory, 'marketplace-nano-wallets'), false);
        recoverPublication(path);
        actual = readPrivate(path, 32768);
    } catch {
        return fail('WALLET_JOURNAL_BINDING', 'The shared Nano journal binding is missing or unavailable. Restore its original private binding and wallet directory before continuing.');
    }
    if (actual.equals(bindingBytes(config, dataDir))) return;
    // Report a reuse path only when the entire saved binding matches this
    // account and source, apart from its original directory.
    try {
        const saved = parseJsonObject(actual.toString('utf8'));
        if (typeof saved.dataDirectory === 'string' && actual.equals(bindingBytes(config, saved.dataDirectory))) {
            return fail('WALLET_JOURNAL_BINDING', `This shared Nano account already uses ${JSON.stringify(saved.dataDirectory)}. Reuse that wallet directory and its original journal.`);
        }
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'WALLET_JOURNAL_BINDING') throw error;
    }
    return fail('WALLET_JOURNAL_BINDING', 'The shared Nano journal binding does not match this wallet. Restore the original source binding and wallet directory before continuing.');
}

/** Check an existing claim before creating any destination files. */
export function checkSharedWalletBindingIfPresent(config: NanoWalletConfiguration, dataDir: string): void {
    if (isShared(config) && existsSync(bindingPath(config))) requireSharedWalletBinding(config, dataDir);
}

/** Atomic durable first claim. Exact retries may complete a crash between this
 * publication and wallet.json; a second directory never obtains another lane. */
export function claimSharedWalletBinding(config: NanoWalletConfiguration, dataDir: string): void {
    if (!isShared(config)) return;
    const path = bindingPath(config);
    if (existsSync(path)) return requireSharedWalletBinding(config, dataDir);
    privateDirectory(join(config.keySource.recoverySource.directory, 'marketplace-nano-wallets'));
    try {
        publishPrivate(path, bindingBytes(config, dataDir));
    } catch (error) {
        // A concurrent publisher may have won. Read its immutable claim for the
        // same useful reuse error as a later setup attempt.
        if (existsSync(path)) return requireSharedWalletBinding(config, dataDir);
        throw error;
    }
    requireSharedWalletBinding(config, dataDir);
}
