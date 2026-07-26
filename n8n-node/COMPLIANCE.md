# Compliance Notes

This package uses Atto Commons as the protocol boundary.

- Address derivation uses `AttoMnemonic`, `toSeedAsync`, `toPrivateKey`, `AttoSigner`, and `AttoAddress`.
- Node and worker requests use n8n's HTTP helpers, preserving n8n authentication, timeout, and streaming behavior.
- Send, receive, and representative-change blocks use the Commons account update helpers.
- Block hashes, work targets, signatures, and transactions use Commons Core.
- Integration tests use `AttoNodeMockAsyncBuilder` and `AttoWorkerMockAsyncBuilder` from `@attocash/commons-test`.

Commons Core and its protocol dependencies are bundled once into the built protocol adapter. The published package has no runtime dependencies other than n8n's `n8n-workflow` peer.

Secrets are accepted only through n8n password fields or encrypted credentials. The node does not log, return, or persist mnemonics, seeds, private keys, API keys, or signed payload internals.
