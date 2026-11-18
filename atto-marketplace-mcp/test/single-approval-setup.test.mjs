import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {tmpdir} from '../../test/support/temporary-directory.mjs';
import {AttoApplication} from '../../atto-cli/dist/application/app.js';
import {StateStore} from '../../atto-cli/dist/storage/state.js';
import {OsSecretStore} from '../../atto-cli/dist/storage/secrets.js';
import {inspectMarketplaceWalletSetup} from '../../atto-cli/dist/internal-marketplace.js';
import {provisionNanoWallet,loadConfiguration,approveNanoWalletPolicy} from '@attocash/atto-marketplace-nano-adapter';
import {runGuidedSetup} from '../dist/guided-setup.js';
import {prepareAttoWalletInteractive} from '../dist/atto-setup.js';
import {runSetup} from '../dist/setup.js';
import {approveMarketplaceController} from '../dist/approval-terminal.js';
import {approvalRequestPath,approvalResponsePath} from '../dist/approval-files.js';
import {MarketplaceProfileStore} from '../dist/profile-store.js';
import {readWalletSelection,saveWalletSelection} from '../dist/wallet-preferences.js';

const phrase=`${'abandon '.repeat(23)}art`,origin='https://fixture.market.example',audience='single-approval-test';
const accountId='11111111-1111-4111-8111-111111111111',identityId='33333333-3333-4333-8333-333333333333';
async function terminal(action){
  const saved=[process.stdin,process.stderr].map(stream=>Object.getOwnPropertyDescriptor(stream,'isTTY'));
  for(const stream of [process.stdin,process.stderr])Object.defineProperty(stream,'isTTY',{configurable:true,value:true});
  const out=process.stdout.write,err=process.stderr.write;let output='',errors='';
  process.stdout.write=(chunk,...rest)=>{if(typeof chunk!=='string')return out.call(process.stdout,chunk,...rest);output+=chunk;return true;};process.stderr.write=(chunk,...rest)=>{if(typeof chunk!=='string')return err.call(process.stderr,chunk,...rest);errors+=chunk;return true;};
  try{return {result:await action(),get output(){return output;},get errors(){return errors;}};}
  finally{process.stdout.write=out;process.stderr.write=err;[process.stdin,process.stderr].forEach((stream,i)=>saved[i]?Object.defineProperty(stream,'isTTY',saved[i]):delete stream.isTTY);}
}
async function fixture(t,{nano=false,policy={perRequest:null,rolling:[]}}={}){
  const home=await mkdtemp(join(tmpdir(),'marketplace-single-approval-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const directory=join(home,'existing-atto');const app=new AttoApplication({directory,secrets:{get:async()=>phrase,set:async()=>{}}});
  let address;
  try{await app.createWallet(phrase);address=app.store.get('identity').address;app.ledger.setPolicy(policy);}finally{await app.close();}
  const env={MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR:directory};let nanoDirectory;
  if(nano){
    const seedFile=join(home,'fixture-nano-seed.hex');await writeFile(seedFile,'42'.repeat(32)+'\n',{mode:0o600});nanoDirectory=join(home,'existing-nano');
    await provisionNanoWallet({dataDir:nanoDirectory,seedFile,derivationIndex:7,network:'nano:dev',rpcUrl:'http://localhost:17076',origin,audience,terminalConfirmed:true,
      grants:{externalTransfers:false,controllerPurposes:['link authorizer']},limits:{maxPaymentAtomic:'1',rolling24hAtomic:'10'}});
    env.MARKETPLACE_MCP_NANO_WALLET_DATA_DIR=nanoDirectory;
  }
  return {home,directory,address,env,nanoDirectory,args:['--home',home,'--profile','agent','--origin',origin,'--audience',audience],
    snapshot:()=>inspectMarketplaceWalletSetup({directory,index:0}),async state(){const store=await MarketplaceProfileStore.open(home);try{return store.getSetupState('agent');}finally{store.close();}}};
}
function answers(values,inspect){const questions=[];return {questions,prompt:async question=>{questions.push(question);await inspect?.(question);assert.ok(values.length,`Unexpected prompt: ${question}`);const value=values.shift();return typeof value==='function'?value(question):value;},done(){assert.equal(values.length,0);}};}
async function transport(action,fetcher,onKey,challengeLifetimeMs=120000){
  const get=OsSecretStore.prototype.get,fetch=globalThis.fetch;const calls=[];let keys=0;
  OsSecretStore.prototype.get=async()=>{keys++;await onKey?.();return phrase;};
  globalThis.fetch=async(url,options)=>{const body=JSON.parse(options.body);calls.push({url:String(url),body});if(fetcher)return fetcher(String(url),body);
    if(String(url).endsWith('/challenges')){
      const id=randomUUID(),issuedAt=new Date(Date.now()-1000).toISOString(),expiresAt=new Date(Date.now()+challengeLifetimeMs).toISOString();
      const binding=createHash('sha256').update(['marketplace-login-v1',accountId,identityId].join('\n')).digest('hex');
      const network=body.network==='NANO'?'nano:dev':'live',header=body.network==='NANO'?'Nano Marketplace Agent Controller Proof v1':'Marketplace Agent Controller Proof v1';
      return new Response(JSON.stringify({challengeId:id,accountId,controllerId:identityId,issuedAt,expiresAt,
        message:`${header}\nAudience: ${audience}\nNetwork: ${network}\nAddress: ${body.address}\nPurpose: login\nRequest ID: ${id}\nBinding Hash: ${binding}\nNonce: ${'a'.repeat(64)}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`}),{status:200});
    }
    return new Response(JSON.stringify({accountId,identityId,agentId:'22222222-2222-4222-8222-222222222222',accessToken:'fixture-session-access',refreshToken:'fixture-session-refresh',
      accessExpiresAt:new Date(Date.now()+120000).toISOString(),refreshExpiresAt:new Date(Date.now()+240000).toISOString()}),{status:200});
  };
  try{await action(calls,()=>keys);}finally{OsSecretStore.prototype.get=get;globalThis.fetch=fetch;}
}

for(const [mode,answer,extra] of [['login-only','1',[]],['limited','2',['3','8']],['unlimited','3',[]]])test(`ATTO ${mode} uses one combined APPROVE after the actual challenge and commits no authority beforehand`,async t=>terminal(async()=>{
  // Given an existing read-only Atto wallet with unbounded native policy.
  const f=await fixture(t),before=await f.snapshot();let final=false;
  await transport(async(calls,keyCount)=>{
    const script=answers(['1','1',answer,...extra,'APPROVE'],async question=>{
      if(question.includes('Type APPROVE to finish setup:')){
        final=true;assert.equal(calls.length,1);assert.equal(keyCount(),0);assert.deepEqual(await f.snapshot(),before);assert.equal(readWalletSelection(f.home),undefined);
        assert.ok(question.includes(origin));assert.ok(question.includes(audience));assert.match(question,/Expires At:|"expiresAt":/);
        assert.match(question,/explicitly authorize the agent to enter the confirmation/);
        if(mode==='unlimited')assert.match(question,/including future deposits/);
      }
    });
    // When source, access and final exact combined terms are approved.
    await runGuidedSetup([...f.args,'--json'],f.env,script.prompt);
    // Then the only typed approval covered wallet authority and login; the reviewed mode is effective.
    script.done();assert.equal(final,true);assert.equal(script.questions.filter(q=>q.includes('Type APPROVE')).length,1);
    assert.deepEqual(calls.map(call=>new URL(call.url).pathname),['/v1/agent/auth/challenges','/v1/agent/auth/sessions']);
    const native=await f.snapshot();assert.equal(native.access,mode==='login-only'?'read-only':'spend');
    assert.equal(readWalletSelection(f.home).attoAccess.externalTransfers,mode!=='login-only');
    if(mode==='limited')assert.deepEqual(native.policy,{perRequest:{amount:'3',unit:'ATTO'},rolling:[{days:1,amount:'8',unit:'ATTO'}]});
    if(mode==='unlimited')assert.deepEqual(native.policy,{perRequest:null,rolling:[]});
  },undefined,async()=>{
    const state=await f.state();assert.equal(JSON.parse(state.privatePayload).walletConsent,undefined,'Consent marker must clear before the signer opens its key.');
  });
}));

test('declined combined review preserves native authority and fences standalone approve/complete even with a response file',async t=>terminal(async()=>{
  // Given a Limited plan whose exact combined review is declined.
  const f=await fixture(t),before=await f.snapshot();
  await transport(async(calls,keyCount)=>{
    const script=answers(['1','1','2','3','8','NO']);
    await assert.rejects(runGuidedSetup(f.args,f.env,script.prompt),{code:'APPROVAL_DECLINED'});script.done();
    const state=await f.state(),saved=JSON.parse(state.privatePayload),path=approvalRequestPath(f.home,'agent',saved.request.handoffId);
    let statusOutput='';const write=process.stdout.write;process.stdout.write=(chunk,...rest)=>{if(typeof chunk!=='string')return write.call(process.stdout,chunk,...rest);statusOutput+=chunk;return true;};
    try{await runSetup(['--home',f.home,'--profile','agent','--status','--json'],f.env);}finally{process.stdout.write=write;}
    const status=JSON.parse(statusOutput.trim());assert.equal(status.walletConsentPending,true);assert.equal(status.walletCommand,undefined);assert.ok(status.resumeCommand.includes(f.home));assert.doesNotMatch(status.resumeCommand,/--complete/);
    // When standalone commands try to consume the pending marked login.
    await assert.rejects(runSetup(['--home',f.home,'--profile','agent','--complete'],f.env),{code:'WALLET_CONSENT_REQUIRED'});
    await assert.rejects(approveMarketplaceController(path,{home:f.home,env:f.env,prompt:()=>assert.fail('Standalone must not offer a bypass approval.')}),{code:'WALLET_CONSENT_REQUIRED'});
    await assert.rejects(approveMarketplaceController(path,{home:f.home,env:f.env,loginAuthorizationFile:join(f.home,'authorization.json')}),{code:'LOGIN_AUTHORIZATION_SCOPE'});
    await writeFile(approvalResponsePath(f.home,'agent',saved.request.handoffId),'{}\n',{mode:0o600});
    await assert.rejects(runSetup(['--home',f.home,'--profile','agent','--complete'],f.env),{code:'WALLET_CONSENT_REQUIRED'});
    // Then no wallet authority, selection, proof submission or setup owner changed.
    assert.equal(calls.length,1);assert.equal(keyCount(),0);assert.deepEqual(await f.snapshot(),before);assert.equal(readWalletSelection(f.home),undefined);assert.deepEqual(await f.state(),state);
  });
}));

test('restart rebuilds the combined wallet review with the same valid challenge and requested caps',async t=>terminal(async()=>{
  // Given a declined Limited setup preserving its unsigned typed login and desired caps.
  const f=await fixture(t);
  await transport(async calls=>{
    await assert.rejects(runGuidedSetup(f.args,f.env,answers(['1','1','2','3','8','NO']).prompt),{code:'APPROVAL_DECLINED'});
    const before=JSON.parse((await f.state()).privatePayload),script=answers(['APPROVE']);
    // When the same setup is resumed and its rebuilt exact review is approved.
    await runGuidedSetup([...f.args,'--json'],f.env,script.prompt);
    // Then no source/cap prompts or replacement challenge are introduced.
    script.done();assert.equal(script.questions.length,1);assert.ok(script.questions[0].includes('3 ATTO'));assert.ok(script.questions[0].includes('8 ATTO'));
    assert.equal(calls.filter(call=>call.url.endsWith('/challenges')).length,1);assert.equal(calls[1].body.challengeId,before.challenge.challengeId);
    assert.equal((await f.snapshot()).policy.perRequest.amount,'3');
  });
}));

test('a stale second wallet prevents every wallet mutation after final approval',async t=>terminal(async()=>{
  // Given prepared Atto Limited and Nano Unlimited plans.
  const f=await fixture(t,{nano:true}),before=await f.snapshot();
  await transport(async(calls,keyCount)=>{
    const script=answers(['3','1','2','3','8','1','3','1',async()=>{
      const current=loadConfiguration(f.nanoDirectory);
      await approveNanoWalletPolicy({dataDir:f.nanoDirectory,grants:current.grants,limits:{maxPaymentAtomic:'2',rolling24hAtomic:'20'},terminalConfirmed:true});return 'APPROVE';
    }]);
    // When the Nano owner changes after review but before the combined consent is consumed.
    await assert.rejects(runGuidedSetup(f.args,f.env,script.prompt),{code:'WALLET_CONFIGURATION_CHANGED'});
    // Then all plans were validated before first mutation, preserving native Atto and the competing Nano policy.
    script.done();assert.deepEqual(await f.snapshot(),before);assert.deepEqual(loadConfiguration(f.nanoDirectory).limits,{maxPaymentAtomic:'2',rolling24hAtomic:'20'});
    assert.equal(readWalletSelection(f.home),undefined);assert.equal(calls.length,1);assert.equal(keyCount(),0);
  });
}));

test('expiry after the first native commit preserves partial settings and never publishes a login proof',async t=>terminal(async()=>{
  // Given a combined Atto Limited / Nano Unlimited review approved with a fresh challenge.
  const f=await fixture(t,{nano:true}),nanoBefore=loadConfiguration(f.nanoDirectory),original=AttoApplication.prototype.approveLimitsProposal,now=Date.now;
  AttoApplication.prototype.approveLimitsProposal=async function(...args){const result=await original.apply(this,args);Date.now=()=>now()+180000;return result;};
  try{await transport(async(calls,keyCount)=>{
    // When the login expires immediately after Atto's native owner commits.
    await assert.rejects(runGuidedSetup(f.args,f.env,answers(['3','1','2','3','8','1','3','1','APPROVE']).prompt),{code:'APPROVAL_EXPIRED'});
    // Then the first approved policy persists, the second wallet is unchanged, and marked consent cannot be bypassed.
    Date.now=now;assert.equal((await f.snapshot()).access,'spend');assert.deepEqual(loadConfiguration(f.nanoDirectory),nanoBefore);
    assert.equal(calls.length,1);assert.equal(keyCount(),0);const state=await f.state();assert.ok(JSON.parse(state.privatePayload).walletConsent);
    const handoff=JSON.parse(state.privatePayload).request.handoffId;await assert.rejects(readFile(approvalResponsePath(f.home,'agent',handoff)),{code:'ENOENT'});
  });}finally{Date.now=now;AttoApplication.prototype.approveLimitsProposal=original;}
}));

test('omitted Nano selection and grants survive ATTO-only combined setup',async t=>terminal(async()=>{
  // Given a saved Nano role while a new profile selects ATTO only.
  const f=await fixture(t,{nano:true}),nanoBefore=loadConfiguration(f.nanoDirectory);
  await saveWalletSelection(f.home,{nanoDirectory:f.nanoDirectory,nanoControllerDirectory:f.nanoDirectory});
  // When only Atto Login-only setup is approved.
  await transport(async()=>runGuidedSetup(f.args,f.env,answers(['1','1','1','APPROVE']).prompt));
  // Then omitted currency roles and permissions are preserved exactly.
  assert.equal(readWalletSelection(f.home).nanoDirectory,f.nanoDirectory);assert.deepEqual(loadConfiguration(f.nanoDirectory),nanoBefore);
}));

test('Both commits Limited ATTO and Unlimited Nano with one exact final approval',async t=>terminal(async()=>{
  // Given two existing wallets with independent native policy owners.
  const f=await fixture(t,{nano:true});
  await transport(async calls=>{
    const script=answers(['3','1','2','3','8','1','3','1','APPROVE']);
    // When both reviewed policies and the Atto login are approved together.
    await runGuidedSetup(f.args,f.env,script.prompt);
    // Then each native owner saves its exact policy, selection CAS covers both roles, and only one proof is submitted.
    script.done();assert.equal(script.questions.filter(q=>q.includes('Type APPROVE')).length,1);
    assert.equal((await f.snapshot()).policy.perRequest.amount,'3');assert.equal((await f.snapshot()).access,'spend');
    assert.deepEqual(loadConfiguration(f.nanoDirectory).limits,{maxPaymentAtomic:null,rolling24hAtomic:null});
    assert.equal(loadConfiguration(f.nanoDirectory).grants.externalTransfers,true);assert.deepEqual(loadConfiguration(f.nanoDirectory).grants.controllerPurposes,['link authorizer']);
    const selection=readWalletSelection(f.home);assert.equal(selection.attoAccess.externalTransfers,true);assert.equal(selection.nanoDirectory,f.nanoDirectory);assert.equal(calls.length,2);
  });
}));

async function separateNanoController(f){
  const seedFile=join(f.home,'fixture-controller-seed.hex'),directory=join(f.home,'nano-controller');
  await writeFile(seedFile,'24'.repeat(32)+'\n',{mode:0o600});
  await provisionNanoWallet({dataDir:directory,seedFile,derivationIndex:3,network:'nano:dev',rpcUrl:'http://localhost:17076',origin,audience,terminalConfirmed:true,
    grants:{externalTransfers:false,controllerPurposes:[]},limits:{maxPaymentAtomic:'0',rolling24hAtomic:'0'}});
  await saveWalletSelection(f.home,{nanoDirectory:f.nanoDirectory,nanoControllerDirectory:directory});
  return {directory,config:loadConfiguration(directory)};
}

test('Nano setup preserves and signs with the saved separate controller without adding headless grants',async t=>terminal(async()=>{
  // Given different saved Nano payment and controller wallets with no controller-purpose grants on the signer.
  const f=await fixture(t,{nano:true}),separate=await separateNanoController(f);
  await transport(async(calls,keyCount)=>{
    const script=answers(['2','1','2','APPROVE']);
    // When Limited payment access is approved with the actual saved Nano controller login.
    await runGuidedSetup(f.args,f.env,script.prompt);
    // Then the original signer role and its policy are preserved, while only the selected payment wallet changes.
    script.done();assert.equal(calls[0].body.address,separate.config.sourceAddress);assert.equal(calls[0].body.network,'NANO');
    assert.ok(script.questions.at(-1).includes(separate.config.sourceAddress));assert.match(script.questions.at(-1),/Nano controller role: preserve/);
    assert.equal(readWalletSelection(f.home).nanoControllerDirectory,separate.directory);assert.deepEqual(loadConfiguration(separate.directory),separate.config);
    assert.equal(loadConfiguration(f.nanoDirectory).grants.externalTransfers,true);assert.deepEqual(loadConfiguration(f.nanoDirectory).grants.controllerPurposes,['link authorizer']);
    assert.equal(keyCount(),0,'Nano native-seed signing must not unlock an Atto keyring.');assert.equal(calls.length,2);
  });
}));

test('a changed separate Nano controller is rejected before payment-wallet mutation',async t=>terminal(async()=>{
  // Given the saved separate signer and a Limited payment plan.
  const f=await fixture(t,{nano:true}),separate=await separateNanoController(f),paymentBefore=loadConfiguration(f.nanoDirectory);
  await transport(async calls=>{
    const script=answers(['2','1','2',async()=>{
      await approveNanoWalletPolicy({dataDir:separate.directory,grants:separate.config.grants,limits:{maxPaymentAtomic:'2',rolling24hAtomic:'20'},terminalConfirmed:true});return 'APPROVE';
    }]);
    // When the separate controller changes during the combined review.
    await assert.rejects(runGuidedSetup(f.args,f.env,script.prompt),{code:'WALLET_CONFIGURATION_CHANGED'});
    // Then controller context is revalidated before any payment policy write or proof submission.
    script.done();assert.deepEqual(loadConfiguration(f.nanoDirectory),paymentBefore);assert.equal(calls.length,1);
  });
}));


for(const race of ['expiry','guard expiry','setup owner','selection'])test(`delayed all-plan validation rejects ${race} before any owner commit or selection write`,async t=>terminal(async()=>{
  // Given Atto Limited plus a new shared-recovery Nano plan whose validation awaits the OS keyring.
  const f=await fixture(t),before=await f.snapshot();let approved=false,postApprovalKeyReads=0,triggered=false,successor;
  let ownerCommits=0,selectionWrites=0,markerClears=0,externalSelectionWrite=false;
  const approve=AttoApplication.prototype.approveLimitsProposal,openPreferences=MarketplaceProfileStore.openWalletPreferences,openProfile=MarketplaceProfileStore.open,transition=MarketplaceProfileStore.prototype.transitionSetupState;
  let postApprovalProfileOpens=0;
  MarketplaceProfileStore.open=async function(...args){
    if(race==='guard expiry'&&approved&&++postApprovalProfileOpens===5){triggered=true;await new Promise(resolve=>setTimeout(resolve,1200));}
    return openProfile.apply(this,args);
  };
  AttoApplication.prototype.approveLimitsProposal=async function(...args){ownerCommits++;return approve.apply(this,args);};
  MarketplaceProfileStore.openWalletPreferences=function(...args){if(!args[1]&&!externalSelectionWrite)selectionWrites++;return openPreferences.apply(this,args);};
  MarketplaceProfileStore.prototype.transitionSetupState=function(profile,from,to,payload,expected){
    if(from==='LOGIN_APPROVAL'&&to==='LOGIN_APPROVAL'&&expected&&JSON.parse(expected).walletConsent&&!JSON.parse(payload).walletConsent)markerClears++;
    return transition.call(this,profile,from,to,payload,expected);
  };
  try{await transport(async(calls)=>{
    const script=answers(['3','1','2','3','8','1','3','1',()=>{approved=true;return 'APPROVE';}]);
    // When validation delays after earlier freshness checks, and expiry or another owner wins during that await.
    await assert.rejects(runGuidedSetup(f.args,f.env,script.prompt),{code:race.endsWith('expiry')?'APPROVAL_EXPIRED':race==='setup owner'?'APPROVAL_CHANGED':'WALLET_CONFIGURATION_CHANGED'});
    // Then the guard is renewed after validation, before the first mutation, leaving the consent marker intact.
    script.done();assert.equal(triggered,true);assert.equal(ownerCommits,0);assert.equal(selectionWrites,0);assert.equal(markerClears,0);
    assert.deepEqual(await f.snapshot(),before);assert.deepEqual(readWalletSelection(f.home),race==='selection'?{attoDirectory:f.directory}:undefined);
    const state=await f.state();assert.ok(JSON.parse(state.privatePayload).walletConsent);if(successor)assert.equal(state.privatePayload,successor);
    assert.equal(calls.length,1);const handoff=JSON.parse(state.privatePayload).request.handoffId;
    await assert.rejects(readFile(approvalResponsePath(f.home,'agent',handoff)),{code:'ENOENT'});
    await assert.rejects(readFile(join(f.home,'wallets','nano','wallet.json')),{code:'ENOENT'});
  },undefined,async()=>{
    if(race==='guard expiry'||!approved||++postApprovalKeyReads!==4)return;
    triggered=true;
    if(race==='expiry')await new Promise(resolve=>setTimeout(resolve,1200));
    else{
      await new Promise(resolve=>setImmediate(resolve));
      if(race==='selection'){
        externalSelectionWrite=true;
        try{await saveWalletSelection(f.home,{attoDirectory:f.directory});}finally{externalSelectionWrite=false;}
      }else{
        const store=await MarketplaceProfileStore.open(f.home);
        try{const state=store.getSetupState('agent');successor=JSON.stringify({...JSON.parse(state.privatePayload),ownerGeneration:'successor'});assert.equal(store.transitionSetupState('agent','LOGIN_APPROVAL','LOGIN_APPROVAL',successor,state.privatePayload),true);}finally{store.close();}
      }
    }
  },race.endsWith('expiry')?1000:120000);}
  finally{AttoApplication.prototype.approveLimitsProposal=approve;MarketplaceProfileStore.openWalletPreferences=openPreferences;MarketplaceProfileStore.open=openProfile;MarketplaceProfileStore.prototype.transitionSetupState=transition;}
}));

test('final validation delay preserves the consent marker when approval expires after wallet commits',async t=>terminal(async()=>{
  // Given a marked Atto Limited review and its real deferred native/selection commit.
  const f=await fixture(t);let committed=false,delayed=false,markerClears=0;
  await transport(async(calls,keyCount)=>{
    await assert.rejects(runGuidedSetup(f.args,f.env,answers(['1','1','2','3','8','NO']).prompt),{code:'APPROVAL_DECLINED'});
    const pending=await f.state(),saved=JSON.parse(pending.privatePayload),plan=await prepareAttoWalletInteractive({home:f.home,env:f.env,prompt:()=>assert.fail('Resume must rebuild without questions.'),resumeIntent:saved.walletConsent.wallets[0].intent});
    const transition=MarketplaceProfileStore.prototype.transitionSetupState;
    MarketplaceProfileStore.prototype.transitionSetupState=function(profile,from,to,payload,expected){
      if(from==='LOGIN_APPROVAL'&&to==='LOGIN_APPROVAL'&&expected&&JSON.parse(expected).walletConsent&&!JSON.parse(payload).walletConsent)markerClears++;
      return transition.call(this,profile,from,to,payload,expected);
    };
    try{
      // When the final post-commit plan validation outlasts the login's remaining lifetime.
      await assert.rejects(approveMarketplaceController(approvalRequestPath(f.home,'agent',saved.request.handoffId),{home:f.home,env:f.env,prompt:()=>true,
        walletConsent:{expectedPayload:pending.privatePayload,review:plan.review,controller:{directory:f.directory,network:'live',address:f.address,index:0},
          async validate(){await plan.validate();if(committed&&!delayed){delayed=true;await new Promise(resolve=>setTimeout(resolve,1200));}},
          async commit(assertCurrent){await plan.validate();await assertCurrent();await plan.commit();await plan.saveSelection(readWalletSelection(f.home));committed=true;}}}),{code:'APPROVAL_EXPIRED'});
      // Then already-approved settings remain, but no marker clear, key read, proof publication or session submission occurs.
      assert.equal(committed,true);assert.equal(delayed,true);assert.equal(markerClears,0);assert.equal((await f.snapshot()).access,'spend');
      assert.equal(readWalletSelection(f.home).attoAccess.externalTransfers,true);assert.deepEqual(await f.state(),pending);assert.equal(keyCount(),0);assert.equal(calls.length,1);
      await assert.rejects(readFile(approvalResponsePath(f.home,'agent',saved.request.handoffId)),{code:'ENOENT'});
    }finally{MarketplaceProfileStore.prototype.transitionSetupState=transition;}
  },undefined,undefined,1000);
}));


test('delayed validation before selection save preserves approved native plans without writing expired Marketplace grants',async t=>terminal(async()=>{
  // Given two approved native owners and a public snapshot validation waiting on the Atto wallet lock.
  const f=await fixture(t),walletLock=StateStore.prototype.withWalletLock,openPreferences=MarketplaceProfileStore.openWalletPreferences;
  let approved=false,delayed=false,selectionWrites=0;
  StateStore.prototype.withWalletLock=async function(...args){
    if(approved&&!delayed&&this.directory===f.directory&&existsSync(join(f.home,'wallets','nano','wallet.json'))){delayed=true;await new Promise(resolve=>setTimeout(resolve,1200));}
    return walletLock.apply(this,args);
  };
  MarketplaceProfileStore.openWalletPreferences=function(...args){if(!args[1])selectionWrites++;return openPreferences.apply(this,args);};
  try{await transport(async(calls)=>{
    // When the final all-plan validation before selection publication outlasts the login.
    await assert.rejects(runGuidedSetup(f.args,f.env,answers(['3','1','2','3','8','1','3','1',()=>{approved=true;return 'APPROVE';}]).prompt),{code:'APPROVAL_EXPIRED'});
    // Then native approvals are retained, while the stale login cannot publish Marketplace grants or clear consent.
    assert.equal(delayed,true);assert.equal(selectionWrites,0);assert.equal(readWalletSelection(f.home),undefined);assert.equal((await f.snapshot()).access,'spend');
    assert.equal(loadConfiguration(join(f.home,'wallets','nano')).grants.externalTransfers,true);assert.equal(calls.length,1);
    const state=await f.state(),saved=JSON.parse(state.privatePayload);assert.ok(saved.walletConsent);
    await assert.rejects(readFile(approvalResponsePath(f.home,'agent',saved.request.handoffId)),{code:'ENOENT'});
  },undefined,undefined,1000);}
  finally{StateStore.prototype.withWalletLock=walletLock;MarketplaceProfileStore.openWalletPreferences=openPreferences;}
}));
