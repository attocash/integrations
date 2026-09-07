import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const moduleUrl = name => pathToFileURL(join(cliDirectory, `dist/${name}.js`)).href;
const { AttoApplication } = await import(moduleUrl('application/app'));
const { StateStore } = await import(moduleUrl('storage/state'));
const { PersonalLabels } = await import(moduleUrl('labels/personal'));
const { GlobalDirectory, DIRECTORY_URL, fetchDirectory } = await import(moduleUrl('labels/directory'));
const { AddressLabels } = await import(moduleUrl('labels/presentation'));
const { SpendLedger } = await import(moduleUrl('spending/ledger'));
const { bindDestination } = await import(moduleUrl('spending/destination'));
const { formatHumanResult } = await import(moduleUrl('cli/output'));
const execute = promisify(execFile);
const A = 'atto://aaswdsyo5pv2pigz3557r7pncks3duwvxpklr6sndcj4kdlcgxpfsowc2hsuk';
const B = 'atto://adcvvasbd2duys5y4ekgrd3gw2og3vvhrnvrvwoki2yko6xmc3ere2apkx7wo';
const C = 'atto://ad7ptdb7tpkvyuoib5cjwjf5fjm6z4iodqvrcx4iejd5aeh6ozroq3vge3ada';
const snapshot = {
  entities: [{ entity: 'example', organization: 'example-org', label: 'Example Entity', website: 'https://example.com', tags: ['VERIFIED'], addedAt: '2026-01-01', description: 'Untrusted description' }],
  addresses: [{ address: A, label: 'Global Savings', entity: 'example', addedAt: '2026-01-01', description: 'Public description' }],
  voters: [{ address: B, label: 'Global Voter', entity: 'example', addedAt: '2026-01-01', description: 'Public voter', payToAddress: C, sharePercentage: 85, voteWeight: '123', lastVotedAt: '2026-01-01T00:00:00Z' }],
};
const response = (value = snapshot) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'atto-labels-'));
  let reads = 0;
  const secrets = { get: async () => { reads++; throw new Error('No credential access expected'); }, set: async () => assert.fail('No keys expected') };
  let requests = 0;
  const globalDirectory = new GlobalDirectory(directory, async (url, options) => {
    requests++;
    assert.equal(url, DIRECTORY_URL);
    assert.equal(options.body, undefined);
    return response();
  });
  const app = new AttoApplication({ directory, secrets, globalDirectory });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, app, globalDirectory, secrets, get reads() { return reads; }, get requests() { return requests; } };
}

test('personal labels support Unicode CRUD, uniqueness, external addresses, search and network isolation without credentials', async t => {
  // Given an uninitialized wallet and public directory data.
  const f = await fixture(t);
  const { app } = f;
  app.store.set('addresses', [{ index: 7, address: A, publicKey: 'unused', active: false }]);

  // When saving an external label and a saved-index label.
  await app.call('labels_set', { index: 7, label: '  Savings  ' });
  await app.call('labels_set', { address: B, label: '家族 🏠' });
  await assert.rejects(app.call('labels_set', { address: C, label: 'sAVINGS' }), { code: 'LABEL_EXISTS' });
  await app.call('labels_set', { address: A, label: 'SAVINGS' });

  // Then only local state changes, and names remain separate on other networks.
  assert.equal(f.reads, 0);
  assert.equal(f.requests, 0);
  assert.deepEqual((await app.call('labels_list', { search: 'sAvInGs' })).items, [{ address: A }]);
  assert.equal((await app.call('labels_list', { search: 'EXAMPLE ENTITY', all: true })).items.length, 2);
  assert.equal((await app.call('labels_get', { index: 7 })).addressLabels[A].personal.label, 'SAVINGS');
  assert.equal((await app.call('labels_list', { search: A.slice(-10) })).items.length, 1);
  assert.equal((await app.call('address_list')).addresses.length, 1);
  await app.call('wallet_configure', { network: 'LOCAL' });
  assert.deepEqual((await app.call('labels_list', { all: true })).items, []);
  await app.call('labels_set', { address: C, label: 'Savings' });
  await app.call('wallet_configure', { network: 'LIVE' });
  assert.equal((await app.call('labels_list')).items.length, 2);
  await app.call('labels_remove', { address: B });
  await app.call('labels_remove', { address: B });
  assert.equal((await app.call('labels_list')).items.length, 1);
  assert.equal(f.reads, 0);
});

