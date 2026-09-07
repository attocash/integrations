import { fetchDirectory, DIRECTORY_URL } from '../labels/directory.js';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AttoAccount, AttoBlock, AttoInstant } from '@attocash/commons-core';
import { satisfies } from 'semver';
import { AttoError } from '../domain/errors.js';
import { NodeReader } from '../network/reader.js';
import { requestWork } from '../network/work.js';
import { MarketData } from '../pricing/market.js';
import { dedicatedMcpDirectory, inspectWalletProfile, type WalletProfile } from '../storage/profiles.js';
import { checkKeyring } from './keyring.js';
import { readDoctorProfile, type DoctorProfile } from './profile.js';
import type { DoctorCheck, DoctorOptions, DoctorReport } from './types.js';

export type { DoctorCheck, DoctorOptions, DoctorReport, DoctorStatus } from './types.js';

const skipped = (id: string, message: string): DoctorCheck => ({ id, status: 'skipped', code: 'CHECK_PREREQUISITE_UNAVAILABLE', message });

function failure(id: string, error: unknown, signal: AbortSignal, steps: string[], warn = false): DoctorCheck {
  // Never include upstream messages or bodies; even SDK failures may contain sensitive data.
  const denied = id === 'profile' && ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException | undefined)?.code ?? '');
  const code = signal.aborted ? 'CHECK_TIMEOUT' : error instanceof AttoError ? error.code : denied ? 'PROFILE_ACCESS_DENIED' : id === 'profile' ? 'PROFILE_STATE_INVALID' : 'CHECK_FAILED';
  const httpStatus = error instanceof AttoError ? (error.details as { httpStatus?: unknown } | undefined)?.httpStatus : undefined;
  return { id, status: warn ? 'warn' : 'fail', code,
    message: signal.aborted ? 'The check did not complete before its deadline or was cancelled.'
      : denied ? 'This process lacks the file or directory access needed to use the profile.'
        : code === 'STATE_VERSION' ? 'The state database version is not supported by this CLI.'
          : code === 'PROFILE_STATE_INVALID' ? 'The selected state database or its public wallet data is invalid or unreadable.'
            : 'The check failed. Follow the suggested steps and rerun doctor.',
    ...(typeof httpStatus === 'number' && Number.isInteger(httpStatus) ? { evidence: { httpStatus } } : {}), remediation: { steps } };
}

