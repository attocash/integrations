import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { parseOperation } from '../application/operations.js';
import { amountRaw } from '../domain/amount.js';
import { AttoError } from '../domain/errors.js';
import { parseAddress } from '../network/reader.js';
import { marketTerms } from '../pricing/terms.js';
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
  const state = new DatabaseSync(file, { readOnly: true });
  try {
    state.exec('PRAGMA busy_timeout = 1000; BEGIN;');
    if (state.prepare('PRAGMA user_version').get()?.user_version !== 1) throw new AttoError('STATE_VERSION', 'This wallet state requires a supported Atto CLI version.');
    const get = (key: string): unknown => {
      const row = state.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      if (!row) return undefined;
      if (typeof row.value !== 'string' || row.value.length > 1_048_576) throw new Error('Invalid state value');
      return JSON.parse(row.value);
    };
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
    const pending = state.prepare("SELECT COUNT(*) AS count FROM settings, json_each(settings.value) WHERE settings.key = 'spending.records' AND json_extract(json_each.value, '$.status') IN ('reserved', 'signed', 'unknown')").get();
    const terms = get('market.terms') as { version?: unknown } | undefined;
    return { settings, settingsSource: 'profile', identity, addresses, access, permissions,
      poolIndexes: (proposed.pool as { indexes: number[] }).indexes, pendingPayments: Number(pending?.count ?? 0),
      resetPending: Boolean(get('wallet.reset')), termsAccepted: terms?.version === marketTerms.version };
  } finally { state.close(); }
}
