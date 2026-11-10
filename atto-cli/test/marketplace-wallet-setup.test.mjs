import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import test from 'node:test';

const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const moduleUrl = path => pathToFileURL(join(cliDirectory, 'dist', path)).href;
const { AttoApplication } = await import(moduleUrl('application/app.js'));
const recoveryPhrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

async function fixture(t, initialize = true, { defaultCli = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'marketplace-wallet-setup-'));
  const directory = defaultCli
    ? process.platform === 'win32' ? join(root, 'local', 'Atto CLI')
      : process.platform === 'darwin' ? join(root, 'Library', 'Application Support', 'Atto CLI')
      : join(root, 'xdg', 'atto-cli')
    : join(root, 'marketplace-wallet');
  t.after(() => rm(root, { recursive: true, force: true }));
  const open = () => new AttoApplication({ directory, secrets: {
    get: async () => recoveryPhrase,
    set: async () => {},
    remove: async () => {},
  } });
  if (initialize) {
    const application = open();
    await application.createWallet(recoveryPhrase);
    await application.call('address_derive', { index: 0 });
    await application.close();
    if (defaultCli) await writeFile(join(directory, 'profile.json'), JSON.stringify({ version: 1, credentialService: 'Atto CLI', defaultCli: true }));
  }
  return { root, directory, open, initialize };
}

async function run(f, { terminal = true, controllerIndex = 3, reuseExisting = false, configuration, steps = [] } = {}) {
  const tracePath = join(f.root, 'trace.json');
  const harness = [
    "import os from 'node:os';",
    "import { writeFile } from 'node:fs/promises';",
    "import { syncBuiltinESMExports } from 'node:module';",
    'os.homedir = () => process.env.ATTO_TEST_HOME;',
    'syncBuiltinESMExports();',
    "Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: process.env.ATTO_TEST_TTY === '1' });",
    "Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: process.env.ATTO_TEST_TTY === '1' });",
    'process.stdin.isRaw = false;',
    "process.stdin.on('resume', () => process.stdin.ref?.());",
    "process.stdin.on('pause', () => process.stdin.unref?.());",
    'process.stdin.setRawMode = value => { process.stdin.isRaw = value; return process.stdin; };',
    'const trace = { reads: 0, writes: 0, removals: 0, credentialBindings: [], operations: [] };',
    'let credential = process.env.ATTO_TEST_PHRASE || null;',
    'const { OsSecretStore } = await import(process.env.ATTO_TEST_SECRETS);',
    'OsSecretStore.prototype.get = async function () { trace.reads++; trace.credentialBindings.push({ service: this.service, account: this.account }); return credential; };',
    'OsSecretStore.prototype.set = async value => { trace.writes++; credential = value; };',
    'OsSecretStore.prototype.remove = async () => { trace.removals++; credential = null; };',
    'const { AttoApplication } = await import(process.env.ATTO_TEST_APPLICATION);',
    'const originalCall = AttoApplication.prototype.call;',
    'AttoApplication.prototype.call = async function (name, input) { trace.operations.push(name); if (process.env.ATTO_TEST_REUSE === \'1\' && [\'limits_get\', \'wallet_configure\'].includes(name)) throw new Error(\'Reuse must not reconcile or configure\'); return originalCall.call(this, name, input); };',
    'const { setupMarketplaceWallet } = await import(process.env.ATTO_TEST_ONBOARDING);',
    'try { trace.result = await setupMarketplaceWallet({ directory: process.env.ATTO_TEST_DIRECTORY, controllerIndex: Number(process.env.ATTO_TEST_INDEX), reuseExisting: process.env.ATTO_TEST_REUSE === \'1\', configuration: JSON.parse(process.env.ATTO_TEST_CONFIGURATION) ?? undefined }); }',
    'catch (error) { trace.error = { code: error.code, message: error.message }; }',
    'trace.hasCredential = credential !== null;',
    'await writeFile(process.env.ATTO_TEST_TRACE, JSON.stringify(trace));',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '--eval', harness], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      XDG_DATA_HOME: join(f.root, 'xdg'),
      LOCALAPPDATA: join(f.root, 'local'),
      ATTO_TEST_HOME: f.root,
      ATTO_TEST_TTY: terminal ? '1' : '0',
      ATTO_TEST_PHRASE: f.initialize ? recoveryPhrase : '',
      ATTO_TEST_DIRECTORY: f.directory,
      ATTO_TEST_INDEX: String(controllerIndex),
      ATTO_TEST_REUSE: reuseExisting ? '1' : '0',
      ATTO_TEST_CONFIGURATION: JSON.stringify(configuration ?? null),
      ATTO_TEST_APPLICATION: moduleUrl('application/app.js'),
      ATTO_TEST_TRACE: tracePath,
      ATTO_TEST_SECRETS: moduleUrl('storage/secrets.js'),
      ATTO_TEST_ONBOARDING: moduleUrl('cli/onboarding.js'),
    },
  });
  let stderr = '';
  let pending = '';
  let stepIndex = 0;
  child.stderr.on('data', async value => {
    stderr += value;
    pending += stripVTControlCharacters(value.toString());
    const step = steps[stepIndex];
    if (!step || !pending.includes(step.prompt)) return;
    pending = '';
    stepIndex++;
    await step.beforeAnswer?.();
    child.stdin.write(String(step.answer) + '\n');
  });
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(async () => {
      const trace = await import('node:fs/promises').then(fs => fs.readFile(tracePath, 'utf8')).catch(() => 'unavailable');
      child.kill();
      reject(new Error('Setup helper did not finish: ' + stripVTControlCharacters(stderr) + '\nTrace: ' + trace));
    }, 10_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolve({ code, stderr: stripVTControlCharacters(stderr) }); });
  });
  assert.equal(stepIndex, steps.length, result.stderr);
  const trace = JSON.parse(await (await import('node:fs/promises')).readFile(tracePath, 'utf8'));
  return { ...result, trace };
}

