import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { parseOperation } from '../application/operations.js';
import { parseAddress } from '../domain/address.js';
import { amountRaw } from '../domain/amount.js';
import { AttoError } from '../domain/errors.js';
import { marketTerms } from '../pricing/terms.js';
import { openReadOnlyState, STATE_SCHEMA_VERSION } from '../storage/state.js';
import { defaultSettings } from '../wallet/defaults.js';
import type { WalletAddress, WalletIdentity, WalletSettings } from '../wallet/types.js';

export interface DoctorProfile {
  settings: WalletSettings;
  settingsSource: 'profile' | 'defaults';
  identity?: WalletIdentity;
  addresses: WalletAddress[];
  access: 'read-only' | 'spend';
  poolIndexes: number[];
  pendingPayments: number;
  resetPending: boolean;
  termsAccepted: boolean;
  permissions?: { private: boolean; directoryMode: string; databaseMode?: string };
}

const identitySchema = z.strictObject({ address: z.string().max(128), fingerprint: z.string().regex(/^[a-f\d]{64}$/i) });
const addressesSchema = z.array(z.strictObject({ index: z.number().int().min(0).max(2147483647),
  address: z.string().max(128), publicKey: z.string().regex(/^[a-f\d]{64}$/i), active: z.boolean() }));

/** Read a consistent snapshot without StateStore's initialization, migration, or chmod. */
export function readDoctorProfile(directory: string): DoctorProfile {
  let parent = directory;
  while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
  accessSync(parent, constants.R_OK | constants.W_OK | constants.X_OK);
  const file = join(directory, 'state.sqlite');
  const directoryInfo = existsSync(directory) ? statSync(directory) : undefined;
  const databaseInfo = existsSync(file) ? statSync(file) : undefined;
  const permissions = process.platform !== 'win32' && directoryInfo ? {
    private: (directoryInfo.mode & 0o077) === 0 && (!databaseInfo || (databaseInfo.mode & 0o077) === 0),
    directoryMode: (directoryInfo.mode & 0o777).toString(8),
    ...(databaseInfo ? { databaseMode: (databaseInfo.mode & 0o777).toString(8) } : {}),
  } : undefined;
  if (!databaseInfo) return { settings: defaultSettings(), settingsSource: 'defaults', addresses: [], access: 'read-only', poolIndexes: [0], pendingPayments: 0, resetPending: false, termsAccepted: false, permissions };
  accessSync(file, constants.R_OK | constants.W_OK);
  const state = openReadOnlyState(directory, { busyTimeoutMs: 1000, beginTransaction: true });
  try {
    if (state.userVersion !== 1 && state.userVersion !== STATE_SCHEMA_VERSION) throw new AttoError('STATE_VERSION', 'This wallet state requires a supported Atto CLI version.');
    const get = (key: string): unknown => state.get(key, 1_048_576);
    const settings = parseOperation('wallet_configure', get('settings')) as unknown as WalletSettings;
    if (['network', 'nodeUrl', 'workerUrl', 'representative', 'autoReceive', 'minReceiveRaw'].some(key => !Object.hasOwn(settings, key))) throw new Error('Incomplete settings');
    parseAddress(settings.representative);
    amountRaw(settings.minReceiveRaw, 'RAW');
    const savedIdentity = get('identity');
    const identity = savedIdentity === undefined ? undefined : identitySchema.parse(savedIdentity);
    if (identity) parseAddress(identity.address);
    const addresses = addressesSchema.parse(get('addresses') ?? []);
    if (new Set(addresses.map(address => address.index)).size !== addresses.length) throw new Error('Duplicate account indexes');
    for (const address of addresses) {
      if (parseAddress(address.address).publicKey.toString().toUpperCase() !== address.publicKey.toUpperCase()) throw new Error('Account identity mismatch');
    }
    if (identity && addresses.find(address => address.index === 0)?.address !== identity.address) throw new Error('Wallet identity mismatch');
    const access = z.enum(['read-only', 'spend']).parse(get('spending.mcpAccess') ?? 'read-only');
    const proposed = parseOperation('limits_propose', { policy: get('spending.policy') ?? { perRequest: null, rolling: [] }, access, pool: get('spending.pool') ?? { indexes: [0], consolidate: false } });
    const terms = get('market.terms') as { version?: unknown } | undefined;
    return { settings, settingsSource: 'profile', identity, addresses, access, permissions,
      poolIndexes: (proposed.pool as { indexes: number[] }).indexes, pendingPayments: state.pendingSendCount(),
      resetPending: Boolean(get('wallet.reset')), termsAccepted: terms?.version === marketTerms.version };
  } finally { state.close(); }
}
