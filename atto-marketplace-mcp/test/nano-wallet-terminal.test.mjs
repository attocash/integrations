import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { inspectNanoSeed, provisionNanoWallet, verifyNanoMessage } from '@attocash/atto-marketplace-nano-adapter';

const execute=promisify(execFile);
const packageDirectory=process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR??join(import.meta.dirname,'..');
const cliDirectory=process.env.ATTO_TEST_CLI_PACKAGE_DIR??fileURLToPath(new URL('../',import.meta.resolve('@attocash/cli/core')));
const cliModuleUrl=name=>pathToFileURL(join(cliDirectory,'dist',name)).href;
const main=join(packageDirectory,'dist/main.js');
const moduleUrl=name=>pathToFileURL(join(packageDirectory,'dist',name)).href;
const {MarketplaceProfileStore}=await import(moduleUrl('profile-store.js'));
const {readWalletSelection,saveWalletSelection}=await import(moduleUrl('wallet-preferences.js'));
const tty=join(import.meta.dirname,'support/run-terminal.py');
async function terminal(args,environment,response='APPROVE',command) {
  const result=await execute('python3',[tty,JSON.stringify({command:command??[process.execPath,main,...(args[0]==='approve'?args:['wallet',...args])],environment,
    prompt:'Type APPROVE to confirm: ',response,timeoutSeconds:30})],{timeout:35000,maxBuffer:1048576});
  const metadata=JSON.parse(result.stdout);
  assert.equal(metadata.timedOut,false);
  return {...metadata,transcript:Buffer.from(metadata.transcriptBase64,'base64').toString('utf8').replaceAll('\r','')};
}
for (const { name, network, rpcOption, rpcUrl, workUrl, production } of [
  { name: 'production mainnet uses signed-in Marketplace work with Nano.to chain RPC', production:true, network: 'nano:mainnet', rpcOption: [], rpcUrl: 'https://rpc.nano.to' },
  { name: 'development omitted RPC uses loopback', network: 'nano:dev', rpcOption: [], rpcUrl: 'http://localhost:17076' },
  { name: 'mainnet explicit RPC keeps the custom provider', network: 'nano:mainnet', rpcOption: ['--rpc-url', 'https://nano.example/rpc'], rpcUrl: 'https://nano.example/rpc' },
  { name: 'mainnet separate work URL keeps the RPC default', network: 'nano:mainnet', rpcOption: [], rpcUrl: 'https://rpc.nano.to', workUrl: 'https://work.nano.example/generate' },
]) {
  test(`Nano terminal setup ${name} in its preview and saved profile`, {skip:process.platform==='win32'}, async t=>{
    // Given an offline private seed import and no existing Nano profile.
    const home=await mkdtemp(join(tmpdir(),'marketplace-nano-rpc-default-'));
    t.after(()=>rm(home,{recursive:true,force:true}));await chmod(home,0o700);
    const seedFile=join(home,'import.hex'),seed='42'.repeat(32)+'\n';
    await writeFile(seedFile,seed,{mode:0o600});
    const expected=await inspectNanoSeed(seedFile,1);
    const args=['setup','--asset','XNO','--network',network,...rpcOption,...(workUrl?['--work-url',workUrl]:[]),
      '--origin',production?'https://api.atto.market':'http://localhost:8080',
      '--audience',production?'urn:marketplace:agent-api:live':'terminal-rpc-test','--seed-file',seedFile];
    // When the user approves setup through the real terminal without contacting the RPC.
    const result=await terminal(args,{MARKETPLACE_MCP_HOME:home});
    // Then the reviewed provider and imported identity are persisted without exposing the seed.
    assert.equal(result.exitCode,0);assert.equal(result.promptAnswered,true);
    const rpcOffset=result.transcript.indexOf(`RPC: ${rpcUrl}\n`);
    assert.ok(rpcOffset>=0);assert.ok(rpcOffset<result.transcript.indexOf('Type APPROVE to confirm: '));
    const workOffset=result.transcript.indexOf(`Work: ${workUrl??rpcUrl}\n`);
    assert.ok(workOffset>=0);assert.ok(workOffset<result.transcript.indexOf('Type APPROVE to confirm: '));
    assert.equal(result.transcript.includes('Work when signed in: https://api.atto.market/v1/agent/wallets/xno/work'), Boolean(production));
    const config=JSON.parse(await readFile(join(home,'wallets','nano','wallet.json'),'utf8'));
    assert.equal(config.network,network);assert.equal(config.rpcUrl,rpcUrl);
    assert.equal(config.workUrl,workUrl);assert.equal(Object.hasOwn(config,'workUrl'),workUrl!==undefined);
    assert.equal(config.sourceAddress,expected.address);assert.equal(config.keySource.seedFile,seedFile);
    assert.equal(await readFile(seedFile,'utf8'),seed);assert.equal(result.transcript.includes(seed.trim()),false);
  });
}

