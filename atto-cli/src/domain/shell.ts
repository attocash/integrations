export type ShellKind = 'posix' | 'powershell';

export function currentShell(): ShellKind {
  return process.platform === 'win32' ? 'powershell' : 'posix';
}

export function quoteShellArgument(value: unknown, shell: ShellKind = currentShell()): string {
  const argument = String(value);
  if (/^[a-z\d_./:@=-]+$/i.test(argument)) return argument;
  return `'${argument.replace(/'/g, shell === 'powershell' ? "''" : "'\\''")}'`;
}
