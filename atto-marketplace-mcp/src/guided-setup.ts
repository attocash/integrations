import { takeJsonFlag, terminalText, writeTerminalResult } from './terminal-output.js';
import {isDeepStrictEqual} from 'node:util';
import type {DeferredWalletPlan} from './wallet-plan.js';
import {fileURLToPath} from 'node:url';
import {inspectNanoWallet,loadConfiguration} from '@attocash/atto-marketplace-nano-adapter';
import {MarketplaceProfileStore,ProfileError} from './profile-store.js';
import {readWalletSelection,saveWalletSelection,type WalletSelection} from './wallet-preferences.js';
import {ensurePrivateDirectory} from './private-directory.js';
import {managedWalletEnvironment} from './wallet-home.js';
import {setupAttoWalletInteractive,prepareAttoWalletInteractive,type AttoDeferredWalletPlan,type AttoSetupResult} from './atto-setup.js';
import {setupNanoWalletInteractive,prepareNanoWalletInteractive} from './nano-setup.js';
import {runSetup,isUnknownSetupState,unknownSetupOutcome,expiredUnsignedLoginApproval,type WalletConsentIntent} from './setup.js';
import {marketplaceCommand,shellQuote} from './shell-quote.js';
import {inspectMarketplaceWalletSetup,marketplacePaymentsUsable} from '@attocash/cli/internal-marketplace';
import {defaultMarketplaceHome,defaultMarketplaceProfile,marketplaceConnection,productionMarketplaceOrigin} from './defaults.js';
import {approveMarketplaceController} from './approval-terminal.js';
import {approvalRequestPath} from './approval-files.js';
import {absoluteDirectory,requireSetupTerminal,terminalPrompt,yesNo,menuChoice,type Prompt} from './terminal-input.js';

interface GuidedOptions {home?:string;profile?:string;origin?:string;audience?:string;advanced?:boolean}
function optionsFromArgs(argv:string[]):GuidedOptions {
  const result:GuidedOptions={};
  for(let i=0;i<argv.length;i++){
    const name=argv[i]!;if(name==='--interactive')continue;
    if(name==='--advanced'){if(result.advanced)throw new ProfileError('SETUP_USAGE','Setup options must not be repeated.');result.advanced=true;continue;}
    if(!['--home','--profile','--origin','--audience'].includes(name)||!argv[i+1]||argv[i+1]!.startsWith('--'))throw new ProfileError('SETUP_USAGE','Use setup [--interactive] [--advanced] [--home <directory>] [--profile <name>] [--origin <origin>] [--audience <audience>].');
    const key=name.slice(2) as Exclude<keyof GuidedOptions,'advanced'>;if(result[key]!==undefined)throw new ProfileError('SETUP_USAGE','Setup options must not be repeated.');result[key]=argv[++i]!;
  }
  return result;
}
function publicHostConfiguration(home:string,profile:string):Record<string,unknown> {
  const selected=managedWalletEnvironment(home,{});
  const env=Object.fromEntries(['MARKETPLACE_MCP_HOME','MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR','MARKETPLACE_MCP_NANO_WALLET_DATA_DIR','MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR'].map(key=>[key,selected[key]!]));
  return {mcpServers:{'atto-marketplace':{command:process.execPath,args:[fileURLToPath(new URL('./main.js',import.meta.url)),'--home',home,'--profile',profile],env}}};
}
async function saveNanoSelection(home:string,directory:string,env:NodeJS.ProcessEnv,prompt:Prompt):Promise<NodeJS.ProcessEnv> {
  const wallet=await inspectNanoWallet(directory);
  let selected={...env,MARKETPLACE_MCP_NANO_WALLET_DATA_DIR:directory};
  const configured=managedWalletEnvironment(home,selected);
  let controllerDirectory=configured.MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR!;
  if(controllerDirectory!==directory){
    const controller=await inspectNanoWallet(controllerDirectory);
    process.stderr.write(`Selected separate Nano controller: ${terminalText(controller.sourceAddress)} at ${terminalText(controllerDirectory)}\n`);
    if(!await yesNo(prompt,'Keep this separate Nano controller for Marketplace approvals?',true))controllerDirectory=directory;
  }
  ensurePrivateDirectory(home);
  await saveWalletSelection(home,{nanoDirectory:directory,nanoControllerDirectory:controllerDirectory});
  return {...selected,MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR:controllerDirectory};
}