async function checkNode(profile: DoctorProfile, overall: AbortSignal): Promise<DoctorCheck[]> {
  const reader = new NodeReader(profile.settings);
  const checks: DoctorCheck[] = [];
  const signal = AbortSignal.any([overall, AbortSignal.timeout(10_000)]);
  const fix = ['Verify nodeUrl with wallet status; use wallet configure --node-url only after selecting the intended endpoint.', 'Check network connectivity, TLS trust, and whether the server exposes the Atto public APIs.'];
  let account: AttoAccount | null = null;
  const selectedAddress = profile.identity?.address ?? profile.settings.representative;
  const lookupAccount = async (address: string) => {
    const value = await reader.account(address, signal);
    if (value && value.address.value !== address) throw new AttoError('ACCOUNT_MISMATCH', 'The node returned another account.');
    return value;
  };
  // Time and account APIs are independent; a clock endpoint alone does not prove account access.
  const results = await Promise.allSettled([
    reader.now(signal),
    lookupAccount(selectedAddress),
  ]);
  const time = results[0];
  if (time.status === 'fulfilled') {
    const offsetMs = Number(time.value.toEpochMilliseconds() - BigInt(Date.now()));
    checks.push({ id: 'node.time', status: Math.abs(offsetMs) > 60_000 ? 'warn' : 'pass', code: Math.abs(offsetMs) > 60_000 ? 'CLOCK_SKEW' : 'NODE_TIME_OK',
      message: 'The node time API returned a valid response.', evidence: { offsetMs },
      ...(Math.abs(offsetMs) > 60_000 ? { remediation: { steps: ['Check OS time synchronization and the configured node clock.'] } } : {}) });
  } else checks.push(failure('node.time', time.reason, signal, fix));
  const lookup = results[1];
  if (lookup.status === 'fulfilled') {
    account = lookup.value;
    checks.push({ id: 'node.account', status: 'pass', code: account ? 'NODE_ACCOUNT_OK' : 'ACCOUNT_NOT_OPEN',
      message: account ? 'The account API returned a valid account.' : 'The account API returned not found; the queried account may not be open.' });
  } else checks.push(failure('node.account', lookup.reason, signal, fix));
  if (lookup.status === 'fulfilled' && !account && selectedAddress !== profile.settings.representative) {
    try {
      account = await lookupAccount(profile.settings.representative);
      checks.push({ id: 'node.representative', status: account ? 'pass' : 'warn', code: account ? 'NODE_REPRESENTATIVE_OK' : 'REPRESENTATIVE_NOT_OPEN',
        message: account ? 'The configured representative provides an existing account for network and stream checks.' : 'The configured representative is also unopened; network and stream verification need an existing account.' });
    } catch (error) { checks.push(failure('node.representative', error, signal, fix)); }
  }
  if (!account) return [...checks, skipped('node.network', 'No existing account was available to verify the node network.'), skipped('node.stream', 'No existing account was available for an observable account-stream snapshot.')];
  checks.push({ id: 'node.network', status: account.network.name === profile.settings.network ? 'pass' : 'fail',
    code: account.network.name === profile.settings.network ? 'NODE_NETWORK_MATCHED' : 'NETWORK_MISMATCH',
    message: 'Compared the account network with the wallet configuration.', evidence: { configured: profile.settings.network, observed: account.network.name },
    ...(account.network.name === profile.settings.network ? {} : { remediation: { steps: ['Select node and worker endpoints for the intended network. A network setting alone does not change endpoints.'] } }) });
  const streamDone = new AbortController();
  const deadline = AbortSignal.any([overall, AbortSignal.timeout(10_000)]);
  let observed = false;
  try {
    await reader.stream({ event: 'account', addresses: [account.address.value] }, model => {
      if (!(model instanceof AttoAccount) || model.address.value !== account!.address.value || model.network.name !== account!.network.name) throw new AttoError('ACCOUNT_MISMATCH', 'Unexpected account stream result.');
      observed = true;
      streamDone.abort();
    }, AbortSignal.any([deadline, streamDone.signal]));
    checks.push({ id: 'node.stream', status: observed ? 'pass' : 'warn', code: observed ? 'NODE_STREAM_OK' : 'NODE_STREAM_UNVERIFIED',
      message: observed ? 'Commons received an account snapshot and closed the subscription.' : 'No account snapshot was observed during the check. An idle stream alone does not prove a failure.' });
  } catch (error) { checks.push(failure('node.stream', error, deadline, fix)); }
  finally { streamDone.abort(); }
  return checks;
}

async function checkWorker(profile: DoctorProfile, overall: AbortSignal): Promise<DoctorCheck> {
  const signal = AbortSignal.any([overall, AbortSignal.timeout(30_000)]);
  try {
    // A fresh public target ensures a real request; this block has no signer or funds.
    const block = AttoBlock.fromJson(JSON.stringify({ type: 'CHANGE', network: profile.settings.network, version: 0, algorithm: 'V1',
      publicKey: '11'.repeat(32), height: 2, balance: 0, timestamp: Number(AttoInstant.Companion.now().toEpochMilliseconds()),
      previous: randomBytes(32).toString('hex'), representativeAlgorithm: 'V1', representativePublicKey: '11'.repeat(32) }));
    await requestWork(block, profile.settings.workerUrl, signal);
    return { id: 'worker.work', status: 'pass', code: 'WORKER_WORK_VALID', message: 'The worker generated fresh proof of work validated by Commons. Nothing was signed, published, or cached.' };
  } catch (error) { return failure('worker.work', error, signal, ['Verify workerUrl and its network with wallet status.', 'Check worker connectivity and capacity. Run wallet configure --worker-url only after selecting the intended endpoint.']); }
}

async function checkPrice(profile: DoctorProfile, overall: AbortSignal): Promise<DoctorCheck> {
  if (profile.settings.network !== 'LIVE') return skipped('usd.price', 'USD-priced payments are available on LIVE only.');
  const signal = AbortSignal.any([overall, AbortSignal.timeout(10_000)]);
  try {
    const quote = await new MarketData().quoteUsd('1', signal);
    return { id: 'usd.price', status: 'pass', code: 'USD_PRICE_AVAILABLE', message: 'An indicative USD conversion is available; it is not an executable exchange quote.', evidence: { source: quote.source, priceDate: quote.priceDate } };
  } catch (error) { return failure('usd.price', error, signal, ['Check the market metrics service and price observation date. Ordinary ATTO payments do not require USD pricing.'], true); }
}