test('invalid label inputs and target ambiguity fail before credentials or directory access', async t => {
  // Given a fresh profile.
  const f = await fixture(t);
  // When submitting invalid text or ambiguous selections.
  for (const label of ['', '   ', 'x'.repeat(129), 'hello\n', 'x\u0000y', '\u009by', 'x\u202ey', 'x\u200by']) {
    await assert.rejects(f.app.call('labels_set', { address: A, label }), { code: 'INVALID_INPUT' });
  }
  await f.app.call('labels_set', { address: A, label: '🏠'.repeat(128) });
  for (const name of ['labels_set', 'labels_remove', 'labels_get']) {
    for (const target of [{}, { address: A, index: 0 }]) await assert.rejects(f.app.call(name, { ...target, ...(name === 'labels_set' ? { label: 'Savings' } : {}) }), { code: 'INVALID_INPUT' });
  }
  await assert.rejects(f.app.call('labels_set', { index: 99, label: 'Savings' }), { code: 'ADDRESS_NOT_DERIVED' });
  // Then no external or credential request occurred.
  assert.equal(f.reads, 0); assert.equal(f.requests, 0);
});

test('read-only MCP may manage personal labels but cannot send', async t => {
  // Given a shared profile without spending approval.
  const f = await fixture(t);
  const mcp = new AttoApplication({ directory: f.directory, secrets: f.secrets, access: 'mcp', globalDirectory: f.globalDirectory });
  try {
    // When managing local names through the MCP permission boundary.
    await mcp.call('labels_set', { address: A, label: 'Savings' });
    assert.equal((await mcp.call('labels_list')).addressLabels[A].personal.label, 'Savings');
    await assert.rejects(mcp.call('send', { destinationLabel: 'Savings', amount: '1', requestId: 'denied' }), { code: 'MCP_READ_ONLY' });
    await mcp.call('labels_remove', { address: A });
    // Then no access or key custody changed.
    assert.equal(mcp.ledger.mcpAccess(), 'read-only');
    assert.equal(f.reads, 0);
  } finally { await mcp.close(); }
});

test('global-only and unknown payment names fail locally with an available or unavailable directory', async t => {
  // Given cached global names and no personal mappings.
  const f = await fixture(t);
  await f.globalDirectory.refresh();
  const fetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('All services unavailable'); };
  t.after(() => { globalThis.fetch = fetch; });
  // When requesting global-only, unknown, and approximate personal names.
  await f.app.call('labels_set', { address: B, label: 'Local Savings' });
  for (const destinationLabel of ['Global Savings', 'Global Voter', 'Unknown', 'Local Saving']) {
    await assert.rejects(f.app.call('send', { destinationLabel, amount: '1', requestId: destinationLabel }), { code: 'LABEL_NOT_FOUND' });
  }
  // Then neither node/price/directory calls, credentials, nor reservations occurred.
  assert.equal(calls, 0); assert.equal(f.reads, 0);
  assert.equal(f.app.ledger.journalList().items.length, 0);
});

