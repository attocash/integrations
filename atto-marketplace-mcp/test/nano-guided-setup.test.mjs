import { setPermissions } from './support/private-permissions.mjs';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { join } from 'node:path';
import test, {before,after} from 'node:test';
import { provisionNanoWallet, inspectNanoRecoveryWallet } from '@attocash/atto-marketplace-nano-adapter';
import {AttoApplication} from '../../atto-cli/dist/application/app.js';
import {OsSecretStore} from '../../atto-cli/dist/storage/secrets.js';
import { setupNanoWalletInteractive } from '../dist/nano-setup.js';
import {readWalletSelection,saveWalletSelection} from '../dist/wallet-preferences.js';

const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
let originalSecretGet;
before(() => {
  // Exercise setup and recovery with a local credential fixture on every OS.
  // A fake secret-tool alone would still reach the native macOS Keychain.
  originalSecretGet = OsSecretStore.prototype.get;
  OsSecretStore.prototype.get = async () => phrase;
});
after(() => { OsSecretStore.prototype.get = originalSecretGet; });
const origin = 'http://localhost:8080';
const audience = 'guided-nano-test';
const initialPurposes = ['link authorizer'];

async function homeFor(t) {
  const home = await mkdtemp(join(tmpdir(), 'nano-guided-setup-'));
  await chmod(home, 0o700);
  t.after(() => rm(home, { recursive: true, force: true }));
  const source=join(home,'wallets','atto');
  const wallet=new AttoApplication({directory:source,secrets:{get:async()=>phrase,set:async()=>{}}});
  try{await wallet.createWallet(phrase);}finally{await wallet.close();}
  await inspectNanoRecoveryWallet(source,0);
  return home;
}

async function snapshot(directory) {
  const entries = {};
  async function walk(path, relative = '') {
    for (const name of (await readdir(path)).sort()) {
      if (/^(state|lifecycle)\.sqlite-(wal|shm)$/.test(name)) continue;
      const child = join(path, name), key = relative ? `${relative}/${name}` : name, st = await lstat(child);
      entries[key] = { mode: st.mode & 0o777, size: st.isDirectory() ? null : st.size,
        content: st.isFile() ? (await readFile(child)).toString('base64') : null };
      if (st.isDirectory()) await walk(child, key);
    }
  }
  await walk(directory);
  return entries;
}

async function terminal(action) {
  const stdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stderr = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
  try { return await action(); }
  finally {
    if (stdin) Object.defineProperty(process.stdin, 'isTTY', stdin); else delete process.stdin.isTTY;
    if (stderr) Object.defineProperty(process.stderr, 'isTTY', stderr); else delete process.stderr.isTTY;
  }
}

function interaction(responses, check, workUrl = '') {
  const questions = [];
  return { questions, prompt: async question => {
    questions.push(question);
    await check?.(question);
    if(question.startsWith('Recovery wallet directory'))return '';
    if(question.startsWith('Nano work URL'))return workUrl;
    assert.ok(responses.length, `Unexpected prompt: ${question}`);
    return responses.shift();
  } };
}

async function existing(home, grants = { marketplaceFunding: true, externalTransfers: false, controllerPurposes: initialPurposes }, workUrl) {
  const directory = join(home, 'existing');
  const seedFile=join(home,'existing-seed.hex');
  await writeFile(seedFile,'42'.repeat(32)+'\n',{mode:0o600});
  await provisionNanoWallet({ seedFile, dataDir: directory, derivationIndex: 7, network: 'nano:dev', rpcUrl: 'http://localhost:17076', ...(workUrl ? { workUrl } : {}),
    origin, audience, handoffDirectory: join(home, 'handoffs'), grants,
    limits: { maxPaymentAtomic: '1000000000000000000000000000000', rolling24hAtomic: '10000000000000000000000000000000' }, terminalConfirmed: true });
  const config = JSON.parse(await readFile(join(directory, 'wallet.json'), 'utf8'));
  // A retained journal must not be opened, recreated, or edited by configuration setup.
  await writeFile(join(directory, 'nano-wallet.sqlite3'), 'retained native journal bytes', { mode: 0o600 });
  return { directory, config };
}

test('guided Nano setup enforces its local terminal before prompting or creating state', async t => {
  const home = await homeFor(t), before = await snapshot(home);
  const stdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  try {
    await assert.rejects(setupNanoWalletInteractive({ home, env: {}, origin, audience,
      prompt: async () => assert.fail('Nonterminal setup prompted') }), { code: 'TERMINAL_REQUIRED' });
  } finally {
    if (stdin) Object.defineProperty(process.stdin, 'isTTY', stdin); else delete process.stdin.isTTY;
  }
  assert.deepEqual(await snapshot(home), before);
});

