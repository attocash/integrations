// Launch against an isolated running Marketplace API and local chain. See docs/marketplace-mcp-reference.md.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { MarketplaceProfileStore } from '../dist/profile-store.js';

const config = JSON.parse(await readFile(process.argv[2],'utf8'));
function localOrigin(raw) {
  const url = new URL(raw);
  assert.ok(['http:','https:'].includes(url.protocol) && ['127.0.0.1','localhost','[::1]'].includes(url.hostname) &&
    !url.username && !url.password && url.href === url.origin + '/', 'Use the origin of an isolated loopback fixture.');
  return url.origin;
}
const origin = localOrigin(config.origin);
const settlement = config.settlementOrigin && localOrigin(config.settlementOrigin);
const asset = config.asset ?? 'ATTO';
assert.ok(['ATTO','XNO'].includes(asset));
const root = await mkdtemp(join(tmpdir(),'real-service-mcp-'));
const clients = {};
const evidence = [];
const run = randomUUID().slice(0,8);
const fixed = {provider:'Provider',buyer:'Buyer',outsider:'Unrelated buyer'};
async function connect(role) {
  const actor = config[role];
  assert.ok(actor, 'Supply the isolated ' + role + ' actor.');
  const directory = join(root,role);
  const files = join(directory,'files');
  await mkdir(files,{recursive:true,mode:0o700});
  const home = actor.home ?? join(directory,'profile');
  const profileId = actor.profileId ?? role;
  const store = await MarketplaceProfileStore.open(home);
  try {
    if (!actor.home) {
      assert.ok(actor.accountId && actor.agentId && actor.identityId && actor.address && actor.accessToken);
      store.createProfile({id:profileId,origin,audience:config.audience,accountId:actor.accountId,agentId:actor.agentId,
        identityId:actor.identityId,controllerNetwork:actor.controllerNetwork ?? 'ATTO',controllerAddress:actor.address,
        authMode:'controller-session',accessToken:actor.accessToken,accessExpiresAt:Date.now()+600_000,
        refreshToken:randomUUID(),refreshExpiresAt:Date.now()+1_200_000});
    }
    assert.equal(store.getProfile(profileId).origin,origin,'Actor profile must target this local fixture.');
  } finally { store.close(); }
  const client = new Client({name:'local-service-actor-' + role,version:'1'});
  clients[role] = client;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key,v])=>typeof v==='string' &&
    !key.startsWith('NODE_TEST_') && !key.startsWith('MARKETPLACE_MCP_')));
  await client.connect(new StdioClientTransport({command:process.execPath,args:[join(import.meta.dirname,'../dist/main.js'),
    '--profile',profileId,'--home',home,'--files-dir',files],env,stderr:'pipe'}));
}
async function call(role,tool,args={},failure=false) {
  const res = await clients[role].callTool({name:'marketplace_' + tool,arguments:args});
  if (failure) {
    assert.equal(res.isError,true,`${role} unexpectedly succeeded: ${tool}`);
    return res.structuredContent.error;
  }
  assert.equal(res.isError,undefined,`${role} ${tool}: ${JSON.stringify(res.structuredContent.error)}`);
  return res.structuredContent.result;
}
const mutate = (role,tool,args,failure=false) => call(role,tool,{...args,requestId:randomUUID()},failure);
async function until(read,ready,label) {
  let last;
  const end = Date.now()+90_000;
  do {
    last = await read();
    if (ready(last)) return last;
    await delay(250);
  } while (Date.now()<end);
  throw new Error('Timed out waiting for ' + label + ', last status: ' + (last?.status ?? last?.order?.status));
}
async function pay(role,paymentId,purpose,amountAtomic,sourceReference) {
  const get = () => call(role,'payment_get',{paymentId});
  const p = await get();
  assert.equal(p.purpose,purpose);assert.equal(p.amountAtomic,amountAtomic);assert.equal(p.sourceReference,sourceReference);
  assert.equal(p.asset,asset);assert.equal(p.id,paymentId);
  assert.ok(p.network==='atto:local' || p.network==='nano:dev','Service exercise requires a private local chain.');
  let transactionHash;
  if (settlement) {
    const headers = {'content-type':'application/json'};
    if (config.settlementToken) headers.authorization = 'Bearer ' + config.settlementToken;
    const sent = await fetch(settlement + '/send',{method:'POST',headers,
      body:JSON.stringify({paymentId,network:p.network,senderAddress:p.senderAddress,recipientAddress:p.recipientAddress,amountAtomic}),
      redirect:'error',signal:AbortSignal.timeout(15_000)});
    assert.equal(sent.status,200,'Local chain could not send payment.');
    ({transactionHash} = await sent.json());
    assert.match(transactionHash,/^[a-fA-F0-9]{64}$/);
    const args = {paymentId,requestId:randomUUID(),transactionHash};
    await call(role,'payment_evidence',args);
    await call(role,'payment_evidence',args);
  } else {
    await call(role,'payment_pay',{paymentId});
    await call(role,'payment_pay',{paymentId});
  }
  const verified = await until(get,r=>r.status==='VERIFIED',purpose + ' verification');
  if (transactionHash) assert.equal(verified.verifiedPayment.transactionHash.toLowerCase(),transactionHash.toLowerCase());
  return {id:paymentId,purpose,amountAtomic,hash:verified.verifiedPayment.transactionHash};
}
async function exercise(prices) {
  const paymentEvidence=[];
  const list = await mutate('provider','service_publish',{title:`Local editing ${run} (${prices.length})`,
    description:'Proofread the supplied sections.',asset,briefTemplate:'Which sections should I edit?'});
  const listingId = list.id;
  const catalog = await call('buyer','services_search',{limit:100});
  assert.ok(catalog.items.some(x=>x.id===listingId));
  assert.equal((await call('buyer','service_get',{listingId})).title,list.title);
  const brief = 'Edit sections for local exercise ' + run;
  const {id:serviceRequestId} = await mutate('buyer','service_request_create',{listingId,brief});
  const ref = {serviceRequestId}, get = () => call('buyer','service_request_get',ref);
  const inbox = () => call('provider','service_requests_list',{role:'provider',limit:100});
  const visible = (await inbox()).items.find(r=>r.id===serviceRequestId);
  assert.equal(visible?.latestMessageCursor,1);
  for (const tool of ['service_request_get','service_messages_list']) {
    const error = await call('outsider',tool,ref,true);
    assert.ok([403,404].includes(error.httpStatus));
  }
  assert.equal((await call('provider','service_messages_list',ref)).messages[0].text,brief);
  await mutate('provider','service_message_add',{...ref,text:'Deliver each section in order.'});
  const milestones = prices.map((amountAtomic,i)=>({amountAtomic,deliverable:'Section ' + (i+1),acceptanceCriteria:'Every paragraph proofread.'}));
  await mutate('provider','service_quote_set',{...ref,expectedQuoteVersion:0,milestones:[{...milestones[0],amountAtomic:'1000'}]});
  const quote = await mutate('provider','service_quote_set',{...ref,expectedQuoteVersion:1,milestones});
  assert.equal(quote.quote.version,2);
  assert.equal((await mutate('buyer','service_quote_accept',{...ref,quoteVersion:1},true)).httpStatus,409);
  const accepted = await mutate('buyer','service_quote_accept',{...ref,quoteVersion:2});
  const fee = await call('provider','publication_fee_get',{feeId:accepted.order.feeId});
  assert.equal(fee.basisAtomic,prices.reduce((s,n)=>s+BigInt(n),0n).toString());
  const rate = asset==='ATTO' ? 10n : 500n;
  assert.equal(fee.feeAtomic,(BigInt(fee.basisAtomic)*rate/10000n).toString());
  paymentEvidence.push(await pay('provider',fee.paymentRequirementId,'PUBLICATION_FEE',fee.feeAtomic,fee.id));
  await until(get,r=>r.order.status==='ACTIVE','service fee activation');

  const submittedFile = 'Edited text ' + run;
  const filename = 'edit-' + prices.length + '.txt';
  await writeFile(join(root,'provider','files',filename),submittedFile,{mode:0o600});
  const upload = await mutate('provider','submission_file_upload',{sourcePath:filename});
  let completed = 0n;
  for (let i=0; i<prices.length; i++) {
    const position=i+1, milestone={...ref,position};
    const args={...milestone,requestId:randomUUID()};
    const funding = await call('buyer','service_milestone_fund',args);
    const paymentId = funding.order.milestones[i].paymentRequirementId;
    assert.ok(paymentId);
    assert.equal((await call('buyer','service_milestone_fund',args)).recovered,true);
    if (i+1<prices.length) {
      assert.equal((await call('buyer','service_milestone_fund',{...args,position:position+1},true)).code,'IDEMPOTENCY_CONFLICT');
      assert.equal((await mutate('buyer','service_milestone_fund',{...ref,position:position+1},true)).httpStatus,409);
    }
    paymentEvidence.push(await pay('buyer',paymentId,'SERVICE_MILESTONE',prices[i],serviceRequestId + ':' + position));
    await until(get,r=>r.order.milestones[i].status==='FUNDED','milestone funding');

    if (prices.length>1 && position===2) {
      const stopped = await mutate('buyer','service_request_stop',ref);
      assert.equal(stopped.order.status,'STOPPING');assert.equal(stopped.order.milestones[i+1].status,'CANCELLED');
      const refund = await mutate('provider','service_milestone_refund',milestone);
      paymentEvidence.push(await pay('provider',refund.order.milestones[i].refundPaymentRequirementId,'BUYER_REFUND',
        prices[i],'service-refund:' + serviceRequestId + ':' + position));
      break;
    }
    const submission={...milestone,urls:['https://example.org/edited']};
    const sent = await mutate('provider','service_milestone_submit',submission);
    const firstId=sent.order.milestones[i].submission.id;
    await mutate('buyer','service_message_add',{...ref,text:'Please correct the citation.'});
    const active = (await inbox()).items.find(r=>r.id===serviceRequestId);
    assert.ok(active.latestMessageCursor>visible.latestMessageCursor && Date.parse(active.updatedAt)>=Date.parse(visible.updatedAt));
    const revised=await mutate('provider','service_milestone_submit',{...milestone,fileIds:[upload.file.fileId]});
    const submissionId=revised.order.milestones[i].submission.id;
    assert.notEqual(firstId,submissionId);
    assert.equal((await mutate('buyer','service_milestone_approve',{...milestone,submissionId:firstId},true)).httpStatus,409);
    const download={...milestone,submissionId,fileId:upload.file.fileId,destinationPath:'received-' + prices.length + '-' + position + '.txt'};
    assert.ok([403,404].includes((await call('outsider','service_submission_file_download',download,true)).httpStatus));
    const saved=await call('buyer','service_submission_file_download',download);
    assert.equal(await readFile(saved.savedAs,'utf8'),submittedFile);
    await mutate('buyer','service_milestone_approve',{...milestone,submissionId});
    completed+=BigInt(prices[i]);
  }
  const closed=await until(get,r=>r.order.status==='CLOSED','permanent close');
  assert.equal(closed.order.earnedAtomic,(completed*rate/10000n).toString());
  assert.equal(closed.order.refundAtomic,(BigInt(fee.feeAtomic)-BigInt(closed.order.earnedAtomic)).toString());
  await mutate('provider','service_close',{listingId});
  const declined=await mutate('buyer','service_request_create',{listingId,brief:'Late request'},true);
  assert.ok([404,409].includes(declined.httpStatus));
  evidence.push({serviceRequestId,amounts:prices,order:closed.order.status,milestones:closed.order.milestones.map(m=>m.status),
    feeAtomic:fee.feeAtomic,earnedAtomic:closed.order.earnedAtomic,refundAtomic:closed.order.refundAtomic,payments:paymentEvidence});
}

try {
  for (const role of Object.keys(fixed)) await connect(role);
  for (const amounts of [['10000'],['2000','5000','9000']]) await exercise(amounts);
  console.log(JSON.stringify({status:'passed',asset,paymentMode:settlement?'external-send-evidence':'local-wallet',journeys:evidence},null,2));
} finally {
  await Promise.allSettled(Object.values(clients).map(c=>c.close()));
  await rm(root,{recursive:true,force:true});
}
