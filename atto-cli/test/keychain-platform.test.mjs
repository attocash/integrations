import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const secretsUrl = new URL('../dist/storage/secrets.js', import.meta.url).href;
const syntheticPhrase = 'synthetic recovery phrase for isolated credential persistence test';

function runSecret(operation, account, options = {}) {
  const source = `
    import { OsSecretStore } from ${JSON.stringify(secretsUrl)};
    process.once('message', async ({ operation, account, service, secret }) => {
      try {
        const store = new OsSecretStore(account, service);
        const value = operation === 'set' ? await store.set(secret) : operation === 'get' ? await store.get() : await store.remove();
        process.send({ success: true, value });
      } catch (error) { process.send({ success: false, code: error.code, message: error.message }); }
      finally { process.disconnect(); }
    });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stdout = '';
    let stderr = '';
    let response;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('message', (message) => { response = message; });
    child.on('exit', (code) => {
      if (code !== 0 || !response) reject(new Error(`Credential subprocess failed (${code}). ${stderr}`));
      else resolve({ ...response, stdout, stderr });
    });
    // Recovery material is sent through IPC, never process arguments or env vars.
    child.send({ operation, account, service: options.service, secret: options.secret });
  });
}

function fakeSecretTool(t) {
  const directory = mkdtempSync(join(tmpdir(), 'atto-secret-tool-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const data = join(directory, 'synthetic-secret');
  const args = join(directory, 'arguments.jsonl');
  const executable = join(directory, 'secret-tool');
  writeFileSync(executable, `#!${process.execPath}
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.ATTO_FAKE_ARGS, JSON.stringify(args) + '\\n');
    const attributes = {};
    for (let index = args[0] === 'store' ? 2 : 1; index < args.length; index += 2) attributes[args[index]] = args[index + 1];
    const key = Buffer.from(JSON.stringify([attributes.service, attributes.account, attributes.key_type])).toString('hex');
    const file = process.env.ATTO_FAKE_DATA + '.' + key;
    if (process.env.ATTO_FAKE_MODE === 'failure') {
      process.stdin.resume();
      process.stdin.on('end', () => { process.stderr.write('synthetic secret diagnostic'); process.exitCode = 1; });
    } else if (args[0] === 'lookup') {
      if (fs.existsSync(file)) process.stdout.write(fs.readFileSync(file));
      else process.exitCode = 1;
    } else if (args[0] === 'store') {
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => fs.writeFileSync(file, input));
    } else if (args[0] === 'clear') fs.rmSync(file, { force: true });
    else process.exitCode = 2;
  `, { mode: 0o700 });
  const env = { PATH: directory, ATTO_FAKE_DATA: data, ATTO_FAKE_ARGS: args };
  return {
    env,
    data: (service, account) => `${data}.${Buffer.from(JSON.stringify([service, account, 'mnemonic'])).toString('hex')}`,
    arguments: () => readFileSync(args, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
  };
}

test('Linux credential adapter sends exact secret through stdin and keeps diagnostics private', { skip: process.platform !== 'linux', timeout: 15_000 }, async (t) => {
  // Given
  const fake = fakeSecretTool(t);
  const { env } = fake;
  const account = `test-${randomUUID()}`;

  // When
  const absent = await runSecret('get', account, { env });
  const saved = await runSecret('set', account, { env, secret: syntheticPhrase });
  const persisted = await runSecret('get', account, { env });
  const storedBytes = readFileSync(fake.data('Atto MCP', account), 'utf8');
  const failure = await runSecret('set', account, { env: { ...env, ATTO_FAKE_MODE: 'failure' }, secret: syntheticPhrase });
  const cleared = await runSecret('remove', account, { env });
  const deleted = await runSecret('get', account, { env });

  // Then
  assert.equal(absent.value, null);
  assert.equal(saved.success, true);
  assert.equal(persisted.value, syntheticPhrase);
  assert.equal(storedBytes, syntheticPhrase);
  assert.equal(cleared.success, true);
  assert.equal(deleted.value, null);
  assert.equal(failure.code, 'SECRET_STORE_UNAVAILABLE');
  assert.equal(failure.message.includes('synthetic secret diagnostic'), false);
  const argumentsLog = JSON.stringify(fake.arguments());
  assert.equal(argumentsLog.includes(syntheticPhrase), false);
  assert.deepEqual(fake.arguments().find(args => args[0] === 'store'), [
    'store', '--label=Atto MCP', 'service', 'Atto MCP', 'account', account, 'key_type', 'mnemonic',
  ]);
  for (const result of [absent, saved, persisted, failure, cleared, deleted]) {
    assert.equal(result.stdout.includes(syntheticPhrase), false);
    assert.equal(result.stderr.includes(syntheticPhrase), false);
    assert.equal(result.stderr.includes('synthetic secret diagnostic'), false);
  }
});

test('Linux CLI and MCP services store distinct secrets for the same account without moving existing credentials', {
  skip: process.platform !== 'linux', timeout: 15_000,
}, async t => {
  // Given
  const fake = fakeSecretTool(t);
  const account = `test-${randomUUID()}`;
  const cliPhrase = 'synthetic CLI recovery phrase in an isolated temporary store';
  const legacy = await runSecret('set', account, { env: fake.env, secret: syntheticPhrase });
  assert.equal(legacy.success, true);

  // When
  const absentCli = await runSecret('get', account, { env: fake.env, service: 'Atto CLI' });
  const savedCli = await runSecret('set', account, { env: fake.env, service: 'Atto CLI', secret: cliPhrase });
  const restoredCli = await runSecret('get', account, { env: fake.env, service: 'Atto CLI' });
  const restoredLegacy = await runSecret('get', account, { env: fake.env });
  const clearedCli = await runSecret('remove', account, { env: fake.env, service: 'Atto CLI' });
  const preservedLegacy = await runSecret('get', account, { env: fake.env });

  // Then
  assert.equal(absentCli.value, null);
  assert.equal(savedCli.success, true);
  assert.equal(restoredCli.value, cliPhrase);
  assert.equal(restoredLegacy.value, syntheticPhrase);
  assert.equal(clearedCli.success, true);
  assert.equal(preservedLegacy.value, syntheticPhrase);
  assert.equal(readFileSync(fake.data('Atto MCP', account), 'utf8'), syntheticPhrase);
  assert.deepEqual(fake.arguments().filter(args => args[0] === 'store'), [
    ['store', '--label=Atto MCP', 'service', 'Atto MCP', 'account', account, 'key_type', 'mnemonic'],
    ['store', '--label=Atto CLI', 'service', 'Atto CLI', 'account', account, 'key_type', 'mnemonic'],
  ]);
  const argumentsLog = JSON.stringify(fake.arguments());
  assert.equal(argumentsLog.includes(syntheticPhrase), false);
  assert.equal(argumentsLog.includes(cliPhrase), false);
  for (const result of [legacy, absentCli, savedCli, restoredCli, restoredLegacy, clearedCli, preservedLegacy]) {
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});

test('Linux credential adapter fails closed when secret-tool is missing', { skip: process.platform !== 'linux', timeout: 10_000 }, async (t) => {
  // Given
  const directory = mkdtempSync(join(tmpdir(), 'atto-no-secret-tool-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  // When
  const result = await runSecret('set', `test-${randomUUID()}`, { env: { PATH: directory }, secret: syntheticPhrase });

  // Then
  assert.equal(result.success, false);
  assert.equal(result.code, 'SECRET_STORE_UNAVAILABLE');
  assert.equal(result.stdout.includes(syntheticPhrase), false);
  assert.equal(result.stderr.includes(syntheticPhrase), false);
});

test('OS password store persists across processes with isolated entry cleanup', {
  skip: process.env.ATTO_TEST_KEYCHAIN !== '1' ? 'Set ATTO_TEST_KEYCHAIN=1 in an isolated unlocked credential-store session.' : false,
  timeout: 180_000,
}, async (t) => {
  // Given
  const account = `test-${randomUUID()}`;
  t.after(async () => {
    const removed = await runSecret('remove', account);
    assert.equal(removed.success, true, removed.message);
  });
  const absent = await runSecret('get', account);
  assert.equal(absent.success, true, absent.message);
  assert.equal(absent.value, null);

  // When
  const saved = await runSecret('set', account, { secret: syntheticPhrase });
  const restored = await runSecret('get', account);

  // Then
  assert.equal(saved.success, true, saved.message);
  assert.equal(restored.success, true, restored.message);
  assert.equal(restored.value, syntheticPhrase);
  for (const result of [absent, saved, restored]) {
    assert.equal(result.stdout.includes(syntheticPhrase), false);
    assert.equal(result.stderr.includes(syntheticPhrase), false);
  }
});
