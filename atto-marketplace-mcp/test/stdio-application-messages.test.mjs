import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { MarketplaceProfileStore } from '../dist/profile-store.js';

const accountId='11111111-1111-4111-8111-111111111111';
const posterId='22222222-2222-4222-8222-222222222222';
const applicantId='33333333-3333-4333-8333-333333333333';
const taskId='44444444-4444-4444-8444-444444444444';
const applicationId='55555555-5555-4555-8555-555555555555';
const requestId='66666666-6666-4666-8666-666666666666';
const nextRequestId='77777777-7777-4777-8777-777777777777';
const foreignId='88888888-8888-4888-8888-888888888888';
const path=`/v1/agent/applications/${applicationId}/messages`;
const row=(changes={})=>({taskId,cursor:1,kind:'MESSAGE',actorAgentId:posterId,text:'**Question**',
  referenceId:applicationId,occurredAt:'2026-11-08T10:00:00Z',...changes});
const envelope=(messages=[],changes={})=>({applicationId,taskId,canMessage:true,messages,...changes});
const result=response=>response.structuredContent.result;
const add=(client,args={})=>client.callTool({name:'marketplace_application_message_add',
  arguments:{applicationId,requestId,text:'**Question**',...args}});
const list=(client,args={})=>client.callTool({name:'marketplace_application_messages_list',arguments:{applicationId,...args}});

// Tests use the actual MCP stdio server, persisted profiles and a bounded HTTP backend fixture.
test('poster and applicant discover private tools, exchange Markdown and retain closed-thread history',async()=>{
  // Given separate controller and scoped-credential participants in the same application.
  const messages=[],saved=new Map();
  let canMessage=true;
  const fixture=await setup(async(req,res,body)=>{
    if(req.method==='GET') return json(res,200,envelope(messages,{canMessage,credential:'do-not-return'}));
    const key=req.headers['idempotency-key'];
    if(saved.has(key)) return json(res,201,saved.get(key));
    if(!canMessage) return json(res,409,{error:'application_conflict',message:'raw-secret'});
    const message=row({cursor:messages.length+1,text:body.text,
      actorAgentId:req.headers.authorization==='Bearer applicant-key'?applicantId:posterId,proof:'hidden-proof'});
    messages.push(message);saved.set(key,message);
    return json(res,201,message);
  });
  const poster=await fixture.profile('poster',posterId,'controller-session');
  const applicant=await fixture.profile('applicant',applicantId,'scoped-api-key',['activity:read','activity:write']);
  const observer=await fixture.profile('observer',applicantId,'scoped-api-key',['activity:read']);
  try {
    // When each party discovers and uses the named tools.
    for(const client of [poster,applicant]) {
      const catalog=await client.listTools();
      const read=catalog.tools.find(tool=>tool.name==='marketplace_application_messages_list');
      const write=catalog.tools.find(tool=>tool.name==='marketplace_application_message_add');
      assert.equal(read.annotations.readOnlyHint,true);
      assert.deepEqual(write.inputSchema.required.sort(),['applicationId','requestId','text']);
      assert.equal(write.inputSchema.additionalProperties,false);
    }
    const sent=await add(poster,{text:'  **Question**  '});
    const reply=await add(applicant,{requestId:nextRequestId,text:'Reply with `code`'});
    const history=await list(applicant);
    // Then both authors and exact normalized text are returned without arbitrary response fields.
    assert.equal(sent.isError,undefined);assert.equal(reply.isError,undefined);
    assert.equal(result(sent).text,'**Question**');
    assert.equal(result(reply).actorAgentId,applicantId);
    assert.equal(result(history).messages.length,2);
    assert.equal(result(history).canMessage,true);
    assert.equal(JSON.stringify(history).includes('hidden-proof'),false);
    assert.equal(JSON.stringify(history).includes('do-not-return'),false);
    assert.equal(fixture.requests[0].path,path);
    const before=fixture.requests.length;
    // When an observer tries to append and a closed conversation is read or appended.
    const denied=await add(observer);
    assert.equal(denied.structuredContent.error.code,'SCOPE_REQUIRED');
    assert.equal(fixture.requests.length,before);
    canMessage=false;
    const closed=await list(poster);
    const rejected=await add(poster,{requestId:foreignId,text:'Late message'});
    const replay=await add(poster);
    // Then history remains available, new posts fail safely, and the old key recovers without HTTP.
    assert.equal(result(closed).canMessage,false);
    assert.equal(result(closed).messages.length,2);
    assert.equal(rejected.structuredContent.error.httpStatus,409);
    assert.equal(JSON.stringify(rejected).includes('raw-secret'),false);
    assert.equal(result(replay).recovered,true);
    assert.deepEqual(JSON.parse(result(replay).resultIdentity),
      {taskId,cursor:1,actorAgentId:posterId,referenceId:applicationId});
    assert.equal(messages.length,2);
    assert.ok(fixture.requests.some(request=>request.path===`${path}?after=0&limit=50`));
    assert.ok(fixture.requests.every(request=>request.path===path||request.path===`${path}?after=0&limit=50`));
  } finally { await fixture.close(); }
});

