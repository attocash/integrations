import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { AttoAccount, AttoBlock, AttoWork } from '@attocash/commons-core';

export const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../../', import.meta.url));
export const cliMain = join(cliDirectory, 'dist/cli/main.js');
export const moduleUrl = name => pathToFileURL(join(cliDirectory, 'dist', name)).href;
const { AttoApplication } = await import(moduleUrl('application/app.js'));
export const execute = promisify(execFile);
export const phrase = `${'abandon '.repeat(23)}art`;
export const diagnostic = 'synthetic-private-keyring-diagnostic';
export const check = (report, id) => {
  const value = report.checks.find(value => value.id === id);
  assert.ok(value, `Missing check ${id}: ${JSON.stringify(report)}`);
  return value;
};

export async function fakeKeyring(t, secret = phrase) {
  const directory = await mkdtemp(join(tmpdir(), 'atto-doctor-keyring-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = join(directory, 'test-only-credential');
  const trace = join(directory, 'trace.jsonl');
  await writeFile(data, secret, { mode: 0o600 });
  await writeFile(trace, '', { mode: 0o600 });
  await writeFile(join(directory, 'secret-tool'), `#!${process.execPath}
    const fs = require('node:fs');
    fs.appendFileSync(process.env.ATTO_FAKE_TRACE, JSON.stringify({ pid: process.pid, parent: process.ppid, args: process.argv.slice(2) }) + '\\n');
    if (process.argv[2] !== 'lookup') process.exit(5);
    if (process.env.ATTO_FAKE_MODE === 'hang') setInterval(() => {}, 1000);
    else if (process.env.ATTO_FAKE_MODE === 'failure' || (process.env.ATTO_FAKE_BUS && process.env.DBUS_SESSION_BUS_ADDRESS !== process.env.ATTO_FAKE_BUS)) {
      process.stderr.write(${JSON.stringify(diagnostic)}); process.exitCode = 1;
    } else if (process.env.ATTO_FAKE_MODE === 'missing') process.exitCode = 1;
    else process.stdout.write(fs.readFileSync(process.env.ATTO_FAKE_DATA));
  `, { mode: 0o700 });
  return { directory, data, env: { PATH: directory, ATTO_FAKE_DATA: data, ATTO_FAKE_TRACE: trace, DBUS_SESSION_BUS_ADDRESS: '', XDG_RUNTIME_DIR: '' },
    trace: async () => (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) };
}

export function updateState(directory, key, value) {
  const db = new DatabaseSync(join(directory, 'state.sqlite'));
  try { db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value)); }
  finally { db.close(); }
}

export async function filesSnapshot(directory) {
  const entries = await readdir(directory);
  const values = await Promise.all(entries.sort().map(async name => {
    const file = join(directory, name);
    const info = await stat(file);
    // SQLite readers maintain shared-memory coordination and may create an empty
    // WAL. Compare all durable data, including any nonempty WAL, without using
    // immutable reads that would miss a running wallet's committed WAL changes.
    if (name.endsWith('-shm') || (name.endsWith('-wal') && info.size === 0)) return;
    return [name, { mode: info.mode & 0o777, content: info.isDirectory() ? await filesSnapshot(file) : createHash('sha256').update(await readFile(file)).digest('hex') }];
  }));
  return Object.fromEntries(values.filter(Boolean));
}

