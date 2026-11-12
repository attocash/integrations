import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const packageDirectory = process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR ?? join(import.meta.dirname, '..');
const { MarketplaceProfileStore } = await import(pathToFileURL(join(packageDirectory, 'dist/profile-store.js')).href);
const { readLocalSource } = await import(pathToFileURL(join(packageDirectory, 'dist/submission-files.js')).href);

const accountId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const identityId = '33333333-3333-4333-8333-333333333333';
const taskId = '44444444-4444-4444-8444-444444444444';
const uploadId = '55555555-5555-4555-8555-555555555555';
const fileId = '66666666-6666-4666-8666-666666666666';
const contentVersionId = '77777777-7777-4777-8777-777777777777';
const submissionId = '88888888-8888-4888-8888-888888888888';
const serverMain = join(packageDirectory, 'dist/main.js');
const bytes = Buffer.from('verified agent deliverable\n');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const manifestHash = 'a'.repeat(64);
const file = {ordinal:0,fileId,contentVersionId,filename:'source.txt',byteLength:bytes.length,
  mediaType:'text/plain',sha256};
const readyFile = {fileId,contentVersionId,filename:'source.txt',byteLength:bytes.length,
  mediaType:'text/plain',sha256,state:'READY'};

test('stdio submission file tools upload only selected bounded paths and verify before publishing downloads', async () => {
  // Given scoped profiles, one configured private root, and a Marketplace API fixture for an immutable file manifest.
  const root = await mkdtemp(join(tmpdir(), 'atto-marketplace-mcp-private-files-'));
  const home = join(root, 'profile');
  const filesDirectory = join(root, 'files');
  const outsideDirectory = join(root,'outside-files');
  await mkdir(outsideDirectory,{mode:0o700});
  const outside = join(outsideDirectory,'outside.bin');
  const sourceAlias = process.platform === 'win32' ? 'outside-link/outside.bin' : 'outside-link.bin';
  const destinationAlias = process.platform === 'win32' ? 'downloads/outside-target/outside.bin' : 'downloads/outside-target.bin';
  await mkdir(join(filesDirectory, 'downloads'), {recursive:true,mode:0o700});
  await writeFile(join(filesDirectory, 'source.txt'), bytes, {mode:0o600});
  await writeFile(outside, bytes, {mode:0o600});
  if (process.platform === 'win32') {
    // Directory junctions need no elevation and preserve the real outside-file escape attempts.
    await symlink(outsideDirectory,join(filesDirectory,'outside-link'),'junction');
    await symlink(outsideDirectory,join(filesDirectory,'downloads','outside-target'),'junction');
  } else {
    await symlink(outside,join(filesDirectory,'outside-link.bin'));
    await symlink(outside,join(filesDirectory,'downloads','outside-target.bin'));
  }

  const requests = [];
  let uploadState = 'PENDING_UPLOAD';
  let uploadedBytes;
  let tamperDownload = false;
  const http = await listen(async (req, res) => {
    const body = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req);
    const parsedBody = body.length > 0 && req.headers['content-type']?.includes('application/json')
      ? JSON.parse(body.toString('utf8')) : undefined;
    requests.push({method:req.method,path:req.url,authorization:req.headers.authorization,
      idempotency:req.headers['idempotency-key'],body:parsedBody ?? body});

    if (req.method === 'POST' && req.url === '/v1/agent/files/uploads') {
      return json(res, 201, {uploadId,state:uploadState,file:null});
    }
    if (req.method === 'GET' && req.url === `/v1/agent/files/uploads/${uploadId}`) {
      return json(res, 200, {uploadId,state:uploadState,file:uploadState === 'READY' ? readyFile : null});
    }
    if (req.method === 'PUT' && req.url === `/v1/agent/files/uploads/${uploadId}/content`) {
      uploadedBytes = body;
      uploadState = 'SCANNING';
      return json(res, 200, {uploadId,state:'PENDING_UPLOAD',byteLength:bytes.length,sha256});
    }
    if (req.method === 'POST' && req.url === `/v1/agent/files/uploads/${uploadId}/finalize`) {
      uploadState = 'READY';
      return json(res, 200, {uploadId,state:'READY',file:readyFile});
    }
    if (req.method === 'POST' && req.url === `/v1/agent/tasks/${taskId}/submissions`) {
      return json(res, 201, {taskId,submissionId,version:2,files:[file],manifestHash});
    }
    if (req.method === 'GET' && new URL(req.url ?? '/', http.origin).pathname === `/v1/agent/tasks/${taskId}/submissions`) {
      return json(res, 200, [{taskId,submissionId,version:2,files:[file],manifestHash}]);
    }
    if (req.method === 'GET' && req.url === `/v1/agent/files/${fileId}/content`) {
      const responseBytes = tamperDownload ? Buffer.from('tampered agent deliverable\n') : bytes;
      res.writeHead(200, {'content-type':'application/octet-stream','content-length':String(responseBytes.length)});
      res.end(responseBytes);
      return;
    }
    return json(res, 404, {error:'not_found'});
  });

  const store = await MarketplaceProfileStore.open(home);
  store.createProfile({id:'agent',origin:http.origin,audience:'marketplace',accountId,agentId,identityId,
    controllerNetwork:'ATTO',controllerAddress:`atto://${'a'.repeat(61)}`,authMode:'scoped-api-key',
    apiKey:'private-file-scoped-key',apiScopes:['files:read','files:write','submissions:read','submissions:write']});
  store.createProfile({id:'limited',origin:http.origin,audience:'marketplace',accountId,agentId,identityId,
    controllerNetwork:'ATTO',controllerAddress:`atto://${'a'.repeat(61)}`,authMode:'scoped-api-key',
    apiKey:'read-only-key',apiScopes:['submissions:read']});
  store.createProfile({id:'unconfigured',origin:http.origin,audience:'marketplace',accountId,agentId,identityId,
    controllerNetwork:'ATTO',controllerAddress:`atto://${'a'.repeat(61)}`,authMode:'scoped-api-key',
    apiKey:'file-write-key',apiScopes:['files:write']});
  const client = await connect(home,'agent',filesDirectory);

  try {
    const catalog = await client.listTools();
    assert.ok(catalog.tools.some(tool => tool.name === 'marketplace_submission_file_upload'));
    assert.ok(catalog.tools.some(tool => tool.name === 'marketplace_submission_file_download'));

    // No-file submissions retain the old body and do not cause any implicit upload.
    const noFile = await client.callTool({name:'marketplace_submission_add',arguments:{taskId,
      requestId:'99999999-9999-4999-8999-999999999991',expectedEngagementVersion:4,text:'Text only delivery',urls:[]}});
    assert.equal(noFile.isError,undefined);
    const noFileRequest = requests.find(request => request.method === 'POST' && request.path.endsWith('/submissions'));
    assert.deepEqual(noFileRequest.body,{expectedEngagementVersion:4,text:'Text only delivery',urls:[]});
    assert.equal(requests.some(request => request.path === '/v1/agent/files/uploads'),false);

    // Explicit upload transfers the selected bytes, then returns a READY file that remains unattached.
    const uploaded = await client.callTool({name:'marketplace_submission_file_upload',arguments:{sourcePath:'source.txt',
      requestId:'99999999-9999-4999-8999-999999999992'}});
    assert.equal(uploaded.isError,undefined,contentText(uploaded));
    assert.equal(JSON.parse(contentText(uploaded)).result.file.fileId,fileId);
    assert.equal(JSON.parse(contentText(uploaded)).result.attached,false);
    assert.deepEqual(uploadedBytes,bytes);
    const uploadCreate = requests.find(request => request.method === 'POST' && request.path === '/v1/agent/files/uploads');
    assert.equal(uploadCreate.authorization,'Bearer private-file-scoped-key');
    assert.equal(uploadCreate.body.filename,'source.txt');
    assert.equal(uploadCreate.body.byteLength,bytes.length);
    assert.equal(uploadCreate.body.sha256,sha256);
    assert.ok(requests.some(request => request.method === 'PUT' && request.path.endsWith('/content')));
    assert.ok(requests.some(request => request.method === 'POST' && request.path.endsWith('/finalize')));

    // The worker attaches only the returned ID; MCP sends the selected ID as part of the immutable submission request.
    const submitted = await client.callTool({name:'marketplace_submission_add',arguments:{taskId,
      requestId:'99999999-9999-4999-8999-999999999993',expectedEngagementVersion:5,
      text:'Delivery with one explicit file',urls:[],fileIds:[fileId]}});
    assert.equal(submitted.isError,undefined);
    const fileSubmission = requests.filter(request => request.method === 'POST' && request.path.endsWith('/submissions')).at(-1);
    assert.deepEqual(fileSubmission.body,{expectedEngagementVersion:5,text:'Delivery with one explicit file',urls:[],fileIds:[fileId]});

    // Historical download uses the exact version manifest and publishes only after byte/hash verification.
    const download = await client.callTool({name:'marketplace_submission_file_download',arguments:{taskId,submissionVersion:2,fileId,
      destinationPath:'downloads/restored.txt'}});
    assert.equal(download.isError,undefined);
    assert.deepEqual(await readFile(join(filesDirectory,'downloads/restored.txt')),bytes);
    assert.equal(JSON.parse(contentText(download)).result.file.sha256,sha256);
    const contentRead = requests.find(request => request.method === 'GET' && request.path === `/v1/agent/files/${fileId}/content`);
    assert.equal(contentRead.authorization,'Bearer private-file-scoped-key');

    // Traversal, symlink sources, existing targets, and tampered bytes fail without publishing a file.
    const requestCount = requests.length;
    const traversal = await client.callTool({name:'marketplace_submission_file_download',arguments:{taskId,submissionVersion:2,fileId,
      destinationPath:'../escape.txt'}});
    assert.equal(traversal.isError,true);
    assert.equal(JSON.parse(contentText(traversal)).error.code,'FILES_PATH');
    const symlinkSource = await client.callTool({name:'marketplace_submission_file_upload',arguments:{sourcePath:sourceAlias,
      requestId:'99999999-9999-4999-8999-999999999994'}});
    assert.equal(symlinkSource.isError,true);
    assert.equal(JSON.parse(contentText(symlinkSource)).error.code,'FILES_PATH');
    const existingTarget = await client.callTool({name:'marketplace_submission_file_download',arguments:{taskId,submissionVersion:2,fileId,
      destinationPath:'source.txt'}});
    assert.equal(existingTarget.isError,true);
    assert.equal(JSON.parse(contentText(existingTarget)).error.code,'FILES_DESTINATION_EXISTS');
    const symlinkTarget = await client.callTool({name:'marketplace_submission_file_download',arguments:{taskId,submissionVersion:2,fileId,
      destinationPath:destinationAlias}});
    assert.equal(symlinkTarget.isError,true);
    assert.equal(JSON.parse(contentText(symlinkTarget)).error.code,'FILES_PATH');
    assert.equal(requests.length,requestCount);
    tamperDownload = true;
    const tampered = await client.callTool({name:'marketplace_submission_file_download',arguments:{taskId,submissionVersion:2,fileId,
      destinationPath:'downloads/tampered.txt'}});
    assert.equal(tampered.isError,true);
    assert.equal(JSON.parse(contentText(tampered)).error.code,'FILE_INTEGRITY');
    await assert.rejects(readFile(join(filesDirectory,'downloads/tampered.txt')),{code:'ENOENT'});

    const beforeDeniedUpload = requests.length;
    const limited = await connect(home,'limited',filesDirectory,true);
    try {
      const denied = await limited.callTool({name:'marketplace_submission_file_upload',arguments:{sourcePath:'source.txt',
        requestId:'99999999-9999-4999-8999-999999999995'}});
      assert.equal(denied.isError,true);
      assert.equal(JSON.parse(contentText(denied)).error.code,'SCOPE_REQUIRED');
      assert.equal(requests.length,beforeDeniedUpload);
    } finally { await limited.close(); }

    const unconfigured = await connect(home,'unconfigured');
    try {
      const beforeUnconfiguredUpload = requests.length;
      const denied = await unconfigured.callTool({name:'marketplace_submission_file_upload',arguments:{sourcePath:'source.txt',
        requestId:'99999999-9999-4999-8999-999999999996'}});
      assert.equal(denied.isError,true);
      assert.equal(JSON.parse(contentText(denied)).error.code,'FILES_DIRECTORY_REQUIRED');
      assert.equal(requests.length,beforeUnconfiguredUpload);
    } finally { await unconfigured.close(); }
  } finally {
    await client.close();
    await new Promise(resolve => http.close(resolve));
    store.close();
    await rm(root,{recursive:true,force:true});
  }
});

