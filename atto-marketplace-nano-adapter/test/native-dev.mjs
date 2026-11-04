#!/usr/bin/env node
// Explicitly opt-in: sends only public Nano dev genesis funds to fresh isolated wallets.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, openSync, fsyncSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { NanoWallet, NanoRpcClient, NanoStateBlock, provisionNanoWallet, addressPublicKey, upperHex, hexBytes } from '../dist/index.js';
import { DEV_GENESIS_ACCOUNT } from '../dist/rpc.js';

if(process.env.NANO_WALLET_NATIVE_DEV_TEST!=='1')throw Error('Set NANO_WALLET_NATIVE_DEV_TEST=1 to authorize fresh-wallet Nano dev chain tests.');
const target=new URL(process.env.NANO_WALLET_NATIVE_DEV_RPC??'http://127.0.0.1:17076');
if(!['localhost','127.0.0.1','[::1]'].includes(target.hostname)||target.protocol!=='http:')throw Error('Only a local Nano development node is accepted.');
const root=mkdtempSync(join(tmpdir(),'nano-wallet-native-'));chmodSync(root,0o700);
const rpc=new NanoRpcClient(target,'nano:dev');await rpc.requirePinnedNetwork();rpc.requireLoopbackDevelopmentEndpoint();
let dropMode=null,processCalls=0;const observed=[];
const proxy=createServer(async(req,res)=>{
  try{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks),parsed=JSON.parse(body);
    if(parsed.action==='process'){
      processCalls++;observed.push(JSON.stringify(parsed.block));
      if(dropMode==='before'){dropMode=null;req.socket.destroy();return;}
    }
    const upstream=await fetch(target,{method:'POST',headers:{'content-type':'application/json'},body,signal:AbortSignal.timeout(20000)}),text=await upstream.text();
    if(parsed.action==='process'&&dropMode==='after'){dropMode=null;req.socket.destroy();return;}
    res.writeHead(upstream.status,{'content-type':'application/json'});res.end(text);
  }catch{res.destroy();}
});
await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});
const proxyUrl=`http://127.0.0.1:${proxy.address().port}`;
async function provision(name){const dataDir=join(root,name);mkdirSync(dataDir,{mode:0o700});const handoffDirectory=join(dataDir,'handoff');mkdirSync(handoffDirectory,{mode:0o700});const seedFile=join(dataDir,'import.hex');writeFileSync(seedFile,randomBytes(32).toString('hex')+'\n',{mode:0o600});return {dataDir,...await provisionNanoWallet({dataDir,seedFile,derivationIndex:1,network:'nano:dev',rpcUrl:proxyUrl,origin:'http://localhost:8080',audience:'marketplace',handoffDirectory,grants:{marketplaceFunding:true,externalTransfers:true,controllerPurposes:['login']},limits:{maxPaymentAtomic:'1000000',rolling24hAtomic:'10000000'},terminalConfirmed:true})};}
async function confirmed(hash,timeout=120000){const end=Date.now()+timeout;while(Date.now()<end){const evidence=await rpc.blockInfo(hash);if(evidence?.confirmed)return evidence;await delay(200);}throw Error(`Confirmation timed out: ${hash}`);}
function durable(name,value){const path=join(root,name);writeFileSync(path,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}const parent=openSync(root,'r');try{fsyncSync(parent);}finally{closeSync(parent);}return path;}
async function genesisSend(address,amount){const account=await rpc.accountSnapshot(DEV_GENESIS_ACCOUNT);assert.equal(account.frontier,account.confirmedFrontier);const work=await rpc.generateWork(account.frontier,2);const key=hexBytes('34F0A37AAD20F4A260F0A5B3CB3D7FB50673212263E58A380BC10474BB039CE4');let block;try{block=NanoStateBlock.signed(key,account.frontier,account.representative,account.balance-amount,upperHex(addressPublicKey(address)),work);}finally{key.fill(0);}durable(`genesis-send-${block.hash}.json`,block.toWire());await rpc.process(block,'send');await confirmed(block.hash);return block.hash;}
async function settled(wallet,operation,args){let result=await wallet.call(operation,args);if(result.state==='CONFIRMED')return result;const candidate=result.sendHash??result.openHash;assert.ok(candidate);await confirmed(candidate);if(operation==='transfer.send')return wallet.call('transfer.status',{requestId:args.requestId});if(operation==='receive')return wallet.call('receive',args);return wallet.call('devsource.open',args);}

