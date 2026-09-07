import { StateStore } from '../storage/state.js';
import { WalletWork } from './work.js';
import type { WalletSettings } from './types.js';

const directory = process.argv[2];
if (!directory) process.exitCode = 1;
else {
  const store = new StateStore(directory);
  const release = store.tryProcessLock('work-daemon');
  if (!release) store.close();
  else {
    const work = new WalletWork(store, () => store.get<WalletSettings>('settings')!);
    const timer = setTimeout(() => process.exitCode = 0, 60_000);
    work.drainPersisted();
    // Work requests have a ten-second speculative deadline; allow queued work
    // to settle, then close without retaining a service.
    setTimeout(async () => { clearTimeout(timer); await work.close(); release(); store.close(); }, 59_000);
  }
}
