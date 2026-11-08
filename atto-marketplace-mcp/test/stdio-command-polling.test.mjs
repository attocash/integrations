import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from '../../test/support/temporary-directory.mjs';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {MarketplaceProfileStore} from '../dist/profile-store.js';

const accountId='11111111-1111-4111-8111-111111111111';
const agentId='22222222-2222-4222-8222-222222222222';
const identityId='33333333-3333-4333-8333-333333333333';
const requestId='44444444-4444-4444-8444-444444444444';
const commandId='55555555-5555-4555-8555-555555555555';
const serverMain=join(import.meta.dirname,'../dist/main.js');
const draft={title:'Durable command test',description:'A focused command recovery test.',deliverable:'A test result.',
  acceptanceTerms:'The durable result is returned once.',asset:'ATTO',grossAtomic:'10'};

test('a 202 financial command is saved and resumed by GET after a timeout and process restart',async t=>{
  const requests=[];
  let commandStatus='PENDING';
  const result={taskId:'66666666-6666-4666-8666-666666666666',state:'DRAFT',version:0};
  const http=await listen(async(req,res)=>{
    const body=await readBody(req);
    requests.push({method:req.method,path:req.url,authorization:req.headers.authorization,
      idempotencyKey:req.headers['idempotency-key'],body});
    if(req.method==='POST'&&req.url==='/v1/agent/tasks') return json(res,202,
      {commandId,status:'PENDING',statusUrl:`/v1/agent/commands/${commandId}`});
    if(req.method==='GET'&&req.url===`/v1/agent/commands/${commandId}`) {
      return json(res,200,{commandId,status:commandStatus,statusUrl:`/v1/agent/commands/${commandId}`,
        ...(commandStatus==='SETTLED'?{result}:{})});
    }
    return json(res,404,{});
  });
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-command-'));
  const store=await MarketplaceProfileStore.open(home);
  store.createProfile({id:'agent',origin:http.origin,audience:'marketplace',accountId,agentId,identityId,
    controllerNetwork:'ATTO',controllerAddress:`atto://${'a'.repeat(61)}`,authMode:'scoped-api-key',apiKey:'test-api-key',
    apiScopes:['tasks:draft:write']});
  let client=await connect(home,'agent',100);
  try {
    const args={requestId,draft};
    const pending=await client.callTool({name:'marketplace_task_draft_create',arguments:args});
    assert.equal(pending.isError,true);
    assert.equal(pending.structuredContent.error.code,'COMMAND_PENDING');
    assert.deepEqual(pending.structuredContent.error.details,{commandId,statusUrl:`/v1/agent/commands/${commandId}`});
    assert.equal(requests.filter(row=>row.method==='POST').length,1);
    assert.ok(requests.some(row=>row.method==='GET'&&row.path===`/v1/agent/commands/${commandId}`));
    assert.deepEqual(requests.find(row=>row.method==='POST').body,draft);
    assert.equal(requests.find(row=>row.method==='POST').idempotencyKey,requestId);

    await client.close();
    client=await connect(home,'agent',5_000);
    commandStatus='SETTLED';
    const recovered=await client.callTool({name:'marketplace_task_draft_create',arguments:args});
    assert.notEqual(recovered.isError,true,text(recovered));
    assert.deepEqual(JSON.parse(text(recovered)).result,result);
    assert.equal(requests.filter(row=>row.method==='POST').length,1,'recovery must poll the saved command, not resubmit');
    assert.ok(requests.filter(row=>row.method==='GET').length>=2);
    assert.ok(requests.every(row=>row.authorization==='Bearer test-api-key'));
  } finally {
    await client.close();
    http.close();
    store.close();
    await rm(home,{recursive:true,force:true});
  }
});

test('a rejected command preserves the backend error code and never retries its POST',async t=>{
  const requests=[];
  const http=await listen(async(req,res)=>{
    requests.push({method:req.method,path:req.url});
    if(req.method==='POST'&&req.url==='/v1/agent/tasks') return json(res,202,
      {commandId,status:'PENDING',statusUrl:`/v1/agent/commands/${commandId}`});
    if(req.method==='GET'&&req.url===`/v1/agent/commands/${commandId}`) return json(res,200,
      {commandId,status:'REJECTED',statusUrl:`/v1/agent/commands/${commandId}`,errorCode:'INSUFFICIENT_BALANCE',httpStatus:409});
    return json(res,404,{});
  });
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-command-rejected-'));
  const store=await MarketplaceProfileStore.open(home);
  store.createProfile({id:'agent',origin:http.origin,audience:'marketplace',accountId,agentId,identityId,
    controllerNetwork:'ATTO',controllerAddress:`atto://${'a'.repeat(61)}`,authMode:'scoped-api-key',apiKey:'test-api-key',
    apiScopes:['tasks:draft:write']});
  const client=await connect(home,'agent');
  try {
    const rejected=await client.callTool({name:'marketplace_task_draft_create',arguments:{requestId,draft}});
    assert.equal(rejected.isError,true);
    assert.equal(rejected.structuredContent.error.code,'INSUFFICIENT_BALANCE');
    assert.equal(rejected.structuredContent.error.httpStatus,409);
    assert.equal(rejected.structuredContent.error.details.commandId,commandId);
    assert.equal(requests.filter(row=>row.method==='POST').length,1);
  } finally {
    await client.close();
    http.close();
    store.close();
    await rm(home,{recursive:true,force:true});
  }
});

async function connect(home,profile,waitMs){
  const client=new Client({name:'test-command-recovery',version:'1.0.0'});
  const environment=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>typeof value==='string'
    &&key!=='NODE_TEST_CONTEXT'&&!key.startsWith('NODE_TEST_')));
  environment.MARKETPLACE_COMMAND_WAIT_MS=String(waitMs);
  await client.connect(new StdioClientTransport({command:process.execPath,args:[serverMain,'--profile',profile,'--home',home],env:environment,stderr:'pipe'}));
  return client;
}

async function listen(handler){
  const server=createServer((req,res)=>{void Promise.resolve(handler(req,res)).catch(()=>{if(!res.destroyed)json(res,500,{});});});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  return Object.assign(server,{origin:`http://127.0.0.1:${server.address().port}`});
}

async function readBody(req){let body='';for await(const chunk of req)body+=chunk;return body?JSON.parse(body):null;}
function json(res,status,body){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));}
function text(result){return result.content?.filter(part=>part.type==='text').map(part=>part.text).join('\n')??'';}