test('a lost acknowledgement survives restart and replays only the exact saved key and text with write-only scope',async()=>{
  // Given a backend that saves the message and drops its first acknowledgement.
  const calls=[];let first=true;
  const fixture=await setup(async(req,res,body)=>{
    calls.push({method:req.method,key:req.headers['idempotency-key'],body});
    if(first) {first=false;res.destroy();return;}
    return json(res,201,row({text:body.text}));
  });
  let client=await fixture.profile('poster',posterId,'scoped-api-key',['activity:write']);
  try {
    // When the first request loses its response and the process restarts.
    const lost=await add(client);
    assert.equal(lost.structuredContent.error.code,'MARKETPLACE_UNAVAILABLE');
    const pendingDatabase=new DatabaseSync(join(fixture.home,'profiles.sqlite'));
    try {
      const pending=pendingDatabase.prepare('SELECT request_id,result_identity,state FROM mutations WHERE request_id=?').get(requestId);
      assert.equal(pending.request_id,requestId);
      assert.equal(pending.state,'PENDING');
      assert.equal(JSON.stringify(JSON.parse(pending.result_identity)).includes('**Question**'),true);
    } finally {pendingDatabase.close();}
    await client.close();
    client=await fixture.connect('poster');
    const changed=await add(client,{text:'Different message'});
    const replay=await add(client);
    const localReplay=await add(client);
    // Then the changed request never reaches HTTP and recovery uses the original idempotency key.
    assert.equal(changed.structuredContent.error.code,'IDEMPOTENCY_CONFLICT');
    assert.equal(replay.isError,undefined);assert.equal(result(localReplay).recovered,true);
    assert.deepEqual(calls,[{method:'POST',key:requestId,body:{text:'**Question**'}},
      {method:'POST',key:requestId,body:{text:'**Question**'}}]);
    const database=new DatabaseSync(join(fixture.home,'profiles.sqlite'));
    try {
      const saved=database.prepare('SELECT request_hash,state FROM mutations WHERE request_id=?').get(requestId);
      assert.equal(saved.state,'COMPLETE');assert.match(saved.request_hash,/^[0-9a-f]{64}$/);
    } finally {database.close();}
  } finally {await fixture.close();}
});

test('private inputs reject route fields, invalid cursors, blank or NUL text and count Unicode codepoints',async()=>{
  // Given a write-only grant and a backend returning the exact submitted message.
  const fixture=await setup(async(req,res,body)=>json(res,201,row({text:body.text})));
  const client=await fixture.profile('poster',posterId,'scoped-api-key',['activity:write']);
  try {
    // When malformed inputs attempt to cross the fixed-route boundary.
    for(const args of [{text:'  '},{text:'a\0b'},{text:'a'.repeat(2001)},
      {path:'/arbitrary'},{applicationId:'../tasks'},{requestId:'not-a-key'}]) {
      const response=await add(client,args);
      assert.equal(response.isError,true);
    }
    for(const args of [{after:-1},{after:Number.MAX_SAFE_INTEGER+1},{limit:101},{route:'/arbitrary'}]) {
      const response=await list(client,args);assert.equal(response.isError,true);
    }
    // Then no invalid request reaches HTTP; 2000 Unicode characters are accepted exactly.
    assert.equal(fixture.requests.length,0);
    const accepted=await add(client,{text:'😀'.repeat(2000)});
    assert.equal(accepted.isError,undefined);
    assert.equal(Array.from(result(accepted).text).length,2000);
    assert.equal(fixture.requests.length,1);
  } finally {await fixture.close();}
});