test('label bindings survive failure before reservation, rename/removal/reassignment and process restart', async t => {
  // Given a valid personal mapping; USD terms fail before any network work.
  const f = await fixture(t);
  await f.app.call('labels_set', { address: A, label: 'Savings' });
  const request = { destinationLabel: '  sAvInGs  ', amount: '1', unit: 'USD', requestId: 'early-failure' };
  await assert.rejects(f.app.call('send', request), { code: 'TERMS_REQUIRED' });
  assert.equal(f.app.ledger.get(request.requestId), undefined);
  const binding = f.app.store.get(`send.destination.${request.requestId}`);
  assert.deepEqual(binding, { network: 'LIVE', address: A, label: 'Savings' });

  // When renaming, removing, reassigning and retrying from a new process.
  await f.app.call('labels_set', { address: A, label: 'Renamed' });
  await f.app.call('labels_remove', { address: A });
  await f.app.call('labels_set', { address: B, label: 'Savings' });
  const source = `
    const { AttoApplication } = await import(${JSON.stringify(moduleUrl('application/app'))});
    const app = new AttoApplication({ directory: process.argv[1], secrets: { get: async () => { throw Error('No keys'); } } });
    try { await app.call('send', JSON.parse(process.argv[2])); }
    catch (error) { process.stdout.write(error.code); }
    finally { await app.close(); }
  `;
  const child = await execute(process.execPath, ['--input-type=module', '-e', source, f.directory, JSON.stringify(request)]);

  // Then the original name/address remain pinned; other destinations conflict.
  assert.equal(child.stdout, 'TERMS_REQUIRED');
  assert.deepEqual(f.app.store.get(`send.destination.${request.requestId}`), binding);
  await assert.rejects(f.app.call('send', { ...request, destinationLabel: 'Renamed' }), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(f.app.call('send', { amount: '1', unit: 'USD', requestId: request.requestId, destination: B }), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(f.app.call('send', { amount: '1', unit: 'USD', requestId: request.requestId, destination: A }), { code: 'TERMS_REQUIRED' });
  await assert.rejects(f.app.call('send', { ...request, requestId: 'new-request' }), { code: 'TERMS_REQUIRED' });
  assert.equal(f.app.store.get('send.destination.new-request').address, B);
  await f.app.call('wallet_configure', { network: 'LOCAL' });
  await assert.rejects(f.app.call('send', request), { code: 'NETWORK_MISMATCH' });
  assert.equal(f.reads, 0); assert.equal(f.requests, 0);
});

test('concurrent processes enforce name uniqueness and one destination per request ID atomically', async t => {
  // Given shared SQLite state and two different address candidates.
  const f = await fixture(t);
  const source = `
    const { StateStore } = await import(${JSON.stringify(moduleUrl('storage/state'))});
    const { PersonalLabels } = await import(${JSON.stringify(moduleUrl('labels/personal'))});
    const { SpendLedger } = await import(${JSON.stringify(moduleUrl('spending/ledger'))});
    const { bindDestination } = await import(${JSON.stringify(moduleUrl('spending/destination'))});
    const store = new StateStore(process.argv[1]);
    try {
      const result = process.argv[3] === 'label' ? new PersonalLabels(store).set('LIVE', process.argv[2], 'Savings')
        : bindDestination(store, new SpendLedger(store), 'LIVE', { requestId: 'race', destination: process.argv[2] });
      process.stdout.write(JSON.stringify(result));
    } catch (error) { process.stdout.write(JSON.stringify({ error: error.code })); }
    finally { store.close(); }
  `;
  // When separate processes race both check-and-save transitions.
  for (const mode of ['label', 'binding']) {
    const results = await Promise.all([A, B].map(address => execute(process.execPath, ['--input-type=module', '-e', source, f.directory, address, mode]).then(result => JSON.parse(result.stdout))));
    // Then precisely one contender wins and the other gets the relevant conflict.
    assert.equal(results.filter(value => !value.error).length, 1);
    assert.equal(results.find(value => value.error).error, mode === 'label' ? 'LABEL_EXISTS' : 'REQUEST_CONFLICT');
  }
});

test('profile backups retain labels and early bindings; reset clears both without touching another profile', async t => {
  // Given personal state and a copied, closed profile backup.
  const f = await fixture(t);
  await f.app.call('labels_set', { address: A, label: 'Savings' });
  bindDestination(f.app.store, f.app.ledger, 'LIVE', { requestId: 'backup', destinationLabel: 'Savings' });
  await f.app.close();
  const copy = `${f.directory}-backup`;
  await cp(f.directory, copy, { recursive: true });
  const restored = new AttoApplication({ directory: copy, secrets: { get: async () => null, remove: async () => {} } });
  t.after(async () => { await restored.close(); await rm(copy, { recursive: true, force: true }); });
  assert.equal((await restored.call('labels_list')).addressLabels[A].personal.label, 'Savings');
  assert.equal(restored.store.get('send.destination.backup').address, A);
  // When explicitly resetting the copied profile.
  await restored.resetWallet(null);
  const cleared = new StateStore(copy);
  const original = new StateStore(f.directory);
  try {
    // Then reset removed labels/bindings and the original profile kept them.
    assert.deepEqual(new PersonalLabels(cleared).list('LIVE'), []);
    assert.equal(cleared.get('send.destination.backup'), undefined);
    assert.equal(new PersonalLabels(original).list('LIVE')[0].label, 'Savings');
  } finally { cleared.close(); original.close(); }
});

test('directory cache preserves provenance, entities and payout relationships; refresh honors freshness and backoff', async t => {
  // Given an injectable clock and public snapshot with a distinct payout destination.
  const f = await fixture(t);
  let now = 1_000_000;
  let calls = 0;
  let failed = false;
  const directory = new GlobalDirectory(f.directory, async () => { calls++; if (failed) throw Error('offline'); return response(); }, () => now);
  // When refreshing repeatedly, then after expiry and a service failure.
  await Promise.all([directory.refresh(), directory.refresh()]);
  await directory.refresh();
  assert.equal(calls, 1);
  now += 3_600_000; failed = true;
  await directory.refresh();
  await directory.refresh();
  assert.equal(calls, 2);
  const reopened = new GlobalDirectory(f.directory, async () => { calls++; throw Error('offline'); }, () => now);
  await reopened.refresh();
  assert.equal(calls, 2);
  await reopened.refresh(true);
  assert.equal(calls, 3);
  now += 300_000;
  await reopened.refresh();
  assert.equal(calls, 4);
  // Then stale data remains identifiable with its original sources and relationships.
  const labels = new AddressLabels(new PersonalLabels(f.app.store), reopened);
  const dictionary = labels.dictionary('LIVE', [A, B, C]);
  assert.equal(dictionary[A].global[0].entityInfo.label, 'Example Entity');
  assert.equal(dictionary[B].global[0].payToAddress, C);
  assert.equal(dictionary[B].global[0].sharePercentage, 85);
  assert.equal(dictionary[B].global[0].kind, 'voter');
  assert.equal(dictionary[C].global.length, 0);
  assert.equal(dictionary[C].payoutFor[0].voterAddress, B);
  assert.equal(dictionary[A].global[0].stale, true);
  assert.equal(labels.status('LIVE').lastError, 'DIRECTORY_UNAVAILABLE');
  assert.equal(labels.dictionary('LOCAL', [A])[A].global.length, 0);
  failed = false;
  await directory.refresh(true);
  assert.equal(directory.cached().status.stale, false);
  assert.equal(directory.cached().status.lastError, undefined);
});

test('directory validation rejects malformed, oversized and slow bodies and never replaces the last valid snapshot', async t => {
  // Given one verified cached snapshot.
  const f = await fixture(t);
  await f.globalDirectory.refresh();
  const before = f.globalDirectory.cached().snapshot;
  const cases = [
    () => new Response('bad', { status: 503 }),
    () => response({ ...snapshot, addresses: [{ ...snapshot.addresses[0], address: 'bad' }] }),
    () => response({ ...snapshot, entities: [] }),
    () => response({ ...snapshot, voters: [{ ...snapshot.voters[0], sharePercentage: 101 }] }),
    () => new Response('x', { headers: { 'content-type': 'application/json', 'content-length': String(3 * 1024 * 1024) } }),
    () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
    () => new Response('<html>unavailable</html>', { headers: { 'content-type': 'text/html' } }),
  ];
  // When each public response violates a boundary.
  for (const invalid of cases) {
    const cache = new GlobalDirectory(f.directory, async () => invalid());
    await cache.refresh(true);
    // Then the last verified snapshot is retained.
    assert.deepEqual(cache.cached().snapshot, before);
    assert.equal(cache.cached().status.lastError, 'DIRECTORY_UNAVAILABLE');
  }
  const started = Date.now();
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(fetchDirectory(async (_url, { signal }) => new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    } }), { headers: { 'content-type': 'application/json' } })));
    assert.ok(Date.now() - started >= 2900 && Date.now() - started < 5000);
  } finally { clearInterval(keepAlive); }
});

