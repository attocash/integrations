import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, parse } from 'node:path';
import { initializeMarketplaceRecoveryWallet } from '@attocash/cli/internal-marketplace';
import {
  approveNanoWalletPolicy,
  inspectNanoSeed,
  inspectNanoRecoveryWallet,
  inspectNanoWallet,
  MAX_RAW,
  provisionNanoWallet,
  type NanoNetwork,
  type NanoWalletConfiguration,
} from '@attocash/atto-marketplace-nano-adapter';
import { ProfileError } from './profile-store.js';
import { readWalletSelection, saveWalletSelection } from './wallet-preferences.js';

export interface NanoInteractiveSetupOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  origin?: string;
  audience?: string;
  prompt: (question: string) => Promise<string>;
}

export interface NanoInteractiveSetupResult {
  directory: string;
  address: string;
  index: number;
  network: NanoNetwork;
}

type Policy = Pick<NanoWalletConfiguration, 'grants' | 'limits'>;
type SetupMode = 'create' | 'reuse' | 'import';

export function defaultNanoRpcUrl(network: NanoNetwork): string {
  return network === 'nano:mainnet' ? 'https://rpc.nano.to' : 'http://localhost:17076';
}

/** Terminal-only setup; every prompt and public review precedes wallet mutation. */
export async function setupNanoWalletInteractive(options: NanoInteractiveSetupOptions): Promise<NanoInteractiveSetupResult> {
  requireTerminal();
  const home = privatePath(options.home);
  const defaultDirectory = privatePath(options.env.MARKETPLACE_MCP_NANO_WALLET_DATA_DIR ?? join(home, 'wallets', 'nano'));
  const mode = await choice(options, 'Nano wallet: derive from your recovery phrase, reuse an adapter profile, or import a private seed file (create/reuse/import)', ['create', 'reuse', 'import'], hasProfile(defaultDirectory) ? 'reuse' : 'create');
  const directory = privatePath(await answer(options, 'Private Nano wallet directory', defaultDirectory));
  if (mode === 'reuse') return reuseWallet(options, directory);

  requireEmptyTarget(directory);
  const network = await choice(options, 'Nano network (nano:mainnet/nano:dev)', ['nano:mainnet', 'nano:dev'], 'nano:mainnet');
  const rpcUrl = validateNanoRpcUrl(await answer(options, 'Nano RPC URL', defaultNanoRpcUrl(network)));
  const selectedWorkUrl = await answer(options, 'Nano work URL (optional; Enter uses the Nano RPC)', '');
  const workUrl = selectedWorkUrl ? validateNanoRpcUrl(selectedWorkUrl) : undefined;
  const origin = marketplaceOrigin(options.origin ?? await answer(options, 'Marketplace origin (for example https://marketplace.example)'));
  const audience = audienceText(options.audience ?? await answer(options, 'Exact Marketplace Agent API audience'));
  const index = derivationIndex(await answer(options, 'Nano derivation index', mode === 'create' ? '0' : '1'));
  const handoffDirectory = privatePath(options.env.MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR ?? join(home, 'payment-handoffs'));
  let seedFile: string | undefined;
  let importedAddress: string | undefined;
  if (mode === 'import') {
    seedFile = privatePath(await answer(options, 'Existing private 32-byte seed file (64 hexadecimal characters; never paste the seed)'));
    refuseManagedSeed(seedFile);
    importedAddress = (await inspectNanoSeed(seedFile, index)).address;
  }
  const recoveryWalletDirectory = mode === 'create'
    ? privatePath(await answer(options, 'Recovery wallet directory (existing Atto CLI or dedicated Marketplace wallet)',
      options.env.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR ?? join(home, 'wallets', 'atto'))) : undefined;
  if (recoveryWalletDirectory && index > 0x7fffffff) throw failure('SETUP_USAGE', 'Shared recovery uses hardened indexes from 0 through 2147483647.');
  const previousAttoDirectory = readWalletSelection(home)?.attoDirectory ?? options.env.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR;
  const selectedAttoDirectory = previousAttoDirectory && existsSync(join(previousAttoDirectory,'state.sqlite')) ? previousAttoDirectory : undefined;
  const recovery = recoveryWalletDirectory ? await inspectExistingRecoveryWallet(recoveryWalletDirectory, index) : undefined;
  const policy = await policyQuestions(options);
  if (await yesNo(options, 'Allow headless Marketplace login proofs (terminal approvals are separate)', false)) policy.grants.controllerPurposes.push('login');
  const seedDescription = seedFile
    ? `Existing private seed file: ${seedFile}`
    : `Recovery phrase: OS password store for ${recoveryWalletDirectory}; Nano derivation m/44'/165'/${index}'. No separate seed file.`;
  await approve(options, review({ mode, directory, address: importedAddress ?? recovery?.address, network, rpcUrl, workUrl, origin, audience,
    index, handoffDirectory, policy, seedDescription }));

  // Recheck after consent: imported seed disappearance must never create a new identity.
  requireEmptyTarget(directory);
  if (seedFile) {
    refuseManagedSeed(seedFile);
    if ((await inspectNanoSeed(seedFile, index)).address !== importedAddress) throw failure('WALLET_KEY_MISMATCH', 'The selected private Nano seed changed during review.');
  }
  let expectedAddress = importedAddress;
  if (recoveryWalletDirectory) {
    if (!recovery) await initializeMarketplaceRecoveryWallet(recoveryWalletDirectory);
    const current = await inspectNanoRecoveryWallet(recoveryWalletDirectory, index);
    if (recovery && JSON.stringify(current) !== JSON.stringify(recovery)) throw failure('WALLET_KEY_MISMATCH', 'The recovery wallet changed during review.');
    expectedAddress = current.address;
  }
  const result = await provisionNanoWallet({ dataDir: directory, derivationIndex: index, network, rpcUrl, ...(workUrl ? { workUrl } : {}), origin, audience,
    handoffDirectory, ...(seedFile ? { seedFile, expectedAddress: importedAddress! } : {}),
    ...(recoveryWalletDirectory ? { recoveryWalletDirectory, expectedAddress: expectedAddress! } : {}), ...policy, terminalConfirmed: true });
  if (recoveryWalletDirectory) await saveWalletSelection(home, { attoDirectory: selectedAttoDirectory ?? recoveryWalletDirectory });
  return { directory, address: result.address, index: result.index, network: result.network };
}

