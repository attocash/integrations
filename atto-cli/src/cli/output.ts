import type { ReceiveProgress } from '../wallet/auto-receive.js';
import { modelAddress } from '../labels/presentation.js';
import { AttoBlock } from '@attocash/commons-core';
import { amountOutput } from '../domain/amount.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Public network data and caller metadata must not control the terminal. */
function text(value: unknown): string {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function label(key: string): string {
  const names: Record<string, string> = {
    id: 'ID', requestId: 'Request ID', raw: 'RAW', atto: 'ATTO', usd: 'USD',
    priceUsd: 'Price per ATTO (USD)', nodeUrl: 'Node URL', workerUrl: 'Worker URL',
    mcpAccess: 'Agent access', perRequest: 'Per payment', minReceiveRaw: 'Minimum receive (RAW)',
    weight: 'Weight (RAW)',
    directory: 'Profile', receivingInThisProcess: 'Receiving in this process',
  };
  if (Object.hasOwn(names, key)) return names[key]!;
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  return text(words.charAt(0).toUpperCase() + words.slice(1));
}

function transactionSummary(value: Record<string, unknown>): Record<string, unknown> {
  const block = record(value.block) ? value.block : value;
  let hash = value.hash;
  if (!hash && record(value.block)) {
    try { hash = AttoBlock.fromJson(JSON.stringify(value.block)).hash.toString(); } catch { /* Partial public results can omit protocol fields. */ }
  }
  return Object.fromEntries(Object.entries({
    type: block.type ?? block.blockType, network: block.network,
    address: modelAddress(block), destination: modelAddress(block, 'receiver'), subject: modelAddress(block, 'subject'),
    representative: modelAddress(block, 'representative'), amount: block.amount,
    balance: block.balance, previousBalance: block.previousBalance,
    height: block.height, timestamp: block.timestamp, hash, sendHash: block.sendHash,
  }).filter(([, value]) => value !== undefined));
}

function inline(value: unknown, literalKeys: boolean): string | undefined {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value !== 'object') return text(value);
  if (Array.isArray(value)) {
    if (!value.length) return 'None';
    if (value.every(item => item === null || typeof item !== 'object')) return value.map(item => inline(item, literalKeys)).join(', ');
  } else {
    if (!Object.keys(value).length) return 'None';
    if (!literalKeys && record(value) && Object.keys(value).length === 2
      && typeof value.atto === 'string' && typeof value.raw === 'string') {
      return `${text(value.atto)} ATTO (${text(value.raw)} RAW)`;
    }
  }
  return undefined;
}

function fields(value: unknown, indent = '', literalKeys = false): string[] {
  const short = inline(value, literalKeys);
  if (short !== undefined) return [`${indent}${short}`];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => [`${indent}${index + 1}.`, ...fields(item, `${indent}  `, literalKeys)]);
  }
  const object = value as Record<string, unknown>;
  return Object.entries(object).flatMap(([key, value]) => {
    // Serialized journal blocks are recovery/debugging data available in --json.
    if (!literalKeys && ['blockJson', 'signature', 'work', 'addressLabels', 'globalDirectory'].includes(key)) return [];
    const literal = literalKeys || key === 'metadata';
    // Core monetary fields use RAW unless they include units or an ATTO/RAW pair.
    const raw = ['amount', 'balance', 'previousBalance'].includes(key) && typeof value !== 'object' && !Object.hasOwn(object, 'unit');
    const name = literalKeys ? text(key) : label(key);
    const displayValue = raw && !literal && typeof value === 'string' && /^\d+$/.test(value) ? amountOutput(value) : value;
    const short = value === null && key === 'perRequest' && !literal ? 'Unlimited' : inline(displayValue, literal);
    return short === undefined
      ? [`${indent}${name}:`, ...fields(value, `${indent}  `, literal)]
      : [`${indent}${name}: ${short}`];
  });
}

function addressSummary(value: unknown): unknown {
  if (!record(value)) return value;
  return { index: value.index, address: value.address, active: value.active };
}

function receiveProgress(progress: ReceiveProgress): string {
  if (progress.event === 'reconnecting') {
    return `Receiving connection interrupted: ${text(progress.error.code)}: ${text(progress.error.message)} Retrying in ${progress.retryInMs / 1000}s.\n`;
  }
  const payment = `${text(progress.amount.atto)} ATTO for account ${text(progress.index)} ${text(progress.address)} (send ${text(progress.sendHash)})`;
  switch (progress.event) {
    case 'pending': return `Pending: ${payment}\n`;
    case 'receiving': return `Receiving: ${payment}\n`;
    case 'received': return `Received: ${payment}\n${progress.receiveHash ? `Receive transaction: ${text(progress.receiveHash)}\n` : ''}`;
    case 'retry': return `Receive delayed: ${payment}\n${text(progress.error.code)}: ${text(progress.error.message)} Retrying in ${progress.retryInMs / 1000}s.\n`;
    case 'skipped': return `Skipped: ${payment}\n${text(progress.error.code)}: ${text(progress.error.message)}\n`;
  }
}

