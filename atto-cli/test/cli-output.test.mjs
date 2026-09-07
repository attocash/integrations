import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { AttoBlock } from '@attocash/commons-core';

const cliDirectory = process.env.ATTO_TEST_CLI_PACKAGE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const { formatHumanResult } = await import(pathToFileURL(join(cliDirectory, 'dist/cli/output.js')));
const { publicModel } = await import(pathToFileURL(join(cliDirectory, 'dist/network/reader.js')));
const execute = promisify(execFile);

test('Human journal output preserves payment details and leaves serialized blocks to JSON', () => {
  // Given a published payment with integers beyond IEEE precision and caller metadata.
  const hash = 'a'.repeat(64);
  const cursor = 'opaque-long-cursor-0123456789';
  const result = { items: [{ id: 'invoice-42', status: 'published', hash,
    raw: '18446744073709551615',
    blockJson: '{"signature":"stored-protocol-detail"}',
    plan: { steps: [{ id: 'internal-step', raw: '123', hash, blockJson: '{"signature":"stored-step-detail"}' }] },
    metadata: { orderId: '42', 'invoice_total': '9007199254740993', confirmed: false },
  }], nextCursor: cursor };

  // When a journal page is displayed for a person.
  const output = formatHumanResult(result, 'journal_list');

  // Then payment and consolidation details stay exact without dumping recovery internals.
  for (const value of [hash, cursor, 'invoice-42', '18446744073709551615', '9007199254740993']) assert.ok(output.includes(value));
  assert.match(output, /Status: published/);
  assert.match(output, /internal-step/);
  assert.match(output, /RAW: 123/);
  assert.match(output, /orderId: 42/);
  assert.match(output, /invoice_total: 9007199254740993/);
  assert.match(output, /confirmed: No/);
  assert.doesNotMatch(output, /stored-protocol-detail|stored-step-detail|9007199254740992|18446744073709552000/);
});