test('cancelled Nano creation preserves all state and never displays recovery material', async t => terminal(async () => {
  const home = await homeFor(t);
  await writeFile(join(home, 'selection.json'), '{"nano":"retained"}', { mode: 0o600 });
  const before = await snapshot(home);
  const script = interaction(['', '', 'nano:dev', '', '', '', '', '', 'cancel'], async () => {
    assert.deepEqual(await snapshot(home), before, 'Setup changed files before final consent');
  });
  await assert.rejects(setupNanoWalletInteractive({ home, env: {}, origin, audience, prompt: script.prompt }), { code: 'APPROVAL_DECLINED' });
  assert.deepEqual(await snapshot(home), before);
  assert.match(script.questions.at(-1), /Marketplace funding: denied\nExternal transfers: denied/);
  assert.match(script.questions.at(-1), /Controller purposes: none/);
}));

test('dedicated Nano creation asks usable defaults and keeps funding and transfers denied', async t => terminal(async () => {
  const home = await homeFor(t);
  // Given a recovery wallet with no explicit Marketplace connection override.
  const responses = ['', '', 'nano:dev', '', '', '', '', '', 'APPROVE'];
  const script = interaction(responses);
  // When the user approves the production binding shown in the review.
  const result = await setupNanoWalletInteractive({ home, env: {}, prompt: script.prompt });
  // Then production is saved without prompting for origin or audience.
  assert.equal(result.directory, join(home, 'wallets', 'nano'));
  assert.equal(result.index, 0);
  assert.equal(result.network, 'nano:dev');
  const config = JSON.parse(await readFile(join(result.directory, 'wallet.json'), 'utf8'));
  assert.equal(result.address, config.sourceAddress);
  assert.deepEqual(config.grants, { marketplaceFunding: false, externalTransfers: false, controllerPurposes: [] });
  assert.deepEqual(config.limits, { maxPaymentAtomic: '0', rolling24hAtomic: '0' });
  assert.equal(config.origin, 'https://api.atto.market');
  assert.equal(config.audience, 'urn:marketplace:agent-api:live');
  assert.equal(script.questions.some(question => /^(Marketplace origin|Exact Marketplace Agent API audience)/.test(question)), false);
  assert.equal(config.version,1);
  assert.equal(config.keySource.recoverySource.directory,join(home,'wallets','atto'));
  assert.equal(config.keySource.derivationVersion,'bip39-ed25519-slip10-nano-v1');
  assert.equal(config.keySource.seedFile,undefined);
  await assert.rejects(lstat(join(result.directory,'seed.hex')),{code:'ENOENT'});
  assert.equal(script.questions.join('\n').includes(phrase),false);
  assert.match(script.questions.at(-1),/Recovery phrase: OS password store/);
  assert.equal(responses.length, 0);
}));

for (const { name, network, answer, rpcUrl } of [
  { name: 'mainnet blank RPC uses Nano.to', network: 'nano:mainnet', answer: '', rpcUrl: 'https://rpc.nano.to' },
  { name: 'development blank RPC uses loopback', network: 'nano:dev', answer: '', rpcUrl: 'http://localhost:17076' },
  { name: 'mainnet explicit RPC keeps the custom provider', network: 'nano:mainnet', answer: 'https://nano.example/rpc', rpcUrl: 'https://nano.example/rpc' },
]) {
  test(`guided Nano creation ${name} in its review and saved profile`, async t => terminal(async () => {
    // Given a private recovery wallet and no existing Nano profile.
    const home = await homeFor(t), before = await snapshot(home);
    const responses = ['', '', network, answer, '', '', '', '', 'APPROVE'];
    const script = interaction(responses, async question => {
      if (question.startsWith('Review Nano wallet setup:')) {
        assert.deepEqual(await snapshot(home), before, 'The reviewed profile must not exist before consent');
        assert.ok(question.includes(`Network: ${network}\nRPC: ${rpcUrl}\nWork: ${rpcUrl}\n`));
      }
    });
    // When the user reviews the resolved RPC and approves creation.
    const result = await setupNanoWalletInteractive({ home, env: {}, origin, audience, prompt: script.prompt });
    // Then the saved connection matches exactly the provider shown before approval.
    const config = JSON.parse(await readFile(join(result.directory, 'wallet.json'), 'utf8'));
    assert.equal(config.network, network);
    assert.equal(config.rpcUrl, rpcUrl);
    assert.equal(Object.hasOwn(config, 'workUrl'), false);
    assert.equal(config.sourceAddress, result.address);
    assert.equal(responses.length, 0);
    assert.ok(script.questions.at(-1).includes(`RPC: ${rpcUrl}\n`));
  }));
}

