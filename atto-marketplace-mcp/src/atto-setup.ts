import {existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createApplication} from '@attocash/cli/core';
import {defaultCliDirectory} from '@attocash/cli/profiles';
import {defaultLiveEndpoints,setupMarketplaceWallet} from '@attocash/cli/terminal';
import {managedWalletEnvironment} from './wallet-home.js';
import {readWalletSelection,saveWalletSelection,type WalletSelection} from './wallet-preferences.js';
import {isDeepStrictEqual} from 'node:util';
import type {DeferredWalletPlan,WalletAccessMode} from './wallet-plan.js';
import {ProfileError} from './profile-store.js';
import {ensurePrivateDirectory} from './private-directory.js';
import {absoluteDirectory,requiredText,requireSetupTerminal,menuChoice,type Prompt} from './terminal-input.js';
import {approveAttoWalletAccess} from './wallet-access.js';
import {initializeMarketplaceRecoveryWallet,inspectMarketplaceWalletSetup,prepareMarketplacePayments,inspectMarketplacePaymentIntent,validateMarketplacePaymentCap,withUnchangedMarketplaceWalletSetup,marketplacePaymentsUsable} from '@attocash/cli/internal-marketplace';
import {terminalFields,terminalText} from './terminal-output.js';
export interface AttoSetupResult {directory:string;address:string;index:number;network:string}
export interface AttoSetupOptions {home:string;env:NodeJS.ProcessEnv;prompt:Prompt;directory?:string;reuseExisting?:boolean;controllerIndex?:number;network?:string;nodeUrl?:string;workerUrl?:string;advanced?:boolean;json?:boolean;continueCommand?:string;resumeIntent?:Record<string,unknown>}

export interface AttoDeferredWalletPlan extends DeferredWalletPlan {
  saveSelection(expected:WalletSelection|undefined,additional?:Partial<WalletSelection>):Promise<WalletSelection>;
}

/** Standalone wallet configuration shares the same deferred review and native owner. */
export async function setupAttoWalletInteractive(options:AttoSetupOptions):Promise<AttoSetupResult> {
  if(options.advanced)return setupAttoWalletAdvanced(options);
  const plan=await prepareAttoWalletInteractive(options);
  process.stderr.write(`${plan.review}\n`);
  if(await options.prompt('Type APPROVE to save this Marketplace wallet setup: ')!=='APPROVE')throw new ProfileError('APPROVAL_DECLINED','Wallet setup was declined; unapproved payment settings were preserved.');
  await plan.validate();
  await plan.commit();
  await plan.saveSelection(readWalletSelection(options.home));
  return plan.wallet;
}

