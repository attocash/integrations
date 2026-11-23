# Marketplace Nano wallet adapter

Private local Nano wallet used by Marketplace MCP. It holds native key access, signs Marketplace payments locally, and broadcasts standalone transfers locally, with configured source/index/network/RPC, approved spending access, durable signed state blocks and exact-candidate recovery. The Marketplace backend receives no customer key material. For x402 it relays only the complete unchanged payment that this wallet authorized.

Spending caps are either finite raw strings or explicitly paired nulls: `{maxPaymentAtomic:null,rolling24hAtomic:null}` means Unlimited spending. Unlimited can spend the available balance, including future deposits. Zero still blocks payments, and missing, malformed or mixed-null caps are rejected. Unlimited skips only ceiling comparisons: it retains the external-transfer grant, balance checks, durable spend history, reservations, source-account lane, exact-request replay checks and policy revalidation before signing. Tightening a later policy counts transfers recorded while Unlimited was approved.

Marketplace payments use the existing `externalTransfers` grant. A separately configured controller directory can authorize identity operations using NOMS.

The adapter retains OS-protected shared BIP39 recovery with versioned Nano SLIP-0010 derivation or explicit native seed imports, immutable source/journal ownership, user-only permissions, trusted network/genesis checks, local signature/work validation, unknown-source fencing and byte-identical publication retries. Source, RPC and work-provider changes must preserve original journals. Never create a replacement SEND merely because a response timed out.

`transfer.send` / `transfer.status`, native identity/balance, receivables/receive and NOMS controller proofs are reached through the typed private wallet host. Shared Marketplace requirements are independently verified by backend status; local wallet state alone never creates entitlement or marks a milestone paid. See [Marketplace reference](../docs/marketplace-mcp-reference.md). This package is an implementation dependency of the installed Marketplace client; HTTP consumers can use their own compatible local Nano/NOMS wallet.

Private `payment.prepare` and `payment.status` operations share the native transfer journal, account lane and spending allowance. Preparation atomically saves the signed state SEND, its work and the x402 header. Market submits the block. Status recognizes a confirmed SEND independently of recipient RECEIVE.

The supported x402 profile is the unmerged Nano proposal3432 at `96f65c29`: exact XNO signed state SEND, string raw balance, destination link plus `link_as_account`, and wallet-supplied valid work. The x402 header carries the required payment identifier. An uncertain result can be retried with its original signed bytes.
