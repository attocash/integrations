import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { withMarketplaceRecoverySeed, type MarketplaceRecoverySource } from '@attocash/cli/internal-marketplace';
import { createHash } from 'node:crypto';
import { addressFromPublicKey, canonicalAddress, derivePrivateKey, deriveNanoRecoveryPrivateKey, publicKey, MAX_RAW, type NanoNetwork } from './protocol.js';
import { parseJsonObject } from './rpc.js';
import { absolutePath, privateDirectory, privateFile, publishPrivate, readPrivate, recoverPublication, replacePrivate } from './private-files.js';
import { checkSharedWalletBindingIfPresent, claimSharedWalletBinding, requireSharedWalletBinding } from './shared-wallet-binding.js';
import { fail } from './errors.js';
export const CONTROLLER_PURPOSES = ['login', 'link authorizer', 'link new identity', 'unlink'] as const;
export type ControllerPurpose = typeof CONTROLLER_PURPOSES[number];
interface NanoWalletSettings {
    derivationIndex: number;
    network: NanoNetwork;
    rpcUrl: string;
    sourceAddress: string;
    handoffDirectory: string;
    origin: string;
    audience: string;
    grants: {
        marketplaceFunding: boolean;
        externalTransfers: boolean;
        controllerPurposes: ControllerPurpose[];
    };
    limits: {
        maxPaymentAtomic: string;
        rolling24hAtomic: string;
    };
}
export type NanoKeySource =
    | { type: 'shared-recovery'; recoverySource: MarketplaceRecoverySource; derivationVersion: 'bip39-ed25519-slip10-nano-v1' }
    | { type: 'native-seed'; seedFile: string; derivationVersion: 'nano-seed-blake2b-v1' };
