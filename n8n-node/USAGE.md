# Usage

## Derive Account

Use **Derive Account** when you need an address/public key from a mnemonic or private key. This operation can run without Atto node credentials if **Secret Source** is set to **Node Parameters**.

Output includes `address`, `publicKey`, `keyIndex`, and `secretType`. It does not include the mnemonic, seed, or private key.

Use encrypted credentials for real wallet material. Node-parameter secrets are intended for local derivation, tests, or controlled workflows where n8n execution-record redaction is configured appropriately.

## Get Account Info

Use **Get Account Info** with an Atto account address and an **Atto API** credential containing `Node Base URL`.

Output includes whether the account was found plus balance, representative, height, frontier hash, and the raw Atto Commons account JSON when available.

## Send Transaction

Use **Send Transaction** with:

- wallet secret from credentials or node parameters
- From Account matching the derived wallet address
- Destination Account
- Amount and Amount Unit

The node signs through Atto Commons wallet APIs and returns the published transaction hash, status, sender, recipient, and amount.

## Receive Pending Transaction

Use **Receive Pending Transaction** with a signing wallet and optional receiving account. The account must match the wallet-derived address. The node listens for the first receivable above the configured minimum amount, publishes a receive block, and returns the receive hash, amount, and receivable JSON.

## Change Representative

Use **Change Representative** with a signing wallet and representative account. The node signs through Atto Commons and returns the change transaction hash and status.

## Private Keys

Private-key input must be a hex string parseable by Atto Commons `AttoPrivateKey.Companion.parse`. For generated keys in JavaScript, Atto Commons `toHex(privateKey.value)` produces the expected format.

Mnemonic input must be a 24-word Atto Commons mnemonic phrase.
