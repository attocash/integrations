import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {copyFile, mkdtemp, mkdir, readdir, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from '../../test/support/temporary-directory.mjs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import test from 'node:test';
import {provisionNanoWallet, approveNanoWalletPolicy, addressFromPublicKey, publicKey, derivePrivateKey} from '@attocash/atto-marketplace-nano-adapter';
const execute=promisify(execFile);
const directory=process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR??join(import.meta.dirname,'..');
const {callWallet}=await import(pathToFileURL(join(directory,'dist/wallet-process.js')).href);
test('the installed private Node host works with Java absent and rejects unapproved or over-limit transfers',async t=>{
  const home=await mkdtemp(join(tmpdir(),'marketplace-node-only-host-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const dataDir=join(home,'nano'),handoffDirectory=join(home,'handoffs'),bin=join(home,'bin');await mkdir(bin,{mode:0o700});
  if (process.platform === 'win32') await copyFile(process.execPath,join(bin,'node.exe'));
  else await symlink(process.execPath,join(bin,'node'));
  const env={PATH:bin,MARKETPLACE_MCP_NANO_WALLET_DATA_DIR:dataDir,MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR:handoffDirectory};
  await assert.rejects(execute('java',['-version'],{env}),{code:'ENOENT'});
  const seedFile=join(home,'seed.hex');await writeFile(seedFile,'42'.repeat(32)+'\n',{mode:0o600});
  const wallet=await provisionNanoWallet({seedFile,dataDir,derivationIndex:1,network:'nano:dev',rpcUrl:'http://localhost:1',
    origin:'http://localhost:8080',audience:'node-only',handoffDirectory,terminalConfirmed:true});
  const configuredFiles=await readdir(dataDir);
  assert.equal(configuredFiles.includes('nano-wallet.sqlite3'),false);
  await rename(seedFile,`${seedFile}.unavailable`);
  const identity=await callWallet(env,{asset:'XNO',operation:'identity.list',input:{}});
  await rename(`${seedFile}.unavailable`,seedFile);
  assert.deepEqual(await readdir(dataDir),configuredFiles,'Configured status neither needs the private key nor creates a payment journal.');
  assert.deepEqual(identity,{asset:'XNO',address:wallet.address,index:1,network:'nano:dev',
    permissions:{marketplaceFunding:false,externalTransfers:false,receive:false}});
  await assert.rejects(callWallet(env,{asset:'XNO',operation:'receive',input:{network:'nano:dev',hash:'a'.repeat(64)}}),{code:'PERMISSION_DENIED'});
  const destination=addressFromPublicKey(publicKey(derivePrivateKey(new Uint8Array(32),7)));
  const transfer={asset:'XNO',operation:'transfer.send',input:{network:'nano:dev',destination,amountAtomic:'11',requestId:randomUUID()}};
  await assert.rejects(callWallet(env,transfer),{code:'PERMISSION_DENIED'});
  await approveNanoWalletPolicy({dataDir,grants:{marketplaceFunding:false,externalTransfers:true,controllerPurposes:[]},
    limits:{maxPaymentAtomic:'10',rolling24hAtomic:'100'},terminalConfirmed:true});
  // The unavailable RPC proves these denials happen before work or publication.
  await assert.rejects(callWallet(env,transfer),{code:'SPENDING_LIMIT'});
  await assert.rejects(callWallet(env,{asset:'XNO',operation:'controller.sign',input:{message:'unstructured arbitrary bytes'}}),{code:'LOCAL_SIGNER'});
  await assert.rejects(callWallet(env,{asset:'XNO',operation:'hash.sign',input:{hash:'A'.repeat(64)}}),{code:'LOCAL_SIGNER'});
});

test('a separate controller never displaces the primary wallet or supplies fallback spending authority',async t=>{
  const {createServer}=await import('node:http');
  let rpcCalls=0;
  const rpc=createServer((_req,res)=>{rpcCalls++;res.setHeader('content-type','application/json');res.end('{"error":"unavailable fixture"}');});
  await new Promise(resolve=>rpc.listen(0,'127.0.0.1',resolve));
  t.after(()=>{rpc.closeAllConnections();return new Promise(resolve=>rpc.close(resolve));});
  const home=await mkdtemp(join(tmpdir(),'marketplace-controller-routing-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const base={derivationIndex:1,network:'nano:dev',rpcUrl:`http://127.0.0.1:${rpc.address().port}`,
    origin:'http://localhost:8080',audience:'controller-routing',terminalConfirmed:true};
  const primaryDir=join(home,'primary'),controllerDir=join(home,'controller');
  const primarySeed=join(home,'primary.hex'),controllerSeed=join(home,'controller.hex');
  await writeFile(primarySeed,'42'.repeat(32)+'\n',{mode:0o600});
  await writeFile(controllerSeed,'43'.repeat(32)+'\n',{mode:0o600});
  const primary=await provisionNanoWallet({...base,seedFile:primarySeed,dataDir:primaryDir,handoffDirectory:join(home,'primary-handoffs'),
    grants:{controllerPurposes:['login']}});
  const controller=await provisionNanoWallet({...base,seedFile:controllerSeed,dataDir:controllerDir,handoffDirectory:join(home,'controller-handoffs'),
    grants:{controllerPurposes:['login'],externalTransfers:true},limits:{maxPaymentAtomic:'100',rolling24hAtomic:'100'}});
  assert.notEqual(primary.address,controller.address);
  const env={MARKETPLACE_MCP_NANO_WALLET_DATA_DIR:primaryDir,MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR:controllerDir};
  assert.equal((await callWallet(env,{asset:'XNO',operation:'identity.list',input:{}})).address,primary.address);
  await assert.rejects(callWallet(env,{asset:'XNO',operation:'transfer.send',input:{network:'nano:dev',destination:controller.address,
    amountAtomic:'1',requestId:randomUUID()}}),{code:'PERMISSION_DENIED'});
  assert.equal(rpcCalls,0);
  const proof=address=>({origin:base.origin,network:base.network,address,index:1,audience:base.audience,purpose:'login',
    message:['Nano Marketplace Agent Controller Proof v1',`Audience: ${base.audience}`,'Network: nano:dev',`Address: ${address}`,
      'Purpose: login',`Request ID: ${randomUUID()}`,`Binding Hash: ${'a'.repeat(64)}`,`Nonce: ${'b'.repeat(64)}`,
      `Issued At: ${new Date().toISOString()}`,`Expiration Time: ${new Date(Date.now()+120000).toISOString()}`].join('\n')});
  // Valid controller terms reach its own RPC; the primary profile has another address.
  await assert.rejects(callWallet(env,{asset:'XNO',operation:'controller.sign',input:proof(controller.address)}),{code:'LOCAL_SIGNER'});
  assert.equal(rpcCalls,1);
  // An explicitly missing controller must fail before contacting the primary's RPC.
  await assert.rejects(callWallet({...env,MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR:join(home,'missing')},
    {asset:'XNO',operation:'controller.sign',input:proof(primary.address)}),{code:'LOCAL_SIGNER'});
  assert.equal(rpcCalls,1);
});
