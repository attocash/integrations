import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,readdirSync} from 'node:fs';
import {mkdtemp,rm,symlink} from 'node:fs/promises';
import {tmpdir} from '../../test/support/temporary-directory.mjs';
import {join} from 'node:path';
import test from 'node:test';
import {inspectNanoSeed,inspectNanoWallet,provisionNanoWallet} from '../dist/index.js';
import {validateConfiguration,withPrivateKey} from '../dist/configuration.js';
test('a supplied missing seed never generates a replacement or creates wallet state',async t=>{
 // Given an explicit seed import whose file is absent.
 const root=await mkdtemp(join(tmpdir(),'nano-import-preserve-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const dataDir=join(root,'new-wallet'),seedFile=join(root,'missing.hex');
 // When provisioning is attempted.
 await assert.rejects(provisionNanoWallet({dataDir,seedFile,derivationIndex:1,network:'nano:dev',rpcUrl:'http://localhost:17076',origin:'http://localhost:8080',audience:'inspect',handoffDirectory:join(root,'handoffs'),terminalConfirmed:true}),{code:'PRIVATE_FILE'});
 // Then no replacement seed or wallet state is created.
 assert.equal(existsSync(seedFile),false);assert.equal(existsSync(dataDir),false);
});
test('identity inspection preserves keys and never initializes journals or missing handoff directories',async t=>{
 // Given a configured wallet with an explicitly imported seed.
 const root=await mkdtemp(join(tmpdir(),'nano-inspect-readonly-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const dataDir=join(root,'wallet'),handoffDirectory=join(root,'handoffs');
 const seedFile=join(root,'import.hex');writeFileSync(seedFile,'01'.repeat(32)+'\n',{mode:0o600});
 const wallet=await provisionNanoWallet({dataDir,seedFile,derivationIndex:1,network:'nano:dev',rpcUrl:'http://localhost:17076',origin:'http://localhost:8080',audience:'inspect',handoffDirectory,terminalConfirmed:true});
 const config=JSON.parse(readFileSync(wallet.configurationPath,'utf8')),seed=readFileSync(config.keySource.seedFile);
 const files=readdirSync(dataDir);
 // When identities are inspected without opening the journal.
 assert.equal((await inspectNanoSeed(config.keySource.seedFile,1)).address,wallet.address);assert.deepEqual(await inspectNanoWallet(dataDir),config);
 // Then keys and wallet files remain unchanged and missing directories stay absent.
 assert.deepEqual(readFileSync(config.keySource.seedFile),seed);assert.deepEqual(readdirSync(dataDir),files);assert.equal(existsSync(join(dataDir,'nano-wallet.sqlite3')),false);
 await rm(handoffDirectory,{recursive:true});await assert.rejects(inspectNanoWallet(dataDir),{code:'PRIVATE_FILE'});assert.equal(existsSync(handoffDirectory),false);
});

test('current schema pins explicit native derivation and rejects old shapes and unsupported raw grants',async t=>{
 // Given an explicitly imported native seed in the current schema.
 const root=await mkdtemp(join(tmpdir(),'nano-current-schema-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const seedFile=join(root,'seed.hex');writeFileSync(seedFile,'02'.repeat(32)+'\n',{mode:0o600});
 const options={dataDir:join(root,'wallet'),seedFile,derivationIndex:1,network:'nano:dev',rpcUrl:'http://localhost:17076',origin:'http://localhost:8080',audience:'schema',handoffDirectory:join(root,'handoffs'),terminalConfirmed:true};
 const result=await provisionNanoWallet(options),config=await inspectNanoWallet(options.dataDir);
 assert.deepEqual(config.keySource,{type:'native-seed',seedFile,derivationVersion:'nano-seed-blake2b-v1'});
 const {keySource,...settings}=config;
 // When legacy versions, extra source fields, unknown derivations, or Shop raw grants are presented.
 const unsupported=[{...settings,seedFile},{...settings,version:2,recoverySource:{},derivationVersion:'bip39-ed25519-slip10-nano-v1'},
   {...config,keySource:{...keySource,recoverySource:{}}},{...config,keySource:{...keySource,derivationVersion:'unknown'}},
   {...config,grants:{...config.grants,controllerPurposes:['product purchase']}},
   {...config,grants:{...config.grants,controllerPurposes:['product refund']}}];
 // Then the single current reader rejects every unsupported shape without changing the approved wallet.
 for(const value of unsupported)assert.throws(()=>validateConfiguration(value));
 assert.equal((await inspectNanoWallet(options.dataDir)).sourceAddress,result.address);
});
test('provisioning without an explicit key source never generates a native seed',async t=>{
 // Given a new wallet with neither an approved recovery source nor a native seed import.
 const root=await mkdtemp(join(tmpdir(),'nano-no-random-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const dataDir=join(root,'wallet'),handoffDirectory=join(root,'handoffs');
 const options={dataDir,derivationIndex:0,network:'nano:dev',rpcUrl:'http://localhost:17076',origin:'http://localhost:8080',audience:'schema',handoffDirectory,terminalConfirmed:true};
 // When source-less or ambiguous provisioning is attempted.
 await assert.rejects(provisionNanoWallet(options),{code:'WALLET_CONFIGURATION'});
 await assert.rejects(provisionNanoWallet({...options,seedFile:join(root,'seed.hex'),recoveryWalletDirectory:root}),{code:'WALLET_CONFIGURATION'});
 // Then neither request creates wallet, handoff or seed files.
 assert.deepEqual(readdirSync(root),[]);
});
test('native key callbacks are awaited and erase their key after success or rejection',async t=>{
 // Given a current native wallet and callback code that yields before returning.
 const root=await mkdtemp(join(tmpdir(),'nano-async-key-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const seedFile=join(root,'seed.hex');writeFileSync(seedFile,'03'.repeat(32)+'\n',{mode:0o600});
 const options={dataDir:join(root,'wallet'),seedFile,derivationIndex:0,network:'nano:dev',rpcUrl:'http://localhost:17076',origin:'http://localhost:8080',audience:'async',handoffDirectory:join(root,'handoffs'),terminalConfirmed:true};
 const provisioning=provisionNanoWallet(options);assert.equal(typeof provisioning.then,'function');await provisioning;
 const inspection=inspectNanoSeed(seedFile,0);assert.equal(typeof inspection.then,'function');await inspection;
 const config=await inspectNanoWallet(options.dataDir);let retained;
 // When a callback resolves or rejects after yielding, its key remains live only inside the callback.
 const pending=withPrivateKey(config,async key=>{retained=key;await Promise.resolve();assert.equal(key.some(byte=>byte!==0),true);return 'done';});
 assert.equal(typeof pending.then,'function');assert.equal(await pending,'done');
 // Then all borrowed key bytes are erased after either outcome.
 assert.deepEqual([...retained],Array(32).fill(0));
 await assert.rejects(withPrivateKey(config,async key=>{retained=key;await Promise.resolve();throw Error('callback failed');}),/callback failed/);
 assert.deepEqual([...retained],Array(32).fill(0));
});

test('canonical fixture roots do not allow symlinked wallet ancestors', async t => {
 // Given a private seed reachable through a symlinked ancestor.
 const root=await mkdtemp(join(tmpdir(),'nano-symlink-parent-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const seedFile=join(root,'seed.hex');writeFileSync(seedFile,'04'.repeat(32)+'\n',{mode:0o600});
 const alias=join(root,'alias');await symlink(root,alias);
 const options={dataDir:join(root,'wallet'),seedFile:join(alias,'seed.hex'),derivationIndex:0,network:'nano:dev',rpcUrl:'http://localhost:17076',origin:'http://localhost:8080',audience:'symlink-parent',handoffDirectory:join(root,'handoffs'),terminalConfirmed:true};
 // When wallet provisioning uses that alias.
 await assert.rejects(provisionNanoWallet(options),{code:'PRIVATE_FILE'});
 // Then it creates no wallet state, while the physical seed remains usable.
 assert.equal(existsSync(options.dataDir),false);
 const configured=await provisionNanoWallet({...options,seedFile});
 assert.equal((await inspectNanoSeed(seedFile,0)).address,configured.address);
 await assert.rejects(inspectNanoSeed(join(alias,'seed.hex'),0),{code:'PRIVATE_FILE'});
});
