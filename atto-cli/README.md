# Atto CLI

Create an Atto wallet, send payments, and receive funds from your terminal.
Name your addresses, follow activity live, or use JSON output in scripts.

**Beta** · [`@attocash/cli` on npm](https://www.npmjs.com/package/@attocash/cli) ·
macOS, Linux, and Windows

[Install](#install) · [Set up a wallet](#set-up-the-wallet) ·
[Everyday examples](#everyday-examples) · [Automation](#use-the-cli) ·
[Recovery](#profiles-and-recovery) ·
[Full reference](https://github.com/attocash/integrations/blob/main/docs/cli-reference.md)

## Install

Requires **Node.js 24.15.0 or newer** and an accessible OS password store:

| OS | Password-store prerequisite |
| --- | --- |
| macOS | Keychain access for the CLI |
| Linux | `secret-tool` (usually `libsecret-tools`), an unlocked Secret Service provider such as GNOME Keyring or KWallet, and access to its D-Bus session |
| Windows | Credential Manager access for the CLI |

```sh
npm install --global @attocash/cli
atto --help
```

Or run without a global installation:

```sh
npx --yes @attocash/cli@latest --help
```

The executable is `atto`. There is no plaintext recovery-phrase fallback when
the password store is unavailable. Headless Linux environments need a working
Secret Service session too; check it with `atto doctor`.

## Set up the wallet

Run this in your own interactive terminal:

```sh
atto wallet create
```

Creation stores the recovery phrase in your OS password store before displaying
it. **Keep a private offline copy.** To restore an existing phrase, use
`atto wallet import` instead; it asks through a hidden prompt. Creation, import,
and `atto wallet backup` require a terminal and never accept recovery words as
command arguments, JSON, or environment variables.

Find your receiving address and check the wallet:

```sh
atto address list
atto wallet status
atto balances
```

The default network is **LIVE**. Send funds to your listed address from another
wallet, and keep this command running to receive incoming payments:

```sh
atto wallet receive
```

It reports pending payments and confirmed receives. Stop it with Ctrl+C.
Finite commands such as `balances` exit after their operation; they do not keep
receiving in the background.

## Everyday examples

### Send to a personal name

With a funded account 0, create a second receiving address, name it, and send
1 ATTO to it:

```sh
atto address activate 1
atto labels set 1 "Savings"
atto send --to-label "Savings" --amount 1 --request-id savings-001
```

`--to-label` matches a personal name exactly, ignoring case. The CLI shows the
full destination and request ID before network work. To pay an external address,
replace `RECIPIENT_ADDRESS` with its full Atto address:

```sh
atto send RECIPIENT_ADDRESS 1.25 --request-id invoice-42
```

Amounts are exact decimal strings; the default unit is `ATTO`. `--unit RAW`
selects raw units. The source defaults to account 0; `--index 1` selects another
saved account. The source must hold the full amount unless you explicitly use
an approved [account pool](https://github.com/attocash/integrations/blob/main/docs/cli-reference.md#use-the-cli).

### Check payments and activity

| Task | Command |
| --- | --- |
| Recent payment activity | `atto history --limit 10` |
| Pending incoming payments | `atto receivables --limit 10` |
| Observe incoming payment events | `atto watch receivable` |
| Receive a batch for account 0 | `atto receive-all --index 0` |
| All saved address balances | `atto balances --all` |
| Saved payment attempts | `atto journal list --limit 10` |

`watch` observes events; it does not receive funds. Use `wallet receive` for
continuous receiving across active addresses.

### Resume an interrupted payment

Keep the original payment details and request ID:

```sh
atto journal show invoice-42
atto send RECIPIENT_ADDRESS 1.25 --request-id invoice-42
```

The original ID checks the recorded payment and resumes its existing progress.
An uncertain publication reuses the exact signed transaction. Conflicting reuse
is rejected. **A new request ID means a new payment.** If you omit
`--request-id`, the CLI generates one and prints it before starting; retain it.

## Use the CLI

Inspect commands and options locally:

```sh
atto --help
atto send --help
atto wallet --help
```

Readable text is the default, including when piped. For automation, pass `--json`:

```sh
atto --json balances
atto --json history --limit 10
atto --json send RECIPIENT_ADDRESS 1.25 --request-id invoice-42
```

Single commands write one compact `{"result": ...}` envelope to stdout.
Failures use `{"error":{"code":"...","message":"..."}}` and a nonzero exit
status. Large protocol integers remain strings. Send progress and retry messages
go to stderr as JSON lines; watch and receiving commands stream multiple result
lines. Doctor also returns a result envelope when a check fails, with exit status 1.

`atto send` retries temporary connection failures, timeouts, and HTTP 5xx errors
with delays up to 30 seconds until success or Ctrl+C. HTTP 4xx errors, including
429, and validation or policy errors stop the command. An in-flight request may
finish after Ctrl+C; inspect the journal and reuse its ID before paying again.
Automation should retain request IDs and account for potentially long retries.

For schema-based integrations, use `atto operations`, `atto operations send`,
and `atto --json call account_get --input '{"index":0}'`. Generic `call send`
requires a request ID and does not automatically retry. See the
[command and JSON reference](https://github.com/attocash/integrations/blob/main/docs/cli-reference.md#use-the-cli)
and [wallet engine API](https://github.com/attocash/integrations/blob/main/docs/library-api.md).

## Diagnostics

Run diagnostics in the environment where the failure occurs:

```sh
atto doctor
atto --json doctor
atto --data-dir /absolute/path/to/profile doctor
```

Allow up to 60 seconds. Doctor checks the runtime, profile, password-store
credential, node, worker, and wallet readiness. It may request password-store
access and public network data; it does not sign, publish, or repair the wallet.

| Symptom | Next step |
| --- | --- |
| `atto` is not found | Check `node --version` and `npm --version`; ensure npm's global executable directory is on `PATH`, or use the `npx` form above. |
| `SECRET_STORE_UNAVAILABLE` | Unlock the OS password store and rerun doctor. On Linux, check `secret-tool` and access to the correct D-Bus session. |
| `WALLET_CREDENTIAL_MISSING` | Verify the selected profile and credential access. Preserve the profile and pending payments; do not reset it to fix password-store access. |
| A payment times out or is interrupted | Inspect `atto journal show REQUEST_ID`; retry with the original ID and details. |
| `SPENDING_LIMIT` or `POOL_BUSY` | Check `atto limits status`, `atto pool status`, and unfinished payments before retrying. |
| CLI works but MCP fails | Run the MCP `doctor` tool; the server may have a different profile or launch environment. |

[Full diagnostic behavior and remediation](https://github.com/attocash/integrations/blob/main/docs/cli-reference.md#diagnostics).

## Spending limits and MCP access

CLI spending starts **without an amount cap**. Set shared limits in your own
terminal; changes require interactive review and confirmation:

```sh
atto limits set --per-payment 1 --daily 10
atto limits status
```

This caps each payment at 1 ATTO and total spending at 10 ATTO over a rolling
24 hours. Limits aggregate CLI and MCP sends across this profile's accounts;
uncertain payments keep their allowance reserved. They do not cover payments
made through other wallet applications.

The optional [`@attocash/mcp`](https://www.npmjs.com/package/@attocash/mcp)
companion starts read-only. Its
[setup guide](https://github.com/attocash/integrations/blob/main/atto-mcp/README.md#install-and-connect)
lets you choose a dedicated wallet or share the CLI wallet. Sharing requires the
**same absolute `--data-dir`** in both interfaces. To allow bounded MCP spending,
review this in your own terminal with that directory:

```sh
atto --data-dir /absolute/path/to/profile limits set --access spend --per-payment 1 --daily 10
```

MCP may propose changes; only local terminal approval applies them. `limits set`
preserves the existing access mode unless you change it. `limits clear` preserves
access too, so clearing caps on a wallet with MCP spending enabled allows
unlimited sends. Message signing requires separate approved indexes. These
controls govern this wallet's tools; programs running as the same OS user can
access the OS password store subject to its permissions.

[Policies, proposals, account pools, and signing grants](https://github.com/attocash/integrations/blob/main/docs/cli-reference.md#spending-limits-and-mcp-access).

## Address labels and personal-name payments

Personal names belong to a profile and network. They can label saved wallet
indexes or external addresses. `atto labels list` lists your names;
`atto labels set RECIPIENT_ADDRESS "Family"` saves an external recipient.
Public directory names are informational; `--to-label` resolves personal names only.
A saved request ID pins its destination even if you later rename or remove a label.

[Label commands and destination binding](https://github.com/attocash/integrations/blob/main/docs/cli-reference.md#address-labels-and-personal-name-payments).

## Wallet details and configuration

`atto wallet status` shows the selected profile, network, and endpoints.
`atto address add` saves and activates the next account; `address derive N` saves
an inactive address. Active accounts appear in default balances and receiving.
Changing networks requires matching node, worker, and representative settings.

See [wallet configuration](https://github.com/attocash/integrations/blob/main/docs/cli-reference.md#wallet-details-and-configuration)
for account management, endpoints, and reset behavior.

### Fund a Marketplace account

Connect the wallet locally, then fund the configured Marketplace account using
shared spending limits and a durable request ID. See
[Marketplace connection and top-ups](https://github.com/attocash/integrations/blob/main/docs/cli-reference.md#fund-a-marketplace-account).

### Review a Marketplace wallet approval

Review Marketplace's exact request file and typed challenge in your own terminal.
See [local proof approvals](https://github.com/attocash/integrations/blob/main/docs/cli-reference.md#review-a-marketplace-wallet-approval)
for origin checks, file requirements, and native Windows limitations.

## Profiles and recovery

The recovery phrase stays in the OS password store. The profile directory holds
public state, settings, personal names, payment journals, request IDs, and pending
payment records. **Back up both your recovery phrase and the complete profile.**
Stop wallet processes before copying the profile; include `profile.json` when present.

Use `atto wallet status` to find the actual directory. Fresh CLI installations use
`~/.local/share/atto-cli` on Linux (or `$XDG_DATA_HOME/atto-cli`),
`~/Library/Application Support/Atto CLI` on macOS, and `%LOCALAPPDATA%/Atto CLI`
on Windows. Existing installations may retain a legacy directory.

Keep the same absolute path when restoring where possible: the path selects the
credential account. Importing the same phrase into separate profiles does not
share locks, spending limits, or request IDs, and concurrent payments may conflict.
A recovery phrase alone does not restore the journal or pending payment records.
Preserve those records and follow the
[recovery and profile reference](https://github.com/attocash/integrations/blob/main/docs/cli-reference.md#profiles-and-recovery)
before resuming payments. `wallet reset` deletes local wallet state and its stored
phrase; it is not a password-store repair command.

## Background receiving and work preparation

```sh
atto wallet receive --background
atto wallet receive status
atto wallet receive stop
```

The detached receiver uses the same profile and password store. It does not
restart after reboot; inspect its status for credential or connection errors.
After account changes, a short detached worker may prepare public proof-of-work
for later payments. See [background behavior](https://github.com/attocash/integrations/blob/main/docs/cli-reference.md#background-receiving-and-work-preparation).

## Update notices

Update a global installation with `npm install --global @attocash/cli@latest`.
If you also use MCP, update the matching CLI/MCP pair and restart the MCP server.
Interactive commands may show a newer-version notice on stderr; updates are
manual. Use `--no-update-notifier` or `NO_UPDATE_NOTIFIER` to disable checks.
Checks are also disabled for JSON output, redirected output, and CI.
[Update behavior and cache locations](https://github.com/attocash/integrations/blob/main/docs/cli-reference.md#update-notices).

## Install from source

See the [source build instructions](https://github.com/attocash/integrations/blob/main/docs/cli-reference.md#install-from-source)
and [contributor guide](https://github.com/attocash/integrations/blob/main/docs/contributing.md).
For help or bugs, [open a GitHub issue](https://github.com/attocash/integrations/issues)
with your CLI version and sanitized diagnostics. Never include recovery words.
Licensed under [BSD-3-Clause](https://github.com/attocash/integrations/blob/main/atto-cli/LICENSE).
