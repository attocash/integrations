import { setPermissions } from './support/private-permissions.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { join } from 'node:path';
import test, {before,after} from 'node:test';
import { provisionNanoWallet, inspectNanoRecoveryWallet, approveNanoWalletPolicy } from '@attocash/atto-marketplace-nano-adapter';
import { NanoJournal } from '../../atto-marketplace-nano-adapter/dist/journal.js';
import {AttoApplication} from '../../atto-cli/dist/application/app.js';
import {OsSecretStore} from '../../atto-cli/dist/storage/secrets.js';
import { setupNanoWalletInteractive, prepareNanoWalletInteractive } from '../dist/nano-setup.js';
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
    if(question.startsWith('Nano wallet: [1] Continue selected wallet'))return '';
    if(question.startsWith('Recovery wallet directory'))return '';
    if(question.startsWith('Nano work URL'))return workUrl;
    assert.ok(responses.length, `Unexpected prompt: ${question}`);
    return responses.shift();
  } };
}

async function existing(home, grants = {  externalTransfers: false, controllerPurposes: initialPurposes }, workUrl) {
  const directory = join(home, 'existing');
  const seedFile=join(home,'existing-seed.hex');
  await writeFile(seedFile,'42'.repeat(32)+'\n',{mode:0o600});
  await provisionNanoWallet({ seedFile, dataDir: directory, derivationIndex: 7, network: 'nano:dev', rpcUrl: 'http://localhost:17076', ...(workUrl ? { workUrl } : {}),
    origin, audience,  grants,
    limits: { maxPaymentAtomic: '1000000000000000000000000000000', rolling24hAtomic: '10000000000000000000000000000000' }, terminalConfirmed: true });
  const config = JSON.parse(await readFile(join(directory, 'wallet.json'), 'utf8'));
  // A real reserved transfer must survive configuration review and policy changes.
  const requestJson = JSON.stringify({ requestId: 'retained-payment', network: config.network,
    destination: config.sourceAddress, amountAtomic: '1' });
  const journal = new NanoJournal(directory);
  try {
    const record = journal.begin({ id: 'transfer:retained-payment', kind: 'transfer',
      digest: createHash('sha256').update(requestJson).digest('hex'), requestJson, uniqueId: 'retained-payment',
      source: config.sourceAddress, network: config.network, amount: '1', destination: config.sourceAddress },
      Date.now(), BigInt(config.limits.rolling24hAtomic));
    assert.equal(record.state, 'PREPARING');
  } finally { journal.close(); }
  return { directory, config };
}

test('guided Nano setup enforces its local terminal before prompting or creating state', async t => {
  const home = await homeFor(t), before = await snapshot(home);
  const stdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  try {
    await assert.rejects(setupNanoWalletInteractive({ advanced:true, home, env: {}, origin, audience,
      prompt: async () => assert.fail('Nonterminal setup prompted') }), { code: 'TERMINAL_REQUIRED' });
  } finally {
    if (stdin) Object.defineProperty(process.stdin, 'isTTY', stdin); else delete process.stdin.isTTY;
  }
  assert.deepEqual(await snapshot(home), before);
});

test('cancelled Nano creation preserves all state and never displays recovery material', async t => terminal(async () => {
  // Given an existing recovery root and no Nano profile.
  const home = await homeFor(t);
  await writeFile(join(home, 'selection.json'), '{"nano":"retained"}', { mode: 0o600 });
  const before = await snapshot(home);
  const script = interaction(['', '', 'cancel'], async () => {
    assert.deepEqual(await snapshot(home), before, 'Setup changed files before final consent');
  });
  // When the user declines the basic creation review.
  await assert.rejects(setupNanoWalletInteractive({ home, env: {}, origin, audience, prompt: script.prompt }), { code: 'APPROVAL_DECLINED' });
  // Then neither wallet creation nor any authority change is persisted.
  assert.deepEqual(await snapshot(home), before);
  assert.match(script.questions[0], /Use selected recovery phrase/);
  assert.match(script.questions[1], /Nano access:.*Login only/);
  assert.match(script.questions.at(-1), /Access: Login only/);
  assert.match(script.questions.at(-1), /Maximum per payment: 0 XNO/);
  assert.doesNotMatch(script.questions.at(-1), /Controller purposes:|\braw\b|Derivation index:|RPC:|Work:/);
  assert.equal(script.questions.some(question => /^(Private Nano wallet directory|Recovery wallet directory)/.test(question)), false);
}));

test('normal Nano creation uses production defaults without technical questions or transfer authority', async t => terminal(async () => {
  const home = await homeFor(t);
  // Given a recovery wallet with no explicit Marketplace connection override.
  const responses = ['', '', 'APPROVE'];
  const script = interaction(responses);
  // When the user approves the production binding shown in the review.
  const result = await setupNanoWalletInteractive({ home, env: {}, prompt: script.prompt });
  // Then production is saved without prompting for origin or audience.
  assert.equal(result.directory, join(home, 'wallets', 'nano'));
  assert.equal(result.index, 0);
  assert.equal(result.network, 'nano:mainnet');
  const config = JSON.parse(await readFile(join(result.directory, 'wallet.json'), 'utf8'));
  assert.equal(result.address, config.sourceAddress);
  assert.equal(config.network,'nano:mainnet');
  assert.equal(config.rpcUrl,'https://rpc.nano.to');
  assert.equal(Object.hasOwn(config,'workUrl'),false);
  assert.deepEqual(config.grants, {  externalTransfers: false, controllerPurposes: [] });
  assert.deepEqual(config.limits, { maxPaymentAtomic: '0', rolling24hAtomic: '0' });
  assert.equal(config.origin, 'https://api.atto.market');
  assert.equal(config.audience, 'urn:marketplace:agent-api:live');
  assert.equal(script.questions.some(question => /^(Marketplace origin|Exact Marketplace Agent API audience|Nano network|Nano RPC URL|Nano work URL|Nano derivation index|Allow external Nano|Maximum XNO|Allow headless|Existing Nano policy|Add permission)/.test(question)), false);
  assert.equal(script.questions.some(question => /^(Private Nano wallet directory|Recovery wallet directory)/.test(question)), false);
  assert.equal(config.version,1);
  assert.equal(config.keySource.recoverySource.directory,join(home,'wallets','atto'));
  assert.equal(config.keySource.derivationVersion,'bip39-ed25519-slip10-nano-v1');
  assert.equal(config.keySource.seedFile,undefined);
  await assert.rejects(lstat(join(result.directory,'seed.hex')),{code:'ENOENT'});
  assert.equal(script.questions.join('\n').includes(phrase),false);
  assert.ok(script.questions.at(-1).includes(`Recovery source: ${join(home, 'wallets', 'atto')} (OS password store)`));
  assert.doesNotMatch(script.questions.at(-1),/RPC:|Work:|Derivation index:|\braw\b|Controller purposes:|m\/44|bip39-ed25519/);
  assert.equal(responses.length, 0);
}));

