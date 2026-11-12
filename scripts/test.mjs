import { spawn } from 'node:child_process';
import { globSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectPlatformTests, reportPlatformExclusions } from './test-platform.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const patterns = process.argv.slice(2);
if (!patterns.length) throw new Error('Specify test files or glob patterns.');
const files = globSync(patterns).map(file => relative(root, resolve(file))).sort();
if (!files.length) throw new Error('No tests matched the requested patterns.');
const { included, excluded } = selectPlatformTests(files);
reportPlatformExclusions(excluded);
if (!included.length) throw new Error('No supported tests matched the requested patterns.');

// Bound individual tests and the whole runner, including failed-fixture handles.
// CI adds a separate hard step deadline so orphaned processes cannot occupy a job.
const runnerMinutes = 8;
const reporter = process.platform === 'win32' ? ['--test-reporter=tap'] : [];
const child = spawn(process.execPath, ['--test', ...reporter, '--test-timeout=180000', ...included], {
  cwd: root, stdio: 'inherit', timeout: runnerMinutes * 60_000,
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => {
  if (signal) console.error(`Test runner terminated with ${signal}; its process limit is ${runnerMinutes} minutes.`);
  process.exitCode = code ?? 1;
});
