import { assertPrivatePermissions, securePrivatePermissions } from '@attocash/cli/internal-marketplace';
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from 'node:fs';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const PROFILE_DATABASE_BUSY_TIMEOUT_MS = 5_000;

export type AuthMode = 'controller-session' | 'scoped-api-key';
export type RefreshState = 'READY' | 'IN_FLIGHT' | 'UNKNOWN';

export interface MarketplaceProfile {
  id: string;
  origin: string;
  audience: string;
  accountId: string;
  agentId: string;
  identityId: string;
  controllerNetwork: 'ATTO' | 'NANO';
  controllerAddress: string;
  controllerIndex: number;
  authMode: AuthMode;
  apiKey: string | null;
  apiScopes: string[];
  publishAttoLimit: string | null;
  publishXnoLimit: string | null;
  productPublishAttoLimit: string | null;
  productPublishXnoLimit: string | null;
  applyAttoLimit: string | null;
  applyXnoLimit: string | null;
  purchaseAttoLimit: string | null;
  purchaseXnoLimit: string | null;
  accessToken: string | null;
  accessExpiresAt: number | null;
  refreshToken: string | null;
  refreshExpiresAt: number | null;
  refreshState: RefreshState;
  refreshAttemptId: string | null;
}

export interface NewProfile extends Omit<MarketplaceProfile,
  'controllerIndex' | 'apiKey' | 'apiScopes' | 'publishAttoLimit' | 'publishXnoLimit' | 'applyAttoLimit' | 'applyXnoLimit' |
  'productPublishAttoLimit' | 'productPublishXnoLimit' | 'purchaseAttoLimit' | 'purchaseXnoLimit' |
  'accessToken' | 'accessExpiresAt' | 'refreshToken' | 'refreshExpiresAt' | 'refreshState' | 'refreshAttemptId'> {
  controllerIndex?: number;
  apiKey?: string | null;
  apiScopes?: string[];
  publishAttoLimit?: string | null;
  publishXnoLimit?: string | null;
  productPublishAttoLimit?: string | null;
  productPublishXnoLimit?: string | null;
  applyAttoLimit?: string | null;
  applyXnoLimit?: string | null;
  purchaseAttoLimit?: string | null;
  purchaseXnoLimit?: string | null;
  accessToken?: string | null;
  accessExpiresAt?: number | null;
  refreshToken?: string | null;
  refreshExpiresAt?: number | null;
}

export interface MutationIdentity {
  profileId: string;
  requestId: string;
  operation: string;
  target: string;
  requestHash: string;
}

export class ProfileError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export class MarketplaceProfileStore {
  private readonly db: DatabaseSync;