test('basic Nano Limited spending saves positive XNO limits through the adapter policy', async t => terminal(async () => {
  // Given a recovery wallet with no selected Nano wallet.
  const home = await homeFor(t);
  const script = interaction(['', '2', '0.5', '2', 'APPROVE']);
  // When the user chooses Limited spending and approves the exact terms.
  const result = await setupNanoWalletInteractive({ home, env: {}, origin, audience, prompt: script.prompt });
  // Then transfers are enabled with the chosen limits and no headless purpose grant.
  const config = JSON.parse(await readFile(join(result.directory, 'wallet.json'), 'utf8'));
  assert.deepEqual(config.grants, { externalTransfers: true, controllerPurposes: [] });
  assert.deepEqual(config.limits, {
    maxPaymentAtomic: '500000000000000000000000000000', rolling24hAtomic: '2000000000000000000000000000000',
  });
  assert.match(script.questions.at(-1), /Access: Limited spending/);
  assert.match(script.questions.at(-1), /Maximum per payment: 0\.5 XNO/);
  assert.doesNotMatch(script.questions.at(-1), /\braw\b|RPC:|Work:|Derivation index:|Controller purposes:/);
  assert.equal(script.questions.filter(question => question.includes('Type APPROVE to confirm:')).length, 1);
  assert.equal(script.questions.some(question => /^(Private Nano wallet directory|Recovery wallet directory|Allow external Nano)/.test(question)), false);
}));

test('basic Nano Limited spending reviews zero saved caps before replacing them', async t => terminal(async () => {
  // Given a selected Login-only wallet with zero saved spending limits.
  const home = await homeFor(t);
  const created = await setupNanoWalletInteractive({ home, env: {}, origin, audience,
    prompt: interaction(['', '', 'APPROVE']).prompt });
  const env = { MARKETPLACE_MCP_NANO_WALLET_DATA_DIR: created.directory };
  const before = await snapshot(home);
  // When Limited spending and positive caps are requested but typed approval is denied.
  const declined = interaction(['2', '0.25', '1', 'NO']);
  await assert.rejects(setupNanoWalletInteractive({ home, env, origin, audience, prompt: declined.prompt }), { code: 'APPROVAL_DECLINED' });
  // Then the review showed both previous and requested caps, and saved access remains unchanged.
  const preview = declined.questions.at(-1);
  assert.match(preview, /Access: Login only \(payments disabled\) → Limited spending \(payments enabled within limits\)/);
  assert.match(preview, /Maximum per payment: 0 XNO → 0\.25 XNO/);
  assert.match(preview, /Rolling 24-hour maximum: 0 XNO → 1 XNO/);
  assert.doesNotMatch(preview, /\braw\b|Controller purposes:|RPC:|Work:|Derivation index:/);
  assert.deepEqual(await snapshot(home), before);
  // When the same exact terms receive typed approval.
  const approved = interaction(['2', '0.25', '1', 'APPROVE']);
  await setupNanoWalletInteractive({ home, env, origin, audience, prompt: approved.prompt });
  // Then the adapter saves Limited spending with precisely those limits.
  const config = JSON.parse(await readFile(join(created.directory, 'wallet.json'), 'utf8'));
  assert.deepEqual(config.grants, { externalTransfers: true, controllerPurposes: [] });
  assert.deepEqual(config.limits, { maxPaymentAtomic: '250000000000000000000000000000', rolling24hAtomic: '1000000000000000000000000000000' });
}));

test('JSON Nano review retains detailed public diagnostics', async t => terminal(async () => {
  // Given an existing selected Nano wallet with a separate work endpoint.
  const home = await homeFor(t), workUrl = 'https://work.nano.example/existing';
  const { directory } = await existing(home, { externalTransfers: true, controllerPurposes: initialPurposes }, workUrl);
  const script = interaction(['', 'APPROVE']);
  // When wallet setup requests JSON-oriented diagnostics.
  await setupNanoWalletInteractive({ home, env: { MARKETPLACE_MCP_NANO_WALLET_DATA_DIR: directory },
    origin, audience, json: true, prompt: script.prompt });
  // Then the review still shows connection, derivation, raw limits and saved purposes.
  const preview = script.questions.at(-1);
  assert.match(preview, /Derivation index: 7/);
  assert.ok(preview.includes(`Work: ${workUrl}\n`));
  assert.match(preview, /Maximum per payment: 1 XNO \(1000000000000000000000000000000 raw\)/);
  assert.match(preview, /Controller purposes: link authorizer/);
}));

test('basic Nano uses the selected Atto recovery wallet without a directory question', async t => terminal(async () => {
  // Given a different selected Atto recovery wallet.
  const home = await homeFor(t), source = join(home, 'selected-recovery');
  const wallet = new AttoApplication({ directory: source, secrets: { get: async () => phrase, set: async () => {} } });
  try { await wallet.createWallet(phrase); } finally { await wallet.close(); }
  await saveWalletSelection(home, { attoDirectory: source });
  const script = interaction(['', '', 'APPROVE']);
  // When basic Nano setup creates a wallet from recovery.
  const result = await setupNanoWalletInteractive({ home, env: {}, origin, audience, prompt: script.prompt });
  // Then the selected source was reviewed and pinned.
  const config = JSON.parse(await readFile(join(result.directory, 'wallet.json'), 'utf8'));
  assert.equal(config.keySource.recoverySource.directory, source);
  assert.ok(script.questions.at(-1).includes(`Recovery source: ${source} (OS password store)`));
  assert.equal(script.questions.some(question => /^(Private Nano wallet directory|Recovery wallet directory)/.test(question)), false);
}));

test('advanced Nano import retains its explicit private seed file alternative', async t => terminal(async () => {
  // Given a private standalone seed and an empty selected Nano directory.
  const home = await homeFor(t), seedFile = join(home, 'standalone-seed.hex');
  await writeFile(seedFile, `${'cd'.repeat(32)}\n`, { mode: 0o600 });
  const script = interaction(['import', '', '', '', '1', seedFile, '', '', 'APPROVE']);
  // When the user explicitly selects the advanced seed-file import.
  const result = await setupNanoWalletInteractive({ advanced:true, home, env: {}, origin, audience, prompt: script.prompt });
  // Then the native seed is pinned while shared recovery remains an independent source.
  const config = JSON.parse(await readFile(join(result.directory, 'wallet.json'), 'utf8'));
  assert.equal(result.index, 1);
  assert.equal(config.keySource.seedFile, seedFile);
  assert.deepEqual(config.grants, { externalTransfers: false, controllerPurposes: [] });
  assert.equal(script.questions.filter(question => question.startsWith('Existing private 32-byte seed file')).length, 1);
  assert.equal(script.questions.some(question => question.startsWith('Recovery wallet directory')), false);
}));

