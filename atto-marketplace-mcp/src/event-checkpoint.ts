import { createHash } from 'node:crypto';
import { closeSync, constants, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isCursor } from './account-events.js';
import { isEventType } from './marketplace-validation.js';
import { assertPrivateProfileFile } from './private-directory.js';

/** A per-subscription SQLite file keeps a crash-released OS lock across cursor commits.
 * The listener never holds a long-lived lock on the shared profile database. */
export class EventCheckpoint {
  private readonly db: DatabaseSync;
  private readonly selected: string[];
  private readonly positions?: Map<string, string>;
  private pending = 0;
  cursor: string | undefined;

  constructor(home: string, origin: string, partition: string, types: string,
    selection?: {mode: 'saved' | 'all'; profile: string | null}) {
    this.selected = types.split(',');
    const identity = selection ? [selection.mode, origin, partition, selection.profile] : [origin, partition, types];
    const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const path = join(home, `events-${key}.sqlite`);
    if (!assertPrivateProfileFile(path, true)) {
      try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    assertPrivateProfileFile(path, false);
    for (const suffix of ['-journal', '-wal', '-shm']) assertPrivateProfileFile(path + suffix, true);
    this.db = new DatabaseSync(path, {defensive: true});
    try {
      this.db.exec('PRAGMA trusted_schema=OFF; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE;');
      if (!selection) {
        this.db.exec('CREATE TABLE IF NOT EXISTS checkpoint (singleton INTEGER PRIMARY KEY CHECK(singleton=1), cursor TEXT NOT NULL); COMMIT;');
        const row = this.db.prepare('SELECT cursor FROM checkpoint WHERE singleton=1').get();
        if (row && !isCursor(row.cursor)) throw new Error('The saved Marketplace listener cursor is invalid.');
        this.cursor = row?.cursor as string | undefined;
      } else {
        this.db.exec('CREATE TABLE IF NOT EXISTS saved_checkpoint (singleton INTEGER PRIMARY KEY CHECK(singleton=1), positions TEXT NOT NULL); COMMIT;');
        const row = this.db.prepare('SELECT positions FROM saved_checkpoint WHERE singleton=1').get();
        const stored: unknown = row ? JSON.parse(String(row.positions)) : {};
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('Invalid saved event positions.');
        this.positions = new Map();
        for (const [type, cursor] of Object.entries(stored)) {
          if (!isEventType(type) || !isCursor(cursor)) throw new Error('Invalid saved event positions.');
          this.positions.set(type, cursor);
        }
        for (const type of this.selected) {
          const cursor = this.positions.get(type);
          if (!cursor) { this.cursor = undefined; break; }
          if (!this.cursor || BigInt(cursor) < BigInt(this.cursor)) this.cursor = cursor;
        }
      }
    } catch (error) {
      this.db.close();
      if ((error as {errcode?: number}).errcode === 5) throw new Error('A listener already owns this event subscription.');
      throw error;
    }
  }

  needsDelivery(type: string, cursor: string): boolean {
    const previous = this.positions ? this.positions.get(type) : this.cursor;
    return previous === undefined || BigInt(cursor) > BigInt(previous);
  }

  advance(cursor: string, delivered: boolean): void {
    const next = BigInt(cursor);
    if (this.cursor && next <= BigInt(this.cursor)) return;
    if (!this.positions) {
      this.db.prepare('INSERT OR REPLACE INTO checkpoint(singleton,cursor) VALUES(1,?)').run(cursor);
    } else {
      // A frame proves that every selected type has been scanned through this ID.
      // Preserve any type that was already further ahead before this selection.
      for (const type of this.selected) {
        const prior = this.positions.get(type);
        if (!prior || BigInt(prior) < next) this.positions.set(type, cursor);
      }
      this.pending++;
      // Acknowledged queue work is durable immediately. Replayed frames cost no wake;
      // batch their scan progress, including the final partial batch at disconnect.
      if (delivered || this.pending >= 64) this.flush();
    }
    this.cursor = cursor;
  }

  flush(): void {
    if (!this.pending || !this.positions) return;
    this.db.prepare('INSERT OR REPLACE INTO saved_checkpoint(singleton,positions) VALUES(1,?)')
      .run(JSON.stringify(Object.fromEntries(this.positions)));
    this.pending = 0;
  }

  close(): void {
    try { this.flush(); }
    finally { this.db.close(); }
  }
}