export async function runGuidedSetup(argv:string[],env:NodeJS.ProcessEnv,prompt:Prompt=terminalPrompt):Promise<void> {
  requireSetupTerminal();
  const selected=takeJsonFlag(argv);
  const options=optionsFromArgs(selected.argv);
  process.stderr.write('Atto Marketplace setup. Wallet keys stay local; Marketplace account and session configuration has its own directory.\n');
  const home=absoluteDirectory(options.home??env.MARKETPLACE_MCP_HOME??defaultMarketplaceHome(env));
  const profile=options.profile??env.MARKETPLACE_MCP_PROFILE??defaultMarketplaceProfile;
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(profile))throw new ProfileError('SETUP_USAGE','Choose a profile name of 1–48 letters, digits, underscores or hyphens.');
  // Read selected paths before opening any replacement wallet. Missing saved paths fail closed.
  managedWalletEnvironment(home,env);
  let effectiveEnv={...env};
  const store=await MarketplaceProfileStore.open(home);
  let existing=false,pending=false,reauthenticate=false,expiredUnsigned=false;
  let pendingSetup:{state:string;privatePayload:string}|undefined;
  try{
    existing=store.listProfileIds().includes(profile);
    const savedSetup=store.getSetupState(profile);pendingSetup=savedSetup;pending=Boolean(savedSetup);
    const saved=existing?store.getProfile(profile):savedSetup?JSON.parse(savedSetup.privatePayload) as {origin:string;audience:string}:undefined;
    if(saved&&((options.origin!==undefined&&options.origin!==saved.origin)||(options.audience!==undefined&&options.audience!==saved.audience))) {
      throw new ProfileError('PROFILE_CONFLICT','This profile is pinned to its saved Marketplace origin and audience. Use its original connection settings or choose a new profile.');
    }
    reauthenticate=existing&&store.needsReauthentication(profile);
    if(savedSetup&&isUnknownSetupState(savedSetup.state)&&!reauthenticate)throw unknownSetupOutcome(store,profile,home);
    if(savedSetup&&!reauthenticate)expiredUnsigned=Boolean(expiredUnsignedLoginApproval(store,profile,home));
  }finally{store.close();}
  if(existing&&reauthenticate){
    if(!await yesNo(prompt,'Reconnect this profile using its original account and controller?',true))throw new ProfileError('CANCELLED','The original profile and payment journals were preserved.');
    await connectWithTerminalApproval(['--profile',profile,'--home',home,'--reauthenticate'],{...env,...managedWalletEnvironment(home,{})},home,profile,prompt,selected.json);
    await reportReady(home,profile,selected.json);return;
  }
  if(existing){
    process.stderr.write(`Marketplace profile ${profile} is already configured. Its account and controller are preserved. Use wallet setup to change an explicitly selected wallet.\n`);
    await reportReady(home,profile,selected.json);return;
  }
  if(pendingSetup&&JSON.parse(pendingSetup.privatePayload).walletConsent){
    if(expiredUnsigned){
      if(!await yesNo(prompt,'The login approval expired. Request a fresh approval for this wallet?',true))throw new ProfileError('CANCELLED','The pending setup and wallets were preserved.');
      await runSetup(['--profile',profile,'--home',home,'--complete'],env,{quiet:true});
      const fresh=await MarketplaceProfileStore.open(home);try{pendingSetup=fresh.getSetupState(profile);}finally{fresh.close();}
    }
    if(!pendingSetup)throw new ProfileError('SETUP_STATE','The pending combined review is unavailable.');
    await runSingleApprovalSetup({home,profile,env,prompt,json:selected.json,pending:pendingSetup});
    await reportReady(home,profile,selected.json);return;
  }
  if(pending){
    if(!await yesNo(prompt,expiredUnsigned?'The login approval expired. Request a fresh approval for this wallet?':'Resume this profile’s saved Marketplace setup?',true))throw new ProfileError('CANCELLED','Pending Marketplace setup was preserved.');
    const approved=readWalletSelection(home);
    const resumeEnv={...env};
    if(approved?.attoDirectory)resumeEnv.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR=approved.attoDirectory;
    if(approved?.nanoDirectory){resumeEnv.MARKETPLACE_MCP_NANO_WALLET_DATA_DIR=approved.nanoDirectory;resumeEnv.MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR=approved.nanoControllerDirectory??approved.nanoDirectory;}
    if(expiredUnsigned)await runSetup(['--profile',profile,'--home',home,'--complete'],resumeEnv,{quiet:true});
    await connectWithTerminalApproval(['--profile',profile,'--home',home,'--complete'],resumeEnv,home,profile,prompt,selected.json);
    const resumed=await MarketplaceProfileStore.open(home);
    try{if(resumed.listProfileIds().includes(profile))await reportReady(home,profile,selected.json);}finally{resumed.close();}
    return;
  }
  const {origin,audience}=marketplaceConnection(options);
  process.stderr.write(`Marketplace [${productionMarketplaceOrigin}]: ${terminalText(origin)}\nProfile: ${profile}\nConfiguration: ${terminalText(home)}\n`);
  if(!options.advanced){
    await runSingleApprovalSetup({home,profile,env:effectiveEnv,prompt,json:selected.json,origin,audience});
    await reportReady(home,profile,selected.json);return;
  }
  const continueCommand=`${marketplaceCommand} setup --home ${shellQuote(home)} --profile ${shellQuote(profile)} --origin ${shellQuote(origin)} --audience ${shellQuote(audience)}${options.advanced?' --advanced':''}`;
  let atto:AttoSetupResult|undefined;
  let nano:Awaited<ReturnType<typeof setupNanoWalletInteractive>>|undefined;
  if(await yesNo(prompt,'Configure an Atto wallet?',true)){
    atto=await setupAttoWalletInteractive({home,env:effectiveEnv,prompt,advanced:options.advanced??false,json:selected.json,continueCommand});
    effectiveEnv.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR=atto.directory;
  }
  if(await yesNo(prompt,'Configure a Nano wallet?',false)){
    nano=await setupNanoWalletInteractive({home,env:managedWalletEnvironment(home,effectiveEnv),origin,audience,prompt,advanced:options.advanced??false,json:selected.json});
    effectiveEnv=await saveNanoSelection(home,nano.directory,effectiveEnv,prompt);
  }
  if(!atto&&!nano)throw new ProfileError('SETUP_USAGE','Configure at least one wallet before connecting an agent.');
  const current=managedWalletEnvironment(home,effectiveEnv);
  let network:'ATTO'|'NANO',address:string,index:number;
  if(atto&&nano){
    const choice=await menuChoice(prompt,'Marketplace controller: [1] Atto (default), [2] Nano: ',['1','2'],'1');
    if(choice!=='1'&&choice!=='2')throw new ProfileError('SETUP_USAGE','Choose 1 or 2.');network=choice==='1'?'ATTO':'NANO';
  }else network=atto?'ATTO':'NANO';
  if(network==='ATTO'){address=atto!.address;index=atto!.index;}
  else{
    const controller=await inspectNanoWallet(current.MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR!);
    if(controller.origin!==origin||controller.audience!==audience)throw new ProfileError('WALLET_SETUP_REQUIRED','The selected Nano controller needs this Marketplace origin and audience.');
    address=controller.sourceAddress;index=controller.derivationIndex;
  }
  await connectWithTerminalApproval(['--profile',profile,'--home',home,'--origin',origin,'--audience',audience,'--controller-network',network,
    '--controller-address',address,'--controller-index',String(index),'--mode','controller-session'],effectiveEnv,home,profile,prompt,selected.json,continueCommand);
  const ready=await MarketplaceProfileStore.open(home);
  try{if(ready.listProfileIds().includes(profile))await reportReady(home,profile,selected.json);}finally{ready.close();}
}

