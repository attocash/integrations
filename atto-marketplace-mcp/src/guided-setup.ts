import {fileURLToPath} from 'node:url';
import {inspectNanoWallet} from '@attocash/atto-marketplace-nano-adapter';
import {MarketplaceProfileStore,ProfileError} from './profile-store.js';
import {readWalletSelection,saveWalletSelection} from './wallet-preferences.js';
import {ensurePaymentHandoffDirectory} from './payment-handoff-files.js';
import {managedWalletEnvironment} from './wallet-home.js';
import {setupAttoWalletInteractive,type AttoSetupResult} from './atto-setup.js';
import {setupNanoWalletInteractive} from './nano-setup.js';
import {runSetup} from './setup.js';
import {defaultMarketplaceHome,defaultMarketplaceProfile,marketplaceConnection} from './defaults.js';
import {approveMarketplaceController} from './approval-terminal.js';
import {approvalRequestPath} from './approval-files.js';
import {absoluteDirectory,requireSetupTerminal,terminalPrompt,yesNo,type Prompt} from './terminal-input.js';

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
  const env=Object.fromEntries(['MARKETPLACE_MCP_HOME','MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR','MARKETPLACE_MCP_NANO_WALLET_DATA_DIR','MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR','MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR'].map(key=>[key,selected[key]!]));
  return {mcpServers:{'atto-marketplace':{command:process.execPath,args:[fileURLToPath(new URL('./main.js',import.meta.url)),'--home',home,'--profile',profile],env}}};
}
async function saveNanoSelection(home:string,directory:string,env:NodeJS.ProcessEnv,prompt:Prompt):Promise<NodeJS.ProcessEnv> {
  const wallet=await inspectNanoWallet(directory);
  let selected={...env,MARKETPLACE_MCP_NANO_WALLET_DATA_DIR:directory,MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR:wallet.handoffDirectory};
  const configured=managedWalletEnvironment(home,selected);
  let controllerDirectory=configured.MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR!;
  if(controllerDirectory!==directory){
    const controller=await inspectNanoWallet(controllerDirectory);
    process.stderr.write(`Selected separate Nano controller: ${controller.sourceAddress} at ${JSON.stringify(controllerDirectory)}\n`);
    if(!await yesNo(prompt,'Keep this separate Nano controller for Marketplace approvals?',true))controllerDirectory=directory;
  }
  ensurePaymentHandoffDirectory(home);
  await saveWalletSelection(home,{nanoDirectory:directory,nanoControllerDirectory:controllerDirectory,paymentHandoffDirectory:wallet.handoffDirectory});
  return {...selected,MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR:controllerDirectory};
}