  constructor(readonly home: string) {
    assertProfileFiles(home);
    this.db = new DatabaseSync(join(home, 'profiles.sqlite'));
    try { this.assertCurrentSchema(); } catch (error) { this.db.close(); throw error; }
    this.db.exec(`PRAGMA busy_timeout=${PROFILE_DATABASE_BUSY_TIMEOUT_MS};`);
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        origin TEXT NOT NULL,
        audience TEXT NOT NULL,
        account_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        identity_id TEXT NOT NULL,
        controller_network TEXT NOT NULL CHECK (controller_network IN ('ATTO','NANO')),
        controller_address TEXT NOT NULL,
        controller_index INTEGER NOT NULL DEFAULT 0,
        auth_mode TEXT NOT NULL CHECK (auth_mode IN ('controller-session','scoped-api-key')),
        api_key TEXT,
        api_scopes TEXT NOT NULL DEFAULT '[]',
        publish_atto_limit TEXT,
        publish_xno_limit TEXT,
        product_publish_atto_limit TEXT,
        product_publish_xno_limit TEXT,
        apply_atto_limit TEXT,
        apply_xno_limit TEXT,
        purchase_atto_limit TEXT,
        purchase_xno_limit TEXT,
        access_token TEXT,
        access_expires_at INTEGER,
        refresh_token TEXT,
        refresh_expires_at INTEGER,
        refresh_state TEXT NOT NULL DEFAULT 'READY' CHECK (refresh_state IN ('READY','IN_FLIGHT','UNKNOWN')),
        refresh_attempt_id TEXT
      );
      CREATE TABLE IF NOT EXISTS mutations (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        target TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('PENDING','COMPLETE')),
        result_identity TEXT,
        PRIMARY KEY(profile_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS handoffs (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        handle TEXT NOT NULL,
        kind TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        private_payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY(profile_id, handle)
      );
      CREATE TABLE IF NOT EXISTS setup_state (
        profile_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        private_payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS issued_credentials (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        api_key_id TEXT NOT NULL,
        api_key TEXT NOT NULL,
        scopes TEXT NOT NULL,
        publish_atto_limit TEXT,
        publish_xno_limit TEXT,
        product_publish_atto_limit TEXT,
        product_publish_xno_limit TEXT,
        apply_atto_limit TEXT,
        apply_xno_limit TEXT,
        purchase_atto_limit TEXT,
        purchase_xno_limit TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(profile_id, api_key_id)
      );
    `);
    if (process.platform !== 'win32') assertProfileFiles(home);
  }

  static async open(home: string): Promise<MarketplaceProfileStore> {
    home = resolve(home);
    // Secure the directory before SQLite can create its database or journal.
    ensureProfileHome(home);
    if (process.platform !== 'win32') {
      try { chmodSync(home, 0o700); }
      catch { throw new ProfileError('PROFILE_PERMISSIONS', 'The Marketplace MCP profile directory permissions could not be secured.'); }
    }
    const database = join(home, 'profiles.sqlite');
    try {
      const info = lstatSync(database);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new ProfileError('PROFILE_PATH', 'The Marketplace MCP database must be a regular private file.');
      if (process.platform !== 'win32') {
        try { chmodSync(database, 0o600); }
        catch { throw new ProfileError('PROFILE_PERMISSIONS', 'The Marketplace MCP database permissions could not be secured.'); }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!assertPrivateProfileFile(database, true)) {
      assertPrivatePermissions(home, 'directory');
      let descriptor: number | undefined;
      try {
        descriptor = openSync(database, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        if (process.platform !== 'win32') securePrivatePermissions(database, 'file');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        assertPrivateProfileFile(database, false);
      } finally { if (descriptor !== undefined) closeSync(descriptor); }
    }
    return new MarketplaceProfileStore(home);
  }

  /** Opens only public wallet preferences; no profile/session data or migrations are read. */
  static openWalletPreferences(home: string, readOnly: boolean): DatabaseSync | undefined {
    if (!assertWalletDirectory(home, readOnly)) return undefined;
    const database = join(home, 'profiles.sqlite');
    if (!assertPrivateProfileFile(database, true)) {
      if (readOnly) return undefined;
      try {
        const descriptor = openSync(database, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { if (process.platform !== 'win32') securePrivatePermissions(database, 'file'); } finally { closeSync(descriptor); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        assertPrivateProfileFile(database, false);
      }
    }
    for (const suffix of ['-journal', '-wal', '-shm']) assertPrivateProfileFile(database + suffix, true);
    const before = lstatSync(database);
    const db = new DatabaseSync(database, { readOnly, defensive: true });
    try {
      db.exec(`PRAGMA busy_timeout=${PROFILE_DATABASE_BUSY_TIMEOUT_MS}; PRAGMA trusted_schema=OFF;`);
      if (readOnly) db.exec('PRAGMA query_only=ON;');
      const after = lstatSync(database);
      if (before.dev !== after.dev || before.ino !== after.ino) throw walletPathError();
      assertPrivateProfileFile(database, false);
      return db;
    } catch (error) { db.close(); throw error; }
  }

  close(): void { this.db.close(); }

  createProfile(profile: NewProfile): void {
    assertProfileId(profile.id);
    assertOrigin(profile.origin);
    if (!/^[^\r\n\0]{1,255}$/.test(profile.audience) || profile.audience.trim()!==profile.audience) {
      throw new ProfileError('PROFILE_AUDIENCE','The configured Marketplace audience must be one exact nonempty line of at most 255 characters.');
    }
    assertUuid(profile.accountId, 'account');
    assertUuid(profile.agentId, 'agent');
    assertUuid(profile.identityId, 'identity');
    const validAddress = profile.controllerNetwork === 'ATTO'
      ? /^atto:\/\/[a-z2-7]{61}$/.test(profile.controllerAddress)
      : /^(?:nano|xrb)_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/.test(profile.controllerAddress);
    if (!validAddress) throw new ProfileError('CONTROLLER_ADDRESS', `The configured ${profile.controllerNetwork} controller address is invalid.`);
    const maximumIndex = profile.controllerNetwork === 'ATTO' ? 0x7fff_ffff : 0xffff_ffff;
    if (profile.controllerIndex !== undefined && (!Number.isSafeInteger(profile.controllerIndex) || profile.controllerIndex < 0 || profile.controllerIndex > maximumIndex)) {
      throw new ProfileError('CONTROLLER_INDEX', `The ${profile.controllerNetwork} controller wallet index must be from 0 through ${maximumIndex}.`);
    }
    this.transaction(() => {
      this.db.prepare(`INSERT INTO profiles (
        id,origin,audience,account_id,agent_id,identity_id,controller_network,controller_address,controller_index,
        auth_mode,api_key,api_scopes,publish_atto_limit,publish_xno_limit,product_publish_atto_limit,product_publish_xno_limit,
        apply_atto_limit,apply_xno_limit,purchase_atto_limit,purchase_xno_limit,access_token,access_expires_at,refresh_token,refresh_expires_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        profile.id, profile.origin, profile.audience, profile.accountId, profile.agentId, profile.identityId,
        profile.controllerNetwork, profile.controllerAddress, profile.controllerIndex ?? 0, profile.authMode, profile.apiKey ?? null,
        JSON.stringify(profile.apiScopes ?? []), profile.publishAttoLimit ?? null,
        profile.publishXnoLimit ?? null, profile.productPublishAttoLimit ?? null, profile.productPublishXnoLimit ?? null,
        profile.applyAttoLimit ?? null, profile.applyXnoLimit ?? null,
        profile.purchaseAttoLimit ?? null, profile.purchaseXnoLimit ?? null,
        profile.accessToken ?? null, profile.accessExpiresAt ?? null, profile.refreshToken ?? null,
        profile.refreshExpiresAt ?? null,
      );
    });
  }

  getProfile(id: string): MarketplaceProfile {
    assertProfileId(id);
    const row = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new ProfileError('PROFILE_REQUIRED', 'Configure a Marketplace MCP profile in the local terminal first.');
    return profileFromRow(row);
  }

  listProfileIds(): string[] {
    return (this.db.prepare('SELECT id FROM profiles ORDER BY id').all() as Array<{id: string}>).map(row => row.id);
  }

  needsReauthentication(id: string): boolean {
    const profile = this.getProfile(id);
    if (profile.authMode !== 'controller-session') return false;
    if (profile.refreshState === 'UNKNOWN') return true;
    if (profile.accessToken && profile.accessExpiresAt && profile.accessExpiresAt > Date.now() + 30_000) return false;
    return profile.refreshState !== 'READY' || !profile.refreshToken || !profile.refreshExpiresAt || profile.refreshExpiresAt <= Date.now();
  }

  startReauthentication(id: string, privatePayload: string, expectedPayload: string | null): void {
    this.transaction(() => {
      if (this.getProfile(id).authMode !== 'controller-session') throw new ProfileError('AUTH_MODE', 'Reauthentication requires the original controller-session profile.');
      const pending = this.getSetupState(id);
      if ((pending?.privatePayload ?? null) !== expectedPayload) throw new ProfileError('SETUP_BUSY', 'Another local setup changed this profile. Inspect its current setup before continuing.');
      if (pending && JSON.parse(pending.privatePayload).reauthenticate !== true) throw new ProfileError('SETUP_IN_PROGRESS', 'Complete the existing setup before reauthenticating this profile.');
      this.db.prepare(`INSERT INTO setup_state(profile_id,state,private_payload,updated_at) VALUES(?,'LOGIN_READY',?,?)
        ON CONFLICT(profile_id) DO UPDATE SET state='LOGIN_READY',private_payload=excluded.private_payload,updated_at=excluded.updated_at`)
        .run(id, privatePayload, Date.now());
      // Invalidate an older refresh attempt; its late acknowledgement cannot replace the new login.
      this.db.prepare(`UPDATE profiles SET refresh_state='UNKNOWN',refresh_attempt_id=NULL WHERE id=?`).run(id);
    });
  }

  completeReauthentication(profile: NewProfile, expectedPayload: string): void {
    this.transaction(() => {
      const original = this.getProfile(profile.id);
      const fields = ['origin','audience','accountId','agentId','identityId','controllerNetwork','controllerAddress','controllerIndex'] as const;
      if (original.authMode !== 'controller-session' || profile.authMode !== 'controller-session'
        || fields.some(field => original[field] !== profile[field])) throw new ProfileError('PROFILE_CONFLICT', 'The renewed session must belong to the original account and controller.');
      const pending = this.getSetupState(profile.id);
      if (pending?.state !== 'LOGIN_SUBMITTING' || pending.privatePayload !== expectedPayload) throw new ProfileError('SETUP_BUSY', 'This login no longer owns the profile setup. Continue the current setup instead.');
      if (!profile.accessToken || !profile.refreshToken || !profile.accessExpiresAt || !profile.refreshExpiresAt) throw new ProfileError('SETUP_RESPONSE', 'The renewed session is incomplete.');
      this.db.prepare(`UPDATE profiles SET access_token=?,access_expires_at=?,refresh_token=?,refresh_expires_at=?,refresh_state='READY',refresh_attempt_id=NULL WHERE id=?`)
        .run(profile.accessToken, profile.accessExpiresAt, profile.refreshToken, profile.refreshExpiresAt, profile.id);
      this.db.prepare('DELETE FROM setup_state WHERE profile_id=?').run(profile.id);
    });
  }

  replaceSessionWithApiKey(id: string, apiKey: string, scopes: string[], ceilings: {
    publishAttoLimit?: string; publishXnoLimit?: string; applyAttoLimit?: string; applyXnoLimit?: string;
    productPublishAttoLimit?: string; productPublishXnoLimit?: string;
    purchaseAttoLimit?: string; purchaseXnoLimit?: string;
  }): void {
    this.transaction(() => {
      const result = this.db.prepare(`UPDATE profiles SET auth_mode='scoped-api-key',api_key=?,api_scopes=?,
        publish_atto_limit=?,publish_xno_limit=?,product_publish_atto_limit=?,product_publish_xno_limit=?,apply_atto_limit=?,apply_xno_limit=?,purchase_atto_limit=?,purchase_xno_limit=?,access_token=NULL,access_expires_at=NULL,
        refresh_token=NULL,refresh_expires_at=NULL,refresh_state='READY',refresh_attempt_id=NULL
        WHERE id=? AND auth_mode='controller-session'`).run(apiKey, JSON.stringify([...new Set(scopes)].sort()),
        ceilings.publishAttoLimit ?? null, ceilings.publishXnoLimit ?? null,
        ceilings.productPublishAttoLimit ?? null, ceilings.productPublishXnoLimit ?? null,
        ceilings.applyAttoLimit ?? null, ceilings.applyXnoLimit ?? null,
        ceilings.purchaseAttoLimit ?? null, ceilings.purchaseXnoLimit ?? null, id);
      if (Number(result.changes) !== 1) throw new ProfileError('AUTH_MODE', 'This profile cannot be changed to scoped API-key authority.');
    });
  }

  beginRefresh(id: string): { kind: 'fresh'; accessToken: string }
    | { kind: 'refresh'; attemptId: string; refreshToken: string } | { kind: 'busy' } {
    return this.transaction(() => {
      const profile = this.getProfile(id);
      if (profile.authMode !== 'controller-session') throw new ProfileError('AUTH_MODE', 'This profile uses a scoped API key and cannot refresh a controller session.');
      if (profile.accessToken && profile.accessExpiresAt && profile.accessExpiresAt > Date.now() + 30_000) {
        return { kind: 'fresh' as const, accessToken: profile.accessToken };
      }
      if (profile.refreshState === 'UNKNOWN') {
        throw new ProfileError('REAUTH_REQUIRED', 'A previous refresh may have rotated the controller token. Reauthenticate from the local terminal before continuing.');
      }
      if (profile.refreshState === 'IN_FLIGHT') return { kind: 'busy' as const };
      if (!profile.refreshToken || !profile.refreshExpiresAt || profile.refreshExpiresAt <= Date.now()) {
        throw new ProfileError('REAUTH_REQUIRED', 'The controller session is unavailable or expired. Reauthenticate from the local terminal.');
      }
      const attemptId = randomUUID();
      const result = this.db.prepare(`UPDATE profiles SET refresh_state='IN_FLIGHT', refresh_attempt_id=?
        WHERE id=? AND refresh_state='READY'`).run(attemptId, id);
      if (Number(result.changes) !== 1) throw new ProfileError('REFRESH_BUSY', 'Another Marketplace MCP process is refreshing this profile. Retry after it completes.');
      return { kind: 'refresh' as const, attemptId, refreshToken: profile.refreshToken };
    });
  }

  completeRefresh(id: string, attemptId: string, tokens: { accessToken: string; accessExpiresAt: number; refreshToken: string; refreshExpiresAt: number }): void {
    this.transaction(() => {
      const result = this.db.prepare(`UPDATE profiles SET access_token=?, access_expires_at=?, refresh_token=?,
        refresh_expires_at=?, refresh_state='READY', refresh_attempt_id=NULL
        WHERE id=? AND refresh_state='IN_FLIGHT' AND refresh_attempt_id=?`)
        .run(tokens.accessToken, tokens.accessExpiresAt, tokens.refreshToken, tokens.refreshExpiresAt, id, attemptId);
      if (Number(result.changes) !== 1) throw new ProfileError('REAUTH_REQUIRED', 'The refresh result no longer owns this profile. Reauthenticate from the local terminal.');
    });
  }

  failRefresh(id: string, attemptId: string): void {
    this.transaction(() => {
      this.db.prepare(`UPDATE profiles SET refresh_state='UNKNOWN'
        WHERE id=? AND refresh_state='IN_FLIGHT' AND refresh_attempt_id=?`).run(id, attemptId);
    });
  }

  beginMutation(identity: MutationIdentity, reservedResultIdentity?: string): { state: 'PENDING' | 'COMPLETE'; resultIdentity: string | null } {
    assertProfileId(identity.profileId);
    assertUuid(identity.requestId, 'request');
    return this.transaction(() => {
      const existing = this.db.prepare(`SELECT operation,target,request_hash,state,result_identity FROM mutations
        WHERE profile_id=? AND request_id=?`).get(identity.profileId, identity.requestId) as Record<string, unknown> | undefined;
      if (existing) {
        if (existing.operation !== identity.operation || existing.target !== identity.target || existing.request_hash !== identity.requestHash) {
          throw new ProfileError('IDEMPOTENCY_CONFLICT', 'This request ID is already bound to different mutation content.');
        }
        let resultIdentity = nullableString(existing.result_identity);
        if (existing.state === 'PENDING' && resultIdentity === null && reservedResultIdentity !== undefined) {
          this.db.prepare(`UPDATE mutations SET result_identity=? WHERE profile_id=? AND request_id=? AND state='PENDING' AND result_identity IS NULL`)
            .run(reservedResultIdentity, identity.profileId, identity.requestId);
          resultIdentity = reservedResultIdentity;
        }
        return { state: existing.state as 'PENDING' | 'COMPLETE', resultIdentity };
      }
      if (identity.operation==='marketplace-fund') {
        const profile=this.getProfile(identity.profileId);
        if (identity.target===profile.accountId) {
          const alias=this.db.prepare(`SELECT p.id,m.operation FROM profiles p
            JOIN mutations m ON m.profile_id=p.id
            WHERE p.id<>? AND p.origin=? AND p.account_id=? AND p.identity_id=?
              AND m.request_id=? AND m.operation='marketplace-fund'
              AND m.target=p.account_id
            ORDER BY p.id,m.operation LIMIT 1`).get(profile.id,profile.origin,profile.accountId,profile.identityId,
            identity.requestId) as {id:string;operation:string}|undefined;
          if (alias) {
            throw new ProfileError('FUNDING_PROFILE_ALIAS',
              `This requestId already has a ${alias.operation} mutation under matching local profile \`${alias.id}\`. Select that original profile and check marketplace_funding_status with the same requestId. No mutation was reserved in the current profile, and no Marketplace or wallet request, signing, or payment was performed.`);
          }
        }
      }
      this.db.prepare(`INSERT INTO mutations(profile_id,request_id,operation,target,request_hash,state,result_identity)
        VALUES(?,?,?,?,?,'PENDING',?)`).run(identity.profileId, identity.requestId, identity.operation, identity.target, identity.requestHash,
        reservedResultIdentity ?? null);
      return { state: 'PENDING', resultIdentity: reservedResultIdentity ?? null };
    });
  }

  getMutation(identity: MutationIdentity): { state: 'PENDING' | 'COMPLETE'; resultIdentity: string | null } | null {
    assertProfileId(identity.profileId);
    assertUuid(identity.requestId, 'request');
    const existing = this.db.prepare(`SELECT operation,target,request_hash,state,result_identity FROM mutations
      WHERE profile_id=? AND request_id=?`).get(identity.profileId, identity.requestId) as Record<string, unknown> | undefined;
    if (!existing) return null;
    if (existing.operation !== identity.operation || existing.target !== identity.target || existing.request_hash !== identity.requestHash) {
      throw new ProfileError('IDEMPOTENCY_CONFLICT', 'This request ID is already bound to different mutation content.');
    }
    return { state: existing.state as 'PENDING' | 'COMPLETE', resultIdentity: existing.result_identity as string | null };
  }

  getMutationByRequestId(profileId: string, requestId: string): {
    operation: string; target: string; requestHash: string; state: 'PENDING' | 'COMPLETE'; resultIdentity: string | null;
  } | null {
    assertProfileId(profileId);
    assertUuid(requestId, 'request');
    const row = this.db.prepare(`SELECT operation,target,request_hash,state,result_identity FROM mutations
      WHERE profile_id=? AND request_id=?`).get(profileId, requestId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { operation: String(row.operation), target: String(row.target), requestHash: String(row.request_hash),
      state: row.state as 'PENDING' | 'COMPLETE', resultIdentity: nullableString(row.result_identity) };
  }

  listFundingRecoveryProfileAliases(profile: Pick<MarketplaceProfile, 'id' | 'origin' | 'accountId' | 'identityId'>,
    requestId: string): Array<{profileId:string}> {
    assertProfileId(profile.id);
    assertUuid(requestId, 'request');
    const rows=this.db.prepare(`SELECT p.id FROM profiles p JOIN mutations m ON m.profile_id=p.id
      WHERE p.id<>? AND p.origin=? AND p.account_id=? AND p.identity_id=? AND m.request_id=?
        AND m.operation='marketplace-fund' AND m.target=p.account_id ORDER BY p.id`)
      .all(profile.id,profile.origin,profile.accountId,profile.identityId,requestId) as Array<{id:string}>;
    return rows.map(row => ({profileId:String(row.id)}));
  }

  setPendingMutationResultIdentity(profileId: string, requestId: string, requestHash: string,
    expectedResultIdentity: string | null, resultIdentity: string): void {
    assertProfileId(profileId);
    assertUuid(requestId, 'request');
    this.transaction(() => {
      const existing = this.db.prepare(`SELECT request_hash,state,result_identity FROM mutations
        WHERE profile_id=? AND request_id=?`).get(profileId, requestId) as Record<string, unknown> | undefined;
      if (!existing || existing.request_hash !== requestHash || existing.state !== 'PENDING') {
        throw new ProfileError('IDEMPOTENCY_CONFLICT', 'Mutation journal ownership changed before command recovery was saved.');
      }
      const current = nullableString(existing.result_identity);
      if (current === resultIdentity) return;
      if (current !== expectedResultIdentity) {
        throw new ProfileError('IDEMPOTENCY_CONFLICT', 'Another recovery command already owns this pending mutation.');
      }
      const updated = this.db.prepare(`UPDATE mutations SET result_identity=?
        WHERE profile_id=? AND request_id=? AND request_hash=? AND state='PENDING' AND result_identity IS ?`)
        .run(resultIdentity, profileId, requestId, requestHash, expectedResultIdentity);
      if (Number(updated.changes) !== 1) {
        throw new ProfileError('IDEMPOTENCY_CONFLICT', 'Mutation journal ownership changed before command recovery was saved.');
      }
    });
  }

  completeMutation(profileId: string, requestId: string, requestHash: string, resultIdentity: string): void {
    this.transaction(() => {
      const result = this.db.prepare(`UPDATE mutations SET state='COMPLETE',result_identity=?
        WHERE profile_id=? AND request_id=? AND request_hash=? AND state='PENDING'`)
        .run(resultIdentity, profileId, requestId, requestHash);
      if (Number(result.changes) !== 1) {
        const existing = this.db.prepare(`SELECT state,request_hash,result_identity FROM mutations
          WHERE profile_id=? AND request_id=?`).get(profileId, requestId) as Record<string, unknown> | undefined;
        if (existing?.state === 'COMPLETE' && existing.request_hash === requestHash && existing.result_identity === resultIdentity) return;
        throw new ProfileError('IDEMPOTENCY_CONFLICT', 'Mutation journal ownership changed before completion.');
      }
    });
  }

  putSetupState(profileId: string, state: string, privatePayload: string): void {
    this.transaction(() => this.db.prepare(`INSERT INTO setup_state(profile_id,state,private_payload,updated_at)
      VALUES(?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET state=excluded.state,
      private_payload=excluded.private_payload,updated_at=excluded.updated_at`).run(profileId, state, privatePayload, Date.now()));
  }

  createSetupState(profileId: string, state: string, privatePayload: string): void {
    this.transaction(() => {
      try { this.db.prepare(`INSERT INTO setup_state(profile_id,state,private_payload,updated_at) VALUES(?,?,?,?)`)
        .run(profileId,state,privatePayload,Date.now()); }
      catch { throw new ProfileError('SETUP_IN_PROGRESS','Another setup already owns this profile ID. Inspect its local state before continuing.'); }
    });
  }

  transitionSetupState(profileId: string, expectedState: string, state: string, privatePayload: string, expectedPayload?: string): boolean {
    return this.transaction(() => {
      const result=this.db.prepare(`UPDATE setup_state SET state=?,private_payload=?,updated_at=?
        WHERE profile_id=? AND state=?${expectedPayload===undefined?'':' AND private_payload=?'}`)
        .run(state,privatePayload,Date.now(),profileId,expectedState,...(expectedPayload===undefined?[]:[expectedPayload]));
      return Number(result.changes)===1;
    });
  }

  getSetupState(profileId: string): { state: string; privatePayload: string } | undefined {
    const row = this.db.prepare('SELECT state,private_payload FROM setup_state WHERE profile_id=?').get(profileId) as {state: string; private_payload: string} | undefined;
    return row ? { state: row.state, privatePayload: row.private_payload } : undefined;
  }

  deleteSetupState(profileId: string): void {
    this.transaction(() => this.db.prepare('DELETE FROM setup_state WHERE profile_id=?').run(profileId));
  }

  putIssuedCredential(profileId: string, credential: {
    apiKeyId: string; apiKey: string; scopes: string[]; publishAttoLimit?: string | null;
    publishXnoLimit?: string | null; applyAttoLimit?: string | null; applyXnoLimit?: string | null;
    productPublishAttoLimit?: string | null; productPublishXnoLimit?: string | null;
    purchaseAttoLimit?: string | null; purchaseXnoLimit?: string | null;
  }): void {
    assertUuid(credential.apiKeyId, 'credential');
    if (credential.apiKey.length < 16 || credential.apiKey.length > 8192 || /[\r\n\0]/.test(credential.apiKey)) {
      throw new ProfileError('CREDENTIAL_RESPONSE', 'Marketplace returned an invalid one-time API key.');
    }
    this.transaction(() => {
      const existing = this.db.prepare(`SELECT api_key FROM issued_credentials WHERE profile_id=? AND api_key_id=?`)
        .get(profileId, credential.apiKeyId) as {api_key:string} | undefined;
      if (existing) {
        if (existing.api_key !== credential.apiKey) throw new ProfileError('CREDENTIAL_CONFLICT', 'A different one-time credential is already saved for this ID.');
        return;
      }
      this.db.prepare(`INSERT INTO issued_credentials(profile_id,api_key_id,api_key,scopes,publish_atto_limit,
        publish_xno_limit,product_publish_atto_limit,product_publish_xno_limit,apply_atto_limit,apply_xno_limit,
        purchase_atto_limit,purchase_xno_limit,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        profileId, credential.apiKeyId, credential.apiKey, JSON.stringify([...new Set(credential.scopes)].sort()),
        credential.publishAttoLimit ?? null, credential.publishXnoLimit ?? null,
        credential.productPublishAttoLimit ?? null, credential.productPublishXnoLimit ?? null,
        credential.applyAttoLimit ?? null,
        credential.applyXnoLimit ?? null, credential.purchaseAttoLimit ?? null, credential.purchaseXnoLimit ?? null, Date.now());
    });
  }

  getIssuedCredential(profileId: string, apiKeyId: string): {
    apiKeyId:string; apiKey:string; scopes:string[]; publishAttoLimit:string|null; publishXnoLimit:string|null; applyAttoLimit:string|null; applyXnoLimit:string|null;
    productPublishAttoLimit:string|null; productPublishXnoLimit:string|null;
    purchaseAttoLimit:string|null; purchaseXnoLimit:string|null;
  } {
    assertUuid(apiKeyId, 'credential');
    const row = this.db.prepare(`SELECT api_key_id,api_key,scopes,publish_atto_limit,publish_xno_limit,product_publish_atto_limit,product_publish_xno_limit,apply_atto_limit,apply_xno_limit,
      purchase_atto_limit,purchase_xno_limit
      FROM issued_credentials WHERE profile_id=? AND api_key_id=?`).get(profileId, apiKeyId) as Record<string,unknown>|undefined;
    if (!row) throw new ProfileError('CREDENTIAL_NOT_FOUND', 'No locally saved one-time API key matches this credential ID.');
    return { apiKeyId:String(row.api_key_id), apiKey:String(row.api_key), scopes:parseScopes(row.scopes),
      publishAttoLimit:nullableString(row.publish_atto_limit), publishXnoLimit:nullableString(row.publish_xno_limit),
      productPublishAttoLimit:nullableString(row.product_publish_atto_limit), productPublishXnoLimit:nullableString(row.product_publish_xno_limit),
      applyAttoLimit:nullableString(row.apply_atto_limit), applyXnoLimit:nullableString(row.apply_xno_limit),
      purchaseAttoLimit:nullableString(row.purchase_atto_limit), purchaseXnoLimit:nullableString(row.purchase_xno_limit) };
  }

  deleteIssuedCredential(profileId: string, apiKeyId: string): void {
    this.transaction(() => this.db.prepare('DELETE FROM issued_credentials WHERE profile_id=? AND api_key_id=?').run(profileId, apiKeyId));
  }

  putHandoff(profileId: string, handle: string, kind: string, requestHash: string, state: string, payload: string, expiresAt: number): void {
    this.transaction(() => {
      const existing = this.db.prepare(`SELECT kind,request_hash,private_payload FROM handoffs WHERE profile_id=? AND handle=?`)
        .get(profileId, handle) as Record<string, unknown> | undefined;
      if (existing) {
        if (existing.kind !== kind || existing.request_hash !== requestHash || existing.private_payload !== payload) {
          throw new ProfileError('HANDOFF_CONFLICT', 'This private handoff handle is already bound to different content.');
        }
        return;
      }
      this.db.prepare(`INSERT INTO handoffs(profile_id,handle,kind,request_hash,state,private_payload,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(profileId, handle, kind, requestHash, state, payload, Date.now(), expiresAt);
    });
  }

  getHandoff(profileId: string, handle: string): { kind: string; requestHash: string; state: string; privatePayload: string; expiresAt: number } {
    assertOpaqueHandle(handle);
    const row = this.db.prepare(`SELECT kind,request_hash,state,private_payload,expires_at FROM handoffs
      WHERE profile_id=? AND handle=?`).get(profileId, handle) as Record<string, unknown> | undefined;
    if (!row) throw new ProfileError('HANDOFF_NOT_FOUND', 'No matching private handoff exists for this profile.');
    return { kind: String(row.kind), requestHash: String(row.request_hash), state: String(row.state),
      privatePayload: String(row.private_payload), expiresAt: Number(row.expires_at) };
  }

  setHandoffState(profileId: string, handle: string, state: string, privatePayload?: string): void {
    this.transaction(() => {
      this.db.prepare(`UPDATE handoffs SET state=?,private_payload=COALESCE(?,private_payload)
        WHERE profile_id=? AND handle=?`).run(state, privatePayload ?? null, profileId, handle);
    });
  }

  claimHandoff(profileId: string, handle: string, expectedState: string, nextState: string): boolean {
    assertOpaqueHandle(handle);
    return this.transaction(() => {
      const result = this.db.prepare(`UPDATE handoffs SET state=? WHERE profile_id=? AND handle=? AND state=?`)
        .run(nextState, profileId, handle, expectedState);
      return Number(result.changes) === 1;
    });
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = action();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private assertCurrentSchema(): void {
    const profileSchema=this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='profiles'").get() as {sql:string}|undefined;
    if (!profileSchema) return;
    const expected={
      profiles:['id','origin','audience','account_id','agent_id','identity_id','controller_network','controller_address',
        'controller_index','auth_mode','api_key','api_scopes','publish_atto_limit','publish_xno_limit','product_publish_atto_limit',
        'product_publish_xno_limit','apply_atto_limit','apply_xno_limit','purchase_atto_limit','purchase_xno_limit','access_token',
        'access_expires_at','refresh_token','refresh_expires_at','refresh_state','refresh_attempt_id'],
      issued_credentials:['profile_id','api_key_id','api_key','scopes','publish_atto_limit','publish_xno_limit',
        'product_publish_atto_limit','product_publish_xno_limit','apply_atto_limit','apply_xno_limit','purchase_atto_limit',
        'purchase_xno_limit','created_at'],
    };
    for (const [table,names] of Object.entries(expected)) {
      const columns=this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>;
      if (columns.length!==names.length || columns.some(column=>!names.includes(column.name))) throw this.schemaError();
    }
    if (!/controller_network\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*controller_network\s+IN\s*\(\s*'ATTO'\s*,\s*'NANO'\s*\)\s*\)/i.test(profileSchema.sql)) {
      throw this.schemaError();
    }
  }

  private schemaError(): ProfileError {
    return new ProfileError('PROFILE_SCHEMA','This Marketplace MCP profile database uses an unsupported schema. Configure a fresh Marketplace MCP home; native wallet directories and their recovery state must be retained.');
  }



}

function profileFromRow(row: Record<string, unknown>): MarketplaceProfile {
  return {
    id: String(row.id), origin: String(row.origin), audience: String(row.audience), accountId: String(row.account_id),
    agentId: String(row.agent_id), identityId: String(row.identity_id), controllerNetwork: row.controller_network as 'ATTO' | 'NANO',
    controllerAddress: String(row.controller_address), controllerIndex: Number(row.controller_index), authMode: row.auth_mode as AuthMode,
    apiKey: nullableString(row.api_key), apiScopes: parseScopes(row.api_scopes),
    publishAttoLimit: nullableString(row.publish_atto_limit), publishXnoLimit: nullableString(row.publish_xno_limit),
    productPublishAttoLimit: nullableString(row.product_publish_atto_limit), productPublishXnoLimit: nullableString(row.product_publish_xno_limit),
    applyAttoLimit: nullableString(row.apply_atto_limit), applyXnoLimit: nullableString(row.apply_xno_limit),
    purchaseAttoLimit: nullableString(row.purchase_atto_limit), purchaseXnoLimit: nullableString(row.purchase_xno_limit), accessToken: nullableString(row.access_token),
    accessExpiresAt: nullableNumber(row.access_expires_at), refreshToken: nullableString(row.refresh_token),
    refreshExpiresAt: nullableNumber(row.refresh_expires_at), refreshState: row.refresh_state as RefreshState,
    refreshAttemptId: nullableString(row.refresh_attempt_id),
  };
}

function assertProfileId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(value)) throw new ProfileError('PROFILE_ID', 'Profile IDs must be 1 to 48 letters, digits, underscores or hyphens.');
}

