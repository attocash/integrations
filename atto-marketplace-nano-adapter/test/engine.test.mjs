import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, symlinkSync, rmSync, lstatSync, linkSync, renameSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from '../../test/support/temporary-directory.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { NanoWallet, provisionNanoWallet, inspectNanoWallet, approveNanoWalletPolicy, verifyNanoMessage, derivePrivateKey, publicKey, addressFromPublicKey, addressPublicKey, NanoStateBlock, ZERO_HASH, upperHex, validWork } from '../dist/index.js';
import { canonical, sha256 } from '../dist/configuration.js';
import { NanoJournal } from '../dist/journal.js';
import { NanoRpcClient, epochLink, DEV_GENESIS_ACCOUNT } from '../dist/rpc.js';
import { hexBytes, sign, offchainSign } from '../dist/protocol.js';
import { decodePaymentHeader } from '@attocash/cli/internal-marketplace';
import { offer, legacyOffer, legacyHeader, terms, legacyChallenge, paymentId } from '../../test/support/relay.mjs';
import { securePrivatePermissions } from '@attocash/cli/internal-marketplace';
import { publishPrivate, readPrivate, processOwnerAlive } from '../dist/private-files.js';
import * as nanoAdapter from '../dist/index.js';
import { signMarketplaceNanoController } from '../dist/index.js';
const now = Date.parse('2026-11-02T12:00:00Z');
function work(root, receive = false) {
    for (let n = 0n;; n++) {
        const nonce = n.toString(16).padStart(16, '0');
        if (validWork('nano:dev', receive ? 0 : 2, receive, root, nonce))
            return nonce;
    }
}
async function fixture(t, { grants = { externalTransfers: true, controllerPurposes: ['login'] }, limit = '100' } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'nano-engine-'));
    chmodSync(dir, 0o700);
    const wallets = new Set(), children = new Set();
    t.after(async () => {
        for (const child of children) {
            if (child.exitCode !== null || child.signalCode !== null) continue;
            const exited = once(child, 'exit');
            child.kill('SIGKILL');
            let deadline;
            try {
                await Promise.race([exited, new Promise((_, reject) => {
                    deadline = setTimeout(() => reject(Error('Fixture child did not exit before cleanup.')), 5000);
                })]);
            } finally { clearTimeout(deadline); }
        }
        for (const wallet of wallets) wallet.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const handoff = join(dir, 'handoff');
    mkdirSync(handoff, { mode: 0o700 });
    const seedFile = join(dir, 'seed.hex');
    writeFileSync(seedFile, '01'.repeat(32) + '\n', { mode: 0o600 });
    const setup = await provisionNanoWallet({ dataDir: dir, seedFile, derivationIndex: 1, network: 'nano:dev', rpcUrl: 'http://127.0.0.1:17076', origin: 'http://localhost:8080', audience: 'marketplace', grants, limits: { maxPaymentAtomic: limit, rolling24hAtomic: limit }, terminalConfirmed: true });
    const key = derivePrivateKey(Buffer.from('01'.repeat(32), 'hex'), 1), source = setup.address, destination = addressFromPublicKey(publicKey(derivePrivateKey(Buffer.from('02'.repeat(32), 'hex'), 1)));
    let account = { frontier: 'A'.repeat(64), confirmedFrontier: 'A'.repeat(64), balance: 1000n, confirmedBalance: 1000n, representative: source, confirmedRepresentative: source, epoch: 2 };
    const blocks = new Map();
    let published = [], mode = 'confirm', pinCount = 0, workPause;
    const rpc = {
        async requirePinnedNetwork() {
            pinCount++;
        }, async accountSnapshot() {
            return account;
        }, async accountSnapshotOrNotFound() {
            return account;
        },
        async blockInfo(hash) {
            return blocks.get(hash) ?? null;
        }, async generateWork(root, epoch, receive = false) {
            if (workPause)
                await workPause;
            return work(root, receive);
        }, async generateOpenWork(root) {
            return work(root, true);
        },
        async process(block, subtype) {
            published.push(block);
            if (mode === 'throw')
                throw Error('lost response');
            if (mode === 'confirm') {
                blocks.set(block.hash, { block, blockAccount: source, subtype: subtype === 'open' ? 'receive' : subtype, confirmed: true });
                account = { frontier: block.hash, confirmedFrontier: block.hash, balance: block.balance, confirmedBalance: block.balance, representative: block.representative, confirmedRepresentative: block.representative, epoch: 2 };
            }
            if (mode === 'lost-after-confirm') {
                blocks.set(block.hash, { block, blockAccount: source, subtype, confirmed: true });
                throw Error('lost accepted response');
            }
        },
        async processDevOpen() {
        }, async receivable() {
            return [];
        }, async receivableExists(hash) {
            return (await this.receivable(source)).some(row => row.hash === hash);
        }, async verifyFrontierState() {
            return {};
        }, validSourceBlock(e, source) {
            return e.blockAccount === source && e.block.validSignature();
        }, validConfirmedBlock(e, source) {
            return e.confirmed && e.blockAccount === source && e.block.validSignature();
        }, requireLoopbackDevelopmentEndpoint() {
        },
    };
    const open = (timestamp = now) => {
        const wallet = NanoWallet.open({ dataDir: dir, rpc, now: () => timestamp });
        const close = wallet.close.bind(wallet);
        wallets.add(wallet);
        wallet.close = () => {
            if (!wallets.has(wallet)) return;
            close();
            wallets.delete(wallet);
        };
        return wallet;
    };
    const trackChild = child => { children.add(child); return child; };
    return { trackChild, dir, handoff, source, destination, key, setup, grants, rpc, open, published, blocks, get account() {
            return account;
        }, set account(v) {
            account = v;
        }, set mode(v) {
            mode = v;
        }, set pause(v) {
            workPause = v;
        }, get pinCount() {
            return pinCount;
        } };
}
function transfer(f, amount = '40', id = randomUUID()) {
    return { network: 'nano:dev', destination: f.destination, amountAtomic: amount, requestId: id };
}
test('external transfer permission defaults denied and retired funding operations are unavailable', async t => {
    // Given no native transfer authority.
    const f=await fixture(t,{grants:{externalTransfers:false,controllerPurposes:[]}}),wallet=f.open();
    // When / Then no signature or publication can be produced.
    await assert.rejects(wallet.call('transfer.send',transfer(f)),{code:'PERMISSION_DENIED'});
    for(const operation of ['funding.prepare','funding.status'])
        await assert.rejects(wallet.call(operation,{}),{code:'UNSUPPORTED_OPERATION'});
    assert.equal(f.published.length,0);
});
test('exact transfer retry and restart preserve one signed candidate and reject changed idempotency terms', async (t) => {
    // Given one exact transfer has a stable economic request ID.
    const f = await fixture(t), args = transfer(f);
    let wallet = f.open();
    // When the confirmed wallet is closed and reopened for an exact retry.
    const first = await wallet.call('transfer.send', args);
    // Then one candidate remains and changed terms are rejected.
    assert.equal(first.state, 'CONFIRMED');
    assert.equal(f.published.length, 1);
    assert.equal('blockJson' in first, false);
    wallet.close();
    wallet = f.open();
    t.after(() => wallet.close());
    assert.equal((await wallet.call('transfer.send', args)).sendHash, first.sendHash);
    assert.equal(f.published.length, 1);
    await assert.rejects(wallet.call('transfer.send', { ...args, amountAtomic: '41' }), { code: 'HANDLE_REUSE' });
});
test('unknown publication fences new money even after 24h and retry publishes only the original bytes', async (t) => {
    // Given publication ends without authoritative chain evidence.
    const f = await fixture(t), args = transfer(f);
    f.mode = 'throw';
    let wallet = f.open();
    // When the wallet is reopened two days later and both new and original requests are retried.
    const first = await wallet.call('transfer.send', args);
    // Then new spending stays fenced and the original signed bytes are reused.
    assert.equal(first.state, 'UNKNOWN');
    wallet.close();
    wallet = f.open(now + 172800000);
    t.after(() => wallet.close());
    await assert.rejects(wallet.call('transfer.send', transfer(f, '1')), { code: 'SOURCE_FENCED' });
    assert.equal((await wallet.call('transfer.send', args)).sendHash, first.sendHash);
    assert.equal(f.published.length, 2);
    assert.deepEqual(f.published[0].toWire(), f.published[1].toWire());
});
test('accepted SEND with lost RPC response resolves after restart without a replacement signature', async (t) => {
    // Given the node accepts a SEND before its response is lost.
    const f = await fixture(t), args = transfer(f);
    f.mode = 'lost-after-confirm';
    let wallet = f.open();
    // When a new wallet instance resolves the saved candidate.
    assert.equal((await wallet.call('transfer.send', args)).state, 'UNKNOWN');
    wallet.close();
    wallet = f.open();
    t.after(() => wallet.close());
    // Then confirmation needs no replacement signature or publication.
    assert.equal((await wallet.call('transfer.status', { requestId: args.requestId })).state, 'CONFIRMED');
    assert.equal(f.published.length, 1);
});
test('confirmed direct spends share the exact rolling cap', async t => {
    // Given a confirmed direct SEND consumes part of the same native wallet limit.
    const f=await fixture(t,{limit:'60'}),wallet=f.open();
    await wallet.call('transfer.send',transfer(f,'40'));
    // When / Then exceeding the remaining cap fails, and its exact remainder succeeds.
    await assert.rejects(wallet.call('transfer.send',transfer(f,'21')),{code:'DAILY_LIMIT'});
    assert.equal((await wallet.call('transfer.send',transfer(f,'20'))).state,'CONFIRMED');
});
test('concurrent authorization holds one source lane and only one candidate reaches publication', async (t) => {
    // Given work generation holds an active authorization open.
    const f = await fixture(t), wallet = f.open();
    t.after(() => wallet.close());
    let release;
    f.pause = new Promise(r => release = r);
    // When a second request races the same account.
    const first = wallet.call('transfer.send', transfer(f, '60'));
    await new Promise(r => setImmediate(r));
    // Then only the first authorized candidate is published.
    await assert.rejects(wallet.call('transfer.send', transfer(f, '60')), { code: 'PAYMENT_IN_PROGRESS' });
    release();
    await first;
    assert.equal(f.published.length, 1);
});

test('private files reject symlinks, broad permissions, duplicate response replacement and malformed config', async t => {
    // Given private response files contain exact create-only bytes.
    const f = await fixture(t), path = join(f.dir, 'private.json');
    // When conflicting content and unsafe filesystem metadata are supplied.
    publishPrivate(path, Buffer.from('{}\n'));
    // Then replacement, broad permissions and symlinks are rejected.
    assert.throws(() => publishPrivate(path, Buffer.from('{"other":1}\n')), { code: 'PRIVATE_FILE_CONFLICT' });
    if (process.platform !== 'win32') {
        chmodSync(path, 0o644);
        assert.throws(() => readPrivate(path), { code: 'PRIVATE_FILE' });
        securePrivatePermissions(path, 'file');
    }
    assert.deepEqual(readPrivate(path), Buffer.from('{}\n'));
    const alias = join(f.dir, 'alias');
    if (process.platform === 'win32') {
        symlinkSync(f.handoff, alias, 'junction');
        const linkedPath = join(alias, 'private.json');
        publishPrivate(join(f.handoff, 'private.json'), Buffer.from('{}\n'));
        assert.throws(() => readPrivate(linkedPath), { code: 'PRIVATE_FILE' });
    } else {
        symlinkSync(path, alias);
        assert.throws(() => readPrivate(alias), { code: 'PRIVATE_FILE' });
    }
});

test('terminal policy update preserves keys and journal while explicit external grant changes authority', async (t) => {
    // Given the profile denies external spending and already owns a seed.
    const f = await fixture(t, { grants: { externalTransfers: false, controllerPurposes: [] } });
    const seed = readFileSync(join(f.dir, 'seed.hex'));
    // When a terminal approval grants bounded external spending.
    await approveNanoWalletPolicy({ dataDir: f.dir, grants: { externalTransfers: true, controllerPurposes: [] }, limits: { maxPaymentAtomic: '50', rolling24hAtomic: '50' }, terminalConfirmed: true });
    // Then the original key persists and the explicitly approved transfer succeeds.
    assert.deepEqual(readFileSync(join(f.dir, 'seed.hex')), seed);
    const wallet = f.open();
    t.after(() => wallet.close());
    assert.equal((await wallet.call('transfer.send', transfer(f))).state, 'CONFIRMED');
});
for (const mode of ['transient', 'changed', 'exhausted']) {
    test(`policy replacement handles ${mode} rename refusal without changing unrelated wallet data`, async t => {
        // Given an existing wallet and a child preload that refuses only policy-file renames.
        const f = await fixture(t), path = join(f.dir, 'wallet.json');
        const original = readFileSync(path), config = JSON.parse(original);
        const concurrent = { ...config, limits: { maxPaymentAtomic: '7', rolling24hAtomic: '17' } };
        const concurrentBytes = `${canonical(concurrent)}\n`;
        const journalPath = join(f.dir, 'nano-wallet.sqlite3'), journal = Buffer.from('retained journal bytes');
        writeFileSync(journalPath, journal, {mode:0o600});
        const seed = readFileSync(config.keySource.seedFile), preload = join(f.dir, 'policy-rename-preload.mjs');
        writeFileSync(preload, `
            import fs from 'node:fs';
            import {syncBuiltinESMExports} from 'node:module';
            const rename = fs.renameSync;
            globalThis.policyRenameAttempts = 0;
            globalThis.policyRenameSources = new Set();
            fs.renameSync = (source, target, ...args) => {
                if (target === ${JSON.stringify(path)} && /[.]nano-policy-[a-f0-9]{32}[.]tmp$/.test(source)) {
                    globalThis.policyRenameSources.add(source);
                    const attempt = ++globalThis.policyRenameAttempts;
                    if (${JSON.stringify(mode)} === 'changed' && attempt === 1)
                        fs.writeFileSync(target, ${JSON.stringify(concurrentBytes)});
                    if (${JSON.stringify(mode)} === 'exhausted' || attempt === 1)
                        throw Object.assign(new Error('Synthetic policy rename refusal.'), {code:'EPERM',syscall:'rename'});
                }
                return rename(source,target,...args);
            };
            syncBuiltinESMExports();
        `, {mode:0o600});
        const grants = {externalTransfers:false,controllerPurposes:['login']};
        const limits = {maxPaymentAtomic:'100',rolling24hAtomic:'100'};
        const childCode = `
            import {approveNanoWalletPolicy} from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
            try {
                await approveNanoWalletPolicy({dataDir:${JSON.stringify(f.dir)},grants:${JSON.stringify(grants)},
                    limits:${JSON.stringify(limits)},terminalConfirmed:true});
                console.log(JSON.stringify({code:'OK',attempts:globalThis.policyRenameAttempts,sourceCount:globalThis.policyRenameSources.size}));
            } catch(error) {
                console.log(JSON.stringify({code:error.code,syscall:error.syscall,attempts:globalThis.policyRenameAttempts,sourceCount:globalThis.policyRenameSources.size}));
            }
        `;
        // When the real policy owner handles the rename failure on the current operating system.
        const child = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href,
            '--input-type=module', '-e', childCode], {encoding:'utf8',timeout:5000});
        assert.equal(child.status,0,child.stderr);
        const result = JSON.parse(child.stdout);
        assert.equal(result.sourceCount,1);
        // Then only Windows retries, every retry checks the original config, and exhaustion remains bounded.
        if (process.platform === 'win32' && mode === 'transient') {
            assert.equal(result.code,'OK');
            assert.ok(Number.isInteger(result.attempts) && result.attempts >= 2 && result.attempts <= 20);
            assert.deepEqual(JSON.parse(readFileSync(path)),{...config,grants,limits});
        } else {
            const changed = process.platform === 'win32' && mode === 'changed';
            assert.equal(result.code,changed ? 'WALLET_CONFIGURATION_CHANGED' : 'EPERM');
            assert.equal(result.attempts,process.platform === 'win32' && mode === 'exhausted' ? 20 : 1);
            if (!changed) assert.equal(result.syscall,'rename');
            assert.deepEqual(readFileSync(path),mode === 'changed' ? Buffer.from(concurrentBytes) : original);
        }
        assert.deepEqual(readFileSync(config.keySource.seedFile),seed);
        assert.deepEqual(readFileSync(journalPath),journal);
        assert.equal(readdirSync(f.dir).some(name => name.startsWith('.nano-policy-')),false);
    });
}
test('controller signer accepts only fresh exact configured typed challenges; verification needs no wallet', async (t) => {
    // Given the controller grants login for one origin, network and audience.
    const f = await fixture(t), wallet = f.open();
    t.after(() => wallet.close());
    const message = ['Nano Marketplace Agent Controller Proof v1', 'Audience: marketplace', 'Network: nano:dev', `Address: ${f.source}`, 'Purpose: login', `Request ID: ${randomUUID()}`, 'Binding Hash: ' + 'b'.repeat(64), 'Nonce: ' + 'c'.repeat(64), 'Issued At: 2026-11-02T12:00:00Z', 'Expiration Time: 2026-11-02T12:05:00Z'].join('\n');
    const request = { origin: 'http://localhost:8080', network: 'nano:dev', address: f.source, index: 1, audience: 'marketplace', purpose: 'login', message };
    // When the exact fresh structured challenge and changed alternatives are signed.
    const { signature } = await wallet.call('message.sign', request);
    // Then only the bound challenge verifies through the public verifier.
    assert.equal(verifyNanoMessage({ address: f.source, message, signature }), true);
    for (const change of [{ message: 'a'.repeat(64) }, { purpose: 'product purchase' }, { audience: 'foreign' }, { message: message.replace('12:05:00Z', '12:00:00Z') }, { message: message + '\n' }])
        await assert.rejects(wallet.call('message.sign', { ...request, ...change }), { code: 'CONTROLLER_PROOF_INVALID' });
});
test('unavailable process metadata preserves live preparation ownership and only ESRCH proves death', () => {
    // Given process start metadata may be unavailable on a supported host.
    assert.equal(processOwnerAlive(`${process.pid}:unknown:test`, () => null, () => {
    }), true);
    // When ownership checks observe a live PID, denied probe or explicit process absence.
    assert.equal(processOwnerAlive(`${process.pid}:123:test`, () => null, () => {
        throw Object.assign(Error(), { code: 'EPERM' });
    }), true);
    // Then only positive death evidence permits unsigned recovery.
    assert.equal(processOwnerAlive('999999999:123:test', () => null, () => {
        throw Object.assign(Error(), { code: 'ESRCH' });
    }), false);
    assert.equal(processOwnerAlive('5:123:test', () => '5:124', () => {
    }), false);
});
test('receive reclaims only a demonstrably dead unsigned preparation, then journals and confirms original funding', async (t) => {
    // Given a killed process left an unsigned receive reservation.
    const f = await fixture(t), hash = 'C'.repeat(64), fundingSource = addressFromPublicKey(publicKey(derivePrivateKey(Buffer.from('03'.repeat(32), 'hex'), 1))), fundingKey = derivePrivateKey(Buffer.from('03'.repeat(32), 'hex'), 1);
    const previous = NanoStateBlock.signed(fundingKey, 'D'.repeat(64), fundingSource, 100n, '0'.repeat(64), '0'.repeat(16));
    const send = NanoStateBlock.signed(fundingKey, previous.hash, fundingSource, 90n, upperHex(addressPublicKey(f.source)), '0'.repeat(16));
    f.blocks.set(previous.hash, { block: previous, blockAccount: fundingSource, subtype: 'receive', confirmed: true });
    f.blocks.set(send.hash, { block: send, blockAccount: fundingSource, subtype: 'send', confirmed: true });
    f.rpc.receivable = async () => [{ hash: send.hash, amount: 10n, source: fundingSource }];
    const terms = { network: 'nano:dev', hash: send.hash, amountAtomic: '10' }, json = canonical(terms), journal = new NanoJournal(f.dir);
    journal.db.prepare(`INSERT INTO operations(id,kind,digest,requestJson,uniqueId,source,network,amount,destination,createdAt,state,owner) VALUES(?,?,?,?,?,?,?,?,?,?,'PREPARING',?)`).run(`receive:${send.hash}`, 'receive', sha256(json), json, `receive:${send.hash}`, f.source, 'nano:dev', '0', send.hash, now, '999999999:123:dead');
    journal.close();
    const wallet = f.open();
    t.after(() => wallet.close());
    // When the wallet retries the original confirmed funding send.
    const received = await wallet.call('receive', { network: 'nano:dev', hash: send.hash });
    // Then the reservation is reclaimed and one RECEIVE increases the confirmed balance.
    assert.equal(received.state, 'CONFIRMED');
    assert.equal(f.published.length, 1);
    assert.equal(f.published[0].balance, 1010n);
});
test('revoking permission during work generation prevents a signature, clears unsigned reservation, and keeps source reusable', async (t) => {
    // Given an approved transfer waits for work generation.
    const f = await fixture(t), wallet = f.open();
    t.after(() => wallet.close());
    let release;
    f.pause = new Promise(r => release = r);
    // When a terminal update revokes its grant before work returns.
    const first = wallet.call('transfer.send', transfer(f));
    await new Promise(r => setImmediate(r));
    await approveNanoWalletPolicy({ dataDir: f.dir, grants: { externalTransfers: false, controllerPurposes: [] }, limits: { maxPaymentAtomic: '100', rolling24hAtomic: '100' }, terminalConfirmed: true });
    release();
    // Then no candidate is signed or published and the unsigned reservation is cleared.
    await assert.rejects(first, { code: 'PERMISSION_DENIED' });
    assert.equal(f.published.length, 0);
    const journal = new NanoJournal(f.dir);
    assert.equal(journal.db.prepare('SELECT count(*) AS n FROM operations').get().n, 0);
    journal.close();
});
test('confirmed rolling spend expires after 24 hours while current reservations do not', async (t) => {
    // Given a confirmed transfer exactly consumes the rolling limit.
    const f = await fixture(t, { limit: '60' });
    let wallet = f.open();
    // When a new transfer arrives after the full 24-hour window.
    await wallet.call('transfer.send', transfer(f, '60'));
    wallet.close();
    wallet = f.open(now + 86400001);
    t.after(() => wallet.close());
    // Then only expired confirmed usage is released.
    assert.equal((await wallet.call('transfer.send', transfer(f, '60'))).state, 'CONFIRMED');
});
test('the native adapter leaves typed approval files and consent to Marketplace', () => {
    // Given the current native adapter export surface.
    // When callers inspect its supported workflow boundary.
    // Then the obsolete Shop-specific request-file approval is unavailable.
    assert.equal(Object.hasOwn(nanoAdapter, 'approveNanoControllerProduct'), false);
    assert.equal(typeof signMarketplaceNanoController, 'function');
});

