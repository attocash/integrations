# Support Matrix

All requested initial operations are implemented against the currently published Atto Commons split packages.

| Requirement | Status | Commons API |
| --- | --- | --- |
| Create or derive address | Supported | `AttoMnemonic`, `AttoPrivateKey`, `AttoAddress` |
| Get account | Supported | `AttoNodeClientAsyncBuilder.accountByPublicKey` |
| Get receivables | Supported | `AttoNodeClientAsyncBuilder.onReceivableByAddresses` |
| Get transactions | Supported | `transaction`, `onTransactionByHash`, `onTransactionByPublicKey`, `onTransactionAll` |
| Get account entries | Supported | `accountEntry`, `onAccountEntryByHash`, `onAccountEntryByPublicKey`, `onAccountEntryAll` |
| Send transaction | Supported | `AttoWalletAsyncBuilder.sendByAddress` |
| Receive pending transaction | Supported | `onReceivableByAddresses` and `AttoWalletAsyncBuilder.receive` |
| Change representative | Supported | `AttoWalletAsyncBuilder.change` |
| Triggers | Supported | Atto Commons node stream APIs |
| Mock node tests | Supported | `AttoNodeMockAsyncBuilder` and `AttoWorkerMockAsyncBuilder` |

No protocol-level behavior is intentionally implemented outside Atto Commons.
