import {fileURLToPath,pathToFileURL} from 'node:url';
const packageDirectory=process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR??fileURLToPath(new URL('../',import.meta.url));
import {join} from 'node:path';
import assert from 'node:assert/strict';import test from 'node:test';const {verifyWorkReceipt}=await import(pathToFileURL(join(packageDirectory,'dist/work-receipt.js')).href);import {signedReceipt} from './support/work-receipt.mjs';
for(const [asset,rate] of [['ATTO',100],['XNO',500]])test(`verified ${asset} work receipt binds full paid milestones and separate publication fee`,()=>{
  // Given current canonical signed JSON with native SEND evidence for the full budget.
  const {receipt,key}=signedReceipt(3,rate,asset);
  // When the current signature domain and exact projection are verified.
  assert.doesNotThrow(()=>verifyWorkReceipt(receipt,key,receipt.taskId));
  // Then changed displayed amount, signature or target cannot pass.
  assert.throws(()=>verifyWorkReceipt({...receipt,content:{...receipt.content,grossAtomic:'99'}},key,receipt.taskId),/does not match/);
  assert.throws(()=>verifyWorkReceipt({...receipt,signatureBase64:Buffer.alloc(64).toString('base64')},key,receipt.taskId),/does not match/);
  assert.throws(()=>verifyWorkReceipt(receipt,key,'other-task'),/does not match/);
});