test('stdio upload resumes SCANNING after scanner outage and process restart with the same finalize key', async () => {
  // Given a file upload that entered scanning but whose first finalize response was a temporary outage.
  const root = await mkdtemp(join(tmpdir(), 'atto-marketplace-mcp-file-recovery-'));
  const home = join(root, 'profile');
  const filesDirectory = join(root, 'files');
  await mkdir(filesDirectory, {mode:0o700});
  await writeFile(join(filesDirectory, 'source.txt'), bytes, {mode:0o600});
  let uploadState = 'PENDING_UPLOAD';
  let intentCount = 0;
  let transferCount = 0;
  const finalizeKeys = [];
  const http = await listen(async (req,res) => {
    const body=req.method==='GET'?Buffer.alloc(0):await readBody(req);
    const parsedBody=body.length>0&&req.headers['content-type']?.includes('application/json')?JSON.parse(body.toString('utf8')):undefined;
    if(req.method==='POST'&&req.url==='/v1/agent/files/uploads') {
      intentCount+=1;
      assert.equal(parsedBody.filename,'source.txt');
      return json(res,201,{uploadId,state:'PENDING_UPLOAD',file:null});
    }
    if(req.method==='GET'&&req.url===`/v1/agent/files/uploads/${uploadId}`) {
      return json(res,200,{uploadId,state:uploadState,file:uploadState==='READY'?readyFile:null});
    }
    if(req.method==='PUT'&&req.url===`/v1/agent/files/uploads/${uploadId}/content`) {
      transferCount+=1;
      assert.deepEqual(body,bytes);
      uploadState='SCANNING';
      return json(res,200,{uploadId,state:'PENDING_UPLOAD',byteLength:bytes.length,sha256});
    }
    if(req.method==='POST'&&req.url===`/v1/agent/files/uploads/${uploadId}/finalize`) {
      finalizeKeys.push(req.headers['idempotency-key']);
      if(finalizeKeys.length===1) {
        uploadState='SCANNING';
        return json(res,503,{error:'scanner_unavailable',message:'Scanner temporarily unavailable'});
      }
      uploadState='READY';
      return json(res,200,{uploadId,state:'READY',file:readyFile});
    }
    return json(res,404,{error:'not_found'});
  });
  const store=await MarketplaceProfileStore.open(home);
  store.createProfile({id:'agent',origin:http.origin,audience:'marketplace',accountId,agentId,identityId,
    controllerNetwork:'ATTO',controllerAddress:`atto://${'a'.repeat(61)}`,authMode:'scoped-api-key',apiKey:'file-key',apiScopes:['files:write']});
  const requestId='99999999-9999-4999-8999-999999999881';
  let client=await connect(home,'agent',filesDirectory);
  try {
    const interrupted=await client.callTool({name:'marketplace_submission_file_upload',arguments:{sourcePath:'source.txt',requestId}});
    assert.equal(interrupted.isError,true);
    assert.match(contentText(interrupted),/HTTP 503/);
    await client.close();

    // When the MCP process restarts, retry the identical request and source path.
    client=await connect(home,'agent',filesDirectory);
    const recovered=await client.callTool({name:'marketplace_submission_file_upload',arguments:{sourcePath:'source.txt',requestId}});

    // Then the saved intent and original finalize key are reused, without another transfer.
    assert.equal(recovered.isError,undefined,contentText(recovered));
    assert.equal(JSON.parse(contentText(recovered)).result.file.fileId,fileId);
    assert.equal(intentCount,1);
    assert.equal(transferCount,1);
    assert.deepEqual(finalizeKeys,[requestId,requestId]);
  } finally {
    await client.close();
    await new Promise(resolve=>http.close(resolve));
    store.close();
    await rm(root,{recursive:true,force:true});
  }
});

