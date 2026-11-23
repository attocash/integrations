import { takeJsonFlag, terminalFields, writeTerminalResult } from './terminal-output.js';
import { defaultMarketplaceHome } from './defaults.js';
import { createInterface } from 'node:readline/promises';
import { join, resolve } from 'node:path';
import { provisionNanoWallet, approveNanoWalletPolicy, loadConfiguration, validateConfiguration, inspectNanoSeed, inspectNanoRecoveryWallet, type ControllerPurpose } from '@attocash/atto-marketplace-nano-adapter';
import { initializeMarketplaceRecoveryWallet } from '@attocash/cli/internal-marketplace';
import { existsSync } from 'node:fs';
import {readWalletSelection,saveWalletSelection} from './wallet-preferences.js';
import {ensurePrivateDirectory} from './private-directory.js';
import { managedWalletEnvironment } from './wallet-home.js';
import { ProfileError } from './profile-store.js';
import { callWallet } from './wallet-process.js';
import { defaultNanoRpcUrl, usesMarketplaceWork } from './nano-work.js';
import { validateNanoRpcUrl } from './nano-setup.js';

export const nanoWalletUsage = `Nano wallet: atto-marketplace-mcp wallet setup --asset XNO --network <nano:dev|nano:mainnet> [--rpc-url <url>] [--work-url <url>] --origin <marketplace-origin> --audience <audience> [--home <private-directory>] [--index <index>] [--recovery-wallet-dir <existing-Atto-wallet-directory> | --seed-file <private-file>] [--allow-external-transfers] [--allow-purpose <purpose>] [--max-payment-atomic <raw>] [--rolling-24h-atomic <raw>] [--unlimited]\nRPC defaults for new profiles: nano:mainnet uses https://rpc.nano.to; nano:dev uses http://localhost:17076. Existing profiles retain their configured RPC when --rpc-url is omitted. Work uses an explicit or saved --work-url. Signed-in production mainnet wallets using the default RPC use Marketplace for work. Other wallets use their RPC.\nPolicy: atto-marketplace-mcp wallet policy --asset XNO [--home <private-directory>] [--allow-external-transfers] [--allow-purpose <purpose>] [--max-payment-atomic <raw> --rolling-24h-atomic <raw> | --unlimited]\nUnlimited spending can spend the available wallet balance, including future deposits.\nApproval: atto-marketplace-mcp approve <private-request-path> [--home <private-directory>]\nStatus: atto-marketplace-mcp wallet status --asset XNO [--home <private-directory>]\n`;

