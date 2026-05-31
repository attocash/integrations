# @attocash/n8n-nodes-atto

[![npm version](https://img.shields.io/npm/v/@attocash/n8n-nodes-atto.svg)](https://www.npmjs.com/package/@attocash/n8n-nodes-atto)
[![n8n Atto Node CI](https://github.com/attocash/integrations/actions/workflows/n8n-node-package.yml/badge.svg)](https://github.com/attocash/integrations/actions/workflows/n8n-node-package.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/attocash/integrations/blob/main/LICENSE)

Use Atto from n8n workflows.

This package adds action and trigger nodes for Atto addresses, accounts, receivables, transactions, and representatives. Signing, address derivation, node calls, wallet operations, streams, and test mocks come from Atto Commons.

## Install

In self-hosted n8n, open **Settings** > **Community Nodes** and install:

```text
@attocash/n8n-nodes-atto
```

Restart n8n if the nodes do not appear right away.

## What You Can Build

The package includes two nodes:

- **Atto**: derive addresses, read account state, list receivables, receive an incoming receivable, list transactions/account entries, send transactions, and change representatives.
- **Atto Trigger**: start workflows from receivables, account updates, transactions, or account entries.

Typical workflows:

- Receive a payment when a receivable appears.
- Send a payment from the address derived from your credential.
- Build a ping/pong flow that receives an incoming amount and sends the same amount back.
- Watch an address for account entries or transaction updates.

## Credentials

Create an **Atto API** credential in n8n.

Required for node access:

- **Node Base URL**: Atto node HTTP API, for example `http://localhost:8080`.
- **Worker Base URL**: Atto work server HTTP API, for example `http://localhost:8085`.

Optional API auth:

- **API Key**
- **API Key Header**
- **API Key Prefix**

Required for signing actions:

- **Wallet Secret Type**: mnemonic phrase or private key.
- **Wallet Secret**: encrypted by n8n and used only when signing.
- **Key Index**: derivation index for mnemonic secrets.

The credential test only checks that **Node Base URL** responds to `GET /`. It does not send the wallet secret.

For real funds, store wallet material in n8n credentials. Node-parameter secrets are useful for local derivation and tests, but n8n may keep node parameters in execution records depending on your instance settings.

## Nodes

### Atto

Resources and operations:

- **Address > Derive**: derive an Atto address and public key from a mnemonic or hex private key.
- **Account > Get**: read balance, representative, height, and frontier for an address.
- **Receivable > Get**: collect receivables for the credential-derived address or manual addresses.
- **Receivable > Receive**: receive the receivable from the incoming item.
- **Transaction > Get**: fetch by hash or collect a bounded transaction stream.
- **Transaction > Send**: send from the credential-derived address.
- **Account Entry > Get**: fetch by hash or collect a bounded account-entry stream.
- **Representative > Change**: change the representative for the credential-derived address.

Signing actions derive the source address from the wallet secret and key index. You do not need to pass a manual source address. Send and receive use a 60 second publish timeout by default.

### Atto Trigger

Trigger events:

- **Receivable**: fires when a receivable appears for the credential-derived address or manual addresses.
- **Account Update**: fires when account state changes.
- **Transaction**: watches by hash, address stream, or all supported transactions.
- **Account Entry**: watches by hash, address stream, or all supported account entries.

## Example Workflows

Importable examples live in [`examples`](./examples):

- [`send-transaction.json`](./examples/send-transaction.json): manual trigger to send Atto.
- [`incoming-to-receive.json`](./examples/incoming-to-receive.json): receivable trigger piped into **Receivable > Receive**.
- [`ping-pong-receivable.json`](./examples/ping-pong-receivable.json): receive an incoming amount and send the same raw amount back to the sender.
- [`receivable-trigger.json`](./examples/receivable-trigger.json): trigger-only receivable watcher.

After importing an example, attach your **Atto API** credential and replace any placeholder addresses before running transaction operations.

## Local Development

Install dependencies and run the checks:

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

### Run n8n With Podman

From this package directory:

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

Open `http://localhost:5678`, create a workflow, and add **Atto** or **Atto Trigger**.

### Install From A Checkout Inside n8n

If you have shell access inside the n8n container:

```bash
cd /tmp
git clone https://github.com/attocash/integrations.git
cd integrations/n8n-node
npm run install:n8n
```

The installer builds, validates, packs, and installs the generated `.tgz` into `${N8N_USER_FOLDER:-$HOME/.n8n}/nodes`.

Optional overrides:

```bash
N8N_NODES_DIR=/path/to/nodes npm run install:n8n
RUN_TESTS=1 npm run install:n8n
```

Restart n8n after the script finishes.

## Maintainers

This package is versioned independently from other integrations in this repository. Use normal semver in `n8n-node/package.json`; release tags use the package-specific format `n8n-node-vX.Y.Z`.

```bash
cd n8n-node
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "Release n8n Atto node vX.Y.Z"
git push origin main
```

On pushes to `main`, GitHub Actions tests and packs the attempted version, uploads the `.tgz` artifact, then waits for approval in the `release` environment. After approval, it creates the tag, publishes `@attocash/n8n-nodes-atto` to npm, and creates the GitHub release.

Configure npm Trusted Publishing for `.github/workflows/n8n-node-package.yml`. `NPM_TOKEN` is supported as a fallback.

## Notes

- Runtime Atto behavior comes from Atto Commons split packages: `@attocash/commons-core`, `@attocash/commons-node`, `@attocash/commons-node-remote`, `@attocash/commons-wallet`, and `@attocash/commons-worker-remote`.
- Atto Commons code is bundled into the built action and trigger node files, so the published n8n package has no runtime dependencies beyond n8n.
- Hex private keys must use the format accepted by `AttoPrivateKey.Companion.parse`.