function assertUuid(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new ProfileError('INVALID_ID', `The ${label} ID must be a canonical UUID.`);
  }
}

function assertOpaqueHandle(value: string): void {
  if (!/^[a-f0-9]{32}$/.test(value)) throw new ProfileError('HANDOFF_ID', 'Handoff IDs must be opaque 128-bit handles.');
}

function assertOrigin(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new ProfileError('PROFILE_ORIGIN', 'The Marketplace origin must be an absolute HTTPS origin.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new ProfileError('PROFILE_ORIGIN', 'The Marketplace origin must be HTTPS; HTTP is allowed only for loopback development.');
  }
}

function nullableString(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function nullableNumber(value: unknown): number | null { return typeof value === 'number' ? value : null; }
function parseScopes(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every(scope => typeof scope === 'string') ? parsed : [];
  } catch { return []; }
}

/** Validates public directory metadata without reading any wallet files or secrets. */
export function assertWalletDirectory(path: string, allowMissing = false): boolean {
  if (!isAbsolute(path) || path.length > 4096 || resolve(path) !== path
    || /[\u0000-\u001f\u007f]/.test(path)) throw walletPathError();
  if (process.platform === 'win32') {
    try { assertPrivatePermissions(path, 'directory'); return true; }
    catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw walletPathError();
      // Check existing ancestors from the root before accepting a missing setup target.
    }
  }
  let current = parse(path).root;
  for (const component of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    let info;
    try { info = lstatSync(current); }
    catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw walletPathError();
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw walletPathError();
  }
  const info = lstatSync(path);
  if (process.platform !== 'win32' && (typeof process.getuid !== 'function'
    || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700)) throw walletPathError();
  return true;
}

