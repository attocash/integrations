import {
  addressPublicKey, canonicalAddress, canonicalHash, hexBytes, NanoStateBlock,
  rawAmount, requiredDifficulty, strictReceiveDifficulty, upperHex, validWork,
  verify, ZERO_HASH, type NanoNetwork,
} from './protocol.js';

export const DEV_GENESIS_HASH = '04270D7F11C4B2B472F2854C5A59F2A7E84226CE9ED799DE75744BD7D85FC9D9';
export const DEV_GENESIS_ACCOUNT = 'nano_3e3j5tkog48pnny9dmfzj1r16pg8t1e76dz5tmac6iq689wyjfpiij4txtdo';
export const MAIN_GENESIS_HASH = '991CF190094C00F0B68E2E5F75F6BEE95A2E0BD93CEAA4A6734DB9F19B728948';
export const MAIN_GENESIS_ACCOUNT = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
const DEV_EPOCH_SIGNER = addressPublicKey(DEV_GENESIS_ACCOUNT);
const MAIN_EPOCH_1_SIGNER = hexBytes('E89208DD038FBB269987689621D52292AE9C35941A7484756ECCED92A65093BA', 32);
const MAIN_EPOCH_2_SIGNER = addressPublicKey('nano_3qb6o6i1tkzr6jwr5s7eehfxwg9x6eemitdinbpi7u8bjjwsgqfj4wzser3x');
const MAX_RESPONSE_BYTES = 1_000_000;

export class NanoRpcError extends Error {
  constructor(readonly code = 'RPC_UNAVAILABLE', message = 'The configured Nano RPC returned unavailable or invalid evidence.') {
    super(message);
    this.name = 'NanoRpcError';
  }
}

export interface NanoConfirmedAccount {
  frontier: string;
  balance: bigint;
  representative: string;
  epoch: number;
}

export interface NanoAccountSnapshot extends NanoConfirmedAccount {
  confirmedFrontier: string;
  confirmedBalance: bigint;
  confirmedRepresentative: string;
}

export interface NanoBlockEvidence {
  block: NanoStateBlock;
  confirmed: boolean;
  subtype: string;
  blockAccount: string;
  successor?: string;
}

export interface NanoReceivable {
  hash: string;
  amount: bigint;
  source: string;
}

export function requireConfirmedFrontier(snapshot: NanoAccountSnapshot): NanoConfirmedAccount {
  if (snapshot.frontier !== snapshot.confirmedFrontier || snapshot.balance !== snapshot.confirmedBalance ||
      snapshot.representative !== snapshot.confirmedRepresentative) {
    throw new NanoRpcError('SOURCE_FRONTIER_UNCONFIRMED', 'The configured Nano source has unconfirmed state and is fenced.');
  }
  return { frontier: snapshot.confirmedFrontier, balance: snapshot.confirmedBalance,
    representative: snapshot.confirmedRepresentative, epoch: snapshot.epoch };
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}

/** JSON.parse semantics with duplicate-field rejection, bounded depth, and no trailing tokens. */
export function parseJsonObject(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('JSON input exceeds its byte limit');
  // JSON.parse performs complete syntax validation. The second pass checks the
  // source keys before duplicate names can be discarded by object construction.
  const result = objectValue(JSON.parse(text));
  let offset = 0;
  const stringToken = /"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const primitive = /(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/y;
  const whitespace = () => { while (/[\x20\x09\x0a\x0d]/.test(text[offset] ?? '!')) offset++; };
  const quoted = (): string => {
    whitespace();
    stringToken.lastIndex = offset;
    const token = stringToken.exec(text);
    if (!token) throw new Error('Invalid JSON string');
    offset = stringToken.lastIndex;
    return JSON.parse(token[0]) as string;
  };
  const scan = (depth: number): void => {
    if (depth > 64) throw new Error('JSON nesting exceeds its limit');
    whitespace();
    const character = text[offset];
    if (character === '{') {
      offset++;
      whitespace();
      if (text[offset] === '}') { offset++; return; }
      const keys = new Set<string>();
      while (true) {
        const key = quoted();
        if (keys.has(key)) throw new Error('Duplicate JSON field');
        keys.add(key);
        whitespace();
        if (text[offset++] !== ':') throw new Error('Invalid JSON object');
        scan(depth + 1);
        whitespace();
        if (text[offset] === '}') { offset++; return; }
        if (text[offset++] !== ',') throw new Error('Invalid JSON object');
      }
    }
    if (character === '[') {
      offset++;
      whitespace();
      if (text[offset] === ']') { offset++; return; }
      while (true) {
        scan(depth + 1);
        whitespace();
        if (text[offset] === ']') { offset++; return; }
        if (text[offset++] !== ',') throw new Error('Invalid JSON array');
      }
    }
    if (character === '"') { quoted(); return; }
    primitive.lastIndex = offset;
    if (!primitive.exec(text)) throw new Error('Invalid JSON value');
    offset = primitive.lastIndex;
  };
  scan(0);
  whitespace();
  if (offset !== text.length) throw new Error('Trailing JSON input');
  return result;
}

