process.env.KOTLIN_LOGGING_STARTUP_MESSAGE = 'false';
const [directory, epoch] = process.argv.slice(2);
if (directory && epoch) {
  const { StateStore } = await import('../storage/state.js');
  const { WalletWork } = await import('./work.js');
  let store: InstanceType<typeof StateStore> | undefined;
  let work: InstanceType<typeof WalletWork> | undefined;
  try {
    store = new StateStore(directory);
    const state = store;
    work = new WalletWork(state, () => state.get<import('./types.js').WalletSettings>('settings')!);
    await work.runDetached(epoch);
  } catch { /* Public jobs remain eligible after startup or storage failures. */ }
  finally { await work?.close(); store?.close(); }
}
export {};
