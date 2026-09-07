# Atto CLI & MCP

**Your Atto wallet, in the terminal and your AI assistant.**

**Beta** · [CLI on npm](https://www.npmjs.com/package/@attocash/cli) ·
[MCP on npm](https://www.npmjs.com/package/@attocash/mcp)

Send payments by a name you recognize, follow your wallet activity, and give
an MCP client access with spending limits you choose. Both packages are
available as an initial beta.

[Get started](#get-started) · [What you can do](#what-you-can-do) ·
[CLI guide](atto-cli/README.md) · [MCP guide](atto-mcp/README.md)

- **Pay by name.** Save a personal label such as “Savings” and use it as a destination.
- **Follow your wallet.** Check balances, review history, and watch incoming payments.
- **Choose the agent's access.** Start read-only, then approve bounded spending in your terminal.
- **Keep your wallet between sessions.** Recovery phrases stay in your OS password store;
  wallet history and settings stay in your profile directory.

## Get started

Requires **Node.js 24**. Use the latest 24.x release and an available OS password
store: Keychain on macOS, Credential Manager on Windows, or Secret Service on
Linux. Linux also needs `secret-tool` and an unlocked desktop keyring.

### Use Atto in your terminal

```sh
npm install --global @attocash/cli
atto wallet create
atto address list
atto balances
```

Already have a recovery phrase? Use `atto wallet import` instead of creating a
wallet. Create or import in your own interactive terminal, and keep a private
offline copy of your recovery phrase.

To keep receiving incoming payments:

```sh
atto wallet receive
```

Leave it running while you want to receive; stop it with Ctrl+C.
[Continue with the CLI guide →](atto-cli/README.md)

### Connect your MCP client

```sh
npx --yes @attocash/mcp@latest setup
```

Setup walks you through choosing or creating a wallet, selecting read-only or
bounded spending access, and generating your client configuration. Copy that
configuration into your MCP client and reconnect. A global installation is
optional; npm fetches the MCP server and its CLI engine dependency.

Then try asking:

> Show my balances and recent payments.

> Watch my wallet for incoming payments.

[Copy an npx client configuration →](atto-mcp/README.md#install-and-connect)

## What you can do

| You want to… | Start here |
| --- | --- |
| Check your wallet | `atto wallet status` and `atto balances` |
| Give an address a familiar name | `atto labels set 0 "Main"` |
| Review recent payments | `atto history --limit 10` |
| Watch incoming payments | `atto watch receivable` |
| Export results for a script | `atto --json balances` |
| Let an agent work with your wallet | [MCP setup and example prompts](atto-mcp/README.md#try-these-prompts) |
| Understand a connection or keyring problem | `atto doctor` or MCP's `doctor` tool |

Once you have labeled a destination “Savings” and funded your wallet, sending
1 ATTO looks like this:

```sh
atto send --to-label "Savings" --amount 1
```

The CLI shows the resolved full address and request ID. Personal names resolve
only from your selected profile; global directory names are informational.
[Learn about personal names and retries](atto-cli/README.md#address-labels-and-personal-name-payments).

## Your wallet, your approvals

MCP starts read-only. It can inspect data, manage personal labels, and watch
events. Sending and receiving require spending access that you approve in a
local terminal. You choose the payment account pool, per-payment cap, and
rolling allowance. An agent can propose changes; you review and approve them.

Choose a dedicated MCP wallet, or share an existing CLI wallet during setup.
Sharing the same absolute `--data-dir` shares funds, history, request IDs, and
spending limits. Reinstalling a package does not select a different wallet.
Recovery phrases are never passed through MCP tools. These permissions govern
MCP tools; other programs running as your OS user retain their normal access.

[Spending approvals](atto-mcp/README.md#approve-access-and-limit-changes) ·
[Profiles and recovery](atto-cli/README.md#profiles-and-recovery)

## Find your way around

| Package | Command | Guide |
| --- | --- | --- |
| [`@attocash/cli`](https://www.npmjs.com/package/@attocash/cli) | `atto` | [Wallet setup, payments, labels, and recovery](atto-cli/README.md) |
| [`@attocash/mcp`](https://www.npmjs.com/package/@attocash/mcp) | `atto-mcp` | [Client setup, prompts, and all 36 tools](atto-mcp/README.md) |

Use `atto --help` or `atto-mcp --help` to explore commands. For updates, rerun
the npm installation command; npx with `@latest` selects the current published
release. [Update details](atto-cli/README.md#update-notices).

Found a problem while trying the beta? [Open an issue](https://github.com/attocash/integrations/issues)
with your OS, Node.js version, and the command or tool that failed. Keep recovery
phrases and credentials out of reports.

The [n8n integration](https://github.com/attocash/integrations-n8n) has its own
repository. Protocol signing and publication use [Atto Commons](https://github.com/attocash/commons).

## Development

### Install from source

Clone the repository, build the two local artifacts, and install them together:

```sh
git clone https://github.com/attocash/integrations.git
cd integrations
npm ci
npm run pack
npm install --global ./attocash-cli-0.1.1.tgz ./attocash-mcp-0.1.1.tgz
atto wallet create
```

To use only the terminal wallet, install just `attocash-cli-0.1.1.tgz`. Install
both artifacts in the same npm command when testing MCP from this checkout so
its exact CLI dependency resolves to the local artifact.

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

This produces `attocash-cli-0.1.1.tgz` and `attocash-mcp-0.1.1.tgz`. The root
`package-lock.json` records the development dependency tree for `npm ci`.
Packaging uses a temporary staging directory and leaves source package files
unchanged. Use the root script to produce release artifacts; plain `npm pack`
is blocked. `npm run test:package` builds and verifies the installed artifacts.

The CLI artifact bundles its direct Commons packages and their JavaScript
dependencies to preserve patched `ws` resolution despite Commons' exact older
pins. Native password-store bindings remain normal npm dependencies so npm
selects the correct platform binaries. MCP stays a separate package with a
normal, exact dependency on `@attocash/cli`; its SDK is not bundled.

Verify installed tarballs when updating dependencies. Overrides and shrinkwrap
alone did not preserve the replacement outside Commons' exact dependency pins.
`npm ls ws` may flag the bundled patched version as outside those upstream pins,
while runtime resolution and the production audit use the patched copy. Remove
the override and bundle when Commons publishes compatible updated pins.

## Releases

The [release workflow](.github/workflows/release.yml) runs on pushes to `main`
and supports manual runs from `main`. A manual run also publishes when commit
history warrants a release; it is not a preview. The workflow uses
semantic-release 24.2.7 in dry-run mode to calculate one shared version and
release notes from commit history, using tags named `atto-v<version>`. When
there is no release to make, publication is skipped. Release runs are serialized
without cancelling an active release.

The initial beta release, `0.1.0`, was published from tested bootstrap artifacts
and is recorded with tag `atto-v0.1.0`. Automated releases calculate subsequent
versions from that tag. Without
an `atto-v` tag, semantic-release defaults to `1.0.0`. Historical n8n tags
belong to a separate release series and do not set the CLI/MCP version.

Both artifacts receive that version, and MCP pins the matching CLI version
exactly. After the reusable CI checks pass, the release build tests the
workspaces, installs the packed artifacts, and exercises those installed
packages against isolated AttoNodeMock and worker containers. Only the
resulting tested tarballs are passed to the publisher.

The publisher runs in the GitHub `release` environment and is the only job with
`id-token: write`. It publishes the CLI tarball first, then MCP, using npm OIDC
trusted publishing. After both npm publications succeed, the workflow prepares
a draft GitHub release, attaches both tested tarballs, and makes the release
public. The shared tag points to the tested workflow commit. The workflow does
not use `NPM_TOKEN`.

The publisher uses a GitHub-hosted Ubuntu runner with Node.js 24, npm 11.5.1
or newer, and system `tar` to inspect the saved package manifests.

### Initial publisher setup

Create the GitHub environment `release` and restrict its deployment branches
to `main`; apply the repository's desired approval rules there. npm's trusted
publisher registration requires an existing package. If either package name
has never been published, an authorized maintainer must first publish its
reviewed, tested artifact using an interactive npm login with the appropriate
organization permissions. This is a separate initial setup action; adding the
workflow does not register or publish packages. See the
[npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/) and
[public scoped-package publishing guide](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).

In npm's package settings, register a GitHub Actions trusted publisher
**separately for `@attocash/cli` and `@attocash/mcp`**, with these values:

| npm setting | Value |
| --- | --- |
| Organization or user | `attocash` |
| Repository | `integrations` |
| Workflow filename | `release.yml` |
| Environment name | `release` |
| Allowed action | Enable direct `npm publish` |

Use the workflow filename alone, without `.github/workflows/`. Allowing only
staged publishing does not authorize this workflow's direct publication.
These values must match the publishing job, and the job must use a
GitHub-hosted runner. Follow the
[npm trusted-publishing setup](https://docs.npmjs.com/trusted-publishers/).

### Recovering a failed release

Use **Re-run failed jobs** on the original GitHub Actions run. The publisher
reuses that run's tested artifacts instead of rebuilding them. If a package
version was already published before another step failed, it is skipped only
when the registry's SHA-512 integrity matches the saved tarball. An integrity
mismatch stops the release.

The workflow retains artifacts for 14 days. Complete recovery within that
window and keep the original tarballs until publication and GitHub release
creation finish. Do not resolve a partial release by changing its version,
replacing its tarballs, or creating the release tag early. CLI can become
available before MCP during a partial failure; retrying the original publisher
completes the matching pair.