test('message trim retains U+001C..U+001F and removes U+FEFF across acknowledgement recovery',async()=>{
  // Given Unicode edge characters whose ECMAScript trim rules differ from Kotlin defaults.
  const retained='\u001c\u001d\u001e\u001f';
  const expected=`${retained}**Question**${retained}`;
  const text=`\ufeff ${expected} \ufeff`;
  const received=[];
  let first=true;
  const fixture=await setup(async(req,res,body)=>{
    received.push(body.text);
    if(first) {first=false;res.destroy();return;}
    return json(res,201,row({text:body.text}));
  });
  const client=await fixture.profile('poster',posterId,'scoped-api-key',['activity:write']);
  try {
    // When a lost acknowledgement is recovered with exactly the original Unicode input.
    const lost=await add(client,{text});
    const recovered=await add(client,{text});
    const localReplay=await add(client,{text:expected});
    // Then sent text and the checked acknowledgement retain control boundaries and remove FEFF.
    assert.equal(lost.structuredContent.error.code,'MARKETPLACE_UNAVAILABLE');
    assert.equal(recovered.isError,undefined);
    assert.equal(result(recovered).text,expected);
    assert.deepEqual(received,[expected,expected]);
    assert.equal(result(localReplay).recovered,true);
    assert.deepEqual(fixture.requests.map(request=>request.key),[requestId,requestId]);
  } finally {await fixture.close();}
});

for(const [name,value] of [
  ['foreign envelope',envelope([],{applicationId:foreignId})],
  ['foreign task row',envelope([row({taskId:foreignId})])],
  ['foreign application row',envelope([row({referenceId:foreignId})])],
  ['null author',envelope([row({actorAgentId:null})])],
  ['wrong kind',envelope([row({kind:'STATUS_NOTE'})])],
  ['invalid date',envelope([row({occurredAt:'yesterday'})])],
  ['duplicate cursor',envelope([row(),row()])],
  ['backwards cursor',envelope([row({cursor:2}),row()])],
  ['missing page flag', {applicationId,taskId,messages:[]}],
]) test(`private message list rejects ${name}`,async()=>{
  // Given an untrusted backend response violating one conversation binding.
  const fixture=await setup(async(req,res)=>json(res,200,value));
  const client=await fixture.profile('poster',posterId,'scoped-api-key',['activity:read']);
  try {
    // When the bound page is requested through stdio.
    const response=await list(client);
    // Then no unvalidated row escapes the tool response.
    assert.equal(response.isError,true);
    assert.equal(response.structuredContent.error.code,'APPLICATION_MESSAGE_BINDING');
  } finally {await fixture.close();}
});

for(const [name,change] of [
  ['foreign application',{referenceId:foreignId}],['foreign author',{actorAgentId:applicantId}],
  ['changed text',{text:'Different text'}],['wrong kind',{kind:'STATUS_NOTE'}],
  ['invalid task',{taskId:'unsafe-task'}],['unsafe cursor',{cursor:Number.MAX_SAFE_INTEGER+1}],
  ['invalid date',{occurredAt:'invalid'}],
]) test(`private message acknowledgement rejects ${name} and stays recoverable`,async()=>{
  // Given a bad acknowledgement followed by the exact original successful backend result.
  let first=true;
  const fixture=await setup(async(req,res)=>{
    const value=first?row(change):row();first=false;return json(res,201,value);
  });
  const client=await fixture.profile('poster',posterId,'scoped-api-key',['activity:write']);
  try {
    // When the client receives an unbound result and retries its original request.
    const rejected=await add(client),recovered=await add(client);
    // Then the bad response does not mark the local operation complete or change its key.
    assert.equal(rejected.structuredContent.error.code,'APPLICATION_MESSAGE_BINDING');
    assert.equal(recovered.isError,undefined);
    assert.deepEqual(fixture.requests.map(request=>request.key),[requestId,requestId]);
  } finally {await fixture.close();}
});

test('private pagination enforces requested after and limit and keeps outsider denials sanitized',async()=>{
  // Given an API that can return stale rows or deny the configured identity.
  let value=envelope([row()]),status=200;
  const fixture=await setup(async(req,res)=>json(res,status,value));
  const client=await fixture.profile('poster',posterId,'controller-session');
  try {
    // When a cursor page includes an old message or exceeds its requested size.
    assert.equal((await list(client,{after:1})).isError,true);
    value=envelope([row(),row({cursor:2})]);
    assert.equal((await list(client,{limit:1})).isError,true);
    value=envelope([row({cursor:3})]);
    const valid=await list(client,{after:2,limit:1});
    status=403;value={error:'secret-code',message:'secret-message',accessToken:'secret-token'};
    const denied=await list(client);
    // Then valid pagination binds all query parameters and denials disclose no raw backend content.
    assert.equal(result(valid).messages[0].cursor,3);
    assert.equal(fixture.requests[2].path,`${path}?after=2&limit=1`);
    assert.equal(denied.structuredContent.error.code,'AUTHORIZATION_DENIED');
    assert.equal(JSON.stringify(denied).includes('secret-'),false);
  } finally {await fixture.close();}
});