test('guided Nano creation reviews and persists a separate work provider', async t => terminal(async () => {
  // Given a private recovery wallet and a user-selected work endpoint.
  const home = await homeFor(t), before = await snapshot(home), workUrl = 'https://work.nano.example/generate';
  const script = interaction(['', '', 'nano:mainnet', '', '', '', '', '', 'APPROVE'], async question => {
    if (question.startsWith('Review Nano wallet setup:')) {
      assert.deepEqual(await snapshot(home), before);
      assert.ok(question.includes(`RPC: https://rpc.nano.to\nWork: ${workUrl}\n`));
    }
  }, workUrl);
  // When the user approves the reviewed RPC and separate work provider.
  const result = await setupNanoWalletInteractive({ home, env: {}, origin, audience, prompt: script.prompt });
  // Then the new profile keeps both choices separately.
  const config = JSON.parse(await readFile(join(result.directory, 'wallet.json'), 'utf8'));
  assert.equal(config.rpcUrl, 'https://rpc.nano.to');
  assert.equal(config.workUrl, workUrl);
}));

test('guided Nano creation rejects invalid work providers without publishing state', async t => terminal(async () => {
  for (const workUrl of ['not-a-url', 'http://work.nano.example', 'https://user:secret@work.nano.example']) {
    // Given a private recovery wallet and an invalid work URL.
    const home = await homeFor(t), before = await snapshot(home);
    const script = interaction(['', '', 'nano:mainnet', ''], undefined, workUrl);
    // When setup validates the separate work URL.
    await assert.rejects(setupNanoWalletInteractive({ home, env: {}, origin, audience, prompt: script.prompt }), { code: 'SETUP_USAGE' });
    // Then no profile or other local state has been published.
    assert.deepEqual(await snapshot(home), before);
  }
}));

test('human XNO ceilings use exact 30-place arithmetic and independent transfer consent', async t => terminal(async () => {
  const home = await homeFor(t);
  const script = interaction(['', '', 'nano:dev', '', '2147483647', 'no', 'yes',
    '0.000000000000000000000000000001', '1.234567890123456789012345678901', 'no', 'APPROVE']);
  const result = await setupNanoWalletInteractive({ home, env: {}, origin, audience, prompt: script.prompt });
  const config = JSON.parse(await readFile(join(result.directory, 'wallet.json'), 'utf8'));
  assert.deepEqual(config.grants, { marketplaceFunding: false, externalTransfers: true, controllerPurposes: [] });
  assert.equal(config.derivationIndex, 2147483647);
  assert.deepEqual(config.limits, { maxPaymentAtomic: '1', rolling24hAtomic: '1234567890123456789012345678901' });
  assert.match(script.questions.at(-1), /0\.000000000000000000000000000001 XNO \(1 raw\)/);
}));

test('invalid precision, ceiling order, and native overflow fail before creating directories', async t => terminal(async () => {
  for (const amounts of [
    ['0.0000000000000000000000000000001'],
    ['340282367'],
    ['2', '1'],
    ['1e-30'],
  ]) {
    const home = await homeFor(t), before = await snapshot(home);
    const script = interaction(['', '', 'nano:dev', '', '', 'yes', 'no', ...amounts]);
    await assert.rejects(setupNanoWalletInteractive({ home, env: {}, origin, audience, prompt: script.prompt }), { code: 'INVALID_AMOUNT' });
    assert.deepEqual(await snapshot(home), before);
  }
}));

test('selected existing Nano profile defaults to reuse and preserves policy, seed and journal byte for byte', async t => terminal(async () => {
  // Given an existing profile with a separate work provider and a retained native journal.
  const home = await homeFor(t), workUrl = 'https://work.nano.example/existing', { directory, config } = await existing(home, undefined, workUrl);
  const before = await snapshot(home);
  const script = interaction(['', '', '', '', 'APPROVE'], async () => {
    assert.deepEqual(await snapshot(home), before, 'Reuse preview changed existing state');
  });
  // When the user accepts reuse without replacing connection settings or policy.
  const result = await setupNanoWalletInteractive({ home, env: { MARKETPLACE_MCP_NANO_WALLET_DATA_DIR: directory },
    origin, audience, prompt: script.prompt });
  // Then the review retains its work provider and every existing byte remains unchanged.
  assert.match(script.questions[0], /\[reuse\]/);
  assert.ok(script.questions.at(-1).includes(`Work: ${workUrl}\n`));
  assert.deepEqual(result, { directory, address: config.sourceAddress, index: 7, network: 'nano:dev' });
  assert.deepEqual(await snapshot(home), before);
}));

