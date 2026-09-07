process.env.KOTLIN_LOGGING_STARTUP_MESSAGE = 'false';
const [directory, token] = process.argv.slice(2);
if (directory && token) {
  const { setTimeout: delay } = await import('node:timers/promises');
  const { StateStore } = await import('../storage/state.js');
  const { AttoApplication } = await import('../application/app.js');
  const { BackgroundReceiver, requireReceivingProfile } = await import('./background-receive.js');
  const { errorResult } = await import('../domain/errors.js');
  let store: InstanceType<typeof StateStore> | undefined;
  let application: InstanceType<typeof AttoApplication> | undefined;
  let receiver: InstanceType<typeof BackgroundReceiver> | undefined;
  let release: (() => void) | undefined;
  const stop = () => receiver?.update(token, { desired: false, state: 'stopping' });
  try {
    store = new StateStore(directory);
    receiver = new BackgroundReceiver(store);
    release = receiver.claim(token);
    if (release) {
      requireReceivingProfile(store);
      const owner = receiver;
      application = new AttoApplication({
        directory, receivingAllowed: () => !owner.stopping(token),
        onReceiveProgress: event => owner.progress(token, event),
      });
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      receiver.update(token, { state: 'running' });
      // Acknowledge local construction/ownership before starting any network or
      // password-store operation. IPC is detached immediately after the reply.
      if (process.connected) await new Promise<void>((resolve, reject) => {
        process.send!({ ready: token }, error => error ? reject(error) : resolve());
      });
      if (process.connected) process.disconnect();
      if (!receiver.stopping(token)) {
        void application.start().catch(error => owner.update(token, { lastError: errorResult(error) }));
        while (!receiver.stopping(token)) await delay(100);
      }
    }
  } catch (error) {
    if (release) receiver?.update(token, { desired: false, state: 'stopping', lastError: errorResult(error) });
  } finally {
    // Keep ownership and stopping visible until the current receive, startup
    // lookups, and work requests have all finished or been canceled.
    if (release) receiver?.update(token, { desired: false, state: 'stopping' });
    await application?.close();
    if (release) receiver?.update(token, { desired: false, state: 'stopped' });
    release?.();
    store?.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (process.connected) process.disconnect();
  }
}
export {};
