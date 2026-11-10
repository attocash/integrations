import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {createApplication} from '@attocash/cli/core';
import {defaultCliDirectory} from '@attocash/cli/profiles';
import {setupMarketplaceWallet} from '@attocash/cli/terminal';
import {managedWalletEnvironment} from './wallet-home.js';
import {readWalletSelection} from './wallet-preferences.js';
import {ProfileError} from './profile-store.js';
import {ensurePaymentHandoffDirectory} from './payment-handoff-files.js';
import {absoluteDirectory,requiredText,requireSetupTerminal,type Prompt} from './terminal-input.js';
import {approveAttoWalletAccess,approveCompactAttoWalletAccess} from './wallet-access.js';
import {inspectMarketplaceWalletSetup} from '@attocash/cli/internal-marketplace';
export interface AttoSetupResult {directory:string;address:string;index:number;network:string}
export interface AttoSetupOptions {home:string;env:NodeJS.ProcessEnv;prompt:Prompt;directory?:string;reuseExisting?:boolean;controllerIndex?:number;network?:string;nodeUrl?:string;workerUrl?:string;advanced?:boolean}

export async function setupAttoWalletInteractive(options:AttoSetupOptions):Promise<AttoSetupResult> {
  if(options.advanced)return setupAttoWalletAdvanced(options);
  requireSetupTerminal();
  const {home,env,prompt}=options;
  const previous=readWalletSelection(home);
  let directory=options.directory??env.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR??previous?.attoDirectory;
  if(!directory){
    const cli=defaultCliDirectory();
    const detected=existsSync(join(cli,'state.sqlite'));
    const choice=await prompt(detected
      ?'Atto wallet: [1] Existing CLI wallet (default), [2] Dedicated Marketplace wallet, [3] Other existing wallet: '
      :'Atto wallet: [1] Dedicated Marketplace wallet (default), [2] Existing CLI wallet: ')||'1';
    if(detected&&choice==='1')directory=cli;
    else if(detected&&choice==='3'||!detected&&choice==='2')directory=await requiredText(prompt,'Existing Atto CLI wallet directory',cli);
    else if(detected&&choice==='2'||!detected&&choice==='1')return setupAttoWalletAdvanced({...options,
      directory:join(home,'wallets','atto'),reuseExisting:false});
    else throw new ProfileError('SETUP_USAGE',detected?'Choose 1, 2 or 3.':'Choose 1 or 2.');
  }
  directory=absoluteDirectory(directory);
  // The read-only CLI boundary never creates accounts, reconciles proposals or opens keys.
  let snapshot=await inspectMarketplaceWalletSetup({directory,index:options.controllerIndex??0});
  const saved=previous?.attoDirectory===directory?previous.attoAccess:undefined;
  if(options.controllerIndex===undefined&&saved&&saved.fingerprint===snapshot.fingerprint&&saved.network===snapshot.network
    &&snapshot.addresses.some(account=>account.index===saved.index&&account.address===saved.address)) {
    snapshot=await inspectMarketplaceWalletSetup({directory,index:saved.index});
  }
  if((options.network&&options.network!==snapshot.network)||(options.nodeUrl&&options.nodeUrl!==snapshot.settings.nodeUrl)
    ||(options.workerUrl&&options.workerUrl!==snapshot.settings.workerUrl))throw new ProfileError('WALLET_CONFIGURATION_MISMATCH','The supplied network or endpoints differ from the selected existing wallet.');
  const approval=await approveCompactAttoWalletAccess({home,snapshot,previous,prompt});
  if(approval==='advanced')return setupAttoWalletAdvanced({...options,directory,reuseExisting:true,controllerIndex:snapshot.index});
  return {directory,address:snapshot.address,index:snapshot.index,network:snapshot.network};
}

