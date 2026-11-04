import { AttoAddress, AttoAlgorithm, AttoPublicKey } from '@attocash/commons-core';
import { canonicalAddress } from '@attocash/atto-marketplace-nano-adapter';
import { z } from 'zod';

const atomic = z.string().regex(/^(0|[1-9][0-9]{0,64})$/);
const positiveAtomic = z.string().regex(/^[1-9][0-9]{0,64}$/);
const hash = z.string().regex(/^[a-fA-F0-9]{64}$/).transform(value => value.toUpperCase());
const index = z.number().int().min(0).max(0xffff_ffff);
const permissions = z.strictObject({marketplaceFunding:z.boolean(),externalTransfers:z.boolean(),receive:z.boolean()});
const identitySchema = z.strictObject({asset:z.enum(['ATTO','XNO']),network:z.string(),address:z.string(),index,permissions});
export type WalletIdentity = z.infer<typeof identitySchema>;
export type NativeWalletOperation = 'identity.list' | 'balance.get' | 'transfer.send' | 'transfer.status' | 'receive' | 'receivable.list';

function invalid(): never {
  throw Object.assign(new Error('The native wallet returned inconsistent public operation data.'), {code:'WALLET_RESPONSE_INVALID'});
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function address(value: unknown, asset: WalletIdentity['asset'], canonicalInput = false): string {
  if (typeof value !== 'string') return invalid();
  try {
    const parsed = asset === 'ATTO' ? AttoAddress.parse(value).value : canonicalAddress(value);
    if (parsed !== value && !canonicalInput) return invalid();
    return parsed;
  } catch { return invalid(); }
}
export function canonicalWalletDestination(asset: WalletIdentity['asset'], value: unknown): string {
  try { return address(value, asset, true); }
  catch { throw Object.assign(new Error('Supply a valid native destination address.'), {code:'INVALID_REQUEST'}); }
}
function attoAddress(algorithm: unknown, publicKey: unknown): string {
  if (typeof algorithm !== 'string' || typeof publicKey !== 'string') return invalid();
  try { return AttoPublicKey.Companion.parse(publicKey).toAddress(AttoAlgorithm.valueOf(algorithm)).value; }
  catch { return invalid(); }
}
function same(actual: unknown, expected: unknown): void { if (actual !== expected) invalid(); }
function base(identity: WalletIdentity) {
  return {asset:identity.asset,network:identity.network,address:identity.address,index:identity.index};
}
export function publicWalletIdentity(value: WalletIdentity): WalletIdentity {
  const result = identitySchema.safeParse(value);
  if (!result.success) return invalid();
  const parsed = result.data;
  address(parsed.address, parsed.asset);
  if (parsed.asset === 'ATTO' ? !/^atto:(live|beta|dev|local)$/.test(parsed.network) || parsed.index > 0x7fff_ffff
    : !/^nano:(main|beta|dev)$/.test(parsed.network)) invalid();
  same(parsed.permissions.receive, parsed.permissions.marketplaceFunding || parsed.permissions.externalTransfers);
  return parsed;
}

export function publicWalletState(asset: WalletIdentity['asset'], state: unknown): 'PENDING' | 'SETTLED' | 'REJECTED' {
  const states = asset === 'ATTO'
    ? {reserved:'PENDING',signed:'PENDING',unknown:'PENDING',published:'SETTLED',received:'SETTLED',failed:'REJECTED'} as const
    : {PREPARING:'PENDING',PREPARED:'PENDING',UNKNOWN:'PENDING',READY:'PENDING',CONFIRMED:'SETTLED',COMPETING:'REJECTED'} as const;
  if (typeof state !== 'string' || !Object.hasOwn(states, state)) return invalid();
  const mapped = (states as Record<string, 'PENDING' | 'SETTLED' | 'REJECTED'>)[state];
  return mapped ?? invalid();
}

/** Construct one public contract; provider fields never pass through to callers. */
export function normalizeWalletResult(identity: WalletIdentity, operation: NativeWalletOperation,
  result: unknown, input: Record<string, unknown>): Record<string, unknown> {
  try { return normalizeResult(identity, operation, result, input); }
  catch (error) {
    if (error instanceof z.ZodError) return invalid();
    throw error;
  }
}

function normalizeResult(identity: WalletIdentity, operation: NativeWalletOperation,
  result: unknown, input: Record<string, unknown>): Record<string, unknown> {
  identity = publicWalletIdentity(identity);
  if (operation === 'identity.list') return {...base(identity),permissions:identity.permissions};
  const value = object(result);
  const atto = identity.asset === 'ATTO';
  if (operation === 'balance.get') {
    let balance: unknown;
    if (atto) {
      if (!Array.isArray(value.balances) || value.balances.length !== 1) return invalid();
      const row = object(value.balances[0]);
      same(row.address, identity.address); same(row.index, identity.index);
      balance = object(row.balance).raw;
    } else {
      same(value.address, identity.address); same(value.index, identity.index); same(value.network, identity.network);
      balance = value.balanceAtomic;
    }
    return {...base(identity),balanceAtomic:atomic.parse(balance)};
  }
  if (operation === 'transfer.send' || operation === 'transfer.status') {
    if (atto && value.external) return invalid();
    same(atto ? value.id : value.requestId, input.requestId);
    same(atto ? `atto:${String(value.network).toLowerCase()}` : value.network, identity.network);
    same(value.sourceAddress, identity.address); same(value.index, identity.index);
    const destination = address(value.destination, identity.asset);
    const amountAtomic = positiveAtomic.parse(atto ? value.raw : value.amountAtomic);
    if (operation === 'transfer.send') {
      same(destination, canonicalWalletDestination(identity.asset, input.destination));
      same(amountAtomic, atto ? input.amount : input.amountAtomic);
    }
    const state = publicWalletState(identity.asset, atto ? value.status : value.state);
    const candidate = (atto ? value.hash : value.sendHash) ?? null;
    const candidateHash = candidate === null ? null : hash.parse(candidate);
    if (state === 'SETTLED' && candidateHash === null) return invalid();
    return {asset:identity.asset,network:identity.network,index:identity.index,sourceAddress:identity.address,
      destination,amountAtomic,requestId:input.requestId,state,hash:candidateHash};
  }
  if (operation === 'receivable.list') {
    const limit = z.number().int().min(1).max(100).parse(input.limit ?? 50);
    const rows = atto ? value.items : value.receivables;
    if (!Array.isArray(rows) || rows.length > limit) return invalid();
    if (!atto) { same(value.address, identity.address); same(value.index, identity.index); same(value.network, identity.network); }
    const seen = new Set<string>();
    const items = rows.map(item => {
      const row = object(item);
      if (atto) {
        same(`atto:${String(row.network).toLowerCase()}`, identity.network);
        same(attoAddress(row.receiverAlgorithm, row.receiverPublicKey), identity.address);
      }
      const sendHash = hash.parse(row.hash);
      if (seen.has(sendHash)) return invalid();
      seen.add(sendHash);
      return {hash:sendHash,sourceAddress:atto ? attoAddress(row.algorithm, row.publicKey) : address(row.source, 'XNO'),
        amountAtomic:positiveAtomic.parse(atto ? row.amount : row.amountAtomic)};
    });
    const incomplete = atto ? z.boolean().parse(value.timedOut) || (value.limitReached === undefined ? false : z.boolean().parse(value.limitReached))
      : rows.length >= limit;
    return {...base(identity),items,incomplete};
  }
  if (operation === 'receive') {
    if (atto && value.status === 'unknown') {
      const pending = z.strictObject({status:z.literal('unknown'),hash,index:index.max(0x7fff_ffff),sendHash:hash,
        sourceAddress:z.string(),network:z.enum(['LOCAL','DEV','BETA','LIVE']),amountAtomic:positiveAtomic.nullable()}).parse(value);
      same(`atto:${pending.network.toLowerCase()}`, identity.network);
      same(pending.sourceAddress, identity.address); same(pending.index, identity.index);
      same(pending.sendHash, hash.parse(input.hash));
      return {...base(identity),sendHash:pending.sendHash,hash:pending.hash,amountAtomic:pending.amountAtomic,state:'PENDING'};
    }
    const state = publicWalletState(identity.asset, atto ? value.status : value.state);
    let amount: unknown;
    if (atto) {
      if (value.index !== undefined) same(value.index, identity.index);
      const block = object(object(value.transaction).block);
      same(`atto:${String(block.network).toLowerCase()}`, identity.network);
      same(attoAddress(block.algorithm, block.publicKey), identity.address);
      same(hash.parse(block.sendHash), hash.parse(input.hash));
      if (!['OPEN','RECEIVE'].includes(String(block.type))) return invalid();
      amount = value.amount === undefined ? null : object(value.amount).raw;
    } else {
      same(value.network, identity.network); same(value.sourceAddress, identity.address); same(value.index, identity.index);
      amount = value.amountAtomic;
    }
    const candidate = (atto ? value.hash : value.sendHash) ?? null;
    const candidateHash = candidate === null ? null : hash.parse(candidate);
    if (state === 'SETTLED' && candidateHash === null) return invalid();
    return {...base(identity),sendHash:hash.parse(input.hash),hash:candidateHash,
      amountAtomic:amount === null ? null : positiveAtomic.parse(amount),state};
  }
  return invalid();
}
