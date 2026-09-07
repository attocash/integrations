import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { AttoError } from '../domain/errors.js';

export function defaultDataDirectory(): string {
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Atto MCP');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Atto MCP');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'atto-mcp');
}

/** Public wallet state only. Recovery material belongs exclusively in SecretStore. */
export class StateStore {
  readonly directory: string;
  private readonly state: DatabaseSync;
  private readonly coordination: DatabaseSync;
  private readonly lifecycle: DatabaseSync;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private lockRequests = 0;
  private exclusiveReset = false;

  get busy(): boolean { return this.lockRequests !== 0 || this.exclusiveReset; }

  constructor(directory: string) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const connections: DatabaseSync[] = [];
    const open = (name: string) => {
      const path = join(this.directory, name);
      closeSync(openSync(path, 'a', 0o600));
      if (process.platform !== 'win32') chmodSync(path, 0o600);
      const connection = new DatabaseSync(path);
      connections.push(connection);
      return connection;
    };
    try {
      // A lifetime read lease prevents reset while another wallet session exists.
      // This separate database must use rollback journaling: WAL readers do not
      // exclude writers. Acquire the lease before opening any wallet state.
      this.lifecycle = open('lifecycle.sqlite');
      this.lifecycle.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY); BEGIN; SELECT COUNT(*) FROM lease;');
      this.state = open('state.sqlite');
      this.state.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      const version = this.state.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== 1) throw new AttoError('STATE_VERSION', 'This wallet state requires a newer Atto CLI.');
      this.state.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version = 1;');
      this.coordination = open('coordination.sqlite');
      this.coordination.exec('PRAGMA busy_timeout = 0;');
    } catch (error) {
      for (const connection of connections.reverse()) {
        try { connection.close(); } catch { /* Preserve the startup failure. */ }
      }
      const code = (error as { errcode?: number }).errcode;
      if (code === 5 || code === 6) throw new AttoError('WALLET_BUSY', 'The wallet is busy. Wait for reset or other wallet operations to finish.');
      throw error;
    }
  }

  get<T>(key: string): T | undefined {
    this.requireOpen();
    const row = this.state.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value as string) as T : undefined;
  }

  set(key: string, value: unknown): void {
    this.requireOpen();
    const json = JSON.stringify(value);
    if (json === undefined) throw new AttoError('INVALID_STATE', 'Persistent state must be JSON serializable.');
    this.state.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, json);
  }

  /** Only synchronous state work belongs here; network work uses withWalletLock. */
  transaction<T>(fn: () => T): T {
    this.requireOpen();
    this.state.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.state.exec('COMMIT');
      return result;
    } catch (error) {
      this.state.exec('ROLLBACK');
      throw error;
    }
  }

  /** Terminal-only lifecycle operation. Once the shared lease is released this
   * store closes, even if another session prevents acquiring exclusivity. */
  async withExclusiveReset<T>(fn: () => Promise<T>): Promise<T> {
    this.requireOpen();
    if (this.lockRequests !== 0 || this.exclusiveReset) throw new AttoError('WALLET_BUSY', 'Wait for wallet operations before resetting this profile.');
    try {
      this.lifecycle.exec('ROLLBACK;');
      try { this.lifecycle.exec('BEGIN EXCLUSIVE;'); }
      catch (error) {
        const code = (error as { errcode?: number }).errcode;
        if (code === 5 || code === 6) throw new AttoError('WALLET_BUSY', 'Stop other sessions using this wallet before resetting.');
        throw error;
      }
      this.exclusiveReset = true;
      return await fn();
    } finally { this.close(); }
  }

  /** Keep database and lock file identities intact; caller owns the transaction. */
  clearForReset(): void {
    this.requireOpen();
    if (!this.exclusiveReset) throw new AttoError('LOCAL_APPROVAL_REQUIRED', 'Clearing wallet state requires an exclusive local reset.');
    this.state.exec('DELETE FROM settings;');
  }

  private requireOpen(): void {
    if (this.closed) throw new AttoError('STATE_CLOSED', 'The wallet state is closed.');
  }

  async withWalletLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) throw new AttoError('STATE_CLOSED', 'The wallet state is closed.');
    this.lockRequests++;
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    await previous;
    let locked = false;
    try {
      // Separate coordination lets short reservations commit durably without
      // keeping the state database transaction open during other async work.
      for (;;) {
        try {
          this.coordination.exec('BEGIN IMMEDIATE');
          locked = true;
          break;
        } catch (error) {
          const code = (error as { errcode?: number }).errcode;
          if (code !== 5 && code !== 6) throw error;
          await delay(25);
        }
      }
      return await fn();
    } finally {
      try {
        if (locked) this.coordination.exec('ROLLBACK');
      } finally {
        this.lockRequests--;
        release();
      }
    }
  }

  /** Never wait for account locks while holding the wallet lock. This immediate
   * attempt is safe during short wallet selection/reservation transactions. */
  tryAccountLocks(indexes: readonly number[]): (() => void) | undefined {
    if (this.closed) throw new AttoError('STATE_CLOSED', 'The wallet state is closed.');
    if (!Array.isArray(indexes) || indexes.length < 1 || indexes.length > 100
      || indexes.some(index => !Number.isSafeInteger(index) || index < 0 || index > 0x7fff_ffff)) {
      throw new AttoError('INVALID_INDEX', 'Account locks require between 1 and 100 valid wallet indexes.');
    }
    const directory = join(this.directory, 'account-locks');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const connections: DatabaseSync[] = [];
    const closeConnections = () => {
      let failure: unknown;
      for (const connection of connections.reverse()) {
        try { connection.close(); } catch (error) { failure ??= error; }
      }
      connections.length = 0;
      if (failure) throw failure;
    };
    try {
      // Sorted acquisition prevents cycles when payments consolidate accounts.
      for (const index of [...new Set(indexes)].sort((left, right) => left - right)) {
        const file = join(directory, `${index}.sqlite`);
        closeSync(openSync(file, 'a', 0o600));
        if (process.platform !== 'win32') chmodSync(file, 0o600);
        const connection = new DatabaseSync(file);
        connections.push(connection);
        connection.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;');
      }
    } catch (error) {
      closeConnections();
      const code = (error as { errcode?: number }).errcode;
      if (code === 5 || code === 6) return undefined;
      throw error;
    }
    this.lockRequests++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      try { closeConnections(); } finally { this.lockRequests--; }
    };
  }

  /** Acquire account locks first; short wallet reservations may run inside fn.
   * Closing the connection (including process death) releases every lock. */
  async withAccountLocks<T>(indexes: readonly number[], fn: () => Promise<T>): Promise<T> {
    if (this.closed) throw new AttoError('STATE_CLOSED', 'The wallet state is closed.');
    this.lockRequests++;
    let release: (() => void) | undefined;
    try {
      while (!(release = this.tryAccountLocks(indexes))) await delay(25);
      return await fn();
    } finally {
      try { release?.(); } finally { this.lockRequests--; }
    }
  }

  /** A process lifetime lock.  Unlike the wallet mutation lock this has no
   * bearing on ordinary commands, and SQLite releases it if the owner dies. */
  tryProcessLock(name: string): (() => void) | undefined {
    if (!/^[a-z0-9-]{1,64}$/i.test(name)) throw new AttoError('INVALID_LOCK', 'Invalid process lock name.');
    const directory = join(this.directory, 'process-locks');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, `${name}.sqlite`);
    closeSync(openSync(file, 'a', 0o600));
    if (process.platform !== 'win32') chmodSync(file, 0o600);
    const connection = new DatabaseSync(file);
    try { connection.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;'); }
    catch (error) {
      connection.close();
      const code = (error as { errcode?: number }).errcode;
      if (code === 5 || code === 6) return undefined;
      throw error;
    }
    this.lockRequests++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      try { connection.close(); } finally { this.lockRequests--; }
    };
  }

  close(): void {
    if (this.closed) return;
    if (this.lockRequests !== 0) throw new AttoError('WALLET_BUSY', 'Wait for wallet operations before closing state.');
    this.coordination.close();
    this.state.close();
    this.lifecycle.close();
    this.closed = true;
  }
}