function approvalSteps(answer = 'yes') {
  return [
    { prompt: 'Account pool: [1] Keep current pool (default), [2] Configure account pool: ', answer: '1' },
    { prompt: 'Maximum ATTO per payment: ', answer: '3' },
    { prompt: 'Maximum ATTO across a rolling 24 hours: ', answer: '8' },
    { prompt: 'Type yes to approve this exact proposal: ', answer },
  ];
}

test('Given no TTY, when Marketplace wallet setup runs, then it exits before filesystem or secret-store access', async t => {
  const f = await fixture(t, false);

  const result = await run(f, { terminal: false, controllerIndex: 2 });

  assert.equal(result.trace.error?.code, 'TERMINAL_REQUIRED');
  assert.equal(result.trace.reads, 0);
  assert.equal(result.trace.writes, 0);
  assert.equal(result.trace.removals, 0);
  assert.equal(result.trace.hasCredential, false);
  await assert.rejects(access(f.directory));
});

test('Given an initialized profile, when approval is declined, then current access and spending limits remain unchanged', async t => {
  const f = await fixture(t);
  const initialPolicy = { perRequest: { amount: '5', unit: 'ATTO' }, rolling: [{ days: 1, amount: '10', unit: 'ATTO' }] };
  const setup = f.open();
  setup.ledger.setPolicy(initialPolicy);
  await setup.close();

  const result = await run(f, { controllerIndex: 2, steps: approvalSteps('no') });
  const after = f.open();
  const access = after.ledger.mcpAccess();
  const policy = after.ledger.policy();
  const indexes = after.ledger.messageSigningIndexes();
  await after.close();

  assert.equal(result.trace.error?.code, 'CANCELLED');
  assert.match(result.stderr, /already has a wallet\. Setup will reuse its funds and spending history/);
  assert.equal(access, 'read-only');
  assert.deepEqual(policy, initialPolicy);
  assert.deepEqual(indexes, []);
});

test('Given an initialized profile, when the local terminal approves, then bounded spend and the chosen message-signing index are saved', async t => {
  const f = await fixture(t);

  const result = await run(f, { controllerIndex: 3, steps: approvalSteps() });
  const after = f.open();
  const status = await after.call('wallet_status');
  const access = after.ledger.mcpAccess();
  const policy = after.ledger.policy();
  const indexes = after.ledger.messageSigningIndexes();
  await after.close();
  const files = await readdir(f.directory);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.trace.error, undefined);
  assert.deepEqual(result.trace.result, {
    directory: f.directory,
    address: status.addresses.find(address => address.index === 3).address,
    index: 3,
  });
  assert.equal(access, 'spend');
  assert.deepEqual(policy, {
    perRequest: { amount: '3', unit: 'ATTO' },
    rolling: [{ days: 1, amount: '8', unit: 'ATTO' }],
  });
  assert.deepEqual(indexes, [3]);
  assert.match(result.stderr, /message_sign requires spend access/);
  assert.match(result.stderr, /Marketplace controller account: index 3/);
  assert.match(result.stderr, /Requested message-signing indexes: 3/);
  assert.deepEqual(files.filter(file => file.endsWith('.json')), []);
  assert.equal(Object.keys(result.trace.result).sort().join(','), 'address,directory,index');
  assert.equal(result.trace.writes, 0);
  assert.equal(result.trace.removals, 0);
});


