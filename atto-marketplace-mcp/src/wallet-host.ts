import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { createApplication, type ApplicationSession } from '@attocash/cli/core';
import { createInternalMarketplaceWalletApplication } from '@attocash/cli/internal-marketplace';
import { dispatchNanoOperation, loadConfiguration, defaultDataDirectory } from '@attocash/atto-marketplace-nano-adapter';
import { selectedAttoWallet } from './wallet-access.js';
import { canonicalWalletDestination, normalizeWalletResult, publicWalletIdentity } from './wallet-results.js';

export const walletOperations = ['controller.sign','payment.prepare','payment.status','identity.list','balance.get',
  'transfer.send','transfer.status','receive','receivable.list'] as const;
export type WalletOperation = typeof walletOperations[number];
export type WalletAsset = 'ATTO' | 'XNO';
export interface WalletRequest {
  asset: WalletAsset;
  operation: WalletOperation;
  input: Record<string, unknown>;
  marketplace?: { apiUrl: string; audience: string } | undefined;
}

/** Trusted, installed adapters only. Each adapter owns its key access, permissions and durable state. */
export async function executeWalletRequest(request: WalletRequest, env: NodeJS.ProcessEnv): Promise<unknown> {
  if (request.operation === 'transfer.send') request = {...request,input:{...request.input,
    destination:canonicalWalletDestination(request.asset, request.input.destination)}};
  const internal = request.operation === 'controller.sign' || request.operation === 'payment.prepare' || request.operation === 'payment.status';
  if (!internal && Object.hasOwn(request.input, 'index')) throw walletError('INVALID_REQUEST');
  if (request.asset === 'XNO') {
    const names: Record<WalletOperation,string> = {'controller.sign':'message.sign','payment.prepare':'payment.prepare',
      'payment.status':'payment.status','identity.list':'identity.list','balance.get':'balance.get',
      'transfer.send':'transfer.send','transfer.status':'transfer.status',receive:'receive','receivable.list':'receivable.list'};
    const selected=request.operation==='controller.sign'&&env.MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR
      ? {...env,MARKETPLACE_MCP_NANO_WALLET_DATA_DIR:env.MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR}:env;
    if (request.operation === 'controller.sign' || request.operation === 'payment.prepare' || request.operation === 'payment.status') {
      return dispatchNanoOperation(selected, names[request.operation], request.input);
    }
    const configuration = loadConfiguration(defaultDataDirectory(selected));
    const identity = publicWalletIdentity({asset:'XNO',network:configuration.network,address:configuration.sourceAddress,
      index:configuration.derivationIndex,permissions:{marketplaceFunding:configuration.grants.marketplaceFunding,
        externalTransfers:configuration.grants.externalTransfers,
        receive:configuration.grants.marketplaceFunding || configuration.grants.externalTransfers}});
    // Status describes the configured account and grants. Configuration loading
    // validates its original shared journal binding without opening signing keys.
    if (request.operation === 'identity.list') return normalizeWalletResult(identity, request.operation, {}, request.input);
    if (request.operation === 'receive' && !identity.permissions.receive) throw walletError('PERMISSION_DENIED');
    const result = await dispatchNanoOperation(selected, names[request.operation], request.input);
    return normalizeWalletResult(identity, request.operation, result, request.input);
  }
  const directory = env.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR;
  if (!directory || !directory.startsWith('/') || /[\0\r\n]/.test(directory)) throw walletError('WALLET_SETUP_REQUIRED');
  if (request.operation === 'controller.sign') {
    const app = createApplication({directory,access:'mcp'});
    try {
      const args = {...request.input};
      delete args.address;
      return await app.call('message_sign', args);
    } finally { await app.close(); }
  }
  let app: ApplicationSession;
  if ((request.operation === 'payment.prepare' || request.operation === 'payment.status') && !request.marketplace) {
    throw walletError('WALLET_SETUP_REQUIRED');
  }
  let status: Record<string, unknown> | undefined;
  let selection: ReturnType<typeof selectedAttoWallet> | undefined;
  app = createInternalMarketplaceWalletApplication({directory,
    ...(request.marketplace ? {internalMarketplacePayment:request.marketplace} : {}),
    authorizeWrite:(currentStatus: unknown) => {
      if (!status || !selection) throw walletError('WALLET_SETUP_REQUIRED');
      const current = selectedAttoWallet(env, currentStatus);
      const currentIdentity = (currentStatus as {identity:{fingerprint:string}}).identity;
      const originalIdentity = status.identity as {fingerprint:string};
      if (current.address !== selection.address || current.index !== selection.index || current.network !== selection.network
        || currentIdentity.fingerprint !== originalIdentity.fingerprint) {
        throw walletError('WALLET_SETUP_REQUIRED');
      }
      const allowed = request.operation === 'payment.prepare' ? current.permissions.marketplaceFunding
        : request.operation === 'transfer.send' ? current.permissions.externalTransfers
        : request.operation === 'receive' ? current.permissions.receive : true;
      if (!allowed) throw walletError('PERMISSION_DENIED');
    }});
  try {
    const names: Record<WalletOperation,string> = {'controller.sign':'message_sign','payment.prepare':'marketplace_pay_intent',
      'payment.status':'marketplace_pay_intent_status','identity.list':'wallet_status','balance.get':'balances_get',
      'transfer.send':'send','transfer.status':'journal_get',receive:'receive','receivable.list':'receivables_list'};
    const args = {...request.input};
    status = await app.call('wallet_status', {}) as Record<string, unknown>;
    selection = selectedAttoWallet(env, status);
    const identity = publicWalletIdentity({asset:'ATTO',...selection});
    if (request.operation === 'transfer.send' || request.operation === 'balance.get' || request.operation === 'receive' || request.operation === 'receivable.list') {
      if (args.network !== identity.network) throw walletError('NETWORK_MISMATCH');
      delete args.network;
      args.index = identity.index;
    }
    if (request.operation === 'payment.prepare') args.index = identity.index;
    if (request.operation === 'transfer.send' || request.operation === 'transfer.status') {
      if (request.operation === 'transfer.send') {
        try { await app.call('send', args); }
        catch (error) {
          const code = errorCode(error);
          // Both outcomes have an original durable record. Conflicting terms
          // and unrelated failures must retain their original error.
          if (code !== 'PUBLICATION_UNCERTAIN' && code !== 'REQUEST_FAILED') throw error;
        }
      }
      await app.call('limits_get', {});
      const journal = await app.call('journal_get', {requestId:args.requestId}) as {record:unknown};
      return normalizeWalletResult(identity, request.operation, journal.record, request.input);
    }
    const result = await app.call(names[request.operation], args);
    if (request.operation === 'payment.prepare' || request.operation === 'payment.status') return result;
    return normalizeWalletResult(identity, request.operation, result, request.input);
  } finally { await app.close(); }
}