test('human output escapes untrusted global text and keeps the payment original name separate from current labels', async t => {
  // Given global instructions/control text and a renamed current personal label.
  const f = await fixture(t);
  await f.app.call('labels_set', { address: A, label: 'Current name' });
  const directory = new GlobalDirectory(f.directory, async () => response({ ...snapshot, addresses: [{ ...snapshot.addresses[0], label: '\u001b[2J Global' }] }));
  await directory.refresh(true);
  const labels = new AddressLabels(new PersonalLabels(f.app.store), directory);
  const original = { destination: A, destinationBinding: { network: 'LIVE', address: A, label: 'Original name' }, transaction: { block: { type: 'SEND' } } };
  // When decorating and rendering a send result.
  const decorated = labels.decorate(original, 'LIVE');
  const human = formatHumanResult(decorated, 'send');
  // Then original protocol data and binding remain unchanged; only presentation is enriched.
  assert.deepEqual(original.transaction, { block: { type: 'SEND' } });
  assert.deepEqual(decorated.destinationBinding, original.destinationBinding);
  assert.equal(decorated.addressLabels[A].personal.label, 'Current name');
  assert.ok(human.includes(`${A} (Original name [personal]`));
  assert.ok(!human.includes('\u001b'));
  assert.ok(human.includes('\\u001b'));
});