for (const network of ['nano:mainnet','nano:dev']) {
  test(`Nano terminal setup without RPC or work URL reuses the existing custom ${network} providers and journal`, {skip:process.platform==='win32'}, async t=>{
    // Given an existing profile pinned to custom RPC and work providers and its retained native journal.
    const home=await mkdtemp(join(tmpdir(),'marketplace-nano-rpc-reuse-'));
    t.after(()=>rm(home,{recursive:true,force:true}));await chmod(home,0o700);
    const directory=join(home,'wallets','nano'),seedFile=join(home,'import.hex'),seed='42'.repeat(32)+'\n';
    await writeFile(seedFile,seed,{mode:0o600});
    const rpcUrl='https://nano.example/custom-rpc',workUrl='https://work.nano.example/existing',origin='http://localhost:8080',audience='terminal-rpc-reuse';
    await provisionNanoWallet({seedFile,dataDir:directory,derivationIndex:7,network,rpcUrl,workUrl,origin,audience,
      terminalConfirmed:true});
    const configPath=join(directory,'wallet.json'),before=await readFile(configPath);
    const journalPath=join(directory,'nano-wallet.sqlite3'),journal='retained original native journal bytes';
    await writeFile(journalPath,journal,{mode:0o600});
    // When setup is approved again with the RPC and work URL options omitted.
    const result=await terminal(['setup','--asset','XNO','--network',network,'--origin',origin,'--audience',audience],
      {MARKETPLACE_MCP_HOME:home});
    // Then consent shows the existing provider and preserves the exact profile, identity, seed and journal.
    assert.equal(result.exitCode,0);assert.equal(result.promptAnswered,true);
    const rpcOffset=result.transcript.indexOf(`RPC: ${rpcUrl}\n`);
    assert.ok(rpcOffset>=0);assert.ok(rpcOffset<result.transcript.indexOf('Type APPROVE to confirm: '));
    const workOffset=result.transcript.indexOf(`Work: ${workUrl}\n`);
    assert.ok(workOffset>=0);assert.ok(workOffset<result.transcript.indexOf('Type APPROVE to confirm: '));
    assert.deepEqual(await readFile(configPath),before);
    assert.equal(await readFile(journalPath,'utf8'),journal);
    assert.equal(await readFile(seedFile,'utf8'),seed);
    assert.equal(result.transcript.includes(seed.trim()),false);
  });
}

test('Nano terminal setup rejects invalid work URLs without publishing a profile', {skip:process.platform==='win32'}, async t=>{
  for(const workUrl of ['not-a-url','http://work.nano.example','https://user:secret@work.nano.example']) {
    // Given an offline private seed import with an invalid work endpoint.
    const home=await mkdtemp(join(tmpdir(),'marketplace-nano-invalid-work-'));
    t.after(()=>rm(home,{recursive:true,force:true}));await chmod(home,0o700);
    const seedFile=join(home,'import.hex'),seed='42'.repeat(32)+'\n';
    await writeFile(seedFile,seed,{mode:0o600});
    // When the user runs setup with that explicit work URL.
    const result=await terminal(['setup','--asset','XNO','--network','nano:mainnet','--work-url',workUrl,
      '--origin','http://localhost:8080','--audience','invalid-work-test','--seed-file',seedFile],{MARKETPLACE_MCP_HOME:home});
    // Then setup fails without a new profile, handoffs, or altered seed.
    assert.notEqual(result.exitCode,0);
    await assert.rejects(stat(join(home,'wallets','nano','wallet.json')),{code:'ENOENT'});
    await assert.rejects(stat(join(home,'payment-handoffs')),{code:'ENOENT'});
    assert.equal(await readFile(seedFile,'utf8'),seed);
    assert.equal(result.transcript.includes(seed.trim()),false);
  }
});

