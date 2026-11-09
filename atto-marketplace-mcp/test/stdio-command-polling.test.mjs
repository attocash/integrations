import assert from 'node:assert/strict';
import test from 'node:test';
import {isDeepStrictEqual} from 'node:util';
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

for(const scenario of [
  {name:'PENDING status responses',disconnectStatusRequests:false},
  {name:'status transport failures',disconnectStatusRequests:true},
]) {
  test(`a 202 financial command survives ${scenario.name} and resumes by GET after process restart`,async t=>{
    // Given an accepted command whose status remains pending or cannot be fetched.
    const requests=[];
    const pointer={commandId,statusUrl:`/v1/agent/commands/${commandId}`};
    let commandStatus='PENDING';
    let http,home,store,client;
    t.after(async()=>{
      await client?.close();
      if(http) {
        http.closeAllConnections();
        await new Promise(resolve=>http.close(resolve));
      }
      store?.close();
      if(home) await rm(home,{recursive:true,force:true});
    });
    const result={taskId:'66666666-6666-4666-8666-666666666666',state:'DRAFT',version:0};
    http=await listen(async(req,res)=>{
      const body=await readBody(req);
      requests.push({method:req.method,path:req.url,authorization:req.headers.authorization,
        idempotencyKey:req.headers['idempotency-key'],body});
      if(req.method==='POST'&&req.url==='/v1/agent/tasks') return json(res,202,
        {...pointer,status:'PENDING'});
      if(req.method==='GET'&&req.url===pointer.statusUrl) {
        if(commandStatus==='PENDING'&&scenario.disconnectStatusRequests) {
          req.socket.destroy();
          return;
        }
        return json(res,200,{...pointer,status:commandStatus,
          ...(commandStatus==='SETTLED'?{result}:{})});
      }
      return json(res,404,{});
    });
    home=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-command-'));
    store=await MarketplaceProfileStore.open(home);
    store.createProfile({id:'agent',origin:http.origin,audience:'marketplace',accountId,agentId,identityId,
      controllerNetwork:'ATTO',controllerAddress:`atto://${'a'.repeat(61)}`,authMode:'scoped-api-key',apiKey:'test-api-key',
      apiScopes:['tasks:draft:write']});
    client=await connect(home,'agent',2_000);
    const args={requestId,draft};

    // When the original request exhausts its command polling budget.
    const pending=await client.callTool({name:'marketplace_task_draft_create',arguments:args});

    // Then only the unresolved pointer and the permitted transport diagnostic are returned and saved.
    assert.equal(pending.isError,true);
    assert.equal(pending.structuredContent.error.code,'COMMAND_PENDING');
    const unavailableDetails={...pointer,statusErrorCode:'MARKETPLACE_UNAVAILABLE'};
    // A final GET may exhaust the remaining budget even when the mock responds immediately.
    const expectedDetails=scenario.disconnectStatusRequests?[unavailableDetails]:[pointer,unavailableDetails];
    assert.ok(expectedDetails.some(expected=>isDeepStrictEqual(pending.structuredContent.error.details,expected)),
      `Unexpected command details: ${JSON.stringify(pending.structuredContent.error.details)}`);
    const saved=store.getMutationByRequestId('agent',requestId);
    assert.equal(saved.state,'PENDING');
    assert.deepEqual(JSON.parse(saved.resultIdentity),{kind:'MARKETPLACE_MUTATION_RECOVERY',command:pointer});
    assert.equal(requests.filter(row=>row.method==='POST').length,1);
    assert.ok(requests.some(row=>row.method==='GET'&&row.path===pointer.statusUrl));
    assert.deepEqual(requests.find(row=>row.method==='POST').body,draft);
    assert.equal(requests.find(row=>row.method==='POST').idempotencyKey,requestId);

    // Given the first process is closed and the original command settles.
    await client.close();
    client=undefined;
    commandStatus='SETTLED';
    client=await connect(home,'agent',5_000);
    const recoveryStart=requests.length;

    // When the restarted process receives the identical request.
    const recovered=await client.callTool({name:'marketplace_task_draft_create',arguments:args});

    // Then it reads the original command without posting a replacement.
    assert.notEqual(recovered.isError,true,text(recovered));
    assert.deepEqual(JSON.parse(text(recovered)).result,result);
    assert.deepEqual(requests.slice(recoveryStart).map(({method,path})=>({method,path})),
      [{method:'GET',path:pointer.statusUrl}]);
    assert.equal(requests.filter(row=>row.method==='POST').length,1,'recovery must poll the saved command, not resubmit');
    assert.equal(store.getMutationByRequestId('agent',requestId).state,'COMPLETE');
    assert.ok(requests.every(row=>row.authorization==='Bearer test-api-key'));
  });
}

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
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,args:[serverMain,'--profile',profile,'--home',home],env:environment,stderr:'pipe'}));
    return client;
  } catch(error) {
    await client.close();
    throw error;
  }
}

async function listen(handler){
  const server=createServer((req,res)=>{void Promise.resolve(handler(req,res)).catch(()=>{if(!res.destroyed)json(res,500,{});});});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  return Object.assign(server,{origin:`http://127.0.0.1:${server.address().port}`});
}

async function readBody(req){let body='';for await(const chunk of req)body+=chunk;return body?JSON.parse(body):null;}
function json(res,status,body){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));}
function text(result){return result.content?.filter(part=>part.type==='text').map(part=>part.text).join('\n')??'';}