async function checkDirectory(profile: DoctorProfile, signal: AbortSignal): Promise<DoctorCheck> {
  if (profile.settings.network !== 'LIVE') return skipped('labels.directory', 'The public directory applies to LIVE only.');
  try {
    const snapshot = await fetchDirectory(fetch, signal);
    return { id: 'labels.directory', status: 'pass', code: 'DIRECTORY_AVAILABLE', message: 'The global address directory is available. No cache was updated.',
      evidence: { source: DIRECTORY_URL, addresses: snapshot.addresses.length, voters: snapshot.voters.length } };
  } catch (error) { return failure('labels.directory', error, signal, ['Check public directory connectivity. Personal-label payments use local storage and do not need this service.'], true); }
}

function readiness(profile: DoctorProfile, options: DoctorOptions, directory: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [{ id: 'wallet.initialization', status: profile.identity ? 'pass' : 'warn',
    code: profile.identity ? 'WALLET_INITIALIZED' : 'WALLET_NOT_INITIALIZED', message: profile.identity ? 'A public wallet identity is saved.' : 'This profile has no initialized wallet.',
    ...(!profile.identity ? { remediation: { steps: ['Create or import a wallet in your local terminal using this data directory.'], command: ['atto', '--data-dir', directory, 'wallet', 'create'] } } : {}) }];
  if (profile.resetPending) checks.push({ id: 'wallet.reset', status: 'fail', code: 'WALLET_RESET_REQUIRED', message: 'A previously requested wallet reset is unfinished.', remediation: { steps: ['Review wallet status and your backups in a local terminal before explicitly resuming the reset. Doctor does not resume it.'] } });
  checks.push({ id: 'wallet.receiving', status: 'pass', code: 'RECEIVING_CONFIGURATION', message: 'Receiving prerequisites are configuration, not a receiver started by doctor.',
    evidence: { enabled: profile.settings.autoReceive, activeAccounts: profile.addresses.filter(address => address.active).length,
      ...(options.access === 'mcp' ? { approvedMcpAccess: profile.access, poolIndexes: profile.poolIndexes } : {}) } });
  if (profile.identity && profile.settings.autoReceive && !profile.addresses.some(address => address.active)) checks.push({ id: 'wallet.activeAccounts', status: 'warn', code: 'NO_ACTIVE_ACCOUNTS', message: 'Receiving is enabled without any active accounts.', remediation: { steps: ['Activate a saved account to receive automatically.'], command: ['atto', '--data-dir', directory, 'address', 'activate', '0'] } });
  if (options.access === 'mcp') checks.push({ id: 'wallet.mcpAccess', status: 'pass', code: profile.access === 'spend' ? 'MCP_SPENDING_APPROVED' : 'MCP_READ_ONLY',
    message: profile.access === 'spend' ? 'MCP spending access is approved, subject to the saved policy.' : 'Read-only MCP access is intentional. Spending needs a proposal and approval by the user in a local terminal; doctor cannot grant it.' });
  checks.push({ id: 'wallet.pendingPayments', status: profile.pendingPayments ? 'warn' : 'pass', code: profile.pendingPayments ? 'PAYMENTS_UNFINISHED' : 'NO_PENDING_PAYMENTS',
    message: profile.pendingPayments ? 'Unfinished payment records need inspection; doctor has not reconciled or retried them.' : 'No unfinished payment records are saved.', evidence: { count: profile.pendingPayments },
    ...(profile.pendingPayments ? { remediation: { steps: ['Inspect the journal and retain original request IDs when checking existing payments.'], command: ['atto', '--data-dir', directory, 'journal', 'list'] } } : {}) });
  if (profile.settings.network === 'LIVE') checks.push({ id: 'usd.terms', status: profile.termsAccepted ? 'pass' : 'warn', code: profile.termsAccepted ? 'USD_TERMS_ACCEPTED' : 'USD_TERMS_REQUIRED',
    message: profile.termsAccepted ? 'The current USD payment terms are accepted.' : 'USD payments require the user to read and explicitly accept the current terms. Ordinary ATTO payments do not.',
    ...(!profile.termsAccepted ? { remediation: { steps: ['Show the terms to the user before requesting their acceptance.'], command: ['atto', '--data-dir', directory, 'terms', 'show'] } } : {}) });
  return checks;
}

