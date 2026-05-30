# Support Matrix

All requested initial operations are implemented against the currently published Atto Commons split packages.

| Requirement | Status | Commons API |
| --- | --- | --- |
| Create or derive account | Supported | `AttoMnemonic`, `AttoPrivateKey`, `AttoAddress` |
| Get account info | Supported | `AttoNodeClientAsyncBuilder.accountByPublicKey` |
| Send transaction | Supported | `AttoWalletAsyncBuilder.sendByAddress` |
| Receive pending transaction | Supported | `onReceivableByAddresses` and `AttoWalletAsyncBuilder.receive` |
| Change representative | Supported | `AttoWalletAsyncBuilder.change` |
| Mock node tests | Supported | `AttoNodeMockAsyncBuilder` and `AttoWorkerMockAsyncBuilder` |

No protocol-level behavior is intentionally implemented outside Atto Commons.