test('CLI labels CRUD and name destination schemas work without key access', async t => {
  // Given a fresh profile configured for LOCAL to avoid directory requests.
  const f = await fixture(t);
  await f.app.call('wallet_configure', { network: 'LOCAL' });
  const cli = (...args) => execute(process.execPath, [join(cliDirectory, 'dist/cli/main.js'), '--no-update-notifier', '--json', '--data-dir', f.directory, ...args]);
  // When invoking the installed/source CLI through its actual parser.
  await cli('labels', 'set', A, 'Savings');
  const shown = JSON.parse((await cli('labels', 'show', A)).stdout).result;
  assert.equal(shown.addressLabels[A].personal.label, 'Savings');
  assert.equal(JSON.parse((await cli('labels', 'list', '--search', 'SAV')).stdout).result.items.length, 1);
  await assert.rejects(cli('send', '--to-label', 'Missing', '--amount', '1'), error => JSON.parse(error.stdout).error.code === 'LABEL_NOT_FOUND');
  await assert.rejects(cli('send', '--to-label', 'Savings', '--to-index', '0', '--amount', '1'), error => JSON.parse(error.stdout).error.code === 'INVALID_INPUT');
  await assert.rejects(cli('send', A, '1', '--to-label', 'Savings'), error => JSON.parse(error.stdout).error.code === 'INVALID_INPUT');
  await cli('labels', 'remove', A);
  // Then changes are shared and no wallet was initialized.
  assert.equal((await f.app.call('labels_list')).items.length, 0);
  assert.equal((await f.app.call('wallet_status')).initialized, false);
});

test('doctor directory checks are optional, report availability failures as warnings, and never update the public cache', async t => {
  // Given a closed, uninitialized profile and a cached directory snapshot.
  const f = await fixture(t);
  await f.globalDirectory.refresh();
  await f.app.close();
  const path = join(f.directory, 'cache', 'global-addresses.json');
  const before = await readFile(path, 'utf8');
  const database = await readFile(join(f.directory, 'state.sqlite'));
  const { runDoctor } = await import(moduleUrl('doctor/doctor'));
  const fetch = globalThis.fetch;
  let directoryCalls = 0;
  let available = true;
  globalThis.fetch = async url => {
    if (String(url) === DIRECTORY_URL) { directoryCalls++; return available ? response() : new Response('', { status: 503 }); }
    return new Response('', { status: 503 });
  };
  t.after(() => { globalThis.fetch = fetch; });
  // When running diagnostics with and without the optional check.
  const defaultReport = await runDoctor({ directory: f.directory });
  assert.equal(directoryCalls, 0);
  assert.equal(defaultReport.checks.some(check => check.id === 'labels.directory'), false);
  const healthy = await runDoctor({ directory: f.directory, globalDirectory: true });
  available = false;
  const offline = await runDoctor({ directory: f.directory, globalDirectory: true });
  // Then the cache and database stay byte-identical regardless of availability.
  assert.equal(healthy.checks.find(check => check.id === 'labels.directory').status, 'pass');
  assert.equal(offline.checks.find(check => check.id === 'labels.directory').status, 'warn');
  assert.equal(directoryCalls, 2);
  assert.equal(await readFile(path, 'utf8'), before);
  assert.deepEqual(await readFile(join(f.directory, 'state.sqlite')), database);
});

test('watch and receive progress show names beside full addresses without modifying stream protocol data', async t => {
  // Given a cached personal label and a protocol account from a saved wallet index.
  const f = await fixture(t);
  const { parseAddress } = await import(moduleUrl('network/reader'));
  await f.app.call('labels_set', { address: A, label: 'Savings' });
  const publicKey = parseAddress(A).publicKey.toString();
  const labels = new AddressLabels(new PersonalLabels(f.app.store), f.globalDirectory);
  const data = { algorithm: 'V1', publicKey, balance: '1', height: '2' };
  const page = { events: [{ cursor: 1, data }], status: 'running' };
  // When cached enrichment formats protocol events and automatic receive progress.
  const decorated = labels.decorate(page, 'LIVE');
  const watch = formatHumanResult(decorated, 'watch_read');
  const progress = formatHumanResult(labels.decorate({ event: 'receiving', address: A, index: 0, sendHash: '11'.repeat(32), amount: { raw: '1', atto: '0.000000001' } }, 'LIVE'), 'receive_progress');
  // Then full addresses and local names are visible; no global fetch was needed.
  assert.ok(watch.includes(`${A} (Savings [personal])`));
  assert.ok(progress.includes(`${A} (Savings [personal])`));
  assert.deepEqual(decorated.events[0].data, data);
  assert.equal(f.requests, 0);
});