const sharedPolicy = { perRequest: { amount: '5', unit: 'ATTO' }, rolling: [{ days: 2, amount: '12', unit: 'ATTO' }] };

async function snapshot(f) {
  const application = f.open();
  try {
    return {
      identity: application.store.get('identity'), settings: application.store.get('settings'),
      access: application.ledger.mcpAccess(), policy: application.ledger.policy(), pool: application.ledger.pool(),
      indexes: application.ledger.messageSigningIndexes(), journal: application.store.get('spending.records'),
    };
  } finally { await application.close(); }
}

async function sharedWallet(f, { access = 'spend', policy = sharedPolicy } = {}) {
  const application = f.open();
  try {
    const status = await application.call('wallet_status');
    application.store.set('settings', { ...status.settings, network: 'LOCAL', nodeUrl: 'http://127.0.0.1:41234', workerUrl: 'http://127.0.0.1:41235', autoReceive: false });
    const { proposal } = await application.call('limits_propose', { policy, access, pool: { indexes: [0, 2], consolidate: true }, messageSigningIndexes: [1, 7] });
    await application.approveLimitsProposal(proposal.id);
    application.ledger.reserve({ id: 'retained-payment', index: 0, destination: status.identity.address, raw: '1000', network: 'LOCAL', createdAt: Date.now() });
  } finally { await application.close(); }
  return snapshot(f);
}

function reuseSteps(answer = 'yes', policyChoice = '1') {
  return [
    { prompt: 'Account pool: [1] Keep current pool (default), [2] Configure account pool: ', answer: '' },
    { prompt: 'Spending policy: [1] Keep current bounded limits (default), [2] Set new bounded limits: ', answer: policyChoice },
    ...(policyChoice === '2' ? [
      { prompt: 'Maximum ATTO per payment: ', answer: '2' },
      { prompt: 'Maximum ATTO across a rolling 24 hours: ', answer: '6' },
    ] : []),
    { prompt: 'Type yes to approve this exact proposal: ', answer },
  ];
}

test('Given explicit existing-wallet reuse without a TTY, then no wallet directory or credential is touched', async t => {
  const f = await fixture(t, false);
  const result = await run(f, { terminal: false, reuseExisting: true });
  assert.equal(result.trace.error?.code, 'TERMINAL_REQUIRED');
  assert.equal(result.trace.reads + result.trace.writes + result.trace.removals, 0);
  await assert.rejects(access(f.directory));
});

test('Given a missing existing wallet, then reuse refuses without creating state or importing a phrase', async t => {
  const f = await fixture(t, false);
  const result = await run(f, { reuseExisting: true });
  assert.equal(result.trace.error?.code, 'WALLET_NOT_INITIALIZED');
  assert.equal(result.trace.reads + result.trace.writes + result.trace.removals, 0);
  await assert.rejects(access(f.directory));
  assert.doesNotMatch(result.stderr, /Import a recovery phrase|Create a new wallet/);
});

test('Given an uninitialized existing state database, then reuse refuses without reading or writing credentials', async t => {
  const f = await fixture(t, false);
  await f.open().close();
  const result = await run(f, { reuseExisting: true });
  assert.equal(result.trace.error?.code, 'WALLET_NOT_INITIALIZED');
  assert.equal(result.trace.reads + result.trace.writes + result.trace.removals, 0);
  assert.equal((await snapshot(f)).identity, undefined);
});

test('Given a shared CLI wallet, approving reuse preserves settings, bounded policy, pool, journals, and all prior signing grants', async t => {
  const f = await fixture(t);
  const before = await sharedWallet(f);
  const result = await run(f, { reuseExisting: true, controllerIndex: 3, configuration: {
    network: before.settings.network, nodeUrl: before.settings.nodeUrl, workerUrl: before.settings.workerUrl,
  }, steps: reuseSteps() });
  const after = await snapshot(f);
  assert.equal(result.trace.error, undefined, result.stderr);
  assert.deepEqual(after, { ...before, indexes: [1, 3, 7] });
  assert.equal(result.trace.writes + result.trace.removals, 0);
  assert.deepEqual(Object.keys(result.trace.result).sort(), ['address', 'directory', 'index']);
  assert.equal(result.trace.result.directory, f.directory);
  assert.equal(result.trace.result.index, 3);
  assert.match(result.stderr, /shares its funds, spending grants, payment journals, and account pool/);
  assert.match(result.stderr, /127\.0\.0\.1:41234/);
  assert.match(result.stderr, /Current message-signing indexes: 1, 7/);
  assert.match(result.stderr, /Requested message-signing indexes: 1, 3, 7/);
  assert.doesNotMatch(result.stderr, new RegExp(recoveryPhrase));
  assert.equal(result.trace.operations.includes('wallet_configure'), false);
  assert.equal(result.trace.operations.includes('limits_get'), false);
});