export async function runNanoTerminal(argv:string[],env:NodeJS.ProcessEnv):Promise<void> {
  const output=takeJsonFlag(argv); argv=output.argv;
  if(argv.includes('--help')||argv.includes('-h')) {process.stdout.write(nanoWalletUsage);return;}
  const command=argv[0];
  const values=new Map<string,string>();const purposes:string[]=[];const flags=new Set<string>();
  const valueNames=new Set(['--asset','--network','--rpc-url','--work-url','--origin','--audience','--home','--index','--seed-file',
    '--max-payment-atomic','--rolling-24h-atomic','--recovery-wallet-dir']);
  for(let index=1;index<argv.length;index++) {
    const arg=argv[index]!;
    if(['--allow-external-transfers','--unlimited'].includes(arg)) {
      if(flags.has(arg))throw usage();flags.add(arg);continue;
    }
    const value=argv[++index];
    if(!value||value.startsWith('--'))throw usage();
    if(arg==='--allow-purpose') {purposes.push(value);continue;}
    if(!valueNames.has(arg)||values.has(arg))throw usage();values.set(arg,value);
  }
  if(values.get('--asset')!=='XNO')throw usage();
  const selected=environment(values.get('--home'),env);
  const dataDir=selected.MARKETPLACE_MCP_NANO_WALLET_DATA_DIR!;
  if(command==='status') {
    if(flags.size||purposes.length||[...values.keys()].some(key=>!['--asset','--home'].includes(key)))throw usage();
    writeTerminalResult(await callWallet(selected,{asset:'XNO',operation:'identity.list',input:{}}),output.json);return;
  }
  if(command==='policy') {
    requireTerminal();
    if([...values.keys()].some(key=>!['--asset','--home','--max-payment-atomic','--rolling-24h-atomic'].includes(key)))throw usage();
    const config=loadConfiguration(dataDir);
    const limits=selectedLimits(values,flags,config.limits);
    const grants={externalTransfers:flags.has('--allow-external-transfers'),controllerPurposes:purposes as ControllerPurpose[]};
    validateConfiguration({...config,grants,limits});
    const terms={directory:dataDir,address:config.sourceAddress,network:config.network,grants,limits,
      ...(limits.maxPaymentAtomic===null?{spending:'Unlimited: can spend the available wallet balance, including future deposits.'}:{})};
    if(!await confirm(`${output.json?JSON.stringify(terms,null,2):terminalFields(terms)}\nReplace this wallet's approved policy; its keys and journal stay in this profile.\n`))throw new ProfileError('APPROVAL_DECLINED','Nano policy approval was declined.');
    if(JSON.stringify(loadConfiguration(dataDir))!==JSON.stringify(config))throw new ProfileError('WALLET_CONFIGURATION_CHANGED','The Nano profile changed during review. Repeat policy approval against its current settings.');
    await approveNanoWalletPolicy({dataDir,grants,limits,expectedConfiguration:config,terminalConfirmed:true});
    writeTerminalResult(await callWallet(selected,{asset:'XNO',operation:'identity.list',input:{}}),output.json);return;
  }
  if(command!=='setup')throw usage();requireTerminal();
  const network=values.get('--network');
  const origin=values.get('--origin');const audience=values.get('--audience');
  if((network!=='nano:mainnet'&&network!=='nano:dev')||!origin||!audience)throw usage();
  const existing=existsSync(join(dataDir,'wallet.json'))?loadConfiguration(dataDir):undefined;
  const rpcUrl=validateNanoRpcUrl(values.get('--rpc-url')??existing?.rpcUrl??defaultNanoRpcUrl(network));
  const selectedWorkUrl=values.get('--work-url')??existing?.workUrl;
  const workUrl=selectedWorkUrl===undefined?undefined:validateNanoRpcUrl(selectedWorkUrl);
  const index=values.get('--index')??(existing?String(existing.derivationIndex):values.has('--seed-file')?'1':'0');
  if(!/^(0|[1-9][0-9]{0,9})$/.test(index)||Number(index)>0xffffffff)throw usage();
  const limits=selectedLimits(values,flags,existing?.limits);
  const {maxPaymentAtomic,rolling24hAtomic}=limits;
  const grants={externalTransfers:flags.has('--allow-external-transfers')||existing?.grants.externalTransfers||false,
    controllerPurposes:[...new Set([...(existing?.grants.controllerPurposes??[]),...purposes])] as ControllerPurpose[]};
  if(existing)validateConfiguration({...existing,grants,limits});
  if(values.has('--seed-file')&&values.has('--recovery-wallet-dir'))throw usage();
  if(existing?.keySource.type==='native-seed'&&values.has('--recovery-wallet-dir'))throw new ProfileError('WALLET_KEY_MISMATCH','Reuse this Nano seed wallet with its original journal. Shared recovery requires a new wallet directory.');
  if(existing?.keySource.type==='shared-recovery'&&values.has('--seed-file'))throw new ProfileError('WALLET_KEY_MISMATCH','Reuse this Nano wallet with its pinned recovery source.');
  const recoveryWalletDirectory=values.has('--seed-file')||existing?.keySource.type==='native-seed'?undefined:resolve(values.get('--recovery-wallet-dir')??(existing?.keySource.type==='shared-recovery'?existing.keySource.recoverySource.directory:selected.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR!));
  if(existing?.keySource.type==='shared-recovery'&&recoveryWalletDirectory!==existing.keySource.recoverySource.directory)throw new ProfileError('WALLET_KEY_MISMATCH','The recovery wallet must match this existing Nano profile.');
  if(recoveryWalletDirectory&&Number(index)>0x7fffffff)throw usage();
  const previousAttoDirectory=readWalletSelection(selected.MARKETPLACE_MCP_HOME!)?.attoDirectory??env.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR;
  const selectedAttoDirectory=previousAttoDirectory&&existsSync(join(previousAttoDirectory,'state.sqlite'))?previousAttoDirectory:undefined;
  const recovery=recoveryWalletDirectory&&existsSync(join(recoveryWalletDirectory,'state.sqlite'))?await inspectNanoRecoveryWallet(recoveryWalletDirectory,Number(index)):undefined;
  const seedFile=values.get('--seed-file')??(existing?.keySource.type==='native-seed'?existing.keySource.seedFile:undefined);
  const imported=seedFile?(existing?{address:existing.sourceAddress,index:existing.derivationIndex}:await inspectNanoSeed(seedFile,Number(index))):undefined;
  const controllerDirectory=selected.MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR!;
  const separateController=controllerDirectory!==dataDir?loadConfiguration(controllerDirectory):undefined;
  const terms={...(imported?{importedPublicAddress:imported.address}:{}),
    ...(separateController?{separateController:{address:separateController.sourceAddress,directory:controllerDirectory}}:{}),
    walletDirectory:dataDir,network,rpcUrl,workUrl:workUrl??rpcUrl,
    ...(usesMarketplaceWork({network,rpcUrl,workUrl,origin,audience}) && {signedInWorkUrl:origin+'/v1/agent/wallets/xno/work'}),marketplaceOrigin:origin,audience,index,
    externalTransfers:grants.externalTransfers,controllerPurposes:grants.controllerPurposes,
    maximumPerPaymentRaw:maxPaymentAtomic,rolling24HoursRaw:rolling24hAtomic,
    ...(maxPaymentAtomic===null?{spending:'Unlimited: can spend the available wallet balance, including future deposits.'}:{}),
    recovery:seedFile?'Use the selected existing private seed file.':{directory:recoveryWalletDirectory,path:`m/44'/165'/${index}'`,...(recovery?{publicAddress:recovery.address}:{})}};
  const preview=output.json?JSON.stringify(terms,null,2):terminalFields(terms);
  if(!await confirm(preview))throw new ProfileError('APPROVAL_DECLINED','Nano wallet setup was declined.');
  if(recoveryWalletDirectory&&!recovery)await initializeMarketplaceRecoveryWallet(recoveryWalletDirectory);
  const current=recoveryWalletDirectory?await inspectNanoRecoveryWallet(recoveryWalletDirectory,Number(index)):undefined;
  if(recovery&&JSON.stringify(current)!==JSON.stringify(recovery))throw new ProfileError('WALLET_KEY_MISMATCH','The recovery wallet changed during review.');
  const result=await provisionNanoWallet({dataDir,derivationIndex:Number(index),network:network as 'nano:mainnet'|'nano:dev',
    rpcUrl,...(workUrl===undefined?{}:{workUrl}),origin,audience,
    ...(imported?{seedFile:seedFile!,expectedAddress:imported.address}:{}),
    ...(recoveryWalletDirectory?{recoveryWalletDirectory,expectedAddress:current!.address}:{}),
    grants,limits,terminalConfirmed:true});
  ensurePrivateDirectory(selected.MARKETPLACE_MCP_HOME!);
  await saveWalletSelection(selected.MARKETPLACE_MCP_HOME!,{...(recoveryWalletDirectory?{attoDirectory:selectedAttoDirectory??recoveryWalletDirectory}:{}),nanoDirectory:dataDir,nanoControllerDirectory:controllerDirectory});
  writeTerminalResult({status:'wallet-configured',...result},output.json);
}
function environment(home:string|undefined,env:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
  return managedWalletEnvironment(resolve(home??env.MARKETPLACE_MCP_HOME??defaultMarketplaceHome(env)),env);
}
function requireTerminal():void {
  if(!process.stdin.isTTY||!process.stderr.isTTY)throw new ProfileError('TERMINAL_REQUIRED','Marketplace wallet setup and approvals require an interactive local terminal.');
}
async function confirm(preview:string):Promise<boolean> {
  process.stderr.write(preview.endsWith('\n')?preview:`${preview}\n`);
  const terminal=createInterface({input:process.stdin,output:process.stderr});
  try{return (await terminal.question('Type APPROVE to confirm: ')).trim()==='APPROVE';}finally{terminal.close();}
}
function usage():ProfileError{return new ProfileError('SETUP_USAGE',nanoWalletUsage.trim());}

function selectedLimits(values: Map<string,string>, flags: Set<string>, current?: {maxPaymentAtomic:string|null;rolling24hAtomic:string|null}): {maxPaymentAtomic:string|null;rolling24hAtomic:string|null} {
  if (flags.has('--unlimited')) {
    if (values.has('--max-payment-atomic') || values.has('--rolling-24h-atomic')) throw usage();
    return {maxPaymentAtomic:null,rolling24hAtomic:null};
  }
  const limits = {
    maxPaymentAtomic: values.has('--max-payment-atomic') ? values.get('--max-payment-atomic')! : current ? current.maxPaymentAtomic : '0',
    rolling24hAtomic: values.has('--rolling-24h-atomic') ? values.get('--rolling-24h-atomic')! : current ? current.rolling24hAtomic : '0',
  };
  if ((limits.maxPaymentAtomic===null)!==(limits.rolling24hAtomic===null)) throw usage();
  for(const amount of [limits.maxPaymentAtomic,limits.rolling24hAtomic]) if(amount!==null && !/^(0|[1-9][0-9]{0,38})$/.test(amount)) throw usage();
  return limits;
}
