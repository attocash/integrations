# n8n-nodes-atto

n8n community node package for Atto cryptocurrency operations. The node delegates account derivation, signing, node access, wallet operations, and test mocks to Atto Commons packages instead of implementing Atto protocol logic locally.

## Operations

- Derive Account: derive an Atto address and public key from a mnemonic or hex private key.
- Get Account Info: fetch account balance, representative, height, and frontier from an Atto node.
- Send Transaction: sign and publish a send block through Atto Commons wallet APIs.
- Receive Pending Transaction: wait for a receivable entry and publish the receive block.
- Change Representative: sign and publish a representative change block.

## Credentials

Create an **Atto API** credential in n8n:

- Node Base URL: Atto node HTTP API, for example `http://localhost:8080`.
- Worker Base URL: Atto work server HTTP API, for example `http://localhost:8085`.
- API Key: optional key sent to both services.
- API Key Header and Prefix: defaults to `Authorization: Bearer <key>`.
- Wallet Secret Type: mnemonic phrase or private key. Atto Commons currently expects 24-word mnemonic phrases.
- Wallet Secret: encrypted by n8n and used only for signing.
- Key Index: derivation index for mnemonic secrets.

For one-off derivation and tests, the node can read the secret from node parameters instead of credentials. For real funds, prefer encrypted n8n credentials; workflow node parameters can appear in failed execution records depending on n8n redaction settings. Secrets are never returned in successful node output.

## Build And Test

```bash
npm install
npm run build
npm test
npm run lint
```

`npm test` builds the package and runs unit, smoke, and integration tests. The integration test uses `AttoNodeMockAsyncBuilder` and `AttoWorkerMockAsyncBuilder` from `@attocash/commons-test`. It uses Docker when available and falls back to a local Podman socket.

To require the mock-container integration path:

```bash
ATTO_TEST_INTEGRATION=1 npm run test:integration
```

## Local n8n

Build first, then mount this package as a community node package:

```bash
npm run build
mkdir -p /tmp/n8n-atto-local/.n8n/nodes/node_modules
podman run --rm -it \
  --user 0 \
  -p 5678:5678 \
  -e N8N_USER_FOLDER=/home/node \
  -e N8N_COMMUNITY_PACKAGES_ENABLED=true \
  -e N8N_SECURE_COOKIE=false \
  -v /tmp/n8n-atto-local:/home/node:Z \
  -v "$PWD:/home/node/.n8n/nodes/node_modules/n8n-nodes-atto:ro,Z" \
  docker.io/n8nio/n8n:latest
```

Open `http://localhost:5678`, create a workflow, and add the **Atto** node.

## Usage

See `examples/send-transaction.json` and `examples/incoming-to-receive.json` for importable workflow shapes. Replace placeholder addresses and attach an **Atto API** credential before running transaction operations.

## Implementation Notes

- Runtime protocol behavior comes from Atto Commons split packages: `@attocash/commons-core`, `@attocash/commons-node`, `@attocash/commons-node-remote`, `@attocash/commons-wallet`, and `@attocash/commons-worker-remote`.
- The Atto Commons package code is bundled into `dist/nodes/Atto/Atto.node.js` so the published n8n community node has no runtime dependencies beyond n8n.
- The aggregate `@attocash/commons-js@6.7.1-patch.1` package was not used because its published runtime entrypoint does not expose the APIs used by the current Commons JS example.
- Hex private keys should use the format accepted by `AttoPrivateKey.Companion.parse`.
