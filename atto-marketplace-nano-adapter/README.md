# Atto Marketplace Nano adapter

**The local Nano wallet engine inside Atto Marketplace MCP.**

`@attocash/atto-marketplace-nano-adapter` signs Nano state blocks, verifies
confirmed chain evidence, and preserves payment attempts for recovery. It runs
in Node.js without a Java runtime and keeps signing keys local.

This is a **private workspace bundled into
[`@attocash/marketplace-mcp`](https://www.npmjs.com/package/@attocash/marketplace-mcp)**.
Install and configure Marketplace MCP to use it. The adapter has no standalone
executable or separate npm installation.

[Use it](#use-through-marketplace-mcp) · [Keys and storage](#keys-and-storage) ·
[Recovery](#payment-recovery) · [RPC requirements](#rpc-and-work-providers) ·
[Development](#develop-and-package)

## Use through Marketplace MCP

Requires **Node.js 24.15.0 or newer** and **Linux or macOS** for private wallet
storage. In your own interactive terminal:

```sh
npm install --global @attocash/marketplace-mcp
atto-marketplace-mcp wallet setup --asset XNO --help
```

Follow the [Marketplace MCP setup guide](https://github.com/attocash/integrations/blob/main/atto-marketplace-mcp/README.md)
to select a wallet and connect your client. Configure the Marketplace MCP server
in your client; the adapter runs inside it.

## Protocol and account binding

Nano x402 v2 uses asset `XNO`, network `nano:mainnet` (or `nano:dev`), and
`payload.block` containing the native signed state block and its matching
`link_as_account`. Base offers need no `extra` fields or extensions. The wallet
generates and validates its own work, including when `extra.workOptional` allows
the facilitator to generate work instead.

Marketplace offers the `marketplace-account-binding` extension to bind its
account, intent, payment identifier and intent expiry to the exact challenge
bytes and native block hash. The wallet preserves the offered schema and info,
then adds `info.bindingSignature`; this authorization stays outside the native
payload. `maxTimeoutSeconds` bounds confirmation polling and does not expire a
native Nano block. Local handoff deadlines follow the Marketplace intent expiry.
Expired or uncertain signed candidates keep their original bytes and journal
reservation until native evidence resolves them.

## Permissions

Default grants deny spending and headless controller proofs. Exact typed
Marketplace actions use the same one-off terminal consent as Atto; this does not
widen headless signing permissions. Marketplace funding and external transfers
have separate grants and share exact atomic limits and a durable journal. Setup
and approval are terminal-only. Keys and signed funding payloads remain private.

Identity, balance and receivable reads use the pinned public configuration without
unlocking signing keys. Signing, provisioning and explicit key inspection still
verify the original key. Configuration status does not prove RPC or key-store
availability. Receiving requires an approved funding or external-transfer write
grant and does not consume the outgoing amount budget.

## Keys and storage

New Marketplace Nano wallets derive from the selected Atto wallet's OS-protected
24-word BIP39 recovery phrase using Ed25519 SLIP-0010 at `m/44'/165'/index'`.
The adapter pins its derivation version, original credential source, Atto root
address and expected Nano address. It never stores a second phrase or derived
private key. A missing or changed source fails closed. Existing native Nano seed
imports retain their original Blake2b seed/index derivation and addresses.

The original recovery source stores an immutable private account-to-directory
binding. Only that Nano directory can open the account's journal on its network;
second homes must reuse it. A copied configuration or missing/changed binding
fails before journal creation or native RPC. Provisioning retries may finish the
same original directory after interruption, without reclaiming another wallet's
binding. Back up this source-side metadata together with the Nano journal.

Wallet storage supports Linux, macOS, and Windows. Unix files use owner-only
permissions. Windows uses Node.js filesystem support and normal per-user directory
permissions. File identity, kind, link and symbolic-link checks protect publication
and recovery on every platform. New mnemonic custody uses Windows Credential
Manager through the shared Atto wallet engine. Use the same OS user for setup and
the MCP client; an explicitly imported existing seed file retains its existing
file-based import semantics.

Profile directories must be owner-only. Protect the recovery source (or imported
seed file) and the entire journal together; restoring an old journal can lose knowledge of signatures
already issued. Fence writes and reconcile against the native chain before
resuming after a restore. Never use the same source key with independent journals.

### Configuration and library boundary

The single current `wallet.json` schema has `version: 1`, a chain `rpcUrl`, an
optional separate `workUrl`, and an explicit
`keySource`: `shared-recovery` pins its original recovery source and SLIP-0010
version; `native-seed` references an explicitly imported existing seed file and
its native Blake2b derivation. Old flat configuration shapes are rejected.
Provisioning never silently creates a separate native seed. Key inspection,
provisioning, policy approval and key callbacks consistently return Promises;
public metadata loading and signature verification stay synchronous.

The exported adapter API is for trusted local code. No raw signing operation is
exposed through public MCP tools. See the
[Marketplace MCP reference](https://github.com/attocash/integrations/blob/main/docs/marketplace-mcp-reference.md)
for configuration, exact request-id retry rules, and explicit Atto wallet-profile
reuse.

## Payment recovery

Recovery keeps each native candidate's signed bytes and original operation
identity in `nano-wallet.sqlite3`. `payment.status` reconciles an existing handoff
and `transfer.status` reconciles an existing external-transfer request; neither
creates or publishes a replacement payment. Retry `payment.prepare`,
`transfer.send`, or `receive` with the original handle, request ID or incoming SEND
hash to resume that operation. Receive retries preserve the original RECEIVE/OPEN
candidate. Uncertain candidates keep the account lane and outgoing reservation,
including beyond 24 hours; only confirmed spending ages out of the rolling
window. Native chain evidence must resolve a signed candidate before a new
operation can use that lane.

## RPC and work providers

The configured chain RPC must expose pinned `version` evidence, `account_info`,
`block_info`, `blocks_info` with its `pending` option, `receivable` and `process`.
`work_generate` uses `workUrl` when supplied, otherwise `rpcUrl`. Only the work
root and required difficulty are sent to that endpoint. The adapter validates
returned work locally; signing keys remain local. Work calls have a 90-second
timeout and an explicit provider failure does not fall back to another endpoint.
A mainnet gateway that omits `version.network_identifier` must return the
canonical genesis OPEN block: its native hash and signature are verified locally.
A present incorrect identifier still rejects the gateway. Both URLs require
HTTPS or loopback HTTP, without embedded credentials or a fragment. Omitting `workUrl` preserves the single-endpoint behavior and existing
profiles are not rewritten by setup defaults.

Exact receipt checks use one-hash `blocks_info` pending evidence,
plus independently verified confirmed SEND and predecessor balances; a truncated
account receivables list cannot establish absence. Missing pending evidence fails
closed. Receipt listing remains separately bounded to 1–100 results.

## Develop and package

From the integrations repository root, after `npm ci`:

```sh
npm run check
npm test --workspace @attocash/atto-marketplace-nano-adapter
```

`npm run check` builds the CLI recovery-source library and Nano adapter before
checking the workspace types. To create installable artifacts, run `npm run pack`
at the repository root. Its staging script embeds this adapter and its README
inside the Marketplace MCP artifact and places its external dependencies on the
containing package. There is no separate Nano adapter tarball or executable.

See the [contributor guide](https://github.com/attocash/integrations/blob/main/docs/contributing.md)
for workspace builds and packaging. Report issues in
[attocash/integrations](https://github.com/attocash/integrations/issues).
Licensed under [BSD-3-Clause](https://github.com/attocash/integrations/blob/main/LICENSE).
