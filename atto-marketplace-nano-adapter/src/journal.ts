import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, sha256 } from './configuration.js';
import { privateFiles, processIdentity, processOwnerAlive, writePrivateNew } from './private-files.js';
import { fail } from './errors.js';
import { parseJsonObject, validateRelayOfferRefresh, type RelayRequest } from '@attocash/cli/internal-marketplace';
export type OperationState = 'PREPARING' | 'PREPARED' | 'UNKNOWN' | 'CONFIRMED' | 'COMPETING';
export interface JournalRecord {
    id: string;
    kind: 'transfer' | 'receive';
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
    confirmedAt: number | null;
}
const columns = 'id,kind,digest,requestJson,uniqueId,source,network,amount,destination,createdAt,state,owner,epoch,previous,previousBalance,representative,blockJson,blockHash,confirmedAt';
/** Validate retained rollback/WAL artifacts before SQLite can consume or delete
 * them. A concurrent transaction may remove an already checked sidecar. */
function privateJournalFiles(path: string): void {
    privateFiles([
        { path },
        ...['-journal', '-wal', '-shm'].map(suffix => ({ path: `${path}${suffix}`, optional: true })),
    ], [dirname(path)]);
}
/** One SQLite writer transaction reserves the account lane and rolling spend together. */
export class NanoJournal {
    readonly db: DatabaseSync;
    private readonly token = `${processIdentity() ?? `${process.pid}:unknown`}:${randomUUID()}`;
    constructor(readonly dataDir: string) {
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
        privateJournalFiles(path);
        this.db = new DatabaseSync(path);
        try {
            this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,kind TEXT NOT NULL,digest TEXT NOT NULL,requestJson TEXT NOT NULL,uniqueId TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,network TEXT NOT NULL,amount TEXT NOT NULL,destination TEXT NOT NULL,createdAt INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('PREPARING','PREPARED','UNKNOWN','CONFIRMED','COMPETING')),owner TEXT NOT NULL,
        epoch INTEGER,previous TEXT,previousBalance TEXT,representative TEXT,blockJson TEXT,blockHash TEXT,confirmedAt INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS source_lane ON operations(source) WHERE state IN ('PREPARING','PREPARED','UNKNOWN');
      DROP TRIGGER IF EXISTS frozen_terms;
      CREATE TRIGGER frozen_terms BEFORE UPDATE ON operations
        WHEN NEW.id<>OLD.id OR NEW.kind<>OLD.kind
        OR NEW.uniqueId<>OLD.uniqueId OR NEW.source<>OLD.source OR NEW.network<>OLD.network OR NEW.amount<>OLD.amount
        OR NEW.destination<>OLD.destination OR NEW.createdAt<>OLD.createdAt
        OR ((NEW.digest<>OLD.digest OR NEW.requestJson<>OLD.requestJson OR NEW.owner<>OLD.owner) AND NOT (
          OLD.kind='transfer' AND OLD.state='PREPARING' AND NEW.state='PREPARING'
          AND OLD.blockHash IS NULL AND OLD.blockJson IS NULL AND OLD.epoch IS NULL AND OLD.previous IS NULL
          AND OLD.previousBalance IS NULL AND OLD.representative IS NULL
          AND json_type(OLD.requestJson,'$.relay')='object' AND json_type(NEW.requestJson,'$.relay')='object'
          AND json_remove(OLD.requestJson,'$.relay.paymentRequired')=json_remove(NEW.requestJson,'$.relay.paymentRequired')))
        BEGIN SELECT RAISE(ABORT,'immutable wallet terms'); END;
      CREATE TRIGGER IF NOT EXISTS frozen_candidate BEFORE UPDATE ON operations WHEN OLD.blockHash IS NOT NULL AND
        (NEW.blockHash IS NOT OLD.blockHash OR NEW.blockJson IS NOT OLD.blockJson OR NEW.previous IS NOT OLD.previous
        OR NEW.previousBalance IS NOT OLD.previousBalance OR NEW.representative IS NOT OLD.representative OR NEW.epoch IS NOT OLD.epoch )
        BEGIN SELECT RAISE(ABORT,'immutable signed candidate'); END;
      CREATE TRIGGER IF NOT EXISTS retain_signed BEFORE DELETE ON operations WHEN OLD.blockHash IS NOT NULL
        BEGIN SELECT RAISE(ABORT,'retain signed candidate'); END;
      CREATE TABLE IF NOT EXISTS relay_headers (id TEXT PRIMARY KEY REFERENCES operations(id), header TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS frozen_relay_header BEFORE UPDATE ON relay_headers
        BEGIN SELECT RAISE(ABORT,'immutable relay authorization'); END;
      CREATE TRIGGER IF NOT EXISTS retain_relay_header BEFORE DELETE ON relay_headers
        BEGIN SELECT RAISE(ABORT,'retain relay authorization'); END;
      COMMIT;`);
            if (process.platform !== 'win32') privateJournalFiles(path);
        } catch (error) {
            this.db.close();
            throw error;
        }
    }
    close(): void {
        this.db.close();
    }
    checkLimit(source: string, network: string, now: number, limit: bigint | null): void {
        this.transaction(() => {
            if (limit !== null && this.reservedSpend(source, network, now) > limit)
                fail('DAILY_LIMIT');
        });
    }
    private reservedSpend(source: string, network: string, now: number): bigint {
        const rows = this.db.prepare(`SELECT amount FROM operations WHERE source=? AND network=? AND kind='transfer' AND
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
    pendingForSource(source: string): JournalRecord | undefined {
        return this.db.prepare(`SELECT ${columns} FROM operations WHERE source=? AND state IN ('PREPARING','PREPARED','UNKNOWN')`).get(source) as unknown as JournalRecord | undefined;
    }
    relayHeader(id: string): string | undefined {
        return (this.db.prepare('SELECT header FROM relay_headers WHERE id=?').get(id) as {header:string}|undefined)?.header;
    }
    authorizeRelay(id: string, header: string): void {
        this.transaction(() => {
            const record = this.find(id), existing = this.relayHeader(id);
            if (!record?.blockHash || header.length > 90_000 || (existing !== undefined && existing !== header)) fail('JOURNAL_CONFLICT');
            if (!existing) this.db.prepare('INSERT INTO relay_headers(id,header) VALUES(?,?)').run(id, header);
        });
    }
    private ownerAlive(owner: string): boolean {
        return processOwnerAlive(owner);
    }
    private requireUnsigned(record: JournalRecord): void {
        for (const key of ['epoch', 'previous', 'previousBalance', 'representative', 'blockJson', 'blockHash'] as const) {
            if (record[key] !== null)
                fail('JOURNAL_CONFLICT', 'An interrupted preparation contains unexpected signed candidate fields.');
        }
    }
    begin(input: Pick<JournalRecord, 'id' | 'kind' | 'digest' | 'requestJson' | 'uniqueId' | 'source' | 'network' | 'amount' | 'destination'>, now: number, limit: bigint | null): JournalRecord {
        return this.transaction(() => {
            const prior = this.find(input.id);
            if (prior) {
                const oldTerms = parseJsonObject(prior.requestJson), nextTerms = parseJsonObject(input.requestJson);
                const relay = oldTerms.relay as RelayRequest | undefined;
                if (relay !== undefined && prior.state === 'PREPARING') {
                    this.requireUnsigned(prior);
                    if (this.ownerAlive(prior.owner)) fail('PAYMENT_IN_PROGRESS');
                    if (this.relayHeader(prior.id)) fail('JOURNAL_CONFLICT');
                    for (const key of ['id','kind','uniqueId','source','network','amount','destination'] as const) {
                        if (prior[key] !== input[key]) fail('HANDLE_REUSE');
                    }
                    const nextRelay = nextTerms.relay as RelayRequest | undefined;
                    if (nextRelay === undefined) fail('HANDLE_REUSE');
                    if (relay.paymentRequired !== nextRelay.paymentRequired) validateRelayOfferRefresh(relay, nextRelay);
                    else this.requireTerms(prior, input);
                    if (sha256(prior.requestJson) !== prior.digest || sha256(input.requestJson) !== input.digest) fail('JOURNAL_CONFLICT');
                    this.db.prepare(`UPDATE operations SET owner=?,requestJson=?,digest=? WHERE id=? AND state='PREPARING' AND blockHash IS NULL`).run(this.token,input.requestJson,input.digest,input.id);
                    return this.find(input.id)!;
                }
                this.requireTerms(prior, input);
                if (prior.state !== 'PREPARING')
                    return prior;
                this.requireUnsigned(prior);
                if (this.ownerAlive(prior.owner))
                    fail('PAYMENT_IN_PROGRESS');
                this.db.prepare(`DELETE FROM operations WHERE id=? AND state='PREPARING' AND blockHash IS NULL`).run(input.id);
            }
            const lane = this.pendingForSource(input.source);
            if (lane?.state === 'PREPARING')
                this.requireUnsigned(lane);
            if (lane?.state === 'PREPARING' && !this.ownerAlive(lane.owner))
                this.db.prepare(`DELETE FROM operations WHERE id=? AND state='PREPARING' AND blockHash IS NULL`).run(lane.id);
            else if (lane)
                fail(lane.state === 'PREPARING' ? 'PAYMENT_IN_PROGRESS' : 'SOURCE_FENCED', 'A prior Nano operation still owns the source account lane.');
            const alias = this.db.prepare('SELECT id FROM operations WHERE uniqueId=?').get(input.uniqueId);
            if (alias)
                fail('INTENT_ALREADY_USED');
            const reserved = this.reservedSpend(input.source, input.network, now);
            if (limit !== null && reserved + BigInt(input.amount) > limit)
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
    save(id: string, candidate: Pick<JournalRecord, 'epoch' | 'previous' | 'previousBalance' | 'representative' | 'blockJson' | 'blockHash'>, header?: string): JournalRecord {
        return this.transaction(() => {
            const result = this.db.prepare(`UPDATE operations SET state='PREPARED',epoch=?,previous=?,previousBalance=?,representative=?,blockJson=?,blockHash=? WHERE id=? AND state='PREPARING' AND owner=? AND blockHash IS NULL`).run(candidate.epoch, candidate.previous, candidate.previousBalance, candidate.representative, candidate.blockJson, candidate.blockHash, id, this.token);
            if (result.changes !== 1)
                fail('JOURNAL_CONFLICT');
            if (header !== undefined) this.db.prepare('INSERT INTO relay_headers(id,header) VALUES(?,?)').run(id, header);
            return this.find(id)!;
        });
    }
    abort(id: string): void {
        this.transaction(() => {
            this.db.prepare(`DELETE FROM operations WHERE id=? AND state='PREPARING' AND owner=? AND blockHash IS NULL`).run(id, this.token);
        });
    }
    clearAbandoned(expected: JournalRecord): boolean {
        return this.transaction(() => {
            const row = this.find(expected.id);
            if (!row || row.state !== 'PREPARING' || row.owner !== expected.owner || row.digest !== expected.digest
                || parseJsonObject(row.requestJson).relay !== undefined)
                return false;
            this.requireUnsigned(row);
            if (this.ownerAlive(row.owner))
                fail('PAYMENT_IN_PROGRESS');
            this.db.prepare('DELETE FROM operations WHERE id=? AND blockHash IS NULL').run(row.id);
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
