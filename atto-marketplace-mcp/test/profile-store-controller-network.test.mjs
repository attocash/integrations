import { setPermissions } from './support/private-permissions.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from '../../test/support/temporary-directory.mjs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {MarketplaceProfileStore} from '../dist/profile-store.js';

const accountId='11111111-1111-4111-8111-111111111111';
const agentId='22222222-2222-4222-8222-222222222222';
const identityId='33333333-3333-4333-8333-333333333333';
const requestId='44444444-4444-4444-8444-444444444444';

test('current ATTO and Nano profiles preserve their controller indexes and durable journal across restart', async () => {
  // Given current profiles for both native controller networks and a saved mutation.
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-controller-network-'));
  let store=await MarketplaceProfileStore.open(home);
  try {
    const common={origin:'https://marketplace.example',audience:'marketplace',accountId,agentId,identityId,authMode:'controller-session'};
    store.createProfile({...common,id:'atto',controllerNetwork:'ATTO',controllerAddress:`atto://${'a'.repeat(61)}`,controllerIndex:7});
    store.createProfile({...common,id:'nano',controllerNetwork:'NANO',
      controllerAddress:'nano_3e3j5tkog48pnny9dmfzj1r16pg8t1e76dz5tmac6iq689wyjfpiij4txtdo',controllerIndex:0xffff_ffff});
    store.beginMutation({profileId:'atto',requestId,operation:'task-draft-create',target:accountId,requestHash:'hash'});
    // When the private store reopens without schema migration.
    store.close();
    store=await MarketplaceProfileStore.open(home);
    // Then both indexes and the original mutation remain unchanged.
    assert.equal(store.getProfile('atto').controllerIndex,7);
    assert.equal(store.getProfile('nano').controllerIndex,0xffff_ffff);
    assert.equal(store.getMutationByRequestId('atto',requestId).operation,'task-draft-create');
  } finally {store.close();await rm(home,{recursive:true,force:true});}
});

test('a retry reserves the same durable result handle if a process stopped after mutation reservation', async () => {
  // Given a controller profile and a pending mutation that has no handle yet.
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-mutation-resume-'));
  const store=await MarketplaceProfileStore.open(home);
  try {
    store.createProfile({id:'agent',origin:'https://marketplace.example',audience:'marketplace',accountId,agentId,identityId,
      controllerNetwork:'ATTO',controllerAddress:`atto://${'a'.repeat(61)}`,controllerIndex:0,authMode:'controller-session'});
    const identity={profileId:'agent',requestId,operation:'marketplace-fund',target:accountId,requestHash:'funding-hash'};
    assert.deepEqual(store.beginMutation(identity),{state:'PENDING',resultIdentity:null});

    // When funding resumes, it reserves one opaque handle, and concurrent retries keep that same handle.
    const reserved=store.beginMutation(identity,'a'.repeat(32));
    assert.deepEqual(reserved,{state:'PENDING',resultIdentity:'a'.repeat(32)});
    assert.deepEqual(store.beginMutation(identity,'b'.repeat(32)),{state:'PENDING',resultIdentity:'a'.repeat(32)});
    assert.equal(store.getMutationByRequestId('agent',requestId).resultIdentity,'a'.repeat(32));
  } finally {
    store.close();
    await rm(home,{recursive:true,force:true});
  }
});

test('an old Marketplace profile schema is rejected without migrating rows or touching native wallet state', async () => {
  // Given an old profile database and unrelated retained wallet recovery bytes.
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-old-schema-'));
  const path=join(home,'profiles.sqlite'),wallet=join(home,'wallets','atto');
  await mkdir(wallet,{recursive:true,mode:0o700});
  await writeFile(join(wallet,'recovery.marker'),'retained wallet recovery',{mode:0o600});
  const db=new DatabaseSync(path);
  db.exec("CREATE TABLE profiles(id TEXT PRIMARY KEY,controller_network TEXT NOT NULL CHECK(controller_network='ATTO')); INSERT INTO profiles VALUES('existing','ATTO');");
  db.close();
  await setPermissions(path,0o600);
  const before=await readFile(path);
  try {
    // When current Marketplace MCP opens the old schema.
    await assert.rejects(MarketplaceProfileStore.open(home),{code:'PROFILE_SCHEMA'});
    // Then no schema migration, row rewrite, or native wallet deletion occurs.
    assert.deepEqual(await readFile(path),before);
    assert.equal(await readFile(join(wallet,'recovery.marker'),'utf8'),'retained wallet recovery');
  } finally {await rm(home,{recursive:true,force:true});}
});