/** Explicit advanced setup retains native account-pool and spending-policy configuration. */
async function setupAttoWalletAdvanced(options:AttoSetupOptions):Promise<AttoSetupResult> {
  requireSetupTerminal();
  const {home,env,prompt}=options;
  const selected=managedWalletEnvironment(home,env);
  const previous=readWalletSelection(home);
  const saved=env.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR??previous?.attoDirectory;
  let directory=options.directory,reuse=options.reuseExisting??false;
  if(!directory){
    let choice:string;
    if(saved){
      process.stderr.write(`Selected Atto wallet directory: ${JSON.stringify(saved)}\n`);
      choice=await prompt('Atto wallet: [1] Keep selected wallet (default), [2] Existing CLI wallet, [3] Dedicated Marketplace wallet: ')||'1';
      if(choice==='1'){directory=saved;reuse=true;}
      else if(choice==='2'){directory=await requiredText(prompt,'Existing Atto CLI wallet directory',defaultCliDirectory());reuse=true;}
      else if(choice==='3'){directory=await requiredText(prompt,'Dedicated Atto wallet directory',join(home,'wallets','atto'));}
      else throw new ProfileError('SETUP_USAGE','Choose 1, 2 or 3.');
    }else{
      choice=await prompt('Atto wallet: [1] Dedicated Marketplace wallet (default), [2] Existing CLI wallet: ')||'1';
      if(choice==='2'){directory=await requiredText(prompt,'Existing Atto CLI wallet directory',defaultCliDirectory());reuse=true;}
      else if(choice==='1')directory=await requiredText(prompt,'Dedicated Atto wallet directory',selected.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR!);
      else throw new ProfileError('SETUP_USAGE','Choose 1 or 2.');
    }
  }
  directory=absoluteDirectory(directory);
  const indexText=options.controllerIndex===undefined?await requiredText(prompt,'Atto controller account index','0'):String(options.controllerIndex);
  if(!/^(0|[1-9][0-9]{0,9})$/.test(indexText)||Number(indexText)>0x7fffffff)throw new ProfileError('SETUP_USAGE','Choose an Atto controller index from 0 through 2147483647.');
  if(!reuse&&existsSync(join(directory,'state.sqlite'))){
    const existing=createApplication({directory});
    try{const status=await existing.call('wallet_status',{}) as {initialized:boolean};if(status.initialized)throw new ProfileError('WALLET_EXISTS','This directory already contains a wallet. Choose the existing-wallet option to preserve its configuration.');}
    finally{await existing.close();}
  }
  let network=options.network,nodeUrl=options.nodeUrl,workerUrl=options.workerUrl;
  if(!reuse){
    network=await requiredText(prompt,'Atto network (atto:live, atto:beta, atto:dev or atto:local)',network??'atto:live');
    if(!/^atto:(live|beta|dev|local)$/.test(network))throw new ProfileError('SETUP_USAGE','Choose the exact Atto network.');
    nodeUrl=httpUrl(await requiredText(prompt,'Trusted Atto node URL',nodeUrl));
    workerUrl=httpUrl(await requiredText(prompt,'Trusted Atto work-service URL',workerUrl));
    process.stderr.write(`${JSON.stringify({directory,network,nodeUrl,workerUrl},null,2)}\n`);
    if(await prompt('Type APPROVE to configure this dedicated Atto wallet: ')!=='APPROVE')throw new ProfileError('CANCELLED','Atto wallet setup was cancelled.');
    ensurePaymentHandoffDirectory(home);ensurePaymentHandoffDirectory(directory);
  }else{
    process.stderr.write(`Reuse the original Atto profile ${JSON.stringify(directory)}. Its credentials, settings, spending history and coordination stay shared.\n`);
    if(await prompt('Type REUSE to select this existing Atto wallet: ')!=='REUSE')throw new ProfileError('CANCELLED','Existing Atto wallet selection was cancelled.');
  }
  if(reuse&&(options.network||options.nodeUrl||options.workerUrl)){
    const existing=createApplication({directory});
    try{
      const status=await existing.call('wallet_status',{}) as {settings:{network:string;nodeUrl:string;workerUrl:string}};
      if((options.network&&options.network!==`atto:${status.settings.network.toLowerCase()}`)||(options.nodeUrl&&options.nodeUrl!==status.settings.nodeUrl)||(options.workerUrl&&options.workerUrl!==status.settings.workerUrl))throw new ProfileError('WALLET_CONFIGURATION_MISMATCH','The supplied network or endpoints differ from the selected existing wallet.');
    }finally{await existing.close();}
  }
  const configuration=!reuse?{network:network!.slice(5).toUpperCase() as 'LIVE'|'BETA'|'DEV'|'LOCAL',nodeUrl:nodeUrl!,workerUrl:workerUrl!}:undefined;
  const wallet=await setupMarketplaceWallet({directory,controllerIndex:Number(indexText),typedControllerApprovals:true,...(reuse?{reuseExisting:true}:{}),...(configuration?{configuration}:{})});
  const app=createApplication({directory});
  try{
    const status=await app.call('wallet_status',{}) as {settings:{network:string;nodeUrl:string;workerUrl:string}};
    network=`atto:${status.settings.network.toLowerCase()}`;
    if(reuse&&((options.network&&options.network!==network)||(options.nodeUrl&&options.nodeUrl!==status.settings.nodeUrl)||(options.workerUrl&&options.workerUrl!==status.settings.workerUrl))) {
      throw new ProfileError('WALLET_CONFIGURATION_MISMATCH','The supplied network or endpoints differ from this existing wallet. Configure them through its CLI before setup.');
    }
  }finally{await app.close();}
  ensurePaymentHandoffDirectory(home);
  await approveAttoWalletAccess({home,directory,index:wallet.index,prompt});
  return {...wallet,network:network!};
}
function httpUrl(input:string):string {
  let url:URL;try{url=new URL(input);}catch{throw new ProfileError('SETUP_USAGE','Supply an HTTP(S) native service URL.');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash)throw new ProfileError('SETUP_USAGE','Native service URLs must have no credentials or fragment.');
  return input;
}