/** Human presentation belongs to the CLI; engine and MCP results stay intact. */
function formatUnlabeledHumanResult(result: unknown, operation?: string): string {
  if (operation === 'receive_progress') return receiveProgress(result as ReceiveProgress);
  if (record(result)) {
    if (operation === 'doctor' && Array.isArray(result.checks)) {
      const checks = result.checks.filter(record).map(check => {
        const heading = `[${text(check.status).toUpperCase()}] ${text(check.id)} (${text(check.code)}): ${text(check.message)}`;
        const evidence = record(check.evidence) ? fields(check.evidence, '  ').join('\n') + '\n' : '';
        const remediation = record(check.remediation) ? check.remediation : undefined;
        const steps = Array.isArray(remediation?.steps) ? remediation.steps.map(step => `  ${text(step)}\n`).join('') : '';
        const quoteArgument = (value: unknown) => {
          const argument = String(value);
          if (/^[a-z\d_./:@=-]+$/i.test(argument)) return argument;
          return `'${argument.replace(/'/g, process.platform === 'win32' ? "''" : "'\\''")}'`;
        };
        const command = Array.isArray(remediation?.command)
          ? `  Command${process.platform === 'win32' ? ' (PowerShell)' : ''}: ${text(remediation.command.map(quoteArgument).join(' '))}\n` : '';
        const env = record(remediation?.suggestedEnv) ? `  Verified MCP env configuration:\n${fields(remediation.suggestedEnv, '    ', true).join('\n')}\n` : '';
        return `${heading}\n${evidence}${steps}${command}${env}`;
      });
      return `Doctor: ${text(result.status).toUpperCase()}\n${fields(result.context).join('\n')}\n\n${checks.join('\n')}\nCompleted in ${text(result.durationMs)} ms. Diagnostics only; no repairs applied.\n`;
    }
    if (['wallet_create', 'wallet_import'].includes(operation ?? '') && record(result.identity)) {
      return `Wallet ${operation === 'wallet_create' ? 'created' : 'imported'}.\nAddress: ${text(result.identity.address)}\n`;
    }
    if ((operation === 'wallet_status' || operation === 'wallet_receive') && record(result.settings)) {
      const receiver = record(result.autoReceive) ? result.autoReceive : {};
      const values = {
        directory: result.directory,
        status: result.resetPending ? 'Reset unfinished; run wallet reset to finish cleanup' : result.initialized ? 'Initialized' : 'Not initialized',
        address: record(result.identity) ? result.identity.address : null,
        network: result.settings.network,
        automaticReceiving: result.settings.autoReceive ? 'Enabled' : 'Disabled',
        ...(operation === 'wallet_status' ? { receivingInThisProcess: receiver.running, lastReceiveError: receiver.lastError } : {}),
        representative: result.settings.representative,
        minReceiveRaw: result.settings.minReceiveRaw,
        nodeUrl: result.settings.nodeUrl,
        workerUrl: result.settings.workerUrl,
        addresses: Array.isArray(result.addresses) ? result.addresses.map(addressSummary) : result.addresses,
        pool: result.pool,
        pendingPayments: result.pendingSends,
      };
      const notice = operation === 'wallet_receive' ? 'Automatic receiving session. Press Ctrl+C to stop.\n' : '';
      return notice + fields(values).join('\n') + '\n';
    }
    if (operation === 'address_list' && Array.isArray(result.addresses)) {
      if (!result.addresses.length) return 'No wallet addresses. Create or import a wallet first.\n';
      return fields({ addresses: result.addresses.map(addressSummary) }).join('\n') + '\n';
    }
    if (['address_add', 'address_derive', 'address_activate', 'address_deactivate'].includes(operation ?? '')) {
      return fields(addressSummary(result)).join('\n') + '\n';
    }
    if (['send', 'receive', 'representative_change'].includes(operation ?? '') && record(result.transaction)) {
      const transaction = transactionSummary(result.transaction);
      const summary = {
        status: result.status, requestId: result.requestId, index: result.index,
        amount: result.amount ?? transaction.amount, source: result.sourceAddress ?? transaction.address,
        destination: result.destination ?? transaction.destination, destinationBinding: result.destinationBinding, representative: transaction.representative,
        hash: result.hash, sendHash: transaction.sendHash,
        quote: result.quote, metadata: result.metadata, consolidation: result.consolidation,
      };
      const notice = record(result.quote) ? 'Indicative conversion only; this is not an executable exchange quote.\n' : '';
      return notice + fields(Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined))).join('\n') + '\n';
    }
    if (['labels_get', 'labels_list'].includes(operation ?? '') && record(result.addressLabels)) {
      return fields({ network: result.network, labels: Object.entries(result.addressLabels).map(([address, value]) => ({ address, ...(record(value) ? value : {}) })), directoryStatus: result.globalDirectory }).join('\n') + '\n';
    }
    if (operation === 'account_get') {
      if (!record(result.account)) return 'Account is not open on the network. Receiving funds opens an account.\n';
      return fields({ ...transactionSummary(result.account), lastTransactionHash: result.account.lastTransactionHash }).join('\n') + '\n';
    }
    if (['transaction_get', 'entry_get'].includes(operation ?? '')) {
      const value = result.transaction ?? result.entry;
      return record(value) ? fields(transactionSummary(value)).join('\n') + '\n' : 'No matching network record found.\n';
    }
    if (operation === 'balances_get' && Array.isArray(result.balances) && !result.balances.length) {
      return 'No matching wallet accounts. Use address add, address activate, or balances --all.\n';
    }
    if (['history_list', 'receivables_list', 'journal_list'].includes(operation ?? '') && Array.isArray(result.items)) {
      const items = operation === 'journal_list' ? result.items : result.items.map(value => record(value) ? transactionSummary(value) : value);
      const body = items.length ? fields({ items }).join('\n') + '\n'
        : operation === 'receivables_list' ? 'No pending payments found during this scan.\n'
          : operation === 'journal_list' ? 'No payment journal records found.\n' : 'No matching account history found.\n';
      return body + (result.timedOut ? 'Scan window ended; results may be incomplete.\n' : '')
        + (result.limitReached ? 'Record limit reached; more payments may remain.\n' : '')
        + (result.nextCursor ? `Next cursor: ${text(result.nextCursor)}\n` : '');
    }
    if (operation === 'watch_read' && Array.isArray(result.events)) {
      return fields({ ...result, events: result.events.map(event => record(event)
        ? { ...event, data: record(event.data) ? transactionSummary(event.data) : event.data } : event) }).join('\n') + '\n';
    }
    if (operation === 'receive_all' && Array.isArray(result.results)) {
      return `Received ${result.results.length} payment${result.results.length === 1 ? '' : 's'}.\n`
        + result.results.map(value => formatHumanResult(value, 'receive')).join('')
        + (result.timedOut || result.limitReached ? `${result.limitReached ? 'Batch limit reached' : 'Scan window ended'}; more payments may remain. Run receive-all again or wallet receive for continuous receiving.\n` : '');
    }
  }
  if (operation === 'operations' && Array.isArray(result)) {
    return result.map(item => record(item)
      ? `${text(item.name)} (${item.readOnly ? 'read-only' : 'write'})\n  ${text(item.description)}`
      : text(item)).join('\n') + '\n';
  }
  const indicative = record(result) && (result.informational === true || (record(result.quote) && result.quote.informational === true));
  const notice = indicative ? 'Indicative conversion only; this is not an executable exchange quote.\n' : '';
  return notice + fields(result).join('\n') + '\n';
}

/** Render names next to full addresses only at the human-output boundary. */
export function formatHumanResult(result: unknown, operation?: string): string {
  const output = formatUnlabeledHumanResult(result, operation);
  if (!record(result) || !record(result.addressLabels)) return output;
  const dictionary = result.addressLabels;
  return output.replace(/atto:\/\/[a-z2-7]+/g, address => {
    const labels = dictionary[address];
    if (!record(labels)) return address;
    const binding = record(result.destinationBinding) && result.destinationBinding.address === address ? result.destinationBinding : undefined;
    const personal = binding?.label ?? (record(labels.personal) ? labels.personal.label : undefined);
    const global = Array.isArray(labels.global) ? labels.global.filter(record).map(value => `${text(value.label)} [global${value.stale ? ', stale' : ''}]`) : [];
    const names = [...(personal ? [`${text(personal)} [personal]`] : []), ...global];
    return names.length ? `${address} (${names.join('; ')})` : address;
  });
}
