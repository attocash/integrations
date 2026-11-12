import assert from 'node:assert/strict';
import test from 'node:test';
import { selectPlatformTests } from '../scripts/test-platform.mjs';

test('Windows runs private Marketplace workflows and excludes only Unix executable fixtures', () => {
  // Given native private storage, stdio, profile, recovery and future contracts.
  const portable = ['atto-cli/test/storage.test.mjs', 'atto-mcp/test/interfaces.test.mjs',
    'atto-marketplace-nano-adapter/test/engine.test.mjs', 'atto-marketplace-nano-adapter/test/inspection.test.mjs',
    'atto-marketplace-nano-adapter/test/wallet-transport.test.mjs', 'atto-marketplace-nano-adapter/test/shared-wallet-binding.test.mjs',
    'atto-marketplace-mcp/test/platform-support.test.mjs', 'atto-marketplace-mcp/test/approval-files.test.mjs',
    'atto-marketplace-mcp/test/payment-handoff-files.test.mjs', 'atto-marketplace-mcp/test/wallet-preferences.test.mjs',
    'atto-marketplace-mcp/test/stdio-profile.test.mjs', 'atto-marketplace-mcp/test/stdio-submission-files.test.mjs',
    'atto-marketplace-mcp/test/compact-atto-setup.test.mjs', 'atto-marketplace-mcp/test/future-contract.test.mjs'];
  const unixFixtures = ['atto-marketplace-mcp/test/guided-onboarding.integration.test.mjs',
    'atto-marketplace-mcp/test/wallet-setup.integration.test.mjs'];
  // When selecting native Windows suites.
  const files = [...portable, ...unixFixtures];
  // Then financial journals and file privacy are tested instead of bypassed.
  assert.deepEqual(selectPlatformTests(files, 'win32'), { included: portable, excluded: unixFixtures });
  for (const platform of ['linux', 'darwin']) {
    assert.deepEqual(selectPlatformTests(files, platform), { included: files, excluded: [] });
  }
});

test('installed package paths and Windows separators preserve native workflow coverage', () => {
  // Given installed-package paths using both separator conventions.
  const files = ['C:\\repo\\atto-marketplace-mcp\\test\\stdio-profile.test.mjs',
    '/checkout/atto-marketplace-mcp/test/wallet-preferences.test.mjs',
    'C:\\repo\\atto-cli\\test\\core.test.mjs',
    'C:\\repo\\atto-marketplace-mcp\\test\\wallet-setup.integration.test.mjs'];
  // When applying the Windows selection policy.
  // Then only the actual shell-executable fixture is excluded.
  assert.deepEqual(selectPlatformTests(files, 'win32'), { included: files.slice(0, 3), excluded: [files[3]] });
});
