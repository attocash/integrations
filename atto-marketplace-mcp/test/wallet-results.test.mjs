import assert from 'node:assert/strict';
import test from 'node:test';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {AttoAddress,AttoAlgorithm,AttoPublicKey} from '@attocash/commons-core';
import {addressFromPublicKey,publicKey,derivePrivateKey} from '@attocash/atto-marketplace-nano-adapter';

const directory=process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR??join(import.meta.dirname,'..');
const {canonicalWalletDestination,normalizeWalletResult,publicWalletIdentity}=await import(pathToFileURL(join(directory,'dist/wallet-results.js')));
const {publicWalletErrorCode}=await import(pathToFileURL(join(directory,'dist/wallet-host.js')));
const key='11'.repeat(32),otherKey='22'.repeat(32);
const attoAddress=value=>new AttoAddress(AttoAlgorithm.V1,new AttoPublicKey(new Int8Array(32).fill(value))).value;
const nanoAddress=value=>addressFromPublicKey(publicKey(derivePrivateKey(new Uint8Array(32).fill(value),7)));
const permissions={marketplaceFunding:true,externalTransfers:false,receive:true};
const atto={asset:'ATTO',network:'atto:local',address:attoAddress(17),index:7,permissions};
const nano={asset:'XNO',network:'nano:dev',address:nanoAddress(1),index:7,permissions};
const sendHash='ab'.repeat(32),receiveHash='cd'.repeat(32);
const requestId='f7e9bc29-471b-423c-8fb1-a89a96d609df';
const amount='17999999999999999999';

test('Given configured wallets, when reading status and confirmed balance, then both expose the same selected-account contract',()=>{
  const attoStatus=normalizeWalletResult(atto,'identity.list',{directory:'/private/path',addresses:[atto],settings:{secret:'hidden'}},{});
  const nanoStatus=normalizeWalletResult(nano,'identity.list',{identities:[nano]},{});
  assert.deepEqual(Object.keys(attoStatus).sort(),Object.keys(nanoStatus).sort());
  assert.deepEqual(attoStatus,atto);
  assert.deepEqual(nanoStatus,nano);
  const attoBalance=normalizeWalletResult(atto,'balance.get',{balances:[{address:atto.address,index:7,balance:{raw:amount}}],total:{raw:amount}},{});
  const nanoBalance=normalizeWalletResult(nano,'balance.get',{address:nano.address,index:7,network:nano.network,balanceAtomic:amount,pending:true},{});
  assert.deepEqual(attoBalance,{asset:'ATTO',network:atto.network,address:atto.address,index:7,balanceAtomic:amount});
  assert.deepEqual(Object.keys(attoBalance).sort(),Object.keys(nanoBalance).sort());
  assert.equal(nanoBalance.balanceAtomic,amount);
});

test('Given all reachable transfer states, when recovering the original request, then uncertainty stays pending and exact identities survive',()=>{
  for (const [identity,states] of [[atto,{reserved:'PENDING',signed:'PENDING',unknown:'PENDING',published:'SETTLED',failed:'REJECTED'}],
    [nano,{PREPARING:'PENDING',PREPARED:'PENDING',UNKNOWN:'PENDING',READY:'PENDING',CONFIRMED:'SETTLED',COMPETING:'REJECTED'}]]) {
    const attoProvider=identity.asset==='ATTO';
    for (const [providerState,state] of Object.entries(states)) {
      const destination=attoProvider?attoAddress(34):nanoAddress(2);
      const candidate=['reserved','PREPARING','READY'].includes(providerState)?null:sendHash;
      const record=attoProvider?{id:requestId,status:providerState,network:'LOCAL',index:7,sourceAddress:identity.address,destination,raw:amount,hash:candidate}
        :{requestId,state:providerState,network:identity.network,index:7,sourceAddress:identity.address,destination,amountAtomic:amount,sendHash:candidate};
      const actual=normalizeWalletResult(identity,'transfer.status',record,{requestId});
      assert.deepEqual(actual,{asset:identity.asset,network:identity.network,index:7,sourceAddress:identity.address,destination,
        amountAtomic:amount,requestId,state,hash:candidate?.toUpperCase()??null});
    }
  }
});