interface SingleApprovalOptions {home:string;profile:string;env:NodeJS.ProcessEnv;prompt:Prompt;json:boolean;origin?:string;audience?:string;pending?:{state:string;privatePayload:string}}
async function runSingleApprovalSetup(options:SingleApprovalOptions):Promise<void>{
  const {home,profile,prompt,json}=options;
  const plans:DeferredWalletPlan[]=[];let atto:AttoDeferredWalletPlan|undefined;
  let effectiveEnv={...options.env};
  const initialSelection=readWalletSelection(home);
  const savedControllerDirectory=options.env.MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR??initialSelection?.nanoControllerDirectory;
  let saved=options.pending?JSON.parse(options.pending.privatePayload) as Record<string,unknown>:undefined;
  const connection=saved?{origin:String(saved.origin),audience:String(saved.audience)}:marketplaceConnection(options);
  if(saved){
    const consent=saved.walletConsent as WalletConsentIntent;
    if(consent?.version!==1||!Array.isArray(consent.wallets)||!consent.wallets.length||consent.wallets.length>2
      ||consent.wallets.some(wallet=>!wallet||!['ATTO','XNO'].includes(wallet.asset)||!wallet.intent||typeof wallet.intent!=='object'||Array.isArray(wallet.intent))
      ||new Set(consent.wallets.map(wallet=>wallet.asset)).size!==consent.wallets.length)throw new ProfileError('SETUP_STATE','The saved wallet review is invalid.');
    for(const wallet of consent.wallets){
      if(wallet.asset==='ATTO'){
        atto=await prepareAttoWalletInteractive({home,env:effectiveEnv,prompt,resumeIntent:wallet.intent});plans.push(atto);
        effectiveEnv.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR=atto.wallet.directory;
      }else if(wallet.asset==='XNO'){
        const nano=await prepareNanoWalletInteractive({home,env:effectiveEnv,prompt,...connection,resumeIntent:wallet.intent});plans.push(nano);
        effectiveEnv.MARKETPLACE_MCP_NANO_WALLET_DATA_DIR=nano.wallet.directory;effectiveEnv.MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR=savedControllerDirectory??nano.wallet.directory;
      }else throw new ProfileError('SETUP_STATE','The saved wallet currency is invalid.');
    }
  }else{
    const currencies=await menuChoice(prompt,'Wallets: [1] ATTO (default), [2] Nano, [3] Both: ',['1','2','3'],'1');
    if(currencies!=='2'){
      atto=await prepareAttoWalletInteractive({home,env:effectiveEnv,prompt});plans.push(atto);
      effectiveEnv.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR=atto.wallet.directory;
    }
    if(currencies!=='1'){
      const nano=await prepareNanoWalletInteractive({home,env:effectiveEnv,prompt,...connection});plans.push(nano);
      effectiveEnv.MARKETPLACE_MCP_NANO_WALLET_DATA_DIR=nano.wallet.directory;effectiveEnv.MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR=savedControllerDirectory??nano.wallet.directory;
    }
  }
  let controller:DeferredWalletPlan;
  let controllerWallet:{directory:string;address:string;index:number;network:string};
  let separateNanoConfiguration:ReturnType<typeof loadConfiguration>|undefined;
  const nanoPlan=plans.find(plan=>plan.asset==='XNO');
  const nanoRoleDirectory=nanoPlan?((saved?.walletConsent as WalletConsentIntent|undefined)?.nanoControllerDirectory??savedControllerDirectory??nanoPlan.wallet.directory):undefined;
  let nanoRoleReview='';
  if(nanoPlan&&nanoRoleDirectory!==nanoPlan.wallet.directory){
    separateNanoConfiguration=loadConfiguration(nanoRoleDirectory!);
    nanoRoleReview=`Nano controller role: preserve ${separateNanoConfiguration.sourceAddress}, account ${separateNanoConfiguration.derivationIndex}, network ${separateNanoConfiguration.network}.`;
  }
  if(saved){
    controller=plans.find(plan=>(plan.asset==='ATTO'?'ATTO':'NANO')===saved!.controllerNetwork)!;
    if(!controller)throw new ProfileError('APPROVAL_BINDING','The saved login does not match a reviewed wallet currency.');
  }else if(plans.length===2){
    const choice=await menuChoice(prompt,'Sign in with: [1] ATTO (default), [2] Nano: ',['1','2'],'1');
    controller=plans.find(plan=>plan.asset===(choice==='1'?'ATTO':'XNO'))!;
  }else controller=plans[0]!;
  controllerWallet=controller.wallet;
  if(controller.asset==='XNO'){
    const remembered=(saved?.walletConsent as WalletConsentIntent|undefined)?.controller;
    const directory=remembered?.directory??nanoRoleDirectory??controller.wallet.directory;
    if(directory!==controller.wallet.directory){
      separateNanoConfiguration=loadConfiguration(directory);
      const config=separateNanoConfiguration;
      if(config.origin!==connection.origin||config.audience!==connection.audience)throw new ProfileError('APPROVAL_BINDING','The saved separate Nano controller belongs to a different Marketplace connection.');
      controllerWallet={directory,address:config.sourceAddress,index:config.derivationIndex,network:config.network};
    }
    effectiveEnv.MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR=directory;
  }
  if(saved&&(controllerWallet.address!==saved.controllerAddress||controllerWallet.index!==saved.controllerIndex))throw new ProfileError('APPROVAL_BINDING','The saved login controller identity changed.');
  let expectedSelection=readWalletSelection(home);
  const assertSelection=()=>{if(!isDeepStrictEqual(expectedSelection,readWalletSelection(home)))throw new ProfileError('WALLET_CONFIGURATION_CHANGED','The selected wallets changed during combined review.');};
  const validate=async()=>{
    assertSelection();for(const plan of plans)await plan.validate();
    if(separateNanoConfiguration&&!isDeepStrictEqual(separateNanoConfiguration,loadConfiguration(nanoRoleDirectory??controllerWallet.directory)))throw new ProfileError('WALLET_CONFIGURATION_CHANGED','The saved separate Nano controller changed during review.');
    assertSelection();
  };
  await validate();
  if(!saved){
    await runSetup(['--profile',profile,'--home',home,'--origin',connection.origin,'--audience',connection.audience,
      '--controller-network',controller.asset==='ATTO'?'ATTO':'NANO','--controller-address',controllerWallet.address,'--controller-index',String(controllerWallet.index),'--mode','controller-session'],effectiveEnv,
      {quiet:true,walletConsent:{version:1,controller:controllerWallet,...(nanoRoleDirectory?{nanoControllerDirectory:nanoRoleDirectory}:{}),wallets:plans.map(plan=>({asset:plan.asset,intent:plan.intent}))}});
  }else if(options.pending?.state==='LOGIN_READY')await runSetup(['--profile',profile,'--home',home,'--complete'],effectiveEnv,{quiet:true,allowLoginRefresh:false});
  const store=await MarketplaceProfileStore.open(home);let pending:{state:string;privatePayload:string}|undefined;
  try{pending=store.getSetupState(profile);}finally{store.close();}
  if(pending?.state!=='LOGIN_APPROVAL')throw new ProfileError('SETUP_STATE','The combined login approval is unavailable.');
  saved=JSON.parse(pending.privatePayload) as Record<string,unknown>;
  const request=saved.request as {handoffId?:string};
  if(!request?.handoffId)throw new ProfileError('SETUP_STATE','The exact login handoff is missing.');
  const completed:string[]=[];
  try{
    await approveMarketplaceController(approvalRequestPath(home,profile,request.handoffId),{home,env:effectiveEnv,json,
      walletConsent:{expectedPayload:pending.privatePayload,review:plans.map(plan=>plan.review).join('\n\n')+(nanoRoleReview?'\n'+nanoRoleReview:''),
        controller:{directory:controllerWallet.directory,network:controller.asset==='ATTO'?'live':controllerWallet.network,address:controllerWallet.address,index:controllerWallet.index},
        validate,
        async commit(assertCurrent){
          await validate();await assertCurrent();
          for(const plan of plans){
            await validate();await assertCurrent();
            await plan.commit();completed.push(plan.asset);
          }
          await validate();await assertCurrent();
          const nano=plans.find(plan=>plan.asset==='XNO');
          const patch:Partial<WalletSelection>=nano?{nanoDirectory:nano.wallet.directory,nanoControllerDirectory:nanoRoleDirectory??nano.wallet.directory}:{};
          if(atto)expectedSelection=await atto.saveSelection(expectedSelection,patch);
          else{ensurePrivateDirectory(home);expectedSelection=await saveWalletSelection(home,patch,{expected:expectedSelection});}
          await validate();await assertCurrent();
        }},
      prompt:async preview=>(await prompt(`${preview}\nType APPROVE to finish setup: `)).trim()==='APPROVE'});
    await runSetup(['--profile',profile,'--home',home,'--complete'],effectiveEnv,{quiet:true,allowLoginRefresh:false});
  }catch(error){
    if(completed.length)process.stderr.write(`Native wallet review completed for: ${completed.join(', ')}. Marketplace selection or login may still be pending; approved changes were preserved.\n`);
    process.stderr.write(`Continue with: ${marketplaceCommand} setup --home ${shellQuote(home)} --profile ${shellQuote(profile)}\n`);
    throw error;
  }
}