export type NanoWalletConfiguration = NanoWalletSettings & { version: 1; keySource: NanoKeySource };
export interface ProvisionNanoWalletOptions extends Omit<NanoWalletSettings, 'sourceAddress' | 'grants' | 'limits'> {
    dataDir: string;
    seedFile?: string;
    recoveryWalletDirectory?: string;
    expectedAddress?: string;
    terminalConfirmed: true;
    grants?: Partial<NanoWalletConfiguration['grants']>;
    limits?: NanoWalletConfiguration['limits'];
}
export function canonical(value: unknown): string {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return JSON.stringify(value);
    if (typeof value === 'number' && Number.isSafeInteger(value))
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object')
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
    return fail('INVALID_REQUEST');
}
export function sha256(value: string | Uint8Array): string {
    return createHash('sha256').update(value).digest('hex');
}
export function framedHash(fields: string[]): Buffer {
    const hash = createHash('sha256');
    for (const field of fields) {
        const bytes = Buffer.from(field, 'utf8');
        const length = Buffer.alloc(4);
        length.writeUInt32BE(bytes.length);
        hash.update(length);
        hash.update(bytes);
    }
    return hash.digest();
}
export function object(value: unknown): Record<string, any> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        fail('INVALID_REQUEST');
    return value as Record<string, any>;
}
export function exactKeys(value: unknown, keys: string[]): Record<string, any> {
    const raw = object(value);
    if (Object.keys(raw).sort().join('\0') !== [...keys].sort().join('\0'))
        fail('INVALID_REQUEST');
    return raw;
}
export function text(value: unknown, maximum = 4096): string {
    if (typeof value !== 'string' || !value.length || value.length > maximum || value.includes('\0'))
        fail('INVALID_REQUEST');
    return value;
}
export function positiveRaw(value: unknown, zero = false): bigint {
    if (typeof value !== 'string' || !(zero ? /^(0|[1-9][0-9]{0,64})$/ : /^[1-9][0-9]{0,64}$/).test(value))
        fail('INVALID_AMOUNT');
    const amount = BigInt(value);
    if (amount > MAX_RAW)
        fail('INVALID_AMOUNT');
    return amount;
}
export function canonicalOrigin(value: unknown): string {
    const input = text(value, 2048);
    let url: URL;
    try {
        url = new URL(input);
    }
    catch {
        return fail('INVALID_ORIGIN');
    }
    if (url.origin !== input ||
        url.username ||
        url.password ||
        !['https:', 'http:'].includes(url.protocol) ||
        (url.protocol === 'http:' &&
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
        fail('INVALID_ORIGIN');
    return input;
}
export function defaultDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
    return absolutePath(env.MARKETPLACE_MCP_NANO_WALLET_DATA_DIR ?? join(homedir(), 'wallets', 'nano'));
}
export function validateConfiguration(value: unknown): NanoWalletConfiguration {
    const raw = exactKeys(value, ['version', 'keySource', 'derivationIndex', 'network', 'rpcUrl', 'sourceAddress', 'handoffDirectory', 'origin', 'audience', 'grants', 'limits']);
    if (raw.version !== 1 ||
        !Number.isInteger(raw.derivationIndex) ||
        raw.derivationIndex < 0 ||
        raw.derivationIndex > 0xffffffff ||
        !['nano:dev', 'nano:mainnet'].includes(raw.network))
        fail('WALLET_CONFIGURATION');
    const keySource = object(raw.keySource);
    if (keySource.type === 'native-seed') {
        exactKeys(keySource, ['type', 'seedFile', 'derivationVersion']);
        absolutePath(keySource.seedFile);
        if (keySource.derivationVersion !== 'nano-seed-blake2b-v1') fail('WALLET_CONFIGURATION');
    } else if (keySource.type === 'shared-recovery') {
        exactKeys(keySource, ['type', 'recoverySource', 'derivationVersion']);
        if (keySource.derivationVersion !== 'bip39-ed25519-slip10-nano-v1' || raw.derivationIndex > 0x7fff_ffff) fail('WALLET_CONFIGURATION');
        const source = exactKeys(keySource.recoverySource, ['directory', 'credentialAccount', 'credentialService', 'identityAddress']);
        absolutePath(source.directory);
        text(source.credentialAccount, 200);
        if (!['Atto CLI', 'Atto MCP'].includes(source.credentialService) || !/^atto:\/\/[a-z0-9]+$/.test(source.identityAddress)) fail('WALLET_CONFIGURATION');
    } else fail('WALLET_CONFIGURATION');
    absolutePath(raw.handoffDirectory);
    canonicalOrigin(raw.origin);
    if (canonicalAddress(raw.sourceAddress) !== raw.sourceAddress)
        fail('WALLET_CONFIGURATION');
    const audience = text(raw.audience, 255);
    if (audience.trim() !== audience || /[\r\n\x00-\x1f\x7f]/.test(audience))
        fail('WALLET_CONFIGURATION');
    let url: URL;
    try {
        url = new URL(text(raw.rpcUrl, 2048));
    }
    catch {
        return fail('WALLET_CONFIGURATION');
    }
    if (url.username ||
        url.password ||
        url.hash ||
        !['https:', 'http:'].includes(url.protocol) ||
        (url.protocol === 'http:' &&
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
        fail('WALLET_CONFIGURATION');
    exactKeys(raw.grants, ['marketplaceFunding', 'externalTransfers', 'controllerPurposes']);
    if (typeof raw.grants.marketplaceFunding !== 'boolean' ||
        typeof raw.grants.externalTransfers !== 'boolean' ||
        !Array.isArray(raw.grants.controllerPurposes) ||
        new Set(raw.grants.controllerPurposes).size !== raw.grants.controllerPurposes.length ||
        raw.grants.controllerPurposes.some((p: unknown) => !(CONTROLLER_PURPOSES as readonly unknown[]).includes(p)))
        fail('WALLET_CONFIGURATION');
    exactKeys(raw.limits, ['maxPaymentAtomic', 'rolling24hAtomic']);
    if (positiveRaw(raw.limits.maxPaymentAtomic, true) > positiveRaw(raw.limits.rolling24hAtomic, true))
        fail('WALLET_CONFIGURATION');
    return raw as NanoWalletConfiguration;
}
export function loadConfiguration(dataDir: string): NanoWalletConfiguration {
    privateDirectory(dataDir, false);
    recoverPublication(join(dataDir, 'wallet.json'));
    const config = validateConfiguration(parseJsonObject(readPrivate(join(dataDir, 'wallet.json'), 32768).toString('utf8')));
    if (config.keySource.type === 'native-seed') privateDirectory(dirname(config.keySource.seedFile), false);
    privateDirectory(config.handoffDirectory, false);
    requireSharedWalletBinding(config, dataDir);
    return config;
}
function seedKey(seedFile:string,index:number):Uint8Array {
    privateDirectory(dirname(absolutePath(seedFile)),false);
    const bytes=readPrivate(seedFile,66);
    const value=bytes.toString('ascii').replace(/\r?\n$/,'');bytes.fill(0);
    if(!/^[a-fA-F0-9]{64}$/.test(value))fail('WALLET_CONFIGURATION');
    const seed=Buffer.from(value,'hex');
    try{return derivePrivateKey(seed,index);}finally{seed.fill(0);}
}
/** Read-only identity inspection; never creates directories, state or credentials. */
export async function inspectNanoSeed(seedFile:string,index:number):Promise<{address:string;index:number}> {
    const key=seedKey(seedFile,index);
    try{return {address:addressFromPublicKey(publicKey(key)),index};}finally{key.fill(0);}
}
export async function inspectNanoWallet(dataDir:string):Promise<NanoWalletConfiguration> {
    const config=loadConfiguration(dataDir);
    return withPrivateKey(config,()=>config);
}
/** Read-only recovery-source inspection. No secret leaves the trusted callback. */
export function inspectNanoRecoveryWallet(directory:string,index:number):Promise<{address:string;index:number;recoverySource:MarketplaceRecoverySource}> {
    return withMarketplaceRecoverySeed(directory,(seed,recoverySource)=>{
        const key=deriveNanoRecoveryPrivateKey(seed,index);
        try{return {address:addressFromPublicKey(publicKey(key)),index,recoverySource};}finally{key.fill(0);}
    });
}
export async function withPrivateKey<T>(config:NanoWalletConfiguration,action:(key:Uint8Array)=>T | Promise<T>):Promise<T> {
    const consume=async (key:Uint8Array):Promise<T>=>{
        try{
            if(addressFromPublicKey(publicKey(key))!==config.sourceAddress)fail('WALLET_KEY_MISMATCH');
            return await action(key);
        }finally{key.fill(0);}
    };
    const source=config.keySource;
    if(source.type==='shared-recovery') return withMarketplaceRecoverySeed(source.recoverySource,seed=>consume(deriveNanoRecoveryPrivateKey(seed,config.derivationIndex)));
    return consume(seedKey(source.seedFile,config.derivationIndex));
}
export interface ProvisionNanoWalletResult {
    address:string;index:number;network:NanoNetwork;configurationPath:string;
}
function preflightSharedDestination(options:ProvisionNanoWalletOptions,config:NanoWalletConfiguration):void {
    if(config.keySource.type!=='shared-recovery'||!existsSync(options.dataDir))return;
    privateDirectory(options.dataDir,false);
    const entries=readdirSync(options.dataDir,{withFileTypes:true});
    if(entries.length===0)return;
    // A retained journal without its config is unresolved financial state. Only
    // an exact prior claim may resume its own interrupted first publication.
    requireSharedWalletBinding(config,options.dataDir);
    const concurrentlyPublished=():boolean=>{
        if(!existsSync(join(options.dataDir,'wallet.json')))return false;
        if(canonical(loadConfiguration(options.dataDir))!==canonical(config))fail('WALLET_CONFIGURATION_EXISTS','This private wallet already has different approved settings.');
        return true;
    };
    if(concurrentlyPublished())return;
    for(const entry of entries){
        const path=join(options.dataDir,entry.name);
        if(entry.isFile()&&/^\.nano-[a-f0-9]{32}\.tmp$/.test(entry.name)){
            // A concurrent exact publisher can still be writing this private
            // temporary file. It contains no native journal/candidate, and the
            // matching immutable claim already fixes this account's owner.
            try{privateFile(path);}catch(error){if(concurrentlyPublished())return;throw error;}
            continue;
        }
        if(concurrentlyPublished())return;
        if(entry.isDirectory()&&path===options.handoffDirectory){
            privateDirectory(path,false);
            if(readdirSync(path).length===0)continue;
        }
        fail('WALLET_CONFIGURATION_EXISTS','This directory retains wallet state without its original configuration. Restore that configuration and journal before continuing.');
    }
}
function publishConfiguration(options:ProvisionNanoWalletOptions, config:NanoWalletConfiguration):ProvisionNanoWalletResult {
    if(options.expectedAddress!==undefined&&options.expectedAddress!==config.sourceAddress)fail('WALLET_KEY_MISMATCH');
    const dataDir=absolutePath(options.dataDir);
    const configurationPath=join(dataDir,'wallet.json');
    if(existsSync(configurationPath)){
        if(canonical(loadConfiguration(dataDir))!==canonical(config))fail('WALLET_CONFIGURATION_EXISTS','This private wallet already has different approved settings.');
    }else {
        checkSharedWalletBindingIfPresent(config,dataDir);
        preflightSharedDestination(options,config);
        privateDirectory(dataDir);
        if(config.keySource.type==='shared-recovery')claimSharedWalletBinding(config,dataDir);
        privateDirectory(config.handoffDirectory);
        publishPrivate(configurationPath,Buffer.from(`${canonical(config)}\n`));
    }
    return {address:config.sourceAddress,index:config.derivationIndex,network:config.network,configurationPath};
}
export async function provisionNanoWallet(options:ProvisionNanoWalletOptions):Promise<ProvisionNanoWalletResult> {
    if (options.terminalConfirmed !== true) fail('TERMINAL_REQUIRED');
    if ((options.seedFile === undefined) === (options.recoveryWalletDirectory === undefined)) fail('WALLET_CONFIGURATION');
    let keySource: NanoKeySource;
    let address: string;
    if(options.recoveryWalletDirectory!==undefined){
        const identity=await inspectNanoRecoveryWallet(absolutePath(options.recoveryWalletDirectory),options.derivationIndex);
        keySource={type:'shared-recovery',derivationVersion:'bip39-ed25519-slip10-nano-v1',recoverySource:identity.recoverySource};
        address=identity.address;
    } else {
        const seedFile=absolutePath(options.seedFile!);
        const identity=await inspectNanoSeed(seedFile,options.derivationIndex);
        keySource={type:'native-seed',derivationVersion:'nano-seed-blake2b-v1',seedFile};
        address=identity.address;
    }
    const config=validateConfiguration({version:1,keySource,derivationIndex:options.derivationIndex,
        network:options.network,rpcUrl:options.rpcUrl,sourceAddress:address,handoffDirectory:options.handoffDirectory,
        origin:options.origin,audience:options.audience,
        grants:{marketplaceFunding:options.grants?.marketplaceFunding??false,externalTransfers:options.grants?.externalTransfers??false,controllerPurposes:options.grants?.controllerPurposes??[]},
        limits:options.limits??{maxPaymentAtomic:'0',rolling24hAtomic:'0'}});
    return publishConfiguration(options,config);
}
/** A terminal-approved policy replacement preserves the identity and durable journal. */
export async function approveNanoWalletPolicy(options: {
    dataDir: string;
    grants: NanoWalletConfiguration['grants'];
    limits: NanoWalletConfiguration['limits'];
    terminalConfirmed: true;
}): Promise<{address:string;configurationPath:string}> {
    if (options.terminalConfirmed !== true)
        fail('TERMINAL_REQUIRED');
    const old = loadConfiguration(options.dataDir), config = validateConfiguration({ ...old, grants: options.grants, limits: options.limits });
    return withPrivateKey(config, () => {
        if(canonical(loadConfiguration(options.dataDir))!==canonical(old))fail('WALLET_CONFIGURATION_CHANGED');
        const configurationPath = join(options.dataDir, 'wallet.json');
        replacePrivate(configurationPath, Buffer.from(`${canonical(config)}\n`));
        return { address: config.sourceAddress, configurationPath };
    });
}
