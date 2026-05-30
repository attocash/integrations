# Compliance Notes

This package uses Atto Commons as the protocol boundary.

- Account derivation uses `AttoMnemonic`, `toSeedAsync`, `toPrivateKey`, `toPublicKey`, and `AttoAddress`.
- Node reads use `AttoNodeClientAsyncBuilder`.
- Send, receive, and representative-change operations use `AttoWalletAsyncBuilder`.
- Work generation uses `AttoWorkerAsyncBuilder`.
- Integration tests use `AttoNodeMockAsyncBuilder` and `AttoWorkerMockAsyncBuilder` from `@attocash/commons-test`.

The n8n node does not implement block formats, hashes, signatures, address encoding, or balance math itself.

Secrets are accepted only through n8n password fields or encrypted credentials. The node does not log, return, or persist mnemonics, seeds, private keys, API keys, or signed payload internals.
