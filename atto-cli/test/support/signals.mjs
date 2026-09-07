// Windows child.kill('SIGINT') terminates the process without delivering Ctrl+C.
// Use the fixture's IPC channel to exercise its real shutdown handlers there;
// Unix tests continue to deliver the OS signal. The override tests this path locally.
export const sigintHarness = `
  process.on('message', signal => {
    if (signal === 'SIGINT') process.emit('SIGINT');
  });
`;

export function interruptCli(child) {
  if (process.platform === 'win32' || process.env.ATTO_TEST_EMULATE_SIGINT === '1') child.send('SIGINT');
  else child.kill('SIGINT');
}
