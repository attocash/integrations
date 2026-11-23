/** Terminal commands opt into JSON locally; protocol output never uses this presenter. */
export function takeJsonFlag(argv: string[]): { argv: string[]; json: boolean } {
  return { argv: argv.filter(value => value !== '--json'), json: argv.includes('--json') };
}

/** Keep paths, remote labels and signed terms from controlling a person's terminal. */
export function terminalText(value: unknown): string {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

const labels: Record<string, string> = {
  profileId: 'Profile', origin: 'Marketplace', marketplaceOrigin: 'Marketplace', audience: 'Audience',
  home: 'Configuration', rpcUrl: 'RPC', workUrl: 'Work', signedInWorkUrl: 'Work when signed in', walletDirectory: 'Controller wallet', nativeNetwork: 'Native network',
  controllerNetwork: 'Controller network', controllerAddress: 'Controller address', controllerIndex: 'Controller index',
  walletCommand: 'Approve with', resumeCommand: 'Continue with', responsePath: 'Approval file',
};
function label(key: string): string {
  return labels[key] ?? key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, value => value.toUpperCase());
}

/** Render public results and exact approval terms without hiding nested values. */
export function terminalFields(value: unknown, indentation = ''): string {
  if (Array.isArray(value)) {
    if (!value.length) return `${indentation}(none)`;
    return value.map(item => item !== null && typeof item === 'object'
      ? `${indentation}-\n${terminalFields(item, `${indentation}  `)}`
      : `${indentation}- ${terminalText(item)}`).join('\n');
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) =>
      item !== null && typeof item === 'object'
        ? `${indentation}${terminalText(label(key))}:\n${terminalFields(item, `${indentation}  `)}`
        : `${indentation}${terminalText(label(key))}: ${terminalText(item)}`).join('\n');
  }
  return `${indentation}${terminalText(value)}`;
}

export function writeTerminalResult(value: unknown, json = false): void {
  if (json) { process.stdout.write(`${JSON.stringify(value)}\n`); return; }
  const record = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const headings: Record<string, string> = { ready: 'Marketplace MCP is ready.', 'wallet-configured': 'Wallet is configured.',
    approval_required: 'Marketplace approval is required.' };
  const heading = record && typeof record.status === 'string' ? headings[record.status] : undefined;
  if (heading && record) {
    const { status: _status, ...fields } = record;
    process.stdout.write(`${heading}\n${terminalFields(fields)}\n`);
  } else process.stdout.write(`${terminalFields(value)}\n`);
}
