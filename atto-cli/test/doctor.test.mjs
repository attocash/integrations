import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { check, cliMain, diagnostic, doctorFixture, filesSnapshot, moduleUrl, phrase, updateState } from './support/doctor.mjs';

const linux = { skip: process.platform !== 'linux' };

test('Human doctor guidance uses safely quoted commands while JSON retains argument arrays', async () => {
  const { formatHumanResult } = await import(moduleUrl('cli/output.js'));
  const command = ['atto', '--data-dir', "/tmp/wallet '$(synthetic)'", 'wallet', 'create'];
  const report = { status: 'warn', context: { interface: 'cli' }, checks: [{ id: 'wallet.initialization', status: 'warn', code: 'WALLET_NOT_INITIALIZED', message: 'Create a wallet.', remediation: { steps: [], command } }], durationMs: 1 };
  const output = formatHumanResult(report, 'doctor');
  assert.match(output, /Command(?: \(PowerShell\))?: atto --data-dir '/);
  assert.ok(output.includes(process.platform === 'win32' ? "'/tmp/wallet ''$(synthetic)'''" : "'/tmp/wallet '\\''$(synthetic)'\\'''"));
  assert.doesNotMatch(output, /\["atto"/);
  assert.deepEqual(report.checks[0].remediation.command, command);
});

test('CLI doctor verifies real APIs, stream, fresh work, and credential without wallet mutations', linux, async t => {
  // Given an initialized, receive-enabled wallet with an isolated credential backend.
  const f = await doctorFixture(t);
  const before = await filesSnapshot(f.directory);

  // When the human command and generic JSON operation both run full diagnostics.
  const human = await f.run(['doctor']);
  const json = await f.run(['--json', 'call', 'doctor']);

  // Then each probe succeeds while recovery material and wallet writes remain absent.
  assert.equal(human.code, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /Doctor: PASS/);
  assert.match(human.stdout, /\[PASS\] keyring.credential/);
  assert.doesNotMatch(human.stdout, /"result"\s*:/);
  assert.equal(json.code, 0, json.stdout + json.stderr);
  for (const id of ['runtime', 'profile', 'keyring.credential', 'node.time', 'node.account', 'node.network', 'node.stream', 'worker.work']) assert.equal(check(json.report, id).status, 'pass');
  assert.equal(check(json.report, 'usd.price').status, 'skipped');
  assert.equal(json.report.context.directory, f.directory);
  assert.equal(json.report.context.credentialService, 'Atto MCP');
  assert.equal(new Set(f.state.works.map(work => work.target)).size, 2, 'Each run must request fresh work.');
  assert.ok(f.state.requests.every(path => /^GET \/(?:instants|accounts)\//.test(path) || path === 'POST /works'));
  assert.ok(!f.state.requests.some(path => path.includes('receivable')));
  const trace = await f.fake.trace();
  assert.equal(trace.length, 2);
  assert.ok(trace.every(value => value.args[0] === 'lookup' && value.args[2] === json.report.context.credentialService && value.args[4] === json.report.context.credentialAccount));
  assert.ok(!JSON.stringify(trace).includes(phrase));
  assert.deepEqual(await filesSnapshot(f.directory), before);
});

test('Credential failures stay distinct, sanitized, and do not hide healthy network checks', linux, async t => {
  const f = await doctorFixture(t);
  for (const [mode, code] of [['missing', 'KEYRING_CREDENTIAL_MISSING'], ['failure', 'KEYRING_UNAVAILABLE']]) {
    const { report, code: exitCode } = await f.run(['--json', 'doctor'], { ATTO_FAKE_MODE: mode });
    assert.equal(exitCode, 1);
    assert.equal(check(report, 'keyring.credential').code, code);
    assert.equal(check(report, 'worker.work').status, 'pass');
    assert.ok(!JSON.stringify(report).includes(diagnostic));
  }
  await writeFile(f.fake.data, 'invalid synthetic recovery phrase');
  assert.equal(check((await f.run()).report, 'keyring.credential').code, 'KEYRING_CREDENTIAL_INVALID');
  await writeFile(f.fake.data, phrase);
  updateState(f.directory, 'identity', { ...f.identity, fingerprint: '00'.repeat(32) });
  assert.equal(check((await f.run()).report, 'keyring.credential').code, 'KEYRING_CREDENTIAL_MISMATCH');
  const missing = await f.run(['--json', 'doctor'], { PATH: join(f.directory, 'nonexistent-bin') });
  assert.equal(check(missing.report, 'keyring.backend').code, 'SECRET_TOOL_MISSING');
  assert.equal(check(missing.report, 'keyring.credential').status, 'skipped');
});

test('An alternative Linux session environment is suggested only after matching the credential', linux, async t => {
  const f = await doctorFixture(t);
  const runtime = join(f.fake.directory, 'runtime');
  await mkdir(runtime, { mode: 0o700 });
  const socket = createServer();
  socket.listen(join(runtime, 'bus'));
  await once(socket, 'listening');
  t.after(() => new Promise(resolve => socket.close(resolve)));
  const bus = `unix:path=${join(runtime, 'bus')}`;
  const env = { XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: '', ATTO_FAKE_BUS: bus };
  const failing = await f.run(['--json', 'doctor'], env);
  const credential = check(failing.report, 'keyring.credential');
  assert.equal(credential.code, 'KEYRING_ENVIRONMENT_FIX_VERIFIED');
  assert.equal(credential.status, 'fail', 'The running process is still broken until its launcher changes.');
  assert.deepEqual(credential.remediation.suggestedEnv, { DBUS_SESSION_BUS_ADDRESS: bus, XDG_RUNTIME_DIR: runtime });
  assert.equal(credential.remediation.restartRequired, true);
  assert.equal(check(failing.report, 'keyring.environment').evidence.sessionBusAddressPresent, false);
  assert.equal((await f.fake.trace()).length, 2);
  const working = await f.run(['--json', 'doctor'], { ...env, ...credential.remediation.suggestedEnv });
  assert.equal(check(working.report, 'keyring.credential').code, 'KEYRING_CREDENTIAL_MATCHED');
  updateState(f.directory, 'identity', { ...f.identity, fingerprint: '00'.repeat(32) });
  const mismatch = check((await f.run(['--json', 'doctor'], env)).report, 'keyring.credential');
  assert.equal(mismatch.code, 'KEYRING_UNAVAILABLE');
  assert.equal(mismatch.remediation.suggestedEnv, undefined, 'A different credential cannot verify an environment fix.');
});

test('Node and worker failures are independently diagnosed without copying response bodies', linux, async t => {
  const f = await doctorFixture(t);
  for (const [field, value, id, code] of [
    ['time', 'invalid', 'node.time', 'INVALID_NODE_RESPONSE'],
    ['time', 'http', 'node.time', 'NODE_HTTP_ERROR'],
    ['account', 'invalid', 'node.account', 'INVALID_NODE_RESPONSE'],
    ['account', 'mismatch', 'node.account', 'ACCOUNT_MISMATCH'],
    ['stream', 'http', 'node.stream', 'NODE_STREAM_ERROR'],
    ['worker', 'http', 'worker.work', 'WORK_FAILED'],
    ['worker', 'malformed', 'worker.work', 'INVALID_WORK'],
    ['worker', 'invalid', 'worker.work', 'INVALID_WORK'],
  ]) {
    const original = f.state[field];
    f.state[field] = value;
    const { report, code: exitCode } = await f.run();
    assert.equal(exitCode, 1);
    assert.equal(check(report, id).code, code);
    assert.equal(check(report, 'keyring.credential').status, 'pass');
    if (value === 'http' && field !== 'stream') assert.equal(check(report, id).evidence.httpStatus, 503);
    f.state[field] = original;
  }
  f.state.network = 'BETA';
  assert.equal(check((await f.run()).report, 'node.network').code, 'NETWORK_MISMATCH');
  f.state.network = 'LOCAL';
  f.state.time = 'skew';
  const skew = await f.run();
  assert.equal(skew.code, 0);
  assert.equal(check(skew.report, 'node.time').code, 'CLOCK_SKEW');
});

test('Unopened wallet accounts use representative snapshots and do not fail for zero balance', linux, async t => {
  const f = await doctorFixture(t);
  f.state.account = 'unopened';
  const { report, code } = await f.run();
  assert.equal(code, 0);
  assert.equal(check(report, 'node.account').code, 'ACCOUNT_NOT_OPEN');
  assert.equal(check(report, 'node.representative').status, 'pass');
  assert.equal(check(report, 'node.network').status, 'pass');
  assert.equal(check(report, 'node.stream').status, 'pass');
  f.state.account = 'missing';
  const missing = (await f.run()).report;
  assert.equal(check(missing, 'node.stream').status, 'skipped');
  assert.equal(check(missing, 'node.network').status, 'skipped');
});

test('Corrupt and future state can be diagnosed without application startup or fallback endpoints', linux, async t => {
  const f = await doctorFixture(t);
  const file = join(f.directory, 'state.sqlite');
  for (const corrupt of [false, true]) {
    if (corrupt) await writeFile(file, 'synthetic corrupt database');
    else {
      const db = new DatabaseSync(file);
      db.exec('PRAGMA user_version = 99');
      db.close();
    }
    const before = await filesSnapshot(f.directory);
    const { report, code } = await f.run();
    assert.equal(code, 1);
    assert.equal(check(report, 'profile').status, 'fail');
    if (!corrupt) assert.equal(check(report, 'profile').code, 'STATE_VERSION');
    assert.equal(check(report, 'keyring.credential').status, 'skipped');
    assert.equal(report.context.nodeUrl, undefined);
    assert.deepEqual(f.state.requests, []);
    assert.deepEqual(await f.fake.trace(), []);
    assert.deepEqual(await filesSnapshot(f.directory), before);
  }
});

test('Doctor reads committed WAL state from an open wallet and leaves its settings intact', async t => {
  const f = await doctorFixture(t);
  const { readDoctorProfile } = await import(moduleUrl('doctor/profile.js'));
  const db = new DatabaseSync(join(f.directory, 'state.sqlite'));
  try {
    db.exec('PRAGMA wal_autocheckpoint = 0');
    const settings = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'settings'").get().value);
    settings.nodeUrl = 'http://127.0.0.1:12345';
    db.prepare("UPDATE settings SET value = ? WHERE key = 'settings'").run(JSON.stringify(settings));
    const before = await filesSnapshot(f.directory);
    const inspected = readDoctorProfile(f.directory);
    assert.equal(inspected.settings.nodeUrl, settings.nodeUrl);
    assert.deepEqual(await filesSnapshot(f.directory), before);
  } finally { db.close(); }
});

test('Profile permission and pending-reset checks report problems without fixing or reconciling them', linux, async t => {
  const f = await doctorFixture(t);
  await chmod(f.directory, 0o755);
  await chmod(join(f.directory, 'state.sqlite'), 0o644);
  updateState(f.directory, 'wallet.reset', { pending: true });
  updateState(f.directory, 'spending.records', [{ status: 'unknown', metadata: { reason: diagnostic } }]);
  const { report, code } = await f.run();
  assert.equal(code, 1);
  assert.equal(check(report, 'profile.permissions').code, 'PROFILE_PERMISSIONS_BROAD');
  assert.equal(check(report, 'wallet.reset').code, 'WALLET_RESET_REQUIRED');
  assert.equal(check(report, 'wallet.pendingPayments').evidence.count, 1);
  assert.equal((await stat(join(f.directory, 'state.sqlite'))).mode & 0o777, 0o644);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o755);
  assert.ok(!JSON.stringify(report).includes(diagnostic));
});

test('Ctrl+C cancels stalled keyring children, node reads, work, and streams promptly', { ...linux, timeout: 15_000 }, async t => {
  const f = await doctorFixture(t);
  f.state.worker = 'hang';
  f.state.stream = 'silent';
  const child = spawn(process.execPath, [cliMain, '--data-dir', f.directory, '--json', 'doctor'], {
    env: { ...f.env, ATTO_FAKE_MODE: 'hang' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const ended = once(child, 'close');
  const deadline = Date.now() + 8000;
  while (!(await f.fake.trace()).length || !f.state.requests.some(path => path.endsWith('/stream')) || !f.state.works.length) {
    assert.ok(Date.now() < deadline, stdout + stderr);
    await delay(20);
  }
  const started = Date.now();
  child.kill('SIGINT');
  const [code, signal] = await ended;
  assert.equal(code, 1, stdout + stderr);
  assert.equal(signal, null);
  assert.ok(Date.now() - started < 3000);
  const report = JSON.parse(stdout).result;
  assert.equal(check(report, 'keyring.credential').code, 'KEYRING_TIMEOUT');
  assert.equal(check(report, 'worker.work').code, 'CHECK_TIMEOUT');
  assert.equal(check(report, 'node.stream').code, 'NODE_STREAM_UNVERIFIED');
  for (const entry of await f.fake.trace()) {
    for (const pid of [entry.pid, entry.parent]) {
      // On Linux a just-killed grandchild may briefly be a zombie pending reaping.
      try { assert.match(await readFile(`/proc/${pid}/stat`, 'utf8'), /^\d+ \(.+\) Z /); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
});

test('An idle infinite stream reaches the diagnostic deadline as unverified, not a failed receiving connection', { ...linux, timeout: 15_000 }, async t => {
  const f = await doctorFixture(t);
  f.state.stream = 'silent';
  const { report, code } = await f.run();
  assert.equal(code, 0);
  assert.equal(check(report, 'node.stream').status, 'warn');
  assert.equal(check(report, 'node.stream').code, 'NODE_STREAM_UNVERIFIED');
  assert.equal(check(report, 'keyring.credential').status, 'pass');
  assert.ok(report.durationMs >= 10_000 && report.durationMs < 14_000);
});

test('Missing profiles and optional LIVE prices are inspected without creating state or accepting terms', async t => {
  const root = await mkdtemp(join(tmpdir(), 'atto-doctor-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'absent');
  const { runDoctor } = await import(moduleUrl('doctor/doctor.js'));
  const { readDoctorProfile } = await import(moduleUrl('doctor/profile.js'));
  assert.equal(readDoctorProfile(directory).settingsSource, 'defaults');
  const url = 'https://gatekeeper.live.application.atto.cash/projections/metrics';
  const requests = [];
  let date = new Date().toISOString().slice(0, 10);
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    requests.push(String(address));
    if (String(address) === url) return Response.json({ metrics: [{ name: 'price.usd', date, value: '1' }] });
    return new Response(null, { status: 503 });
  });
  // No executable is exposed, so the test cannot contact a real password store.
  const originalPath = process.env.PATH;
  process.env.PATH = join(root, 'absent-bin');
  t.after(() => { process.env.PATH = originalPath; });
  if (process.platform !== 'linux') return; // Native backend probes need their platform-specific harness.
  const report = await runDoctor({ directory, access: 'mcp' });
  assert.equal(report.context.settingsSource, 'defaults');
  assert.equal(check(report, 'usd.price').status, 'pass');
  assert.equal(check(report, 'usd.terms').code, 'USD_TERMS_REQUIRED');
  assert.equal(check(report, 'wallet.mcpAccess').code, 'MCP_READ_ONLY');
  assert.equal(check(report, 'wallet.initialization').status, 'warn');
  date = '2020-01-01';
  assert.equal(check(await runDoctor({ directory }), 'usd.price').code, 'PRICE_STALE');
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  assert.ok(requests.every(address => address.startsWith('https://gatekeeper.live.application.atto.cash/')));
});