test('explicit Nano policy replacement retains all unrelated purpose grants and immutable profile settings', async t => terminal(async () => {
  const home = await homeFor(t), { directory, config } = await existing(home);
  const seed = await readFile(config.keySource.seedFile), journal = await readFile(join(directory, 'nano-wallet.sqlite3'));
  const script = interaction(['reuse', directory, 'replace', 'no', 'yes', '0.5', '2.5', 'yes', 'APPROVE']);
  await setupNanoWalletInteractive({ home, env: {}, origin, audience, prompt: script.prompt });
  const after = JSON.parse(await readFile(join(directory, 'wallet.json'), 'utf8'));
  assert.deepEqual({ ...after, grants: config.grants, limits: config.limits }, config);
  assert.deepEqual(after.grants, { marketplaceFunding: false, externalTransfers: true, controllerPurposes: [...initialPurposes, 'login'] });
  assert.deepEqual(after.limits, { maxPaymentAtomic: '500000000000000000000000000000', rolling24hAtomic: '2500000000000000000000000000000' });
  assert.deepEqual(await readFile(config.keySource.seedFile), seed);
  assert.deepEqual(await readFile(join(directory, 'nano-wallet.sqlite3')), journal);
}));

test('adding login while keeping Nano transfer policy persists only the explicitly reviewed purpose', async t => terminal(async () => {
  const home = await homeFor(t), { directory, config } = await existing(home);
  const script = interaction(['reuse', directory, 'keep', 'yes', 'APPROVE']);
  await setupNanoWalletInteractive({ home, env: {}, origin, audience, prompt: script.prompt });
  const after = JSON.parse(await readFile(join(directory, 'wallet.json'), 'utf8'));
  assert.deepEqual(after, { ...config, grants: { ...config.grants, controllerPurposes: [...initialPurposes, 'login'] } });
}));

test('cancelled existing-profile policy changes preserve wallet, selection and native journal', async t => terminal(async () => {
  const home = await homeFor(t), { directory } = await existing(home);
  await writeFile(join(home, 'selection.json'), '{"nano":"retained"}', { mode: 0o600 });
  const before = await snapshot(home);
  const script = interaction(['reuse', directory, 'replace', 'no', 'yes', '1', '2', 'yes', 'NO'], async () => {
    assert.deepEqual(await snapshot(home), before);
  });
  await assert.rejects(setupNanoWalletInteractive({ home, env: {}, origin, audience, prompt: script.prompt }), { code: 'APPROVAL_DECLINED' });
  assert.deepEqual(await snapshot(home), before);
}));

test('existing Nano profile missing a seed or using another connection never falls back to generation', async t => terminal(async () => {
  const home = await homeFor(t), { directory, config } = await existing(home);
  await rm(config.keySource.seedFile);
  const before = await snapshot(home);
  const script = interaction(['', '']);
  await assert.rejects(setupNanoWalletInteractive({ home, env: { MARKETPLACE_MCP_NANO_WALLET_DATA_DIR: directory },
    origin, audience, prompt: script.prompt }), { code: 'PRIVATE_FILE' });
  assert.deepEqual(await snapshot(home), before);
  const second = await homeFor(t), wallet = await existing(second), prior = await snapshot(second);
  await assert.rejects(setupNanoWalletInteractive({ home: second, env: {}, origin: 'http://localhost:9999', audience,
    prompt: interaction(['reuse', wallet.directory]).prompt }), { code: 'WALLET_CONFIGURATION' });
  assert.deepEqual(await snapshot(second), prior);
}));

test('private standalone seed import reviews its public address and retains the original private file', async t => terminal(async () => {
  const home = await homeFor(t), seedDirectory = join(home, 'backup');
  await mkdir(seedDirectory, { mode: 0o700 });
  const seedFile = join(seedDirectory, 'seed.hex'), seed = `${'ab'.repeat(32)}\n`;
  await writeFile(seedFile, seed, { mode: 0o600 });
  const before = await snapshot(home);
  const script = interaction(['import', '', 'nano:dev', '', '2', seedFile, '', '', 'no', 'APPROVE'], async () => {
    assert.deepEqual(await snapshot(home), before);
  });
  const result = await setupNanoWalletInteractive({ home, env: {}, origin, audience, prompt: script.prompt });
  const config = JSON.parse(await readFile(join(result.directory, 'wallet.json'), 'utf8'));
  assert.equal(config.keySource.seedFile, seedFile);
  assert.equal(await readFile(seedFile, 'utf8'), seed);
  assert.match(script.questions.at(-1), new RegExp(`Address: ${result.address}`));
  assert.equal(script.questions.join('\n').includes(seed.trim()), false);
  await assert.rejects(lstat(join(result.directory, 'seed.hex')), { code: 'ENOENT' });
}));

