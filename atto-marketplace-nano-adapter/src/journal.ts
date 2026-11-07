import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, sha256 } from './configuration.js';
import { privateDirectory, privateFile, processIdentity, processOwnerAlive, writePrivateNew } from './private-files.js';
import { fail } from './errors.js';
export type OperationState = 'PREPARING' | 'PREPARED' | 'UNKNOWN' | 'CONFIRMED' | 'COMPETING';
export interface JournalRecord {
    id: string;
    kind: 'payment' | 'transfer' | 'receive';
    digest: string;
    requestJson: string;
    uniqueId: string;
    source: string;
    network: string;
    amount: string;
    destination: string;
    createdAt: number;
    state: OperationState;
    owner: string;
    epoch: number | null;
    previous: string | null;
    previousBalance: string | null;
    representative: string | null;
    blockJson: string | null;
    blockHash: string | null;
    responseJson: string | null;
    deadline: string | null;
    confirmedAt: number | null;
}
const columns = 'id,kind,digest,requestJson,uniqueId,source,network,amount,destination,createdAt,state,owner,epoch,previous,previousBalance,representative,blockJson,blockHash,responseJson,deadline,confirmedAt';
/** One SQLite writer transaction reserves the account lane and rolling spend together. */
export class NanoJournal {
    readonly db: DatabaseSync;
    private readonly token = `${processIdentity() ?? `${process.pid}:unknown`}:${randomUUID()}`;
    constructor(readonly dataDir: string) {
        privateDirectory(dataDir);
        const path = join(dataDir, 'nano-wallet.sqlite3');
        if (!existsSync(path)) {
            try {
                writePrivateNew(path, Buffer.alloc(0));
            }
            catch {
                if (!existsSync(path))
                    fail('JOURNAL_UNAVAILABLE');
            }
        }
        privateFile(path);
        this.db = new DatabaseSync(path);
        this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,kind TEXT NOT NULL,digest TEXT NOT NULL,requestJson TEXT NOT NULL,uniqueId TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,network TEXT NOT NULL,amount TEXT NOT NULL,destination TEXT NOT NULL,createdAt INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('PREPARING','PREPARED','UNKNOWN','CONFIRMED','COMPETING')),owner TEXT NOT NULL,
        epoch INTEGER,previous TEXT,previousBalance TEXT,representative TEXT,blockJson TEXT,blockHash TEXT,responseJson TEXT,deadline TEXT,confirmedAt INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS source_lane ON operations(source) WHERE state IN ('PREPARING','PREPARED','UNKNOWN');
      CREATE TRIGGER IF NOT EXISTS frozen_terms BEFORE UPDATE ON operations
        WHEN NEW.id<>OLD.id OR NEW.kind<>OLD.kind OR NEW.digest<>OLD.digest OR NEW.requestJson<>OLD.requestJson
        OR NEW.uniqueId<>OLD.uniqueId OR NEW.source<>OLD.source OR NEW.network<>OLD.network OR NEW.amount<>OLD.amount
        OR NEW.destination<>OLD.destination OR NEW.createdAt<>OLD.createdAt OR NEW.owner<>OLD.owner
        BEGIN SELECT RAISE(ABORT,'immutable wallet terms'); END;
      CREATE TRIGGER IF NOT EXISTS frozen_candidate BEFORE UPDATE ON operations WHEN OLD.blockHash IS NOT NULL AND
        (NEW.blockHash IS NOT OLD.blockHash OR NEW.blockJson IS NOT OLD.blockJson OR NEW.previous IS NOT OLD.previous
        OR NEW.previousBalance IS NOT OLD.previousBalance OR NEW.representative IS NOT OLD.representative OR NEW.epoch IS NOT OLD.epoch
        OR NEW.responseJson IS NOT OLD.responseJson OR NEW.deadline IS NOT OLD.deadline)
        BEGIN SELECT RAISE(ABORT,'immutable signed candidate'); END;
      CREATE TRIGGER IF NOT EXISTS retain_signed BEFORE DELETE ON operations WHEN OLD.blockHash IS NOT NULL
        BEGIN SELECT RAISE(ABORT,'retain signed candidate'); END;`);
        privateFile(path);
    }
    close(): void {
        this.db.close();
    }
    checkLimit(source: string, network: string, now: number, limit: bigint): void {
        this.transaction(() => {
            if (this.reservedSpend(source, network, now) > limit)
                fail('DAILY_LIMIT');
        });
    }
    private reservedSpend(source: string, network: string, now: number): bigint {
        const rows = this.db.prepare(`SELECT amount FROM operations WHERE source=? AND network=? AND kind IN ('payment','transfer') AND
        (state IN ('PREPARING','PREPARED','UNKNOWN') OR (state='CONFIRMED' AND confirmedAt>=?))`).all(source, network, now - 86400000) as {
            amount: string;
        }[];
        return rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
    }
    private transaction<T>(action: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const value = action();
            this.db.exec('COMMIT');
            return value;
        }
        catch (error) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch {
            }
            throw error;
        }
    }
    find(id: string): JournalRecord | undefined {
        return this.db.prepare(`SELECT ${columns} FROM operations WHERE id=?`).get(id) as unknown as JournalRecord | undefined;
    }
    private ownerAlive(owner: string): boolean {
        return processOwnerAlive(owner);
    }
    private requireUnsigned(record: JournalRecord): void {
        for (const key of ['epoch', 'previous', 'previousBalance', 'representative', 'blockJson', 'blockHash', 'responseJson', 'deadline'] as const) {
            if (record[key] !== null)
                fail('JOURNAL_CONFLICT', 'An interrupted preparation contains unexpected signed candidate fields.');
        }
    }
    begin(input: Pick<JournalRecord, 'id' | 'kind' | 'digest' | 'requestJson' | 'uniqueId' | 'source' | 'network' | 'amount' | 'destination'>, now: number, limit: bigint): JournalRecord {
        return this.transaction(() => {
            const prior = this.find(input.id);
            if (prior) {
                this.requireTerms(prior, input);
                if (prior.state !== 'PREPARING')
                    return prior;
                this.requireUnsigned(prior);
                if (this.ownerAlive(prior.owner))
                    fail('PAYMENT_IN_PROGRESS');
                this.db.prepare(`DELETE FROM operations WHERE id=? AND state='PREPARING' AND blockHash IS NULL`).run(input.id);
            }
            const lane = this.db.prepare(`SELECT ${columns} FROM operations WHERE source=? AND state IN ('PREPARING','PREPARED','UNKNOWN')`).get(input.source) as unknown as JournalRecord | undefined;
            if (lane?.state === 'PREPARING')
                this.requireUnsigned(lane);
            if (lane?.state === 'PREPARING' && !this.ownerAlive(lane.owner))
                this.db.prepare(`DELETE FROM operations WHERE source=? AND state='PREPARING' AND blockHash IS NULL`).run(input.source);
            else if (lane)
                fail(lane.state === 'PREPARING' ? 'PAYMENT_IN_PROGRESS' : 'SOURCE_FENCED', 'A prior Nano operation still owns the source account lane.');
            const alias = this.db.prepare('SELECT id FROM operations WHERE uniqueId=?').get(input.uniqueId);
            if (alias)
                fail('INTENT_ALREADY_USED');
            const reserved = this.reservedSpend(input.source, input.network, now);
            if (reserved + BigInt(input.amount) > limit)
                fail('DAILY_LIMIT', 'The Nano payment exceeds the approved rolling 24-hour spend ceiling.');
            this.db.prepare(`INSERT INTO operations(id,kind,digest,requestJson,uniqueId,source,network,amount,destination,createdAt,state,owner) VALUES(?,?,?,?,?,?,?,?,?,?,'PREPARING',?)`).run(input.id, input.kind, input.digest, input.requestJson, input.uniqueId, input.source, input.network, input.amount, input.destination, now, this.token);
            return this.find(input.id)!;
        });
    }
    requireTerms(record: JournalRecord, input: Pick<JournalRecord, 'id' | 'kind' | 'digest' | 'requestJson' | 'uniqueId' | 'source' | 'network' | 'amount' | 'destination'>): void {
        for (const key of ['id', 'kind', 'digest', 'requestJson', 'uniqueId', 'source', 'network', 'amount', 'destination'] as const)
            if (record[key] !== input[key])
                fail('HANDLE_REUSE', 'This Nano operation identity is already bound to different terms.');
    }
    save(id: string, candidate: Pick<JournalRecord, 'epoch' | 'previous' | 'previousBalance' | 'representative' | 'blockJson' | 'blockHash' | 'responseJson' | 'deadline'>): JournalRecord {
        return this.transaction(() => {
            const result = this.db.prepare(`UPDATE operations SET state='PREPARED',epoch=?,previous=?,previousBalance=?,representative=?,blockJson=?,blockHash=?,responseJson=?,deadline=? WHERE id=? AND state='PREPARING' AND owner=? AND blockHash IS NULL`).run(candidate.epoch, candidate.previous, candidate.previousBalance, candidate.representative, candidate.blockJson, candidate.blockHash, candidate.responseJson, candidate.deadline, id, this.token);
            if (result.changes !== 1)
                fail('JOURNAL_CONFLICT');
            return this.find(id)!;
        });
    }
    abort(id: string): void {
        this.transaction(() => {
            this.db.prepare(`DELETE FROM operations WHERE id=? AND state='PREPARING' AND owner=? AND blockHash IS NULL`).run(id, this.token);
        });
    }
    clearAbandoned(id: string): boolean {
        return this.transaction(() => {
            const row = this.find(id);
            if (!row || row.state !== 'PREPARING')
                return false;
            this.requireUnsigned(row);
            if (this.ownerAlive(row.owner))
                fail('PAYMENT_IN_PROGRESS');
            this.db.prepare('DELETE FROM operations WHERE id=? AND blockHash IS NULL').run(id);
            return true;
        });
    }
    state(id: string, state: Exclude<OperationState, 'PREPARING' | 'PREPARED'>, now: number): JournalRecord {
        return this.transaction(() => {
            const row = this.find(id);
            if (!row || !row.blockHash)
                fail('JOURNAL_CONFLICT');
            if (['CONFIRMED', 'COMPETING'].includes(row.state)) {
                if (row.state !== state)
                    fail('JOURNAL_CONFLICT');
                return row;
            }
            this.db.prepare(`UPDATE operations SET state=?,confirmedAt=? WHERE id=? AND state IN ('PREPARED','UNKNOWN')`).run(state, state === 'CONFIRMED' ? now : null, id);
            return this.find(id)!;
        });
    }
}
