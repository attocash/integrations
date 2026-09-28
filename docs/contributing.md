# Contributing to Atto CLI and MCP

Build, test, and packaging instructions for contributors.
For installation and wallet usage, see the [public guide](../README.md).

## Development

Run these commands from the repository root. The build compiles CLI first so
MCP can resolve its exported library declarations:

```sh
npm ci
npm run build
npm run check
npm test
npm run test:integration
ATTO_TEST_KEYCHAIN=1 npm run test:keychain
npm run test:package
```

Until the Commons JS verifier is published, plain `npm ci` installs Commons
8.0.0 and the CLI `prebuild`/`precheck` guards intentionally fail because that
package has no JavaScript `AttoSignature.isValidMessage` export. Source builds
and package tests need the local Commons JS package set installed into the
workspace first; use the exact `ATTO_COMMONS_LOCAL_VERSION` for that set (the
current local build is `8.1.0-local.0`). Do not update the signed integrations
package manifests or treat the local packages as a published release.

Individual workspaces support `build`, `check`, and `test` scripts. Build before
running a workspace test directly; build CLI before building or checking MCP.
The executables in a checkout are:

```sh
node atto-cli/dist/cli/main.js --help
node atto-mcp/dist/main.js --help
```

Tests use temporary profiles and mock nodes/workers. They cover CLI and MCP
parity, real SDK stdio sessions, shutdown, recovery restrictions, signing,
publication recovery, personal-label CRUD and pinned destination retries, global-directory
cache failures, and the public library boundary. Installed artifacts are
also exercised. Linux container integration tests and isolated native
password-store tests are separate checks; no test sends live funds or publishes
a package.

## Packaging

```sh
npm run pack
npm run pack -- --pack-destination /tmp/atto-artifacts
```

Source checkouts use `0.0.0` as a development placeholder. CI replaces it with
the version calculated by semantic-release before testing and publishing.

This produces `attocash-cli-0.0.0.tgz` and `attocash-mcp-0.0.0.tgz`. The root
`package-lock.json` records the development dependency tree for `npm ci`.
Packaging uses a temporary staging directory and leaves source package files
unchanged. Use the root script to produce release artifacts; plain `npm pack`
is blocked. `npm run test:package` builds and verifies the installed artifacts.

The CLI artifact bundles its direct Commons packages and their JavaScript
dependencies to preserve patched `ws` resolution despite Commons' exact older
pins. Native password-store bindings remain normal npm dependencies so npm
selects the correct platform binaries. MCP stays a separate package with a
normal, exact dependency on `@attocash/cli`; its SDK is not bundled. For local
Commons packages, `ATTO_COMMONS_LOCAL_VERSION` makes staging verify the one
installed Commons closure and rewrites only the staged CLI dependency versions;
the source manifests remain registry-pinned.

Verify installed tarballs when updating dependencies. Overrides and shrinkwrap
alone did not preserve the replacement outside Commons' exact dependency pins.
`npm ls ws` may flag the bundled patched version as outside those upstream pins,
while runtime resolution and the production audit use the patched copy. Remove
the override and bundle when Commons publishes compatible updated pins.