test('Human output escapes terminal controls in both metadata keys and values', () => {
  // Given caller-controlled text that could otherwise forge terminal lines or hide fields.
  const result = { requestId: 'invoice\nStatus: published', metadata: {
    'reason\u001b[2J': 'line\rreplacement\t\u009b\u202e\u2066',
    raw: '0', atto: 'caller-defined',
    blockJson: 'caller-defined metadata',
  } };

  // When the public result is rendered as terminal text.
  const output = formatHumanResult(result, 'send');

  // Then controls are visible escapes and arbitrary metadata retains its literal keys.
  assert.match(output, /invoice\\u000aStatus: published/);
  assert.match(output, /reason\\u001b\[2J/);
  assert.match(output, /line\\u000dreplacement\\u0009\\u009b\\u202e\\u2066/);
  assert.match(output, /raw: 0/);
  assert.match(output, /atto: caller-defined/);
  assert.match(output, /blockJson: caller-defined metadata/);
  assert.doesNotMatch(output, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
});

test('Monetary fields retain their RAW or explicit units without unrelated protocol fields', () => {
  // Given account-entry balances (which have no network field), receivables, and an ATTO limit.
  const entry = { previousBalance: '9007199254740993', balance: '18446744073709551615' };
  const receivable = { amount: '1' };
  const limit = { amount: '1.25', unit: 'ATTO' };

  // When each engine result is presented as plain text.
  const output = formatHumanResult({ entry, receivable, limit });

  // Then units follow the monetary data, without losing precision or overriding an explicit unit.
  assert.match(output, /Previous balance: 9007199\.254740993 ATTO \(9007199254740993 RAW\)/);
  assert.match(output, /Balance: 18446744073\.709551615 ATTO \(18446744073709551615 RAW\)/);
  assert.match(output, /Amount: 0\.000000001 ATTO \(1 RAW\)\n/);
  assert.match(output, /Amount: 1\.25\n\s+Unit: ATTO/);
});

test('Human quotes and terms retain the complete informational notice and price provenance', () => {
  // Given a precise indicative quote and the current wallet responsibility notice.
  const quote = { usd: '1', priceUsd: '0.000123456789', priceDate: '2026-09-06',
    source: 'https://metrics.example.test/prices', fetchedAt: '2026-09-06T12:00:00Z',
    amount: { raw: '8100000073710', atto: '8100.00007371' }, informational: true };
  const terms = { title: 'Wallet responsibility', version: 'test-version', accepted: false,
    text: 'The price is informative. Keep an offline recovery backup.' };

  // When quoting, recording the quote with a payment, and showing terms.
  const output = formatHumanResult(quote, 'price_quote');
  const payment = formatHumanResult({ status: 'published', requestId: 'invoice-42', quote }, 'send');
  const notice = formatHumanResult(terms, 'terms_get');

  // Then no price precision, source date, disclaimer, or acceptance requirement is lost.
  for (const value of [quote.priceUsd, quote.priceDate, quote.source, quote.fetchedAt, quote.amount.raw, quote.amount.atto]) assert.ok(output.includes(value));
  assert.match(output, /Indicative conversion only/);
  assert.match(payment, /Indicative conversion only/);
  assert.match(payment, /Request ID: invoice-42/);
  assert.match(notice, /Accepted: No/);
  assert.ok(notice.includes(terms.text));
  assert.ok(notice.includes(terms.version));
});

test('Human watch output keeps gaps, cursors, errors, and empty event state explicit', () => {
  // Given a watch that lost older events and is reconnecting after an error.
  const result = { id: 'watch-1', events: [], nextCursor: 37, oldestCursor: 35,
    status: 'reconnecting', gapDetected: true, lastError: { code: 'NETWORK_ERROR', message: 'Connection lost.' } };

  // When reporting its current state through the same CLI output layer.
  const output = formatHumanResult(result, 'watch_read');

  // Then gaps and retry state remain visible without suggesting an unsupported watch flag.
  assert.match(output, /Events: None/);
  assert.match(output, /Next cursor: 37/);
  assert.match(output, /Oldest cursor: 35/);
  assert.match(output, /Gap detected: Yes/);
  assert.match(output, /Status: reconnecting/);
  assert.match(output, /NETWORK_ERROR/);
  assert.doesNotMatch(output, /--cursor/);
});

test('Human wallet status hides internal identifiers while retaining pending work and reset warnings', () => {
  // Given public wallet state containing both user-facing status and internal identifiers.
  const result = { initialized: true, resetPending: true,
    identity: { address: 'atto_public_wallet', fingerprint: 'internal-fingerprint' },
    settings: { network: 'LIVE', autoReceive: true, minReceiveRaw: '1', representative: 'atto_representative', nodeUrl: 'https://node.example.test', workerUrl: 'https://worker.example.test' },
    autoReceive: { running: false, lastError: { message: 'Connection lost.' } }, mcpAccess: 'read-only',
    addresses: [{ index: 0, address: 'atto_public_wallet', publicKey: 'internal-public-key', active: true }],
    pool: { indexes: [0], consolidate: false }, pendingSends: [{ requestId: 'pending-42', hash: 'b'.repeat(64), status: 'unknown' }],
  };

  // When requesting normal status instead of full structured state.
  const output = formatHumanResult(result, 'wallet_status');

  // Then actionable warnings remain prominent and shared-engine internals are absent.
  assert.match(output, /Reset unfinished/);
  assert.match(output, /Automatic receiving: Enabled/);
  assert.match(output, /Receiving in this process: No/);
  assert.match(output, /Connection lost/);
  assert.match(output, /pending-42/);
  assert.match(output, /Status: unknown/);
  assert.doesNotMatch(output, /internal-fingerprint|internal-public-key|MCP|Agent access/);
});

test('Real CLI uses plain text through pipes and retains complete JSON only when requested', async t => {
  // Given an isolated empty public profile, without any credential or network operations.
  const directory = await mkdtemp(join(tmpdir(), 'atto-output-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = args => execute(process.execPath, [join(cliDirectory, 'dist/cli/main.js'), '--data-dir', directory, ...args], {
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1' }, timeout: 10_000,
  });

  // When named and generic commands write to pipes, and a caller opts into JSON.
  const status = await run(['wallet', 'status']);
  const generic = await run(['call', 'wallet_status']);
  const addresses = await run(['address', 'list']);
  const humanList = await run(['journal', 'list']);
  const json = await run(['--json', 'wallet', 'status']);
  const jsonList = await run(['--json', 'journal', 'list']);

  // Then human output is the consistent default; JSON remains complete and one line per result.
  assert.equal(status.stderr, '');
  assert.match(status.stdout, /^Status: Not initialized/m);
  assert.equal(generic.stdout, status.stdout);
  assert.match(addresses.stdout, /^No wallet addresses\./);
  assert.match(humanList.stdout, /^No payment journal records found/m);
  assert.equal(json.stderr, '');
  assert.equal(json.stdout.trim().split('\n').length, 1);
  const parsed = JSON.parse(json.stdout).result;
  assert.equal(parsed.initialized, false);
  assert.equal(parsed.mcpAccess, 'read-only');
  assert.deepEqual(parsed.addresses, []);
  assert.equal(parsed.identity, null);
  assert.deepEqual(JSON.parse(jsonList.stdout).result.items, []);
});

test('Network and payment summaries retain addresses, exact amounts and hashes without cryptographic fields', () => {
  // Given a real Commons send block, including a balance above JavaScript integer precision.
  const block = AttoBlock.fromJson(`{"type":"SEND","network":"LOCAL","version":0,"algorithm":"V1","publicKey":"${'11'.repeat(32)}","height":2,"balance":17999999999999999999,"timestamp":1704616009211,"previous":"${'AA'.repeat(32)}","receiverAlgorithm":"V1","receiverPublicKey":"${'22'.repeat(32)}","amount":1000000001}`);
  const transaction = { block: publicModel(block), signature: 'hidden-signature', work: 'hidden-work' };
  const payment = { status: 'published', requestId: 'invoice-1', index: 0, transaction, hash: block.hash.toString(), metadata: { reason: 'Invoice 1' } };

  // When printing a payment or network history through the human formatter.
  const sent = formatHumanResult(payment, 'send');
  const history = formatHumanResult({ items: [transaction], timedOut: false }, 'history_list');

  // Then the hash is derived through Commons and monetary values remain exact.
  for (const output of [sent, history]) {
    assert.ok(output.includes(block.address.value));
    assert.ok(output.includes(block.receiverAddress.value));
    assert.ok(output.includes(block.hash.toString()));
    assert.match(output, /1\.000000001 ATTO \(1000000001 RAW\)/);
    assert.doesNotMatch(output, /hidden-signature|hidden-work|Public key:|Version:|Algorithm:/);
  }
  assert.match(sent, /Request ID: invoice-1/);
  assert.match(sent, /reason: Invoice 1/);
  assert.match(history, /17999999999\.999999999 ATTO \(17999999999999999999 RAW\)/);
  assert.equal(transaction.signature, 'hidden-signature', 'Formatting must preserve the original JSON payload.');
  assert.match(formatHumanResult({ items: [], timedOut: true }, 'receivables_list'), /Scan window ended; results may be incomplete/);
  assert.match(formatHumanResult({ results: [], timedOut: false, limitReached: true }, 'receive_all'), /Batch limit reached; more payments may remain/);
});