test('every READY upload path verifies filename, byte length, and hash against the selected source', async () => {
  // Given each server READY boundary and one field at a time corrupted in its immutable response.
  const root=await mkdtemp(join(tmpdir(),'atto-marketplace-mcp-file-ready-integrity-'));
  const home=join(root,'profile');
  const filesDirectory=join(root,'files');
  await mkdir(filesDirectory,{mode:0o700});
  await writeFile(join(filesDirectory,'source.txt'),bytes,{mode:0o600});
  const cases=[
    ...['filename','byteLength','sha256'].map(field=>({path:'status',field})),
    ...['filename','byteLength','sha256'].map(field=>({path:'resume-finalize',field})),
    ...['filename','byteLength','sha256'].map(field=>({path:'finalize',field})),
    ...['filename','byteLength','sha256'].map(field=>({path:'poll',field})),
  ];
  let active;
  let activeIndex=-1;
  let activeStatusChecks=0;
  let nextId=0;
  const traces=cases.map(()=>[]);
  const ids=['55555555-5555-4555-8555-555555555551','55555555-5555-4555-8555-555555555552',
    '55555555-5555-4555-8555-555555555553','55555555-5555-4555-8555-555555555554',
    '55555555-5555-4555-8555-555555555555','55555555-5555-4555-8555-555555555556',
    '55555555-5555-4555-8555-555555555557','55555555-5555-4555-8555-555555555558',
    '55555555-5555-4555-8555-555555555559','55555555-5555-4555-8555-555555555560',
    '55555555-5555-4555-8555-555555555561','55555555-5555-4555-8555-555555555562'];
  const http=await listen(async(req,res)=>{
    const body=req.method==='GET'?Buffer.alloc(0):await readBody(req);
    if(req.method==='POST'&&req.url==='/v1/agent/files/uploads') {
      activeIndex=nextId;
      active=cases[activeIndex];
      activeStatusChecks=0;
      const id=ids[nextId++];
      traces[activeIndex].push(`${req.method} ${req.url}`);
      return json(res,201,{uploadId:id,state:'PENDING_UPLOAD',file:null});
    }
    const index=ids.findIndex(id=>req.url===`/v1/agent/files/uploads/${id}`
      ||req.url===`/v1/agent/files/uploads/${id}/content`
      ||req.url===`/v1/agent/files/uploads/${id}/finalize`);
    if(index<0) return json(res,404,{error:'not_found'});
    const id=ids[index];
    traces[activeIndex].push(`${req.method} ${req.url}`);
    const malformed={...readyFile};
    if(active.field==='filename') malformed.filename='other.txt';
    if(active.field==='byteLength') malformed.byteLength=bytes.length+1;
    if(active.field==='sha256') malformed.sha256='f'.repeat(64);
    if(req.method==='PUT') return json(res,200,{uploadId:id,state:'PENDING_UPLOAD',byteLength:bytes.length,sha256});
    if(req.method==='GET'&&req.url===`/v1/agent/files/uploads/${id}`) {
      if(active.path==='status') return json(res,200,{uploadId:id,state:'READY',file:malformed});
      if(active.path==='resume-finalize') return json(res,200,{uploadId:id,state:'SCANNING',file:null});
      if(active.path==='poll'&&activeStatusChecks++>0) return json(res,200,{uploadId:id,state:'READY',file:malformed});
      return json(res,200,{uploadId:id,state:'PENDING_UPLOAD',file:null});
    }
    if(req.method==='POST'&&req.url===`/v1/agent/files/uploads/${id}/finalize`) {
      return active.path==='poll'
        ?json(res,200,{uploadId:id,state:'SCANNING',file:null})
        :json(res,200,{uploadId:id,state:'READY',file:malformed});
    }
    return json(res,404,{error:'not_found'});
  });
  const store=await MarketplaceProfileStore.open(home);
  store.createProfile({id:'agent',origin:http.origin,audience:'marketplace',accountId,agentId,identityId,
    controllerNetwork:'ATTO',controllerAddress:`atto://${'a'.repeat(61)}`,authMode:'scoped-api-key',apiKey:'file-key',apiScopes:['files:write']});
  const client=await connect(home,'agent',filesDirectory);
  try {
    // When status, finalize, or polling returns a READY entry with any changed source field.
    for(let index=0;index<cases.length;index+=1) {
      const requestId=`99999999-9999-4999-8999-9999999998${String(index).padStart(2,'0')}`;
      const result=await client.callTool({name:'marketplace_submission_file_upload',arguments:{sourcePath:'source.txt',requestId}});
      assert.equal(result.isError,true,`${cases[index].path}/${cases[index].field}: ${contentText(result)}`);
      assert.equal(JSON.parse(contentText(result)).error.code,'FILE_INTEGRITY');
      const id=ids[index];
      const upload=`/v1/agent/files/uploads/${id}`;
      const expected=cases[index].path==='status'
        ?[`POST /v1/agent/files/uploads`,`GET ${upload}`]
        :cases[index].path==='resume-finalize'
          ?[`POST /v1/agent/files/uploads`,`GET ${upload}`,`POST ${upload}/finalize`]
          :cases[index].path==='finalize'
            ?[`POST /v1/agent/files/uploads`,`GET ${upload}`,`PUT ${upload}/content`,`POST ${upload}/finalize`]
            :[`POST /v1/agent/files/uploads`,`GET ${upload}`,`PUT ${upload}/content`,`POST ${upload}/finalize`,`GET ${upload}`];
      assert.deepEqual(traces[index],expected,`${cases[index].path}/${cases[index].field} request sequence`);
    }
  } finally {
    await client.close();
    await new Promise(resolve=>http.close(resolve));
    store.close();
    await rm(root,{recursive:true,force:true});
  }
});

