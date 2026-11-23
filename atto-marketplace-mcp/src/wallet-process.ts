import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { offchainVerify } from '@attocash/atto-marketplace-nano-adapter/protocol';
import type { WalletRequest } from './wallet-host.js';
import { MarketplaceApiError } from './marketplace-api.js';
import { nanoWorkMethod, nanoWorkRequest, nanoWorkResult } from './nano-work.js';
import type { NanoWorkProvider } from '@attocash/atto-marketplace-nano-adapter';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ProfileError } from './profile-store.js';
import { validAttoProof } from './atto-proof.js';
const TOOL_TIMEOUT_MS = 180_000;

export async function signAttoControllerProof(input: {
  env: NodeJS.ProcessEnv;
  index: number;
  address: string;
  message: string;
}): Promise<string> {
  const result = await callWallet(input.env, {asset:'ATTO',operation:'controller.sign',input:{index:input.index,message:input.message}});
  if (result.index !== input.index || result.address !== input.address
    || typeof result.signature !== 'string' || !/^[A-Fa-f0-9]{128}$/.test(result.signature)) {
    throw localSignerFailure('The selected ATTO signer did not return a signature for this configured controller address and index.');
  }
  if (!await validAttoProof(input.address, input.message, result.signature)) {
    throw localSignerFailure('The selected ATTO signer returned a signature that does not verify for this exact controller challenge.');
  }
  return result.signature;
}

export async function signNanoControllerProof(input: {
  env: NodeJS.ProcessEnv;
  origin: string;
  network: string;
  address: string;
  index: number;
  audience: string;
  purpose: string;
  message: string;
}): Promise<string> {
  const result = await callWallet(input.env, {asset:'XNO',operation:'controller.sign',input:{
    origin: input.origin, network: input.network, address: input.address,
    index: input.index, audience: input.audience, purpose: input.purpose, message: input.message,
  }});
  if (Object.keys(result).length !== 1 || typeof result.signature !== 'string' || !/^[A-Fa-f0-9]{128}$/.test(result.signature)) {
    throw localSignerFailure('The selected Nano signer did not return a valid NOMS controller proof.');
  }
  if(!offchainVerify(input.address,input.message,result.signature))throw localSignerFailure('The Nano wallet returned a signature for different controller terms.');
  return result.signature;
}

/** Both networks cross the same private Node stdio boundary. */
export async function callWallet(env: NodeJS.ProcessEnv, request: WalletRequest, workProvider?: NanoWorkProvider): Promise<Record<string, unknown>> {
  const configured = env.MARKETPLACE_MCP_WALLET_HOST_COMMAND;
  if (configured && (!isAbsolute(configured) || configured.length>4096 || /[\0\r\n]/.test(configured))) {
    throw new ProfileError('WALLET_SETUP_REQUIRED','Use an absolute path for the private wallet host.');
  }
  const client = new Client({name:'marketplace-managed-wallet',version:'0.1.0'});
  const marketplaceWork = !configured && request.asset === 'XNO' && workProvider;
  let workFailure: MarketplaceApiError | ProfileError | undefined;
  if (marketplaceWork) {
    client.setRequestHandler(nanoWorkMethod, {params:nanoWorkRequest, result:nanoWorkResult}, async ({hash, difficulty}) => {
      try { return {work:await marketplaceWork(hash, difficulty)}; }
      catch (error) {
        workFailure = error instanceof MarketplaceApiError || error instanceof ProfileError ? error
          : new MarketplaceApiError('NANO_WORK_UNAVAILABLE', 'Marketplace could not supply Nano work. Retry the same request ID or incoming SEND hash.');
        throw new Error('Nano work request failed.');
      }
    });
  }
  const nodeScript = process.platform === 'win32' && configured !== undefined && /\.[cm]?js$/i.test(configured);
  const transport = new StdioClientTransport({command:nodeScript?process.execPath:configured??process.execPath,
    args:configured?(nodeScript?[configured]:[]):[fileURLToPath(new URL('./main.js',import.meta.url)),'--internal-wallet-host'],
    env:childEnvironment(env),stderr:'pipe'});
  try {
    await client.connect(transport);
    let timer:NodeJS.Timeout|undefined;
    const result=await Promise.race([client.callTool({name:'wallet_call',arguments:{...request, ...(marketplaceWork && {marketplaceWork:true})}},{timeout:TOOL_TIMEOUT_MS}),
      new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Wallet timeout')),TOOL_TIMEOUT_MS);})
    ]).finally(()=>{if(timer)clearTimeout(timer);});
    if(result.isError) {
      if (workFailure) throw workFailure;
      const content=result.structuredContent;
      if(isRecord(content)&&isRecord(content.error)&&typeof content.error.code==='string'&&Object.hasOwn(walletDenials,content.error.code)) {
        throw new ProfileError(content.error.code,walletDenials[content.error.code]!);
      }
      throw new Error('wallet rejected request');
    }
    const structured=result.structuredContent;
    if(isRecord(structured)&&isRecord(structured.result)) return structured.result;
    throw new Error('invalid wallet result');
  } catch(error) {
    if(error instanceof ProfileError || error instanceof MarketplaceApiError)throw error;
    throw localSignerFailure('The private wallet could not complete this operation. Check its selected profile, approved permissions, and original request status.');
  } finally { await client.close().catch(()=>undefined); }
}

