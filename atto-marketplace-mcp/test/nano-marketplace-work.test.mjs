import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {Client, InMemoryTransport} from '@modelcontextprotocol/client';
import {addressFromPublicKey, addressPublicKey, upperHex, derivePrivateKey, NanoStateBlock, provisionNanoWallet, publicKey, ZERO_HASH} from '@attocash/atto-marketplace-nano-adapter';
import {NanoJournal} from '../../atto-marketplace-nano-adapter/dist/journal.js';
import {tmpdir} from '../../test/support/temporary-directory.mjs';
import {productionMarketplaceOrigin as origin, productionMarketplaceAudience as audience} from '../dist/defaults.js';
import {createMarketplaceMcpServer} from '../dist/server.js';
import {MarketplaceProfileStore} from '../dist/profile-store.js';
import {usesMarketplaceWork} from '../dist/nano-work.js';

const rpcUrl = 'https://rpc.nano.to';
const network = 'nano:mainnet';

test('only a production wallet on the default Nano.to RPC selects Marketplace work', () => {
  const config = {network, origin, audience, rpcUrl};
  assert.equal(usesMarketplaceWork(config), true);
  assert.equal(usesMarketplaceWork({...config, rpcUrl:rpcUrl + '/'}), true);
  for (const override of [{network:'nano:dev'}, {origin:'https://example.org'}, {audience:'test'},
    {rpcUrl:rpcUrl + '/custom'}, {rpcUrl:rpcUrl + '?key=custom'}, {rpcUrl:'https://rpc.example.org'},
    {workUrl:rpcUrl}, {workUrl:'https://work.example.org'}]) {
    assert.equal(usesMarketplaceWork({...config, ...override}), false);
  }
});