test('the native typed signer requires local terminal consent before key access', async t => {
    // Given a configured native wallet and a valid native controller frame.
    const f = await fixture(t), request = terminalProof(f, 'API-key creation');
    const descriptors = [process.stdin, process.stderr].map(stream => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
    try {
        for (const stream of [process.stdin, process.stderr]) Object.defineProperty(stream, 'isTTY', { configurable: true, value: false });
        // When a nonterminal caller tries to claim consent.
        await assert.rejects(signMarketplaceNanoController({ dataDir: f.dir, request, terminalConfirmed: true }), { code: 'TERMINAL_REQUIRED' });
        for (const stream of [process.stdin, process.stderr]) Object.defineProperty(stream, 'isTTY', { configurable: true, value: true });
        await assert.rejects(signMarketplaceNanoController({ dataDir: f.dir, request, terminalConfirmed: false }), { code: 'TERMINAL_REQUIRED' });
        // Then no approval response or native transaction has been produced.
        assert.equal(f.published.length, 0);
    } finally { restoreTerminal(descriptors); }
});

test('the native typed signer accepts reviewed user frames and keeps headless purposes restricted', async t => {
    // Given a local terminal and wallet with no recurring controller signing grants.
    const f = await fixture(t, { grants: { externalTransfers: false, controllerPurposes: [] } });
    const descriptors = [process.stdin, process.stderr].map(stream => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
    const wallet = f.open();
    t.after(() => wallet.close());
    try {
        for (const stream of [process.stdin, process.stderr]) Object.defineProperty(stream, 'isTTY', { configurable: true, value: true });
        const request = terminalProof(f, 'API-key creation');
        // When Marketplace's terminal boundary delegates its already reviewed exact frame.
        const signature = await signMarketplaceNanoController({ dataDir: f.dir, request, terminalConfirmed: true });
        // Then only that exact native frame verifies, and headless signing gains no new authority.
        assert.equal(verifyNanoMessage({ address: f.source, message: request.message, signature }), true);
        assert.equal(verifyNanoMessage({ address: f.source, message: `${request.message} `, signature }), false);
        await assert.rejects(wallet.call('message.sign', request), { code: 'CONTROLLER_PROOF_INVALID' });
        await assert.rejects(wallet.call('message.sign', terminalProof(f, 'login')), { code: 'CONTROLLER_PROOF_INVALID' });
        for (const changed of [
            terminalProof(f, 'administrator public moderation'),
            terminalProof(f, 'message signing'),
            { ...request, message: 'ab'.repeat(32) },
            { ...request, message: request.message.replace('Purpose: API-key creation', 'Purpose: login') },
            { ...request, origin: 'https://foreign.example' },
            { ...request, network: 'nano:mainnet' },
            { ...request, index: 2 },
        ]) await assert.rejects(signMarketplaceNanoController({ dataDir: f.dir, request: changed, terminalConfirmed: true }), { code: 'CONTROLLER_PROOF_INVALID' });
    } finally { restoreTerminal(descriptors); }
});

function terminalProof(f, purpose) {
    const issuedAt = new Date(Date.now() - 1000).toISOString(), expiresAt = new Date(Date.now() + 120000).toISOString();
    return { origin: 'http://localhost:8080', network: 'nano:dev', address: f.source, index: 1, audience: 'marketplace', purpose,
        message: ['Nano Marketplace Agent Controller Proof v1', 'Audience: marketplace', 'Network: nano:dev', `Address: ${f.source}`,
            `Purpose: ${purpose}`, `Request ID: ${randomUUID()}`, 'Binding Hash: ' + 'b'.repeat(64), 'Nonce: ' + 'c'.repeat(64),
            `Issued At: ${issuedAt}`, `Expiration Time: ${expiresAt}`].join('\n') };
}
function restoreTerminal(descriptors) {
    [process.stdin, process.stderr].forEach((stream, index) => {
        if (descriptors[index]) Object.defineProperty(stream, 'isTTY', descriptors[index]);
        else delete stream.isTTY;
    });
}

test('abrupt exit between atomic publication link and unlink recovers exact response; unrelated hardlinks remain forbidden', async t => {
    // Given the actual publisher exits immediately after its create-only hard link.
    const f = await fixture(t), path = join(f.handoff, 'a'.repeat(32) + '.response.json'), moduleUrl = new URL('../dist/private-files.js', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const link=fs.linkSync;fs.linkSync=(...args)=>{link(...args);process.exit(73);};syncBuiltinESMExports();const {publishPrivate}=await import(${JSON.stringify(moduleUrl)});publishPrivate(${JSON.stringify(path)},Buffer.from('{}\\n'));`]);
    assert.equal(child.status, 73);
    assert.equal(lstatSync(path).nlink, 2);
    // When a restart reads and retries the exact saved response.
    assert.equal(readPrivate(path).toString(), '{}\n');
    publishPrivate(path, Buffer.from('{}\n'));
    // Then only the recognized same-inode temporary publication is removed.
    assert.equal(lstatSync(path).nlink, 1);
    const unsafe = join(f.handoff, 'b'.repeat(32) + '.response.json');
    writeFileSync(unsafe, '{}\n', { mode: 0o600 });
    linkSync(unsafe, join(f.handoff, 'unrelated-link'));
    assert.throws(() => readPrivate(unsafe), { code: 'PRIVATE_FILE' });
});
test('signed journal candidates cannot be rewritten or deleted, and malformed saved identity is rejected before RPC', async (t) => {
    // Given a confirmed transfer with its immutable original candidate.
    const f = await fixture(t), wallet = f.open(), args = transfer(f);
    t.after(() => wallet.close());
    await wallet.call('transfer.send', args);
    const journal = new NanoJournal(f.dir), id = `transfer:${args.requestId}`;
    // When candidate bytes, original economic terms or retained history are modified.
    assert.throws(() => journal.db.prepare('UPDATE operations SET blockHash=? WHERE id=?').run('D'.repeat(64), id), /immutable signed candidate/);
    assert.throws(() => journal.db.prepare('UPDATE operations SET amount=? WHERE id=?').run('1', id), /immutable wallet terms/);
    assert.throws(() => journal.db.prepare('DELETE FROM operations WHERE id=?').run(id), /retain signed candidate/);
    const prior = journal.find(id), badId = randomUUID();
    journal.db.prepare(`INSERT INTO operations(id,kind,digest,requestJson,uniqueId,source,network,amount,destination,createdAt,state,owner,epoch,previous,previousBalance,representative,blockJson,blockHash,confirmedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`transfer:${badId}`, prior.kind, 'wrong-digest', prior.requestJson, `transfer:${badId}`, prior.source, prior.network, prior.amount, prior.destination, prior.createdAt, 'CONFIRMED', prior.owner, prior.epoch, prior.previous, prior.previousBalance, prior.representative, prior.blockJson, prior.blockHash, now);
    journal.close();
    // Then status refuses malformed persisted ownership without producing native effects.
    const published = f.published.length;
    await assert.rejects(wallet.call('transfer.status', { requestId: badId }), { code: 'JOURNAL_CONFLICT' });
    assert.equal(f.published.length, published);
});
test('independent processes serialize live preparation, reclaim a killed unsigned attempt, and recover one durable signed candidate', { timeout: process.platform === 'win32' ? 300000 : 10000 }, async (t) => {
    // Given two independent processes share one owner-only profile and SQLite account lane.
    const f = await fixture(t), request = transfer(f), moduleUrl = new URL('../dist/index.js', import.meta.url).href;
    const childCode = `
      import {NanoWallet,validWork} from ${JSON.stringify(moduleUrl)};
      const [dataDir,source,mode,operation,argText]=process.argv.slice(1),args=JSON.parse(argText);
      const snapshot={frontier:'A'.repeat(64),confirmedFrontier:'A'.repeat(64),balance:1000n,confirmedBalance:1000n,representative:source,confirmedRepresentative:source,epoch:2};
      function work(root){for(let n=0n;;n++){const nonce=n.toString(16).padStart(16,'0');if(validWork('nano:dev',2,false,root,nonce))return nonce;}}
      const rpc={requirePinnedNetwork:async()=>{},accountSnapshot:async()=>snapshot,accountSnapshotOrNotFound:async()=>snapshot,verifyFrontierState:async()=>{},blockInfo:async()=>null,generateWork:async root=>{if(mode==='hold'){console.log('WORK_PENDING');await new Promise(r=>setTimeout(r,${process.platform === 'win32' ? 300000 : 60000}));}return work(root);}};
      const wallet=NanoWallet.open({dataDir,rpc,now:()=>${now}});
      try{console.log(JSON.stringify(await wallet.call(operation,args)));}catch(error){console.log(JSON.stringify({errorCode:error.code}));}finally{wallet.close();}
    `;
    const args = ['--input-type=module', '-e', childCode, f.dir, f.source, 'hold', 'transfer.send', JSON.stringify(request)];
    const held = f.trackChild(spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] }));
    t.after(() => { if (!held.killed)
        held.kill('SIGKILL'); });
    const [pending] = await once(held.stdout, 'data');
    assert.ok(String(pending).includes('WORK_PENDING'));
    function run(operation, values) {
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', childCode, f.dir, f.source, 'run', operation, JSON.stringify(values)], { encoding: 'utf8', timeout: process.platform === 'win32' ? 60000 : 5000 });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout.trim());
    }
    // When another process races the live reservation and the first process is then killed.
    assert.equal(run('transfer.send', transfer(f)).errorCode, 'PAYMENT_IN_PROGRESS');
    held.kill('SIGKILL');
    await once(held, 'exit');
    const recovered = run('transfer.send', request);
    // Then a fresh process reclaims only the unsigned attempt and future processes reuse its exact saved signature.
    assert.equal(recovered.state, 'UNKNOWN');
    assert.equal(run('transfer.send', request).sendHash, recovered.sendHash);
    assert.equal(run('transfer.send', transfer(f)).errorCode, 'SOURCE_FENCED');
});

