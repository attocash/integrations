import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {tmpdir} from '../../test/support/temporary-directory.mjs';

const packageDirectory=process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR??join(import.meta.dirname,'..');
const cliDirectory=process.env.ATTO_TEST_CLI_PACKAGE_DIR??fileURLToPath(new URL('../',import.meta.resolve('@attocash/cli/core')));
const {AttoApplication}=await import(pathToFileURL(join(cliDirectory,'dist/application/app.js')));
const {inspectMarketplaceWalletSetup}=await import(pathToFileURL(join(cliDirectory,'dist/internal-marketplace.js')));
const {setupAttoWalletInteractive}=await import(pathToFileURL(join(packageDirectory,'dist/atto-setup.js')));
const {runWalletWizard}=await import(pathToFileURL(join(packageDirectory,'dist/guided-setup.js')));
const {readWalletSelection,saveWalletSelection}=await import(pathToFileURL(join(packageDirectory,'dist/wallet-preferences.js')));
const phrase=`${'abandon '.repeat(23)}art`;
const boundedPolicy={perRequest:{amount:'100',unit:'ATTO'},rolling:[{days:1,amount:'1000',unit:'ATTO'}]};

async function terminal(action){
  const descriptors=[process.stdin,process.stderr].map(stream=>Object.getOwnPropertyDescriptor(stream,'isTTY'));
  for(const stream of [process.stdin,process.stderr])Object.defineProperty(stream,'isTTY',{configurable:true,value:true});
  const originalOut=process.stdout.write,originalError=process.stderr.write;
  let stdout='',stderr='';
  process.stdout.write=chunk=>{stdout+=chunk;return true;};
  process.stderr.write=chunk=>{stderr+=chunk;return true;};
  try{return {result:await action(),stdout,stderr};}
  finally{
    process.stdout.write=originalOut;process.stderr.write=originalError;
    [process.stdin,process.stderr].forEach((stream,index)=>descriptors[index]?Object.defineProperty(stream,'isTTY',descriptors[index]):delete stream.isTTY);
  }
}
async function fixture(t,{access='spend',policy=boundedPolicy,pool=[0,1]}={}){
  const root=await mkdtemp(join(tmpdir(),'marketplace-compact-atto-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const home=join(root,'marketplace'),directory=join(root,'existing-cli');
  await mkdir(home,{mode:0o700});
  // Only fixture construction may use a synthetic mnemonic. Compact setup has no credential adapter.
  const open=()=>new AttoApplication({directory,secrets:{get:async()=>phrase,set:async()=>{},remove:async()=>{}}});
  const app=open();
  try{
    await app.createWallet(phrase);
    await app.call('address_derive',{index:1});
    const status=await app.call('wallet_status');
    app.store.set('settings',{...status.settings,network:'LOCAL',nodeUrl:'http://localhost:41234',workerUrl:'http://localhost:41235',autoReceive:false});
    const {proposal}=await app.call('limits_propose',{access,policy,pool:{indexes:pool,consolidate:true},messageSigningIndexes:[]});
    await app.approveLimitsProposal(proposal.id);
    app.ledger.reserve({id:'retained-reservation',index:0,destination:status.identity.address,raw:'1000',network:'LOCAL',createdAt:Date.now()});
  }finally{await app.close();}
  const env={MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR:directory};
  const snapshot=()=>inspectMarketplaceWalletSetup({directory,index:0});
  async function journal(){const app=open();try{return app.store.get('spending.records');}finally{await app.close();}}
  return {home,directory,env,open,snapshot,journal};
}
function interaction(steps){
  const questions=[];
  return {questions,prompt:async question=>{
    questions.push(question);
    const step=steps.shift();assert.ok(step,`Unexpected prompt: ${question}`);
    assert.match(question,step[0]);
    return typeof step[1]==='function'?step[1](question):step[1];
  },done:()=>assert.equal(steps.length,0,'Expected every workflow decision to be reached')};
}

for(const [choice,funding,transfers] of [['',false,false],['2',true,false],['3',false,true],['4',true,true]]){
  test(`compact Atto purpose choice ${choice||'default'} preserves native limits, pool, signing authority, proposal and journal`,async t=>terminal(async()=>{
    // Given a selected bounded shared wallet with no Marketplace grants or generic signing.
    const f=await fixture(t),before=await f.snapshot(),journal=await f.journal();
    const script=interaction([[/^Atto access:.*default 1/,choice],[/^Type APPROVE to save/,'APPROVE']]);
    // When one purpose selection and one exact wallet approval are accepted.
    const wallet=await setupAttoWalletInteractive({...f,prompt:script.prompt});
    // Then grants remain separately selectable and no native proposal or payment state changes.
    script.done();assert.equal(script.questions.length,2);assert.equal(wallet.index,0);
    assert.deepEqual(readWalletSelection(f.home).attoAccess,{address:before.address,index:0,network:'atto:local',fingerprint:before.fingerprint,
      marketplaceFunding:funding,externalTransfers:transfers});
    assert.deepEqual(await f.snapshot(),before);assert.deepEqual(await f.journal(),journal);
  }));
}

test('compact wallet review shows exact source, shared limits and separate purposes without native internals',async t=>{
  // Given the selected shared native wallet and its approved limits.
  let before;
  const output=await terminal(async()=>{
    const f=await fixture(t);before=await f.snapshot();
    const script=interaction([[/^Atto access:/,'4'],[/^Type APPROVE to save/,'APPROVE']]);
    // When the selected purposes are reviewed.
    await setupAttoWalletInteractive({...f,prompt:script.prompt});script.done();
  });
  // Then the concise review exposes the exact source and grant decision without full policy JSON or fingerprints.
  assert.ok(output.stderr.includes(before.address));
  assert.match(output.stderr,/Account index: 0 \| Network: atto:local/);
  assert.match(output.stderr,/100 ATTO.*1000 ATTO/);
  assert.match(output.stderr,/Marketplace funding: allowed \| External transfers: allowed/);
  assert.match(output.stderr,/Login proof requires a separate approval/);
  for(const value of [before.fingerprint,before.settings.nodeUrl,before.settings.workerUrl,phrase])assert.equal(output.stderr.includes(value),false);
  assert.doesNotMatch(output.stderr,/"policy"|"pool"|messageSigningIndexes|walletFingerprint/);
});

test('denying compact wallet approval saves no Marketplace grants or pointer',async t=>terminal(async()=>{
  // Given native authority and no previous Marketplace wallet selection.
  const f=await fixture(t),before=await f.snapshot();
  const script=interaction([[/^Atto access:/,'4'],[/^Type APPROVE to save/,'NO']]);
  // When final wallet approval is declined.
  await assert.rejects(setupAttoWalletInteractive({...f,prompt:script.prompt}),{code:'APPROVAL_DECLINED'});
  // Then native authority and the absent Marketplace selection are preserved.
  script.done();assert.equal(readWalletSelection(f.home),undefined);assert.deepEqual(await f.snapshot(),before);
}));

test('login-only compact reuse needs no native spend authority or configuration fallback',async t=>terminal(async()=>{
  // Given a read-only shared native wallet.
  const f=await fixture(t,{access:'read-only'}),before=await f.snapshot();
  const script=interaction([[/^Atto access:/,''],[/^Type APPROVE to save/,'APPROVE']]);
  // When the default login-only purpose is approved.
  await setupAttoWalletInteractive({...f,prompt:script.prompt});
  // Then it requires only two wallet prompts and preserves read-only native authority.
  script.done();assert.deepEqual(await f.snapshot(),before);assert.equal(script.questions.length,2);
  assert.equal(readWalletSelection(f.home).attoAccess.marketplaceFunding,false);
  assert.equal(readWalletSelection(f.home).attoAccess.externalTransfers,false);
}));

for(const [name,configuration] of [
  ['read-only',{access:'read-only'}],['unbounded',{policy:{perRequest:null,rolling:[]}}],['outside the native pool',{pool:[1]}],
]){
  test(`compact funding choice with ${name} authority offers login-only without expanding native permissions`,async t=>terminal(async()=>{
    // Given native authority that cannot fund the selected Marketplace source.
    const f=await fixture(t,configuration),before=await f.snapshot();
    const script=interaction([[/^Atto access:/,'2'],[/^Continue:.*Login only.*Advanced native configuration/,''],[/^Type APPROVE to save/,'APPROVE']]);
    // When the user chooses the offered login-only fallback.
    await setupAttoWalletInteractive({...f,prompt:script.prompt});
    // Then no pool, limit, signing permission or native proposal was upgraded.
    script.done();assert.deepEqual(await f.snapshot(),before);
    assert.equal(readWalletSelection(f.home).attoAccess.marketplaceFunding,false);
    assert.equal(readWalletSelection(f.home).attoAccess.externalTransfers,false);
  }));
}
for(const [name,policy] of [
  ['per-payment only',{perRequest:{amount:'100',unit:'ATTO'},rolling:[]}],
  ['rolling only',{perRequest:null,rolling:[{days:1,amount:'1000',unit:'ATTO'}]}],
]){
  test(`compact funding accepts existing ${name} bounded native spend`,async t=>terminal(async()=>{
    // Given an existing native policy bounded by one of the CLI-supported limit types.
    const f=await fixture(t,{policy}),before=await f.snapshot();
    const script=interaction([[/^Atto access:/,'2'],[/^Type APPROVE to save/,'APPROVE']]);
    // When Marketplace funding is selected under that unchanged shared policy.
    await setupAttoWalletInteractive({...f,prompt:script.prompt});
    // Then the native bound is retained and the narrower funding purpose is usable.
    script.done();assert.deepEqual(await f.snapshot(),before);assert.equal(readWalletSelection(f.home).attoAccess.marketplaceFunding,true);
  }));
}

test('matching saved identity, account and network reuse the saved index and purpose defaults',async t=>terminal(async()=>{
  // Given a previously approved nonzero account in the same shared wallet.
  const f=await fixture(t),snapshot=await inspectMarketplaceWalletSetup({directory:f.directory,index:1});
  await saveWalletSelection(f.home,{attoDirectory:f.directory,attoAccess:{address:snapshot.address,index:1,network:snapshot.network,
    fingerprint:snapshot.fingerprint,marketplaceFunding:false,externalTransfers:true}});
  const script=interaction([[/^Atto access:.*default 3/,''],[/^Type APPROVE to save/,'APPROVE']]);
  // When compact setup resumes with only the saved path and access binding.
  const wallet=await setupAttoWalletInteractive({home:f.home,env:{},prompt:script.prompt});
  // Then no repeated wallet, path, index or REUSE questions precede approval.
  script.done();assert.equal(wallet.index,1);assert.equal(wallet.address,snapshot.address);
  assert.equal(readWalletSelection(f.home).attoAccess.externalTransfers,true);
}));

for(const changed of ['fingerprint','network','directory']){
  test(`saved grants default to login only after ${changed} changes`,async t=>terminal(async()=>{
    // Given old Marketplace grants whose exact wallet binding no longer matches.
    const f=await fixture(t),snapshot=await f.snapshot();
    const access={address:snapshot.address,index:0,network:snapshot.network,fingerprint:snapshot.fingerprint,marketplaceFunding:true,externalTransfers:true};
    let selectedDirectory=f.directory;
    if(changed==='fingerprint')access.fingerprint='a'.repeat(64);
    if(changed==='network')access.network='atto:beta';
    if(changed==='directory'){selectedDirectory=join(f.home,'old-wallet');await mkdir(selectedDirectory,{mode:0o700});}
    await saveWalletSelection(f.home,{attoDirectory:selectedDirectory,attoAccess:access});
    const script=interaction([[/^Atto access:.*default 1/,''],[/^Type APPROVE to save/,'APPROVE']]);
    // When the explicitly selected current wallet is approved.
    await setupAttoWalletInteractive({...f,prompt:script.prompt});
    // Then old grants do not carry across identity, path or network changes.
    script.done();assert.equal(readWalletSelection(f.home).attoAccess.marketplaceFunding,false);
    assert.equal(readWalletSelection(f.home).attoAccess.externalTransfers,false);
  }));
}

for(const changed of ['settings','proposal','selection']){
  test(`compact approval rejects ${changed} changed during terminal review`,async t=>terminal(async()=>{
    // Given a reviewed shared wallet and no Marketplace selection.
    const f=await fixture(t);
    const script=interaction([[/^Atto access:/,'2'],[/^Type APPROVE to save/,async()=>{
      if(changed==='selection')await saveWalletSelection(f.home,{attoDirectory:f.directory});
      else{
        const app=f.open();
        try{
          if(changed==='settings')app.store.set('settings',{...app.store.get('settings'),workerUrl:'http://localhost:49999'});
          else await app.call('limits_propose',{access:'spend',policy:boundedPolicy,pool:{indexes:[0,1],consolidate:true},messageSigningIndexes:[]});
        }finally{await app.close();}
      }
      return 'APPROVE';
    }]]);
    // When settings, a pending native proposal or selected wallet changes before approval is committed.
    await assert.rejects(setupAttoWalletInteractive({...f,prompt:script.prompt}),{code:changed==='selection'?'WALLET_CONFIGURATION_CHANGED':'PROPOSAL_STALE'});
    // Then the stale review never saves new purpose grants.
    script.done();assert.equal(readWalletSelection(f.home)?.attoAccess,undefined);
  }));
}

test('compact reuse preserves old CLI profiles without creating metadata or moving keys',async t=>terminal(async()=>{
  // Given an older custom CLI wallet with no profile metadata.
  const f=await fixture(t);await rm(join(f.directory,'profile.json'),{force:true});
  const before=await f.snapshot();
  const script=interaction([[/^Atto access:/,'1'],[/^Type APPROVE to save/,'APPROVE']]);
  // When that exact directory is reused for login-only Marketplace access.
  await setupAttoWalletInteractive({...f,prompt:script.prompt});
  // Then the original profile resolution, authority and metadata absence remain unchanged.
  script.done();assert.deepEqual(await f.snapshot(),before);await assert.rejects(readFile(join(f.directory,'profile.json')),{code:'ENOENT'});
}));

test('--advanced remains reachable from standalone wallet setup before compact purpose choices',async t=>terminal(async()=>{
  // Given an explicitly selected existing CLI wallet.
  const f=await fixture(t),before=await f.snapshot(),questions=[];
  // When the user requests advanced account and native-policy configuration.
  await assert.rejects(runWalletWizard(['--home',f.home,'--asset','ATTO','--advanced'],f.env,async question=>{
    questions.push(question);
    if(questions.length===1){assert.match(question,/^Atto wallet:/);return '';}
    if(questions.length===2){assert.match(question,/^Atto controller account index/);return '0';}
    assert.match(question,/^Type REUSE/);return 'NO';
  }),{code:'CANCELLED'});
  // Then advanced retains the original wallet chooser and account control, with no unapproved state changes.
  assert.equal(questions.length,3);assert.deepEqual(await f.snapshot(),before);assert.equal(readWalletSelection(f.home),undefined);
}));

test('missing native authority can enter advanced setup only through an explicit choice',async t=>terminal(async()=>{
  // Given a selected read-only native wallet.
  const f=await fixture(t,{access:'read-only'}),before=await f.snapshot();
  const script=interaction([[/^Atto access:/,'4'],[/^Continue:/,'2'],[/^Type REUSE/,'NO']]);
  // When the user explicitly chooses advanced native setup and then cancels it.
  await assert.rejects(setupAttoWalletInteractive({...f,prompt:script.prompt}),{code:'CANCELLED'});
  // Then entering the advanced path has not upgraded authority or saved purpose grants.
  script.done();assert.deepEqual(await f.snapshot(),before);assert.equal(readWalletSelection(f.home),undefined);
}));