test('SEND, RECEIVE and OPEN route only work through the signed-in profile across the private stdio boundary', async t => {
  const home = await mkdtemp(join(tmpdir(), 'marketplace-work-'));
  const dataDir = join(home, 'wallets', 'nano'), seedFile = join(home, 'seed.hex');
  const seed = Buffer.alloc(32, 1), key = derivePrivateKey(seed, 1);
  const source = addressFromPublicKey(publicKey(key)), destination = addressFromPublicKey(publicKey(Buffer.alloc(32, 2)));
  const frontier = NanoStateBlock.signed(key, 'A'.repeat(64), source, 1000n, ZERO_HASH, '0'.repeat(16));
  const previous = NanoStateBlock.signed(Buffer.alloc(32,2), 'B'.repeat(64), destination, 500n, ZERO_HASH, '0'.repeat(16));
  const openRoot = upperHex(addressPublicKey(source));
  const incoming = NanoStateBlock.signed(Buffer.alloc(32,2), previous.hash, destination, 400n, openRoot, '0'.repeat(16));
  const evidence = block => ({contents:block.toWire(), block_account:block.account, confirmed:'true', subtype:'send'});
  await writeFile(seedFile, seed.toString('hex'), {mode:0o600});
  await provisionNanoWallet({dataDir, seedFile, derivationIndex:1, network, rpcUrl, origin, audience,
    grants:{externalTransfers:true}, limits:{maxPaymentAtomic:'100',rolling24hAtomic:'100'}, terminalConfirmed:true});
  const store = await MarketplaceProfileStore.open(home);
  t.after(async () => { store.close(); await rm(home, {recursive:true,force:true}); });
  const apiKey = 'private-test-scoped-api-key';
  store.createProfile({id:'named', origin, audience, authMode:'scoped-api-key', apiKey, apiScopes:['tasks:read'],
    accountId:randomUUID(), agentId:randomUUID(), identityId:randomUUID(), controllerNetwork:'NANO', controllerAddress:source});

  // Replace the chain's HTTPS responses only in the real private wallet child.
  const chainLog = join(home, 'requests.jsonl'), preload = join(home, 'offline-chain.mjs');
  const blockInfo = Object.fromEntries([frontier, previous, incoming].map(block => [block.hash,evidence(block)]));
  const unopened = join(home, 'unopened');
  const replies = {
    version:{network:'live',network_identifier:'991CF190094C00F0B68E2E5F75F6BEE95A2E0BD93CEAA4A6734DB9F19B728948'},
    account_info:{frontier:frontier.hash,confirmed_frontier:frontier.hash,balance:'1000',confirmed_balance:'1000',
      representative:source,confirmed_representative:source,account_version:'2'},
    blocks_info:{blocks:{[incoming.hash]:{...evidence(incoming),pending:'1'}}},
  };
  await writeFile(preload, `
    import {appendFileSync, existsSync} from 'node:fs';
    const replies = ${JSON.stringify(replies)};
    const blocks = ${JSON.stringify(blockInfo)};
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      appendFileSync(${JSON.stringify(chainLog)}, JSON.stringify({url:String(url), headers:init.headers, body}) + '\\n');
      if (body.action === 'account_info' && existsSync(${JSON.stringify(unopened)})) return Response.json({error:'Account not found'});
      if (body.action === 'block_info') return Response.json(blocks[body.hash] ?? {error:'Block not found'});
      return Response.json(replies[body.action] ?? {error:'unexpected action'});
    };
  `);
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    assert.ok(args.includes('--internal-wallet-host'));
    assert.ok(!JSON.stringify(options.env).includes(apiKey));
    return spawn(command, ['--import', pathToFileURL(preload).href, ...args], options);
  });
  const workCalls = [];
  let workStatus = 200;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(String(url), origin + '/v1/agent/wallets/xno/work');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.authorization, 'Bearer ' + apiKey);
    assert.equal(init.redirect, 'error');
    workCalls.push(JSON.parse(init.body));
    if (workStatus !== 200) return new Response('<html>private gateway diagnostic</html>', {status:workStatus});
    return Response.json({work:'0000000000000000'});
  });
  const server = createMarketplaceMcpServer({profiles:store,profileId:'named',env:{}});
  const client = new Client({name:'offline-work-test',version:'1'});
  const [clientTransport,serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {await client.close(); await server.close();});
  const requestId = randomUUID();
  const send = await client.callTool({name:'wallet_transfer', arguments:{asset:'XNO', network, destination,
    amountAtomic:'10', requestId}});
  const receiveArgs = {name:'wallet_receive',arguments:{asset:'XNO', network, hash:incoming.hash}};
  const receive = await client.callTool(receiveArgs);
  await writeFile(unopened, '');
  const open = await client.callTool(receiveArgs);
  assert.deepEqual(workCalls, [
    {hash:frontier.hash,difficulty:'FFFFFFF800000000'},
    {hash:frontier.hash,difficulty:'FFFFFFC000000000'},
    {hash:openRoot,difficulty:'FFFFFFC000000000'},
  ]);
  for (const result of [send, receive, open]) {
    assert.equal(result.structuredContent.error.code, 'NANO_WORK_INVALID');
    assert.ok(!JSON.stringify(result).includes(apiKey));
  }
  for (const [status,code] of [[429,'NANO_WORK_RATE_LIMITED'],[503,'NANO_WORK_UNAVAILABLE'],[401,'AUTHORIZATION_DENIED']]) {
    workStatus = status;
    const attempts = workCalls.length;
    const failed = await client.callTool(receiveArgs);
    assert.equal(workCalls.length, attempts+1, 'A work refusal must not trigger an automatic retry');
    assert.equal(failed.structuredContent.error.code,code);
    assert.equal(failed.structuredContent.error.httpStatus,status);
    assert.match(failed.structuredContent.error.message,/same request ID or incoming SEND hash/);
    assert.doesNotMatch(JSON.stringify(failed),/private gateway diagnostic|private-test-scoped-api-key/);
  }
  const journal = new NanoJournal(dataDir);
  try {
    assert.equal(journal.find('transfer:' + requestId), undefined);
    assert.equal(journal.find('receive:' + incoming.hash), undefined);
  } finally { journal.close(); }
  const chain = (await readFile(chainLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(new Set(chain.map(request => request.body.action)), new Set(['version','account_info','block_info','blocks_info']));
  for (const request of chain) {
    assert.equal(request.url, rpcUrl + '/');
    assert.equal(new Headers(request.headers).has('authorization'), false);
  }
});