test('pending Nano payments are discoverable without sending authority and amounts stay exact',async t=>{
    const f=await fixture(t,{grants:{externalTransfers:false,controllerPurposes:[]}});
    let observed;
    f.rpc.receivable=async(address,limit)=>{observed={address,limit};return [{hash:'A'.repeat(64),amount:900719925474099312345n,source:f.destination}];};
    const wallet=f.open();t.after(()=>wallet.close());
    const result=await wallet.call('receivable.list',{network:'nano:dev',limit:3});
    assert.deepEqual(observed,{address:f.source,limit:3});
    assert.deepEqual(result.receivables,[{hash:'A'.repeat(64),amountAtomic:'900719925474099312345',source:f.destination}]);
    assert.equal(f.published.length,0);
    await assert.rejects(wallet.call('receivable.list',{network:'nano:mainnet',limit:3}),{code:'NETWORK_MISMATCH'});
    await assert.rejects(wallet.call('receivable.list',{network:'nano:dev',limit:101}),{code:'INVALID_REQUEST'});
    assert.equal(f.published.length,0);
});

function alternateWork(block, { valid = true, epoch = 2, receive = false, belowEpoch } = {}) {
    for (let nonce = BigInt('0x' + block.work) + 1n;; nonce++) {
        const work = nonce.toString(16).padStart(16, '0');
        if (validWork('nano:dev', epoch, receive, block.workRoot(), work) === valid &&
            (belowEpoch === undefined || !validWork('nano:dev', belowEpoch, receive, block.workRoot(), work)))
            return NanoStateBlock.parse({ ...block.toWire(), work });
    }
}
function fundingSend(f) {
    const key = derivePrivateKey(Buffer.from('03'.repeat(32), 'hex'), 1), source = addressFromPublicKey(publicKey(key));
    const previous = NanoStateBlock.signed(key, 'D'.repeat(64), source, 100n, ZERO_HASH, work('D'.repeat(64)));
    const send = NanoStateBlock.signed(key, previous.hash, source, 90n, upperHex(addressPublicKey(f.source)), work(previous.hash));
    f.blocks.set(previous.hash, { block: previous, blockAccount: source, subtype: 'change', confirmed: true });
    f.blocks.set(send.hash, { block: send, blockAccount: source, subtype: 'send', confirmed: true });
    return send;
}
for (const kind of ['transfer']) {
    test(`${kind} confirmation accepts another valid work nonce after lost acknowledgement and retains original bytes`, async t => {
        const f = await fixture(t); let wallet = f.open();
        const request = transfer(f);
        const args = request;
        f.mode = 'lost-after-confirm';
        const first = await wallet.call('transfer.send', args);
        assert.equal(first.state, kind === 'transfer' ? 'UNKNOWN' : 'PREPARED');
        const id = `${kind}:${request.requestId}`;
        const journal = new NanoJournal(f.dir), originalJson = journal.find(id).blockJson;
        journal.close();
        const original = NanoStateBlock.parse(JSON.parse(originalJson)), observed = alternateWork(original, { epoch: 0, belowEpoch: 2 });
        assert.equal(validWork('nano:dev', 0, false, observed.workRoot(), observed.work), true);
        assert.equal(validWork('nano:dev', 2, false, observed.workRoot(), observed.work), false);
        assert.equal(observed.hash, original.hash);
        assert.equal(observed.signature, original.signature);
        assert.notEqual(observed.work, original.work);
        assert.equal(observed.validSignature(), true);
        f.blocks.set(observed.hash, { block: observed, blockAccount: f.source, subtype: 'send', confirmed: true });
        f.account = { ...f.account, frontier: observed.hash, confirmedFrontier: observed.hash, balance: observed.balance, confirmedBalance: observed.balance };
        wallet.close(); wallet = f.open(); t.after(() => wallet.close());
        assert.equal((await wallet.call(`${kind}.status`, { requestId: request.requestId })).state, 'CONFIRMED');
        assert.equal(f.published.length, 1);
        const after = new NanoJournal(f.dir); assert.equal(after.find(id).blockJson, originalJson); after.close();
        f.mode = 'confirm';
        assert.equal((await wallet.call('transfer.send', transfer(f, '1'))).state, 'CONFIRMED');
    });
    test(`${kind} reconciliation rejects invalid work and changes to signed identity, account and subtype`, async t => {
        const f = await fixture(t), wallet = f.open(); t.after(() => wallet.close());
        const request = transfer(f);
        const args = request;
        f.mode = 'throw';
        const first = await wallet.call('transfer.send', args);
        const id = `${kind}:${request.requestId}`;
        const journal = new NanoJournal(f.dir), row = journal.find(id); journal.close();
        const original = NanoStateBlock.parse(JSON.parse(row.blockJson));
        const evidence = { block: original, blockAccount: f.source, subtype: 'send', confirmed: true };
        const changed = fields => NanoStateBlock.parse({ ...original.toWire(), ...fields,
            ...(fields.link ? { link_as_account: addressFromPublicKey(hexBytes(fields.link)) } : {}) });
        const mutations = [
            { block: alternateWork(original, { valid: false, epoch: 0 }) },
            { block: changed({ account: f.destination }) }, { block: changed({ previous: ZERO_HASH }) },
            { block: changed({ representative: f.destination }) }, { block: changed({ balance: '0' }) },
            { block: changed({ link: ZERO_HASH }) }, { block: changed({ signature: '0'.repeat(128) }) },
            { blockAccount: f.destination }, { subtype: 'receive' }, { subtype: 'epoch' },
        ];
        for (const mutation of mutations) {
            f.blocks.set(first.sendHash, { ...evidence, ...mutation });
            await assert.rejects(wallet.call(`${kind}.status`, { requestId: request.requestId }), { code: 'RPC_CONFLICT' });
        }
        f.blocks.set(first.sendHash, { ...evidence, block: alternateWork(original, { epoch: 0, belowEpoch: 2 }), confirmed: false });
        await assert.rejects(wallet.call(`${kind}.status`, { requestId: request.requestId }), { code: 'RPC_CONFLICT' });
        f.blocks.set(first.sendHash, { ...evidence, block: alternateWork(original), confirmed: false });
        assert.notEqual((await wallet.call(`${kind}.status`, { requestId: request.requestId })).state, 'CONFIRMED');
        await assert.rejects(wallet.call('transfer.send', transfer(f, '1')), { code: 'SOURCE_FENCED' });
    });
}
test('a 101st receivable is received by exact hash and an exact replay publishes no second receive', async t => {
    const f = await fixture(t), send = fundingSend(f), wallet = f.open(); t.after(() => wallet.close());
    const rows = Array.from({ length: 100 }, (_, i) => ({ hash: i.toString(16).padStart(64, '0').toUpperCase(), amount: 1n, source: send.account }));
    rows.push({ hash: send.hash, amount: 10n, source: send.account });
    f.rpc.receivable = async (_address, count = 100) => rows.slice(0, count);
    const checked = [];
    f.rpc.receivableExists = async hash => { checked.push(hash); return rows.some(row => row.hash === hash); };
    const received = await wallet.call('receive', { network: 'nano:dev', hash: send.hash });
    assert.equal(received.state, 'CONFIRMED'); assert.equal(received.amountAtomic, '10'); assert.equal(received.index, 1);
    assert.equal(f.published.length, 1); assert.equal(f.published[0].balance, 1010n);
    rows.splice(100, 1);
    const replay = await wallet.call('receive', { network: 'nano:dev', hash: send.hash });
    assert.equal(replay.state, 'CONFIRMED'); assert.equal(replay.index, 1);
    assert.equal(f.published.length, 1); assert.deepEqual(checked, [send.hash]);
});
test('receive recovers a candidate confirmed while checking a preparation for abandonment', async t => {
    // Given a writer that owns an unsigned receive for this funding block.
    const f = await fixture(t), send = fundingSend(f), wallet = f.open();
    const args = { network: 'nano:dev', hash: send.hash }, id = `receive:${send.hash}`;
    const requestJson = canonical({ ...args, amountAtomic: '10' });
    const account = f.account;
    const block = NanoStateBlock.signed(f.key, account.frontier, account.representative, account.balance + 10n, send.hash, work(account.frontier, true));
    const writer = new NanoJournal(f.dir);
    const receivableExists = t.mock.method(f.rpc, 'receivableExists', async () => false);
    const generateOpenWork = t.mock.method(f.rpc, 'generateOpenWork');
    const clearAbandoned = NanoJournal.prototype.clearAbandoned;
    try {
        writer.begin({ id, kind: 'receive', digest: sha256(requestJson), requestJson, uniqueId: id,
            source: f.source, network: args.network, amount: '0', destination: send.hash }, now, 100n);
        // When the writer confirms after the retry reads PREPARING, before its cleanup transaction.
        t.mock.method(NanoJournal.prototype, 'clearAbandoned', function (row) {
            writer.save(id, { epoch: account.epoch, previous: account.frontier, previousBalance: String(account.balance),
                representative: account.representative, blockJson: canonical(block.toWire()), blockHash: block.hash });
            writer.state(id, 'CONFIRMED', now);
            return clearAbandoned.call(this, row);
        });
        const recovered = await wallet.call('receive', args);
        // Then the retry returns the saved receive without checking for new funding or publishing.
        assert.equal(recovered.state, 'CONFIRMED');
        assert.equal(recovered.sendHash, block.hash);
        assert.equal(recovered.amountAtomic, '10');
        assert.equal(recovered.replayed, true);
        assert.equal(receivableExists.mock.callCount(), 0);
        assert.equal(generateOpenWork.mock.callCount(), 0);
        assert.equal(f.published.length, 0);
    } finally {
        writer.close();
    }
});
test('exact receipt availability cannot replace confirmed signed SEND, recipient and predecessor amount proof', async t => {
    const f = await fixture(t), send = fundingSend(f), wallet = f.open(); t.after(() => wallet.close());
    const original = f.blocks.get(send.hash), predecessor = f.blocks.get(send.previous);
    let pending = false;
    f.rpc.receivableExists = async () => pending;
    await assert.rejects(wallet.call('receive', { network: 'nano:dev', hash: send.hash }), { code: 'FUNDING_NOT_RECEIVABLE' });
    pending = true;
    for (const altered of [ { ...original, confirmed: false }, { ...original, subtype: 'receive' },
        { ...original, block: NanoStateBlock.parse({ ...send.toWire(), signature: '0'.repeat(128) }) },
        { ...original, block: NanoStateBlock.parse({ ...send.toWire(), link: upperHex(addressPublicKey(f.destination)), link_as_account: f.destination }) } ]) {
        f.blocks.set(send.hash, altered);
        await assert.rejects(wallet.call('receive', { network: 'nano:dev', hash: send.hash }), { code: 'FUNDING_INVALID' });
    }
    f.blocks.set(send.hash, original);
    f.blocks.set(send.previous, { ...predecessor, blockAccount: f.destination });
    await assert.rejects(wallet.call('receive', { network: 'nano:dev', hash: send.hash }), { code: 'FUNDING_INVALID' });
    f.blocks.set(send.previous, predecessor);
    f.rpc.receivableExists = async () => { throw Object.assign(new Error('unsupported evidence'), { code: 'RPC_UNAVAILABLE' }); };
    await assert.rejects(wallet.call('receive', { network: 'nano:dev', hash: send.hash }), { code: 'RPC_UNAVAILABLE' });
    assert.equal(f.published.length, 0);
});
test('wallet receives from a valid pinned-signer epoch-open frontier', async t => {
    const f = await fixture(t), send = fundingSend(f), zero = addressFromPublicKey(new Uint8Array(32));
    const epochKey = hexBytes('34F0A37AAD20F4A260F0A5B3CB3D7FB50673212263E58A380BC10474BB039CE4');
    assert.equal(addressFromPublicKey(publicKey(epochKey)), DEV_GENESIS_ACCOUNT);
    const blank = new NanoStateBlock(f.source, ZERO_HASH, zero, 0n, epochLink(2), '0'.repeat(128), work(upperHex(addressPublicKey(f.source)), true));
    const epochOpen = NanoStateBlock.parse({ ...blank.toWire(), signature: upperHex(sign(epochKey, hexBytes(blank.hash))) });
    f.blocks.set(epochOpen.hash, { block: epochOpen, blockAccount: f.source, subtype: 'epoch', confirmed: true });
    f.account = { frontier: epochOpen.hash, confirmedFrontier: epochOpen.hash, balance: 0n, confirmedBalance: 0n, representative: zero, confirmedRepresentative: zero, epoch: 2 };
    const verifier = new NanoRpcClient('http://127.0.0.1:17076', 'nano:dev');
    verifier.blockInfo = f.rpc.blockInfo;
    f.rpc.verifyFrontierState = verifier.verifyFrontierState.bind(verifier);
    f.rpc.validConfirmedBlock = verifier.validConfirmedBlock.bind(verifier);
    f.rpc.receivable = async () => [{ hash: send.hash, amount: 10n, source: send.account }];
    f.rpc.receivableExists = async hash => hash === send.hash;
    const wallet = f.open(); t.after(() => wallet.close());
    const result = await wallet.call('receive', { network: 'nano:dev', hash: send.hash });
    assert.equal(result.state, 'CONFIRMED'); assert.equal(f.published.length, 1);
    assert.equal(f.published[0].previous, epochOpen.hash); assert.equal(f.published[0].balance, 10n);
    assert.equal(f.published[0].representative, zero);
});