test('basic Nano retries only invalid finite choices before creating wallet state', async t => terminal(async () => {
  // Given an empty managed Nano directory.
  const home = await homeFor(t), before = await snapshot(home);
  const script = interaction(['invalid', '', 'invalid', '', 'APPROVE'], async () => {
    assert.deepEqual(await snapshot(home), before);
  });
  // When both the creation and access menus receive an invalid choice first.
  const result = await setupNanoWalletInteractive({ home, env: {}, origin, audience, prompt: script.prompt });
  // Then each menu repeats and only the approved Login-only wallet is created.
  assert.equal(script.questions.filter(question => question.startsWith('Nano wallet:')).length, 2);
  assert.equal(script.questions.filter(question => question.startsWith('Nano access:')).length, 2);
  const config = JSON.parse(await readFile(join(result.directory, 'wallet.json'), 'utf8'));
  assert.equal(config.grants.externalTransfers, false);
}));

test('basic Nano refuses an occupied selected directory before offering creation', async t => terminal(async () => {
  // Given an occupied selected Nano directory without a wallet configuration.
  const home = await homeFor(t), directory = join(home, 'wallets', 'nano');
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, 'retained.txt'), 'keep me', { mode: 0o600 });
  const before = await snapshot(home);
  // When basic setup inspects the selected location.
  await assert.rejects(setupNanoWalletInteractive({ home, env: {}, origin, audience,
    prompt: async () => assert.fail('An occupied directory must not offer wallet creation') }), { code: 'WALLET_CONFIGURATION_EXISTS' });
  // Then all retained bytes remain and no menu was shown.
  assert.deepEqual(await snapshot(home), before);
}));

