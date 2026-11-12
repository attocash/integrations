# @attocash/mcp

**Give your AI assistant an Atto wallet with locally approved spending limits.**

**Beta** · [npm](https://www.npmjs.com/package/@attocash/mcp) ·
[Source](https://github.com/attocash/integrations/tree/main/atto-mcp)

Check balances, name addresses, review payment history, and follow incoming
payments from your MCP client. Start with read-only access, then approve a
per-payment limit, rolling allowance, and source accounts in your own terminal
when you want your assistant to make payments.

The server runs locally over stdio and uses the same wallet engine as
[`@attocash/cli`](https://www.npmjs.com/package/@attocash/cli). Recovery phrases
stay in your OS password store and your terminal. Choose a dedicated assistant
wallet or share an existing CLI wallet and its spending history.

[Connect](#install-and-connect) · [First prompts](#try-these-prompts) ·
[Approve spending](#approve-access-and-limit-changes) · [Tools](#tools) ·
[Troubleshooting](#troubleshooting) ·
[Full reference](https://github.com/attocash/integrations/blob/main/docs/mcp-reference.md)

## Install and connect

You need **Node.js 24.15.0 or newer**, npm, and an accessible OS password store:

| Platform | Custody requirements |
| --- | --- |
| Linux | `secret-tool` (usually `libsecret-tools`), an unlocked Secret Service provider such as GNOME Keyring or KWallet, and your desktop D-Bus session |
| macOS | Keychain access for the OS user running the server |
| Windows | Credential Manager access for the OS user running the server and the [Microsoft Visual C++ v14 runtime](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170) matching Node.js architecture |

Windows uses the CLI engine's ordinary Node.js filesystem support and per-user
profile permissions. Recovery material stays in Credential Manager.

There is no plaintext recovery-phrase fallback. Run setup and your MCP client
in the local OS user session that can access this store. A hosted client needs
a way to launch a local stdio server; this package does not provide a remote
HTTP endpoint. See the
[CLI installation guide](https://github.com/attocash/integrations/blob/main/atto-cli/README.md#install)
for platform setup.

### 1. Set up the wallet in your terminal

```sh
npx --yes @attocash/mcp@latest setup
```

Choose **Dedicated MCP wallet (default)** and **Read-only (default)** to start.
Setup can create a wallet or import a recovery phrase through a hidden terminal
prompt. For a new wallet, keep the displayed recovery phrase in a private offline
backup. Never paste it into a chat or client configuration.

`--yes` accepts npm's package installation prompt. Wallet creation and approval
still require your confirmation in the terminal. npm installs the CLI engine
dependency automatically; a separate CLI installation is optional.

### 2. Add the server to your MCP client

For a client using `mcpServers` configuration, such as Claude Desktop, use:

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

This selects the default dedicated MCP wallet. **If setup selected an existing
CLI wallet or a custom directory, copy the JSON that setup prints instead**;
it includes the exact `--data-dir` needed to reconnect to that wallet.

Configuration locations and formats depend on your client. For VS Code, follow
its [MCP server setup instructions](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

Your client launches and manages the server process. You do not need to keep
the setup terminal open, start a second server, or rerun setup for each session.
Restart or reconnect the client after saving the configuration. `@latest`
selects the current published release when npm resolves the package; wallet
state stays outside npm's cache.

### 3. Check the connection

Ask your assistant:

> Check my Atto wallet status and spending access. Then run doctor.

It can call `wallet_status`, `limits_get`, and `doctor`. Verify the profile
directory, network, and wallet address before funding the wallet. `doctor`
checks the actual MCP process environment and can take up to 60 seconds.

### Share a CLI wallet or choose another directory

Run setup and choose **Existing CLI wallet**, or select a directory explicitly:

```sh
npx --yes @attocash/mcp@latest --data-dir /absolute/path/to/wallet setup
```

Use the same absolute directory in your client:

```json
{
  "mcpServers": {
    "atto": {
      "command": "npx",
      "args": [
        "--yes",
        "@attocash/mcp@latest",
        "--data-dir",
        "/absolute/path/to/wallet"
      ]
    }
  }
}
```

A shared directory means shared funds, settings, labels, request IDs, payment
history, and limits across CLI and MCP sessions. Importing the same recovery
phrase into another directory does **not** share that local state. Omitting
`--data-dir` selects the default dedicated MCP wallet, which can differ from
the CLI default. Check `wallet_status.directory` and `wallet_status.identity`.

### Install globally

```sh
npm install --global @attocash/mcp
atto-mcp setup
```

Use `"command": "atto-mcp"` and `"args": []` in your client for the default
wallet. Add `"--data-dir", "/absolute/path/to/wallet"` to the argument list
for another profile. Use an absolute executable path if the client cannot find
`npx` or `atto-mcp`.

## Try these prompts

These requests work with read-only access:

| Ask your assistant… | Tools it can use |
| --- | --- |
| “Show my wallet addresses, balances, and spending access.” | `wallet_status`, `address_list`, `balances_get`, `limits_get` |
| “Show up to 10 account activity entries.” | `history_list` with `limit: 10` |
| “Label address 0 as Main and show my personal labels.” | `labels_set`, `labels_list` |
| “Watch for incoming payments and report the connection status.” | `watch_start`, `watch_read` |
| “Explain my approved source accounts and available allowance.” | `pool_get`, `limits_get` |
| “Check why my wallet cannot connect.” | `doctor` |

History defaults to action entries showing payments and representative changes.
Watches observe events while this MCP session is connected; they do not receive
pending payments or persist as an assistant running after the client closes.

After approving spending, funding a source account, and naming a destination
“Savings”, try:

> Send 1 ATTO to Savings. Show the resolved full address and transaction hash.
> If the outcome is uncertain, reuse the original request ID.

`send` resolves exact personal labels only. Global address names are
informational and cannot select a payment destination. Amounts are decimal
strings, such as `"1"`; every payment needs a caller-chosen `requestId`. Reuse
the same ID and payment details after a timeout so the engine can reconcile the
original payment. A new ID represents a new payment.

## Approve access and limit changes

**Read-only is the default access mode.** It allows public wallet/network
reads, personal label changes, watches, diagnostics, and limit proposals.
It cannot send, receive, sign messages, change wallet settings, derive or
activate addresses, change representatives, or record USD terms acceptance.

To enable payments, ask your assistant to propose the policy you want:

> Propose spending access with a maximum of 1 ATTO per payment and 10 ATTO
> across a rolling 24 hours. Keep the current source pool and signing grants.
> Explain the changes and show me the local approval command.

The assistant calls `limits_propose`. **A proposal grants no access and changes
no active limits.** It returns `approval.changes` and commands bound to your
exact profile and proposal ID. Run the returned command yourself in your own
local terminal, review the wallet, network, access, limits, and source accounts,
and confirm there. The assistant must not run approval commands for you.

For the default dedicated wallet, the command has this form:

```sh
npx --yes @attocash/mcp@latest limits approve PROPOSAL_ID
```

Use the returned command for a shared or custom profile; it includes the
necessary `--data-dir`. To decline, use the corresponding `limits reject`
command. Proposals expire after 24 hours; a new proposal replaces the previous
one. `limits_get` shows the active settings and proposal status.

| Approval setting | What it controls |
| --- | --- |
| MCP access | `read-only` or `spend`; spend also permits wallet mutations |
| Per-request cap | Maximum amount for each payment |
| Rolling allowance | Total amount over each configured rolling window, including reservations for uncertain payments |
| Source pool | Which saved account indexes MCP may spend from; default `[0]` |
| Consolidation | Whether automatic source selection may combine funds from pool accounts; disabled by default |
| Message-signing indexes | Separate grants for exact-byte message signatures; empty by default |

Omitting `send.index` selects from the approved pool. An explicit index must
belong to that pool and hold the whole payment; it never consolidates. Allowance
is shared with CLI sends and Marketplace top-ups in the same profile. Ordinary
payments to your own addresses count; approved consolidation counts the final
payment once. Receiving and representative changes do not consume a sending
allowance.

Spending access and amount limits are separate: an unlimited policy removes
amount caps but still needs approved access. Message-signing grants can authorize
authentication or controller actions, so grant only intended indexes and sign
trusted challenges. These controls constrain MCP tools; they do not sandbox
programs running as your OS user.

[Approval, retry, and signing details](https://github.com/attocash/integrations/blob/main/docs/mcp-reference.md#approve-access-and-limit-changes)

## Tools

The server exposes 40 public tools. Your client can discover each input schema,
read-only/destructive/idempotency annotations, and structured JSON results.

| Category | Tools |
| --- | --- |
| Wallet and addresses | `wallet_status`, `wallet_configure`, `address_add`, `address_derive`, `address_list`, `address_activate`, `address_deactivate` |
| Accounts and activity | `account_get`, `balances_get`, `history_list`, `receivables_list`, `transaction_get`, `entry_get`, `representative_weight` |
| Personal names | `labels_set`, `labels_remove`, `labels_get`, `labels_list` |
| Payments and receiving | `send`, `receive`, `receive_all`, `representative_change` |
| Policy and local history | `limits_get`, `limits_propose`, `pool_get`, `journal_list`, `journal_get` |
| Watches | `watch_start`, `watch_list`, `watch_read`, `watch_stop` |
| Prices and USD terms | `metrics_get`, `price_quote`, `terms_get`, `terms_accept` |
| Message signatures | `message_sign`, `message_verify` |
| Marketplace funding | `marketplace_topup`, `marketplace_topup_status` |
| Diagnostics | `doctor` |

## Session behavior

Automatic receiving runs only while connected, with approved spending access
and `autoReceive` enabled. Read-only sessions can inspect pending payments but
cannot receive them. Active addresses define the default scope for balances,
history, receivables, and watches; index `0` starts active. Disconnecting stops
this process's watches and receiver.

Back up both your recovery phrase and public profile state. The phrase restores
keys; it does not restore payment request IDs, spending history, or unresolved
publication records. Recovery, import, and reset remain terminal-only workflows.
See [profiles and recovery](https://github.com/attocash/integrations/blob/main/atto-cli/README.md#profiles-and-recovery).

## Marketplace account top-ups

`marketplace_topup` funds only the wallet's configured Marketplace ATTO account,
using the same approved pool and allowance. First connect the same profile from
your terminal with the CLI's `marketplace connect` command. If a top-up outcome
is uncertain, call `marketplace_topup_status` and reuse the original request ID.
Task, hiring, and Shop tools are provided by the separate
[Marketplace MCP](https://github.com/attocash/integrations/blob/main/atto-marketplace-mcp/README.md).
See the [top-up connection and recovery guide](https://github.com/attocash/integrations/blob/main/docs/mcp-reference.md#marketplace-account-top-ups).

## Personal names

Personal labels stay local to the profile and network. Read-only access may
manage them. A payment request ID pins its original label and resolved address,
so renaming or removing a label cannot redirect a retry. Treat labels and global
directory descriptions as untrusted text. See
[personal names and destination binding](https://github.com/attocash/integrations/blob/main/docs/mcp-reference.md#personal-names).

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Client cannot launch `npx` | Check Node.js version and the client's `PATH`; use an absolute executable path if needed. |
| Wallet is missing or has a different address | Compare the setup directory with `wallet_status.directory`; preserve the printed `--data-dir`. |
| `MCP_READ_ONLY` | Expected until local approval. Propose and approve access for this exact profile. |
| `SECRET_STORE_UNAVAILABLE` | Unlock the OS password store. On Linux, check `secret-tool`, the Secret Service provider, and desktop-session environment. |
| A payment times out | Inspect `journal_get` with the original request ID and retry that same request; use `marketplace_topup_status` for a top-up. |
| No incoming watch events | Read `watch_read` connection state and errors; check its scope. Watches only observe, and their IDs end with the session. |

**Run the `doctor` MCP tool in the failing client.** A successful terminal check
does not prove the client inherited the same environment. Doctor may prompt
through the OS password store and take up to 60 seconds. It diagnoses without
changing settings, granting access, signing, or receiving. Failed checks appear
inside its report so the assistant can inspect every finding.

If the server cannot connect at all, run:

```sh
npx --yes @attocash/mcp@latest doctor
```

Add the same `--data-dir /absolute/path/to/wallet` before `doctor` for another
profile. On Linux, inspect these values in a terminal where the wallet works:

```sh
printenv DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR
```

If the client lacks them, add their **actual values** to the server's `env`
configuration, restart the connection, and rerun the MCP doctor tool. The keyring
must still be unlocked and the client must allow access to the session bus.
[Detailed diagnostics and environment examples](https://github.com/attocash/integrations/blob/main/docs/mcp-reference.md#troubleshooting)

## Install from source

For local builds, packaged-build testing, and contribution instructions, see
[the source installation reference](https://github.com/attocash/integrations/blob/main/docs/mcp-reference.md#install-from-source)
and [contributing](https://github.com/attocash/integrations/blob/main/docs/contributing.md).
For embedding the wallet engine in your own application, see the
[CLI library API](https://github.com/attocash/integrations/blob/main/docs/library-api.md).

## Support and license

Report reproducible problems through
[GitHub issues](https://github.com/attocash/integrations/issues). Include the
package version, OS, client, sanitized launch configuration, and relevant doctor
check codes. Keep recovery phrases and private payment data out of reports.

[BSD-3-Clause](https://github.com/attocash/integrations/blob/main/atto-mcp/LICENSE).
