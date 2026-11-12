import { fileURLToPath } from 'node:url';

export const marketplaceCommand = `${process.platform === 'win32' ? '& ' : ''}${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(new URL('./main.js', import.meta.url)))}`;

/** Commands shown by the local terminal use PowerShell literals on Windows. */
export function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`;
}
