# Atto Marketplace Nano adapter

`@attocash/atto-marketplace-nano-adapter` is the private Node wallet engine used by Marketplace MCP.
It implements Nano Ed25519-Blake2b, state-block signing, confirmed chain checks,
controller proofs and durable payment recovery without a Java runtime.

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

Configure only Marketplace MCP in your client. Run `atto-marketplace-mcp wallet setup
--asset XNO --help` in your terminal for setup. Default grants deny spending and
headless controller proofs. Exact typed Marketplace actions use the same one-off
terminal consent as Atto; this does not widen headless signing permissions. Marketplace funding and external transfers have separate
grants and share exact atomic limits and a durable journal. Setup and approval
are terminal-only. Keys and signed funding payloads remain private.

Identity, balance and receivable reads use the pinned public configuration without
unlocking signing keys. Signing, provisioning and explicit key inspection still
verify the original key. Configuration status does not prove RPC or key-store
availability. Receiving requires an approved funding or external-transfer write
grant and does not consume the outgoing amount budget.

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

Profile directories must be owner-only. Protect the recovery source (or imported
seed file) and the entire journal together; restoring an old journal can lose knowledge of signatures
already issued. Fence writes and reconcile against the native chain before
resuming after a restore. Never use the same source key with independent journals.

The single current `wallet.json` schema has `version: 1`, a chain `rpcUrl`, an
optional separate `workUrl`, and an explicit
`keySource`: `shared-recovery` pins its original recovery source and SLIP-0010
version; `native-seed` references an explicitly imported existing seed file and
its native Blake2b derivation. Old flat configuration shapes are rejected.
Provisioning never silently creates a separate native seed. Key inspection,
provisioning, policy approval and key callbacks consistently return Promises;
public metadata loading and signature verification stay synchronous.

The exported adapter API is for trusted local code. No raw signing operation is
exposed through public MCP tools. See the Marketplace MCP README for configuration,
exact request-id retry rules and explicit Atto wallet-profile reuse.

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