function textField(value: Record<string, unknown>, name: string): string {
  const field = value[name];
  if (typeof field !== 'string' || field.length < 1 || field.length > 4096) throw new NanoRpcError();
  return field;
}

export function epochLink(epoch: number): string {
  if (epoch !== 1 && epoch !== 2) throw new Error('Unsupported Nano epoch');
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode(`epoch v${epoch} block`));
  return upperHex(bytes);
}

export class NanoRpcClient {
  readonly rpcUrl: URL;

  constructor(url: string | URL, readonly network: NanoNetwork) {
    this.rpcUrl = new URL(url);
    if (!['http:', 'https:'].includes(this.rpcUrl.protocol) || this.rpcUrl.username || this.rpcUrl.password ||
        this.rpcUrl.hash || !['nano:dev', 'nano:mainnet'].includes(network)) throw new NanoRpcError();
  }

  async requirePinnedNetwork(): Promise<void> {
    const response = await this.call('version');
    const name = this.network === 'nano:dev' ? 'dev' : 'live';
    const genesis = this.network === 'nano:dev' ? DEV_GENESIS_HASH : MAIN_GENESIS_HASH;
    if (response.network !== name || canonicalHash(textField(response, 'network_identifier')) !== genesis) {
      throw new NanoRpcError();
    }
  }

  async accountSnapshot(address: string): Promise<NanoAccountSnapshot> {
    const snapshot = await this.accountSnapshotOrNotFound(address);
    if (snapshot === null) throw new NanoRpcError('SOURCE_NOT_FUNDED', 'The Nano account is not opened.');
    return snapshot;
  }

  async accountSnapshotOrNotFound(address: string): Promise<NanoAccountSnapshot | null> {
    const value = await this.response('account_info', { account: canonicalAddress(address), include_confirmed: 'true', representative: 'true' });
    if (Object.hasOwn(value, 'error')) {
      if (Object.keys(value).length === 1 && value.error === 'Account not found') return null;
      throw new NanoRpcError();
    }
    try {
      const version = textField(value, 'account_version');
      if (!/^[012]$/.test(version)) throw new NanoRpcError();
      return { frontier: canonicalHash(textField(value, 'frontier')),
        confirmedFrontier: canonicalHash(textField(value, 'confirmed_frontier')),
        balance: rawAmount(value.balance), confirmedBalance: rawAmount(value.confirmed_balance),
        representative: canonicalAddress(textField(value, 'representative')),
        confirmedRepresentative: canonicalAddress(textField(value, 'confirmed_representative')), epoch: Number(version) };
    } catch { throw new NanoRpcError(); }
  }

  async confirmedAccount(address: string): Promise<NanoConfirmedAccount> {
    return requireConfirmedFrontier(await this.accountSnapshot(address));
  }

  async blockInfo(hash: string): Promise<NanoBlockEvidence | null> {
    const requestedHash = canonicalHash(hash);
    const value = await this.response('block_info', { hash: requestedHash, json_block: 'true', include_linked_account: 'true' });
    if (Object.hasOwn(value, 'error')) {
      if (Object.keys(value).length === 1 && value.error === 'Block not found') return null;
      throw new NanoRpcError();
    }
    return this.parseBlockEvidence(value, requestedHash);
  }

