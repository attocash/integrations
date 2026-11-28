import { createHash } from 'node:crypto';
import { closeSync, constants, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isCursor } from './account-events.js';
import { assertPrivateProfileFile } from './private-directory.js';

/** A per-subscription SQLite file keeps a crash-released OS lock across cursor commits.
 * The listener never holds a long-lived lock on the shared profile database. */
export class EventCheckpoint {
  private readonly db: DatabaseSync;
  cursor: string | undefined;

  constructor(home: string, origin: string, accountId: string, types: string) {
    const key = createHash('sha256').update(JSON.stringify([origin, accountId, types])).digest('hex');
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
      this.db.exec('CREATE TABLE IF NOT EXISTS checkpoint (singleton INTEGER PRIMARY KEY CHECK(singleton=1), cursor TEXT NOT NULL); COMMIT;');
      const row = this.db.prepare('SELECT cursor FROM checkpoint WHERE singleton=1').get();
      if (row && !isCursor(row.cursor)) throw new Error('The saved Marketplace listener cursor is invalid.');
      this.cursor = row?.cursor as string | undefined;
    } catch (error) {
      this.db.close();
      if ((error as {errcode?: number}).errcode === 5) throw new Error('A listener already owns this account subscription.');
      throw error;
    }
  }

  acknowledge(cursor: string): void {
    this.db.prepare('INSERT OR REPLACE INTO checkpoint(singleton,cursor) VALUES(1,?)').run(cursor);
    this.cursor = cursor;
  }

  close(): void { this.db.close(); }
}