export async function doctorFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'atto-doctor-wallet-'));
  const fake = await fakeKeyring(t);
  const state = { requests: [], works: [], stream: 'snapshot', account: 'ok', time: 'ok', worker: 'ok' };
  const http = createServer((request, response) => {
    state.requests.push(`${request.method} ${request.url}`);
    const run = async () => {
      if (request.url.startsWith('/instants/')) {
        if (state.time === 'hang') return;
        if (state.time === 'http') { response.writeHead(503); return response.end(diagnostic); }
        const requested = decodeURIComponent(request.url.slice('/instants/'.length));
        return response.end(JSON.stringify({ clientInstant: state.time === 'invalid' ? 'bad' : requested,
          serverInstant: new Date(Date.now() + (state.time === 'skew' ? 300_000 : 0)).toISOString(), differenceMillis: 0 }));
      }
      if (request.url.startsWith('/accounts/')) {
        const publicKey = request.url.split('/')[2];
        const account = AttoAccount.fromJson(JSON.stringify({ network: state.network ?? 'LOCAL', version: 0, algorithm: 'V1',
          publicKey: state.account === 'mismatch' ? '33'.repeat(32) : publicKey,
          height: 1, balance: 1000, lastTransactionHash: '11'.repeat(32), lastTransactionTimestamp: Date.now(),
          representativeAlgorithm: 'V1', representativePublicKey: publicKey }));
        if (request.url.endsWith('/stream')) {
          if (state.stream === 'http') { response.writeHead(503); return response.end(diagnostic); }
          response.setHeader('content-type', 'application/x-ndjson');
          response.flushHeaders();
          if (state.stream === 'snapshot') response.write(`${account.toJson()}\n`);
          return;
        }
        if (state.account === 'missing' || (state.account === 'unopened' && publicKey === state.publicKey)) { response.writeHead(404); return response.end(); }
        if (state.account === 'invalid') return response.end(diagnostic);
        return response.end(account.toJson());
      }
      if (request.url === '/works') {
        let body = '';
        for await (const chunk of request) body += chunk;
        const input = JSON.parse(body);
        state.works.push(input);
        if (state.worker === 'hang') return;
        if (state.worker === 'http') { response.writeHead(503); return response.end(diagnostic); }
        if (state.worker === 'malformed') return response.end(diagnostic);
        const block = AttoBlock.fromJson(JSON.stringify({ type: 'CHANGE', network: input.network, version: 0, algorithm: 'V1',
          publicKey: '11'.repeat(32), height: 2, balance: 0, timestamp: input.timestamp, previous: input.target,
          representativeAlgorithm: 'V1', representativePublicKey: '11'.repeat(32) }));
        assert.equal(input.network, 'LOCAL', 'Synthetic work must never calculate LIVE work.');
        for (let nonce = 0; nonce < 1_000_000; nonce++) {
          const bytes = new Uint8Array(8);
          new DataView(bytes.buffer).setUint32(0, nonce, true);
          const work = new AttoWork(new Int8Array(bytes.buffer));
          if (work.isValid(block) === (state.worker !== 'invalid')) return response.end(JSON.stringify({ work: work.toString() }));
        }
        throw new Error('No bounded synthetic LOCAL work found.');
      }
      response.writeHead(404);
      response.end();
    };
    void run().catch(error => { state.error = error; response.writeHead(500); response.end(); });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const url = `http://127.0.0.1:${http.address().port}`;
  const app = new AttoApplication({ directory, secrets: { get: async () => phrase, set: async () => {} } });
  const initialized = await app.createWallet(phrase);
  state.publicKey = initialized.addresses[0].publicKey;
  await app.call('wallet_configure', { network: 'LOCAL', nodeUrl: url, workerUrl: url, autoReceive: true });
  await app.close();
  t.after(async () => {
    http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
    await rm(directory, { recursive: true, force: true });
    assert.equal(state.error, undefined);
  });
  const env = { ...process.env, ...fake.env, NO_UPDATE_NOTIFIER: '1', KOTLIN_LOGGING_STARTUP_MESSAGE: 'false' };
  const run = async (args = ['--json', 'doctor'], overrides = {}, main = cliMain) => {
    let result;
    try { result = { ...await execute(process.execPath, [main, '--data-dir', directory, ...args], { env: { ...env, ...overrides }, timeout: 15_000 }), code: 0 }; }
    catch (error) { if (typeof error.code !== 'number') throw error; result = error; }
    assert.ok([0, 1].includes(result.code), result.stdout + result.stderr);
    assert.ok(!result.stdout.includes(phrase) && !result.stderr.includes(phrase));
    assert.ok(!result.stdout.includes(diagnostic) && !result.stderr.includes(diagnostic));
    return { ...result, ...(args.includes('--json') ? { report: JSON.parse(result.stdout).result } : {}) };
  };
  return { directory, fake, state, env, run, url, identity: initialized.identity };
}
