import { fileURLToPath } from 'node:url';
import { offchainVerify } from '@attocash/atto-marketplace-nano-adapter/protocol';
import type { WalletRequest } from './wallet-host.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ProfileError } from './profile-store.js';
import { validAttoProof } from './atto-proof.js';
import type { MarketplaceIntentPayment, MarketplaceIntentPaymentFailure, MarketplaceIntentPendingSignature,
  MarketplaceIntentPaymentStatus } from '@attocash/cli/internal-marketplace';

const TOOL_TIMEOUT_MS = 180_000;

export type AttoIntentPayment = MarketplaceIntentPayment;
export type AttoIntentPaymentFailure = MarketplaceIntentPaymentFailure;
export type AttoIntentPendingSignature = MarketplaceIntentPendingSignature;
export type AttoIntentPaymentStatus = MarketplaceIntentPaymentStatus;

export async function signAttoControllerProof(input: {
  env: NodeJS.ProcessEnv;
  index: number;
  address: string;
  message: string;
}): Promise<string> {
  const result = await callAttoTool(input.env, 'message_sign', { index: input.index, message: input.message });
  if (result.index !== input.index || result.address !== input.address
    || typeof result.signature !== 'string' || !/^[A-Fa-f0-9]{128}$/.test(result.signature)) {
    throw localSignerFailure('The selected ATTO signer did not return a signature for this configured controller address and index.');
  }
  if (!await validAttoProof(input.address, input.message, result.signature)) {
    throw localSignerFailure('The selected ATTO signer returned a signature that does not verify for this exact controller challenge.');
  }
  return result.signature;
}

export async function payAttoIntent(input: {
  env: NodeJS.ProcessEnv;
  apiUrl: string;
  audience: string;
  request: {
    requestId: string; intentId: string; amountAtomic: string; paymentIdentifier: string;
    paymentRequired: string; apiUrl: string; resourceUrl: string; expiresAt: string;
  };
}): Promise<AttoIntentPayment> {
  const result = await callAttoTool(input.env, 'marketplace_pay_intent', { ...input.request, audience: input.audience },
    { apiUrl: input.apiUrl, audience: input.audience });
  const payment = parseAttoIntentPayment(result);
  if (payment.requestId !== input.request.requestId || payment.intentId !== input.request.intentId
    || payment.paymentIdentifier !== input.request.paymentIdentifier || payment.amountAtomic !== input.request.amountAtomic
    || payment.network !== 'atto:live' && payment.network !== 'atto:beta' && payment.network !== 'atto:dev' && payment.network !== 'atto:local') {
    throw localSignerFailure('The Atto wallet returned a saved payment bound to a different Marketplace intent.');
  }
  return payment;
}

export async function attoIntentPaymentStatus(input: {env:NodeJS.ProcessEnv;requestId:string;apiUrl:string;audience:string}): Promise<AttoIntentPaymentStatus> {
  const result = await callAttoTool(input.env, 'marketplace_pay_intent_status', { requestId:input.requestId },
    {apiUrl:input.apiUrl,audience:input.audience});
  return parseAttoIntentPaymentStatus(result,input.requestId);
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

export async function payXnoHandoff(env: NodeJS.ProcessEnv, handoffId: string): Promise<void> {
  const result = await callWallet(env, {asset:'XNO',operation:'payment.prepare',input:{handoffId}});
  if (result.handoffId !== handoffId || !['PREPARED', 'ATTEMPTED', 'UNKNOWN', 'CONFIRMED', 'REJECTED', 'EXPIRED', 'COMPETING'].includes(String(result.state))) {
    throw localSignerFailure('The Nano payer did not return status for the matching saved Marketplace handoff.');
  }
}

async function callAttoTool(env: NodeJS.ProcessEnv, name: string, args: Record<string, unknown>,
  paymentConfiguration?: { apiUrl: string; audience: string }): Promise<Record<string, unknown>> {
  const operation = name === 'message_sign' ? 'controller.sign' : name === 'marketplace_pay_intent' ? 'payment.prepare' : 'payment.status';
  return callWallet(env,{asset:'ATTO',operation,input:args,...(paymentConfiguration?{marketplace:paymentConfiguration}:{})});
}

/** Both networks cross the same private Node stdio boundary. */
export async function callWallet(env: NodeJS.ProcessEnv, request: WalletRequest): Promise<Record<string, unknown>> {
  const configured = env.MARKETPLACE_MCP_WALLET_HOST_COMMAND;
  if (configured && (!configured.startsWith('/') || configured.length>4096 || /[\0\r\n]/.test(configured))) {
    throw new ProfileError('WALLET_SETUP_REQUIRED','Use an absolute path for the private wallet host.');
  }
  const client = new Client({name:'marketplace-managed-wallet',version:'0.1.0'});
  const transport = new StdioClientTransport({command:configured??process.execPath,
    args:configured?[]:[fileURLToPath(new URL('./main.js',import.meta.url)),'--internal-wallet-host'],
    env:childEnvironment(env),stderr:'pipe'});
  try {
    await client.connect(transport);
    let timer:NodeJS.Timeout|undefined;
    const result=await Promise.race([client.callTool({name:'wallet_call',arguments:request as unknown as Record<string,unknown>},{timeout:TOOL_TIMEOUT_MS}),
      new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Wallet timeout')),TOOL_TIMEOUT_MS);})
    ]).finally(()=>{if(timer)clearTimeout(timer);});
    if(result.isError) {
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
    if(error instanceof ProfileError)throw error;
    throw localSignerFailure('The private wallet could not complete this operation. Check its selected profile, approved permissions, and original request status.');
  } finally { await client.close().catch(()=>undefined); }
}

function validPaymentIdentity(value: Record<string, unknown>): boolean {
  return typeof value.requestId === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value.requestId)
    && typeof value.intentId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.intentId)
    && typeof value.network === 'string' && ['atto:live','atto:beta','atto:dev','atto:local'].includes(value.network)
    && typeof value.amountAtomic === 'string' && /^[1-9][0-9]{0,64}$/.test(value.amountAtomic);
}

