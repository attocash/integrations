import {fileURLToPath,pathToFileURL} from 'node:url';
const packageDirectory=process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR??fileURLToPath(new URL('../',import.meta.url));
import test from 'node:test';import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from '../../test/support/temporary-directory.mjs';
import {Client} from '@modelcontextprotocol/client';import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const {MarketplaceProfileStore}=await import(pathToFileURL(join(packageDirectory,'dist/profile-store.js')).href);
test('noncustodial MCP exposes direct evidence and ordered milestones while retiring customer custody tools',async()=>{
  // Given a configured local scoped profile and no connected native wallet.
  const home=await mkdtemp(join(tmpdir(),'marketplace-direct-tools-')),id='11111111-1111-4111-8111-111111111111';
  const requests=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];
    for await(const chunk of req)chunks.push(chunk);
    requests.push({method:req.method,path:req.url,body:JSON.parse(Buffer.concat(chunks).toString())});
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({status:'PENDING'}));
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const store=await MarketplaceProfileStore.open(home);
  store.createProfile({id:'test',origin:`http://127.0.0.1:${server.address().port}`,audience:'audience',accountId:id,agentId:id,identityId:id,controllerNetwork:'ATTO',controllerAddress:`atto://${'a'.repeat(61)}`,authMode:'scoped-api-key',apiKey:'test-key',apiScopes:['payments:read','payments:write','applications:apply']});store.close();
  const client=new Client({name:'direct-client-test',version:'1'});
  try{
    const env=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>typeof value==='string'&&key!=='NODE_TEST_CONTEXT'&&!key.startsWith('NODE_TEST_')));
    await client.connect(new StdioClientTransport({command:process.execPath,args:[join(packageDirectory,'dist/main.js'),'--home',home,'--profile','test'],env,stderr:'pipe'}));
    // When the public tool catalog is inspected.
    const {tools}=await client.listTools(),names=tools.map(t=>t.name);
    // Then direct payments and free applications have exact narrow schemas without custody commands.
    const instructions=client.getInstructions();
    assert.match(instructions,/wallet signs and saves the native SEND/);
    assert.match(instructions,/Marketplace retries queued durable relays using that SEND and independently verifies confirmation/);
    assert.match(instructions,/Only VERIFIED establishes paid status/);
    assert.match(instructions,/Marketplace holds no customer keys or balances/);
    assert.doesNotMatch(instructions,/All native transactions sign and broadcast locally|never publishes customer payments/);
    assert.equal(tools.find(t=>t.name==='marketplace_tasks_search')?.description,'Search public open Marketplace tasks by exact asset, text and cursor.');
    for(const name of ['marketplace_payment_get','marketplace_payment_pay','marketplace_payment_relay_reauthorize','marketplace_payment_evidence','marketplace_publication_fee_get','marketplace_task_milestones'])assert.ok(names.includes(name),name);
    for(const name of ['marketplace_payment_challenge','marketplace_balances_get','marketplace_fund','marketplace_funding_status','marketplace_withdrawal_create','marketplace_withdrawals_list','marketplace_payout_address_mutate','marketplace_product_publication_quote'])assert.ok(!names.includes(name),name);
    const recovery=tools.find(t=>t.name==='marketplace_payment_relay_reauthorize');
    assert.deepEqual(recovery.inputSchema.required.sort(),['paymentId','requestId','transactionHash','validUntil']);
    const evidence=tools.find(t=>t.name==='marketplace_payment_evidence');
    assert.deepEqual(evidence.inputSchema.required.sort(),['paymentId','requestId','transactionHash']);
    assert.deepEqual(Object.keys(evidence.inputSchema.properties).sort(),evidence.inputSchema.required);
    const transactionHash='c'.repeat(64);
    const requestId='22222222-2222-4222-8222-222222222222';
    const submitted=await client.callTool({name:evidence.name,arguments:{paymentId:id,requestId,transactionHash}});
    assert.notEqual(submitted.isError,true);
    assert.deepEqual(requests,[{method:'POST',path:`/v1/agent/payments/${id}/evidence`,body:{requestId,transactionHash}}]);
    const signIn = tools.find(t => t.name === 'marketplace_browser_signin');
    assert.deepEqual(Object.keys(signIn.inputSchema.properties), ['path']);
    assert.equal(signIn.inputSchema.additionalProperties, false);
    for (const args of [{}, {path:'/shop?tab=orders#latest'}]) {
      const response = await client.callTool({name:signIn.name, arguments:args});
      assert.notEqual(response.isError,true);
      assert.equal(response.structuredContent.result.status,'manual_sign_in');
      assert.equal(response.structuredContent.result.url,'https://atto.market'+(args.path ?? '/workspace'));
      assert.equal(JSON.stringify(response).includes('test-key'),false);
    }
    for (const args of [{path:'//other.example'}, {taskId:id}]) {
      const response = await client.callTool({name:signIn.name, arguments:args});
      assert.equal(response.isError,true);
    }
    const application=tools.find(t=>t.name==='marketplace_application_create');assert.deepEqual(Object.keys(application.inputSchema.properties).sort(),['expectedTaskVersion','proposal','requestId','taskId']);
    const publication=tools.find(t=>t.name==='marketplace_product_publish');assert.ok(publication.inputSchema.required.includes('quantity'));assert.ok(!Object.hasOwn(publication.inputSchema.properties,'maxReservationAtomic'));
  }finally{await client.close();await new Promise(resolve=>server.close(resolve));await rm(home,{recursive:true,force:true});}
});