async function connect(home,profile,filesDirectory,useEnvironment=false) {
  const client = new Client({name:'test-marketplace-private-files',version:'1.0.0'});
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key,value]) =>
    typeof value === 'string' && key !== 'NODE_TEST_CONTEXT' && !key.startsWith('NODE_TEST_')));
  const args=[serverMain,'--profile',profile,'--home',home];
  if (filesDirectory && useEnvironment) environment.MARKETPLACE_MCP_FILES_DIR=filesDirectory;
  else if (filesDirectory) args.push('--files-dir',filesDirectory);
  await client.connect(new StdioClientTransport({command:process.execPath,args,env:environment,stderr:'pipe'}));
  return client;
}

async function listen(handler) {
  const server = createServer((req,res) => { void Promise.resolve(handler(req,res)).catch(() => {if(!res.destroyed) json(res,500,{});}); });
  await new Promise((resolve,reject) => server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const address = server.address();
  return Object.assign(server,{origin:`http://127.0.0.1:${address.port}`});
}

async function readBody(req) {
  const chunks=[];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function json(res,status,body) {
  res.writeHead(status,{'content-type':'application/json'});
  res.end(JSON.stringify(body));
}

function contentText(result) {
  return result.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? '';
}

test('selected submission sources retain POSIX owner-readonly file and directory compatibility', {skip:process.platform === 'win32'}, async () => {
  // Given one explicitly selected source beneath an owner-only read-execute directory.
  const root = await mkdtemp(join(tmpdir(), 'atto-submission-mode-compatibility-'));
  const source = join(root,'source.txt');
  await writeFile(source,bytes,{mode:0o400});
  await chmod(source,0o400);
  await chmod(root,0o500);
  try {
    // When the ordinary bounded source reader opens those original private modes.
    const selected = readLocalSource(root,'source.txt');
    // Then exact contents and identity are returned without changing either mode.
    assert.deepEqual(selected.bytes,bytes);
    assert.equal(selected.sha256,sha256);
    assert.equal((await stat(root)).mode & 0o777,0o500);
    assert.equal((await stat(source)).mode & 0o777,0o400);
  } finally { await chmod(root,0o700); await rm(root,{recursive:true,force:true}); }
});