/** Guided setup consumes the same durable approvals printed by explicit setup. */
async function connectWithTerminalApproval(args:string[],env:NodeJS.ProcessEnv,home:string,profile:string,prompt:Prompt,json:boolean,
  continueCommand=`${marketplaceCommand} setup --home ${shellQuote(home)} --profile ${shellQuote(profile)}`):Promise<void> {
  try{await connectWithTerminalApprovalSteps(args,env,home,profile,prompt,json);}
  catch(error){
    process.stderr.write(error instanceof ProfileError&&['SETUP_UNKNOWN','REAUTH_REQUIRED'].includes(error.code)
      ?'Wallet access is saved. Marketplace login outcome is unknown; follow the recovery instruction below.\n'
      :`Wallet access is saved. Marketplace login is incomplete. Continue with: ${terminalText(continueCommand)}\n`);
    throw error;
  }
}
async function connectWithTerminalApprovalSteps(args:string[],env:NodeJS.ProcessEnv,home:string,profile:string,prompt:Prompt,json:boolean):Promise<void> {
  let pending = await setupApproval(home, profile);
  // Resuming an unsigned handoff must review it before --complete consumes it.
  if (args.includes('--complete') && pending) await approve(pending);
  await runSetup(args,env,{quiet:true,allowLoginRefresh:false});
  for (let phase=0;phase<2;phase++) {
    pending=await setupApproval(home,profile);
    if (!pending) return;
    await approve(pending);
    await runSetup(['--profile',profile,'--home',home,'--complete'],env,{quiet:true,allowLoginRefresh:false});
  }
  async function approve(handoffId:string) {
    await approveMarketplaceController(approvalRequestPath(home,profile,handoffId),{home,env,json,
      prompt:async preview=>(await prompt(`${preview}\nType APPROVE to confirm: `)).trim()==='APPROVE'});
  }
}
async function setupApproval(home:string,profile:string):Promise<string|undefined> {
  const store=await MarketplaceProfileStore.open(home);
  try {
    const state=store.getSetupState(profile);
    if (!state || !['LOGIN_APPROVAL','SCOPED_KEY_APPROVAL'].includes(state.state)) return undefined;
    const saved=JSON.parse(state.privatePayload) as {request?:{handoffId?:unknown}};
    if(typeof saved.request?.handoffId!=='string')throw new ProfileError('SETUP_STATE','The pending typed approval is incomplete. Restore its original setup state.');
    return saved.request.handoffId;
  }finally{store.close();}
}