test('Nano seed import, separate transfer policy and profile-pinned credential proof approval use the real terminal', {skip:process.platform==='win32'},async t=>{
  const home=await mkdtemp(join(tmpdir(),'marketplace-nano-terminal-'));
  t.after(()=>rm(home,{recursive:true,force:true}));await chmod(home,0o700);
  const env={MARKETPLACE_MCP_HOME:home};
  const seedFile=join(home,'import.hex');await writeFile(seedFile,'42'.repeat(32)+'\n',{mode:0o600});
  const setup=['setup','--asset','XNO','--network','nano:dev','--rpc-url','http://localhost:17076',
    '--origin','http://localhost:8080','--audience','terminal-test','--seed-file',seedFile,
    '--max-payment-atomic','1000','--rolling-24h-atomic','2000'];
  const created=await terminal(setup,env);assert.equal(created.exitCode,0);assert.equal(created.promptAnswered,true);
  const wallet=join(home,'wallets/nano'),configPath=join(wallet,'wallet.json');
  const before=JSON.parse(await readFile(configPath,'utf8'));
  assert.equal(before.grants.externalTransfers,false);
  const seed=await readFile(before.keySource.seedFile,'utf8');assert.ok(!created.transcript.includes(seed.trim()));
  const policy=['policy','--asset','XNO','--allow-external-transfers',
    '--max-payment-atomic','1500','--rolling-24h-atomic','3000'];
  await assert.rejects(execute(process.execPath,[main,'wallet',...policy],{env:{...process.env,...env}}),error=>/interactive local terminal/.test(error.stderr));
  const approved=await terminal(policy,env);assert.equal(approved.exitCode,0);
  const after=JSON.parse(await readFile(configPath,'utf8'));assert.equal(after.grants.externalTransfers,true);
  assert.equal(after.keySource.seedFile,before.keySource.seedFile);assert.equal(after.sourceAddress,before.sourceAddress);
  assert.equal(await readFile(after.keySource.seedFile,'utf8'),seed);
  const accountId=randomUUID(),identityId=randomUUID(),targetApiKeyId=randomUUID(),idempotencyKey=randomUUID();
  const action={kind:'credential',operation:'REVOKE',command:{operation:'REVOKE',targetApiKeyId,idempotencyKey}};
  const challengeId=randomUUID(),issuedAt=new Date().toISOString(),expiresAt=new Date(Date.now()+240000).toISOString();
  const digest=createHash('sha256').update(['agent-credential-v1',accountId,identityId,'REVOKE',targetApiKeyId,idempotencyKey,''].join('\n')).digest('hex');
  const message=['Nano Marketplace Agent Controller Proof v1','Audience: terminal-test','Network: nano:dev',`Address: ${after.sourceAddress}`,
    'Purpose: API-key revocation',`Request ID: ${challengeId}`,`Binding Hash: ${digest}`,`Nonce: ${randomBytes(32).toString('hex')}`,
    `Issued At: ${issuedAt}`,`Expiration Time: ${expiresAt}`].join('\n');
  const handoffId=randomBytes(16).toString('hex');
  const directory=join(home,'approvals/agent');await mkdir(directory,{recursive:true,mode:0o700});await chmod(join(home,'approvals'),0o700);
  const path=join(directory,`${handoffId}.request.json`);
  const request={version:1,type:'marketplace-controller-approval-request',profileId:'agent',handoffId,marketplaceOrigin:'http://localhost:8080',
    transport:'AGENT_API',proofOrigin:null,audience:'terminal-test',accountId,identityId,controller:{network:'NANO',address:after.sourceAddress,index:after.derivationIndex},
    purpose:'API-key revocation',action,challenge:{challengeId,message,issuedAt,expiresAt}};
  await writeFile(path,JSON.stringify(request),{mode:0o600});
  const store=await MarketplaceProfileStore.open(home);
  try{
    store.createProfile({id:'agent',origin:request.marketplaceOrigin,audience:request.audience,accountId,agentId:randomUUID(),identityId,
      controllerNetwork:'NANO',controllerAddress:after.sourceAddress,controllerIndex:after.derivationIndex,
      authMode:'controller-session',accessToken:'terminal-fixture-token',accessExpiresAt:Date.now()+3600000});
    store.putHandoff('agent',handoffId,'CONTROLLER_APPROVAL','a'.repeat(64),'AWAITING_APPROVAL',JSON.stringify({request}),Date.now()+240000);
  }finally{store.close();}
  const consent=await terminal(['approve',path],env);assert.equal(consent.exitCode,0);assert.equal(consent.promptAnswered,true);
  const responsePath=path.replace('.request.json','.response.json'),bytes=await readFile(responsePath,'utf8'),response=JSON.parse(bytes);
  assert.equal(verifyNanoMessage({address:after.sourceAddress,message,signature:response.signature}),true);
  const retry=await terminal(['approve',path],env);assert.equal(retry.exitCode,0);assert.equal(retry.promptAnswered,false);
  assert.equal(await readFile(responsePath,'utf8'),bytes);
  await writeFile(path,JSON.stringify({...request,action:{...action,command:{...action.command,targetApiKeyId:randomUUID()}}}),{mode:0o600});
  const changed=await terminal(['approve',path],env);assert.notEqual(changed.exitCode,0);assert.equal(changed.promptAnswered,false);
});

