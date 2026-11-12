// Only suites that launch Unix shell executables remain excluded. Private
// Marketplace storage, SQLite, stdio and native Nano workflows run on Windows.
const unixExecutableFixtures = new Set([
  'atto-marketplace-mcp/test/guided-onboarding.integration.test.mjs',
  'atto-marketplace-mcp/test/shared-recovery-onboarding.integration.test.mjs',
  'atto-marketplace-mcp/test/unified-approval-native.integration.test.mjs',
  'atto-marketplace-mcp/test/wallet-setup.integration.test.mjs',
]);

export function selectPlatformTests(files, platform = process.platform) {
  const included = [], excluded = [];
  for (const file of files) {
    const normalized = file.replaceAll('\\', '/');
    const unixFixture = [...unixExecutableFixtures].some(path => normalized === path || normalized.endsWith(`/${path}`));
    (platform === 'win32' && unixFixture ? excluded : included).push(file);
  }
  return { included, excluded };
}

export function reportPlatformExclusions(excluded) {
  if (!excluded.length) return;
  process.stdout.write(`Skipping ${excluded.length} Unix executable-fixture suites on Windows; native Marketplace storage, credentials and stdio suites remain enabled.\n`);
  for (const file of excluded) process.stdout.write(`  Unix executable fixture: ${file}\n`);
}