  private parseBlockEvidence(value: Record<string, unknown>, requestedHash: string): NanoBlockEvidence {
    try {
      const contents = typeof value.contents === 'string' ? parseJsonObject(value.contents) : objectValue(value.contents);
      const block = NanoStateBlock.parse(contents);
      if (block.hash !== requestedHash) throw new NanoRpcError();
      const blockAccount = canonicalAddress(textField(value, 'block_account'));
      if (block.account !== blockAccount) throw new NanoRpcError();
      const confirmed = value.confirmed === true || value.confirmed === 'true';
      if (!(confirmed || value.confirmed === false || value.confirmed === 'false')) throw new NanoRpcError();
      const subtype = textField(value, 'subtype');
      const successor = value.successor === undefined || value.successor === '' ? undefined : canonicalHash(textField(value, 'successor'));
      return { block, confirmed, subtype, blockAccount, ...(successor ? { successor } : {}) };
    } catch { throw new NanoRpcError(); }
  }

  async generateWork(root: string, epoch: number, receive = false): Promise<string> {
    const canonicalRoot = canonicalHash(root);
    const difficulty = requiredDifficulty(this.network, epoch, receive);
    const value = await this.call('work_generate', { hash: canonicalRoot, difficulty });
    const work = textField(value, 'work').toUpperCase();
    if (!validWork(this.network, epoch, receive, canonicalRoot, work)) throw new NanoRpcError();
    return work;
  }

  async generateOpenWork(root: string): Promise<string> {
    // The source send epoch is not guaranteed by receivable RPC. Epoch-0 receive
    // work is the strictest supported receive threshold, valid across epochs.
    const canonicalRoot = canonicalHash(root);
    const value = await this.call('work_generate', { hash: canonicalRoot, difficulty: strictReceiveDifficulty(this.network) });
    const work = textField(value, 'work').toUpperCase();
    if (!validWork(this.network, 0, true, canonicalRoot, work)) throw new NanoRpcError();
    return work;
  }

  requireLoopbackDevelopmentEndpoint(): void {
    if (this.network !== 'nano:dev' || this.rpcUrl.protocol !== 'http:' ||
        !['localhost', '127.0.0.1', '[::1]', '::1'].includes(this.rpcUrl.hostname.toLowerCase())) {
      throw new NanoRpcError('LOCAL_DEV_REQUIRED', 'This operation requires the pinned local Nano dev network.');
    }
  }

  async process(block: NanoStateBlock, subtype: 'send' | 'receive' | 'open' | 'change'): Promise<void> {
    if (!['send', 'receive', 'open', 'change'].includes(subtype) || !block.validSignature() ||
        (subtype === 'open') !== (block.previous === ZERO_HASH)) throw new NanoRpcError();
    const value = await this.call('process', { json_block: 'true', subtype, block: block.toWire() });
    if (canonicalHash(textField(value, 'hash')) !== block.hash) throw new NanoRpcError();
  }

  async processDevOpen(block: NanoStateBlock): Promise<void> {
    this.requireLoopbackDevelopmentEndpoint();
    if (block.account !== block.representative || block.balance <= 0n ||
        !validWork('nano:dev', 0, true, block.workRoot(), block.work)) throw new NanoRpcError();
    await this.process(block, 'open');
  }

  async receivable(address: string, count = 100): Promise<NanoReceivable[]> {
    if (!Number.isInteger(count) || count < 1 || count > 1000) throw new NanoRpcError();
    const response = await this.call('receivable', { account: canonicalAddress(address), count: String(count),
      source: 'true', include_only_confirmed: 'true' });
    if (response.blocks === '' || (Array.isArray(response.blocks) && response.blocks.length === 0)) return [];
    try {
      const blocks = objectValue(response.blocks);
      if (Object.keys(blocks).length > count) throw new NanoRpcError();
      const seen = new Set<string>();
      return Object.entries(blocks).map(([hash, data]) => {
        const canonical = canonicalHash(hash);
        if (seen.has(canonical)) throw new NanoRpcError();
        seen.add(canonical);
        const value = objectValue(data);
        const amount = rawAmount(value.amount);
        if (amount === 0n) throw new NanoRpcError();
        return { hash: canonical, amount, source: canonicalAddress(textField(value, 'source')) };
      });
    } catch { throw new NanoRpcError(); }
  }

