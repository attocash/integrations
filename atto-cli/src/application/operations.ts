import { personalNameSchema } from '../labels/personal.js';
import { z } from 'zod';
import { AttoError } from '../domain/errors.js';
import { paymentMetadataSchema } from '../spending/journal.js';

const index = z.number().int().min(0).max(2_147_483_647);
const address = z.string().min(1).max(128).describe('Atto address.');
const addresses = z.array(address).min(1).max(100);
const hash = z.string().regex(/^[a-fA-F0-9]{64}$/).describe('64-character hexadecimal transaction hash.');
const integer = z.string().regex(/^\d+$/).max(40);
const decimal = z.string().regex(/^\d+(?:\.\d+)?$/).max(80).describe('Exact decimal amount; never a JSON number.');
const unit = z.enum(['ATTO', 'RAW']);
const cursor = z.string().min(1).max(16_384);
const limit = z.number().int().min(1).max(1000).describe('Maximum returned records; defaults to 100.');
const timeoutMs = z.number().int().min(100).max(30_000).describe('Scan window in milliseconds; list queries default to 3000.');
const endpoint = z.url().max(2048).refine(value => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}, 'Use an HTTP(S) endpoint without credentials, query parameters, or fragments.');
const amount = z.strictObject({ amount: decimal, unit });
const policy = z.strictObject({
  perRequest: amount.nullable(),
  rolling: z.array(amount.extend({ days: z.number().int().positive().max(36_500) })).max(100),
});
const pool = z.strictObject({
  indexes: z.array(index).min(1).max(100).refine(indexes => new Set(indexes).size === indexes.length, 'Pool indexes must be unique.'),
  consolidate: z.boolean(),
});
const streamFields = {
  addresses: addresses.optional(),
  hash: hash.optional(),
  fromHeight: integer.optional(),
  toHeight: integer.optional(),
  minAmountRaw: integer.optional(),
};
const listFields = { limit: limit.optional(), timeoutMs: timeoutMs.optional(), cursor: cursor.optional() };
const labelTarget = { address: address.optional(), index: index.optional() };
const oneLabelTarget = (value: { address?: string; index?: number }) => (value.address !== undefined) !== (value.index !== undefined);
const accountFields = { index: index.optional(), addresses: addresses.optional() };
function singleSelection(value: { index?: number; addresses?: string[]; all?: boolean; networkWide?: boolean; hash?: string }): boolean {
  return [value.index !== undefined, value.addresses !== undefined, value.all === true, value.networkWide === true, value.hash !== undefined].filter(Boolean).length <= 1;
}

export interface Operation {
  name: string;
  description: string;
  schema: z.ZodObject;
  readOnly: boolean;
}