function assertPrivateProfileFile(path: string, allowMissing: boolean): boolean {
  let info;
  try { info = lstatSync(path); }
  catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw walletPathError();
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || (process.platform !== 'win32' && (typeof process.getuid !== 'function'
      || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600))) throw walletPathError();
  return true;
}

/** Check existing SQLite artifacts before SQLite opens them. */
function assertProfileFiles(home: string): void {
  assertWalletDirectory(home);
  const database = join(home, 'profiles.sqlite');
  assertPrivateProfileFile(database, false);
  for (const suffix of ['-journal', '-wal', '-shm']) assertPrivateProfileFile(database + suffix, true);
}

function walletPathError(): ProfileError {
  return new ProfileError('WALLET_SETUP_REQUIRED', 'The selected Marketplace wallet or its private profile storage is missing or unsafe. Review the wallet selection in the local terminal.');
}

export function requireSession(profile: MarketplaceProfile): void {
  if (profile.authMode!=='controller-session') throw new ProfileError('SETUP_REQUIRED','This operation requires a controller-session profile. Reconfigure a separate Marketplace MCP profile with `atto-marketplace-mcp setup --profile <new-id> --mode controller-session`; scoped API-key profiles do not gain funding authority.');
}

function ensureProfileHome(home: string): void {
  let current = parse(home).root;
  for (const component of home.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    let created = false;
    try { mkdirSync(current, { mode: 0o700 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ProfileError('PROFILE_PATH', 'The Marketplace MCP profile directory must be a real directory.');
    if (created) securePrivatePermissions(current, 'directory');
  }

}