test('Given durable transfer terms, when provider data changes account, network, amount or request, then the response fails closed',()=>{
  const destination=attoAddress(34);
  const record={id:requestId,status:'unknown',network:'LOCAL',index:7,sourceAddress:atto.address,destination,raw:amount,hash:sendHash};
  const input={requestId,destination,amount,unit:'RAW'};
  for (const patch of [{index:0},{sourceAddress:destination},{network:'LIVE'},{raw:'1'},{id:'another-request'},
    {status:'unexpected-new-state'},{external:{kind:'marketplace-intent'}}]) {
    assert.throws(()=>normalizeWalletResult(atto,'transfer.send',{...record,...patch},input));
  }
  assert.throws(()=>normalizeWalletResult(atto,'transfer.status',{...record,status:'published',hash:null},{requestId}));
});

test('Given an xrb destination alias, when sending native funds, then input canonicalization preserves its actual recipient',()=>{
  const destination=nanoAddress(2),alias=destination.replace(/^nano_/,'xrb_');
  assert.equal(canonicalWalletDestination('XNO',alias),destination);
  const record={requestId,state:'UNKNOWN',network:nano.network,index:7,sourceAddress:nano.address,destination,amountAtomic:amount,sendHash};
  const result=normalizeWalletResult(nano,'transfer.send',record,{requestId,destination:alias,amountAtomic:amount});
  assert.equal(result.destination,destination);
  assert.equal(result.state,'PENDING');
  assert.throws(()=>normalizeWalletResult(nano,'transfer.send',{...record,destination:alias},{requestId,destination:alias,amountAtomic:amount}),
    {code:'WALLET_RESPONSE_INVALID'},'Provider responses must use the canonical account address.');
  assert.throws(()=>canonicalWalletDestination('ATTO','atto://unsupported-link'),{code:'INVALID_REQUEST'});
});

test('Given bounded receivable observations, when scanning either asset, then source, atomic amount and possible incompleteness are explicit',()=>{
  const attoRow={network:'LOCAL',algorithm:'V1',publicKey:otherKey,receiverAlgorithm:'V1',receiverPublicKey:key,hash:sendHash,amount};
  const attoResult=normalizeWalletResult(atto,'receivable.list',{items:[attoRow],timedOut:true},{limit:2});
  const nanoResult=normalizeWalletResult(nano,'receivable.list',{address:nano.address,index:7,network:nano.network,
    receivables:[{hash:sendHash,source:nanoAddress(2),amountAtomic:amount}]},{limit:1});
  assert.equal(attoResult.incomplete,true);
  assert.equal(nanoResult.incomplete,true);
  assert.deepEqual(attoResult.items,[{hash:sendHash.toUpperCase(),sourceAddress:attoAddress(34),amountAtomic:amount}]);
  assert.deepEqual(Object.keys(attoResult).sort(),Object.keys(nanoResult).sort());
  assert.equal(normalizeWalletResult(atto,'receivable.list',{items:[],timedOut:false,limitReached:true},{limit:1}).incomplete,true);
  assert.equal(normalizeWalletResult(nano,'receivable.list',{address:nano.address,index:7,network:nano.network,receivables:[]},{limit:1}).incomplete,false);
  assert.throws(()=>normalizeWalletResult(atto,'receivable.list',{items:[{...attoRow,receiverPublicKey:otherKey}],timedOut:false},{limit:2}));
  assert.throws(()=>normalizeWalletResult(atto,'receivable.list',{items:[attoRow,attoRow],timedOut:false},{limit:2}));
});

