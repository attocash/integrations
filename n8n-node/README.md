# @attocash/n8n-nodes-atto

[![npm version](https://img.shields.io/npm/v/@attocash/n8n-nodes-atto.svg)](https://www.npmjs.com/package/@attocash/n8n-nodes-atto)
[![n8n Atto Node CI](https://github.com/attocash/integrations/actions/workflows/n8n-node-package.yml/badge.svg)](https://github.com/attocash/integrations/actions/workflows/n8n-node-package.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/attocash/integrations/blob/main/LICENSE)

n8n community node package for Atto cryptocurrency wallet, transaction, account, and trigger automation. The nodes delegate address derivation, signing, node access, wallet operations, streams, and test mocks to Atto Commons packages instead of implementing Atto protocol logic locally.

## Install in n8n

Install the npm package from **Settings** > **Community Nodes** in a self-hosted n8n instance:

```text
@attocash/n8n-nodes-atto
```

n8n's **Browse** button opens npm search for packages tagged with `n8n-community-node-package`. This package includes that keyword so it is discoverable from the n8n community-node flow after it is published to npm.

## Nodes

### Atto

- Address: Derive an Atto address and public key from a mnemonic or hex private key.
- Account: Get balance, representative, height, and frontier for an address.
- Receivable: Get receivable entries or receive the receivable from the incoming item.
- Transaction: Get transactions by hash or bounded stream query, or send from the credentials-derived address.
- Account Entry: Get account entries by hash or bounded stream query.
- Representative: Change the representative for the credentials-derived address.

### Atto Trigger

- Receivable: Trigger when a receivable is available for the credentials-derived address or manual addresses.
- Account Update: Trigger from account state updates.
- Transaction: Trigger from transactions by hash, address stream, or all stream.
- Account Entry: Trigger from account entries by hash, address stream, or all stream.

## Credentials

Create an **Atto API** credential in n8n:

- Node Base URL: Atto node HTTP API, for example `http://localhost:8080`.
- Worker Base URL: Atto work server HTTP API, for example `http://localhost:8085`.
- API Key: optional key sent to both services.
- API Key Header and Prefix: defaults to `Authorization: Bearer <key>`.
- Wallet Secret Type: mnemonic phrase or private key. Atto Commons currently expects 24-word mnemonic phrases.
- Wallet Secret: encrypted by n8n and used only for signing.
- Key Index: derivation index for mnemonic secrets.

The n8n credential test performs a read-only `GET /` against **Node Base URL** to verify the configured node endpoint is reachable. It does not send the wallet secret.

For one-off derivation and tests, the action node can read the secret from node parameters instead of credentials. For real funds, prefer encrypted n8n credentials; workflow node parameters can appear in failed execution records depending on n8n redaction settings. Secrets are never returned in successful node output.

Signing actions derive the source address from the wallet secret and key index. Send, receive, and representative-change operations do not require a manual source address. Send and receive use a 60 second publish timeout by default.

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
  -v "$PWD:/home/node/.n8n/nodes/node_modules/@attocash/n8n-nodes-atto:ro,Z" \
  docker.io/n8nio/n8n:latest
```

Open `http://localhost:5678`, create a workflow, and add the **Atto** or **Atto Trigger** node.

### Install from a checkout inside the n8n container

If you have shell access inside the n8n container, clone this repository and run the installer from the package directory:

```bash
cd /tmp
git clone https://github.com/attocash/integrations.git
cd integrations/n8n-node
npm run install:n8n
```

The script installs build dependencies, builds and validates the package, packs it, and installs the generated `.tgz` into `${N8N_USER_FOLDER:-$HOME/.n8n}/nodes`. Override the destination with `N8N_NODES_DIR=/path/to/nodes npm run install:n8n`. Use `RUN_TESTS=1 npm run install:n8n` only when the container can run the test dependencies.

Restart n8n after the script finishes.

## Usage

See `examples/send-transaction.json`, `examples/incoming-to-receive.json`, `examples/ping-pong-receivable.json`, and `examples/receivable-trigger.json` for importable workflow shapes. `incoming-to-receive.json` pipes the **Atto Trigger** receivable output into **Atto** → **Receivable** → **Receive**. `ping-pong-receivable.json` receives the incoming receivable and sends the same raw amount back to the original sender from the trigger payload. Replace placeholder addresses and attach an **Atto API** credential before running transaction operations.

## Release

The n8n package is versioned independently from other integrations in this repository. Update `n8n-node/package.json` with normal semver when you want to attempt a new release. Multiple commits can keep the same attempted version until the release is approved.

```bash
cd n8n-node
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "Release n8n Atto node vX.Y.Z"
git push origin main
```

The GitHub Actions workflow runs lint, tests, and packing for pull requests and n8n-related pushes to `main`. Main pushes upload the attempted package artifact immediately, then wait for approval in the GitHub environment named `release`. After approval, the workflow creates the package-specific tag `n8n-node-vX.Y.Z`, publishes `@attocash/n8n-nodes-atto@X.Y.Z` to npm with provenance, and creates the GitHub Release with the `.tgz` attached. Configure npm Trusted Publishing for this repository and workflow file, or set the `NPM_TOKEN` repository secret as a fallback.

## Implementation Notes

- Runtime protocol behavior comes from Atto Commons split packages: `@attocash/commons-core`, `@attocash/commons-node`, `@attocash/commons-node-remote`, `@attocash/commons-wallet`, and `@attocash/commons-worker-remote`.
- The Atto Commons package code is bundled into the action and trigger node files so the published n8n community node has no runtime dependencies beyond n8n.
- The aggregate `@attocash/commons-js@6.7.1-patch.1` package was not used because its published runtime entrypoint does not expose the APIs used by the current Commons JS example.
- Hex private keys should use the format accepted by `AttoPrivateKey.Companion.parse`.