function validPayerIdentity(value: Record<string, unknown>): boolean {
  return validPaymentIdentity(value) && value.paymentIdentifier === value.requestId
    && typeof value.payer === 'string' && value.payer.length >= 1 && value.payer.length <= 128 && !/[\r\n\0]/.test(value.payer);
}

function parseAttoIntentPayment(value: Record<string, unknown>): AttoIntentPayment {
  const signature = value.paymentSignature;
  if (!onlyKeys(value,['requestId','intentId','paymentIdentifier','network','amountAtomic','payer','hash',
      'paymentSignature','paymentState','reused','nativeState']) || !validPayerIdentity(value)
    || typeof value.hash !== 'string' || !/^[A-Fa-f0-9]{64}$/.test(value.hash)
    || typeof signature !== 'string' || signature.length < 4 || signature.length > 90_000 || /[\r\n\0]/.test(signature)
    || value.paymentState !== 'READY' || typeof value.reused !== 'boolean'
    || (value.nativeState !== undefined && value.nativeState !== 'unknown' && value.nativeState !== 'confirmed')) {
    throw localSignerFailure('The Atto wallet returned an invalid bounded-payment result.');
  }
  return { requestId: value.requestId as string, intentId: value.intentId as string, paymentIdentifier: value.paymentIdentifier as string,
    network: value.network as string, amountAtomic: value.amountAtomic as string, payer: value.payer as string, hash: value.hash,
    paymentSignature: signature, paymentState: 'READY', reused: value.reused,
    ...(value.nativeState === undefined ? {} : {nativeState: value.nativeState}) };
}

function parseAttoIntentPaymentStatus(value:Record<string,unknown>,requestId:string):AttoIntentPaymentStatus {
  if (value.requestId!==requestId || typeof value.paymentState!=='string') {
    throw localSignerFailure('The Atto wallet returned status for a different Marketplace payment request.');
  }
  if (value.paymentState==='NOT_FOUND') {
    if (!onlyKeys(value,['requestId','paymentState'])) throw localSignerFailure('The Atto wallet returned an invalid empty payment status.');
    return {requestId,paymentState:'NOT_FOUND'};
  }
  if (value.paymentState==='FAILED') {
    if (!onlyKeys(value,['requestId','intentId','paymentIdentifier','network','amountAtomic','payer','hash','paymentState','nativeState','failureReason'])
      || !validPayerIdentity(value)) {
      throw localSignerFailure('The Atto wallet returned an invalid terminal payment status.');
    }
    const identity={requestId,intentId:value.intentId as string,paymentIdentifier:requestId,network:value.network as string,
      amountAtomic:value.amountAtomic as string,payer:value.payer as string,paymentState:'FAILED' as const};
    if (value.nativeState==='rejected' && value.failureReason==='NATIVE_TRANSACTION_REJECTED'
      && typeof value.hash==='string' && /^[A-Fa-f0-9]{64}$/.test(value.hash)) {
      return {...identity,hash:value.hash,nativeState:'rejected',failureReason:'NATIVE_TRANSACTION_REJECTED'};
    }
    if (value.nativeState==='challenged' && value.failureReason==='MARKETPLACE_CHALLENGE_EXPIRED' && value.hash===null) {
      return {...identity,hash:null,nativeState:'challenged',failureReason:'MARKETPLACE_CHALLENGE_EXPIRED'};
    }
    throw localSignerFailure('The Atto wallet returned an invalid terminal payment status.');
  }
  if (value.paymentState==='PENDING_SIGNATURE') {
    if (!onlyKeys(value,['requestId','intentId','network','amountAtomic','paymentState','nativeState'])
      || !validPaymentIdentity(value) || value.nativeState!=='challenged') {
      throw localSignerFailure('The Atto wallet returned an invalid pending signature status.');
    }
    return {requestId,intentId:value.intentId as string,network:value.network as string,amountAtomic:value.amountAtomic as string,
      paymentState:'PENDING_SIGNATURE',nativeState:'challenged'};
  }
  if (value.paymentState==='READY') return parseAttoIntentPayment(value);
  throw localSignerFailure('The Atto wallet returned an unsupported Marketplace payment state.');
}

function onlyKeys(value:Record<string,unknown>,keys:string[]):boolean {
  return Object.keys(value).every(key=>keys.includes(key));
}

function childEnvironment(env: NodeJS.ProcessEnv): Record<string,string> {
  const result:Record<string,string>={};
  for(const [key,value] of Object.entries(env)) {
    if(value!==undefined && (['PATH','HOME','USER','LOGNAME','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME',
      'XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','MARKETPLACE_MCP_HOME','MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR',
      'MARKETPLACE_MCP_NANO_WALLET_DATA_DIR','MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR','MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR'].includes(key)
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
  MARKETPLACE_FUNDING_DENIED:'Marketplace funding requires local terminal approval for this wallet.',
  SOURCE_FENCED:'Recover the original uncertain native operation before sending another payment.',
  NETWORK_MISMATCH:'The requested network does not match the selected native wallet.',
  MCP_READ_ONLY:'This wallet requires local approval for MCP spending.',
  LIMIT_EXCEEDED:'The payment exceeds this wallet’s approved spending limit.',
};
