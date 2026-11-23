import { terminalText } from './terminal-output.js';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, parse } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertPrivatePermissions, initializeMarketplaceRecoveryWallet } from '@attocash/cli/internal-marketplace';
import {
  approveNanoWalletPolicy,
  inspectNanoSeed,
  inspectNanoRecoveryWallet,
  loadConfiguration,
  validateConfiguration,
  MAX_RAW,
  provisionNanoWallet,
  type NanoNetwork,
  type NanoWalletConfiguration,
} from '@attocash/atto-marketplace-nano-adapter';
import {menuChoice} from './terminal-input.js';
import type { DeferredWalletPlan, WalletAccessMode } from './wallet-plan.js';
import { ProfileError } from './profile-store.js';
import { defaultNanoRpcUrl, nanoWorkDescription } from './nano-work.js';
import { marketplaceConnection } from './defaults.js';
import { readWalletSelection, saveWalletSelection } from './wallet-preferences.js';

export interface NanoInteractiveSetupOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  origin?: string;
  audience?: string;
  advanced?: boolean;
  json?: boolean;
  resumeIntent?: Record<string, unknown>;
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

/** Standalone setup owns its one exact approval; guided setup combines the public plan with login. */
export async function setupNanoWalletInteractive(options: NanoInteractiveSetupOptions): Promise<NanoInteractiveSetupResult> {
  const plan = await prepareNanoWalletInteractive(options);
  const wasExisting = hasProfile(plan.wallet.directory);
  await approve(options, `${plan.review}\nType APPROVE to confirm: `);
  await plan.validate();
  const result = await plan.commit() as NanoInteractiveSetupResult;
  const config = loadConfiguration(result.directory);
  if (!wasExisting && config.keySource.type === 'shared-recovery') {
    const previous = readWalletSelection(options.home)?.attoDirectory ?? options.env.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR ?? join(options.home, 'wallets', 'atto');
    await saveWalletSelection(options.home, { attoDirectory: previous && existsSync(join(previous, 'state.sqlite')) ? previous : config.keySource.recoverySource.directory });
  }
  return result;
}

