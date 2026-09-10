import { isDeepStrictEqual } from 'node:util';
import type { LimitsProposal, McpAccess } from './ledger.js';
import type { AccountPool, SpendingPolicy } from '../wallet/types.js';

/** Public guidance only; approval remains a separate human terminal operation. */
export function approvalInstructions(proposal: LimitsProposal,
  current: { access: McpAccess; policy: SpendingPolicy; pool: AccountPool }) {
  const shell = process.platform === 'win32' ? 'powershell' : 'posix';
  const quote = (argument: string) => /^[a-z\d_./:@=-]+$/i.test(argument) ? argument
    : `'${argument.replace(/'/g, shell === 'powershell' ? "''" : "'\\''")}'`;
  const args = ['--data-dir', proposal.directory, 'limits', 'approve', proposal.id].map(quote).join(' ');
  const pool = proposal.pool ?? current.pool;
  return {
    method: 'local-terminal',
    instructions: 'Ask the user to review the changes and run one command in their own terminal. Use atto when the CLI is installed, or npx with Node.js/npm. Never run approval commands on the user\'s behalf. Proposing does not change active settings.',
    changes: {
      ...(current.access !== proposal.access ? { access: { from: current.access, to: proposal.access } } : {}),
      ...(!isDeepStrictEqual(current.policy, proposal.policy) ? { policy: { from: current.policy, to: proposal.policy } } : {}),
      ...(!isDeepStrictEqual(current.pool, pool) ? { pool: { from: current.pool, to: pool } } : {}),
    },
    shell,
    commands: {
      atto: `atto ${args}`,
      npx: `npx --yes @attocash/mcp@latest ${args}`,
    },
  };
}