test('Given a shared CLI wallet, declining exact approval preserves active authority, settings, identity, and journals', async t => {
  const f = await fixture(t);
  const before = await sharedWallet(f);
  const result = await run(f, { reuseExisting: true, steps: reuseSteps('no', '2') });
  assert.equal(result.trace.error?.code, 'CANCELLED');
  assert.deepEqual(await snapshot(f), before);
  assert.equal(result.trace.writes + result.trace.removals, 0);
  assert.doesNotMatch(result.stderr, new RegExp(recoveryPhrase));
});

test('Given read-only CLI access with bounded limits, exact local approval enables spend while retaining limits and earlier grants', async t => {
  const f = await fixture(t);
  const before = await sharedWallet(f, { access: 'read-only' });
  const result = await run(f, { reuseExisting: true, steps: reuseSteps() });
  assert.equal(result.trace.error, undefined, result.stderr);
  assert.deepEqual(await snapshot(f), { ...before, access: 'spend', indexes: [1, 3, 7] });
  assert.match(result.stderr, /MCP access: read-only → spend/);
});

test('Given unlimited CLI spending, reuse requires bounded limits before granting the controller', async t => {
  const f = await fixture(t);
  const before = await sharedWallet(f, { policy: { perRequest: null, rolling: [] } });
  const result = await run(f, { reuseExisting: true, steps: approvalSteps() });
  assert.equal(result.trace.error, undefined, result.stderr);
  assert.deepEqual(await snapshot(f), { ...before, policy: { perRequest: { amount: '3', unit: 'ATTO' }, rolling: [{ days: 1, amount: '8', unit: 'ATTO' }] }, indexes: [1, 3, 7] });
  assert.match(result.stderr, /current policy is unlimited/);
});

test('Given the default CLI profile, dedicated setup refuses it and explicit reuse retains its credential metadata', async t => {
  const f = await fixture(t, true, { defaultCli: true });
  const before = await sharedWallet(f);
  const metadata = await readFile(join(f.directory, 'profile.json'), 'utf8');
  const dedicated = await run(f);
  assert.equal(dedicated.trace.error?.code, 'PROFILE_CONFLICT');
  assert.equal(dedicated.trace.reads + dedicated.trace.writes + dedicated.trace.removals, 0);
  const result = await run(f, { reuseExisting: true, steps: reuseSteps() });
  assert.equal(result.trace.error, undefined, result.stderr);
  assert.deepEqual(await snapshot(f), { ...before, indexes: [1, 3, 7] });
  assert.equal(await readFile(join(f.directory, 'profile.json'), 'utf8'), metadata);
  assert.ok(result.trace.credentialBindings.length > 0);
  assert.ok(result.trace.credentialBindings.every(binding => binding.service === 'Atto CLI'));
  assert.equal(result.trace.writes + result.trace.removals, 0);
});


test('Given selected dedicated-wallet network settings, then the exact limits proposal uses that network before approval', async t => {
  const f = await fixture(t, false);
  const configuration = { network: 'LOCAL', nodeUrl: 'http://127.0.0.1:41236', workerUrl: 'http://127.0.0.1:41237' };
  const result = await run(f, { configuration, steps: [
    { prompt: 'Wallet is not initialized. [1] Create a new wallet (default), [2] Import a recovery phrase: ', answer: '2' },
    { prompt: 'Type yes to store this wallet in the OS password store: ', answer: 'yes' },
    { prompt: 'Recovery phrase (hidden): ', answer: recoveryPhrase },
    ...approvalSteps(),
  ] });
  assert.equal(result.trace.error, undefined, result.stderr);
  assert.match(result.stderr, /Network: "LOCAL"/);
  const after = await snapshot(f);
  assert.equal(after.settings.network, configuration.network);
  assert.equal(after.settings.nodeUrl, configuration.nodeUrl);
  assert.equal(after.settings.workerUrl, configuration.workerUrl);
  const application = f.open();
  try { assert.equal(application.ledger.proposal().network, 'LOCAL'); }
  finally { await application.close(); }
  assert.ok(result.trace.operations.indexOf('wallet_configure') < result.trace.operations.indexOf('limits_propose'));
});