test('bounded receivable discovery drains 101 exact pending sends without omission or duplicate publication', async t => {
    const f = await fixture(t), fundingKey = derivePrivateKey(Buffer.from('03'.repeat(32), 'hex'), 1);
    const source = addressFromPublicKey(publicKey(fundingKey)), pending = new Map();
    let previous = NanoStateBlock.signed(fundingKey, 'D'.repeat(64), source, 1000n, ZERO_HASH, work('D'.repeat(64)));
    f.blocks.set(previous.hash, { block: previous, blockAccount: source, subtype: 'change', confirmed: true });
    for (let index = 0; index < 101; index++) {
        const send = NanoStateBlock.signed(fundingKey, previous.hash, source, previous.balance - 1n,
            upperHex(addressPublicKey(f.source)), work(previous.hash));
        f.blocks.set(send.hash, { block: send, blockAccount: source, subtype: 'send', confirmed: true });
        pending.set(send.hash, { hash: send.hash, source, amount: 1n });
        previous = send;
    }
    const limits = [], publish = f.rpc.process.bind(f.rpc);
    f.rpc.receivable = async (_address, count = 100) => { limits.push(count); return [...pending.values()].slice(0, count); };
    f.rpc.receivableExists = async hash => pending.has(hash);
    f.rpc.process = async (block, subtype) => { await publish(block, subtype); pending.delete(block.link); };
    const wallet = f.open(); t.after(() => wallet.close());
    for (;;) {
        const page = await wallet.call('receivable.list', { network: 'nano:dev', limit: 100 });
        if (page.receivables.length === 0) break;
        for (const incoming of page.receivables) {
            assert.equal((await wallet.call('receive', { network: 'nano:dev', hash: incoming.hash })).state, 'CONFIRMED');
        }
    }
    assert.deepEqual(limits, [100, 100, 100]);
    assert.equal(pending.size, 0); assert.equal(f.published.length, 101);
    assert.equal(new Set(f.published.map(block => block.link)).size, 101);
    assert.equal(f.account.confirmedBalance, 1101n);
});