/** Full diagnostics, independent of application startup and without wallet mutations. */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const started = Date.now();
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string; engines: { node: string } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const report: DoctorReport = { status: 'pass', context: { interface: options.access ?? 'cli', executable: process.execPath,
    nodeVersion: process.version, cliVersion: pkg.version, platform: `${process.platform}/${process.arch}` }, checks: [], durationMs: 0 };
  try {
    const supported = satisfies(process.version, pkg.engines.node);
    report.checks.push({ id: 'runtime', status: supported ? 'pass' : 'fail', code: supported ? 'RUNTIME_SUPPORTED' : 'RUNTIME_UNSUPPORTED', message: `This package requires Node.js ${pkg.engines.node}.` });
    let profile: WalletProfile;
    let snapshot: DoctorProfile;
    try {
      const directory = options.directory ?? (options.access === 'mcp' ? dedicatedMcpDirectory() : undefined);
      if (directory) report.context.directory = resolve(directory);
      profile = inspectWalletProfile(directory);
      Object.assign(report.context, profile);
      snapshot = readDoctorProfile(profile.directory);
      Object.assign(report.context, { network: snapshot.settings.network, nodeUrl: snapshot.settings.nodeUrl, workerUrl: snapshot.settings.workerUrl, settingsSource: snapshot.settingsSource });
      report.checks.push({ id: 'profile', status: 'pass', code: 'PROFILE_READABLE', message: snapshot.settingsSource === 'defaults' ? 'No state database exists. Checks use labelled defaults without creating a profile.' : 'The public wallet snapshot is readable and its directory is accessible.' });
      if (snapshot.permissions) report.checks.push({ id: 'profile.permissions', status: snapshot.permissions.private ? 'pass' : 'warn',
        code: snapshot.permissions.private ? 'PROFILE_PERMISSIONS_PRIVATE' : 'PROFILE_PERMISSIONS_BROAD',
        message: snapshot.permissions.private ? 'The profile directory and database restrict access to their owner.' : 'The profile directory or database allows access by other OS users.',
        evidence: snapshot.permissions,
        ...(!snapshot.permissions.private ? { remediation: { steps: ['Review ownership and permissions for this data directory and state.sqlite. Restrict the directory to mode 700 and the database to mode 600. Doctor has not changed them.'] } } : {}) });
    } catch (error) {
      report.checks.push(failure('profile', error, signal, ['Verify the data directory, file permissions, and supported wallet state version.', 'Preserve the existing profile and restore valid metadata or state from its backup; do not reset the wallet to fix access.']));
      for (const id of ['keyring.credential', 'node.time', 'node.account', 'node.network', 'node.stream', 'worker.work', 'wallet.readiness', 'usd.price']) report.checks.push(skipped(id, 'The selected profile could not be inspected safely. No alternate profile or endpoints were substituted.'));
      return report;
    }
    report.checks.push(...readiness(snapshot, options, profile.directory));
    const jobs = await Promise.allSettled([checkKeyring(profile, snapshot.identity, signal), checkNode(snapshot, signal), checkWorker(snapshot, signal), checkPrice(snapshot, signal), ...(options.globalDirectory ? [checkDirectory(snapshot, signal)] : [])]);
    for (const [index, job] of jobs.entries()) {
      if (job.status === 'fulfilled') report.checks.push(...(Array.isArray(job.value) ? job.value : [job.value]));
      else report.checks.push(failure(['keyring.credential', 'node', 'worker.work', 'usd.price', 'labels.directory'][index]!, job.reason, signal, ['Rerun doctor from the same launch environment.']));
    }
    return report;
  } finally {
    clearTimeout(timer);
    controller.abort();
    report.status = report.checks.some(check => check.status === 'fail') ? 'fail' : report.checks.some(check => check.status === 'warn') ? 'warn' : 'pass';
    report.durationMs = Date.now() - started;
  }
}
