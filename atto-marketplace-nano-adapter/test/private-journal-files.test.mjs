import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { NanoJournal } from '../dist/journal.js';

function fixture(t, suffix) {
  const directory = mkdtempSync(join(tmpdir(), 'nano-journal-private-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const original = new NanoJournal(directory);
  original.close();
  const database = join(directory, 'nano-wallet.sqlite3');
  return { directory, database, databaseBytes: readFileSync(database), sidecar: `${database}${suffix}` };
}

for (const suffix of ['-journal', '-wal', '-shm']) {
  test(`Nano rejects permissive POSIX modes on retained SQLite ${suffix} before opening the journal`, {skip:process.platform === 'win32'}, t => {
    // Given an original private database and a retained sidecar readable by other users.
    const f = fixture(t, suffix), retained = Buffer.from('retained candidate sidecar');
    writeFileSync(f.sidecar, retained, { mode: 0o600 });
    chmodSync(f.sidecar, 0o644);
    // When a fresh adapter attempts to open its original journal.
    assert.throws(() => new NanoJournal(f.directory), { code: 'PRIVATE_FILE' });
    // Then neither SQLite recovery nor cleanup consumes the untrusted artifact.
    assert.deepEqual(readFileSync(f.sidecar), retained);
    assert.deepEqual(readFileSync(f.database), f.databaseBytes);
  });

  test(`Nano rejects an extra hardlink on retained SQLite ${suffix}`, t => {
    // Given a retained sidecar with an unrelated second hardlink.
    const f = fixture(t, suffix), retained = Buffer.from('retained candidate sidecar');
    writeFileSync(f.sidecar, retained, { mode: 0o600 });
    const other = join(f.directory, 'unrelated-hardlink');
    linkSync(f.sidecar, other);
    // When a fresh adapter attempts to open its original journal.
    assert.throws(() => new NanoJournal(f.directory), { code: 'PRIVATE_FILE' });
    // Then both exact links remain untouched and the database is unchanged.
    assert.deepEqual(readFileSync(f.sidecar), retained);
    assert.deepEqual(readFileSync(other), retained);
    assert.deepEqual(readFileSync(f.database), f.databaseBytes);
  });

  test(`Nano rejects a redirected retained SQLite ${suffix}`, t => {
    // Given a retained artifact redirected to another file or Windows junction.
    const f = fixture(t, suffix), target = join(f.directory, 'redirect-target');
    if (process.platform === 'win32') {
      mkdirSync(target);
      symlinkSync(target, f.sidecar, 'junction');
    } else {
      writeFileSync(target, 'untouched target', { mode: 0o600 });
      symlinkSync(target, f.sidecar);
    }
    // When a fresh adapter attempts to open its original journal.
    assert.throws(() => new NanoJournal(f.directory), { code: 'PRIVATE_FILE' });
    // Then SQLite never opens the redirected artifact or alters the original database.
    assert.deepEqual(readFileSync(f.database), f.databaseBytes);
    if (process.platform !== 'win32') assert.equal(readFileSync(target, 'utf8'), 'untouched target');
  });
}
