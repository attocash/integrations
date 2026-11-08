import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from '../../test/support/temporary-directory.mjs';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {MarketplaceProfileStore} from '../dist/profile-store.js';

const accountId='11111111-1111-4111-8111-111111111111';
const agentId='22222222-2222-4222-8222-222222222222';
const identityId='33333333-3333-4333-8333-333333333333';

test('a refresh waits for a cross-thread SQLite writer and preserves its original claim', async () => {
  // Given an expired controller session while an independent worker thread owns SQLite's write lock.
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-profile-lock-'));
  const store=await MarketplaceProfileStore.open(home);
  store.createProfile({id:'agent',origin:'http://127.0.0.1:8080',audience:'marketplace',accountId,agentId,identityId,
    controllerNetwork:'ATTO',controllerAddress:`atto://${'a'.repeat(61)}`,authMode:'controller-session',
    accessToken:'expired-access-token',accessExpiresAt:Date.now()-1000,
    refreshToken:'original-refresh-token',refreshExpiresAt:Date.now()+120_000});

  const holderSource=`
    const {parentPort,workerData}=require('node:worker_threads');
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(workerData.database);
    db.exec('BEGIN IMMEDIATE');
    parentPort.postMessage({state:'locked'});
    setTimeout(()=>{
      try { db.exec('ROLLBACK'); parentPort.postMessage({state:'released'}); }
      catch (error) { parentPort.postMessage({state:'release-failed',code:error.code??'SQLITE_ERROR'}); }
      finally { db.close(); }
    },workerData.holdMs);
  `;
  const holder=new Worker(holderSource,{eval:true,workerData:{database:join(home,'profiles.sqlite'),holdMs:600},stderr:true});
  holder.stderr?.on('data',()=>{});
  const queued=[];
  const waiters=[];
  let holderFailure;
  holder.on('message',message=>{
    const waiter=waiters.shift();
    if(waiter) waiter.resolve(message);
    else queued.push(message);
  });
  holder.on('error',error=>{
    holderFailure=error;
    for(const waiter of waiters.splice(0)) waiter.reject(error);
  });
  holder.on('exit',code=>{
    if(code!==0&&!holderFailure){
      holderFailure=new Error(`SQLite lock holder exited with code ${code}`);
      for(const waiter of waiters.splice(0)) waiter.reject(holderFailure);
    }
  });
  const nextMessage=async(timeoutMs=5000)=>{
    if(holderFailure) throw holderFailure;
    if(queued.length) return queued.shift();
    let timer;
    try {
      return await Promise.race([
        new Promise((resolve,reject)=>waiters.push({resolve,reject})),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('SQLite lock holder timed out')),timeoutMs);}),
      ]);
    } finally {clearTimeout(timer);}
  };

  try {
    assert.deepEqual(await nextMessage(),{state:'locked'});
    const released=nextMessage();
    const started=Date.now();
    let attempt;
    let beginFailure;
    // When the original refresh claims its state while that independent transaction is still held.
    try { attempt=store.beginRefresh('agent'); }
    catch(error) { beginFailure=error; }
    const waitedMs=Date.now()-started;
    const releaseMessage=await released;

    // Then it waits, claims the unchanged original refresh token once, and completes under the same attempt owner.
    assert.deepEqual(releaseMessage,{state:'released'});
    assert.equal(beginFailure,undefined,`beginRefresh failed under SQLite contention: ${beginFailure?.code??beginFailure?.message}`);
    assert.ok(waitedMs>=200,`beginRefresh did not wait for the held write lock (${waitedMs}ms)`);
    assert.equal(attempt?.kind,'refresh');
    assert.equal(attempt?.refreshToken,'original-refresh-token');
    const claimed=store.getProfile('agent');
    assert.equal(claimed.refreshState,'IN_FLIGHT');
    assert.equal(claimed.refreshAttemptId,attempt?.attemptId);

    store.completeRefresh('agent',attempt.attemptId,{accessToken:'rotated-access-token',accessExpiresAt:Date.now()+60_000,
      refreshToken:'rotated-refresh-token',refreshExpiresAt:Date.now()+120_000});
    const completed=store.getProfile('agent');
    assert.equal(completed.refreshState,'READY');
    assert.equal(completed.refreshAttemptId,null);
    assert.equal(completed.accessToken,'rotated-access-token');
    assert.equal(completed.refreshToken,'rotated-refresh-token');
  } finally {
    await holder.terminate().catch(()=>undefined);
    store.close();
    await rm(home,{recursive:true,force:true});
  }
});