/** Standalone wallet setup persists the approved wallet selection. */
export async function runWalletWizard(argv:string[],env:NodeJS.ProcessEnv,prompt:Prompt=terminalPrompt):Promise<void> {
  requireSetupTerminal();
  const selected=takeJsonFlag(argv); argv=selected.argv;
  const advanced=argv.includes('--advanced');
  if(argv.filter(value=>value==='--advanced').length>1)throw new ProfileError('SETUP_USAGE','Setup options must not be repeated.');
  const args=argv.filter(value=>value!=='--interactive'&&value!=='--advanced');
  const values=new Map<string,string>();
  for(let i=0;i<args.length;i+=2){const name=args[i],value=args[i+1];if(!name||!['--home','--asset','--origin','--audience'].includes(name)||!value||value.startsWith('--')||values.has(name))throw new ProfileError('SETUP_USAGE','Use wallet setup [--interactive] [--advanced] [--home <directory>] [--asset ATTO|XNO] [--origin <origin>] [--audience <audience>].');values.set(name,value);}
  const home=absoluteDirectory(values.get('--home')??env.MARKETPLACE_MCP_HOME??defaultMarketplaceHome(env));
  // Reject incomplete custom bindings before asking for or changing any wallet.
  if(values.has('--origin')||values.has('--audience'))marketplaceConnection({...(values.has('--origin')?{origin:values.get('--origin')!}:{}),...(values.has('--audience')?{audience:values.get('--audience')!}:{})});
  const asset=values.get('--asset')??((await menuChoice(prompt,'Wallet asset: [1] Atto (default), [2] Nano: ',['1','2'],'1'))==='2'?'XNO':'ATTO');
  if(asset==='XNO'){
    const wallet=await setupNanoWalletInteractive({home,env:managedWalletEnvironment(home,env),prompt,advanced,json:selected.json,
      ...(values.has('--origin')?{origin:values.get('--origin')!}:{}),...(values.has('--audience')?{audience:values.get('--audience')!}:{})});
    await saveNanoSelection(home,wallet.directory,env,prompt);
    writeTerminalResult({status:'wallet-configured',asset:'XNO',...wallet},selected.json);
  }else if(asset==='ATTO'){
    const wallet=await setupAttoWalletInteractive({home,env,prompt,advanced,json:selected.json});
    writeTerminalResult({status:'wallet-configured',asset:'ATTO',...wallet},selected.json);
  }else throw new ProfileError('SETUP_USAGE','Choose ATTO or XNO.');
}