test('managed, missing, permissive and symlink seed imports fail without new wallet state', async t => terminal(async () => {
  const home = await homeFor(t), { config } = await existing(home);
  const outside = join(home, 'standalone');
  await mkdir(outside, { mode: 0o700 });
  const permissive = join(outside,'public.hex');
  await writeFile(permissive, `${'cd'.repeat(32)}\n`, {mode:0o600});
  await setPermissions(permissive,0o644);
  const aliasDirectory = join(home,'seed-alias');
  const link = process.platform === 'win32' ? join(aliasDirectory,'public.hex') : join(outside,'link.hex');
  if (process.platform === 'win32') await symlink(outside,aliasDirectory,'junction');
  else await symlink(permissive,link);
  for (const seedFile of [config.keySource.seedFile, join(outside, 'missing.hex'), ...(process.platform === 'win32' ? [] : [permissive]), link]) {
    const before = await snapshot(home);
    const script = interaction(['import', '', 'nano:dev', '', '', seedFile]);
    await assert.rejects(setupNanoWalletInteractive({ home, env: {}, origin, audience, prompt: script.prompt }));
    assert.deepEqual(await snapshot(home), before);
  }
}));

test('an imported seed changed during approval cannot configure an unreviewed Nano identity', async t => terminal(async () => {
  const home = await homeFor(t), source = join(home, 'backup');
  await mkdir(source, { mode: 0o700 });
  const seedFile = join(source, 'seed.hex');
  await writeFile(seedFile, `${'ef'.repeat(32)}\n`, { mode: 0o600 });
  const script = interaction(['import', '', 'nano:dev', '', '', seedFile, '', '', 'no', 'APPROVE'], async question => {
    if (question.startsWith('Review Nano wallet setup:')) await writeFile(seedFile, `${'12'.repeat(32)}\n`, { mode: 0o600 });
  });
  await assert.rejects(setupNanoWalletInteractive({ home, env: {}, origin, audience, prompt: script.prompt }), { code: 'WALLET_KEY_MISMATCH' });
  await assert.rejects(lstat(join(home, 'wallets', 'nano')), { code: 'ENOENT' });
  assert.equal(await readFile(seedFile, 'utf8'), `${'12'.repeat(32)}\n`);
}));

test('reuse validates the stored public address and never recreates a missing handoff directory', async t => terminal(async () => {
  const home = await homeFor(t), { directory, config } = await existing(home);
  await writeFile(config.keySource.seedFile, `${'34'.repeat(32)}\n`, { mode: 0o600 });
  let before = await snapshot(home);
  await assert.rejects(setupNanoWalletInteractive({ home, env: {}, origin, audience,
    prompt: interaction(['reuse', directory]).prompt }), { code: 'WALLET_KEY_MISMATCH' });
  assert.deepEqual(await snapshot(home), before);
  await rm(config.handoffDirectory, { recursive: true });
  before = await snapshot(home);
  await assert.rejects(setupNanoWalletInteractive({ home, env: {}, origin, audience,
    prompt: interaction(['reuse', directory]).prompt }), { code: 'PRIVATE_FILE' });
  assert.deepEqual(await snapshot(home), before);
}));


test('choosing a Nano recovery source preserves an independently selected Atto wallet',async t=>terminal(async()=>{
  // Given the existing Atto wallet and another explicitly selected recovery source.
  const home=await homeFor(t),original=join(home,'wallets','atto'),source=join(home,'other-recovery');
  const wallet=new AttoApplication({directory:source,secrets:{get:async()=>phrase,set:async()=>{}}});
  try{await wallet.createWallet(phrase);}finally{await wallet.close();}
  await saveWalletSelection(home,{attoDirectory:original});
  const script=interaction(['','','nano:dev','','','','','','APPROVE']);
  // When Nano setup explicitly chooses the second source.
  const result=await setupNanoWalletInteractive({home,env:{MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR:original},origin,audience,
    prompt:question=>question.startsWith('Recovery wallet directory')?Promise.resolve(source):script.prompt(question)});
  // Then Nano pins that source while the existing Atto wallet remains selected after restart.
  const config=JSON.parse(await readFile(join(result.directory,'wallet.json'),'utf8'));
  assert.equal(config.keySource.recoverySource.directory,source);
  assert.equal(readWalletSelection(home).attoDirectory,original);
  assert.equal(script.questions.join('\n').includes(phrase),false);
}));