export async function runGuidedSetup(argv:string[],env:NodeJS.ProcessEnv,prompt:Prompt=terminalPrompt):Promise<void> {
  requireSetupTerminal();
  const options=optionsFromArgs(argv);
  process.stderr.write('Atto Marketplace setup. Wallet keys stay local; Marketplace account and session configuration has its own directory.\n');
  const home=absoluteDirectory(options.home??env.MARKETPLACE_MCP_HOME??defaultMarketplaceHome(env));
  const profile=options.profile??env.MARKETPLACE_MCP_PROFILE??defaultMarketplaceProfile;
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(profile))throw new ProfileError('SETUP_USAGE','Choose a profile name of 1–48 letters, digits, underscores or hyphens.');
  // Read selected paths before opening any replacement wallet. Missing saved paths fail closed.
  managedWalletEnvironment(home,env);
  let effectiveEnv={...env};
  const store=await MarketplaceProfileStore.open(home);
  let existing=false,pending=false,reauthenticate=false;
  try{
    existing=store.listProfileIds().includes(profile);
    const savedSetup=store.getSetupState(profile);pending=Boolean(savedSetup);
    const saved=existing?store.getProfile(profile):savedSetup?JSON.parse(savedSetup.privatePayload) as {origin:string;audience:string}:undefined;
    if(saved&&((options.origin!==undefined&&options.origin!==saved.origin)||(options.audience!==undefined&&options.audience!==saved.audience))) {
      throw new ProfileError('PROFILE_CONFLICT','This profile is pinned to its saved Marketplace origin and audience. Use its original connection settings or choose a new profile.');
    }
    reauthenticate=existing&&store.needsReauthentication(profile);
  }finally{store.close();}
  if(existing&&reauthenticate){
    if(!await yesNo(prompt,'Reconnect this profile using its original account and controller?',true))throw new ProfileError('CANCELLED','The original profile and payment journals were preserved.');
    await connectWithTerminalApproval(['--profile',profile,'--home',home,'--reauthenticate'],{...env,...managedWalletEnvironment(home,{})},home,profile,prompt);
    process.stdout.write(`${JSON.stringify({status:'ready',home,profileId:profile,...publicHostConfiguration(home,profile)})}\n`);return;
  }
  if(existing){
    process.stderr.write(`Marketplace profile ${JSON.stringify(profile)} is already configured. Its account and controller are preserved. Use wallet setup to change an explicitly selected wallet.\n`);
    process.stdout.write(`${JSON.stringify({status:'ready',home,profileId:profile,...publicHostConfiguration(home,profile)})}\n`);return;
  }
  if(pending){
    if(!await yesNo(prompt,'Resume this profile’s saved Marketplace setup?',true))throw new ProfileError('CANCELLED','Pending Marketplace setup was preserved.');
    const approved=readWalletSelection(home);
    const resumeEnv={...env};
    if(approved?.attoDirectory)resumeEnv.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR=approved.attoDirectory;
    if(approved?.nanoDirectory){resumeEnv.MARKETPLACE_MCP_NANO_WALLET_DATA_DIR=approved.nanoDirectory;resumeEnv.MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR=approved.nanoControllerDirectory??approved.nanoDirectory;}
    if(approved?.paymentHandoffDirectory)resumeEnv.MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR=approved.paymentHandoffDirectory;
    await connectWithTerminalApproval(['--profile',profile,'--home',home,'--complete'],resumeEnv,home,profile,prompt);
    const resumed=await MarketplaceProfileStore.open(home);
    try{if(resumed.listProfileIds().includes(profile))process.stdout.write(`${JSON.stringify({status:'ready',home,profileId:profile,...publicHostConfiguration(home,profile)})}\n`);}finally{resumed.close();}
    return;
  }
  const {origin,audience}=marketplaceConnection(options);
  process.stderr.write(`Marketplace: ${origin}\nProfile: ${profile}\nConfiguration: ${home}\n`);
  let atto:AttoSetupResult|undefined;
  let nano:Awaited<ReturnType<typeof setupNanoWalletInteractive>>|undefined;
  if(await yesNo(prompt,'Configure an Atto wallet?',true)){
    atto=await setupAttoWalletInteractive({home,env:effectiveEnv,prompt,advanced:options.advanced??false});
    effectiveEnv.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR=atto.directory;
  }
  if(await yesNo(prompt,'Configure a Nano wallet?',false)){
    nano=await setupNanoWalletInteractive({home,env:managedWalletEnvironment(home,effectiveEnv),origin,audience,prompt});
    effectiveEnv=await saveNanoSelection(home,nano.directory,effectiveEnv,prompt);
  }
  if(!atto&&!nano)throw new ProfileError('SETUP_USAGE','Configure at least one wallet before connecting an agent.');
  const current=managedWalletEnvironment(home,effectiveEnv);
  let network:'ATTO'|'NANO',address:string,index:number;
  if(atto&&nano){
    const choice=await prompt('Marketplace controller: [1] Atto (default), [2] Nano: ')||'1';
    if(choice!=='1'&&choice!=='2')throw new ProfileError('SETUP_USAGE','Choose 1 or 2.');network=choice==='1'?'ATTO':'NANO';
  }else network=atto?'ATTO':'NANO';
  if(network==='ATTO'){address=atto!.address;index=atto!.index;}
  else{
    const controller=await inspectNanoWallet(current.MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR!);
    if(controller.origin!==origin||controller.audience!==audience)throw new ProfileError('WALLET_SETUP_REQUIRED','The selected Nano controller needs this Marketplace origin and audience.');
    address=controller.sourceAddress;index=controller.derivationIndex;
  }
  await connectWithTerminalApproval(['--profile',profile,'--home',home,'--origin',origin,'--audience',audience,'--controller-network',network,
    '--controller-address',address,'--controller-index',String(index),'--mode','controller-session'],effectiveEnv,home,profile,prompt);
  const ready=await MarketplaceProfileStore.open(home);
  try{if(ready.listProfileIds().includes(profile))process.stdout.write(`${JSON.stringify({status:'ready',home,profileId:profile,...publicHostConfiguration(home,profile)})}\n`);}finally{ready.close();}
}