function walletError(code: string): Error & {code:string} { return Object.assign(new Error(code), {code}); }
function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

export function publicWalletErrorCode(error: unknown): string {
  const code = errorCode(error);
  if (['SPEND_LIMIT','SPENDING_LIMIT','DAILY_LIMIT','PAYMENT_LIMIT','LIMIT_EXCEEDED'].includes(code ?? '')) return 'SPENDING_LIMIT';
  if (['PERMISSION_DENIED','EXTERNAL_TRANSFERS_DENIED','MARKETPLACE_FUNDING_DENIED','MCP_READ_ONLY'].includes(code ?? '')) return 'PERMISSION_DENIED';
  if (['SOURCE_FENCED','ACCOUNT_RESERVED','POOL_BUSY','PAYMENT_IN_PROGRESS','WALLET_BUSY','ACCOUNT_BUSY'].includes(code ?? '')) return 'SOURCE_FENCED';
  const allowed = ['INSUFFICIENT_FUNDS','NETWORK_MISMATCH','WALLET_SETUP_REQUIRED','WALLET_RESPONSE_INVALID',
    'REQUEST_CONFLICT','INVALID_REQUEST','NOT_FOUND','JOURNAL_NOT_FOUND','RPC_CONFLICT','JOURNAL_CONFLICT'];
  return code && allowed.includes(code) ? code : 'WALLET_REJECTED';
}

/** This endpoint is private to Marketplace's child process, never part of the public tool catalog. */
export function createWalletHost(env: NodeJS.ProcessEnv = process.env): McpServer {
  const server = new McpServer({name:'marketplace-private-wallet',version:'0.1.0'});
  server.registerTool('wallet_call', {
    description:'Private typed wallet adapter request. No generic hash signing, key export or remote plugin loading.',
    inputSchema:z.strictObject({asset:z.enum(['ATTO','XNO']),operation:z.enum(walletOperations),
      input:z.record(z.string(),z.unknown()),marketplace:z.strictObject({apiUrl:z.string().max(2048),audience:z.string().max(255)}).optional()}),
  }, async request => {
    try {
      const result = await executeWalletRequest(request, env);
      const structuredContent = {result};
      return {content:[{type:'text',text:JSON.stringify(structuredContent)}],structuredContent};
    } catch(error) {
      const code=publicWalletErrorCode(error);
      const structuredContent={error:{code,message:'The local wallet rejected the operation. Check its terminal configuration, permissions and original request status.'}};
      return {content:[{type:'text',text:JSON.stringify(structuredContent)}],structuredContent,isError:true};
    }
  });
  return server;
}

export async function runWalletHost(env: NodeJS.ProcessEnv): Promise<void> {
  await createWalletHost(env).connect(new StdioServerTransport());
}