test('a corrupted completed message identity fails locally without another send',async()=>{
  // Given a completed request whose persisted safe identity was replaced with another thread.
  const fixture=await setup(async(req,res)=>json(res,201,row()));
  const client=await fixture.profile('poster',posterId,'scoped-api-key',['activity:write']);
  try {
    assert.equal((await add(client)).isError,undefined);
    const database=new DatabaseSync(join(fixture.home,'profiles.sqlite'));
    try {
      database.prepare('UPDATE mutations SET result_identity=? WHERE request_id=?')
        .run(JSON.stringify({taskId,cursor:1,actorAgentId:posterId,referenceId:foreignId}),requestId);
    } finally {database.close();}
    // When the exact request is retried from the completed local journal.
    const response=await add(client);
    // Then the invalid saved binding is rejected and no new message request is submitted.
    assert.equal(response.structuredContent.error.code,'APPLICATION_MESSAGE_BINDING');
    assert.equal(fixture.requests.length,1);
  } finally {await fixture.close();}
});

test('an unexpected asynchronous command response cannot introduce another message route',async()=>{
  // Given a nonfinancial message endpoint returning an unrelated command pointer.
  const fixture=await setup(async(req,res)=>json(res,202,{commandId:foreignId,statusUrl:`/v1/agent/commands/${foreignId}`}));
  const client=await fixture.profile('poster',posterId,'scoped-api-key',['activity:write']);
  try {
    // When the message is sent through its synchronous endpoint.
    const response=await add(client);
    // Then the response is rejected and its arbitrary command is never followed.
    assert.equal(response.isError,true);
    assert.equal(response.structuredContent.error.httpStatus,202);
    assert.equal(fixture.requests.length,1);
  } finally {await fixture.close();}
});

async function setup(handler) {
  const home=await mkdtemp(join(tmpdir(),'atto-marketplace-application-messages-'));
  const store=await MarketplaceProfileStore.open(home),clients=[],requests=[];
  const http=createServer((req,res)=>{
    void (async()=>{
      let text='';for await(const chunk of req) text+=chunk;
      requests.push({method:req.method,path:req.url,key:req.headers['idempotency-key']});
      if(req.url!==path&&!req.url?.startsWith(`${path}?`)) return json(res,404,{});
      await handler(req,res,text?JSON.parse(text):null);
    })().catch(()=>{if(!res.destroyed) json(res,500,{});});
  });
  await new Promise((resolve,reject)=>http.once('error',reject).listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${http.address().port}`;
  async function connect(profile) {
    const client=new Client({name:'test-application-messages',version:'1.0.0'});
    const env=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>
      typeof value==='string'&&!key.startsWith('NODE_TEST_')));
    await client.connect(new StdioClientTransport({command:process.execPath,
      args:[join(import.meta.dirname,'../dist/main.js'),'--profile',profile,'--home',home],env,stderr:'pipe'}));
    clients.push(client);return client;
  }
  return {home,store,requests,connect,
    async profile(id,agentId,authMode,apiScopes=[]) {
      store.createProfile({id,origin,audience:'marketplace',accountId,agentId,identityId:agentId,
        controllerNetwork:'ATTO',controllerAddress:'atto://'+'a'.repeat(61),authMode,
        ...(authMode==='scoped-api-key'?{apiKey:`${id}-key`,apiScopes}:
          {accessToken:'valid-controller-access-token',accessExpiresAt:Date.now()+600_000,
            refreshToken:'valid-controller-refresh-token',refreshExpiresAt:Date.now()+1_200_000})});
      return connect(id);
    },
    async close() {
      for(const client of clients) await client.close();
      await new Promise((resolve,reject)=>http.close(error=>error?reject(error):resolve()));
      store.close();await rm(home,{recursive:true,force:true});
    }};
}
function json(res,status,value) {res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));}
