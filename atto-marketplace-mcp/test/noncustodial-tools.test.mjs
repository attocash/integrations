import {fileURLToPath,pathToFileURL} from 'node:url';
const packageDirectory=process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR??fileURLToPath(new URL('../',import.meta.url));
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from '../../test/support/temporary-directory.mjs';
import {Client} from '@modelcontextprotocol/client';import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const {MarketplaceProfileStore}=await import(pathToFileURL(join(packageDirectory,'dist/profile-store.js')).href);
test('noncustodial MCP exposes direct evidence and ordered milestones while retiring customer custody tools',async()=>{
  // Given a configured local scoped profile and no connected native wallet.
  const home=await mkdtemp(join(tmpdir(),'marketplace-direct-tools-')),id='11111111-1111-4111-8111-111111111111';
  const store=await MarketplaceProfileStore.open(home);
  store.createProfile({id:'test',origin:'http://127.0.0.1:12345',audience:'audience',accountId:id,agentId:id,identityId:id,controllerNetwork:'ATTO',controllerAddress:`atto://${'a'.repeat(61)}`,authMode:'scoped-api-key',apiKey:'test-key',apiScopes:['payments:read','payments:write','applications:apply']});store.close();
  const client=new Client({name:'direct-client-test',version:'1'});
  try{
    const env=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>typeof value==='string'&&key!=='NODE_TEST_CONTEXT'&&!key.startsWith('NODE_TEST_')));
    await client.connect(new StdioClientTransport({command:process.execPath,args:[join(packageDirectory,'dist/main.js'),'--home',home,'--profile','test'],env,stderr:'pipe'}));
    // When the public tool catalog is inspected.
    const {tools}=await client.listTools(),names=tools.map(t=>t.name);
    // Then direct payments and free applications have exact narrow schemas without custody commands.
    const instructions=client.getInstructions();
    assert.ok(instructions.includes('For marketplace_payment_pay, the selected local wallet signs and durably retains the exact native candidate and authorization. Marketplace relays the signed x402 payment unchanged and independently verifies the confirmed SEND. Marketplace holds no customer keys or balances.'));
    assert.doesNotMatch(instructions,/All native transactions sign and broadcast locally|never publishes customer payments/);
    assert.equal(tools.find(t=>t.name==='marketplace_tasks_search')?.description,'Search public open Marketplace tasks by exact asset, text and cursor.');
    for(const name of ['marketplace_payment_get','marketplace_payment_pay','marketplace_payment_challenge','marketplace_payment_evidence','marketplace_publication_fee_get','marketplace_task_milestones'])assert.ok(names.includes(name),name);
    for(const name of ['marketplace_balances_get','marketplace_fund','marketplace_funding_status','marketplace_withdrawal_create','marketplace_withdrawals_list','marketplace_payout_address_mutate','marketplace_product_publication_quote'])assert.ok(!names.includes(name),name);
    const application=tools.find(t=>t.name==='marketplace_application_create');assert.deepEqual(Object.keys(application.inputSchema.properties).sort(),['expectedTaskVersion','proposal','requestId','taskId']);
    const publication=tools.find(t=>t.name==='marketplace_product_publish');assert.ok(publication.inputSchema.required.includes('quantity'));assert.ok(!Object.hasOwn(publication.inputSchema.properties,'maxReservationAtomic'));
  }finally{await client.close();await rm(home,{recursive:true,force:true});}
});
