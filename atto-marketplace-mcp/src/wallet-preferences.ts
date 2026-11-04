import { constants, type DatabaseSync } from 'node:sqlite';
import { assertWalletDirectory, MarketplaceProfileStore, ProfileError } from './profile-store.js';
import { AttoAddress } from '@attocash/commons-core';
import { isDeepStrictEqual } from 'node:util';

export interface AttoWalletAccess {
  address: string;
  index: number;
  network: string;
  fingerprint: string;
  marketplaceFunding: boolean;
  externalTransfers: boolean;
}

export interface WalletSelection {
  attoDirectory?: string;
  nanoDirectory?: string;
  nanoControllerDirectory?: string;
  paymentHandoffDirectory?: string;
  attoAccess?: AttoWalletAccess;
}

const fields = ['attoDirectory', 'nanoDirectory', 'nanoControllerDirectory', 'paymentHandoffDirectory'] as const;
const schema = `CREATE TABLE wallet_selection (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = 1),
  atto_directory TEXT,
  nano_directory TEXT,
  nano_controller_directory TEXT,
  payment_handoff_directory TEXT,
  atto_access TEXT
)`;

/** Reads public paths only. An absent home/database/selection stays absent. */
export function readWalletSelection(home: string): WalletSelection | undefined {
  if (!assertWalletDirectory(home, true)) return undefined;
  let db: DatabaseSync | undefined;
  try {
    db = MarketplaceProfileStore.openWalletPreferences(home, true);
    if (!db) return undefined;
    restrictPreferencesAccess(db);
    if (!validateSchema(db)) return undefined;
    const selection = readSelection(db);
    if (selection) validateDirectories(selection);
    return selection;
  } catch (error) { throw selectionError(error); }
  finally { db?.close(); }
}

/** Commits a role patch atomically in the existing profile backup boundary. */
export async function saveWalletSelection(home: string, patch: Partial<WalletSelection>, approval?: {expected: WalletSelection | undefined}): Promise<void> {
  validatePatch(patch);
  validateDirectories(patch);
  if (!assertWalletDirectory(home)) throw selectionError();
  let db: DatabaseSync | undefined;
  let transaction = false;
  try {
    db = MarketplaceProfileStore.openWalletPreferences(home, false)!;
    restrictPreferencesAccess(db);
    db.exec('BEGIN IMMEDIATE');
    transaction = true;
    if (!validateSchema(db)) db.exec(schema);
    const previous = readSelection(db);
    if (approval && !isDeepStrictEqual(previous, approval.expected)) throw new ProfileError('WALLET_CONFIGURATION_CHANGED', 'The selected wallet changed during terminal review. Repeat approval.');
    const selected = { ...previous, ...patch };
    if (patch.attoDirectory !== undefined && patch.attoDirectory !== previous?.attoDirectory && !patch.attoAccess) delete selected.attoAccess;
    if (selected.attoAccess && !selected.attoDirectory) throw selectionError();
    // A shared controller follows the primary wallet; only a separate role needs its own pointer.
    if (selected.nanoControllerDirectory === selected.nanoDirectory) delete selected.nanoControllerDirectory;
    validateDirectories(selected);
    db.prepare(`INSERT INTO wallet_selection(singleton,version,atto_directory,nano_directory,nano_controller_directory,payment_handoff_directory,atto_access)
      VALUES(1,1,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET atto_directory=excluded.atto_directory,
      nano_directory=excluded.nano_directory,nano_controller_directory=excluded.nano_controller_directory,
      payment_handoff_directory=excluded.payment_handoff_directory,atto_access=excluded.atto_access`)
      .run(selected.attoDirectory ?? null, selected.nanoDirectory ?? null, selected.nanoControllerDirectory ?? null,
        selected.paymentHandoffDirectory ?? null, selected.attoAccess ? JSON.stringify(selected.attoAccess) : null);
    db.exec('COMMIT');
    transaction = false;
  } catch (error) {
    if (transaction) { try { db?.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ } }
    throw selectionError(error);
  } finally { db?.close(); }
}

function validatePatch(value: WalletSelection): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length === 0
    || Object.keys(value).some(key => key !== 'attoAccess' && !fields.includes(key as typeof fields[number]))) throw selectionError();
  for (const [field, item] of Object.entries(value)) {
    if (field === 'attoAccess') validateAttoAccess(item);
    else if (typeof item !== 'string') throw selectionError();
  }
}