function childEnvironment(env: NodeJS.ProcessEnv): Record<string,string> {
  const result:Record<string,string>={};
  for(const [key,value] of Object.entries(env)) {
    if(value!==undefined && (['PATH','Path','PATHEXT','SystemRoot','SYSTEMROOT','WINDIR','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','COMSPEC','HOME','USER','LOGNAME','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME',
      'XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','MARKETPLACE_MCP_HOME','MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR',
      'MARKETPLACE_MCP_NANO_WALLET_DATA_DIR','MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR'].includes(key)
      || key.startsWith('ATTO_') || key.startsWith('COMMONS_'))) result[key]=value;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function localSignerFailure(message: string): ProfileError {
  return new ProfileError('LOCAL_SIGNER', message);
}

const walletDenials:Record<string,string>={
  WALLET_SETUP_REQUIRED:'Configure the selected account and wallet permissions in the local terminal.',
  NANO_WORK_INVALID:'The returned nonce did not meet the requested Nano difficulty. Retry the same request ID or incoming SEND hash.',
  WALLET_RESPONSE_INVALID:'The native wallet returned data inconsistent with the selected account or request.',
  RECEIVE_RECOVERY_UNAVAILABLE:'Recovery data is temporarily unavailable. Retry wallet_receive with the original incoming SEND hash; its candidate is unchanged.',
  REQUEST_CONFLICT:'Recover the original request with its unchanged account, route and payment terms.',
  INVALID_REQUEST:'The wallet request does not match this tool’s supported inputs.',
  NOT_FOUND:'The original wallet operation was not found in its selected journal.',
  JOURNAL_NOT_FOUND:'The original wallet operation was not found in its selected journal.',
  RPC_CONFLICT:'The native chain evidence conflicts with the original operation; recover its saved request.',
  JOURNAL_CONFLICT:'The saved wallet operation conflicts with this request; preserve its original journal.',
  PERMISSION_DENIED:'This operation requires local terminal approval for the selected wallet.',
  SPENDING_LIMIT:'The payment exceeds this wallet’s approved spending limit.',
  SPEND_LIMIT:'The payment exceeds this wallet’s approved per-payment limit.',
  INSUFFICIENT_FUNDS:'The selected native wallet has insufficient confirmed funds.',
  DAILY_LIMIT:'The transfer exceeds this wallet’s approved rolling 24-hour limit.',
  PAYMENT_LIMIT:'The payment exceeds this wallet’s approved per-payment limit.',
  EXTERNAL_TRANSFERS_DENIED:'External transfers require local terminal approval for this wallet.',
  SOURCE_FENCED:'Recover the original uncertain native operation before sending another payment.',
  NETWORK_MISMATCH:'The requested network does not match the selected native wallet.',
  MCP_READ_ONLY:'This wallet requires local approval for MCP spending.',
  LIMIT_EXCEEDED:'The payment exceeds this wallet’s approved spending limit.',
};
