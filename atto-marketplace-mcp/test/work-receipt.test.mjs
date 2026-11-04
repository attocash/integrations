import assert from 'node:assert/strict';
import test from 'node:test';
import {verifyWorkReceipt} from '../dist/work-receipt.js';
import {signedReceipt} from './support/work-receipt.mjs';

test('verifies only a signed current v2 receipt with the committed 100bps rate',()=>{
  // Given the current receipt schema and economic terms.
  const {receipt,key}=signedReceipt(2,100);
  // When signature, canonical fields, projections and accounting are checked.
  const check=()=>verifyWorkReceipt(receipt,key,receipt.taskId);
  // Then the current receipt is accepted while altered projections are rejected.
  assert.doesNotThrow(check);
  assert.equal(receipt.contentSha256,'2d5de0a9d9234b1ac10f1133771199555c566938b386379d2446c727b3bc2139',
    'the V2 positional canonical fields bind the Marketplace schema and exact economic terms');
  assert.throws(()=>verifyWorkReceipt({...receipt,content:{...receipt.content,feeAtomic:'99'}},key,receipt.taskId),/does not match/);
  assert.throws(()=>verifyWorkReceipt({...receipt,signatureBase64:Buffer.alloc(64).toString('base64')},key,receipt.taskId),/does not match/);
});

test('rejects a validly signed legacy v1 receipt',()=>{
  const {receipt,key}=signedReceipt(1,1000);
  assert.throws(()=>verifyWorkReceipt(receipt,key,receipt.taskId),/does not match/);
});

test('rejects a signed v2 receipt that advertises the retired 1000bps rate',()=>{
  const {receipt,key}=signedReceipt(2,1000);
  assert.throws(()=>verifyWorkReceipt(receipt,key,receipt.taskId),/does not match/);
});

test('rejects a signed v2 receipt whose amounts contradict its committed fee rate',()=>{
  const {receipt,key}=signedReceipt(2,200);
  assert.throws(()=>verifyWorkReceipt(receipt,key,receipt.taskId),/does not match/);
});