  async receivableExists(hash: string): Promise<boolean> {
    const requestedHash = canonicalHash(hash);
    // Unlike the bounded account list, blocks_info proves pending status for
    // this exact SEND. Its pending option is supported by the native RPC.
    const response = await this.call('blocks_info', { hashes: [requestedHash], json_block: 'true', pending: 'true' });
    try {
      const entries = Object.entries(objectValue(response.blocks));
      if (entries.length !== 1 || canonicalHash(entries[0]![0]) !== requestedHash) throw new NanoRpcError();
      const value = objectValue(entries[0]![1]);
      if (value.pending !== '0' && value.pending !== '1') throw new NanoRpcError();
      const evidence = this.parseBlockEvidence(value, requestedHash);
      if (evidence.subtype !== 'send' || !this.validConfirmedBlock(evidence, evidence.blockAccount)) throw new NanoRpcError();
      return value.pending === '1';
    } catch { throw new NanoRpcError(); }
  }

  validConfirmedBlock(evidence: NanoBlockEvidence, account: string): boolean {
    const block = evidence.block;
    if (!evidence.confirmed || evidence.blockAccount !== account || block.account !== account) return false;
    if (evidence.subtype !== 'epoch') {
      return ['send', 'receive', 'change', 'open'].includes(evidence.subtype) && block.validSignature();
    }
    const epoch = block.link === epochLink(1) ? 1 : block.link === epochLink(2) ? 2 : 0;
    return this.validEpochSignature(block, epoch);
  }

  async verifyFrontierState(account: NanoConfirmedAccount, source: string): Promise<NanoBlockEvidence> {
    if (account.frontier === ZERO_HASH || account.balance < 0n) {
      throw new NanoRpcError('SOURCE_NOT_FUNDED', 'The configured Nano source must be opened by its operator.');
    }
    const evidence = await this.blockInfo(account.frontier);
    if (evidence === null || !evidence.confirmed || evidence.blockAccount !== source || evidence.block.account !== source ||
        evidence.block.balance !== account.balance || evidence.block.representative !== account.representative ||
        (evidence.subtype === 'epoch' ? !this.validEpochSignature(evidence.block, account.epoch) :
          !['send', 'receive', 'change', 'open'].includes(evidence.subtype) || !evidence.block.validSignature())) {
      throw new NanoRpcError();
    }
    return evidence;
  }

  validSourceBlock(evidence: NanoBlockEvidence, source: string, previousBalance: bigint,
      previousRepresentative: string, expectedEpoch: number): boolean {
    const block = evidence.block;
    if (evidence.blockAccount !== source || block.account !== source) return false;
    if (evidence.subtype !== 'epoch') return ['send', 'receive', 'change'].includes(evidence.subtype) && block.validSignature();
    return block.balance === previousBalance && block.representative === previousRepresentative &&
      this.validEpochSignature(block, expectedEpoch);
  }

  private validEpochSignature(block: NanoStateBlock, epoch: number): boolean {
    if ((epoch !== 1 && epoch !== 2) || block.link !== epochLink(epoch) ||
        upperHex(addressPublicKey(block.account)) === ZERO_HASH ||
        !validWork(this.network, epoch, true, block.workRoot(), block.work)) return false;
    // Native epoch-open blocks carry no funds or representative. Existing
    // accounts retain their balance/representative through validSourceBlock.
    if (block.previous === ZERO_HASH && (block.balance !== 0n ||
        upperHex(addressPublicKey(block.representative)) !== ZERO_HASH)) return false;
    const signer = this.network === 'nano:dev' ? DEV_EPOCH_SIGNER : epoch === 1 ? MAIN_EPOCH_1_SIGNER : MAIN_EPOCH_2_SIGNER;
    return verify(signer, hexBytes(block.hash, 32), hexBytes(block.signature, 64));
  }

  private async call(action: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const response = await this.response(action, fields);
    if (Object.hasOwn(response, 'error')) throw new NanoRpcError();
    return response;
  }

  private async response(action: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!['version', 'account_info', 'block_info', 'work_generate', 'process', 'receivable', 'blocks_info'].includes(action)) throw new NanoRpcError();
    try {
      const response = await fetch(this.rpcUrl, { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(action === 'work_generate' ? 90_000 : 15_000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...fields }) });
      if (response.status !== 200 || response.body === null) {
        await response.body?.cancel();
        throw new NanoRpcError();
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new NanoRpcError();
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      return parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)));
    } catch { throw new NanoRpcError(); }
  }
}
