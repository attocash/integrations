import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AttoPrivateKey} from '@attocash/commons-core';
import {pathToFileURL,fileURLToPath} from 'node:url';
const packageDirectory=process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR??join(import.meta.dirname,'..');
const cliDirectory=process.env.ATTO_TEST_CLI_PACKAGE_DIR??fileURLToPath(new URL('../',import.meta.resolve('@attocash/cli/core')));
const {AttoApplication}=await import(pathToFileURL(join(cliDirectory,'dist/application/app.js')));
const {readWalletSelection,saveWalletSelection}=await import(pathToFileURL(join(packageDirectory,'dist/wallet-preferences.js')));
const {selectedAttoWallet,assertAttoWalletWrite,approveAttoWalletAccess}=await import(pathToFileURL(join(packageDirectory,'dist/wallet-access.js')));

const address=(await AttoPrivateKey.Companion.parse('01'.repeat(32)).toSigner()).address.toString();
const fingerprint='a'.repeat(64);
const status={initialized:true,identity:{fingerprint},settings:{network:'LOCAL'},addresses:[{address,index:7}],mcpAccess:'spend',pool:{indexes:[7]}};
const access={address,index:7,network:'atto:local',fingerprint,marketplaceFunding:true,externalTransfers:false};

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'marketplace-native-access-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const home=join(root,'marketplace'),directory=join(root,'atto');
  await mkdir(home,{mode:0o700});await mkdir(directory,{mode:0o700});
  return{home,directory,env:{MARKETPLACE_MCP_HOME:home,MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR:directory}};
}

test('Atto Marketplace funding and external transfers require separate saved grants',async t=>{
  // Given a CLI wallet with spend access but no Marketplace purpose approval.
  const f=await fixture(t);
  await saveWalletSelection(f.home,{attoDirectory:f.directory});
  assert.throws(()=>selectedAttoWallet(f.env,status),{code:'WALLET_SETUP_REQUIRED'});
  await saveWalletSelection(f.home,{attoAccess:access});
  const before=await readFile(join(f.home,'profiles.sqlite'));
  // When the narrower Marketplace authority is checked.
  assert.doesNotThrow(()=>assertAttoWalletWrite(f.env,status,'payment.prepare'));
  assert.doesNotThrow(()=>assertAttoWalletWrite(f.env,status,'receive'));
  assert.throws(()=>assertAttoWalletWrite(f.env,status,'transfer.send'),{code:'PERMISSION_DENIED'});
  // Then existing CLI spend alone did not grant external transfers or mutate state.
  assert.deepEqual(selectedAttoWallet(f.env,status).permissions,{marketplaceFunding:true,externalTransfers:false,receive:true});
  assert.deepEqual(await readFile(join(f.home,'profiles.sqlite')),before);
  await saveWalletSelection(f.home,{attoAccess:{...access,marketplaceFunding:false,externalTransfers:true}});
  assert.throws(()=>assertAttoWalletWrite(f.env,status,'payment.prepare'),{code:'PERMISSION_DENIED'});
  assert.doesNotThrow(()=>assertAttoWalletWrite(f.env,status,'transfer.send'));
  assert.doesNotThrow(()=>assertAttoWalletWrite(f.env,status,'receive'));
});

test('Atto source binding and CLI authority cannot be replaced by Marketplace preferences',async t=>{
  // Given exact reviewed source identity, account, route and two outgoing grants.
  const f=await fixture(t);
  await saveWalletSelection(f.home,{attoDirectory:f.directory,attoAccess:{...access,externalTransfers:true}});
  // When the source or original CLI authority differs.
  for(const changed of [{...status,identity:{fingerprint:'b'.repeat(64)}},{...status,settings:{network:'BETA'}},
    {...status,addresses:[{address,index:8}]}])assert.throws(()=>selectedAttoWallet(f.env,changed),{code:'WALLET_SETUP_REQUIRED'});
  for(const changed of [{...status,mcpAccess:'read-only'},{...status,pool:{indexes:[0]}}]){
    // Then no Marketplace flag bypasses the underlying spend/pool restriction.
    assert.deepEqual(selectedAttoWallet(f.env,changed).permissions,{marketplaceFunding:false,externalTransfers:false,receive:false});
    assert.throws(()=>assertAttoWalletWrite(f.env,changed,'receive'),{code:'PERMISSION_DENIED'});
  }
  assert.throws(()=>selectedAttoWallet({...f.env,MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR:join(f.home,'other')},status),{code:'WALLET_SETUP_REQUIRED'});
  await saveWalletSelection(f.home,{attoAccess:{...access,marketplaceFunding:false}});
  assert.throws(()=>assertAttoWalletWrite(f.env,status,'receive'),{code:'PERMISSION_DENIED'});
});

test('changing the selected Atto directory never carries purpose approval to another wallet',async t=>{
  // Given one saved account with funding authority.
  const f=await fixture(t),other=join(f.home,'other');await mkdir(other,{mode:0o700});
  await saveWalletSelection(f.home,{attoDirectory:f.directory,attoAccess:access});
  // When the selected wallet is replaced without a new terminal approval.
  await saveWalletSelection(f.home,{attoDirectory:other});
  // Then the old grant is discarded, while stale approval cannot overwrite the replacement.
  assert.deepEqual(readWalletSelection(f.home),{attoDirectory:other});
  await assert.rejects(saveWalletSelection(f.home,{attoAccess:access},{expected:{attoDirectory:f.directory,attoAccess:access}}),{code:'WALLET_CONFIGURATION_CHANGED'});
  assert.deepEqual(readWalletSelection(f.home),{attoDirectory:other});
});

test('Atto Marketplace access approval preserves standalone wallet configuration and defaults to deny',async t=>{
  // Given an initialized CLI wallet and a genuine terminal with no native write grants.
  const f=await fixture(t),phrase=`${'abandon '.repeat(23)}art`;
  const app=new AttoApplication({directory:f.directory,secrets:{get:async()=>phrase,set:async()=>{}}});
  await app.createWallet(phrase);
  const before=await app.call('wallet_status',{});
  await app.close();
  const descriptors=[process.stdin,process.stderr].map(stream=>Object.getOwnPropertyDescriptor(stream,'isTTY'));
  for(const stream of [process.stdin,process.stderr])Object.defineProperty(stream,'isTTY',{configurable:true,value:true});
  try{
    const prompts=[];
    // When Marketplace-only account access is reviewed and approved.
    await approveAttoWalletAccess({home:f.home,env:f.env,directory:f.directory,index:0,prompt:async question=>{
      prompts.push(question);return question.startsWith('Type APPROVE')?'APPROVE':'';
    }});
    // Then both purposes stay denied and standalone settings/access/pool remain identical.
    assert.equal(prompts.length,3);
    const saved=readWalletSelection(f.home).attoAccess;
    assert.equal(saved.marketplaceFunding,false);assert.equal(saved.externalTransfers,false);
    const after=new AttoApplication({directory:f.directory});
    try{assert.deepEqual(await after.call('wallet_status',{}),before);}finally{await after.close();}
    const prior=readWalletSelection(f.home);
    await assert.rejects(approveAttoWalletAccess({home:f.home,env:f.env,directory:f.directory,index:0,
      grants:{marketplaceFunding:true,externalTransfers:true},prompt:async()=> 'DECLINE'}),{code:'APPROVAL_DECLINED'});
    assert.deepEqual(readWalletSelection(f.home),prior);
  }finally{
    [process.stdin,process.stderr].forEach((stream,index)=>descriptors[index]?Object.defineProperty(stream,'isTTY',descriptors[index]):delete stream.isTTY);
  }
});