async function inspectExistingRecoveryWallet(directory: string, index: number) {
  try { lstatSync(join(directory, 'state.sqlite')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return inspectNanoRecoveryWallet(directory, index);
}

async function reuseWallet(options: NanoInteractiveSetupOptions, directory: string): Promise<NanoInteractiveSetupResult> {
  const config = await inspectNanoWallet(directory);
  if ((options.origin !== undefined && marketplaceOrigin(options.origin) !== config.origin)
    || (options.audience !== undefined && audienceText(options.audience) !== config.audience)) {
    throw failure('WALLET_CONFIGURATION', 'This Nano profile is pinned to a different Marketplace origin or audience. Reuse its exact existing connection settings.');
  }
  const replace = await choice(options, 'Existing Nano policy: keep approved grants and limits, or replace transfer policy (keep/replace)', ['keep', 'replace'], 'keep');
  const originalPolicy = { grants: { ...config.grants, controllerPurposes: [...config.grants.controllerPurposes] }, limits: { ...config.limits } };
  const policy = replace === 'replace' ? await policyQuestions(options, originalPolicy)
    : { grants: { ...originalPolicy.grants, controllerPurposes: [...originalPolicy.grants.controllerPurposes] }, limits: { ...originalPolicy.limits } };
  if (!policy.grants.controllerPurposes.includes('login')
    && await yesNo(options, 'Add permission to sign Marketplace login proofs only (other purpose grants stay unchanged)', false)) {
    policy.grants.controllerPurposes.push('login');
  }
  await approve(options, review({ mode: 'reuse', directory, address: config.sourceAddress, network: config.network,
    rpcUrl: config.rpcUrl, workUrl: config.workUrl, origin: config.origin, audience: config.audience, index: config.derivationIndex,
    handoffDirectory: config.handoffDirectory, policy, seedDescription: config.keySource.type === 'shared-recovery' ? `Recovery phrase: OS password store for ${config.keySource.recoverySource.directory}; ${config.keySource.derivationVersion}` : `Existing private seed file: ${config.keySource.seedFile}` }));

  const current = await inspectNanoWallet(directory);
  if (JSON.stringify(current) !== JSON.stringify(config)) throw failure('WALLET_CONFIGURATION_CHANGED', 'The Nano profile changed during review. Repeat setup against its current settings.');
  if (JSON.stringify(policy) !== JSON.stringify(originalPolicy)) {
    await approveNanoWalletPolicy({ dataDir: directory, ...policy, terminalConfirmed: true });
  }
  return { directory, address: config.sourceAddress, index: config.derivationIndex, network: config.network };
}

async function policyQuestions(options: NanoInteractiveSetupOptions, current?: Policy): Promise<Policy> {
  const marketplaceFunding = await yesNo(options, 'Allow Marketplace funding from this wallet', current?.grants.marketplaceFunding ?? false);
  const externalTransfers = await yesNo(options, 'Allow external Nano transfers from this wallet', current?.grants.externalTransfers ?? false);
  let maxPaymentAtomic = current?.limits.maxPaymentAtomic ?? '0';
  let rolling24hAtomic = current?.limits.rolling24hAtomic ?? '0';
  if (marketplaceFunding || externalTransfers) {
    maxPaymentAtomic = xnoToRaw(await answer(options, 'Maximum XNO per payment (up to 30 decimal places)', maxPaymentAtomic === '0' ? '1' : rawToXno(maxPaymentAtomic)));
    rolling24hAtomic = xnoToRaw(await answer(options, 'Maximum XNO over rolling 24 hours (shared by funding and external transfers)', rolling24hAtomic === '0' ? '10' : rawToXno(rolling24hAtomic)));
    if (BigInt(maxPaymentAtomic) > BigInt(rolling24hAtomic)) throw failure('INVALID_AMOUNT', 'The per-payment ceiling must not exceed the rolling 24-hour ceiling.');
  }
  return { grants: { marketplaceFunding, externalTransfers, controllerPurposes: [...(current?.grants.controllerPurposes ?? [])] },
    limits: { maxPaymentAtomic, rolling24hAtomic } };
}

function review(input: {
  mode: SetupMode; directory: string; address: string | undefined; network: NanoNetwork; rpcUrl: string; workUrl: string | undefined;
  origin: string; audience: string; index: number; handoffDirectory: string; policy: Policy; seedDescription: string;
}): string {
  return [
    'Review Nano wallet setup:',
    `Action: ${input.mode === 'reuse' ? 'Reuse existing keys and journal' : input.mode === 'import' ? 'Import existing private seed into a new profile' : 'Derive Nano wallet from shared recovery phrase'}`,
    `Wallet directory: ${input.directory}`,
    `Address: ${input.address ?? 'New public address will be derived after approval'}`,
    `Derivation index: ${input.index}`,
    `Network: ${input.network}`,
    `RPC: ${input.rpcUrl}`,
    `Work: ${input.workUrl ?? input.rpcUrl}`,
    `Marketplace origin: ${input.origin}`,
    `Audience: ${input.audience}`,
    `Payment handoff directory: ${input.handoffDirectory}`,
    `Marketplace funding: ${input.policy.grants.marketplaceFunding ? 'allowed' : 'denied'}`,
    `External transfers: ${input.policy.grants.externalTransfers ? 'allowed' : 'denied'}`,
    `Controller purposes: ${input.policy.grants.controllerPurposes.join(', ') || 'none'}`,
    `Maximum per payment: ${rawToXno(input.policy.limits.maxPaymentAtomic)} XNO (${input.policy.limits.maxPaymentAtomic} raw)`,
    `Rolling 24-hour maximum: ${rawToXno(input.policy.limits.rolling24hAtomic)} XNO (${input.policy.limits.rolling24hAtomic} raw)`,
    input.seedDescription,
    'Keep your recovery phrase, wallet configuration and journals backed up securely.',
    'Type APPROVE to confirm: ',
  ].join('\n');
}

async function approve(options: NanoInteractiveSetupOptions, preview: string): Promise<void> {
  if ((await options.prompt(preview)).trim() !== 'APPROVE') throw failure('APPROVAL_DECLINED', 'Nano wallet setup was declined.');
  requireTerminal();
}

async function answer(options: NanoInteractiveSetupOptions, question: string, fallback?: string): Promise<string> {
  const value = (await options.prompt(`${question}${fallback ? ` [${fallback}]` : ''}: `)).trim();
  if (/\x00|\r|\n/.test(value) || value.length > 4096) throw failure('SETUP_USAGE', 'Use one bounded line for each setup answer.');
  if (!value && fallback === undefined) throw failure('SETUP_USAGE', 'A required Nano setup answer was empty.');
  return value || fallback!;
}

async function choice<T extends string>(options: NanoInteractiveSetupOptions, question: string, choices: readonly T[], fallback: T): Promise<T> {
  const value = await answer(options, question, fallback);
  if (!choices.includes(value as T)) throw failure('SETUP_USAGE', `Choose ${choices.join(', ')}.`);
  return value as T;
}

async function yesNo(options: NanoInteractiveSetupOptions, question: string, fallback: boolean): Promise<boolean> {
  const value = (await answer(options, `${question} (yes/no)`, fallback ? 'yes' : 'no')).toLowerCase();
  if (value === 'yes' || value === 'y') return true;
  if (value === 'no' || value === 'n') return false;
  throw failure('SETUP_USAGE', 'Answer yes or no.');
}

function xnoToRaw(value: string): string {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,30}))?$/.exec(value);
  if (!match || value.length > 70) throw failure('INVALID_AMOUNT', 'Use a nonnegative plain XNO amount with up to 30 decimal places.');
  const raw = BigInt(match[1]!) * 10n ** 30n + BigInt((match[2] ?? '').padEnd(30, '0'));
  if (raw > MAX_RAW) throw failure('INVALID_AMOUNT', 'The Nano amount exceeds its native maximum.');
  return raw.toString();
}