export const operations: readonly Operation[] = [
  { name: 'doctor', description: 'Diagnose this process environment, profile, keyring credential access, node APIs and streaming, worker proof of work, and wallet readiness. Full checks can take up to 60 seconds and may trigger an OS keyring prompt. Returns structured checks and actionable remediation, never recovery material. Does not repair settings, grant access, sign, publish, receive, or modify wallet state. Available in read-only sessions. Rerun after an authorized repair; client environment changes require restarting the MCP connection.', schema: z.strictObject({ globalDirectory: z.boolean().optional() }), readOnly: true },
  { name: 'wallet_status', description: 'Read public wallet configuration, readiness, network, and auto-receive status. Never returns recovery material.', schema: z.strictObject({}), readOnly: true },
  { name: 'wallet_configure', description: 'Update the supplied wallet settings, preserving omitted settings. Representative is the default for opening accounts; use representative_change for an existing account. Changes apply to this shared wallet.', schema: z.strictObject({ network: z.enum(['LIVE', 'BETA', 'DEV', 'LOCAL']).optional(), nodeUrl: endpoint.optional(), workerUrl: endpoint.optional(), representative: address.optional(), autoReceive: z.boolean().optional(), minReceiveRaw: integer.optional() }).refine(value => Object.values(value).some(value => value !== undefined), 'Supply at least one setting.'), readOnly: false },
  { name: 'address_add', description: 'Add and activate the next wallet address after the highest saved index. Includes it in default balances and automatic receiving. Does not open an account on the network. Each call adds a different address.', schema: z.strictObject({}), readOnly: false },
  { name: 'address_derive', description: 'Derive an address at a mnemonic key index and save its public metadata. Does not open an account on the network.', schema: z.strictObject({ index: index.default(0) }), readOnly: false },
  { name: 'address_list', description: 'List previously derived addresses and which are active for balances and automatic receiving.', schema: z.strictObject({}), readOnly: true },
  { name: 'address_activate', description: 'Activate a key index for default balances and automatic receiving, deriving its address first if needed.', schema: z.strictObject({ index }), readOnly: false },
  { name: 'address_deactivate', description: 'Deactivate a key index locally. This does not remove its keys or alter its network account.', schema: z.strictObject({ index }), readOnly: false },
  { name: 'labels_set', description: 'Save a personal name for an address or existing wallet index, scoped to this profile and network. Names are unique after trimming and case-insensitive matching. Available without spending approval; labels are untrusted text and never uploaded.', schema: z.strictObject({ ...labelTarget, label: personalNameSchema }).refine(oneLabelTarget, 'Choose exactly one address or index.'), readOnly: false },
  { name: 'labels_remove', description: 'Remove a personal label for an address or existing wallet index. Idempotent; available without spending approval. Existing payment request destinations remain pinned.', schema: z.strictObject(labelTarget).refine(oneLabelTarget, 'Choose exactly one address or index.'), readOnly: false },
  { name: 'labels_get', description: 'Show personal and informational global address/voter labels for one address or saved index. refresh bypasses the global cache backoff. Sources and payout relationships remain distinct.', schema: z.strictObject({ ...labelTarget, refresh: z.boolean().optional() }).refine(oneLabelTarget, 'Choose exactly one address or index.'), readOnly: true },
  { name: 'labels_list', description: 'List personal labels; all includes LIVE global address and voter names. Search addresses, names, and entities case-insensitively. refresh forces a global refresh. Global names cannot resolve payments.', schema: z.strictObject({ all: z.boolean().optional(), search: z.string().max(4096).optional(), refresh: z.boolean().optional() }), readOnly: true },
  { name: 'account_get', description: 'Read an Atto account by public address or wallet key index. Defaults to index zero.', schema: z.strictObject({ address: address.optional(), index: index.optional() }).refine(value => !(value.address && value.index !== undefined), 'Specify an address or an index, not both.'), readOnly: true },
  { name: 'balances_get', description: 'Read individual and aggregate balances. Defaults to active wallet addresses. Select one saved index, explicit addresses (including foreign addresses), or all saved addresses with all=true.', schema: z.strictObject({ ...accountFields, all: z.boolean().optional() }).refine(singleSelection, 'Choose one account selection.'), readOnly: true },
  { name: 'transaction_get', description: 'Read a network transaction by hash.', schema: z.strictObject({ hash }), readOnly: true },
  { name: 'entry_get', description: 'Read an account entry by transaction hash.', schema: z.strictObject({ hash }), readOnly: true },
  { name: 'representative_weight', description: 'Read a representative address voting weight.', schema: z.strictObject({ address }), readOnly: true },
  { name: 'history_list', description: 'Read bounded account-entry history by default, or full transaction history. Defaults to active wallet addresses; index selects one saved account and addresses can include foreign accounts. Supports heights and a continuation cursor.', schema: z.strictObject({ event: z.enum(['transaction', 'entry']).default('entry'), ...accountFields, fromHeight: integer.optional(), toHeight: integer.optional(), ...listFields }).refine(singleSelection, 'Choose an index or addresses.'), readOnly: true },
  { name: 'receivables_list', description: 'Scan pending incoming payments, defaulting to active wallet addresses. Select a saved index or explicit addresses, including foreign accounts. This is a bounded scan, without continuation cursors; timedOut means the scan window ended and more payments may exist.', schema: z.strictObject({ ...accountFields, minAmountRaw: integer.optional(), limit: limit.optional(), timeoutMs: timeoutMs.optional() }).refine(singleSelection, 'Choose an index or addresses.'), readOnly: true },
  { name: 'send', description: 'Send funds to exactly one destination address, saved destinationIndex, or personal destinationLabel, subject to shared spending limits. Omit index to select an account from the approved pool. Explicit MCP indexes must belong to that pool and hold the full amount. Approved consolidation may combine pool funds only when index is omitted. Metadata is optional local journal data (up to 4096 UTF-8 bytes) and is never published on the network. USD uses an indicative price and requires accepted terms. Reuse requestId for retries; the original account, metadata, and USD conversion are preserved. Omit metadata to retain it; changed metadata is rejected.', schema: z.strictObject({ index: index.optional(), destination: address.optional(), destinationLabel: personalNameSchema.optional().describe('Exact personal name; global-only names fail locally. The original label and resolved address are pinned per request ID before network access.'), destinationIndex: index.optional().describe('Existing saved destination account index, instead of destination.'), amount: decimal, unit: z.enum(['ATTO', 'RAW', 'USD']).default('ATTO'), requestId: z.string().min(1).max(128), metadata: paymentMetadataSchema.optional() }).refine(value => [value.destination, value.destinationIndex, value.destinationLabel].filter(value => value !== undefined).length === 1, 'Choose exactly one destination address, destination index, or personal label.'), readOnly: false },
  { name: 'pool_get', description: 'Read the approved send pool, its account balances, and readiness for payments. Does not reserve an account or move funds.', schema: z.strictObject({}), readOnly: true },
  { name: 'journal_list', description: 'List local payment journal records, newest first, with an optional status filter. Includes caller metadata and recorded payment progress; metadata is not an authenticated statement from the network.', schema: z.strictObject({ limit: z.number().int().min(1).max(100).default(50), cursor: cursor.optional(), status: z.enum(['reserved', 'signed', 'published', 'unknown', 'failed']).optional() }), readOnly: true },
  { name: 'journal_get', description: 'Read a local payment journal record by its request ID, including caller metadata and recorded payment progress.', schema: z.strictObject({ requestId: z.string().min(1).max(128) }), readOnly: true },
  { name: 'metrics_get', description: 'Read public Atto market metrics and their observation date. Market prices are indicative, not executable exchange quotes.', schema: z.strictObject({}), readOnly: true },
  { name: 'price_quote', description: 'Convert a USD decimal amount to Atto using the public indicative price. Returns the price observation date and rejects data older than 72 hours. Does not send funds.', schema: z.strictObject({ amount: decimal }), readOnly: true },
  { name: 'terms_get', description: 'Read the current terms and version for USD-priced payments. Present the terms to the user before requesting acknowledgement.', schema: z.strictObject({}), readOnly: true },
  { name: 'terms_accept', description: 'Persist acknowledgement of the specified terms version for USD-priced payments. Call only after the user has read and explicitly accepted those terms.', schema: z.strictObject({ version: z.string().min(1).max(128), accepted: z.literal(true) }), readOnly: false },
  { name: 'receive', description: 'Receive one pending payment by hash, opening the account if needed.', schema: z.strictObject({ index: index.default(0), hash, representative: address.optional() }), readOnly: false },
  { name: 'receive_all', description: 'Receive a bounded set of pending payments for a key index, opening the account if needed.', schema: z.strictObject({ index: index.default(0), limit: limit.default(100), timeoutMs: timeoutMs.default(2000), representative: address.optional() }), readOnly: false },
  { name: 'representative_change', description: 'Publish a representative change for an existing account. Selecting its current representative returns REPRESENTATIVE_UNCHANGED without publishing.', schema: z.strictObject({ index: index.default(0), representative: address }), readOnly: false },
  { name: 'limits_get', description: 'Read spending policy, approved send pool, MCP access, proposal status, historical usage, reservations, and remaining allowances.', schema: z.strictObject({}), readOnly: true },
  { name: 'limits_propose', description: 'Propose spending limits, MCP access, and optional send-pool settings for local terminal approval. Omitted pool preserves the approved pool. Does not change active settings or grant access. A new proposal replaces the previous proposal and expires after 24 hours. Read limits_get for active settings and proposal status. Amounts are ATTO or RAW; null perRequest with empty rolling means unlimited spending if approved.', schema: z.strictObject({ policy, access: z.enum(['read-only', 'spend']).default('spend'), pool: pool.optional() }), readOnly: false },
  { name: 'watch_start', description: 'Start an observational, reconnecting watch for this session, defaulting to active wallet addresses. Choose one saved index, explicit addresses (including foreign accounts), a transaction/entry hash, or networkWide=true. Network-wide receivables are unsupported. Read buffered events and connection status with watch_read. Does not enable automatic receiving.', schema: z.strictObject({ event: z.enum(['account', 'transaction', 'entry', 'receivable']), ...streamFields, index: index.optional(), networkWide: z.boolean().optional() }).refine(singleSelection, 'Choose one watch selection.').refine(value => !(value.networkWide && value.event === 'receivable'), 'Receivable watches require addresses.'), readOnly: false },
  { name: 'watch_list', description: 'List watches owned by this process.', schema: z.strictObject({}), readOnly: true },
  { name: 'watch_read', description: 'Read buffered events after an optional numeric cursor. Gaps are reported if bounded event retention was exceeded.', schema: z.strictObject({ id: z.string().min(1).max(128), cursor: z.number().int().nonnegative().optional(), limit: limit.optional() }), readOnly: true },
  { name: 'watch_stop', description: 'Stop a watch owned by this process and cancel its network subscription.', schema: z.strictObject({ id: z.string().min(1).max(128) }), readOnly: false },
];

export function parseOperation(name: string, input: unknown = {}): Record<string, unknown> {
  const operation = operations.find(operation => operation.name === name);
  if (!operation) throw new AttoError('UNKNOWN_OPERATION', 'Unknown Atto operation.');
  const parsed = operation.schema.safeParse(input);
  if (!parsed.success) {
    // Do not echo invalid values: callers may accidentally supply a secret.
    const selectionError = parsed.error.issues.find(issue => issue.code === 'custom' && issue.path.length === 0);
    throw new AttoError('INVALID_INPUT', selectionError?.message ?? 'Invalid operation input. Inspect the operation schema or CLI help.', {
      fields: [...new Set(parsed.error.issues.map(issue => {
        const field = String(issue.path[0] ?? 'input');
        return Object.hasOwn(operation.schema.shape, field) ? field : 'input';
      }))],
    });
  }
  return parsed.data;
}
