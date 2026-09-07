# Wallet engine API

Other local adapters can import the supported engine interface:

```js
import { createApplication, operations } from '@attocash/cli/core';

const application = createApplication({ directory: '/absolute/path/to/profile' });
try {
  const balances = await application.call('balances_get');
  console.log(balances);
  console.log(operations.map(operation => operation.name));
} finally {
  await application.close();
}
```

Omit `directory` to use the CLI default wallet. The exported `ApplicationSession`
interface provides `call(name, input?)`, `start()`, and `close()`. Call `start()`
for a persistent session that should run automatic receiving, and always call
`close()` when the session ends. Watches belong to that application session.
The library's `send` operation selects from the approved pool when `index` is
omitted, matching MCP. The `atto send` command supplies index `0` by default and
uses that automatic selection only with `--pool`.

Adapters requiring the MCP permission policy pass `access: 'mcp'`; that session
rechecks the profile's approved access before wallet mutations. Automatic
receiving follows that access mode too. Generic `limits_propose` only creates a
proposal in either mode.

The entry point also exports `operations`, `errorResult`, and the `Operation`,
`ApplicationOptions`, and `ApplicationSession` types. It does not expose recovery
methods. Wallet creation, import, backup, and reset remain terminal commands. The MCP
package calls this API directly and keeps one application session for its stdio
connection. `@attocash/cli/profiles` provides shared directory resolution;
`@attocash/cli/terminal` provides interactive setup and proposal review for the
terminal executables.