test('Given mismatched requested settings for a shared CLI wallet, then reuse rejects without changing settings, authority, or the existing proposal', async t => {
  const f = await fixture(t);
  const before = await sharedWallet(f);
  const application = f.open();
  const proposal = application.ledger.proposal();
  await application.close();
  const result = await run(f, { reuseExisting: true, configuration: {
    network: 'LIVE', nodeUrl: 'http://127.0.0.1:41236', workerUrl: 'http://127.0.0.1:41237',
  } });
  assert.equal(result.trace.error?.code, 'PROFILE_CONFLICT');
  assert.deepEqual(await snapshot(f), before);
  const after = f.open();
  try { assert.deepEqual(after.ledger.proposal(), proposal); }
  finally { await after.close(); }
  assert.equal(result.trace.reads + result.trace.writes + result.trace.removals, 0);
  assert.deepEqual(result.trace.operations, ['wallet_status']);
});


test('identical existing authority skips proposal creation and approval while preserving a different pending proposal', async t => {
  // Given a shared wallet whose existing controller already has the requested grants.
  const f = await fixture(t);
  const before = await sharedWallet(f);
  const application = f.open();
  let pending;
  try {
    await application.call('address_derive', { index: 1 });
    pending = application.ledger.proposePolicy({ perRequest: { amount: '1', unit: 'ATTO' }, rolling: [] }, 'read-only', {
      directory: f.directory, walletFingerprint: before.identity.fingerprint, network: before.settings.network,
    });
  } finally { await application.close(); }

  // When setup keeps the exact active access, policy, pool, and signing indexes.
  const result = await run(f, { reuseExisting: true, controllerIndex: 1, steps: reuseSteps().slice(0, -1) });

  // Then the separate pending proposal survives and no redundant approval is requested.
  assert.equal(result.trace.error, undefined, result.stderr);
  assert.deepEqual(await snapshot(f), before);
  const after = f.open();
  try { assert.deepEqual(after.ledger.proposal(), pending); }
  finally { await after.close(); }
  assert.doesNotMatch(result.stderr, /Type yes to approve this exact proposal/);
  assert.equal(result.trace.operations.includes('limits_propose'), false);
  assert.equal(result.trace.reads + result.trace.writes + result.trace.removals, 0);
});


test('a no-op authority selection still rejects a wallet change made during terminal questions', async t => {
  // Given matching active grants that another session changes during review.
  const f = await fixture(t);
  await sharedWallet(f);
  const application = f.open();
  try { await application.call('address_derive', { index: 1 }); }
  finally { await application.close(); }
  const steps = reuseSteps().slice(0, -1);
  steps.at(-1).beforeAnswer = async () => {
    const concurrent = f.open();
    try { await concurrent.store.withWalletLock(async () => concurrent.store.set('spending.mcpAccess', 'read-only')); }
    finally { await concurrent.close(); }
  };

  // When setup would otherwise skip a redundant proposal.
  const result = await run(f, { reuseExisting: true, controllerIndex: 1, steps });

  // Then the current snapshot is checked first and the new authority remains intact.
  assert.equal(result.trace.error?.code, 'PROPOSAL_STALE', result.stderr);
  assert.equal((await snapshot(f)).access, 'read-only');
  assert.doesNotMatch(result.stderr, /Type yes to approve this exact proposal/);
});


test('a no-op authority selection preserves the reset fence after terminal questions', async t => {
  // Given matching grants and a reset interrupted during terminal review.
  const f = await fixture(t);
  await sharedWallet(f);
  const application = f.open();
  try { await application.call('address_derive', { index: 1 }); }
  finally { await application.close(); }
  const steps = reuseSteps().slice(0, -1);
  steps.at(-1).beforeAnswer = async () => {
    const concurrent = f.open();
    try { await concurrent.store.withWalletLock(async () => concurrent.store.set('wallet.reset', { interrupted: true })); }
    finally { await concurrent.close(); }
  };

  // When unchanged authority would otherwise skip proposal approval.
  const result = await run(f, { reuseExisting: true, controllerIndex: 1, steps });

  // Then setup still requires reset recovery and never reports success.
  assert.equal(result.trace.error?.code, 'WALLET_RESET_REQUIRED', result.stderr);
  assert.equal(result.trace.result, undefined);
  assert.doesNotMatch(result.stderr, /Type yes to approve this exact proposal/);
});