function rawToXno(value: string): string {
  const raw = BigInt(value), unit = 10n ** 30n;
  const fraction = (raw % unit).toString().padStart(30, '0').replace(/0+$/, '');
  return `${raw / unit}${fraction ? `.${fraction}` : ''}`;
}

function derivationIndex(value: string): number {
  if (!/^(0|[1-9][0-9]{0,9})$/.test(value) || Number(value) > 0xffffffff) throw failure('SETUP_USAGE', 'Use a Nano derivation index from 0 through 4294967295.');
  return Number(value);
}

function marketplaceOrigin(value: string): string {
  const url = webUrl(value, true);
  if (url.origin !== value) throw failure('SETUP_USAGE', 'Use the exact Marketplace origin without a path, query, or trailing slash.');
  return value;
}

export function validateNanoRpcUrl(value: string): string {
  webUrl(value, false);
  return value;
}

function webUrl(value: string, origin: boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw failure('SETUP_USAGE', 'Use an absolute HTTPS URL, or loopback HTTP for development.'); }
  if (value.length > 2048 || /[\x00-\x20\x7f]/.test(value) || url.username || url.password || url.hash
    || !['http:', 'https:'].includes(url.protocol)
    || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    || (origin && (url.pathname !== '/' || url.search))) {
    throw failure('SETUP_USAGE', 'Use an absolute HTTPS URL, or loopback HTTP for development, without embedded credentials.');
  }
  return url;
}