async function reportReady(home:string,profile:string,json:boolean):Promise<void> {
  const store=await MarketplaceProfileStore.open(home);
  try {
    const saved=store.getProfile(profile);
    const selection=readWalletSelection(home);
    const access:Record<string,string>={};
    if(selection?.attoDirectory&&selection.attoAccess){
      const native=await inspectMarketplaceWalletSetup({directory:selection.attoDirectory,index:selection.attoAccess.index});
      const grant=selection.attoAccess;
      const payments=grant.externalTransfers&&marketplacePaymentsUsable(native)&&native.fingerprint===grant.fingerprint
        &&native.address===grant.address&&native.network===grant.network;
      const zero=native.policy.perRequest&&Number(native.policy.perRequest.amount)===0||native.policy.rolling.some(rule=>Number(rule.amount)===0);
      access.ATTO=!payments?'Login only':zero?'Receiving allowed; sending blocked by saved zero limits'
        :native.policy.perRequest===null&&native.policy.rolling.length===0?'Unlimited spending (available balance and future deposits)':'Limited spending within saved limits';
    }
    if(selection?.nanoDirectory){
      const wallet=loadConfiguration(selection.nanoDirectory);
      access.XNO=!wallet.grants.externalTransfers?'Login only'
        :wallet.limits.maxPaymentAtomic===null&&wallet.limits.rolling24hAtomic===null?'Unlimited spending (available balance and future deposits)'
        :wallet.limits.maxPaymentAtomic!==null&&wallet.limits.rolling24hAtomic!==null&&BigInt(wallet.limits.maxPaymentAtomic)>0n&&BigInt(wallet.limits.rolling24hAtomic)>0n?'Limited spending within saved limits'
          :'Receiving allowed; sending blocked by saved zero limits';
    }
    writeTerminalResult({status:'ready',home,profileId:profile,...(!json?{origin:saved.origin,audience:saved.audience}:{}),access,...publicHostConfiguration(home,profile)},json);
  }finally{store.close();}
}
