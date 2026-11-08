import assert from 'node:assert/strict';
import test from 'node:test';
import { selectPlatformTests } from '../scripts/test-platform.mjs';

test('Windows retains Atto CLI/MCP and portable Marketplace contracts while excluding POSIX storage suites', () => {
  // Given portable CLI/MCP and Marketplace contracts alongside private-storage suites.
  const portable = ['atto-cli/test/storage.test.mjs', 'atto-mcp/test/interfaces.test.mjs',
    'atto-marketplace-nano-adapter/test/protocol.test.mjs', 'atto-marketplace-nano-adapter/test/rpc.test.mjs',
    'atto-marketplace-nano-adapter/test/x402-conformance.test.mjs', 'atto-marketplace-nano-adapter/test/recovery-vectors.test.mjs',
    'atto-marketplace-mcp/test/platform-support.test.mjs', 'atto-marketplace-mcp/test/wallet-results.test.mjs',
    'atto-marketplace-mcp/test/marketplace-api-signer.test.mjs', 'atto-marketplace-mcp/test/future-contract.test.mjs'];
  const privateStorage = ['atto-marketplace-mcp/test/stdio-profile.test.mjs',
    'atto-marketplace-mcp/test/stdio-application-messages.test.mjs',
    'atto-marketplace-nano-adapter/test/engine.test.mjs'];
  // When selecting suites for Windows.
  const selected = selectPlatformTests([...portable, ...privateStorage], 'win32');
  // Then portable and future contracts remain enabled while POSIX storage is excluded.
  assert.deepEqual(selected, { included: portable, excluded: privateStorage });
  for (const platform of ['linux', 'darwin']) {
    assert.deepEqual(selectPlatformTests([...portable, ...privateStorage], platform), { included: [...portable, ...privateStorage], excluded: [] });
  }
});

test('installed package paths and Windows separators use the same platform policy', () => {
  // Given absolute installed-package paths using both separator conventions.
  const files = ['C:\\repo\\atto-marketplace-mcp\\test\\stdio-profile.test.mjs',
    '/checkout/atto-marketplace-mcp/test/wallet-preferences.test.mjs',
    'C:\\repo\\atto-cli\\test\\core.test.mjs'];
  // When applying the Windows selection policy.
  const selected = selectPlatformTests(files, 'win32');
  // Then CLI stays enabled and Marketplace private storage is consistently excluded.
  assert.deepEqual(selected, { included: [files[2]], excluded: files.slice(0, 2) });
});