/** Preparation may initialize protected recovery, but never enables payment or headless signing. */
export async function prepareNanoWalletInteractive(options: NanoInteractiveSetupOptions): Promise<DeferredWalletPlan> {
  requireTerminal();
  if (options.origin !== undefined || options.audience !== undefined) marketplaceConnection(options);
  const home = privatePath(options.home);
  if (options.resumeIntent) return resumePlan(options, options.resumeIntent);
  const defaultDirectory = privatePath(options.env.MARKETPLACE_MCP_NANO_WALLET_DATA_DIR ?? join(home, 'wallets', 'nano'));
  const selectedExists = hasProfile(defaultDirectory);
  const selectedRecovery = options.env.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR ?? readWalletSelection(home)?.attoDirectory ?? join(home, 'wallets', 'atto');
  const prepared = options.advanced ? [] : managedNanoChoices(home, defaultDirectory, selectedRecovery);
  if (!options.advanced && !selectedExists) requireEmptyTarget(defaultDirectory);
  let mode: SetupMode;
  let newRecovery = false;
  let alternateWallet = false;
  let continued: ManagedNanoChoice | undefined;
  let recoveryMethod: 'create' | 'import' | undefined;
  if (options.advanced) {
    mode = await choice(options, 'Nano wallet: derive from your recovery phrase, reuse an existing wallet, or import a private seed file (create/reuse/import)', ['create', 'reuse', 'import'], selectedExists ? 'reuse' : 'create');
  } else if (selectedExists) {
    const selection = await sourceChoice(options, ['Continue selected wallet (default)', 'Create recovery phrase', 'Import recovery phrase'], prepared);
    continued = prepared[Number(selection) - 4];
    mode = selection === '1' || continued?.kind === 'wallet' ? 'reuse' : 'create';
    if (mode === 'create' && !continued) {
      recoveryMethod = selection === '2' ? 'create' : 'import';
      newRecovery = true;
      alternateWallet = true;
    }
  } else {
    const hasRecovery = existsSync(join(selectedRecovery, 'state.sqlite'));
    const selection = await sourceChoice(options, [hasRecovery ? 'Use selected recovery phrase (default)' : 'Create recovery phrase (default)', 'Import a recovery phrase'], prepared);
    continued = prepared[Number(selection) - 3];
    mode = continued?.kind === 'wallet' ? 'reuse' : 'create';
    if (!continued) recoveryMethod = selection === '2' ? 'import' : hasRecovery ? undefined : 'create';
  }
  const directory = options.advanced ? privatePath(await answer(options, 'Private Nano wallet directory', defaultDirectory))
    : continued?.kind === 'wallet' ? continued.directory
    : alternateWallet || selectedExists && continued?.kind === 'recovery' ? unusedManagedDirectory(home, 'nano-new') : defaultDirectory;
  if (mode === 'reuse') {
    const config = loadConfiguration(directory);
    assertConnection(options, config);
    const originalPolicy = policyOf(config);
    const replace = options.advanced ? await choice(options, 'Existing Nano policy: keep approved grants and limits, or replace transfer policy (keep/replace)', ['keep', 'replace'], 'keep') : 'keep';
    const policy = options.advanced ? replace === 'replace' ? await policyQuestions(options, originalPolicy) : policyOf(config) : await basicPolicy(options, originalPolicy);
    if (options.advanced && !policy.grants.controllerPurposes.includes('login')
      && await yesNo(options, 'Add permission to sign Marketplace login proofs only (other purpose grants stay unchanged)', false)) policy.grants.controllerPurposes.push('login');
    return existingPlan(options, directory, config, policy);
  }

  requireEmptyTarget(directory);
  const network = options.advanced ? await choice(options, 'Nano network (nano:mainnet/nano:dev)', ['nano:mainnet', 'nano:dev'], 'nano:mainnet') : 'nano:mainnet';
  const rpcUrl = options.advanced ? validateNanoRpcUrl(await answer(options, 'Nano RPC URL', defaultNanoRpcUrl(network))) : defaultNanoRpcUrl(network);
  const selectedWorkUrl = options.advanced ? await answer(options, 'Nano work URL (optional; Enter uses the default work provider)', '') : '';
  const workUrl = selectedWorkUrl ? validateNanoRpcUrl(selectedWorkUrl) : undefined;
  const { origin, audience } = marketplaceConnection(options);
  const index = options.advanced ? derivationIndex(await answer(options, 'Nano derivation index', mode === 'create' ? '0' : '1')) : 0;
  let seedFile: string | undefined;
  let address: string;
  let recoveryWalletDirectory: string | undefined;
  let recovery: Awaited<ReturnType<typeof inspectNanoRecoveryWallet>> | undefined;
  if (mode === 'import') {
    seedFile = privatePath(await answer(options, 'Existing private 32-byte seed file (64 hexadecimal characters; never paste the seed)'));
    refuseManagedSeed(seedFile);
    address = (await inspectNanoSeed(seedFile, index)).address;
  } else {
    recoveryWalletDirectory = options.advanced
      ? privatePath(await answer(options, 'Recovery wallet directory (existing Atto CLI or dedicated Marketplace wallet)', selectedRecovery))
      : continued?.kind === 'recovery' ? continued.directory
      : privatePath(newRecovery || recoveryMethod === 'import' && existsSync(join(selectedRecovery, 'state.sqlite')) ? unusedManagedDirectory(home, 'nano-recovery') : selectedRecovery);
    if (!continued && (newRecovery || recoveryMethod === 'import' && recoveryWalletDirectory !== selectedRecovery)) requireEmptyTarget(recoveryWalletDirectory);
    if (index > 0x7fffffff) throw failure('SETUP_USAGE', 'Shared recovery uses hardened indexes from 0 through 2147483647.');
    if (!existsSync(join(recoveryWalletDirectory, 'state.sqlite'))) {
      await initializeMarketplaceRecoveryWallet(recoveryWalletDirectory, recoveryMethod ? { method: recoveryMethod } : undefined);
    }
    recovery = await inspectNanoRecoveryWallet(recoveryWalletDirectory, index);
    address = recovery.address;
  }
  const policy = options.advanced ? await policyQuestions(options) : await basicPolicy(options);
  if (options.advanced && await yesNo(options, 'Allow headless Marketplace login proofs (terminal approvals are separate)', false)) policy.grants.controllerPurposes.push('login');
  const config = validateConfiguration({ version: 1, keySource: seedFile
    ? { type: 'native-seed', seedFile, derivationVersion: 'nano-seed-blake2b-v1' }
    : { type: 'shared-recovery', recoverySource: recovery!.recoverySource, derivationVersion: 'bip39-ed25519-slip10-nano-v1' },
    derivationIndex: index, sourceAddress: address, network, rpcUrl, ...(workUrl ? { workUrl } : {}), origin, audience, ...policy });
  return newPlan(options, directory, config, mode);
}

