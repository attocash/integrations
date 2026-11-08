# Atto Marketplace MCP

`@attocash/marketplace-mcp` provides the `atto-marketplace-mcp` executable.
Its npm package includes the Nano adapter; no separate adapter installation or
release is required.

Marketplace MCP is currently unreleased. Build it from this checkout and use the
staged package for local installation. Requires Node.js **24.15.0 or newer**.

Atto Marketplace MCP is a separate local stdio server for named buyer and worker
operations. Human users keep using the Marketplace browser workspace. A private
Node wallet host uses the existing Atto CLI wallet engine and a Node Nano adapter
to sign approved native transactions and controller proofs without exposing keys
to the agent. Marketplace workflow tools remain in this separate MCP server.

Administrator operations are excluded from MCP, including administrator purchase
reads, receipt exports, product refunds, and dispute resolution. This applies
even when the selected controller session has administrator authority. Use the
Marketplace browser workspace for administrator operations. Seller refunds,
buyer and seller receipt verification, and participant disputes remain available
through their named account tools.

The server reads one explicitly selected private profile per process. Set
`MARKETPLACE_MCP_PROFILE` to a profile ID created with `atto-marketplace-mcp setup` and
`MARKETPLACE_MCP_HOME` only when selecting a private configuration directory. File
tools also require an explicit absolute `--files-dir` or
`MARKETPLACE_MCP_FILES_DIR`; there is no default. Only the named submission-file
and product-file tools accept source or destination paths, and those paths must
stay beneath that configured directory. Other tool arguments cannot select a
filesystem path, API origin, credential, or arbitrary route. Profiles pin the Marketplace
origin and account, choose exactly one auth mode, and use 0700/0600 permissions
on POSIX systems. Marketplace MCP and its Nano wallet storage currently support
Linux and macOS; native Windows is unsupported and profile access fails closed.
The separate Atto CLI and Atto MCP support Windows, including Credential Manager
custody. Windows CI still verifies those packages and Marketplace's portable
cryptography, API contracts, and installed package layout.

From the integrations repository root:

```sh
npm ci
npm run check
npm test --workspace @attocash/marketplace-mcp
npm run build --workspace @attocash/marketplace-mcp
```

For local installation, build and install the CLI and Marketplace artifacts
together so the exact CLI dependency resolves to this checkout:

```sh
npm run pack
npm install --global ./attocash-cli-0.0.0.tgz ./attocash-marketplace-mcp-0.1.0.tgz
```

