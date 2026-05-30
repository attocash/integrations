# Usage

## Address: Derive

Use **Address > Derive** when you need an address/public key from a mnemonic or private key. This operation can run without Atto node credentials if **Secret Source** is set to **Node Parameters**.

Output includes `address`, `publicKey`, `keyIndex`, and `secretType`. It does not include the mnemonic, seed, or private key.

Use encrypted credentials for real wallet material. Node-parameter secrets are intended for local derivation, tests, or controlled workflows where n8n execution-record redaction is configured appropriately.

## Account: Get

Use **Account > Get** with an Atto address and an **Atto API** credential containing `Node Base URL`.

Output includes whether the account was found plus balance, representative address, height, frontier hash, and the raw Atto Commons account JSON when available.

## Receivable: Get

Use **Receivable > Get** to collect receivable entries for the credentials-derived address or manual addresses. The operation uses Atto Commons stream APIs and returns when either **Max Items** is reached or **Timeout** expires.

## Transaction: Get

Use **Transaction > Get** to fetch a transaction by hash or collect a bounded transaction stream for the credentials-derived address, manual addresses, or all transactions.

## Account Entry: Get

Use **Account Entry > Get** to fetch an account entry by hash or collect a bounded account-entry stream for the credentials-derived address, manual addresses, or all account entries.

## Transaction: Send

Use **Transaction > Send** with:

- wallet secret from credentials or node parameters
- Destination Address
- Amount and Amount Unit

The source address is derived from the wallet secret and key index. The node signs through Atto Commons wallet APIs and returns the published transaction hash, status, source address, destination address, and amount.

## Receivable: Receive Pending

Use **Receivable > Receive Pending** with a signing wallet. The receiving address is derived from the wallet secret and key index. The node listens for the first receivable above the configured minimum amount, publishes a receive block, and returns the receive hash, amount, and receivable JSON.

## Representative: Change

Use **Representative > Change** with a signing wallet and representative address. The source address is derived from the wallet secret and key index. The node signs through Atto Commons and returns the change transaction hash and status.

## Atto Trigger

Use **Atto Trigger** for receivables, account updates, transactions, and account entries. Trigger filters can use the credentials-derived address, manual addresses, all supported stream items, or a hash where supported.

## Private Keys

Private-key input must be a hex string parseable by Atto Commons `AttoPrivateKey.Companion.parse`. For generated keys in JavaScript, Atto Commons `toHex(privateKey.value)` produces the expected format.

Mnemonic input must be a 24-word Atto Commons mnemonic phrase.