for (const opened of [true, false]) {
    test(`${opened ? 'epoch-2 receive' : 'epoch-2-source open'} recovery accepts confirmed receive work across restart without new bytes`, async t => {
        const f = await fixture(t), send = fundingSend(f);
        if (!opened) f.account = null;
        f.rpc.receivableExists = async hash => hash === send.hash;
        f.mode = 'lost-after-confirm';
        let wallet = f.open();
        const args = { network: 'nano:dev', hash: send.hash };
        const first = await wallet.call('receive', args);
        assert.equal(first.state, 'UNKNOWN');
        const original = f.published[0], subtype = opened ? 'receive' : 'open';
        assert.equal(original.previous === ZERO_HASH, !opened);
        const journal = new NanoJournal(f.dir), originalJson = journal.find(`receive:${send.hash}`).blockJson;
        journal.close();
        const observed = alternateWork(original, { receive: true, epoch: 2, belowEpoch: 0 });
        assert.equal(validWork('nano:dev', 2, true, observed.workRoot(), observed.work), true);
        assert.equal(validWork('nano:dev', 0, true, observed.workRoot(), observed.work), false);
        const evidence = { block: observed, blockAccount: f.source, subtype, confirmed: true };
        const changed = fields => NanoStateBlock.parse({ ...observed.toWire(), ...fields,
            ...(fields.link ? { link_as_account: addressFromPublicKey(hexBytes(fields.link)) } : {}) });
        for (const mutation of [
            { block: alternateWork(original, { receive: true, epoch: 2, valid: false }) },
            { block: changed({ account: f.destination }) }, { block: changed({ previous: 'B'.repeat(64) }) },
            { block: changed({ representative: f.destination }) }, { block: changed({ balance: '0' }) },
            { block: changed({ link: ZERO_HASH }) }, { block: changed({ signature: '0'.repeat(128) }) },
            { blockAccount: f.destination }, { subtype: 'send' }, { subtype: 'epoch' }, { confirmed: false },
        ]) {
            f.blocks.set(observed.hash, { ...evidence, ...mutation });
            await assert.rejects(wallet.call('receive', args), { code: 'RPC_CONFLICT' });
        }
        await assert.rejects(wallet.call('transfer.send', transfer(f, '1')), { code: 'SOURCE_FENCED' });
        f.blocks.set(observed.hash, evidence);
        f.account = { frontier: observed.hash, confirmedFrontier: observed.hash, balance: observed.balance,
            confirmedBalance: observed.balance, representative: observed.representative,
            confirmedRepresentative: observed.representative, epoch: 2 };
        wallet.close(); wallet = f.open(); t.after(() => wallet.close());
        assert.equal((await wallet.call('receive', args)).state, 'CONFIRMED');
        assert.equal(f.published.length, 1);
        const after = new NanoJournal(f.dir); assert.equal(after.find(`receive:${send.hash}`).blockJson, originalJson); after.close();
    });
}


