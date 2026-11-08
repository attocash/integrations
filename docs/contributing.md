# Contributing to Atto integrations

Build, test, and packaging instructions for contributors.
For installation and wallet usage, see the [public guide](../README.md).

## Development

Requires Node.js 24.15.0 or newer; CI uses Node.js 24 on Linux, macOS, and Windows.

Run these commands from the repository root. The build compiles CLI first so
the wallet MCP and Nano adapter can resolve its exported library declarations.
The check command also builds the Nano adapter before checking Marketplace MCP:

```sh
npm ci
npm run build
npm run check
npm test
npm run test:integration
ATTO_TEST_KEYCHAIN=1 npm run test:keychain
npm run test:package
```

The Marketplace MCP is a separate workspace package. Its sources and tests live in
`atto-marketplace-mcp/`; its accepted tarball is included in `npm run pack` and
`npm run test:package`. The current trusted npm release remains limited to the
CLI and wallet MCP pair.

The CLI and its direct Commons dependencies now use the published 8.0.2
JavaScript verifier API. A regular `npm ci` installs the supported package set;
the optional `ATTO_COMMONS_LOCAL_VERSION` override is only for deliberate local
Commons development and does not change source package pins.

The root test runner keeps all Atto CLI and wallet MCP suites enabled on Linux,
macOS and Windows. Marketplace's private storage and executable-fixture suites
require POSIX permissions; Windows still runs portable protocol/API tests and
checks that private wallet startup fails closed. Tests have a three-minute
individual deadline and an eight-minute runner deadline, with separate CI step
and job limits. Package verification follows the same platform policy.

Individual workspaces support `build`, `check`, and `test` scripts. Build before
running a workspace test directly. Build CLI first, then the Nano adapter before
building or checking Marketplace MCP.
The executables in a checkout are:

```sh
node atto-cli/dist/cli/main.js --help
node atto-mcp/dist/main.js --help
node atto-marketplace-mcp/dist/main.js --help
```

The Nano adapter is a library workspace and has no executable.

Tests use temporary profiles and mock nodes/workers. They cover CLI and MCP
parity, real SDK stdio sessions, shutdown, recovery restrictions, signing,
publication recovery, personal-label CRUD and pinned destination retries, global-directory
cache failures, and the public library boundary. Installed artifacts are
also exercised. Linux container integration tests and isolated native
password-store tests are separate checks; no test sends live funds or publishes
a package.

## Source ownership

| Responsibility | Owner |
| --- | --- |
| Released wallet operations and session lifecycle | `atto-cli/src/application/`; public library entry point `core.ts` |
| Receive candidates, recovery, and unresolved receive fences | `atto-cli/src/wallet/receive.ts`, shared by explicit and automatic receiving |
| Spending policy, reservations, and account availability | `atto-cli/src/spending/ledger.ts`; `payments.ts` owns selection, signing, publication, and reconciliation |
| Terminal Marketplace approval presentation | `atto-cli/src/marketplace/approval-preview.ts`; all rendered fields pass through terminal escaping |
| Wallet MCP protocol and transport | `atto-mcp/src/`, using the released CLI engine |
| Marketplace tools and resource-specific commands | `atto-marketplace-mcp/src/server.ts` |
| Marketplace funding intent and native-payment recovery | `atto-marketplace-mcp/src/marketplace-funding.ts` |
| Protected Marketplace mutations and terminal approval recovery | `atto-marketplace-mcp/src/protected-mutation.ts` |
| Marketplace profile persistence and submission claims | `atto-marketplace-mcp/src/profile-store.ts` |
| Marketplace canonical serialization and asset/network rules | `atto-marketplace-mcp/src/canonical-json.ts` and `asset-network.ts` |
| Nano native operation lifecycle and spend reservations | `atto-marketplace-nano-adapter/src/wallet.ts` and `journal.ts` |
| Bounded Nano JSON parsing | `atto-marketplace-nano-adapter/src/json.ts`, shared by RPC and local recovery inputs |

The CLI and wallet MCP are released contracts. Keep their exported interfaces,
operation schemas, command behavior, and persisted wallet records compatible.
Marketplace packages are unreleased; their internal interfaces can change. Preserve
financial recovery guarantees across all packages: retry the original request ID,
retain uncertain reservations and exact signed candidates, and hold the existing
account and wallet locks around the same state transitions. Moving a workflow
must include its recovery path and journal validation.

## Packaging

```sh
npm run pack
npm run pack -- --pack-destination /tmp/atto-artifacts
```

The CLI and wallet MCP use `0.0.0` as a development placeholder; Marketplace MCP
and the private Nano adapter currently use `0.1.0`. CI assigns the CLI and wallet
MCP the shared version calculated by semantic-release before testing and
publishing. It also aligns their CLI dependency pins in both Marketplace
workspaces, without changing the Marketplace package versions.

This produces CLI, wallet MCP, and Marketplace MCP tarballs. The Nano adapter
is a private source workspace bundled inside the Marketplace MCP tarball; it
does not need a separate npm release or installation. The Marketplace MCP tarball
is an accepted workspace artifact and is not in the trusted npm publisher.
The root `package-lock.json` records the development dependency tree for
`npm ci`.

Repository guides follow the source checkout, so they can describe commands and
tools absent from an older npm release. The release workflow publishes only
the tested CLI and wallet MCP tarballs; Marketplace MCP remains a source artifact.

Packaging uses a temporary staging directory and leaves source package files
unchanged. Use the root script to produce release artifacts; plain `npm pack`
is blocked. `npm run test:package` builds and verifies the installed artifacts.

The CLI artifact bundles its direct Commons packages and their JavaScript
dependencies to preserve patched `ws` resolution. Native password-store
bindings remain normal npm dependencies so npm selects the correct platform
binaries. The wallet MCP stays a separate package with an exact dependency on
`@attocash/cli`; its SDK is not bundled. The Marketplace MCP package depends on the
matching CLI artifact and Commons 8.0.2. Its bundled Nano adapter shares that
CLI engine; the adapter's crypto dependencies remain normal npm dependencies.
Package verification installs Marketplace MCP without a separate adapter artifact
and verifies the embedded adapter in paired, global, and npm exec installations. For local Commons
packages, `ATTO_COMMONS_LOCAL_VERSION` makes staging verify the one installed
Commons closure and rewrites only the staged CLI dependency versions; source
manifests remain registry-pinned.

Verify installed tarballs when updating dependencies. Overrides and shrinkwrap
alone did not preserve the replacement outside Commons' exact dependency pins.
`npm ls ws` may flag the bundled patched version as outside those upstream pins,
while runtime resolution and the production audit use the patched copy. Remove
the override and bundle when Commons publishes compatible updated pins.
