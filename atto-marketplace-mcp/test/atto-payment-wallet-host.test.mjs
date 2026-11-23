import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { fixture, gate, until } from '../../atto-cli/test/support/payments.mjs';
import { offer, terms, paymentId } from '../../test/support/relay.mjs';

const directory=process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR??join(import.meta.dirname,'..');
const cliDirectory=process.env.ATTO_TEST_CLI_PACKAGE_DIR??join(import.meta.dirname,'../../atto-cli');
const {callWallet}=await import(pathToFileURL(join(directory,'dist/wallet-process.js')));
const {saveWalletSelection,readWalletSelection}=await import(pathToFileURL(join(directory,'dist/wallet-preferences.js')));
const {decodePaymentHeader}=await import(pathToFileURL(join(cliDirectory,'dist/marketplace/relay.js')));

test('private ATTO process bridge finishes asynchronous payment operations before closing and recovers exact authorization',
  {timeout:30000,skip:process.platform!=='linux'?'Uses the Linux OS credential adapter fixture.':false},async t=>{
    // Given the real private stdio host, selected index 1 and an asynchronous OS secret/native work boundary.
    const f=await fixture(t,['100','100']),home=join(f.directory,'marketplace'),bin=join(f.directory,'bin');
    await mkdir(home,{mode:0o700});
    await mkdir(bin,{mode:0o700});
    const phraseFile=join(f.directory,'fixture-credential');
    await writeFile(phraseFile,f.mnemonic(),{mode:0o600});
    await writeFile(join(bin,'secret-tool'),'#!/bin/sh\n[ "$1" = lookup ] || exit 2\nsleep 0.05\ncat "$ATTO_TEST_PHRASE_FILE"\n',{mode:0o700});
    const status=await f.app.call('wallet_status',{}),selected=status.addresses.find(value=>value.index===1);
    const access={address:selected.address,index:1,network:'atto:local',fingerprint:status.identity.fingerprint,externalTransfers:true};
    await saveWalletSelection(home,{attoDirectory:f.directory,attoAccess:access});
    const env={...process.env,PATH:bin+':'+process.env.PATH,MARKETPLACE_MCP_HOME:home,
      MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR:f.directory,ATTO_TEST_PHRASE_FILE:phraseFile};
    const p={...terms('ATTO',selected.address,f.recipient.address),baselineFrontier:'02'.repeat(32)},
      request={requestId:paymentId,origin:'https://marketplace.example',audience:'marketplace',terms:p,paymentRequired:offer(p)};
    const invoke=(operation,input)=>callWallet(env,{asset:'ATTO',operation,input});
    f.state.holdWork=gate();let outcome;
    const pending=invoke('payment.prepare',request).then(value=>{outcome={value};return value;},error=>{outcome={error};throw error;});
    pending.catch(()=>{});
    // When native work remains pending across event-loop turns before the host can return or close its session.
    await until(()=>{if(outcome?.error)throw outcome.error;return f.state.works.length>0;});
    assert.equal(outcome,undefined);
    f.state.holdWork.release();
    const prepared=await pending,record=f.app.ledger.get(paymentId);
    // Then preparation durably retained the full candidate for the selected account without publishing.
    assert.ok(record.transactionJson);assert.equal(record.index,1);
    assert.equal(prepared.hash,record.hash);assert.equal(record.relay.paymentSignature,prepared.paymentSignature);
    assert.equal(f.app.ledger.usage().pendingRaw,'40');assert.equal(f.app.ledger.journalList().items.length,1);
    assert.equal(f.state.publicationAttempts.length,0);
    // When status and prepare reopen the journal in fresh wallet processes.
    const recovered=await invoke('payment.status',{requestId:paymentId});
    const retried=await invoke('payment.prepare',request);
    // Then status/retry reopen the same journal and preserve its exact header, candidate, allowance and selection.
    assert.equal(recovered.hash,prepared.hash);assert.equal(recovered.paymentSignature,prepared.paymentSignature);
    assert.equal(retried.hash,prepared.hash);assert.equal(retried.paymentSignature,prepared.paymentSignature);
    assert.equal(f.app.ledger.get(paymentId).transactionJson,record.transactionJson);
    const decoded=decodePaymentHeader(recovered.paymentSignature);
    assert.equal(decoded.payload.transaction.block.receiverAddress,p.recipientAddress);
    assert.equal(decoded.payload.transaction.block.amount,'40');
    assert.deepEqual(Object.keys(decoded.extensions),['payment-identifier']);
    assert.deepEqual(decoded.extensions['payment-identifier'].info,{required:true,id:paymentId});
    assert.deepEqual(readWalletSelection(home).attoAccess,access);
    assert.equal(f.app.ledger.usage().pendingRaw,'40');assert.equal(f.app.ledger.journalList().items.length,1);
    assert.equal(f.state.publicationAttempts.length,0);
    assert.equal(await readFile(phraseFile,'utf8'),f.mnemonic());
    await assert.rejects(invoke('payment.status',{requestId:paymentId,index:0}),{code:'INVALID_REQUEST'});
    await saveWalletSelection(home,{attoAccess:{...access,externalTransfers:false}});
    await assert.rejects(invoke('payment.prepare',request),{code:'PERMISSION_DENIED'});
    assert.equal((await invoke('payment.status',{requestId:paymentId})).paymentSignature,prepared.paymentSignature);
  });