test('receive requires explicit external-transfer approval and does not debit spending limits', async t => {
    for (const grants of [
        { externalTransfers: false, controllerPurposes: ['login'] },
        { externalTransfers: true, controllerPurposes: [] },
    ]) {
        const f = await fixture(t, { grants, limit: '0' }), send = fundingSend(f), wallet = f.open();
        t.after(() => wallet.close());
        f.rpc.receivableExists = async hash => hash === send.hash;
        const args = { network: 'nano:dev', hash: send.hash };
        if (!grants.externalTransfers) {
            await assert.rejects(wallet.call('receive', args), { code: 'PERMISSION_DENIED' });
            assert.equal(f.pinCount, 0);
            assert.equal(f.published.length, 0);
        } else {
            const result = await wallet.call('receive', args);
            assert.equal(result.state, 'CONFIRMED');
            assert.equal(result.amountAtomic, '10');
            assert.equal(f.published.length, 1);
        }
    }
});

test('receive succeeds after the rolling limit drops below recent outgoing spend', async t => {
    const f = await fixture(t), wallet = f.open();
    const outgoing = await wallet.call('transfer.send', transfer(f, '40'));
    assert.equal(outgoing.state, 'CONFIRMED');
    await approveNanoWalletPolicy({ dataDir: f.dir, grants: f.grants,
        limits: { maxPaymentAtomic: '0', rolling24hAtomic: '0' }, terminalConfirmed: true });
    await assert.rejects(wallet.call('transfer.send', transfer(f, '1')), { code: 'SPEND_LIMIT' });

    const send = fundingSend(f);
    f.rpc.receivableExists = async hash => hash === send.hash;
    const args = { network: 'nano:dev', hash: send.hash };
    const received = await wallet.call('receive', args);
    assert.equal(received.state, 'CONFIRMED');
    assert.equal(received.amountAtomic, '10');
    assert.equal(f.account.confirmedBalance, 970n);
    assert.equal((await wallet.call('receive', args)).state, 'CONFIRMED');
    assert.equal(f.published.length, 2);
});

test('receive rechecks local authority after asynchronous work and retains signed recovery after revocation', async t => {
    const f = await fixture(t), send = fundingSend(f), wallet = f.open();
    t.after(() => wallet.close());
    f.rpc.receivableExists = async hash => hash === send.hash;
    const generate = f.rpc.generateOpenWork.bind(f.rpc);
    f.rpc.generateOpenWork = async root => {
        const result = await generate(root);
        await approveNanoWalletPolicy({ dataDir: f.dir,
            grants: { externalTransfers: false, controllerPurposes: [] },
            limits: { maxPaymentAtomic: '100', rolling24hAtomic: '100' }, terminalConfirmed: true });
        return result;
    };
    const args = { network: 'nano:dev', hash: send.hash };
    await assert.rejects(wallet.call('receive', args), { code: 'PERMISSION_DENIED' });
    assert.equal(f.published.length, 0);
    const journal = new NanoJournal(f.dir);
    assert.equal(journal.find(`receive:${send.hash}`), undefined);
    journal.close();
    await approveNanoWalletPolicy({ dataDir: f.dir,
        grants: { externalTransfers: true, controllerPurposes: [] },
        limits: { maxPaymentAtomic: '100', rolling24hAtomic: '100' }, terminalConfirmed: true });
    f.rpc.generateOpenWork = generate;
    f.mode = 'throw';
    const first = await wallet.call('receive', args);
    assert.equal(first.state, 'UNKNOWN');
    await approveNanoWalletPolicy({ dataDir: f.dir,
        grants: { externalTransfers: false, controllerPurposes: [] },
        limits: { maxPaymentAtomic: '100', rolling24hAtomic: '100' }, terminalConfirmed: true });
    f.mode = 'confirm';
    const replay = await wallet.call('receive', args);
    assert.equal(replay.sendHash, first.sendHash);
    assert.equal(replay.state, 'CONFIRMED');
});

test('external transfer and status expose immutable destination, amount and selected index', async t => {
    const f = await fixture(t), wallet = f.open(), args = transfer(f);
    t.after(() => wallet.close());
    const first = await wallet.call('transfer.send', args);
    const status = await wallet.call('transfer.status', { requestId: args.requestId });
    for (const result of [first, status]) {
        assert.equal(result.destination, args.destination);
        assert.equal(result.amountAtomic, args.amountAtomic);
        assert.equal(result.index, 1);
        assert.equal(result.sourceAddress, f.source);
        assert.equal(result.sendHash, first.sendHash);
    }
});