function audienceText(value: string): string {
  if (!value || value.length > 255 || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) throw failure('SETUP_USAGE', 'Use the exact Marketplace audience as one nonempty line of at most 255 characters.');
  return value;
}

function privatePath(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw failure('PRIVATE_FILE', 'Use an explicit absolute local path without symbolic links.');
  return value;
}

function hasProfile(directory: string): boolean {
  try { lstatSync(join(directory, 'wallet.json')); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function requireEmptyTarget(directory: string): void {
  try {
    const st = lstatSync(directory);
    if (!st.isDirectory() || st.isSymbolicLink() || readdirSync(directory).length) throw failure('WALLET_CONFIGURATION_EXISTS', 'The target Nano directory already contains state. Reuse its existing private adapter profile.');
    if ((st.mode & 0o777) !== 0o700 || (process.getuid && st.uid !== process.getuid())) throw failure('PRIVATE_FILE', 'Use a private owner-only Nano wallet directory.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function refuseManagedSeed(seedFile: string): void {
  let directory = dirname(seedFile);
  while (directory !== parse(directory).root) {
    try {
      lstatSync(join(directory, 'wallet.json'));
      throw failure('WALLET_CONFIGURATION_EXISTS', `This seed is beside an existing adapter profile. Choose reuse with ${directory} so its keys and journal remain together.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    directory = dirname(directory);
  }
}

function requireTerminal(): void {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw failure('TERMINAL_REQUIRED', 'Nano wallet setup requires an interactive local terminal.');
}

function failure(code: string, message: string): ProfileError { return new ProfileError(code, message); }
