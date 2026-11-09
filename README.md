# Atto integrations

**Your wallet in the terminal. Your AI assistant with an allowance.**

Send Atto payments by a familiar name, follow wallet activity, and let an AI
assistant make payments within limits you approve. Connect Marketplace MCP when
you want your agent to find work, hire workers, or buy and sell through the Shop.

Recovery phrases stay in your OS password store. Wallet setup and access approvals
happen in your own terminal.

[Get started](#get-started) · [Choose a package](#choose-a-package) ·
[How access works](#how-access-works) · [Documentation](#documentation)

## Choose a package

| You want to… | Install | Command | Guide |
| --- | --- | --- | --- |
| Use an Atto wallet from your terminal or scripts | [`@attocash/cli`](https://www.npmjs.com/package/@attocash/cli) | `atto` | [CLI README](atto-cli/README.md) |
| Give an MCP assistant access to an Atto wallet | [`@attocash/mcp`](https://www.npmjs.com/package/@attocash/mcp) | `atto-mcp` | [Wallet MCP README](atto-mcp/README.md) |
| Work with Marketplace tasks, hiring, and Shop purchases | [`@attocash/marketplace-mcp`](https://www.npmjs.com/package/@attocash/marketplace-mcp) | `atto-marketplace-mcp` | [Marketplace MCP README](atto-marketplace-mcp/README.md) |

All three are available on npm as **beta** packages. The MCP packages install
their wallet engine dependencies automatically. Marketplace MCP includes its
private Nano adapter; there is no separate adapter to install.

## Get started

Requires **Node.js 24.15.0 or newer**. CI uses Node.js 24. Wallets need an
available OS password store:

| Platform | Password store |
| --- | --- |
| macOS | Keychain |
| Windows | Credential Manager |
| Linux | An unlocked Secret Service provider, `secret-tool`, and access to your desktop D-Bus session |

The CLI and wallet MCP support Linux, macOS, and Windows. Marketplace MCP's
private wallet storage requires Linux or macOS. See each package guide for its
requirements and troubleshooting.

### Use your terminal

```sh
npm install --global @attocash/cli
atto wallet create
atto address list
atto balances
```

Already have a recovery phrase? Run `atto wallet import` instead. Create or
import in your own interactive terminal and keep a private offline recovery copy.
The default network is **LIVE**.

To receive incoming payments, leave this command running; stop it with Ctrl+C:

```sh
atto wallet receive
```

With a funded wallet, give a second address a name and send 1 ATTO to it:

```sh
atto address activate 1
atto labels set 1 "Savings"
atto send --to-label "Savings" --amount 1
```

The CLI displays the full destination and a request ID. Keep the request ID
when retrying an interrupted payment. Personal names come from your selected
wallet profile.

[Continue with the CLI guide →](atto-cli/README.md)

### Connect your AI assistant

Run setup in your terminal:

```sh
npx --yes @attocash/mcp@latest setup
```

Choose **Dedicated MCP wallet (default)**, create or import a wallet, and select
read-only or bounded spending access. For that default wallet, add this to a
client that uses `mcpServers` configuration, such as Claude Desktop:

```json
{
  "mcpServers": {
    "atto": {
      "command": "npx",
      "args": ["--yes", "@attocash/mcp@latest"]
    }
  }
}
```

Reconnect your client and try:

> Show my balances and the last 10 payments.

> Label address 0 as Main, then explain my current spending limits.

Your client starts the local server. Setup is a one-time terminal step;
`--yes` accepts npm's download prompt, while wallet and spending approvals
still require your review. To share a CLI wallet or select another directory,
use the exact configuration printed by setup.

[Client configuration, tools, and approvals →](atto-mcp/README.md)

### Put an agent to work on Marketplace

```sh
npm install --global @attocash/marketplace-mcp
atto-marketplace-mcp setup
```

Setup uses the production Marketplace connection and default profile, lets you
select local wallets and approve login, and prints the configuration for your
MCP client. Copy it, reconnect, then try:

> Show open Marketplace tasks that match my skills.

> Show my Shop purchases and which downloads are available.

Marketplace tools cover buyer, worker, and seller workflows. Publishing,
funding, and other protected actions follow their respective permissions and
approvals. Human users can also use the Marketplace browser workspace.

[Marketplace setup and workflows →](atto-marketplace-mcp/README.md)

## How access works

Wallet MCP starts **read-only**. It can inspect balances and history, manage
personal labels, watch events, and propose access changes. Sending and receiving
require spending access approved in a local terminal.

You choose the payment account pool, per-payment cap, and rolling allowance.
An agent can propose a change; the proposal takes effect only after your
terminal approval. Recovery phrases are entered or displayed only through
terminal wallet commands.

A dedicated MCP wallet keeps a separate wallet profile. Pointing the CLI and
wallet MCP at the same absolute `--data-dir` shares funds, payment history,
request IDs, and spending limits. Package installation and npm's cache do not
define wallet identity.

Marketplace MCP has its own selected account profile and wallet permissions.
Marketplace controller proofs and wallet spending grants authorize different
actions; its [approval guide](atto-marketplace-mcp/README.md#permissions-and-approvals)
explains both. These controls govern the tools; software running as your OS
user retains its normal local access.

## Documentation

| Need | Read |
| --- | --- |
| Payments, labels, receiving, and scripts | [CLI guide](atto-cli/README.md) |
| Assistant setup, wallet access, and tools | [Wallet MCP guide](atto-mcp/README.md) |
| Tasks, applications, submissions, Shop, and funding | [Marketplace MCP guide](atto-marketplace-mcp/README.md) |
| Embed the wallet engine in a Node.js application | [Public library API](docs/library-api.md) |
| Understand the bundled Nano wallet engine | [Nano adapter guide](atto-marketplace-nano-adapter/README.md) |
| Build, test, or install local artifacts | [Contributor guide](docs/contributing.md) |

The [n8n integration](https://github.com/attocash/integrations-n8n) lives in its
own repository. Protocol signing and publication use
[Atto Commons](https://github.com/attocash/commons).

### Release status

The shared release workflow publishes the CLI, wallet MCP, and Marketplace MCP
to npm and attaches the tested tarballs to
[GitHub releases](https://github.com/attocash/integrations/releases). The Nano
adapter remains a private workspace bundled into Marketplace MCP.

Use the linked npm package pages for current versions. Repository documentation
can describe features added after an older installed release; `atto --help`,
`atto-mcp --help`, and your MCP client's tool list show what you have installed.

To update a global installation, rerun its `npm install --global` command.
The npx examples use `@latest` to select the current published release.

## Help and contributions

Start with `atto doctor` or wallet MCP's `doctor` tool for wallet environment
and connectivity checks. For a bug or feature request,
[open an issue](https://github.com/attocash/integrations/issues) with your OS,
Node.js and package versions, and the failing command or tool. Remove recovery
phrases, credentials, and private wallet data from reports.

Contributions are welcome. See [build and test instructions](docs/contributing.md).

Licensed under [BSD-3-Clause](LICENSE).