for (const { name, network, answer, rpcUrl, production } of [
  { name: 'mainnet production blank RPC uses signed-in Marketplace work', production:true, network:'nano:mainnet', answer:'', rpcUrl:'https://rpc.nano.to' },
  { name: 'mainnet blank RPC uses Nano.to', network: 'nano:mainnet', answer: '', rpcUrl: 'https://rpc.nano.to' },
  { name: 'development blank RPC uses loopback', network: 'nano:dev', answer: '', rpcUrl: 'http://localhost:17076' },
  { name: 'mainnet explicit RPC keeps the custom provider', network: 'nano:mainnet', answer: 'https://nano.example/rpc', rpcUrl: 'https://nano.example/rpc' },
]) {
  test(`advanced Nano creation ${name} in its review and saved profile`, async t => terminal(async () => {
    // Given a private recovery wallet and no existing Nano profile.
    const home = await homeFor(t), before = await snapshot(home);
    const responses = ['', '', network, answer, '', '', '', 'APPROVE'];
    const script = interaction(responses, async question => {
      if (question.startsWith('Review Nano wallet setup:')) {
        assert.deepEqual(await snapshot(home), before, 'The reviewed profile must not exist before consent');
        const work = production ? 'Marketplace when signed in, otherwise ' + rpcUrl : rpcUrl;
        assert.ok(question.includes(`Network: ${network}\nRPC: ${rpcUrl}\nWork: ${work}\n`));
      }
    });
    // When the user reviews the resolved RPC and approves creation.
    const result = await setupNanoWalletInteractive({ advanced:true, home, env:{}, origin:production?'https://api.atto.market':origin,
      audience:production?'urn:marketplace:agent-api:live':audience, prompt:script.prompt });
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

test('advanced Nano creation reviews and persists a separate work provider', async t => terminal(async () => {
  // Given a private recovery wallet and a user-selected work endpoint.
  const home = await homeFor(t), before = await snapshot(home), workUrl = 'https://work.nano.example/generate';
  const script = interaction(['', '', 'nano:mainnet', '', '', '', '', 'APPROVE'], async question => {
    if (question.startsWith('Review Nano wallet setup:')) {
      assert.deepEqual(await snapshot(home), before);
      assert.ok(question.includes(`RPC: https://rpc.nano.to\nWork: ${workUrl}\n`));
    }
  }, workUrl);
  // When the user approves the reviewed RPC and separate work provider.
  const result = await setupNanoWalletInteractive({ advanced:true, home, env: {}, origin, audience, prompt: script.prompt });
  // Then the new profile keeps both choices separately.
  const config = JSON.parse(await readFile(join(result.directory, 'wallet.json'), 'utf8'));
  assert.equal(config.rpcUrl, 'https://rpc.nano.to');
  assert.equal(config.workUrl, workUrl);
}));

test('advanced Nano creation rejects invalid work providers without publishing state', async t => terminal(async () => {
  for (const workUrl of ['not-a-url', 'http://work.nano.example', 'https://user:secret@work.nano.example']) {
    // Given a private recovery wallet and an invalid work URL.
    const home = await homeFor(t), before = await snapshot(home);
    const script = interaction(['', '', 'nano:mainnet', ''], undefined, workUrl);
    // When setup validates the separate work URL.
    await assert.rejects(setupNanoWalletInteractive({ advanced:true, home, env: {}, origin, audience, prompt: script.prompt }), { code: 'SETUP_USAGE' });
    // Then no profile or other local state has been published.
    assert.deepEqual(await snapshot(home), before);
  }
}));

test('human XNO ceilings use exact 30-place arithmetic and independent transfer consent', async t => terminal(async () => {
  const home = await homeFor(t);
  const script = interaction(['', '', 'nano:dev', '', '2147483647', 'yes',
    '0.000000000000000000000000000001', '1.234567890123456789012345678901', 'no', 'APPROVE']);
  const result = await setupNanoWalletInteractive({ advanced:true, home, env: {}, origin, audience, prompt: script.prompt });
  const config = JSON.parse(await readFile(join(result.directory, 'wallet.json'), 'utf8'));
  assert.deepEqual(config.grants, {  externalTransfers: true, controllerPurposes: [] });
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
    const script = interaction(['', '', 'nano:dev', '', '', 'yes', ...amounts]);
    await assert.rejects(setupNanoWalletInteractive({ advanced:true, home, env: {}, origin, audience, prompt: script.prompt }), { code: 'INVALID_AMOUNT' });
    assert.deepEqual(await snapshot(home), before);
  }
}));

test('normal Nano reuse preserves saved network, endpoints, policy, seed and journal without technical questions', async t => terminal(async () => {
  // Given an existing profile with a separate work provider and a retained native journal.
  const home = await homeFor(t), workUrl = 'https://work.nano.example/existing', { directory, config } = await existing(home, {externalTransfers:true,controllerPurposes:initialPurposes}, workUrl);
  const before = await snapshot(home);
  const script = interaction(['', 'APPROVE'], async () => {
    assert.deepEqual(await snapshot(home), before, 'Reuse preview changed existing state');
  });
  // When the user accepts reuse without replacing connection settings or policy.
  const result = await setupNanoWalletInteractive({ home, env: { MARKETPLACE_MCP_NANO_WALLET_DATA_DIR: directory },
    origin, audience, prompt: script.prompt });
  // Then the concise review keeps the saved access and every existing byte remains unchanged.
  assert.match(script.questions[0], /Nano wallet:.*Continue selected wallet.*default/);
  assert.match(script.questions[1], /Nano access:.*Limited spending.*default/);
  assert.equal(script.questions.some(question=>/^(Nano network|Nano RPC URL|Nano work URL|Nano derivation index|Allow external Nano|Maximum XNO|Allow headless|Existing Nano policy|Add permission)/.test(question)),false);
  assert.equal(script.questions.some(question=>/^(Private Nano wallet directory|Recovery wallet directory)/.test(question)),false);
  assert.match(script.questions.at(-1), /Access: Limited spending/);
  assert.match(script.questions.at(-1), /Maximum per payment: 1 XNO/);
  assert.doesNotMatch(script.questions.at(-1), /RPC:|Work:|Derivation index:|\braw\b|Controller purposes:|bip39-ed25519/);
  assert.deepEqual(result, { directory, address: config.sourceAddress, index: 7, network: 'nano:dev' });
  assert.deepEqual(await snapshot(home), before);
  const journal = new NanoJournal(directory);
  try { assert.equal(journal.find('transfer:retained-payment').state, 'PREPARING'); }
  finally { journal.close(); }
}));

test('basic Nano Limited spending reuses suitable saved caps and preserves unrelated purposes', async t => terminal(async () => {
  // Given a selected Login-only Nano wallet with suitable saved limits and another purpose grant.
  const home = await homeFor(t), workUrl = 'https://work.nano.example/existing';
  const { directory, config } = await existing(home, { externalTransfers: false, controllerPurposes: initialPurposes }, workUrl);
  const journal = await readFile(join(directory, 'nano-wallet.sqlite3'));
  const script = interaction(['2', 'APPROVE']);
  // When the user deliberately chooses Limited spending and types approval.
  await setupNanoWalletInteractive({ home, env: { MARKETPLACE_MCP_NANO_WALLET_DATA_DIR: directory }, origin, audience, prompt: script.prompt });
  // Then only transfer access changes; the saved caps, purpose, key source, connection and journal persist.
  const after = JSON.parse(await readFile(join(directory, 'wallet.json'), 'utf8'));
  assert.deepEqual(after, { ...config, grants: { ...config.grants, externalTransfers: true } });
  assert.deepEqual(await readFile(join(directory, 'nano-wallet.sqlite3')), journal);
  assert.match(script.questions.at(-1), /Access: Login only \(payments disabled\) → Limited spending \(payments enabled within limits\)/);
  assert.match(script.questions.at(-1), /Maximum per payment: 1 XNO/);
  assert.doesNotMatch(script.questions.at(-1), /Controller purposes:|\braw\b/);
  assert.equal(script.questions.some(question => question.startsWith('Maximum XNO')), false);
}));

test('basic Nano Login only narrows existing Limited spending only after typed approval', async t => terminal(async () => {
  // Given a selected Full-access Nano wallet and its native journal.
  const home = await homeFor(t), { directory, config } = await existing(home, { externalTransfers: true, controllerPurposes: initialPurposes });
  const before = await snapshot(home);
  const env = { MARKETPLACE_MCP_NANO_WALLET_DATA_DIR: directory };
  // When the user chooses Login only but declines the review.
  const declined = interaction(['1', 'NO']);
  await assert.rejects(setupNanoWalletInteractive({ home, env, origin, audience, prompt: declined.prompt }), { code: 'APPROVAL_DECLINED' });
  // Then no existing authority or journal has changed.
  assert.deepEqual(await snapshot(home), before);
  assert.match(declined.questions.at(-1), /Access: Limited spending \(payments enabled within limits\) → Login only \(payments disabled\)/);
  // When the user repeats the deliberate choice and approves it.
  const approved = interaction(['1', 'APPROVE']);
  await setupNanoWalletInteractive({ home, env, origin, audience, prompt: approved.prompt });
  // Then the adapter policy denies transfers and preserves saved limits and unrelated purpose.
  const after = JSON.parse(await readFile(join(directory, 'wallet.json'), 'utf8'));
  assert.deepEqual(after, { ...config, grants: { ...config.grants, externalTransfers: false } });
}));

test('explicit Nano policy replacement retains all unrelated purpose grants and immutable profile settings', async t => terminal(async () => {
  const home = await homeFor(t), { directory, config } = await existing(home);
  const seed = await readFile(config.keySource.seedFile), journal = await readFile(join(directory, 'nano-wallet.sqlite3'));
  const script = interaction(['reuse', directory, 'replace', 'yes', '0.5', '2.5', 'yes', 'APPROVE']);
  await setupNanoWalletInteractive({ advanced:true, home, env: {}, origin, audience, prompt: script.prompt });
  const after = JSON.parse(await readFile(join(directory, 'wallet.json'), 'utf8'));
  assert.deepEqual({ ...after, grants: config.grants, limits: config.limits }, config);
  assert.deepEqual(after.grants, {  externalTransfers: true, controllerPurposes: [...initialPurposes, 'login'] });
  assert.deepEqual(after.limits, { maxPaymentAtomic: '500000000000000000000000000000', rolling24hAtomic: '2500000000000000000000000000000' });
  assert.deepEqual(await readFile(config.keySource.seedFile), seed);
  assert.deepEqual(await readFile(join(directory, 'nano-wallet.sqlite3')), journal);
}));

test('adding login while keeping Nano transfer policy persists only the explicitly reviewed purpose', async t => terminal(async () => {
  const home = await homeFor(t), { directory, config } = await existing(home);
  const script = interaction(['reuse', directory, 'keep', 'yes', 'APPROVE']);
  await setupNanoWalletInteractive({ advanced:true, home, env: {}, origin, audience, prompt: script.prompt });
  const after = JSON.parse(await readFile(join(directory, 'wallet.json'), 'utf8'));
  assert.deepEqual(after, { ...config, grants: { ...config.grants, controllerPurposes: [...initialPurposes, 'login'] } });
}));

test('cancelled existing-profile policy changes preserve wallet, selection and native journal', async t => terminal(async () => {
  const home = await homeFor(t), { directory } = await existing(home);
  await writeFile(join(home, 'selection.json'), '{"nano":"retained"}', { mode: 0o600 });
  const before = await snapshot(home);
  const script = interaction(['reuse', directory, 'replace', 'yes', '1', '2', 'yes', 'NO'], async () => {
    assert.deepEqual(await snapshot(home), before);
  });
  await assert.rejects(setupNanoWalletInteractive({ advanced:true, home, env: {}, origin, audience, prompt: script.prompt }), { code: 'APPROVAL_DECLINED' });
  assert.deepEqual(await snapshot(home), before);
}));

test('existing Nano profile missing a seed or using another connection never falls back to generation', async t => terminal(async () => {
  // Given the original private seed is unavailable.
  const home = await homeFor(t), { directory, config } = await existing(home);
  await rm(config.keySource.seedFile);
  const before = await snapshot(home);
  const script = interaction(['', '', 'replace', 'yes', '1', '2', 'no', 'APPROVE']);
  // When the user approves a policy change that requires the original key.
  await assert.rejects(setupNanoWalletInteractive({ advanced:true, home, env: { MARKETPLACE_MCP_NANO_WALLET_DATA_DIR: directory },
    origin, audience, prompt: script.prompt }), { code: 'PRIVATE_FILE' });
  assert.deepEqual(await snapshot(home), before);
  // Then no identity is replaced, and a different connection is rejected at public review.
  const second = await homeFor(t), wallet = await existing(second), prior = await snapshot(second);
  await assert.rejects(setupNanoWalletInteractive({ advanced:true, home: second, env: {}, origin: 'http://localhost:9999', audience,
    prompt: interaction(['reuse', wallet.directory]).prompt }), { code: 'WALLET_CONFIGURATION' });
  assert.deepEqual(await snapshot(second), prior);
}));

test('private standalone seed import reviews its public address and retains the original private file', async t => terminal(async () => {
  const home = await homeFor(t), seedDirectory = join(home, 'backup');
  await mkdir(seedDirectory, { mode: 0o700 });
  const seedFile = join(seedDirectory, 'seed.hex'), seed = `${'ab'.repeat(32)}\n`;
  await writeFile(seedFile, seed, { mode: 0o600 });
  const before = await snapshot(home);
  const script = interaction(['import', '', 'nano:dev', '', '2', seedFile, '', 'no', 'APPROVE'], async () => {
    assert.deepEqual(await snapshot(home), before);
  });
  const result = await setupNanoWalletInteractive({ advanced:true, home, env: {}, origin, audience, prompt: script.prompt });
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
    await assert.rejects(setupNanoWalletInteractive({ advanced:true, home, env: {}, origin, audience, prompt: script.prompt }));
    assert.deepEqual(await snapshot(home), before);
  }
}));

test('an imported seed changed during approval cannot configure an unreviewed Nano identity', async t => terminal(async () => {
  const home = await homeFor(t), source = join(home, 'backup');
  await mkdir(source, { mode: 0o700 });
  const seedFile = join(source, 'seed.hex');
  await writeFile(seedFile, `${'ef'.repeat(32)}\n`, { mode: 0o600 });
  const script = interaction(['import', '', 'nano:dev', '', '', seedFile, '', 'no', 'APPROVE'], async question => {
    if (question.startsWith('Review Nano wallet setup:')) await writeFile(seedFile, `${'12'.repeat(32)}\n`, { mode: 0o600 });
  });
  await assert.rejects(setupNanoWalletInteractive({ advanced:true, home, env: {}, origin, audience, prompt: script.prompt }), { code: 'WALLET_KEY_MISMATCH' });
  await assert.rejects(lstat(join(home, 'wallets', 'nano')), { code: 'ENOENT' });
  assert.equal(await readFile(seedFile, 'utf8'), `${'12'.repeat(32)}\n`);
}));

test('reuse validates the stored public address and never recreates missing native wallet keys', async t => terminal(async () => {
  // Given changed or missing original private keys behind a valid public profile.
  const home = await homeFor(t), { directory, config } = await existing(home);
  await writeFile(config.keySource.seedFile, `${'34'.repeat(32)}\n`, { mode: 0o600 });
  let before = await snapshot(home);
  // When a new purpose grant is approved after the public review.
  await assert.rejects(setupNanoWalletInteractive({ advanced:true, home, env: {}, origin, audience,
    prompt: interaction(['reuse', directory, 'keep', 'yes', 'APPROVE']).prompt }), { code: 'WALLET_KEY_MISMATCH' });
  // Then the original identity and journal remain intact and no replacement keys are generated.
  assert.deepEqual(await snapshot(home), before);
  await rm(config.keySource.seedFile);
  before = await snapshot(home);
  await assert.rejects(setupNanoWalletInteractive({ advanced:true, home, env: {}, origin, audience,
    prompt: interaction(['reuse', directory, 'keep', 'yes', 'APPROVE']).prompt }), { code: 'PRIVATE_FILE' });
  assert.deepEqual(await snapshot(home), before);
}));


test('choosing a Nano recovery source preserves an independently selected Atto wallet',async t=>terminal(async()=>{
  // Given the existing Atto wallet and another explicitly selected recovery source.
  const home=await homeFor(t),original=join(home,'wallets','atto'),source=join(home,'other-recovery');
  const wallet=new AttoApplication({directory:source,secrets:{get:async()=>phrase,set:async()=>{}}});
  try{await wallet.createWallet(phrase);}finally{await wallet.close();}
  await saveWalletSelection(home,{attoDirectory:original});
  const script=interaction(['','','nano:dev','','','','','APPROVE']);
  // When Nano setup explicitly chooses the second source.
  const result=await setupNanoWalletInteractive({advanced:true,home,env:{MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR:original},origin,audience,
    prompt:question=>question.startsWith('Recovery wallet directory')?Promise.resolve(source):script.prompt(question)});
  // Then Nano pins that source while the existing Atto wallet remains selected after restart.
  const config=JSON.parse(await readFile(join(result.directory,'wallet.json'),'utf8'));
  assert.equal(config.keySource.recoverySource.directory,source);
  assert.equal(readWalletSelection(home).attoDirectory,original);
  assert.equal(script.questions.join('\n').includes(phrase),false);
}));

test('basic Nano numbered menus show one explicit default marker without a second fallback',async t=>terminal(async()=>{
  // Given an empty managed target and Login-only defaults.
  const home=await homeFor(t),script=interaction(['','','NO']);
  // When the basic wallet and access choices are displayed.
  await assert.rejects(setupNanoWalletInteractive({home,env:{},origin,audience,prompt:script.prompt}),{code:'APPROVAL_DECLINED'});
  // Then each numbered menu has one clear default marker and no duplicate bracketed default.
  for(const question of script.questions.slice(0,2)){
    assert.equal((question.match(/\(default\)/g)||[]).length,1);assert.doesNotMatch(question,/\(default\).*\[[12]\]:/);
  }
}));

async function nanoCapFixture(t){
  const home=await homeFor(t),{directory,config}=await existing(home);
  await approveNanoWalletPolicy({dataDir:directory,grants:config.grants,limits:{maxPaymentAtomic:'0',rolling24hAtomic:'0'},terminalConfirmed:true});
  return {home,directory,env:{MARKETPLACE_MCP_NANO_WALLET_DATA_DIR:directory},config:JSON.parse(await readFile(join(directory,'wallet.json'),'utf8'))};
}

for(const cap of ['per-payment','rolling'])test(`basic Nano corrects invalid ${cap} caps without losing prior policy or journal`,async t=>terminal(async()=>{
  // Given a selected wallet with zero caps, another purpose grant and a populated native transfer journal.
  const f=await nanoCapFixture(t),before=await snapshot(f.home),journal=await readFile(join(f.directory,'nano-wallet.sqlite3'));
  const invalid=['0','not-an-amount',`0.${'0'.repeat(30)}1`,'999999999'];
  const responses=['2',...(cap==='rolling'?['0.25']:[]),...invalid,cap==='per-payment'?'0.25':'2',...(cap==='per-payment'?['2']:[]),'APPROVE'];
  const script=interaction(responses,async()=>assert.deepEqual(await snapshot(f.home),before,'Cap entry or review mutated saved state before typed approval.'));
  // When zero, malformed, excess-precision and out-of-range values are corrected in the affected field.
  await setupNanoWalletInteractive({...f,origin,audience,prompt:script.prompt});
  // Then the first accepted cap is retained and only the exact approved transfer policy is changed.
  assert.equal(responses.length,0);
  const after=JSON.parse(await readFile(join(f.directory,'wallet.json'),'utf8'));
  assert.deepEqual(after,{...f.config,grants:{...f.config.grants,externalTransfers:true},limits:{maxPaymentAtomic:(10n**30n/4n).toString(),rolling24hAtomic:(2n*10n**30n).toString()}});
  assert.deepEqual(await readFile(join(f.directory,'nano-wallet.sqlite3')),journal);
  assert.equal(script.questions.filter(question=>question.includes('Type APPROVE to confirm:')).length,1);
  assert.equal(script.questions.filter(question=>question.startsWith('Maximum XNO per payment')).length,cap==='per-payment'?5:1);
  assert.equal(script.questions.filter(question=>question.startsWith('Maximum XNO over rolling')).length,cap==='rolling'?5:1);
  assert.ok(script.questions.filter(question=>question.startsWith('Maximum XNO per payment')).every(question=>question.endsWith(' [1]: ')));
  assert.ok(script.questions.filter(question=>question.startsWith('Maximum XNO over rolling')).every(question=>question.endsWith(' [10]: ')));
}));

test('basic Nano explains a daily cap below the accepted per-payment amount and repeats only the daily field',async t=>terminal(async()=>{
  // Given an existing zero-cap wallet and its retained transfer journal.
  const f=await nanoCapFixture(t),before=await snapshot(f.home),journal=await readFile(join(f.directory,'nano-wallet.sqlite3'));
  const responses=['2','2','1','2.5','APPROVE'],script=interaction(responses,async()=>assert.deepEqual(await snapshot(f.home),before));
  const originalWrite=process.stderr.write;let output='';process.stderr.write=(chunk,...rest)=>{if(typeof chunk!=='string')return originalWrite.call(process.stderr,chunk,...rest);output+=chunk;return true;};
  try{
    // When the daily amount is lower than the already accepted per-payment amount, then corrected.
    await setupNanoWalletInteractive({...f,origin,audience,prompt:script.prompt});
  }finally{process.stderr.write=originalWrite;}
  // Then the explanation names the accepted minimum, retains the first cap and saves exactly the reviewed pair.
  assert.match(output,/rolling 24-hour maximum must be at least the per-payment limit of 2 XNO/);
  assert.equal(responses.length,0);assert.equal(script.questions.filter(question=>question.startsWith('Maximum XNO per payment')).length,1);
  assert.equal(script.questions.filter(question=>question.startsWith('Maximum XNO over rolling')).length,2);
  const after=JSON.parse(await readFile(join(f.directory,'wallet.json'),'utf8'));
  assert.deepEqual(after.limits,{maxPaymentAtomic:(2n*10n**30n).toString(),rolling24hAtomic:(5n*10n**30n/2n).toString()});
  assert.deepEqual(await readFile(join(f.directory,'nano-wallet.sqlite3')),journal);
}));

test('basic Nano amount correction keeps the visible defaults and accepts their empty answers',async t=>terminal(async()=>{
  // Given a selected wallet that needs positive Limited caps.
  const f=await nanoCapFixture(t),responses=['2','','','APPROVE'],script=interaction(responses);
  // When the person accepts the displayed 1 XNO and 10 XNO defaults.
  await setupNanoWalletInteractive({...f,origin,audience,prompt:script.prompt});
  // Then those exact values are saved with one typed policy review.
  assert.equal(responses.length,0);
  assert.match(script.questions.find(question=>question.startsWith('Maximum XNO per payment')),/\[1\]: $/);
  assert.match(script.questions.find(question=>question.startsWith('Maximum XNO over rolling')),/\[10\]: $/);
  const after=JSON.parse(await readFile(join(f.directory,'wallet.json'),'utf8'));
  assert.deepEqual(after.limits,{maxPaymentAtomic:(10n**30n).toString(),rolling24hAtomic:(10n*10n**30n).toString()});
}));

for(const [cap,code] of [['per-payment','CANCELLED'],['rolling','ERR_USE_AFTER_CLOSE'],['rolling','SETUP_PROTOCOL']])test(`basic Nano correction propagates ${code} from the ${cap} prompt unchanged`,async t=>terminal(async()=>{
  // Given an invalid basic cap followed by terminal cancellation, EOF or a protocol failure.
  const f=await nanoCapFixture(t),before=await snapshot(f.home),error=Object.assign(new Error('Fixture prompt ended'),{code});
  const responses=['2',...(cap==='rolling'?['0.25']:[]),'0'];let amountQuestions=0;
  const script=interaction(responses,async question=>{
    assert.deepEqual(await snapshot(f.home),before);
    if(question.startsWith(cap==='per-payment'?'Maximum XNO per payment':'Maximum XNO over rolling')&&++amountQuestions===2)throw error;
  });
  // When that prompt failure occurs during local amount correction.
  await assert.rejects(setupNanoWalletInteractive({...f,origin,audience,prompt:script.prompt}),failure=>failure===error);
  // Then non-amount failures are not retried, and policy, unrelated purposes and journal are unchanged.
  assert.equal(amountQuestions,2);assert.equal(responses.length,0);assert.deepEqual(await snapshot(f.home),before);
}));

test('declining the corrected Nano policy review preserves the original zero caps and populated journal',async t=>terminal(async()=>{
  // Given a zero-cap wallet with a retained transfer journal and unrelated controller purpose.
  const f=await nanoCapFixture(t),before=await snapshot(f.home),responses=['2','0','0.25','0','2','NO'];
  const script=interaction(responses,async()=>assert.deepEqual(await snapshot(f.home),before));
  // When both invalid caps are corrected but the exact policy review is declined.
  await assert.rejects(setupNanoWalletInteractive({...f,origin,audience,prompt:script.prompt}),{code:'APPROVAL_DECLINED'});
  // Then validation and preview alone changed no state.
  assert.equal(responses.length,0);assert.deepEqual(await snapshot(f.home),before);
}));

test('a concurrent Nano policy change during cap correction survives the stale final review',async t=>terminal(async()=>{
  // Given a zero-cap wallet while another terminal installs its own approved policy during correction.
  const f=await nanoCapFixture(t),journal=await readFile(join(f.directory,'nano-wallet.sqlite3'));
  const responses=['2','0.25','invalid','2','APPROVE'];let concurrent;
  const script=interaction(responses,async question=>{
    if(question.startsWith('Maximum XNO over rolling')&&!concurrent){
      await approveNanoWalletPolicy({dataDir:f.directory,grants:f.config.grants,limits:{maxPaymentAtomic:(10n**30n/2n).toString(),rolling24hAtomic:(3n*10n**30n).toString()},terminalConfirmed:true});
      concurrent=await snapshot(f.home);
    }
  });
  // When the original person corrects the cap and approves an outdated exact review.
  await assert.rejects(setupNanoWalletInteractive({...f,origin,audience,prompt:script.prompt}),{code:'WALLET_CONFIGURATION_CHANGED'});
  // Then final configuration revalidation preserves the newer policy and all journal bytes.
  assert.equal(responses.length,0);assert.ok(concurrent);assert.deepEqual(await snapshot(f.home),concurrent);
  assert.deepEqual(await readFile(join(f.directory,'nano-wallet.sqlite3')),journal);
}));

test('Nano preparation reviews Unlimited without enabling transfer or headless signing authority',async t=>terminal(async()=>{
  // Given shared recovery and an empty Nano target.
  const home=await homeFor(t),before=await snapshot(home),script=interaction(['','3']);
  // When a public Unlimited plan is prepared before combined wallet/login consent.
  const plan=await prepareNanoWalletInteractive({home,env:{},origin,audience,prompt:script.prompt});
  await plan.validate();
  // Then it has an actual public identity and exact risk review without creating Nano authority or asking approval.
  assert.equal(plan.mode,'unlimited');assert.equal(plan.asset,'XNO');assert.match(plan.wallet.address,/^nano_/);
  assert.match(plan.review,/Unlimited spending \(can spend available balance and future deposits\)/);
  assert.match(plan.review,/Maximum per payment: Unlimited/);assert.match(plan.review,/Rolling 24-hour maximum: Unlimited/);
  assert.equal(script.questions.some(question=>/Type APPROVE|Maximum XNO/.test(question)),false);
  assert.deepEqual(await snapshot(home),before);
  // When the owner commits the already reviewed plan after consent.
  await plan.commit();await plan.validate();
  // Then only the exact requested policy is persisted, and later drift is fenced.
  const path=join(plan.wallet.directory,'wallet.json'),config=JSON.parse(await readFile(path,'utf8'));
  assert.deepEqual(config.grants,{externalTransfers:true,controllerPurposes:[]});
  assert.deepEqual(config.limits,{maxPaymentAtomic:null,rolling24hAtomic:null});
  assert.equal(readWalletSelection(home),undefined);
  await approveNanoWalletPolicy({dataDir:plan.wallet.directory,grants:{...config.grants,externalTransfers:false},limits:config.limits,terminalConfirmed:true});
  await assert.rejects(plan.validate(),{code:'WALLET_CONFIGURATION_CHANGED'});
}));

test('Nano preparation reads an existing locked wallet without unlocking its seed',async t=>terminal(async()=>{
  // Given an existing wallet whose private seed is unavailable and a populated journal.
  const home=await homeFor(t),{directory,config}=await existing(home);
  await rm(config.keySource.seedFile);const before=await snapshot(home),script=interaction(['3']);
  // When the user prepares an Unlimited policy review using public configuration only.
  const plan=await prepareNanoWalletInteractive({home,env:{MARKETPLACE_MCP_NANO_WALLET_DATA_DIR:directory},origin,audience,prompt:script.prompt});
  await plan.validate();
  // Then no key access was needed for review, and actual policy mutation still requires the original key.
  assert.equal(plan.wallet.address,config.sourceAddress);assert.deepEqual(await snapshot(home),before);
  await assert.rejects(plan.commit(),{code:'PRIVATE_FILE'});assert.deepEqual(await snapshot(home),before);
}));

test('Nano existing Unlimited defaults preserve null caps and Login only does not coalesce them to zero',async t=>terminal(async()=>{
  // Given an existing Unlimited profile with unrelated purpose grants and a populated journal.
  const home=await homeFor(t),{directory,config}=await existing(home),limits={maxPaymentAtomic:null,rolling24hAtomic:null};
  await approveNanoWalletPolicy({dataDir:directory,grants:{...config.grants,externalTransfers:true},limits,terminalConfirmed:true});
  const before=await snapshot(home),env={MARKETPLACE_MCP_NANO_WALLET_DATA_DIR:directory},saved=interaction(['','APPROVE']);
  // When the saved access default is accepted, then Login only is deliberately selected.
  await setupNanoWalletInteractive({home,env,origin,audience,prompt:saved.prompt});
  assert.match(saved.questions[1],/\[3\] Unlimited spending \(default\)/);assert.deepEqual(await snapshot(home),before);
  const narrowed=interaction(['1','APPROVE']);await setupNanoWalletInteractive({home,env,origin,audience,prompt:narrowed.prompt});
  // Then disabled transfer access retains explicit nulls, all unrelated grants and the original journal.
  const after=JSON.parse(await readFile(join(directory,'wallet.json'),'utf8'));
  assert.deepEqual(after.limits,limits);assert.deepEqual(after.grants,{...config.grants,externalTransfers:false});
  assert.equal(narrowed.questions.some(question=>question.startsWith('Maximum XNO')),false);
  assert.deepEqual(await readFile(join(directory,'nano-wallet.sqlite3')),Buffer.from(before['existing/nano-wallet.sqlite3'].content,'base64'));
}));

test('Nano resumed intent rebuilds current public policy review and preserves newly saved unrelated purposes',async t=>terminal(async()=>{
  // Given deferred Unlimited intent and a later independently approved policy change.
  const home=await homeFor(t),{directory,config}=await existing(home),env={MARKETPLACE_MCP_NANO_WALLET_DATA_DIR:directory};
  const first=await prepareNanoWalletInteractive({home,env,origin,audience,prompt:interaction(['3']).prompt});
  await approveNanoWalletPolicy({dataDir:directory,grants:{...config.grants,controllerPurposes:[...config.grants.controllerPurposes,'unlink']},limits:{maxPaymentAtomic:'2',rolling24hAtomic:'3'},terminalConfirmed:true});
  const journal=await readFile(join(directory,'nano-wallet.sqlite3'));
  // When restart rebuilds the saved desired access without replaying menus or consuming old approval.
  const resumed=await prepareNanoWalletInteractive({home,env,origin,audience,resumeIntent:first.intent,prompt:async()=>assert.fail('Resume must rebuild review without menu answers')});
  // Then current before/after terms are reviewed and unrelated purpose changes survive the new approved commit.
  assert.match(resumed.review,/Maximum per payment: .* → Unlimited/);
  await resumed.validate();await resumed.commit();await resumed.validate();
  const after=JSON.parse(await readFile(join(directory,'wallet.json'),'utf8'));
  assert.deepEqual(after.grants.controllerPurposes,[...config.grants.controllerPurposes,'unlink']);
  assert.deepEqual(after.limits,{maxPaymentAtomic:null,rolling24hAtomic:null});
  assert.deepEqual(await readFile(join(directory,'nano-wallet.sqlite3')),journal);
  const malformed=structuredClone(first.intent);malformed.policy.limits.rolling24hAtomic='1';
  await assert.rejects(prepareNanoWalletInteractive({home,env,origin,audience,resumeIntent:malformed,prompt:async()=>assert.fail('Malformed intent must not prompt')}));
}));

test('Nano Limited spending replaces saved Unlimited with two locally correctable finite caps',async t=>terminal(async()=>{
  // Given a saved Unlimited wallet.
  const home=await homeFor(t),{directory,config}=await existing(home);
  await approveNanoWalletPolicy({dataDir:directory,grants:{...config.grants,externalTransfers:true},limits:{maxPaymentAtomic:null,rolling24hAtomic:null},terminalConfirmed:true});
  const script=interaction(['2','0','0.5','0.25','2','APPROVE']);
  // When Limited is selected and invalid or insufficient caps are corrected.
  await setupNanoWalletInteractive({home,env:{MARKETPLACE_MCP_NANO_WALLET_DATA_DIR:directory},origin,audience,prompt:script.prompt});
  // Then Unlimited has become precisely the approved finite pair, with one final approval.
  const after=JSON.parse(await readFile(join(directory,'wallet.json'),'utf8'));
  assert.deepEqual(after.limits,{maxPaymentAtomic:(5n*10n**29n).toString(),rolling24hAtomic:(2n*10n**30n).toString()});
  assert.equal(script.questions.filter(question=>question.includes('Type APPROVE to confirm:')).length,1);assert.equal(script.questions.length,7);
}));

test('Nano offers prepared managed recovery explicitly when the selected shared recovery already exists',async t=>terminal(async()=>{
  // Given the selected shared root and another managed recovery retained before any Nano plan or wallet was saved.
  const home=await homeFor(t),source=join(home,'wallets','nano-recovery');
  const recovery=new AttoApplication({directory:source,secrets:{get:async()=>phrase,set:async()=>{}}});
  try{await recovery.createWallet(phrase);}finally{await recovery.close();}
  const before=await snapshot(home),questions=[];
  // When the person explicitly chooses that prepared source instead of using the selected root or importing again.
  const plan=await prepareNanoWalletInteractive({home,env:{},origin,audience,prompt:async question=>{
    questions.push(question);
    if(question.startsWith('Nano wallet:')){assert.match(question,/\[3\] Continue prepared recovery at/);return '3';}
    if(question.startsWith('Nano access:'))return '1';
    return assert.fail('Prepared recovery should need no storage or import prompt');
  }});
  await plan.validate();
  // Then its existing identity is reviewed, no state changes before approval, and the default empty Nano target stays available.
  assert.deepEqual(await snapshot(home),before);assert.equal(plan.wallet.directory,join(home,'wallets','nano'));
  assert.equal(plan.intent.configuration.keySource.recoverySource.directory,source);
  assert.equal(questions.length,2);assert.match(plan.review,/Login only/);
}));

for(const rolling24hAtomic of ['0',(10n*10n**30n).toString()])test(`existing transfer-enabled Nano retains intentional zero payment cap with rolling cap ${rolling24hAtomic}`,async t=>terminal(async()=>{
  // Given approved transfer access with an intentional finite zero payment cap and a populated journal.
  const f=await nanoCapFixture(t),limits={maxPaymentAtomic:'0',rolling24hAtomic};
  await approveNanoWalletPolicy({dataDir:f.directory,grants:{...f.config.grants,externalTransfers:true},limits,terminalConfirmed:true});
  const before=await snapshot(f.home),script=interaction(['','APPROVE']);
  // When the person accepts the saved Limited default and its exact review.
  await setupNanoWalletInteractive({...f,origin,audience,prompt:script.prompt});
  // Then the zero restriction is preserved without cap questions, and receiving authority remains approved.
  assert.deepEqual(await snapshot(f.home),before);
  assert.match(script.questions[1],/\[2\] Limited spending \(default\)/);
  assert.match(script.questions.at(-1),/Limited spending \(zero limits block payments\)/);
  assert.match(script.questions.at(-1),/Maximum per payment: 0 XNO/);
  assert.equal(script.questions.some(question=>question.startsWith('Maximum XNO')),false);
  const config=JSON.parse(await readFile(join(f.directory,'wallet.json'),'utf8'));
  assert.equal(config.grants.externalTransfers,true);assert.deepEqual(config.limits,limits);
}));

test('Login-only Nano with zero caps asks for positive caps when Limited is explicitly selected',async t=>terminal(async()=>{
  // Given denied transfer access with default zero caps and its retained journal.
  const f=await nanoCapFixture(t),journal=await readFile(join(f.directory,'nano-wallet.sqlite3'));
  const script=interaction(['2','0.5','2','APPROVE']);
  // When the person explicitly enables Limited spending and approves positive limits.
  await setupNanoWalletInteractive({...f,origin,audience,prompt:script.prompt});
  // Then both cap fields are requested and exactly those limits enable transfers without changing the journal.
  assert.match(script.questions[1],/\[1\] Login only \(default\)/);
  assert.equal(script.questions.filter(question=>question.startsWith('Maximum XNO per payment')).length,1);
  assert.equal(script.questions.filter(question=>question.startsWith('Maximum XNO over rolling')).length,1);
  const config=JSON.parse(await readFile(join(f.directory,'wallet.json'),'utf8'));
  assert.equal(config.grants.externalTransfers,true);
  assert.deepEqual(config.limits,{maxPaymentAtomic:(5n*10n**29n).toString(),rolling24hAtomic:(2n*10n**30n).toString()});
  assert.deepEqual(await readFile(join(f.directory,'nano-wallet.sqlite3')),journal);
}));
