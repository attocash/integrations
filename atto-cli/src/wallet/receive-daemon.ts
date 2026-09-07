import { setTimeout as delay } from 'node:timers/promises';
import { AttoApplication } from '../application/app.js';
import { errorResult } from '../domain/errors.js';

const directory = process.argv[2];
if (!directory) process.exitCode = 1;
else {
  const app = new AttoApplication({ directory });
  const release = app.store.tryProcessLock('receive-daemon');
  if (!release) await app.close();
  else {
    try {
      await app.start();
      while ((app.store.get<{ desired: boolean }>('receive.background')?.desired ?? false)) await delay(250);
      app.store.set('receive.background', { desired: false, state: 'stopped', lastError: null });
    } catch (error) {
      app.store.set('receive.background', { desired: false, state: 'stopped', lastError: errorResult(error) });
    } finally { release(); await app.close(); }
  }
}