test('native status clears only its original abandoned unsigned transfer', async t => {
    const f = await fixture(t), args = transfer(f), id = `transfer:${args.requestId}`;
    const journal = new NanoJournal(f.dir);
    try {
        const insert = journal.db.prepare(`INSERT INTO operations(id,kind,digest,requestJson,uniqueId,source,network,amount,destination,createdAt,state,owner) VALUES(?,?,?,?,?,?,?,?,?,?,'PREPARING',?)`);
        const json = canonical(args);
        insert.run(id, 'transfer', sha256(json), json, id, f.source, args.network, args.amountAtomic, args.destination, now, '999999999:123:dead');
        const stale = journal.find(id);
        const wallet = f.open();
        await assert.rejects(wallet.call('payment.status', { requestId: args.requestId }), { code: 'JOURNAL_CONFLICT' });
        assert.equal(f.pinCount, 0);
        const result = await wallet.call('transfer.status', { requestId: args.requestId });
        assert.equal(result.state, 'READY');
        assert.equal(result.requestId, args.requestId);
        assert.equal(result.destination, args.destination);
        assert.equal(result.amountAtomic, args.amountAtomic);
        assert.equal(result.index, 1);
        assert.equal(result.sourceAddress, f.source);
        assert.equal(result.network, args.network);
        assert.equal(result.sendHash, null);
        assert.equal(result.candidateState, 'ABSENT');
        assert.equal(f.published.length, 0);
        assert.equal(journal.find(id), undefined);

        // A second process reserves the vacant ID and dies while another reader still holds the old row.
        const replacement = canonical({ ...args, amountAtomic: '41' });
        insert.run(id, 'transfer', sha256(replacement), replacement, id, f.source, args.network, '41', args.destination, now, '999999999:123:replacement');
        assert.equal(journal.clearAbandoned(stale), false);
        assert.equal(journal.find(id).requestJson, replacement);
    } finally {
        journal.close();
    }
});


test('configured native reads do not unlock keys while signing and explicit inspection still require the original seed', async t => {
    // Given an approved wallet whose original key source is temporarily unavailable.
    const f = await fixture(t), seedFile = join(f.dir, 'seed.hex'), unavailable = join(f.dir, 'seed.saved');
    const wallet = f.open();
    t.after(() => wallet.close());
    const original = await wallet.call('transfer.send', transfer(f, '1'));
    const before = new NanoJournal(f.dir);
    const candidateDigest = sha256(JSON.stringify(before.db.prepare('SELECT * FROM operations ORDER BY id').all()));
    before.close();
    renameSync(seedFile, unavailable);
    const identity = { address: f.source, index: 1, network: 'nano:dev' };
    const pending = { hash: 'AB'.repeat(32), amount: 7n, source: f.destination };
    f.rpc.receivable = async () => [pending];
    // When public account identity, balance and incoming observations are requested.
    assert.deepEqual(await wallet.call('identity.list'), { identities: [identity] });
    assert.deepEqual(await wallet.call('balance.get', { network: 'nano:dev' }),
        { ...identity, balanceAtomic: '999', pending: false });
    assert.deepEqual(await wallet.call('receivable.list', { network: 'nano:dev', limit: 10 }),
        { ...identity, receivables: [{ hash: pending.hash, amountAtomic: '7', source: f.destination }] });
    // Then reads succeed, while new signatures and explicit key/source proofs still fail before journal admission.
    await assert.rejects(wallet.call('transfer.send', transfer(f, '1')), { code: 'PRIVATE_FILE' });
    await assert.rejects(wallet.call('receive', { network: 'nano:dev', hash: pending.hash }), { code: 'PRIVATE_FILE' });
    await assert.rejects(inspectNanoWallet(f.dir), { code: 'PRIVATE_FILE' });
    await assert.rejects(provisionNanoWallet({ dataDir: join(f.dir, 'unprovisioned'), seedFile, derivationIndex: 1,
        network: 'nano:dev', rpcUrl: 'http://127.0.0.1:17076', origin: 'http://localhost:8080', audience: 'marketplace',
        terminalConfirmed: true }), { code: 'PRIVATE_FILE' });
    const journal = new NanoJournal(f.dir);
    assert.equal(journal.db.prepare('SELECT COUNT(*) AS count FROM operations').get().count, 1);
    assert.equal(sha256(JSON.stringify(journal.db.prepare('SELECT * FROM operations ORDER BY id').all())), candidateDigest);
    assert.equal(journal.db.prepare('SELECT blockHash FROM operations').get().blockHash, original.sendHash);
    journal.close();
    assert.equal(f.published.length, 1);
    renameSync(unavailable, seedFile);
    assert.equal((await inspectNanoWallet(f.dir)).sourceAddress, f.source);
    assert.equal((await wallet.call('transfer.send', transfer(f, '1'))).state, 'CONFIRMED');
});





test('fixture cleanup closes restarted wallets before removing exact signed recovery files', {timeout:process.platform==='win32'?180000:10000},async t=>{
    // Given a child fixture with an uncertain direct SEND.
    let directory;
    await t.test('owned wallet lifecycle',async child=>{
        const f=await fixture(child),request=transfer(f);directory=f.dir;f.mode='throw';
        let wallet=f.open();const first=await wallet.call('transfer.send',request);
        const journal=new NanoJournal(f.dir),bytes=journal.find(`transfer:${request.requestId}`).blockJson;journal.close();
        // When it restarts, only its original candidate may be retried.
        wallet.close();wallet.close();wallet=f.open();
        const retry=await wallet.call('transfer.send',request);
        const after=new NanoJournal(f.dir);assert.equal(after.find(`transfer:${request.requestId}`).blockJson,bytes);after.close();
        assert.equal(retry.sendHash,first.sendHash);child.after(()=>wallet.close());
    });
    // Then cleanup owns the restarted wallet and completes removal.
    assert.equal(existsSync(directory),false);
});


test('x402 relay preparation and original header survive restart without Nano publication or a second allowance',async t=>{
    // Given immutable seller terms and the selected native wallet's existing transfer authority.
    const f=await fixture(t),p=terms('XNO',f.source,f.destination),request={requestId:paymentId,origin:'http://localhost:8080',audience:'marketplace',terms:p,paymentRequired:offer(p,'http://localhost:8080')};
    let wallet=f.open();
    // When the wallet prepares its candidate and durably retains the exact final header.
    const prepared=await wallet.call('payment.prepare',request);
    wallet.close();wallet=f.open(now+172800000);
    const pinCount = f.pinCount;
    await assert.rejects(wallet.call('transfer.status', { requestId: paymentId }), { code: 'NOT_FOUND' });
    assert.equal(f.pinCount, pinCount);
    const recovered=await wallet.call('payment.status',{requestId:paymentId});
    // Then Market can recover the unchanged candidate while status and generic sends cannot publish or replace it.
    assert.equal(f.published.length,0);assert.equal(recovered.hash,prepared.hash);assert.equal(recovered.paymentSignature,prepared.paymentSignature);
    const payload=decodePaymentHeader(recovered.paymentSignature);
    assert.equal(payload.payload.block.link_as_account,f.destination);assert.equal(payload.payload.block.balance,'960');
    assert.deepEqual(Object.keys(payload.extensions),['payment-identifier']);
    assert.equal(payload.extensions['payment-identifier'].info.id,paymentId);
    await assert.rejects(wallet.call('transfer.send',transfer(f,'40',paymentId)),{code:'HANDLE_REUSE'});
    await assert.rejects(wallet.call('transfer.send',transfer(f,'1')),{code:'SOURCE_FENCED'});
    assert.equal((await wallet.call('payment.prepare',request)).paymentSignature,recovered.paymentSignature);
    assert.equal(f.published.length,0);
    const journal=new NanoJournal(f.dir),row=journal.find(`transfer:${paymentId}`);journal.close();
    // Given Market later publishes that exact saved SEND and the native chain confirms it.
    await f.rpc.process(NanoStateBlock.parse(JSON.parse(row.blockJson)),'send');
    // When original status is read, then canonical SEND confirmation releases the lane without recipient RECEIVE.
    const nextTerms={...p,paymentId:randomUUID(),amountAtomic:'1'};
    const next=await wallet.call('payment.prepare',{...request,requestId:nextTerms.paymentId,terms:nextTerms,paymentRequired:offer(nextTerms,request.origin)});
    assert.notEqual(next.hash,prepared.hash);
    const confirmed=await wallet.call('payment.status',{requestId:paymentId});
    assert.equal(confirmed.state,'CONFIRMED');assert.equal(f.published.length,1);
    assert.equal(confirmed.paymentSignature,recovered.paymentSignature);
});

test('x402 relay rejects changed terms and requires the existing transfer grant',async t=>{
    const f=await fixture(t),wallet=f.open(),p=terms('XNO',f.source,f.destination),request={requestId:paymentId,origin:'http://localhost:8080',audience:'marketplace',terms:p,paymentRequired:offer(p,'http://localhost:8080')};
    await approveNanoWalletPolicy({dataDir:f.dir,grants:{externalTransfers:false,controllerPurposes:[]},limits:{maxPaymentAtomic:'100',rolling24hAtomic:'100'},terminalConfirmed:true});
    await assert.rejects(wallet.call('payment.prepare',request),{code:'PERMISSION_DENIED'});
    await approveNanoWalletPolicy({dataDir:f.dir,grants:{externalTransfers:true,controllerPurposes:[]},limits:{maxPaymentAtomic:'100',rolling24hAtomic:'100'},terminalConfirmed:true});
    const prepared=await wallet.call('payment.prepare',request);
    await assert.rejects(wallet.call('payment.prepare',{...request,terms:{...p,amountAtomic:'41'}}));
    await assert.rejects(wallet.call('payment.prepare',{...request,terms:{...p,termsHash:'c'.repeat(64)}}),{code:'HANDLE_REUSE'});
    assert.equal((await wallet.call('payment.status',{requestId:paymentId})).hash,prepared.hash);
    assert.equal(f.published.length,0);
});

