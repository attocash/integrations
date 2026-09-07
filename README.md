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

## Install from source

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

For development and testing, see the [contributor guide](docs/contributing.md).
