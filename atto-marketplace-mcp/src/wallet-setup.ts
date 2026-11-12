import { defaultMarketplaceHome } from './defaults.js';
import { runNanoTerminal, nanoWalletUsage } from './nano-terminal.js';
import {existsSync} from 'node:fs';
import { join, resolve } from 'node:path';
import { ProfileError } from './profile-store.js';
import { ensurePaymentHandoffDirectory } from './payment-handoff-files.js';
import { managedWalletEnvironment } from './wallet-home.js';
import {approveAttoWalletAccess,runAttoWalletAccessCommand} from './wallet-access.js';

const usage = 'Usage: atto-marketplace-mcp wallet setup [--asset ATTO] [--home <private-directory>] [--index <index>] --network <atto:live|atto:beta|atto:dev|atto:local> --node-url <url> --worker-url <url>\nAtto policy: atto-marketplace-mcp wallet policy --asset ATTO [--home <private-directory>] [--allow-marketplace-funding] [--allow-external-transfers]\n';

/** Wallet recovery and approvals execute only in a person's local terminal. */
export async function runWalletSetup(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  if(argv[0]==='setup'&&!argv.includes('--help')&&!argv.includes('-h')&&(argv.includes('--interactive')||(!argv.includes('--network')&&!argv.includes('--rpc-url')))) {
    const {runWalletWizard}=await import('./guided-setup.js');
    await runWalletWizard(argv.slice(1),env);return;
  }
  if(!['setup','status','policy'].includes(argv[0]??''))throw new ProfileError('SETUP_USAGE',usage.trim());
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(usage+nanoWalletUsage); return; }
  if((argv[0]==='status'||argv[0]==='policy')&&argv.includes('ATTO')) {await runAttoWalletAccessCommand(argv,env);return;}
  if(argv[0]==='status'||argv[0]==='policy'||argv.includes('XNO')) {await runNanoTerminal(argv,env);return;}
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new ProfileError('TERMINAL_REQUIRED', 'Marketplace wallet setup requires an interactive local terminal.');
  }
  if (argv[0] !== 'setup') throw new ProfileError('SETUP_USAGE', usage.trim());
  const options = new Map<string, string>();
  const names = new Set(['--asset', '--home', '--index', '--network', '--node-url', '--worker-url']);
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !names.has(key) || !value || value.startsWith('--') || options.has(key)) {
      throw new ProfileError('SETUP_USAGE', usage.trim());
    }
    options.set(key, value);
  }
  if (options.has('--asset') && options.get('--asset') !== 'ATTO') throw new ProfileError('SETUP_USAGE', usage.trim());
  const indexText = options.get('--index') ?? '0';
  if (!/^(0|[1-9][0-9]{0,9})$/.test(indexText) || Number(indexText) > 0x7fff_ffff) {
    throw new ProfileError('SETUP_USAGE', 'Choose an Atto controller index from 0 through 2147483647.');
  }
  const network = options.get('--network');
  if (!network || !/^atto:(live|beta|dev|local)$/.test(network)) {
    throw new ProfileError('SETUP_USAGE', 'Choose the exact Atto native network with --network.');
  }
  const nodeUrl = publicUrl(options.get('--node-url'));
  const workerUrl = publicUrl(options.get('--worker-url'));
  const home = resolve(options.get('--home') ?? env.MARKETPLACE_MCP_HOME ?? defaultMarketplaceHome(env));
  const walletEnv = managedWalletEnvironment(home, env);
  const directory = walletEnv.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR!;
  ensurePaymentHandoffDirectory(home);
  ensurePaymentHandoffDirectory(directory);
  process.stderr.write(`Marketplace MCP Atto wallet: ${directory}\nNative network: ${network}\nNode: ${nodeUrl}\nWork server: ${workerUrl}\n`);
  const { setupMarketplaceWallet } = await import('@attocash/cli/terminal');
  let reuseExisting=false;
  if(existsSync(join(directory,'state.sqlite'))){
    const {createApplication}=await import('@attocash/cli/core');
    const existing=createApplication({directory});
    try{reuseExisting=Boolean((await existing.call('wallet_status',{}) as {initialized:boolean}).initialized);}
    finally{await existing.close();}
  }
  const wallet=await setupMarketplaceWallet({directory,controllerIndex:Number(indexText),reuseExisting,typedControllerApprovals:true,
    configuration:{network:network.slice(5).toUpperCase() as 'LIVE'|'BETA'|'DEV'|'LOCAL',nodeUrl,workerUrl}});
  await approveAttoWalletAccess({home,directory,index:wallet.index});
  process.stdout.write(`${JSON.stringify({status:'wallet-configured', ...wallet, network,
    next:'Use this public controller address for Marketplace login or explicitly link it to your existing Marketplace account. Configure only atto-marketplace-mcp in your client.'})}\n`);
}

function publicUrl(value: string | undefined): string {
  if (!value || value.length > 2048) throw new ProfileError('SETUP_USAGE', 'Supply both --node-url and --worker-url for this native network.');
  let url: URL;
  try { url = new URL(value); } catch { throw new ProfileError('SETUP_USAGE', 'Use an HTTP(S) native node or work-server URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new ProfileError('SETUP_USAGE', 'Native node and work-server URLs must have no credentials or fragment.');
  }
  return value;
}