The pack script embeds the Nano adapter; no separate adapter installation is
needed. Packing the source workspace directly is unsupported. See the
[contributor guide](../docs/contributing.md#packaging) for package verification
and release-version filenames.

## Connect a local agent

Run the installed executable in your own interactive terminal:

```sh
atto-marketplace-mcp setup
```

From a built source checkout, run `node atto-marketplace-mcp/dist/main.js setup`
from the integrations repository root. For local development, first start the
stack in the sibling Marketplace repository's
[local guide](../../marketplace/dev/local/README.md).

The guided setup asks for your private Marketplace configuration directory,
profile name, exact Marketplace origin, and Agent API audience supplied by the
Marketplace operator. It then lets you:

- Create a dedicated Atto wallet or select your existing Atto CLI wallet at its
  default or custom directory. Select the exact original CLI `--data-dir` to
  share its keys, settings, approved limits, spending journal and coordination.
  Do not copy its seed into another profile to share a wallet.
- Optionally derive a Nano wallet from the same recovery phrase, reuse its existing
  adapter profile, or import a private Nano seed file. New Nano wallets reference
  the selected Atto CLI wallet or a dedicated recovery wallet in the OS password
  store. They never write a second phrase or Nano seed file. Review
  the public address, network, RPC, controller permissions and spending ceilings
  locally. Guided ceilings use human XNO amounts with up to 30 decimal places.
- Choose Atto or Nano as the Marketplace controller when both are configured.
  Review and approve the exact login challenge in the same local terminal for
  either controller, then setup saves the private controller session. Log in with the chosen address or explicitly link it to
  your existing Marketplace account; wallet selection does not link accounts.

New Marketplace wallet selections deny funding and external transfers by default;
approve each grant separately if needed. Login, payout changes, withdrawals and
credential changes use one-off typed terminal approvals for either controller.
These approvals do not grant generic message signing or native spending.
The optional Nano wallet has its own public native address for receiving Nano
and sending to external addresses. External sends require the separately
approved external-transfer grant. Funding and external sends share the same
per-payment and rolling 24-hour ceilings and journal. Discover pending incoming
payments with `wallet_receivables`, then pass a returned hash to `wallet_receive`
with the same asset and network to receive that confirmed SEND. Receiving requires
an approved funding or external-transfer write grant and does not consume the
outgoing amount budget. Atto also retains its existing CLI spend and source-pool
checks. Marketplace grants can only narrow that underlying authority.

Marketplace uses one current configuration contract. Its unreleased older profile
schemas and Nano configuration shapes are unsupported; create a fresh Marketplace
configuration when necessary and select the original native wallet directories.
Standalone Atto CLI/MCP configuration, keyring entries and payment journals stay
in their existing directories.

Setup saves selected wallet directories and the reviewed Atto account/purpose
grants in `<Marketplace home>/profiles.sqlite`
and prints an MCP client configuration containing public paths and the profile
name, without tokens, seeds or other secrets. Copy its `mcpServers` configuration
into your client. It uses the exact Node executable and installed entrypoint,
so local-prefix installations do not depend on your client's `PATH`. Keep its `--home`,
`--profile` and wallet path selections together. File tools additionally require
the private directory described below.

To prefill the guided connection questions, use
`atto-marketplace-mcp setup --interactive --home /absolute/private/home --profile local-agent --origin http://localhost:8080 --audience urn:marketplace:agent-api:local`.
Bare `atto-marketplace-mcp wallet setup` (or `wallet setup --interactive`)
opens the wallet-only asset chooser and saves the selected directory pointers;
it does not authenticate a Marketplace account.

If a controller session expires or its refresh outcome becomes unknown, reconnect
in the same configuration home and profile:

```sh
atto-marketplace-mcp setup --home /absolute/private/home --profile local-agent --reauthenticate
```

This signs a fresh login proof for the saved account and controller, replaces only
session credentials, and preserves payment journals and wallet selections. The
guided setup also offers reconnection for an unusable existing session. After an
uncertain login acknowledgement, run `--reauthenticate` again for a fresh proof;
use `--complete` for a safely retryable pending login. Scoped API-key profiles keep
their separate credential workflow and cannot become controller sessions here.

### Advanced explicit setup

For a fully specified dedicated Atto wallet, use:

```sh
MARKETPLACE_MCP_HOME="$HOME/.config/atto/marketplace-mcp"
node atto-marketplace-mcp/dist/main.js wallet setup \
  --asset ATTO --home "$MARKETPLACE_MCP_HOME" --index 0 \
  --network atto:local --node-url http://localhost:18080 \
  --worker-url http://localhost:18877
```

Setup creates or reuses `<Marketplace home>/wallets/atto`, keeps its recovery phrase
in the OS password store, and requires terminal approval for bounded payments
and leaves generic message-signing grants unchanged. It returns only the public
address and index. This configures the wallet; log in with that address or
explicitly link it to your existing account. Wallet setup does not link keys
or authenticate a Marketplace account automatically. Review the separate funding
and external-transfer grants after the existing CLI spending-limit approval.
These Marketplace grants do not replace the CLI's permissions or limits.

To replace only those purpose grants later, use a local terminal:

```sh
atto-marketplace-mcp wallet policy --asset ATTO --home "$MARKETPLACE_MCP_HOME" \
  --allow-marketplace-funding
```

This permits Marketplace funding and denies external transfers. Omitting both
grant flags revokes both. Nano uses the same grant flags with `--asset XNO` and
requires its exact per-payment and rolling-24-hour ceilings when replacing policy.

Create a separate private Marketplace profile with that public address/index:

```sh
node atto-marketplace-mcp/dist/main.js setup --home "$MARKETPLACE_MCP_HOME" --profile local-agent \
  --origin http://localhost:8080 \
  --audience urn:marketplace:agent-api:local \
  --controller-address "$MARKETPLACE_CONTROLLER_ADDRESS" --controller-index 0 \
  --mode controller-session
```

Explicit controller-session setup prepares a durable typed login approval.
Run its printed `atto-marketplace-mcp approve` command in your local terminal,
then complete the same setup. Marketplace MCP verifies the exact controller
signature before submitting it and saving the session. Guided setup performs
these steps in the current terminal. Resume explicit setup with:

```sh
node atto-marketplace-mcp/dist/main.js setup --home "$MARKETPLACE_MCP_HOME" --profile local-agent --complete
```

A definite `SIGNER_UNAVAILABLE` (HTTP 503 `signer_unavailable`) or
`SIGNER_REQUEST_REJECTED` (HTTP 403 `signer_request_rejected`) response leaves
that same login setup retryable. Restore signer availability or inspect the
exact approval and signer configuration, then use `--complete` while the
challenge is valid. A missing response, malformed success, or lost tokens keeps
the setup unresolved; inspect it before starting a new profile. Normal MCP
operations also retain these two signer errors separately from authentication
failures, without exposing upstream diagnostics. For an uncertain financial
operation, preserve its original request ID and exact arguments.

Marketplace MCP owns controller approval, profile pinning and request recovery.
Both assets use the same terminal command and typed validation, including the
exact origin, audience, account, controller, purpose and action binding. Atto uses
the existing CLI wallet engine; Nano uses its Node adapter. Neither public MCP
surface exports keys or offers generic signing. Existing standalone Atto CLI
connections, message-signing grants, configuration and commands stay intact.

For advanced Nano provisioning with raw atomic ceilings, create a dedicated
profile in your own terminal:

```sh
atto-marketplace-mcp wallet setup --asset XNO --network nano:dev \
  --rpc-url http://localhost:45000 --origin http://localhost:8080 \
  --audience urn:marketplace:agent-api:local --recovery-wallet-dir /absolute/existing/atto-wallet \
  --allow-marketplace-funding --max-payment-atomic 1000000000000000000000000000000 \
  --rolling-24h-atomic 10000000000000000000000000000000
```

For `nano:mainnet`, new profiles default to `https://rpc.nano.to`; use
`--rpc-url` or the interactive RPC prompt to select another provider. New
`nano:dev` profiles default to `http://localhost:17076`. Reusing a profile keeps
its saved RPC and work URL when those options are omitted. Set `--work-url` or
answer the optional interactive work URL prompt to use a separate PoW provider.
Otherwise work uses the selected RPC. Only `work_generate` requests go to the
work provider; chain queries and broadcasting stay on the RPC. Returned work is
verified locally, and signing keys stay local. An explicit work provider failure
does not switch providers automatically. Work requests have a 90-second timeout;
Nano.to's public service has availability and usage limits. Select your mainnet
Marketplace origin for mainnet. Amounts
above are raw atomic units (one XNO is 10^30 raw). Setup shows every permission
and asks for terminal approval. New profiles deny funding, external transfers and
controller purposes unless explicitly selected. Add `--allow-external-transfers`
only when you want the agent to send to external Nano addresses. All outgoing
payments share the profile's limits and journal. New wallets derive Nano with
Ed25519 SLIP-0010 at `m/44'/165'/0'` from the same 24-word BIP39 phrase as Atto,
with an empty passphrase. `--index` chooses the final hardened index. The selected
wallet's existing Atto derivation and addresses stay unchanged. Nano configuration
pins the derivation version, credential source and expected addresses; a missing
or replaced credential fails closed. Nano-only setup can create this protected
recovery source offline without configuring Atto endpoints or enabling spending.

A derived Nano account on one network is bound to its original adapter directory.
Another Marketplace home must reuse that profile and journal; it cannot create
an independent journal for the same account. Setup reports the existing directory
when a duplicate is attempted. The immutable binding lives under the selected
recovery wallet and is checked before opening a Nano journal. Preserve it with
the original wallet directories when backing up or restoring.

Back up the recovery phrase through its existing protected terminal workflow,
and preserve both wallet directories and journals. Existing native Nano seeds
remain supported with `--seed-file`; their native derivation and addresses stay
unchanged. Never use the same account with independently coordinated journals.

For any protected Marketplace action, run the exact returned command in your
own terminal. Both Atto and Nano use the same command:

```sh
atto-marketplace-mcp approve /absolute/private/home/approvals/<profile>/<handoff-id>.request.json --home /absolute/private/home
```

Review the origin, account, controller, purpose and full action terms before
approving. Retry the original Marketplace tool with its identical request ID and
arguments. Public Nano signature verification uses only the address, exact message
and signature and never opens wallet configuration or secrets.

Explicit setup prints the same private approval request and terminal command for
login and scoped API-key provisioning with either controller. Approve it, then
resume setup with `--complete`. Guided setup performs these steps in the current
terminal. Marketplace MCP independently verifies the returned signature before
submitting the one-use proof. Repeating approval for the identical request recovers
its existing response without producing a new signature. No separate Atto CLI
Marketplace connection is needed.

Guided setup prints your selected stdio configuration. For an explicit source
checkout configuration, replace the absolute paths in this example:

```json
{
  "mcpServers": {
    "marketplace": {
      "command": "node",
      "args": ["/absolute/path/to/integrations/atto-marketplace-mcp/dist/main.js", "--home", "/home/user/.config/atto/marketplace-mcp", "--profile", "local-agent", "--files-dir", "/home/user/marketplace-agent-files"]
    }
  }
}
```

Create `/home/user/marketplace-agent-files` yourself as a real directory owned by
the MCP user, with POSIX mode `0700`, before enabling file tools, or set
`MARKETPLACE_MCP_FILES_DIR` to that absolute directory.
`marketplace_submission_file_upload` reads only a path you explicitly provide inside
it. It uploads one file and returns a READY `fileId`; it never attaches the
file automatically. Pass selected IDs explicitly in `marketplace_submission_add`
to include them in a submission. Use `marketplace_submission_file_download` with an
exact task, submission version, file ID, and new destination path to retrieve a
visible historical attachment. Downloads are checked against the immutable
submission size and SHA-256 before publication. Paths that escape the configured
directory, traverse symlinks, or name an existing destination are rejected.
Scoped credentials need `files:write` plus `submissions:write` to attach and
`files:read` plus `submissions:read` to download submitted files.

## Browse and publish Shop products

`marketplace_products_search` and `marketplace_product_get` read current public releases
without sending account credentials. The server still requires a selected local
profile to pin the Marketplace origin. These tools return the public summary,
seller profile, exact asset and price, license, immutable release hash, and file
names/sizes/types. They do not return paid Markdown, file bytes, storage URLs,
or buyer data.

Private seller tools require the selected account's `products:read` to list and
read drafts, `products:write` to create or edit drafts, and `products:publish`
to publish or unpublish. Publishing additionally requires `products:read` so the
MCP can inspect the current draft. A file-bearing draft also requires `files:write`
when created or edited; publishing that draft requires both `products:write` and
`files:write` as well as `products:publish`. Publishing requires an explicit
`confirmsDistributionRights: true` argument and the current draft version.
Each mutation uses a caller-supplied `requestId`; retry an uncertain request
with the same ID and exact arguments. Publishing creates an immutable release,
while unpublishing blocks new sales and retains the seller's release history.

Before a first publication reservation, use
`marketplace_product_publication_quote` with the current `expectedVersion`. The
quote is read-only and requires only `products:publish`; it returns the asset,
exact atomic amount, USD policy evidence, and whether a reservation already
exists. Pass `maxReservationAtomic` to `marketplace_product_publish` for a new hold.
Scoped keys that create new holds need `productPublishAttoLimit` and/or
`productPublishXnoLimit`; the requested maximum must fit the matching asset
ceiling. Existing held listings can still be published/updated or unpublished
without those new ceiling fields. Create those fields explicitly in a new
scoped grant with `--product-publish-atto-limit` and/or
`--product-publish-xno-limit`; `products:publish` alone does not grant a new
reservation.

Upload product files only through the named `marketplace_product_file_upload` tool
with an explicit source path under the configured private directory. Uploads
remain unattached until their returned `fileId` is included in
`marketplace_product_draft_create` or the complete ordered `fileIds` list for
`marketplace_product_draft_update`. Product downloads require
`marketplace_product_file_download` with the product, exact release sequence, file
ID, and a new destination path under the configured directory. The MCP client
checks file size and SHA-256 against that release before publishing bytes and
never overwrites an existing destination. Seller draft/release reads and file
access stay account-scoped; a file ID by itself grants no access.

### Buy and retrieve Shop content

Read the current public offer before calling `marketplace_product_purchase` with
its exact `productId`, `releaseId`, `expectedReleaseHash`, `asset`, `grossAtomic`,
and a stable `requestId`. A changed release or price requires a fresh review.
Controller sessions require a one-off typed terminal approval; scoped credentials
need `products:purchase` and the matching `purchaseAttoLimit` or `purchaseXnoLimit`
ceiling. Provision those ceilings with `--purchase-atto-limit` or
`--purchase-xno-limit`. Purchases spend the account's Marketplace balance.

Use `marketplace_purchases_list` and `marketplace_purchase_get` for account order
history, and `marketplace_product_orders_list` for seller-owned product orders.
Buyers retrieve paid Markdown and the immutable file manifest with
`marketplace_purchase_content_get`. Download a purchased file with
`marketplace_purchase_file_download`, using its purchase ID, file ID and a new
destination beneath `--files-dir`; size and SHA-256 are checked before writing.
Scoped buyer reads require `purchases:read`, with `files:read` for downloads;
seller order listing requires `products:read`.

`marketplace_purchase_receipt_get` with `kind: PURCHASE` or `REFUND` verifies the
signed receipt against the historical order and Marketplace's published key.
A seller can issue a full refund through `marketplace_product_refund`, providing
the current purchase version, original purchase receipt hash, exact asset and
gross amount, and a stable request ID. Controller sessions require typed terminal
approval; scoped keys need `purchases:read` and `purchases:refund`. Refunded orders
retain their receipts and lose access to paid content. Retry uncertain purchases
or refunds with their original request ID and unchanged terms.

## Credentials and local recovery

Run `node atto-marketplace-mcp/dist/main.js --help` for explicit scoped-key provisioning
and activation options. Use a different profile ID for a scoped credential;
changing from controller-session mode is never automatic. Funding tools require
an explicitly configured controller-session profile. Scoped API-key profiles
receive an actionable reconfiguration error; funding does not add authority to
those keys.

The MCP server never returns bearer credentials, proof signatures, native
payment payloads, or raw scoped API keys. It never upgrades from an API key to
a controller session after an authorization error. Controller approvals and
XNO payment handoffs use private typed files with opaque handles at the MCP
boundary. Configure `MARKETPLACE_MCP_PAYMENT_HANDOFF_DIR` or pass
`--payment-handoff-dir` to select a dedicated 0700 directory shared locally
with the private wallet host. The default is `<Marketplace home>/payment-handoffs`.
The two files are named
`<32-lowercase-hex-handle>.request.json` and `.response.json`; only the opaque
handle crosses MCP tool calls. The profile database and bearer credentials stay
outside this shared handoff directory. Setup configures the Nano adapter's
profile and handoff directory; override the directory only when needed. The
Marketplace process invokes the wallet host only for the exact private request
it created.
Before using either wallet, confirm it is configured for the same Marketplace
origin, account, and exact network shown by Marketplace MCP.

An in-flight controller-token refresh in another local MCP process is
transient: `REFRESH_BUSY` means this process sent no refresh request. Retry
after the other process finishes, or resolve a profile that remains busy from
the local terminal. `REAUTH_REQUIRED` means refresh is terminally unresolved,
such as an unknown or ambiguous token-rotation outcome; reauthenticate from
the local terminal before retrying. The client keeps that uncertain refresh
fence fail-closed and never clears it or sends another refresh automatically.

## Contract history

Use `marketplace_engagements_list({limit?, cursor?})` to list this account’s buyer and
worker contracts, including completed work. Scoped credentials require
`tasks:read`. The default page size is 25, with a maximum of 100. Pass the returned
`nextCursor` unchanged to continue; cursors are bound to the authenticated account.
Each item includes its role, state, counterparty display snapshot, frozen amounts,
and current version. Use `marketplace_engagement_get({taskId})` for the full agreement.
The API chooses the account from the configured credential and supports no role
or state filter. This private history stays available when the account changes
between buyer and worker roles.

`marketplace_application_messages_list` reads one private poster/applicant
conversation by `applicationId`, with `after` (default 0) and `limit` (default 50,
maximum 100). Its envelope returns `applicationId`, `taskId`, `canMessage`, and
ordered `messages`. Each message uses the existing task-activity row shape.
`marketplace_application_message_add` sends `{applicationId, text, requestId}`;
text supports Markdown, is trimmed to 1..2000 Unicode characters, and rejects
NUL. Only that application’s poster and applicant can read or write the thread.
New messages require a pending application on an OPEN task, or the hired
application on an ACTIVE engagement. Closed and unselected threads remain
readable. The selected conversation carries into the job’s activity feed after
hire. Scoped credentials use `activity:read` and `activity:write` respectively;
no application-read grant is needed to send a message.

Reuse the exact `requestId` and text after a lost response. The protected local
mutation journal retains the original request binding and retries the same
backend idempotency key; changing the text or application is rejected. An exact
successful replay still recovers the original result identity after closure.

Read `marketplace_engagement_get` before sending task feedback or accepting work.
`marketplace_activity_add` appends a `MESSAGE` or `STATUS_NOTE` only while the task
is `IN_PROGRESS` and its engagement is `ACTIVE`. Acceptance or dispute blocks new
ordinary activity, so send feedback first. An exact retry of an already successful
activity request still recovers its saved result after closure. Use
`marketplace_activity_list` to read earlier messages; scoped keys need
`activity:write` to append and `activity:read` to read.

## Public task history and receipts

Use `marketplace_tasks_history_search({limit?, cursor?, asset?, q?, agentId?, role?, state?})`
to search previously published terminal tasks anonymously. The default page size
is 24, with a maximum of 100. `state` may be `COMPLETED`, `REFUNDED`,
`CANCELLED`, or `EXPIRED`; omitting it includes all four. `agentId` is a public
agent UUID. An optional `role` of `BUYER` or `WORKER` requires `agentId`; without
a role, an agent filter matches either participant role. A role or agent filter
requires the agent profile to remain publicly visible. Cursors bind every
filter, so clear `cursor` and restart from the first page after changing any
filter. If a valid page exceeds the client response-size bound, retry that same
filter and cursor with `limit:1`, then continue using the returned cursor.

Each result contains the existing public task projection, a current visible
worker profile when one is available, and a receipt summary when Marketplace can
currently verify and publish it. No application, activity, submission,
reservation, or private account identifiers are included. Use
`marketplace_public_receipt_get({taskId})` to fetch and cryptographically verify the
immutable signed receipt without participant credentials. The public receipt is
available only while the published terminal task and both participant profiles
remain eligible and visible; otherwise Marketplace returns not-found. This proves a
recorded Marketplace outcome, not independent work quality. Participants can still
use `marketplace_receipt_get({taskId})` for their existing account-authorized read.

## Unified funding

Use `marketplace_fund({asset, amountAtomic, requestId, network?})` to create or
reuse one Marketplace funding intent, prepare its exact native payment, submit it,
and reconcile the status. ATTO and XNO are the supported native assets. Omit
`network` when the Marketplace profile has one configured route for that asset, or
pass the exact network to select a route. Reuse the same `requestId`, asset,
amount, and network after any uncertain response; an explicit network is part
of the durable request binding. Marketplace stores both the requested route and the
resolved intent network with its challenge, native payment binding, and
settlement status. `marketplace_funding_status({requestId})` checks the existing
journal and Marketplace intent and reports the bound network; it does not create a
replacement intent or payment. The tools return Marketplace status and account
ledger balances, never a native key or signed payment.

A confirmed native SEND produces Marketplace `ACCEPTED` and credits the account
once. A later linked RECEIVE produces `SETTLED` without another credit. Both
Marketplace states are successful; native receipt settlement can follow account
crediting. Recover the same request while either side remains uncertain.

The optional browser context fields `expectedMarketplaceOrigin` and
`expectedAccountId` are a pair: supply both to check the copied request against
the selected Marketplace profile, or omit both for an ordinary agent call. A lone
field or a pair that does not match the profile is rejected before funding
admission, API access, or wallet use. Context fields do not change the funding
request hash, so retries may include or omit the same matching pair while
keeping the original `requestId`, asset, amount, and network.

Funding journals belong to the profile ID that created them. If another profile
uses the same request ID for the same Marketplace origin, account and identity,
MCP identifies the original profile and stops before any new admission, signing,
or submission. Select that profile and call `marketplace_funding_status` with the
same `requestId`. Continue with `marketplace_fund` only with its identical asset,
amount, network and ID. Recovery never invents a replacement payment.

Marketplace has one funding API for both assets: `marketplace_fund` and
`marketplace_funding_status`. Native wallet preparation, submission and recovery
are internal to that flow. The standalone Atto CLI/MCP retains its independent
`marketplace_topup` interface.

Status responses label their sources. Funding status tools report fresh Marketplace
intent reads; intent creation and payment submission report their Marketplace POST
responses. These are separate from the fresh Marketplace account balance read and
from saved Marketplace MCP journal or external wallet observations. Local `ISSUED` or
`PREPARED` metadata does not override a current Marketplace `ACCEPTED` or `SETTLED`
result. Both assets expose `nativePayment: {state, hash, failureReason}` with
`PENDING`, `SETTLED`, or `REJECTED` native states and a nullable native SEND hash.
An unprepared or uncertain payment remains `PENDING`; Marketplace ledger status
is reported separately. Unknown wallet or Marketplace outcomes remain unresolved; status recovery
never recommends an unverified replacement payment.

Payout address changes and withdrawal creation accept an optional `network`; when
supplied, it must match the destination route and appears in the exact typed
approval. Existing calls without a network remain valid where the Marketplace
configuration provides one route.

Controller sessions inspect payout destinations with
`marketplace_payout_addresses_list` and the current selection version and cooldown
with `marketplace_payout_selection_get`. Use that exact selection version and
destination in `marketplace_withdrawal_create`, then approve its typed request
locally. `marketplace_withdrawals_list` and `marketplace_withdrawal_get` retain the
original `requestId` and a nullable `nativeSend`: it is `null` before a saved
candidate, then contains `transactionId`, `hash`, and a `CANDIDATE`, `CONFIRMED`, or
`REJECTED` state. A confirmed outgoing SEND can settle the withdrawal; receiving
those funds at the destination is a separate native operation. Retry an uncertain
creation with its original request ID and terms.

ATTO uses the existing CLI wallet engine in the private Node host. Its bounded
payment methods require Marketplace's pinned `/v1/agent/topups` URL and configured
audience. Existing public Atto CLI and MCP interfaces keep their current behavior.

Native wallets are private adapters in the same Node host; no Java runtime,
standalone Nano MCP, or payer executable is required. The default wallet homes are
`<Marketplace home>/wallets/atto` and `<Marketplace home>/wallets/nano`.
`MARKETPLACE_MCP_NANO_WALLET_DATA_DIR` explicitly selects another private Nano
profile. By default it supplies both the controller and spending identity.
`MARKETPLACE_MCP_NANO_CONTROLLER_DATA_DIR` can explicitly select a separate Nano
controller profile for typed account approvals; funding and native transfers still
use the primary wallet. Give separate keys their own profiles and preserve each
profile's original journal. To reuse an existing Atto CLI/MCP wallet, set
`MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR` to its exact absolute `--data-dir`.
This preserves its credentials, permissions, limits, journal and coordination;
it does not copy or migrate the profile. Marketplace profiles and credentials
stay in Marketplace's separate home. Existing `atto` and `atto-mcp` configuration
and public tools are unchanged.

The public wallet tools operate on the account selected during setup, independently
of Marketplace's custodial balances. Atto uses the reviewed account index from
Marketplace's private preferences; Nano uses its primary adapter profile's index.
Individual calls cannot choose another index or spend through a separate login
controller. Atto funding also binds that selected account while preserving its
original CLI pool approval, limits and journal. All public balances and amounts
use exact atomic decimal strings.

| Tool | Common response for either asset |
| --- | --- |
| `wallet_status` | `asset`, `network`, `address`, `index`, `permissions` |
| `wallet_balance` | Selected identity plus `balanceAtomic` |
| `wallet_transfer`, `wallet_transfer_status` | `asset`, `network`, `index`, `sourceAddress`, `destination`, `amountAtomic`, `requestId`, `state`, nullable SEND `hash` |
| `wallet_receivables` | Selected identity plus `items: [{hash, sourceAddress, amountAtomic}]` and `incomplete` |
| `wallet_receive` | Selected identity plus incoming `sendHash`, RECEIVE/OPEN candidate `hash`, `amountAtomic`, and `state` |

`permissions` reports effective `marketplaceFunding`, `externalTransfers`, and
`receive` grants. Native operation states are `PENDING`, `SETTLED`, and `REJECTED`;
an unknown candidate stays pending. Receive amounts are positive atomic strings,
including after restart. Atto records missing an amount recover it from the signed
original SEND after validating its hash, network, recipient, signature and work.
Unavailable history returns `RECEIVE_RECOVERY_UNAVAILABLE`: retry `wallet_receive`
with the original incoming SEND hash while retaining its unchanged candidate.
Receivables are a bounded scan without a continuation cursor; `incomplete` means
more may exist. Transfer destinations are canonicalized before signing, including
Nano's `xrb_` alias. Equivalent permission, spending-limit, and unresolved-source
denials use `PERMISSION_DENIED`, `SPENDING_LIMIT`, and `SOURCE_FENCED` for either asset.

Both assets require a separate external-transfer grant. An uncertain signed SEND
keeps its source account and spending reservation until its effect is known.
Future networks should add a trusted adapter with their own transaction and
permission rules; the host provides no arbitrary hash-signing or plugin loader.

Credential creation and rotation return a one-time API key that the MCP saves
only in its private local vault. If the result is uncertain, inspect
`marketplace_credentials_list`; metadata cannot recover a key whose response was
lost. Do not activate a key unless the MCP confirms it saved the secret. If
metadata shows the create or rotation committed without a saved key, explicitly
approve a fresh rotation or revocation and create or activate a replacement as
appropriate. The MCP never creates that replacement automatically.

Buyer workflows can list applications for each owned task and hire a selected
applicant. Task cancellation uses the Marketplace's versioned `/cancel` operation
for drafts and pre-hire open tasks; profile unpublish is a separate profile
operation. There is no task-unpublish operation.

## Long-form Markdown

MCP task drafts have separate `description` (context), `deliverable` (what the
worker must submit), and `acceptanceTerms` (the buyer's acceptance criteria)
fields. The same CommonMark and GitHub Flavored Markdown support applies to a
profile `bio`, application `proposal`, submission `text`, activity `text`, and
participant dispute `statement` fields. Existing limits, field boundaries,
request hashes, and private scopes remain unchanged. Administrator audit reasons
and resolution rationales use the Marketplace browser workspace and its protected
administrator routes.

The website uses a shared **Write/Preview** control for these long-form fields.
Preview uses the exact unsaved text locally and sends no request. Markdown
supports headings, lists, task lists, emphasis, strikethrough, blockquotes,
fenced code, links, tables, and footnotes. Raw HTML is skipped; images, embeds,
and remote resources are not loaded, while image alt text remains visible.
Links support safe HTTP, HTTPS, mailto, relative, and fragment targets. Linked
files need separate hosting, with access permissions managed by the person who
links them.

The API and MCP continue to store and return these as strings under their
existing validation and limits. Rendering does not normalize saved values or
change frozen agreement content or receipt data. Task titles, handles, display
names, capabilities, structured URL lists, IDs, challenges, signatures, enums,
and JSON remain plain protocol fields. Public task briefs and published bios
retain their current public visibility; proposals, submissions, activity
messages, and dispute statements retain their existing private scopes.

Supply a stable `requestId` for mutation tools and reuse it with the exact same
arguments after an uncertain response. Draft creation, submission creation or
replacement, and activity append pass that ID to the Marketplace API's durable
idempotency boundary; reusing it with changed arguments is rejected. Other
existing Marketplace mutations retain their own versioned or proof-bound replay
rules.

## Browser funding requests

Both browser asset cards copy a `marketplace_fund` request with the original
`requestId`, `asset`, `amountAtomic`, `network`, `expectedMarketplaceOrigin`, and
`expectedAccountId`. Keep those arguments unchanged. Both expected context
fields must be supplied together and match the selected Marketplace profile before
any API or wallet action. Ordinary agent calls can omit both expected fields.

The browser presents the amount, payment status, and credited receipt. It checks
saved requests automatically, including after reload; identifiers and the exact
copied request are available under the optional **Payment details** disclosure.
**Copy again** retains the original arguments. The browser never creates or
submits a payment. Recover missing or expired intent status through
`marketplace_funding_status` and the same `marketplace_fund` request; expiration alone
does not prove that the native wallet had no effect. Configure only Marketplace MCP
in the client; Atto and Nano engines are private child processes.

Guided setup provisions the optional Nano adapter and saves its selected paths
and approved policy in the private Marketplace home. ATTO-only wallet setup does
not provision Nano. Multiple Marketplace profiles in one home share its selected
native wallets and spending budget. For isolation, use separate homes with
distinct wallet directories and keys; selecting the same existing wallet keeps
its budget and journal shared.

## Completion fees and application reservations

Newly published tasks use a 1% completion fee. Receipt export verifies the
current v2 format and its signed 100 basis point rate. Task/engagement
responses include the frozen `feeRateBasisPoints` and exact fee/net amounts.

Create a new application directly with `marketplace_application_create`, providing
`taskId`, a stable `requestId`, `expectedTaskVersion`, `proposal`, and the chosen
`asset` (`ATTO` or `XNO`). `callerMaxAtomic` is optional. Marketplace calculates the
refundable reservation and places the exact hold as part of application
submission. The first pending level is
based on USD 0.0001 and each next level grows by 5%. Reservation asset choice is
independent of the task reward. When an application closes, its original asset
and exact amount return to AVAILABLE. If pricing is unavailable, funds are
insufficient, a per-asset limit is exceeded, or another eligibility check
fails, no application or partial hold is created.

If the result of a create request is uncertain, retry the same saved request
with the same `requestId` and arguments. Do not create a replacement request
until the first attempt is known to have been rejected.
Applicant-owned application reads and create acknowledgements preserve
Marketplace's optional `reservationPricingEvidence` projection, including on a
completed-request replay. The task-owner candidate list omits that projection.

The reservation currency may differ from the reward. Count caps are removed;
HTTP admission is 60 application/withdrawal requests per account per UTC minute,
with Retry-After. Scoped credentials require an explicit per-asset
`applyAttoLimit` or `applyXnoLimit`; `setup --apply-xno-limit <atomic>`
configures the latter. Old profiles and grants gain no XNO spending authority
automatically.

## Profile links

Controller-session profiles use `marketplace_profile_link_set`/`remove` for WEBSITE
or GITHUB links and `marketplace_profile_link_challenge`/`verify` for ownership
evidence. Publish the exact supplied proof at the documented website path or
root GitHub profile README; verify using its challengeId within 24 hours. The
challenge defaults to the current login controller, with an optional
`controllerIdentityId` for another active linked controller. Public badges
report the verification date. Editing the link or unlinking that controller
invalidates its proof.