/** Source/mode questions prepare public intent; payment authority changes only during commit. */
export async function prepareAttoWalletInteractive(options:AttoSetupOptions):Promise<AttoDeferredWalletPlan> {
  requireSetupTerminal();
  const {home,env,prompt}=options,previous=readWalletSelection(home),resume=options.resumeIntent;
  let directory=resume?String(resume.directory):options.directory??env.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR??previous?.attoDirectory;
  let index=resume?Number(resume.index):options.controllerIndex??0;
  if(!resume&&!options.directory){
    const dedicated=join(home,'wallets','atto'),cli=defaultCliDirectory();
    if(directory&&!existsSync(join(directory,'state.sqlite')))throw new ProfileError('WALLET_SETUP_REQUIRED','The selected Atto wallet is unavailable. Restore its original directory before setup.');
    const choices:{label:string;directory:string;method?:'create'|'import'}[]=[];
    const detected=directory??(existsSync(join(dedicated,'state.sqlite'))?dedicated:existsSync(join(cli,'state.sqlite'))?cli:undefined);
    if(detected)choices.push({label:'Continue selected wallet',directory:detected});
    if(cli!==detected&&existsSync(join(cli,'state.sqlite')))choices.push({label:'Continue CLI wallet',directory:cli});
    const managed=join(home,'wallets');
    if(existsSync(managed))for(const name of readdirSync(managed).filter(name=>/^atto(?:-(?:new|import)(?:-[1-9][0-9]*)?)?$/.test(name)).sort()){
      const prepared=join(managed,name);
      if(!choices.some(choice=>choice.directory===prepared)&&existsSync(join(prepared,'state.sqlite')))choices.push({label:`Continue prepared Atto wallet (${name})`,directory:prepared});
    }
    choices.push({label:'Create recovery phrase',directory:unusedRecoveryDirectory(existsSync(dedicated)?join(home,'wallets','atto-new'):dedicated),method:'create'});
    choices.push({label:'Import recovery phrase',directory:unusedRecoveryDirectory(existsSync(dedicated)?join(home,'wallets','atto-import'):dedicated),method:'import'});
    const answer=await menuChoice(prompt,`Atto wallet source: ${choices.map((choice,i)=>`[${i+1}] ${choice.label}${i===0?' (default)':''}`).join(', ')}: `,choices.map((_,i)=>String(i+1)),'1');
    const choice=choices[Number(answer)-1]!;directory=choice.directory;
    if(choice.method){
      if(existsSync(join(directory,'state.sqlite')))throw new ProfileError('WALLET_EXISTS','This recovery wallet already exists. Continue it or choose another directory through advanced setup.');
      ensurePrivateDirectory(home);ensurePrivateDirectory(directory);
      await initializeMarketplaceRecoveryWallet(directory,{method:choice.method});
      index=0;
    }
  }
  if(!directory)throw new ProfileError('WALLET_SETUP_REQUIRED','Choose an Atto wallet source.');
  directory=absoluteDirectory(directory);
  let snapshot=await inspectMarketplaceWalletSetup({directory,index});
  const saved=previous?.attoDirectory===directory?previous.attoAccess:undefined;
  if(!resume&&options.controllerIndex===undefined&&saved&&saved.fingerprint===snapshot.fingerprint&&saved.network===snapshot.network
    &&snapshot.addresses.some(account=>account.index===saved.index&&account.address===saved.address)){
    index=saved.index;snapshot=await inspectMarketplaceWalletSetup({directory,index});
  }
  if((options.network&&options.network!==snapshot.network)||(options.nodeUrl&&options.nodeUrl!==snapshot.settings.nodeUrl)
    ||(options.workerUrl&&options.workerUrl!==snapshot.settings.workerUrl))throw new ProfileError('WALLET_CONFIGURATION_MISMATCH','The supplied network or endpoints differ from the selected wallet.');
  const boundSaved=saved?.fingerprint===snapshot.fingerprint&&saved.address===snapshot.address&&saved.index===snapshot.index&&saved.network===snapshot.network?saved:undefined;
  let mode:WalletAccessMode;
  if(resume){
    if(resume.version!==1||resume.address!==snapshot.address||resume.fingerprint!==snapshot.fingerprint||resume.network!==snapshot.network
      ||!['login-only','limited','unlimited'].includes(String(resume.mode)))throw new ProfileError('WALLET_CONFIGURATION_CHANGED','The saved Atto setup intent no longer matches its original wallet identity.');
    mode=resume.mode as WalletAccessMode;
  }else{
    const unbounded=snapshot.policy.perRequest===null&&snapshot.policy.rolling.length===0;
    const fallback=boundSaved?.externalTransfers?(unbounded?'3':'2'):'1';
    const answer=await menuChoice(prompt,`Atto access: [1] Login only${fallback==='1'?' (default)':''}, [2] Limited spending${fallback==='2'?' (default)':''}, [3] Unlimited spending${fallback==='3'?' (default)':''}: `,['1','2','3'],fallback);
    mode=answer==='1'?'login-only':answer==='2'?'limited':'unlimited';
  }
  const nativeIntent=inspectMarketplacePaymentIntent(snapshot,mode);
  let policy=resume?.policy as typeof snapshot.policy|undefined;
  if(mode==='limited'&&!policy){
    policy=nativeIntent.policy;
    if(nativeIntent.requiresPolicy){
      const payment=await attoCap(prompt,'Maximum ATTO per payment: '),daily=await attoCap(prompt,'Maximum ATTO across a rolling 24 hours: ');
      policy={perRequest:{amount:payment,unit:'ATTO'},rolling:[{days:1,amount:daily,unit:'ATTO'}]};
    }
  }
  if(mode==='unlimited')policy={perRequest:null,rolling:[]};
  const previousProposal=resume?.previousProposal as {id:string;expiresAt:number}|undefined;
  const proposalDescriptor=previousProposal??(nativeIntent.resumeProposalId&&snapshot.proposal?{id:snapshot.proposal.id,expiresAt:snapshot.proposal.expiresAt}:undefined);
  const native=await prepareMarketplacePayments({expected:snapshot,mode,...(mode!=='login-only'&&policy?{policy}:{}),...(previousProposal?{previousProposal}:{})});
  const externalTransfers=mode!=='login-only';
  const grant={address:snapshot.address,index:snapshot.index,network:snapshot.network,fingerprint:snapshot.fingerprint,externalTransfers};
  const matchingSaved=boundSaved;
  const wallet={directory,address:snapshot.address,index:snapshot.index,network:snapshot.network};
  const intent:Record<string,unknown>={version:1,...wallet,fingerprint:snapshot.fingerprint,mode,...(mode!=='login-only'?{policy:policy??nativeIntent.policy}:{}),...(proposalDescriptor?{previousProposal:proposalDescriptor}:{})};
  let expectedSelection=previous,committedSnapshot:typeof snapshot|undefined;
  return {asset:'ATTO',wallet,mode,intent,
    review:`${native.review}\nMarketplace payments for selected account ${snapshot.index}: ${matchingSaved?.externalTransfers?'allowed':'denied'} → ${externalTransfers?'allowed':'denied'}.\nMarketplace receiving follows this selected-account payment grant.`,
    async validate(){
      if(!isDeepStrictEqual(expectedSelection,readWalletSelection(home)))throw new ProfileError('WALLET_CONFIGURATION_CHANGED','The selected wallets changed during setup review.');
      await native.validate();
    },
    async commit(){
      committedSnapshot=await native.commit();
      if(committedSnapshot.fingerprint!==snapshot.fingerprint||committedSnapshot.address!==snapshot.address||committedSnapshot.network!==snapshot.network
        ||(externalTransfers&&!marketplacePaymentsUsable(committedSnapshot)))throw new ProfileError('WALLET_CONFIGURATION_CHANGED','The selected Atto account is no longer eligible for the reviewed payment access.');
      return wallet;
    },
    async saveSelection(expected,additional={}){
      if(!isDeepStrictEqual(expected,expectedSelection))throw new ProfileError('WALLET_CONFIGURATION_CHANGED','Wallet selection no longer belongs to this review.');
      if(!committedSnapshot)throw new ProfileError('WALLET_CONSENT_REQUIRED','Commit the reviewed native wallet settings before saving Marketplace access.');
      await withUnchangedMarketplaceWalletSetup({directory,index:snapshot.index,expected:committedSnapshot,terminalConfirmed:true},async()=>{
        ensurePrivateDirectory(home);
        expectedSelection=await saveWalletSelection(home,{...additional,attoDirectory:directory,attoAccess:grant},{expected:expectedSelection});
      });
      return structuredClone(expectedSelection!);
    },
  };
}
function unusedRecoveryDirectory(base:string):string {
  if(!existsSync(base))return base;
  for(let suffix=2;;suffix++){const candidate=`${base}-${suffix}`;if(!existsSync(candidate))return candidate;}
}
async function attoCap(prompt:Prompt,question:string):Promise<string>{
  for(;;){
    const answer=await prompt(question);
    try{validateMarketplacePaymentCap(answer);return answer;}
    catch(error){
      if(!error||typeof error!=='object'||!('code' in error)||error.code!=='INVALID_AMOUNT')throw error;
      process.stderr.write('Enter an ATTO amount greater than zero, with up to 9 decimal places.\n');
    }
  }
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
      process.stderr.write(`Selected Atto wallet directory: ${terminalText(saved)}\n`);
      choice=await menuChoice(prompt,'Atto wallet: [1] Keep selected wallet (default), [2] Existing CLI wallet, [3] Dedicated Marketplace wallet: ',['1','2','3'],'1');
      if(choice==='1'){directory=saved;reuse=true;}
      else if(choice==='2'){directory=await requiredText(prompt,'Existing Atto CLI wallet directory',defaultCliDirectory());reuse=true;}
      else if(choice==='3'){directory=await requiredText(prompt,'Dedicated Atto wallet directory',join(home,'wallets','atto'));}
      else throw new ProfileError('SETUP_USAGE','Choose 1, 2 or 3.');
    }else{
      choice=await menuChoice(prompt,'Atto wallet: [1] Dedicated Marketplace wallet (default), [2] Existing CLI wallet: ',['1','2'],'1');
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
    const defaults=network==='atto:live'?defaultLiveEndpoints:undefined;
    nodeUrl=httpUrl(await requiredText(prompt,'Trusted Atto node URL',nodeUrl??defaults?.nodeUrl));
    workerUrl=httpUrl(await requiredText(prompt,'Trusted Atto work-service URL',workerUrl??defaults?.workerUrl));
    const review={directory,network,nodeUrl,workerUrl};
    process.stderr.write(`${options.json?JSON.stringify(review,null,2):terminalFields(review)}\n`);
    if(await prompt('Type APPROVE to configure this dedicated Atto wallet: ')!=='APPROVE')throw new ProfileError('CANCELLED','Atto wallet setup was cancelled.');
    ensurePrivateDirectory(home);ensurePrivateDirectory(directory);
  }else{
    process.stderr.write(`Continue with the selected Atto wallet: ${terminalText(directory)}\nUse its existing keys and account history while configuring payment permissions.\n`);
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
  ensurePrivateDirectory(home);
  await approveAttoWalletAccess({home,directory,index:wallet.index,prompt,json:options.json??false});
  return {...wallet,network:network!};
}
function httpUrl(input:string):string {
  let url:URL;try{url=new URL(input);}catch{throw new ProfileError('SETUP_USAGE','Supply an HTTP(S) native service URL.');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash)throw new ProfileError('SETUP_USAGE','Native service URLs must have no credentials or fragment.');
  return input;
}
