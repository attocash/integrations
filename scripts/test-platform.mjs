// These suites require Marketplace's POSIX ownership/mode checks or executable
// fixtures. Atto CLI/MCP and portable Marketplace crypto/API tests run everywhere.
const posixTests = new Set([
  'atto-marketplace-mcp/test/approval-files.test.mjs',
  'atto-marketplace-mcp/test/approval-terminal-recovery.test.mjs',
  'atto-marketplace-mcp/test/atto-private-recovery.test.mjs',
  'atto-marketplace-mcp/test/guided-onboarding.integration.test.mjs',
  'atto-marketplace-mcp/test/marketplace-api-refresh.test.mjs',
  'atto-marketplace-mcp/test/nano-guided-setup.test.mjs',
  'atto-marketplace-mcp/test/nano-wallet-terminal.test.mjs',
  'atto-marketplace-mcp/test/node-wallet-funding-recovery.test.mjs',
  'atto-marketplace-mcp/test/node-wallet-host.test.mjs',
  'atto-marketplace-mcp/test/payment-handoff-files.test.mjs',
  'atto-marketplace-mcp/test/profile-store-concurrency.test.mjs',
  'atto-marketplace-mcp/test/profile-store-controller-network.test.mjs',
  'atto-marketplace-mcp/test/receive-recovery-errors.test.mjs',
  'atto-marketplace-mcp/test/setup.test.mjs',
  'atto-marketplace-mcp/test/shared-recovery-onboarding.integration.test.mjs',
  'atto-marketplace-mcp/test/stdio-activity-lifecycle.test.mjs',
  'atto-marketplace-mcp/test/stdio-application-hire-recovery.test.mjs',
  'atto-marketplace-mcp/test/stdio-application-messages.test.mjs',
  'atto-marketplace-mcp/test/stdio-command-polling.test.mjs',
  'atto-marketplace-mcp/test/stdio-controller-approval.test.mjs',
  'atto-marketplace-mcp/test/stdio-engagement-history.test.mjs',
  'atto-marketplace-mcp/test/stdio-nano-shop-approval.test.mjs',
  'atto-marketplace-mcp/test/stdio-products.test.mjs',
  'atto-marketplace-mcp/test/stdio-profile.test.mjs',
  'atto-marketplace-mcp/test/stdio-public-history.test.mjs',
  'atto-marketplace-mcp/test/stdio-publication-reservation.test.mjs',
  'atto-marketplace-mcp/test/stdio-purchases.test.mjs',
  'atto-marketplace-mcp/test/stdio-submission-files.test.mjs',
  'atto-marketplace-mcp/test/stdio-unified-funding.test.mjs',
  'atto-marketplace-mcp/test/unified-approval-native.integration.test.mjs',
  'atto-marketplace-mcp/test/wallet-access.test.mjs',
  'atto-marketplace-mcp/test/wallet-home.test.mjs',
  'atto-marketplace-mcp/test/wallet-preferences.test.mjs',
  'atto-marketplace-mcp/test/wallet-setup.integration.test.mjs',
  'atto-marketplace-nano-adapter/test/engine.test.mjs',
  'atto-marketplace-nano-adapter/test/inspection.test.mjs',
  'atto-marketplace-nano-adapter/test/recovery-root.test.mjs',
  'atto-marketplace-nano-adapter/test/shared-wallet-binding.test.mjs',
  'atto-marketplace-nano-adapter/test/wallet-transport.test.mjs',
]);

export function selectPlatformTests(files, platform = process.platform) {
  const included = [], excluded = [];
  for (const file of files) {
    const normalized = file.replaceAll('\\', '/');
    const relative = [...posixTests].find(path => normalized === path || normalized.endsWith(`/${path}`));
    (platform === 'win32' && relative ? excluded : included).push(file);
  }
  return { included, excluded };
}

export function reportPlatformExclusions(excluded) {
  if (!excluded.length) return;
  process.stdout.write(`Skipping ${excluded.length} POSIX Marketplace storage/fixture suites on Windows; Atto CLI/MCP and portable Marketplace suites remain enabled.\n`);
  for (const file of excluded) process.stdout.write(`  POSIX only: ${file}\n`);
}