async function restartedSelection(home) {
  const source=`import {managedWalletEnvironment} from ${JSON.stringify(moduleUrl('wallet-home.js'))}; process.stdout.write(JSON.stringify(managedWalletEnvironment(process.argv[1],{})));`;
  return JSON.parse((await execute(process.execPath,['--input-type=module','--eval',source,home],{timeout:10000})).stdout);
}

test('raw Nano import previews its address before consent and persists external wallet and handoff paths in a new home', {skip:process.platform==='win32'},async t=>{
  const root=await mkdtemp(join(tmpdir(),'marketplace-nano-import-paths-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const home=join(root,'new-home'),wallet=join(root,'external-wallet'),handoffs=join(root,'external-handoffs');
  const seedDirectory=join(root,'existing-seed');await mkdir(seedDirectory,{mode:0o700});
  const seedFile=join(seedDirectory,'seed.hex'),seed='ab'.repeat(32)+'\n';
  await writeFile(seedFile,seed,{mode:0o600});
  const expected=await inspectNanoSeed(seedFile,3);
  const environment={MARKETPLACE_MCP_HOME:home,MARKETPLACE_MCP_NANO_WALLET_DATA_DIR:wallet,
    MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR:wallet};
  const args=['setup','--asset','XNO','--network','nano:dev','--rpc-url','http://localhost:1',
    '--origin','http://localhost:8080','--audience','terminal-path-test','--index','3','--seed-file',seedFile];
  const cancelled=await terminal(args,environment,'NO');
  assert.notEqual(cancelled.exitCode,0);assert.equal(cancelled.promptAnswered,true);
  const addressOffset=cancelled.transcript.indexOf(`Imported Public Address: ${expected.address}`);
  assert.ok(addressOffset>=0);assert.ok(addressOffset<cancelled.transcript.indexOf('Type APPROVE to confirm: '));
  assert.equal(cancelled.transcript.includes(seed.trim()),false);
  for(const path of [home,wallet,handoffs])await assert.rejects(readdir(path),{code:'ENOENT'});
  const approved=await terminal(args,environment);
  assert.equal(approved.exitCode,0);assert.equal(approved.promptAnswered,true);
  assert.equal(approved.transcript.includes(seed.trim()),false);
  assert.equal((await stat(home)).mode&0o777,0o700);
  const config=JSON.parse(await readFile(join(wallet,'wallet.json'),'utf8'));
  assert.equal(config.sourceAddress,expected.address);assert.equal(config.keySource.seedFile,seedFile);
  assert.equal(await readFile(seedFile,'utf8'),seed);
  assert.deepEqual(readWalletSelection(home),{nanoDirectory:wallet});
  const restart=await restartedSelection(home);
  assert.equal(restart.MARKETPLACE_MCP_NANO_WALLET_DATA_DIR,wallet);
  assert.equal(restart.MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR,wallet);
});

test('explicit shared Nano controller clears a previously saved separate controller without changing either wallet', {skip:process.platform==='win32'},async t=>{
  const root=await mkdtemp(join(tmpdir(),'marketplace-nano-controller-selection-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const home=join(root,'home');await mkdir(home,{mode:0o700});
  const primary=join(root,'primary'),controller=join(root,'controller'),handoffs=join(root,'handoffs');
  const common={derivationIndex:1,network:'nano:dev',rpcUrl:'http://localhost:1',origin:'http://localhost:8080',audience:'terminal-controller-test',terminalConfirmed:true};
  const primarySeedFile=join(root,'primary.hex'),controllerSeedFile=join(root,'controller.hex');
  await writeFile(primarySeedFile,'42'.repeat(32)+'\n',{mode:0o600});
  await writeFile(controllerSeedFile,'43'.repeat(32)+'\n',{mode:0o600});
  await provisionNanoWallet({...common,seedFile:primarySeedFile,dataDir:primary});
  await provisionNanoWallet({...common,seedFile:controllerSeedFile,dataDir:controller});
  await saveWalletSelection(home,{nanoDirectory:primary,nanoControllerDirectory:controller});
  const primaryBefore=await readFile(join(primary,'wallet.json')),controllerBefore=await readFile(join(controller,'wallet.json'));
  const primarySeedPath=JSON.parse(primaryBefore).keySource.seedFile,controllerSeedPath=JSON.parse(controllerBefore).keySource.seedFile;
  const primarySeed=await readFile(primarySeedPath),controllerSeed=await readFile(controllerSeedPath);
  const journalPath=join(primary,'nano-wallet.sqlite3');await writeFile(journalPath,'retained native journal',{mode:0o600});
  const args=['setup','--asset','XNO','--network',common.network,'--rpc-url',common.rpcUrl,'--origin',common.origin,'--audience',common.audience];
  const environment={MARKETPLACE_MCP_HOME:home,MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR:primary};
  const cancelled=await terminal(args,environment,'NO');assert.notEqual(cancelled.exitCode,0);
  assert.equal(readWalletSelection(home).nanoControllerDirectory,controller);
  const approved=await terminal(args,environment);assert.equal(approved.exitCode,0);assert.equal(approved.promptAnswered,true);
  assert.deepEqual(readWalletSelection(home),{nanoDirectory:primary});
  const restart=await restartedSelection(home);
  assert.equal(restart.MARKETPLACE_MCP_NANO_WALLET_DATA_DIR,primary);assert.equal(restart.MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR,primary);
  assert.deepEqual(await readFile(join(primary,'wallet.json')),primaryBefore);assert.deepEqual(await readFile(join(controller,'wallet.json')),controllerBefore);
  assert.deepEqual(await readFile(primarySeedPath),primarySeed);assert.deepEqual(await readFile(controllerSeedPath),controllerSeed);
  assert.equal(await readFile(journalPath,'utf8'),'retained native journal');
});


test('Nano policy approval rejects a configuration changed during terminal consent', {skip:process.platform==='win32'},async t=>{
  // Given a private existing wallet whose original policy denies spending.
  const home=await mkdtemp(join(tmpdir(),'marketplace-policy-consent-'));
  t.after(()=>rm(home,{recursive:true,force:true}));await chmod(home,0o700);
  const directory=join(home,'wallets','nano');
  const seedFile=join(home,'policy.hex');await writeFile(seedFile,'42'.repeat(32)+'\n',{mode:0o600});
  await provisionNanoWallet({seedFile,dataDir:directory,derivationIndex:0,network:'nano:dev',rpcUrl:'http://localhost:17076',
    origin:'http://localhost:8080',audience:'policy-consent',terminalConfirmed:true});
  const path=join(directory,'wallet.json'),before=JSON.parse(await readFile(path,'utf8'));
  const source=`import {readFileSync,writeFileSync} from 'node:fs';
    import {runNanoTerminal} from ${JSON.stringify(moduleUrl('nano-terminal.js'))};
    const original=process.stderr.write.bind(process.stderr);let changed=false;
    process.stderr.write=(chunk,...rest)=>{if(!changed&&String(chunk).includes("Replace this wallet's approved policy")){
      changed=true;const config=JSON.parse(readFileSync(process.argv[1],'utf8'));config.origin='http://localhost:9999';
      writeFileSync(process.argv[1],JSON.stringify(config),{mode:0o600});}return original(chunk,...rest);};
    try{await runNanoTerminal(['policy','--asset','XNO','--allow-external-transfers','--max-payment-atomic','10','--rolling-24h-atomic','20'],process.env);}
    catch(error){process.stderr.write('Expected rejection: '+error.code+'\\n');process.exitCode=1;}`;
  // When the configuration changes after its preview, before the real terminal consent returns.
  const result=await terminal([],{MARKETPLACE_MCP_HOME:home},'APPROVE',
    [process.execPath,'--input-type=module','--eval',source,path]);
  // Then the new grants never apply to the unreviewed connection.
  assert.equal(result.exitCode,1);assert.equal(result.promptAnswered,true);
  assert.match(result.transcript,/WALLET_CONFIGURATION_CHANGED/);
  const after=JSON.parse(await readFile(path,'utf8'));
  assert.deepEqual(after,{...before,origin:'http://localhost:9999'});
});

test('explicit Nano Unlimited setup reviews future deposits and retains paired nulls on repeated setup', {skip:process.platform==='win32'}, async t=>{
  // Given a synthetic private seed and no selected Nano profile.
  const home=await mkdtemp(join(tmpdir(),'marketplace-nano-unlimited-terminal-'));t.after(()=>rm(home,{recursive:true,force:true}));await chmod(home,0o700);
  const seedFile=join(home,'seed.hex');await writeFile(seedFile,'56'.repeat(32)+'\n',{mode:0o600});
  const base=['setup','--asset','XNO','--network','nano:dev','--origin','http://localhost:8080','--audience','unlimited-terminal'];
  const environment={MARKETPLACE_MCP_HOME:home};
  // When the exact Unlimited transfer policy is approved through the real terminal.
  const created=await terminal([...base,'--seed-file',seedFile,'--allow-external-transfers','--unlimited'],environment);
  // Then the risk is explicit before consent and the persisted caps are actual paired nulls.
  assert.equal(created.exitCode,0);assert.match(created.transcript,/Unlimited: can spend the available wallet balance, including future deposits/);
  assert.ok(created.transcript.indexOf('future deposits')<created.transcript.indexOf('Type APPROVE to confirm:'));
  const path=join(home,'wallets','nano','wallet.json'),before=await readFile(path);
  const config=JSON.parse(before);assert.equal(config.grants.externalTransfers,true);assert.deepEqual(config.limits,{maxPaymentAtomic:null,rolling24hAtomic:null});
  const journal=join(home,'wallets','nano','nano-wallet.sqlite3');await writeFile(journal,'original retained journal',{mode:0o600});
  // When setup is repeated with cap and permission options omitted.
  const repeated=await terminal(base,environment);
  // Then explicit null caps, prior transfer authority, identity and journal remain exact.
  assert.equal(repeated.exitCode,0);assert.deepEqual(await readFile(path),before);assert.equal(await readFile(journal,'utf8'),'original retained journal');
});

test('Nano explicit policy Unlimited declines safely and rejects mixed cap flags', {skip:process.platform==='win32'}, async t=>{
  // Given an existing synthetic wallet with zero caps and denied transfers.
  const home=await mkdtemp(join(tmpdir(),'marketplace-nano-unlimited-policy-'));t.after(()=>rm(home,{recursive:true,force:true}));await chmod(home,0o700);
  const seedFile=join(home,'seed.hex');await writeFile(seedFile,'57'.repeat(32)+'\n',{mode:0o600});
  const directory=join(home,'wallets','nano');
  await provisionNanoWallet({dataDir:directory,seedFile,derivationIndex:1,network:'nano:dev',rpcUrl:'http://localhost:17076',origin:'http://localhost:8080',audience:'unlimited-policy',terminalConfirmed:true});
  const path=join(directory,'wallet.json'),before=await readFile(path),environment={MARKETPLACE_MCP_HOME:home};
  const policy=['policy','--asset','XNO','--allow-external-transfers','--unlimited'];
  // When Unlimited consent is declined or combined with a finite cap flag.
  const declined=await terminal(policy,environment,'NO');
  const mixed=await terminal([...policy,'--max-payment-atomic','1'],environment);
  // Then the original policy remains untouched and malformed terms never reach consent.
  assert.notEqual(declined.exitCode,0);assert.match(declined.transcript,/Unlimited: can spend the available wallet balance, including future deposits/);
  assert.notEqual(mixed.exitCode,0);assert.equal(mixed.promptAnswered,false);assert.deepEqual(await readFile(path),before);
  // When the same paired-null policy receives exact typed approval.
  const approved=await terminal(policy,environment);
  // Then Unlimited is explicitly enabled through the existing policy owner.
  assert.equal(approved.exitCode,0);const after=JSON.parse(await readFile(path,'utf8'));
  assert.equal(after.grants.externalTransfers,true);assert.deepEqual(after.limits,{maxPaymentAtomic:null,rolling24hAtomic:null});
});

for (const method of ['create','import']) test(`Nano ${method} recovery survives cancellation before the plan and explicit restart continuation`,{skip:process.platform==='win32'},async t=>{
  // Given an existing selected Nano wallet and its original journal, with a disposable OS-store stand-in.
  const home=await mkdtemp(join(tmpdir(),`marketplace-nano-prepared-${method}-`));t.after(()=>rm(home,{recursive:true,force:true}));await chmod(home,0o700);
  const directory=join(home,'wallets','nano'),seedFile=join(home,'original.hex');await writeFile(seedFile,'58'.repeat(32)+'\n',{mode:0o600});
  await provisionNanoWallet({dataDir:directory,seedFile,derivationIndex:7,network:'nano:dev',rpcUrl:'http://localhost:17076',origin:'http://localhost:8080',audience:'prepared-nano',terminalConfirmed:true});
  const originalConfig=await readFile(join(directory,'wallet.json')),journal=join(directory,'nano-wallet.sqlite3');
  await writeFile(journal,'original retained native journal',{mode:0o600});
  const phrase=`${'abandon '.repeat(23)}art`,secondPhrase=`${'zoo '.repeat(23)}vote`;
  const source=`
    import assert from 'node:assert/strict';
    import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    import {AttoApplication} from ${JSON.stringify(cliModuleUrl('application/app.js'))};
    import {OsSecretStore} from ${JSON.stringify(cliModuleUrl('storage/secrets.js'))};
    import {prepareNanoWalletInteractive,setupNanoWalletInteractive} from ${JSON.stringify(moduleUrl('nano-setup.js'))};
    import {terminalPrompt} from ${JSON.stringify(moduleUrl('terminal-input.js'))};
    const [home,phase,method]=process.argv.slice(1),phrase=phase==='new'?${JSON.stringify(secondPhrase)}:${JSON.stringify(phrase)};
    OsSecretStore.prototype.get=async function(){const path=join(home,'fixture-secret-'+this.account);return existsSync(path)?readFileSync(path,'utf8'):null;};
    OsSecretStore.prototype.set=async function(value){writeFileSync(join(home,'fixture-secret-'+this.account),value,{mode:0o600});appendFileSync(join(home,'fixture-store-operations'),'store\\n',{mode:0o600});};
    const create=AttoApplication.prototype.createWallet;
    AttoApplication.prototype.createWallet=function(mnemonic){return create.call(this,mnemonic??phrase);};
    const options={home,env:{MARKETPLACE_MCP_NANO_WALLET_DATA_DIR:join(home,'wallets','nano')},origin:'http://localhost:8080',audience:'prepared-nano',
      prompt:async question=>{
        if(question.startsWith('Nano wallet:')){
          process.stderr.write(question+'\\n');
          if(phase==='resume'||phase==='continue-wallet'){
            const label=phase==='resume'?'Continue prepared recovery':'Continue existing managed wallet';
            const match=new RegExp('\\\\[(\\\\d+)\\\\] '+label+' at ').exec(question);assert.ok(match,'Expected explicit continuation choice');return match[1];
          }
          return method==='create'?'2':'3';
        }
        if(question.startsWith('Nano access:')){
          if(phase==='cancel')throw Object.assign(new Error('Fixture cancellation after recovery storage'),{code:'CANCELLED'});
          return '1';
        }
        if(question.includes('Type APPROVE to confirm:'))return terminalPrompt(question);
        throw Error('Unexpected fixture prompt');
      }};
    if(phase==='cancel'){
      await assert.rejects(prepareNanoWalletInteractive(options),{code:'CANCELLED'});
      process.stdout.write('Cancelled after protected recovery; no plan returned.\\n');
    }else{
      const result=await setupNanoWalletInteractive(options);
      assert.equal(result.directory,join(home,'wallets',phase==='new'?'nano-new-2':'nano-new'));
      process.stdout.write('Prepared recovery continued through exact approval.\\n');
    }
  `;
  async function run(phase,steps){
    const command=[process.execPath,'--input-type=module','--eval',source,home,phase,method];
    const raw=await execute('python3',[tty,JSON.stringify({command,steps,timeoutSeconds:20})],{timeout:25000,maxBuffer:1048576});
    const metadata=JSON.parse(raw.stdout),transcript=Buffer.from(metadata.transcriptBase64,'base64').toString('utf8');
    assert.equal(metadata.timedOut,false);assert.equal(metadata.stepsAnswered,steps.length);
    assert.equal(metadata.exitCode,0,transcript.replaceAll(phrase,'[fixture recovery]').replaceAll(secondPhrase,'[fixture recovery]'));
    return transcript;
  }
  const storageSteps=fixturePhrase=>[{prompt:'Type yes to store this shared recovery phrase in the OS password store: ',response:'yes'},
    ...(method==='import'?[{prompt:'Recovery phrase (hidden): ',response:fixturePhrase,hidden:true}]:[])];
  // When recovery is stored and the user cancels at access selection before a plan can be persisted.
  await run('cancel',storageSteps(phrase));
  const preparedSource=join(home,'wallets','nano-recovery'),preparedState=await readFile(join(preparedSource,'state.sqlite'));
  await assert.rejects(stat(join(home,'wallets','nano-new','wallet.json')),{code:'ENOENT'});
  assert.equal((await readFile(join(home,'fixture-store-operations'),'utf8')).trim(),'store');
  // Then a fresh invocation explicitly offers continuation without another import or OS-store write.
  const resumed=await run('resume',[{prompt:'Type APPROVE to confirm: ',response:'APPROVE'}]);
  assert.match(resumed,/Continue prepared recovery at/);assert.equal(resumed.includes('Type yes to store'),false);
  const createdPath=join(home,'wallets','nano-new','wallet.json'),created=await readFile(createdPath),config=JSON.parse(created);
  assert.equal(config.keySource.recoverySource.directory,preparedSource);assert.deepEqual(await readFile(join(preparedSource,'state.sqlite')),preparedState);
  assert.equal((await readFile(join(home,'fixture-store-operations'),'utf8')).trim(),'store');
  // When another invocation explicitly continues the now configured managed wallet, then requests a genuinely new wallet.
  const continued=await run('continue-wallet',[{prompt:'Type APPROVE to confirm: ',response:'APPROVE'}]);
  assert.match(continued,/Continue existing managed wallet at/);assert.deepEqual(await readFile(createdPath),created);
  await run('new',[...storageSteps(secondPhrase),{prompt:'Type APPROVE to confirm: ',response:'APPROVE'}]);
  // Then new wallet/source paths and identity are distinct, while both earlier wallets and the original journal remain intact.
  const next=JSON.parse(await readFile(join(home,'wallets','nano-new-2','wallet.json'),'utf8'));
  assert.equal(next.keySource.recoverySource.directory,join(home,'wallets','nano-recovery-2'));
  assert.notEqual(next.sourceAddress,config.sourceAddress);assert.deepEqual(await readFile(createdPath),created);
  assert.deepEqual(await readFile(join(directory,'wallet.json')),originalConfig);assert.equal(await readFile(journal,'utf8'),'original retained native journal');
  assert.deepEqual((await readFile(join(home,'fixture-store-operations'),'utf8')).trim().split('\n'),['store','store']);
});