type ManagedNanoChoice = {kind:'wallet'|'recovery';directory:string};

function managedNanoChoices(home: string, selectedWallet: string, selectedRecovery: string): ManagedNanoChoice[] {
  const root = join(home, 'wallets');
  if (!existsSync(root)) return [];
  const state = lstatSync(root);
  if (!state.isDirectory() || state.isSymbolicLink()) throw failure('PRIVATE_FILE', 'Use a private owner-only wallet directory.');
  assertPrivatePermissions(root, 'directory');
  const choices: ManagedNanoChoice[] = [];
  for (const entry of readdirSync(root, {withFileTypes:true}).sort((left,right)=>left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    if (/^nano(?:-new(?:-[1-9][0-9]*)?)?$/.test(entry.name) && directory !== selectedWallet && hasProfile(directory)) {
      choices.push({kind:'wallet',directory});
    } else if (/^nano-recovery(?:-[1-9][0-9]*)?$/.test(entry.name) && directory !== selectedRecovery && existsSync(join(directory, 'state.sqlite'))) {
      // An account claim belongs to its original wallet and journal. Only
      // recovery created before Nano provisioning can resume as a new target.
      const claims = join(directory, 'marketplace-nano-wallets');
      if (!existsSync(claims) || readdirSync(claims).length === 0) choices.push({kind:'recovery',directory});
    }
  }
  return choices;
}

async function sourceChoice(options: NanoInteractiveSetupOptions, primary: string[], prepared: ManagedNanoChoice[]): Promise<string> {
  const labels = [...primary, ...prepared.map(item => `${item.kind === 'wallet' ? 'Continue existing managed wallet' : 'Continue prepared recovery'} at ${terminalText(item.directory)}`)];
  const choices = labels.map((_,index)=>String(index+1));
  return menuChoice(options.prompt, `Nano wallet: ${labels.map((label,index)=>`[${index+1}] ${label}`).join(', ')}: `, choices, '1');
}

function unusedManagedDirectory(home: string, name: 'nano-new'|'nano-recovery'): string {
  for (let number=1;;number++) {
    const directory = join(home, 'wallets', `${name}${number===1?'':`-${number}`}`);
    try { lstatSync(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return directory;
      throw error;
    }
  }
}

function policyOf(config: NanoWalletConfiguration): Policy {
  return { grants: { ...config.grants, controllerPurposes: [...config.grants.controllerPurposes] }, limits: { ...config.limits } };
}
function assertConnection(options: NanoInteractiveSetupOptions, config: NanoWalletConfiguration): void {
  if ((options.origin !== undefined && marketplaceOrigin(options.origin) !== config.origin)
    || (options.audience !== undefined && audienceText(options.audience) !== config.audience)) {
    throw failure('WALLET_CONFIGURATION', 'This Nano wallet is pinned to a different Marketplace origin or audience. Reuse its exact existing connection settings.');
  }
}
function planReview(options: NanoInteractiveSetupOptions, directory: string, config: NanoWalletConfiguration, mode: SetupMode, policy: Policy, originalPolicy?: Policy): string {
  const source = config.keySource;
  return review({ mode, directory, address: config.sourceAddress, network: config.network, rpcUrl: config.rpcUrl, workUrl: config.workUrl,
    origin: config.origin, audience: config.audience, index: config.derivationIndex, policy, ...(originalPolicy ? { originalPolicy } : {}),
    detailed: Boolean(options.advanced || options.json),
    sourceDescription: source.type === 'shared-recovery' ? `Recovery source: ${source.recoverySource.directory} (OS password store)` : `Seed file: ${source.seedFile}`,
    seedDescription: source.type === 'shared-recovery' ? `Recovery phrase: OS password store for ${source.recoverySource.directory}; ${source.derivationVersion}` : `Existing private seed file: ${source.seedFile}` });
}
function accessMode(policy: Policy): WalletAccessMode {
  return !policy.grants.externalTransfers ? 'login-only' : policy.limits.maxPaymentAtomic === null ? 'unlimited' : 'limited';
}
function identity(directory: string, config: NanoWalletConfiguration): NanoInteractiveSetupResult {
  return { directory, address: config.sourceAddress, index: config.derivationIndex, network: config.network };
}
function existingPlan(options: NanoInteractiveSetupOptions, directory: string, config: NanoWalletConfiguration, policy: Policy): DeferredWalletPlan {
  validateConfiguration({ ...config, ...policy });
  const wallet = identity(directory, config);
  let expected = config;
  let committed = false;
  const validate = async () => {
    requireTerminal();
    if (!isDeepStrictEqual(loadConfiguration(directory), expected)) throw failure('WALLET_CONFIGURATION_CHANGED', 'The Nano wallet changed during review. Repeat setup against its current settings.');
  };
  return { asset: 'XNO', wallet, mode: accessMode(policy), review: planReview(options, directory, config, 'reuse', policy, policyOf(config)),
    intent: structuredClone({ version: 1, directory, configuration: config, policy }), validate,
    commit: async () => {
      await validate();
      if (committed) return identity(directory, config);
      if (JSON.stringify(policy) !== JSON.stringify(policyOf(config))) await approveNanoWalletPolicy({ dataDir: directory, ...policy, expectedConfiguration: config, terminalConfirmed: true });
      expected = { ...config, ...policy };
      committed = true;
      await validate();
      return identity(directory, config);
    } };
}
function newPlan(options: NanoInteractiveSetupOptions, directory: string, config: NanoWalletConfiguration, mode: SetupMode): DeferredWalletPlan {
  const wallet = identity(directory, config);
  let committed: NanoWalletConfiguration | undefined;
  const validate = async () => {
    requireTerminal();
    if (committed) {
      if (!isDeepStrictEqual(loadConfiguration(directory), committed)) throw failure('WALLET_CONFIGURATION_CHANGED', 'The Nano wallet changed after its approved setup.');
      return;
    }
    requireEmptyTarget(directory);
    if (config.keySource.type === 'native-seed') {
      refuseManagedSeed(config.keySource.seedFile);
      if ((await inspectNanoSeed(config.keySource.seedFile, config.derivationIndex)).address !== config.sourceAddress) throw failure('WALLET_KEY_MISMATCH', 'The selected private Nano seed changed during review.');
    } else {
      const current = await inspectNanoRecoveryWallet(config.keySource.recoverySource.directory, config.derivationIndex);
      if (current.address !== config.sourceAddress || JSON.stringify(current.recoverySource) !== JSON.stringify(config.keySource.recoverySource)) throw failure('WALLET_KEY_MISMATCH', 'The recovery wallet changed during review.');
    }
  };
  return { asset: 'XNO', wallet, mode: accessMode(config), review: planReview(options, directory, config, mode, config),
    intent: structuredClone({ version: 1, directory, configuration: config, policy: policyOf(config) }), validate,
    commit: async () => {
      await validate();
      if (committed) return identity(directory, config);
      const source = config.keySource;
      await provisionNanoWallet({ dataDir: directory, derivationIndex: config.derivationIndex, network: config.network, rpcUrl: config.rpcUrl,
        ...(config.workUrl ? { workUrl: config.workUrl } : {}), origin: config.origin, audience: config.audience, ...policyOf(config), expectedAddress: config.sourceAddress,
        ...(source.type === 'native-seed' ? { seedFile: source.seedFile } : { recoveryWalletDirectory: source.recoverySource.directory }), terminalConfirmed: true });
      committed = config;
      await validate();
      return identity(directory, config);
    } };
}
function resumePlan(options: NanoInteractiveSetupOptions, intent: Record<string, unknown>): DeferredWalletPlan {
  if (Object.keys(intent).sort().join(',') !== 'configuration,directory,policy,version' || intent.version !== 1 || typeof intent.directory !== 'string') throw failure('WALLET_CONFIGURATION', 'The saved Nano setup plan is invalid.');
  const directory = privatePath(intent.directory), config = validateConfiguration(structuredClone(intent.configuration));
  assertConnection(options, config);
  if (!intent.policy || typeof intent.policy !== 'object' || Array.isArray(intent.policy) || Object.keys(intent.policy).sort().join(',') !== 'grants,limits') throw failure('WALLET_CONFIGURATION', 'The saved Nano setup policy is invalid.');
  const desired = validateConfiguration({ ...config, ...structuredClone(intent.policy) });
  if (hasProfile(directory)) {
    const current = loadConfiguration(directory);
    if (!isDeepStrictEqual({ ...current, grants: null, limits: null }, { ...config, grants: null, limits: null })) throw failure('WALLET_CONFIGURATION_CHANGED', 'The saved Nano setup refers to a different wallet or connection.');
    const policy = policyOf(desired);
    if (isDeepStrictEqual(config.grants.controllerPurposes, desired.grants.controllerPurposes)) policy.grants.controllerPurposes = [...current.grants.controllerPurposes];
    return existingPlan(options, directory, current, policy);
  }
  return newPlan(options, directory, desired, config.keySource.type === 'native-seed' ? 'import' : 'create');
}

async function policyQuestions(options: NanoInteractiveSetupOptions, current?: Policy): Promise<Policy> {
  const externalTransfers = await yesNo(options, 'Allow external Nano transfers from this wallet', current?.grants.externalTransfers ?? false);
  let maxPaymentAtomic = current ? current.limits.maxPaymentAtomic : '0';
  let rolling24hAtomic = current ? current.limits.rolling24hAtomic : '0';
  if (externalTransfers) {
    maxPaymentAtomic = xnoToRaw(await answer(options, 'Maximum XNO per payment (up to 30 decimal places)', maxPaymentAtomic === null || maxPaymentAtomic === '0' ? '1' : rawToXno(maxPaymentAtomic)));
    rolling24hAtomic = xnoToRaw(await answer(options, 'Maximum XNO over rolling 24 hours (all native sends)', rolling24hAtomic === null || rolling24hAtomic === '0' ? '10' : rawToXno(rolling24hAtomic)));
    if (maxPaymentAtomic !== null && rolling24hAtomic !== null && BigInt(maxPaymentAtomic) > BigInt(rolling24hAtomic)) throw failure('INVALID_AMOUNT', 'The per-payment ceiling must not exceed the rolling 24-hour ceiling.');
  }
  return { grants: { externalTransfers, controllerPurposes: [...(current?.grants.controllerPurposes ?? [])] },
    limits: { maxPaymentAtomic, rolling24hAtomic } };
}

async function basicPolicy(options: NanoInteractiveSetupOptions, current?: Policy): Promise<Policy> {
  const saved = current ? accessMode(current) : 'login-only';
  const fallback = saved === 'login-only' ? '1' : saved === 'limited' ? '2' : '3';
  const selection = await menuChoice(options.prompt,
    `Nano access: [1] Login only${fallback === '1' ? ' (default)' : ''}, [2] Limited spending${fallback === '2' ? ' (default)' : ''}, [3] Unlimited spending${fallback === '3' ? ' (default)' : ''}: `,
    ['1', '2', '3'], fallback);
  const limits: NanoWalletConfiguration['limits'] = current ? { ...current.limits } : { maxPaymentAtomic: '0', rolling24hAtomic: '0' };
  if (selection === '3') {
    limits.maxPaymentAtomic = null;
    limits.rolling24hAtomic = null;
  } else if (selection === '2' && (limits.maxPaymentAtomic === null || limits.rolling24hAtomic === null
    || !current?.grants.externalTransfers && (BigInt(limits.maxPaymentAtomic) === 0n || BigInt(limits.rolling24hAtomic) === 0n))) {
    limits.maxPaymentAtomic = await basicPaymentCap(options, 'Maximum XNO per payment (up to 30 decimal places)', '1');
    limits.rolling24hAtomic = await basicPaymentCap(options, 'Maximum XNO over rolling 24 hours (all native sends)', '10', limits.maxPaymentAtomic);
  }
  return { grants: { externalTransfers: selection !== '1', controllerPurposes: [...(current?.grants.controllerPurposes ?? [])] }, limits };
}

/** Correct only basic cap input; terminal and wallet failures retain their original boundary. */
async function basicPaymentCap(options:NanoInteractiveSetupOptions,question:string,fallback:string,minimumRaw?:string):Promise<string> {
  for(;;){
    const value=await answer(options,question,fallback);
    let raw:string;
    try{
      raw=xnoToRaw(value);
      if(BigInt(raw)===0n)throw failure('INVALID_AMOUNT','Limited Nano spending requires a positive payment cap.');
    }catch(error){
      if(!(error instanceof ProfileError)||error.code!=='INVALID_AMOUNT')throw error;
      process.stderr.write('Enter an XNO amount greater than zero, with up to 30 decimal places and within the Nano range.\n');
      continue;
    }
    if(minimumRaw!==undefined&&BigInt(raw)<BigInt(minimumRaw)){
      process.stderr.write(`The rolling 24-hour maximum must be at least the per-payment limit of ${rawToXno(minimumRaw)} XNO.\n`);
      continue;
    }
    return raw;
  }
}

type ReviewInput = {
  mode: SetupMode; directory: string; address: string | undefined; network: NanoNetwork; rpcUrl: string; workUrl: string | undefined;
  origin: string; audience: string; index: number; policy: Policy; originalPolicy?: Policy;
  sourceDescription: string; seedDescription: string; detailed: boolean;
};

function accessDescription(policy: Policy): string {
  if (!policy.grants.externalTransfers) return 'Login only (payments disabled)';
  if (policy.limits.maxPaymentAtomic === null) return 'Unlimited spending (can spend available balance and future deposits)';
  return BigInt(policy.limits.maxPaymentAtomic) > 0n && BigInt(policy.limits.rolling24hAtomic!) > 0n
    ? 'Limited spending (payments enabled within limits)' : 'Limited spending (zero limits block payments)';
}

function capDescription(value: string | null, detailed: boolean): string {
  return value === null ? 'Unlimited' : `${rawToXno(value)} XNO${detailed ? ` (${value} raw)` : ''}`;
}

function changedLine(label: string, current: string | undefined, requested: string): string {
  return `${label}: ${current !== undefined && current !== requested ? `${terminalText(current)} → ` : ''}${terminalText(requested)}`;
}

function review(input: ReviewInput): string {
  const action = input.mode === 'reuse' ? 'Continue existing Nano wallet and journal'
    : input.mode === 'import' ? 'Import existing private seed into a new Nano wallet' : 'Derive Nano wallet from shared recovery phrase';
  const original = input.originalPolicy;
  if (!input.detailed) {
    const lines = [
      'Review Nano wallet setup:',
      `Action: ${action}`,
      `Wallet directory: ${terminalText(input.directory)}`,
      terminalText(input.sourceDescription),
      `Address: ${terminalText(input.address ?? 'New public address will be derived after approval')}`,
      `Network: ${terminalText(input.network)}`,
      changedLine('Access', original && accessDescription(original), accessDescription(input.policy)),
      changedLine('Maximum per payment', original && capDescription(original.limits.maxPaymentAtomic, false), capDescription(input.policy.limits.maxPaymentAtomic, false)),
      changedLine('Rolling 24-hour maximum', original && capDescription(original.limits.rolling24hAtomic, false), capDescription(input.policy.limits.rolling24hAtomic, false)),
    ];
    const currentPurposes = original?.grants.controllerPurposes.join(', ') || 'none';
    const requestedPurposes = input.policy.grants.controllerPurposes.join(', ') || 'none';
    if (original && currentPurposes !== requestedPurposes) lines.push(changedLine('Controller purposes', currentPurposes, requestedPurposes));
    return [...lines, 'Keep your recovery phrase, wallet configuration and journals backed up securely.'].join('\n');
  }
  return [
    'Review Nano wallet setup:',
    `Action: ${terminalText(action)}`,
    changedLine('Access', original && accessDescription(original), accessDescription(input.policy)),
    `Wallet directory: ${terminalText(input.directory)}`,
    `Address: ${terminalText(input.address ?? 'New public address will be derived after approval')}`,
    `Derivation index: ${terminalText(input.index)}`,
    `Network: ${terminalText(input.network)}`,
    `RPC: ${terminalText(input.rpcUrl)}`,
    `Work: ${terminalText(nanoWorkDescription(input))}`,
    `Marketplace origin: ${terminalText(input.origin)}`,
    `Audience: ${terminalText(input.audience)}`,
    changedLine('External transfers', original && (original.grants.externalTransfers ? 'allowed' : 'denied'), input.policy.grants.externalTransfers ? 'allowed' : 'denied'),
    changedLine('Controller purposes', original && (original.grants.controllerPurposes.join(', ') || 'none'), input.policy.grants.controllerPurposes.join(', ') || 'none'),
    changedLine('Maximum per payment', original && capDescription(original.limits.maxPaymentAtomic, true), capDescription(input.policy.limits.maxPaymentAtomic, true)),
    changedLine('Rolling 24-hour maximum', original && capDescription(original.limits.rolling24hAtomic, true), capDescription(input.policy.limits.rolling24hAtomic, true)),
    terminalText(input.seedDescription),
    'Keep your recovery phrase, wallet configuration and journals backed up securely.',
  ].join('\n');
}

async function approve(options: NanoInteractiveSetupOptions, preview: string): Promise<void> {
  if ((await options.prompt(preview)).trim() !== 'APPROVE') throw failure('APPROVAL_DECLINED', 'Nano wallet setup was declined.');
  requireTerminal();
}

async function answer(options: NanoInteractiveSetupOptions, question: string, fallback?: string): Promise<string> {
  const value = (await options.prompt(`${question}${fallback ? ` [${terminalText(fallback)}]` : ''}: `)).trim();
  if (/\x00|\r|\n/.test(value) || value.length > 4096) throw failure('SETUP_USAGE', 'Use one bounded line for each setup answer.');
  if (!value && fallback === undefined) throw failure('SETUP_USAGE', 'A required Nano setup answer was empty.');
  return value || fallback!;
}

async function choice<T extends string>(options: NanoInteractiveSetupOptions, question: string, choices: readonly T[], fallback: T): Promise<T> {
  while (true) {
    const value = await answer(options, question, fallback);
    if (choices.includes(value as T)) return value as T;
    process.stderr.write(`Choose ${choices.join(', ')}.\n`);
  }
}

async function yesNo(options: NanoInteractiveSetupOptions, question: string, fallback: boolean): Promise<boolean> {
  while (true) {
    const value = (await answer(options, `${question} (yes/no)`, fallback ? 'yes' : 'no')).toLowerCase();
    if (value === 'yes' || value === 'y') return true;
    if (value === 'no' || value === 'n') return false;
    process.stderr.write('Answer yes or no.\n');
  }
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
    if (!st.isDirectory() || st.isSymbolicLink() || readdirSync(directory).length) throw failure('WALLET_CONFIGURATION_EXISTS', 'The target Nano directory already contains state. Select its existing Nano wallet or use an empty directory.');
    try { assertPrivatePermissions(directory, 'directory'); }
    catch { throw failure('PRIVATE_FILE', 'Use a private owner-only Nano wallet directory.'); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function refuseManagedSeed(seedFile: string): void {
  let directory = dirname(seedFile);
  while (directory !== parse(directory).root) {
    try {
      lstatSync(join(directory, 'wallet.json'));
      throw failure('WALLET_CONFIGURATION_EXISTS', `This seed is beside an existing Nano wallet. Select ${directory} so its keys and journal remain together.`);
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
