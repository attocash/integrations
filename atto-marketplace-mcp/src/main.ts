#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createMarketplaceMcpServer } from './server.js';
import { MarketplaceProfileStore } from './profile-store.js';
import { runSetup } from './setup.js';
import { runWalletSetup } from './wallet-setup.js';
import { defaultMarketplaceHome, defaultMarketplaceProfile } from './defaults.js';

export async function run(argv = process.argv.slice(2), env = process.env): Promise<void> {
  if (argv.length===1 && argv[0]==='--internal-wallet-host') {
    const {runWalletHost}=await import('./wallet-host.js');
    await runWalletHost(env);
    return;
  }
  if(argv[0]==='setup'&&(argv.includes('--interactive')||argv.slice(1).every(arg=>!arg.startsWith('--')||['--home','--profile','--origin','--audience','--advanced'].includes(arg)))) {
    const {runGuidedSetup}=await import('./guided-setup.js');
    await runGuidedSetup(argv.slice(1),env);return;
  }
  if(argv[0]==='approve') {
    const {runApproval}=await import('./approval-terminal.js');
    await runApproval(argv.slice(1),env);return;
  }
  if (argv[0]==='wallet') {
    await runWalletSetup(argv.slice(1),env);
    return;
  }
  if (argv[0]==='setup') {
    await runSetup(argv.slice(1),env);
    return;
  }
  const options = parseArgs(argv, env);
  if (options.help) {
    process.stdout.write('Marketplace MCP\n\nGuided setup: atto-marketplace-mcp setup [--advanced] [--home <directory>] [--profile <name>] [--origin <origin> --audience <audience>]\nDefaults: production Marketplace, main profile, per-user Marketplace home (override with --home).\nReuse the selected Atto CLI wallet and its current authority, choose Marketplace purposes, and optionally configure Nano. Use --advanced to choose accounts or configure native limits.\n\nDedicated wallet: atto-marketplace-mcp wallet setup --help\nShared recovery: new Nano wallets use the selected Atto recovery phrase.\nApproval: atto-marketplace-mcp approve <private-request-file> [--home <private-directory>]\n\nUsage: atto-marketplace-mcp [--profile <profile-id>] [--home <private-directory>] [--payment-handoff-dir <private-directory>] [--files-dir <private-directory>]\n       atto-marketplace-mcp setup --profile <id> --origin <https-origin> --audience <agent-api-audience> --controller-network <ATTO|NANO> --controller-address <address> --controller-index <index> --mode <controller-session|scoped-api-key> [credential grant options]\n       atto-marketplace-mcp setup --profile <id> --complete [--home <private-directory>]\n       atto-marketplace-mcp setup --profile <id> --reauthenticate [--home <private-directory>]\n       atto-marketplace-mcp setup --profile <new-id> --from-profile <controller-profile> --credential-id <api-key-id> [--home <private-directory>]\n\nCredential grants use repeatable --scope values. Per-asset limits include --publish-atto-limit/--publish-xno-limit, --apply-atto-limit/--apply-xno-limit, --purchase-atto-limit/--purchase-xno-limit and --product-publish-atto-limit/--product-publish-xno-limit. Product-publish limits apply only to new reservation holds; products:publish without them can manage existing holds.\n\nFile tools require an existing absolute private directory via --files-dir or MARKETPLACE_MCP_FILES_DIR; there is no default.\n');
    return;
  }
  const home = options.home ?? env.MARKETPLACE_MCP_HOME ?? defaultMarketplaceHome(env);
  const profileId = options.profile ?? env.MARKETPLACE_MCP_PROFILE ?? defaultMarketplaceProfile;
  const profiles = await MarketplaceProfileStore.open(resolve(home));
  let server: ReturnType<typeof createMarketplaceMcpServer> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.stdin.removeListener('end', onSignal);
    if (server) await server.close();
    profiles.close();
  })();
  const onSignal = () => { void close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.stdin.once('end', onSignal);
  try {
    server = createMarketplaceMcpServer({ profiles, profileId, env,
      ...(options.paymentHandoffDirectory ? { paymentHandoffDirectory: resolve(options.paymentHandoffDirectory) } : {}),
      ...(options.filesDirectory ? { filesDirectory: options.filesDirectory } : {}) });
    server.server.onerror = () => process.stderr.write('Marketplace MCP protocol error.\n');
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await close();
    throw error;
  }
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): { profile?: string; home?: string; paymentHandoffDirectory?: string; filesDirectory?: string; help: boolean } {
  const result: { profile?: string; home?: string; paymentHandoffDirectory?: string; filesDirectory?: string; help: boolean } = { help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--profile' && argv[index + 1]) { const value = argv[++index]; if (!value) throw new Error('Missing profile ID.'); result.profile = value; }
    else if (arg === '--home' && argv[index + 1]) { const value = argv[++index]; if (!value) throw new Error('Missing profile directory.'); result.home = value; }
    else if (arg === '--payment-handoff-dir' && argv[index + 1]) { const value = argv[++index]; if (!value) throw new Error('Missing payment handoff directory.'); result.paymentHandoffDirectory = value; }
    else if (arg === '--files-dir' && argv[index + 1]) { const value = argv[++index]; if (!value) throw new Error('Missing private files directory.'); result.filesDirectory = value; }
    else throw new Error(`Unknown or incomplete option: ${arg}`);
  }
  if (result.profile && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(result.profile)) {
    throw new Error('Profile IDs must be 1 to 48 letters, digits, underscores or hyphens.');
  }
  if (result.home && (result.home.includes('\0') || result.home.length > 2048)) throw new Error('Profile directory path is invalid.');
  if (result.paymentHandoffDirectory && (result.paymentHandoffDirectory.includes('\0') || result.paymentHandoffDirectory.length > 4096)) throw new Error('Payment handoff directory path is invalid.');
  if (!result.paymentHandoffDirectory && env.MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR) result.paymentHandoffDirectory = env.MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR;
  if (result.paymentHandoffDirectory && (result.paymentHandoffDirectory.includes('\0') || result.paymentHandoffDirectory.length > 4096)) throw new Error('Payment handoff directory path is invalid.');
  if (!result.filesDirectory && env.MARKETPLACE_MCP_FILES_DIR) result.filesDirectory = env.MARKETPLACE_MCP_FILES_DIR;
  if (result.filesDirectory && (!isAbsolute(result.filesDirectory) || result.filesDirectory.includes('\0') || result.filesDirectory.length > 4096)) {
    throw new Error('Private files directory must be an absolute path of at most 4096 characters.');
  }
  return result;
}

if (process.argv[1] && isMainModule(process.argv[1])) {
  run().catch(error => {
    const message = error instanceof Error ? error.message : 'Marketplace MCP could not start.';
    process.stderr.write(`Marketplace MCP: ${message}\n`);
    process.exitCode = 1;
  });
}

function isMainModule(entry: string): boolean {
  const own = realpathSync(fileURLToPath(import.meta.url));
  const invoked = realpathSync(entry);
  return process.platform === 'win32' ? own.toLowerCase() === invoked.toLowerCase() : own === invoked;
}