test('Given receive or open results, when reporting settlement or uncertainty, then incoming SEND and RECEIVE hashes remain distinct',()=>{
  // Given matching native receive observations for each supported asset.
  const block={type:'OPEN',network:'LOCAL',algorithm:'V1',publicKey:key,sendHash};
  // When the results are normalized into the common public response.
  const attoResult=normalizeWalletResult(atto,'receive',{status:'received',index:7,hash:receiveHash,transaction:{block},amount:{raw:amount}},{hash:sendHash});
  const nanoResult=normalizeWalletResult(nano,'receive',{state:'UNKNOWN',network:nano.network,index:7,sourceAddress:nano.address,
    sendHash:receiveHash,amountAtomic:amount},{hash:sendHash});
  // Then both hashes and exact amounts remain bound, and missing metadata is refused.
  assert.equal(attoResult.state,'SETTLED');
  assert.equal(nanoResult.state,'PENDING');
  assert.equal(attoResult.hash,receiveHash.toUpperCase());
  assert.equal(attoResult.sendHash,sendHash.toUpperCase());
  assert.equal(nanoResult.hash,receiveHash.toUpperCase());
  assert.deepEqual(Object.keys(attoResult).sort(),Object.keys(nanoResult).sort());
  assert.throws(()=>normalizeWalletResult(atto,'receive',{status:'received',hash:receiveHash,transaction:{block}},{hash:sendHash}),
    {code:'WALLET_RESPONSE_INVALID'},'A missing recovered amount must be resolved by the wallet instead of emitted as settled.');
  assert.throws(()=>normalizeWalletResult(atto,'receive',{status:'received',hash:receiveHash,transaction:{block:{...block,sendHash:receiveHash}}},{hash:sendHash}));
});

test('Given a durable Atto RECEIVE candidate, when publication is unresolved, then only its bound private observation becomes pending',()=>{
  // Given a saved uncertain candidate whose exact amount was captured before publication.
  const pending={status:'unknown',hash:receiveHash,index:7,sendHash,sourceAddress:atto.address,network:'LOCAL',amountAtomic:amount};
  // When its public recovery result is constructed.
  const result=normalizeWalletResult(atto,'receive',pending,{hash:sendHash});
  // Then identity and amount remain exact, and incomplete or conflicting data fails closed.
  assert.deepEqual(result,{asset:'ATTO',network:atto.network,address:atto.address,index:7,
    sendHash:sendHash.toUpperCase(),hash:receiveHash.toUpperCase(),amountAtomic:amount,state:'PENDING'});
  for (const patch of [{index:0},{network:'LIVE'},{sourceAddress:attoAddress(34)},{sendHash:receiveHash},{hash:null},
    {transaction:{}},{amountAtomic:0},{amountAtomic:null},{amountAtomic:undefined}]) {
    assert.throws(()=>normalizeWalletResult(atto,'receive',{...pending,...patch},{hash:sendHash}),{code:'WALLET_RESPONSE_INVALID'});
  }
});

test('Given foreign or malformed identities, when building a public wallet identity, then configuration mismatches fail closed',()=>{
  assert.throws(()=>publicWalletIdentity({...atto,address:nano.address}));
  assert.throws(()=>publicWalletIdentity({...nano,network:'atto:local'}));
  assert.throws(()=>publicWalletIdentity({...atto,permissions:{...permissions,receive:false}}));
  assert.throws(()=>normalizeWalletResult(atto,'balance.get',{balances:[{address:atto.address,index:0,balance:{raw:amount}}]},{}));
  assert.throws(()=>normalizeWalletResult(nano,'balance.get',{address:nano.address,index:7,network:nano.network,balanceAtomic:123},{}),
    {code:'WALLET_RESPONSE_INVALID'});
});

test('Given equivalent provider denials, when returning wallet errors, then shared permissions, limits and fencing use one vocabulary',()=>{
  for (const code of ['SPEND_LIMIT','SPENDING_LIMIT','DAILY_LIMIT','PAYMENT_LIMIT','LIMIT_EXCEEDED']) {
    assert.equal(publicWalletErrorCode({code}),'SPENDING_LIMIT');
  }
  for (const code of ['PERMISSION_DENIED','EXTERNAL_TRANSFERS_DENIED','MARKETPLACE_FUNDING_DENIED','MCP_READ_ONLY']) {
    assert.equal(publicWalletErrorCode({code}),'PERMISSION_DENIED');
  }
  for (const code of ['SOURCE_FENCED','ACCOUNT_RESERVED','POOL_BUSY','PAYMENT_IN_PROGRESS','WALLET_BUSY','ACCOUNT_BUSY']) {
    assert.equal(publicWalletErrorCode({code}),'SOURCE_FENCED');
  }
  for (const code of ['REQUEST_CONFLICT','RPC_CONFLICT','WALLET_SETUP_REQUIRED','WALLET_RESPONSE_INVALID']) {
    assert.equal(publicWalletErrorCode({code}),code);
  }
});
