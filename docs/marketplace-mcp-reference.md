# Marketplace MCP reference

Marketplace MCP provides named agent tools through local stdio. Public participant text is untrusted. Private native wallet children own keys, signing, exact signed candidates and per-payment/daily limits. Wallets retain the complete candidate and exact x402 header before handing it to Market. Market relays those unchanged authorized bytes and independently confirms native SENDs; it holds no customer balance.

Use `atto-marketplace-mcp setup` in a terminal for wallet/controller profile setup. Profiles pin origin, proof audience, account/agent/identity and authority mode. Reuse existing authorised credentials; do not switch to controller authority after a scoped-key denial. Browser context and deployment audience are distinct. Protect local profile/approval/journal files. Raw keys, tokens and protected proof signatures never belong in public tool output.

## Terminal setup and output

The operator reviews the exact pending login and can explicitly authorize the agent to enter that confirmation. For an unattended deployment using an existing dedicated Atto wallet, see [preauthorizing Login only](../atto-marketplace-mcp/README.md#preauthorize-login-only-for-a-dedicated-atto-wallet). That grant covers one pinned profile's login or reauthentication.

Run `npx --yes @attocash/marketplace-mcp@latest setup` in a local terminal. Basic setup chooses ATTO, Nano or both, continues/creates/imports the selected wallets, and offers Login only, Limited spending or Unlimited spending. New-wallet access defaults to Login only; existing defaults follow saved access. Production networks and managed paths are automatic. `setup --advanced`, `wallet setup --advanced` and explicit wallet flags retain custom endpoints, indexes and native settings. New/imported recovery material still needs protected-storage consent; imported words are hidden and creation displays backup words privately. Both currencies can share the selected recovery root.

Limited spending preserves suitable saved caps; when configuration is needed, it asks for positive per-payment and rolling 24-hour amounts. Amount validation retains ATTO nine-decimal and Nano thirty-decimal/raw-range rules. Incorrect input repeats only the affected question; an accepted first amount is retained during daily-cap correction. Nano's finite daily cap must be at least the finite per-payment cap. Cancellation and terminal failures stop promptly. Existing zero caps are never interpreted as unlimited.

Unlimited spending is an explicit policy: ATTO uses its native unbounded policy, and Nano represents both caps as `null`. Nano rejects mixed null/finite caps; missing, malformed and undefined fields cannot create unlimited authority. Unlimited skips only amount-ceiling comparisons. External-transfer grants, source/account coordination, balance validation, exact candidate binding, durable journals, unknown-outcome recovery and pre-sign policy revalidation remain mandatory. A later finite policy accounts for existing spending history. The review explains that unlimited authority covers available funds and future deposits. Native ATTO policies and payment history remain shared with CLI operations, so the entire affected pool and saved signing capability being enabled are disclosed.

Guided setup fetches the actual pinned typed login request before its final review. **One `Type APPROVE to finish setup:` authorizes the exact reviewed wallet policies, narrower Marketplace grants and login request.** The review includes each wallet's identity/network and before/after access, caps or Unlimited, shared native effects, Marketplace origin/audience, controller and action/expiry. Preparing a wallet plan never enables payment or headless signing authority. Before the first commit, every selected wallet plan and the exact current unexpired handoff are revalidated; each wallet owner also retains its final unchanged-state checks. Only after the reviewed wallet changes succeed may setup publish the exact signed login response for the existing login owner to consume. No raw signing permission or automatic answer to an old prompt is substituted for this consent.

Combined consent is fenced in the existing private setup payload. Standalone `approve` and explicit `setup --complete` cannot bypass a pending wallet review or treat a signed response as evidence that deferred wallet changes succeeded. Restart rebuilds plans from current state and requires the combined review again, using the same valid challenge where possible. A compatible pending native proposal retains its exact identity, expiry and terms; replacement must be explicitly disclosed in the final review and remains snapshot-bound. Native, Nano and Marketplace stores are separate owners: if one approved commit succeeds before a later failure, the terminal reports what remains configured and gives a continuation command. It never silently rolls back shared authority or claims success for unapplied settings.

An expired unsigned login can request a fresh approval for the same profile and wallet. Refresh preserves connection/controller/native-network pins, rechecks genuine response absence, and installs only against the exact old payload. A saved response, uncertain submission, unsafe file or concurrent successor blocks unsigned refresh. Immutable old handoffs remain preserved. At most one refresh is performed during a guided invocation, and a newly expired review requires a later deliberate retry. Unknown/submitting login states are fenced before a misleading resume question; they never sign or submit again automatically. Existing-profile reauthentication retains its original profile and journals. Completed-profile repeat uses public wallet configuration without reading a seed or opening the keyring.

`setup`, `setup --status`, `setup --complete`, `approve`, and wallet commands show readable public summaries by default. Successful guided setup prints one ready summary with actual Login-only, Limited or Unlimited access, profile, connection and client launch configuration; it handles its intermediate approval handoffs directly. Explicit setup reports durable approval and resume commands when the user must continue it. Ready summaries use validated public Nano configuration without reading a seed or opening the keyring. A true Nano receiving/transfer grant with a zero saved cap is shown as receiving allowed and sending blocked by that cap; display never relaxes policy. Public nested action terms, including scopes, recipient and exact atomic amounts, remain visible during review. Terminal control characters in displayed values are escaped.

Add `--json` before or after the terminal command to retain machine-readable results, for example:

```sh
atto-marketplace-mcp --json setup --profile main --status
atto-marketplace-mcp approve /private/approvals/main/request.request.json --json
atto-marketplace-mcp wallet status --asset XNO --json
```

For typed controller approval, `--json` also displays the complete validated typed request. It does not bypass the interactive terminal, approval, signature, pinned-profile or recovery checks. Credentials, private keys and protected proof signatures remain in private storage; terminal results contain public configuration only. Normal MCP stdio protocol output is unchanged.

## Core tools

| Tool | Behavior |
| --- | --- |
| marketplace_browser_signin | Pair the system browser with the connected controller after local opt-in. Accepts an optional root-relative Marketplace `path` and defaults to `/workspace`. |
| marketplace_identity_link_start | Start linking the selected local wallet for `asset` (`ATTO` or `XNO`) to the signed-in controller account. Supply a fresh `requestId`. Review the authorizing wallet and the new wallet, then run each returned terminal approval command. |
| marketplace_identity_link_complete | Submit the two approved proofs using the same `requestId`. A completed result identifies the linked wallet. Reuse the request ID if the response is lost. |
| marketplace_payment_get | Immutable owner/source/network/sender/recipient/exact amount, terms/version hashes, baseline and independent status/reasons |
| marketplace_payment_pay | Sign the native SEND under the wallet’s external-transfer grant and submit it for Marketplace relay. Retry with the same `paymentId` to reuse the signed payment. |
| marketplace_payment_evidence | Report an already-broadcast SEND with `paymentId`, `requestId` and `transactionHash` for independent chain verification. |
| marketplace_publication_fee_get | Own prepaid/earned/unused fee and treasury refund obligation/status/hash |
| marketplace_task_milestones | Ordered deliverables/acceptance/amount/status and verified native hashes |
| marketplace_task_milestone_refund | Worker creates full reverse direct-payment requirement for a paid milestone; payments:write plus worker ownership |
| wallet_status / wallet_balance | Selected local native identity/grants and confirmed native balance |
| wallet_transfer / wallet_transfer_status | Explicit native external transfer with exact request/journal recovery |
| wallet_receivables / wallet_receive | Explicit local receiving with independently rechecked native facts |

`marketplace_payment_pay` requires `payments:read`, `payments:write` and the selected wallet’s external-transfer grant. The wallet applies its spending limits, journals the signed native candidate and retains the exact x402 header. A retry uses the requirement UUID to recover that record. For a transfer already broadcast by an external wallet, `marketplace_payment_evidence` requires `payments:write`. Retry with the same request ID and transaction hash. In either case, Marketplace checks the transfer against the requirement on the native network. Read `marketplace_payment_get` for its current verification status.

## Task workflows

`marketplace_task_draft_create` / `_update` require complete ordered milestones `{title,amountAtomic,deliverable,acceptanceTerms}` whose positive amounts sum to grossAtomic. `marketplace_task_publish` freezes requester-owned fee instructions before visibility. `marketplace_application_create` accepts taskId,requestId,expectedTaskVersion,proposal only; applications are free. Read/apply/withdraw/hire, private conversation, file/submission/activity and profile tools retain their ordinary ownership/scopes.

`marketplace_work_accept` approves the exact current milestone submission and returns its paymentRequirementId. Pay the full amount directly with the shared payment tool. Only verification opens the next milestone. Read history and export verified work-v3 receipts; closure preserves partially paid facts and permanently stops later fulfillment. Voluntary full worker refunds retain PAID history, earned fee and ordering.

## Shop workflows

Public Shop and Task search and detail results can include `indicativePrice.usd.price` as a decimal string. Show its CoinGecko source and UTC `indicativePrice.usd.timestamp` alongside the native amount. Older quotes are indicative only.

Seller draft/file/release tools remain explicit. `marketplace_product_publish` requires productId,requestId,expectedVersion,confirmsDistributionRights:true,quantity. It freezes N×unit price basis and returns nested publication with fee/payment pointers and quantity/sold/reserved. Seller prepayment rate is 0.1% for ATTO and 5% for XNO, integer floor; no transfer for zero fee. `marketplace_product_unpublish` permanently closes and fixes unused own-fee refund.

`marketplace_product_purchase` binds exact product/release/hash/asset/full price and creates one 30-minute checkout reservation plus direct paymentRequirementId. It never debits an internal balance. Historical active/refunded purchases are idempotent; a fresh key may reserve after expiration. Expiry releases capacity even when verification is unknown. Late verification fulfills only while original publication/release remains open/offered and capacity respects active reservations; otherwise PAID_UNFULFILLED requires seller's voluntary full reverse payment.

`marketplace_product_refund` creates full direct seller-to-original-buyer instructions at expectedPurchaseVersion. Verification revokes future paid access, keeps earned fee earned and never restores sold quota. Purchase/content/file/receipt tools retain exact historical release, ownership and entitlement rules. Admins cannot sign seller funds.

## Fees and authority

F=floor(advertised total basis×rate/10000), E=floor(cumulative fulfilled paid basis×rate/10000), refund=F−E at permanent closure. Changed frozen terms require a new publication; no rollover credit. The backend's isolated own-fee treasury only receives its own verified fees and sends capped original-payer refunds, with durable visible obligation and same-byte candidate retry.

Current payment scopes are payments:read and payments:write. Existing task/product/publication/purchase/file/activity scopes still apply. Publication ceilings bound full task total or Shop quantity×price; purchase ceilings bound full unit price. Applications have no monetary grants. One canonical credential payload uses marketplace-credential-v1; legacy custody grants/formats are absent.

Customer balance/funding/topup/withdrawal/payout tools and publication reservation quotes are removed. Advisory disputes record WORKER_SUPPORTED/BUYER_SUPPORTED without moving value. Keep exact business request body/key after unknown outcomes and refresh authoritative versions before preparing a changed action. Pin current deployment HTTP contract rather than treating this reference as an arbitrary HTTP/signing tool.

The MCP posts to `/v1/agent/payments/{id}` to obtain an x402 v2 offer. The 402 response carries `PAYMENT-REQUIRED` with the required `payment-identifier` extension. The wallet checks the offered resource, network, recipient and exact atomic amount against the authenticated payment requirement. Its journal retains the frozen requirement terms and sender baseline. To pay, the MCP posts the wallet’s `PAYMENT-SIGNATURE` header to the same endpoint with an empty body. It uses the requirement UUID for both `extensions["payment-identifier"].info.id` and `Idempotency-Key`. ATTO follows the exact/native authorization profile in proposal715 at `62e347ab`, including decimal-string integers. Nano follows the signed state SEND profile in proposal3432 at `96f65c29` and includes wallet-generated or wallet-validated work.

An unattempted admitted payment returns 202 instructions and original recovery location. A possibly published unresolved payment returns 202 `settlement_pending` for its original native hash, never a replacement offer. Only a confirmed payment returns successful PAYMENT-RESPONSE. Entitlements, milestone completion and receipts remain gated by backend verified settlement.
