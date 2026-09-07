import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = spawn(process.execPath, ['--test', fileURLToPath(new URL('../test/integration.test.mjs', import.meta.url))], {
  stdio: 'inherit', env: { ...process.env, ATTO_TEST_INTEGRATION: '1' },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('error', () => { process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
