import { isDeepStrictEqual } from 'node:util';
import { currentShell, quoteShellArgument } from '../domain/shell.js';
import type { LimitsProposal, McpAccess } from './ledger.js';
import type { AccountPool, SpendingPolicy } from '../wallet/types.js';

/** Public guidance only; approval remains a separate human terminal operation. */
export function approvalInstructions(proposal: LimitsProposal,
  current: { access: McpAccess; policy: SpendingPolicy; pool: AccountPool; messageSigningIndexes: number[] }) {
  const shell = currentShell();
  const args = ['--data-dir', proposal.directory, 'limits', 'approve', proposal.id]
    .map(argument => quoteShellArgument(argument, shell)).join(' ');
  const pool = proposal.pool ?? current.pool;
  return {
    method: 'local-terminal',
    instructions: 'Ask the user to review the changes and run one command in their own terminal. Use atto when the CLI is installed, or npx with Node.js/npm. Never run approval commands on the user\'s behalf. Proposing does not change active settings.',
    changes: {
      ...(current.access !== proposal.access ? { access: { from: current.access, to: proposal.access } } : {}),
      ...(!isDeepStrictEqual(current.policy, proposal.policy) ? { policy: { from: current.policy, to: proposal.policy } } : {}),
      ...(!isDeepStrictEqual(current.pool, pool) ? { pool: { from: current.pool, to: pool } } : {}),
      ...(!isDeepStrictEqual(current.messageSigningIndexes, proposal.messageSigningIndexes ?? [])
        ? { messageSigningIndexes: { from: current.messageSigningIndexes, to: proposal.messageSigningIndexes ?? [] } } : {}),
    },
    shell,
    commands: {
      atto: `atto ${args}`,
      npx: `npx --yes @attocash/mcp@latest ${args}`,
    },
  };
}