for(const hasHeader of [false,true]) test(`Nano reopens a previous-version ${hasHeader?'authorized':'prepared'} relay without signing another block`, async t=>{
    const f=await fixture(t),p=terms('XNO',f.source,f.destination);
    const request={requestId:paymentId,origin:'http://localhost:8080',audience:'marketplace',terms:p,paymentRequired:legacyOffer(p,'http://localhost:8080',now)};
    const requestJson=canonical({...transfer(f,'40',paymentId),relay:request}),journal=new NanoJournal(f.dir),id='transfer:'+paymentId;
    journal.begin({id,kind:'transfer',digest:sha256(requestJson),requestJson,uniqueId:id,source:f.source,network:p.network,amount:p.amountAtomic,destination:f.destination},now,100n);
    const prior=f.account,block=NanoStateBlock.signed(f.key,prior.frontier,f.source,960n,upperHex(addressPublicKey(f.destination)),work(prior.frontier));
    journal.save(id,{epoch:prior.epoch,previous:prior.frontier,previousBalance:'1000',representative:f.source,blockJson:canonical(block.toWire()),blockHash:block.hash});
    let header;
    if(hasHeader) {
        const c=legacyChallenge(p,block.hash,request.audience,now);
        header=legacyHeader(request,{block:block.toWire()},{challengeId:c.challengeId,message:c.message,signature:upperHex(offchainSign(f.key,c.message))});
        journal.authorizeRelay(id,header);
    }
    journal.close();
    f.rpc.generateWork=async()=>assert.fail('Recovery requested another block');
    const wallet=f.open(),status=await wallet.call('payment.status',{requestId:paymentId});
    assert.equal(status.paymentSignature,header??null);
    const prepared=await wallet.call('payment.prepare',request);
    assert.equal(prepared.hash,block.hash);assert.equal(prepared.paymentRequired,request.paymentRequired);
    if(hasHeader) assert.equal(prepared.paymentSignature,header);
    else assert.deepEqual(Object.keys(decodePaymentHeader(prepared.paymentSignature).extensions),['payment-identifier']);
    assert.deepEqual(decodePaymentHeader(prepared.paymentSignature).payload.block,block.toWire());
    assert.equal((await wallet.call('payment.status',{requestId:paymentId})).paymentSignature,prepared.paymentSignature);
    assert.equal(f.published.length,0);
});

test('an unsigned pre-upgrade Nano relay resumes its original reservation after its owner exits', {timeout:20000},async t=>{
    // Given a real process holding the original source lane before work or a signed candidate exists.
    const f=await fixture(t),p=terms('XNO',f.source,f.destination),request={requestId:paymentId,origin:'http://localhost:8080',audience:'marketplace',terms:p,paymentRequired:offer(p,'http://localhost:8080')};
    const oldRequest={...request,paymentRequired:legacyOffer(p,request.origin,now)};
    const requestJson=canonical({...transfer(f,'40',paymentId),relay:oldRequest}),id='transfer:'+paymentId;
    const reservation={id,kind:'transfer',digest:sha256(requestJson),requestJson,uniqueId:id,source:f.source,network:p.network,amount:p.amountAtomic,destination:f.destination};
    const childCode=`
      import {NanoJournal} from ${JSON.stringify(new URL('../dist/journal.js',import.meta.url).href)};
      const journal=new NanoJournal(process.argv[1]);
      journal.begin(JSON.parse(process.argv[2]),${now},100n);
      console.log('RESERVED');
      await new Promise(r=>setTimeout(r,60000));
    `;
    const held=f.trackChild(spawn(process.execPath,['--input-type=module','-e',childCode,f.dir,JSON.stringify(reservation)],{stdio:['ignore','pipe','pipe']}));
    held.stderr.resume();const [pending]=await once(held.stdout,'data');assert.match(String(pending),/RESERVED/);
    const beforeJournal=new NanoJournal(f.dir),original=beforeJournal.find(`transfer:${paymentId}`);beforeJournal.close();
    assert.equal(original.blockHash,null);assert.equal(original.blockJson,null);
    const wallet=f.open();
    await assert.rejects(wallet.call('payment.prepare',request),{code:'PAYMENT_IN_PROGRESS'});
    const still=new NanoJournal(f.dir);assert.equal(still.find(original.id).requestJson,original.requestJson);still.close();
    const exited=once(held,'exit');held.kill('SIGKILL');await exited;
    await assert.rejects(wallet.call('transfer.status', { requestId: paymentId }), { code: 'NOT_FOUND' });
    const unsigned = await wallet.call('payment.status', { requestId: paymentId });
    assert.equal(unsigned.state, 'PREPARING');assert.equal(unsigned.hash, null);assert.equal(unsigned.paymentRequired, oldRequest.paymentRequired);
    await assert.rejects(wallet.call('payment.prepare',{...request,terms:{...p,termsHash:'c'.repeat(64)}}));
    const recovered=await wallet.call('payment.prepare',request),afterJournal=new NanoJournal(f.dir),after=afterJournal.find(original.id);
    assert.equal(after.createdAt,original.createdAt);assert.equal(after.amount,original.amount);assert.equal(after.uniqueId,original.uniqueId);
    assert.notEqual(after.owner,original.owner);assert.equal(JSON.parse(after.requestJson).relay.paymentRequired,request.paymentRequired);
    assert.equal(after.blockHash,recovered.hash);assert.equal(afterJournal.relayHeader(after.id),recovered.paymentSignature);assert.equal(f.published.length,0);
    assert.throws(()=>afterJournal.db.prepare('UPDATE operations SET owner=? WHERE id=?').run('replacement',original.id),/immutable wallet terms/);
    assert.equal(afterJournal.find(original.id).blockJson,after.blockJson);afterJournal.close();
});

test('Unlimited retains spend history so a later finite policy counts earlier transfers', async t=>{
    // Given explicit paired-null Unlimited spending and the usual durable journal.
    const f=await fixture(t,{limit:null}),wallet=f.open(),first=transfer(f,'200');
    // When transfers above the old fixture cap confirm before the policy is tightened.
    assert.equal((await wallet.call('transfer.send',first)).state,'CONFIRMED');
    assert.equal((await wallet.call('transfer.send',transfer(f,'150'))).state,'CONFIRMED');
    await approveNanoWalletPolicy({dataDir:f.dir,grants:f.grants,limits:{maxPaymentAtomic:'250',rolling24hAtomic:'400'},terminalConfirmed:true});
    // Then prior Unlimited spending consumes the finite rolling ceiling and exact retries remain immutable.
    await assert.rejects(wallet.call('transfer.send',transfer(f,'60')),{code:'DAILY_LIMIT'});
    assert.equal((await wallet.call('transfer.send',first)).state,'CONFIRMED');
    assert.equal(f.published.length,2);
    const journal=new NanoJournal(f.dir);
    try {assert.equal(journal.db.prepare("SELECT COUNT(*) AS count FROM operations WHERE kind='transfer' AND state='CONFIRMED'").get().count,2);} finally {journal.close();}
});

test('Unlimited preserves unknown-source fencing, idempotency and exact signed bytes', async t=>{
    // Given an Unlimited wallet whose first native publication has an unknown outcome.
    const f=await fixture(t,{limit:null}),wallet=f.open(),args=transfer(f,'200');f.mode='throw';
    // When a different transfer and an exact retry are requested.
    const first=await wallet.call('transfer.send',args);
    await assert.rejects(wallet.call('transfer.send',transfer(f,'1')),{code:'SOURCE_FENCED'});
    await assert.rejects(wallet.call('transfer.send',{...args,amountAtomic:'201'}),{code:'HANDLE_REUSE'});
    const replay=await wallet.call('transfer.send',args);
    // Then the journal fences the account and reuses the original signed candidate.
    assert.equal(first.state,'UNKNOWN');assert.equal(replay.sendHash,first.sendHash);
    assert.deepEqual(f.published[0].toWire(),f.published[1].toWire());
});

test('Unlimited still revalidates zero caps and transfer permission immediately before signing', async t=>{
    for(const revoked of ['zero','grant']) {
        // Given Unlimited spending while proof-of-work generation yields to a policy change.
        const f=await fixture(t,{limit:null}),wallet=f.open(),generate=f.rpc.generateWork.bind(f.rpc);
        f.rpc.generateWork=async(...args)=>{
            const result=await generate(...args);
            await approveNanoWalletPolicy({dataDir:f.dir,grants:{...f.grants,externalTransfers:revoked!=='grant'},
                limits:revoked==='zero'?{maxPaymentAtomic:'0',rolling24hAtomic:'0'}:{maxPaymentAtomic:null,rolling24hAtomic:null},terminalConfirmed:true});
            return result;
        };
        // When the unsigned transfer resumes after tightening or revocation.
        await assert.rejects(wallet.call('transfer.send',transfer(f,'200')),{code:revoked==='zero'?'SPEND_LIMIT':'PERMISSION_DENIED'});
        // Then no block is signed/published and the unsigned reservation is cleared.
        assert.equal(f.published.length,0);
        const journal=new NanoJournal(f.dir);try{assert.equal(journal.pendingForSource(f.source),undefined);}finally{journal.close();}
    }
});