/** Guided setup consumes the same durable approvals printed by explicit setup. */
async function connectWithTerminalApproval(args:string[],env:NodeJS.ProcessEnv,home:string,profile:string,prompt:Prompt):Promise<void> {
  let pending = await setupApproval(home, profile);
  // Resuming an unsigned handoff must review it before --complete consumes it.
  if (args.includes('--complete') && pending) await approve(pending);
  await runSetup(args,env);
  for (let phase=0;phase<2;phase++) {
    pending=await setupApproval(home,profile);
    if (!pending) return;
    await approve(pending);
    await runSetup(['--profile',profile,'--home',home,'--complete'],env);
  }
  async function approve(handoffId:string) {
    await approveMarketplaceController(approvalRequestPath(home,profile,handoffId),{home,env,
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
  const advanced=argv.includes('--advanced');
  if(argv.filter(value=>value==='--advanced').length>1)throw new ProfileError('SETUP_USAGE','Setup options must not be repeated.');
  const args=argv.filter(value=>value!=='--interactive'&&value!=='--advanced');
  const values=new Map<string,string>();
  for(let i=0;i<args.length;i+=2){const name=args[i],value=args[i+1];if(!name||!['--home','--asset','--origin','--audience'].includes(name)||!value||value.startsWith('--')||values.has(name))throw new ProfileError('SETUP_USAGE','Use wallet setup [--interactive] [--advanced] [--home <directory>] [--asset ATTO|XNO] [--origin <origin>] [--audience <audience>].');values.set(name,value);}
  const home=absoluteDirectory(values.get('--home')??env.MARKETPLACE_MCP_HOME??defaultMarketplaceHome(env));
  // Reject incomplete custom bindings before asking for or changing any wallet.
  if(values.has('--origin')||values.has('--audience'))marketplaceConnection({...(values.has('--origin')?{origin:values.get('--origin')!}:{}),...(values.has('--audience')?{audience:values.get('--audience')!}:{})});
  const asset=values.get('--asset')??((await prompt('Wallet asset: [1] Atto (default), [2] Nano: ')||'1')==='2'?'XNO':'ATTO');
  if(asset==='XNO'){
    const wallet=await setupNanoWalletInteractive({home,env:managedWalletEnvironment(home,env),prompt,
      ...(values.has('--origin')?{origin:values.get('--origin')!}:{}),...(values.has('--audience')?{audience:values.get('--audience')!}:{})});
    await saveNanoSelection(home,wallet.directory,env,prompt);
    process.stdout.write(`${JSON.stringify({status:'wallet-configured',asset:'XNO',...wallet})}\n`);
  }else if(asset==='ATTO'){
    const wallet=await setupAttoWalletInteractive({home,env,prompt,advanced});
    process.stdout.write(`${JSON.stringify({status:'wallet-configured',asset:'ATTO',...wallet})}\n`);
  }else throw new ProfileError('SETUP_USAGE','Choose ATTO or XNO.');
}