function validateDirectories(selection: WalletSelection): void {
  for (const field of fields) {
    const directory = selection[field];
    if (directory === undefined) continue;
    if (typeof directory !== 'string') throw selectionError();
    assertWalletDirectory(directory);
  }
}

function validateAttoAccess(value: unknown): asserts value is AttoWalletAccess {
  const access = value as AttoWalletAccess;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 6
    || Object.keys(value).some(key => !['address','index','network','fingerprint','marketplaceFunding','externalTransfers'].includes(key))
    || !Number.isInteger(access.index) || access.index < 0 || access.index > 0x7fffffff
    || !['atto:live','atto:beta','atto:dev','atto:local'].includes(access.network)
    || typeof access.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(access.fingerprint)
    || typeof access.marketplaceFunding !== 'boolean' || typeof access.externalTransfers !== 'boolean') throw selectionError();
  try { if (AttoAddress.parse(access.address).value !== access.address) throw selectionError(); }
  catch { throw selectionError(); }
}

function validateSchema(db: DatabaseSync): boolean {
  const objects = db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE name='wallet_selection' OR tbl_name='wallet_selection'`).all() as Array<{type: string; name: string; tbl_name: string; sql: string}>;
  if (objects.length === 0) return false;
  if (objects.length !== 1 || objects[0]!.type !== 'table' || objects[0]!.name !== 'wallet_selection'
    || canonicalSchema(objects[0]!.sql) !== canonicalSchema(schema)) throw selectionError();
  return true;
}

function canonicalSchema(value: string): string { return value.replace(/\s+/g, '').toLowerCase(); }

function readSelection(db: DatabaseSync): WalletSelection | undefined {
  const rows = db.prepare('SELECT singleton,version,atto_directory,nano_directory,nano_controller_directory,payment_handoff_directory,atto_access FROM wallet_selection LIMIT 2').all();
  if (rows.length === 0) return undefined;
  if (rows.length !== 1) throw selectionError();
  const row = rows[0]!;
  if (row.singleton !== 1 || row.version !== 1) throw selectionError();
  const selection: WalletSelection = {};
  for (const [field, column] of [['attoDirectory', 'atto_directory'], ['nanoDirectory', 'nano_directory'],
    ['nanoControllerDirectory', 'nano_controller_directory'], ['paymentHandoffDirectory', 'payment_handoff_directory']] as const) {
    const value = row[column];
    if (value !== null) {
      if (typeof value !== 'string') throw selectionError();
      selection[field] = value;
    }
  }
  if (row.atto_access !== null) {
    if (typeof row.atto_access !== 'string') throw selectionError();
    const access: unknown = JSON.parse(row.atto_access);
    validateAttoAccess(access);
    if (!selection.attoDirectory) throw selectionError();
    selection.attoAccess = access;
  }
  if (Object.keys(selection).length === 0) throw selectionError();
  return selection;
}

function restrictPreferencesAccess(db: DatabaseSync): void {
  // Defense in depth: even a malicious view/trigger cannot read credentials or modify profile/journal tables.
  db.setAuthorizer((action, table, _column, database, triggerOrView) => {
    if (triggerOrView !== null || (database !== null && database !== 'main')) return constants.SQLITE_DENY;
    if ([constants.SQLITE_READ, constants.SQLITE_INSERT, constants.SQLITE_UPDATE, constants.SQLITE_DELETE].includes(action)
      && !['wallet_selection', 'sqlite_master', 'sqlite_schema'].includes(table ?? '')) return constants.SQLITE_DENY;
    if (action === constants.SQLITE_CREATE_TABLE && table !== 'wallet_selection') return constants.SQLITE_DENY;
    if ([constants.SQLITE_ATTACH, constants.SQLITE_DETACH, constants.SQLITE_ALTER_TABLE, constants.SQLITE_DROP_TABLE,
      constants.SQLITE_CREATE_VIEW, constants.SQLITE_CREATE_TRIGGER, constants.SQLITE_CREATE_VTABLE].includes(action)) return constants.SQLITE_DENY;
    return constants.SQLITE_OK;
  });
}

function selectionError(error?: unknown): ProfileError {
  if (error instanceof ProfileError) return error;
  return new ProfileError('WALLET_SETUP_REQUIRED', 'The saved Marketplace wallet selection is unavailable or invalid. Review it in the local terminal.');
}