const a=await provision('sender'),b=await provision('recipient');let wallet=NanoWallet.open({dataDir:a.dataDir});let recipient=NanoWallet.open({dataDir:b.dataDir});
const results=[];
try{
  const funding=await genesisSend(a.address,1000000n);const opened=await settled(wallet,'devsource.open',{fundingSendHash:funding});assert.equal(opened.state,'CONFIRMED');results.push({case:'confirmed SEND and OPEN',hash:opened.openHash});
  const second=await genesisSend(a.address,10n);const received=await settled(wallet,'receive',{network:'nano:dev',hash:second});assert.equal(received.state,'CONFIRMED');results.push({case:'confirmed RECEIVE',hash:received.sendHash});
  const request={network:'nano:dev',destination:b.address,amountAtomic:'100',requestId:randomUUID()};dropMode='before';
  const uncertain=await wallet.call('transfer.send',request);assert.equal(uncertain.state,'UNKNOWN');const originalHash=uncertain.sendHash;wallet.close();wallet=NanoWallet.open({dataDir:a.dataDir});
  await assert.rejects(wallet.call('transfer.send',{...request,requestId:randomUUID()}),{code:'SOURCE_FENCED'});
  const beforeRetry=processCalls,retry=await settled(wallet,'transfer.send',request);assert.equal(retry.sendHash,originalHash);assert.equal(retry.state,'CONFIRMED');assert.equal(processCalls,beforeRetry+1);assert.equal(observed.at(-1),observed.at(-2));results.push({case:'unknown outcome, restart, same-byte retry',hash:retry.sendHash});
  const recipientOpen=await settled(recipient,'receive',{network:'nano:dev',hash:retry.sendHash});assert.equal(recipientOpen.state,'CONFIRMED');results.push({case:'recipient OPEN with public wallet API',hash:recipientOpen.sendHash});
  dropMode='after';const lostArgs={...request,amountAtomic:'7',requestId:randomUUID()},lost=await wallet.call('transfer.send',lostArgs);assert.equal(lost.state,'UNKNOWN');const callsAfterLoss=processCalls;
  wallet.close();wallet=NanoWallet.open({dataDir:a.dataDir});await confirmed(lost.sendHash);const recovered=await wallet.call('transfer.status',{requestId:lostArgs.requestId});assert.equal(recovered.state,'CONFIRMED');assert.equal(processCalls,callsAfterLoss);results.push({case:'accepted SEND, lost response, restart status recovery',hash:recovered.sendHash});
  const recipientReceive=await settled(recipient,'receive',{network:'nano:dev',hash:recovered.sendHash});assert.equal(recipientReceive.state,'CONFIRMED');
  const balanceA=await wallet.call('balance.get',{network:'nano:dev'}),balanceB=await recipient.call('balance.get',{network:'nano:dev'});assert.equal(balanceA.balanceAtomic,'999903');assert.equal(balanceB.balanceAtomic,'107');
  durable('results.json',{rpc:target.origin,results,sender:a.address,recipient:b.address,balanceA:balanceA.balanceAtomic,balanceB:balanceB.balanceAtomic,processCalls});
  console.log(JSON.stringify({stateDirectory:root,results,balanceA:balanceA.balanceAtomic,balanceB:balanceB.balanceAtomic,processCalls},null,2));
}finally{wallet.close();recipient.close();await new Promise(resolve=>proxy.close(resolve));}
