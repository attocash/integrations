import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { tmpdir } from '../../test/support/temporary-directory.mjs';

const execute = promisify(execFile);
const harness = join(import.meta.dirname, 'support/run-terminal.py');
// Exercise both host EOF conventions with a real PTY and child on every POSIX
// host: macOS returns empty bytes, while Linux normally raises EIO.
const normalizeEof = `
import errno, os, runpy, sys
helper, eof, request = sys.argv[1:]
read = os.read
def terminal_read(fd, size):
    try:
        chunk = read(fd, size)
    except OSError as error:
        if error.errno != errno.EIO:
            raise
        chunk = b""
    if not chunk and eof == "EIO":
        raise OSError(errno.EIO, "Terminal closed")
    return chunk
os.read = terminal_read
sys.argv = [helper, request]
runpy.run_path(helper, run_name="__main__")
`;

async function runTerminal(t, eof, { closeBeforeExit = false, delay = 0, timeoutSeconds = 2 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'marketplace-terminal-harness-'));
  const pidPath = join(root, 'child.pid');
  t.after(async () => {
    // Also clean up the fixture if a broken harness fails its outer deadline.
    try { process.kill(Number(await readFile(pidPath, 'utf8')), 'SIGKILL'); }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    await rm(root, { recursive: true, force: true });
  });
  const source = `
import os, sys, time
with open(sys.argv[1], "w") as output:
    output.write(str(os.getpid()))
print("terminal fixture complete", flush=True)
if ${closeBeforeExit ? 'True' : 'False'}:
    for fd in (0, 1, 2):
        os.close(fd)
time.sleep(${delay})
os._exit(23)
`;
  const request = { command: ['python3', '-c', source, pidPath], timeoutSeconds };
  const started = performance.now();
  const { stdout, stderr } = await execute('python3', ['-c', normalizeEof, harness, eof, JSON.stringify(request)], {
    timeout: 5_000, maxBuffer: 1_048_576,
  });
  assert.equal(stderr, '');
  const result = JSON.parse(stdout);
  if (result.timedOut) assert.ok(performance.now() - started >= timeoutSeconds * 1_000, 'A timeout must wait for the deadline.');
  const pid = Number(await readFile(pidPath, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'The terminal child must be reaped.');
  assert.equal(Buffer.from(result.transcriptBase64, 'base64').toString('utf8').replaceAll('\r', ''), 'terminal fixture complete\n');
  return result;
}

for (const eof of ['empty bytes', 'EIO']) {
  test(`terminal harness reaps an exiting child with ${eof} EOF`, { skip: process.platform === 'win32' }, async t => {
    // Given a real child connected to the selected PTY EOF convention.
    // When the harness waits for completion or its deadline.
    const result = await runTerminal(t, eof);
    // Then the result distinguishes completion from a timeout.
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, 23);
  });

  test(`terminal harness waits for a running child after ${eof} EOF`, { skip: process.platform === 'win32' }, async t => {
    // Given a real child connected to the selected PTY EOF convention.
    // When the harness waits for completion or its deadline.
    const result = await runTerminal(t, eof, { closeBeforeExit: true, delay: 0.3 });
    // Then the result distinguishes completion from a timeout.
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, 23);
  });

  test(`terminal harness kills and reaps a timed-out child after ${eof} EOF`, { skip: process.platform === 'win32' }, async t => {
    // Given a real child connected to the selected PTY EOF convention.
    // When the harness waits for completion or its deadline.
    const result = await runTerminal(t, eof, { closeBeforeExit: true, delay: 30, timeoutSeconds: 0.3 });
    // Then the result distinguishes completion from a timeout.
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, -9);
  });
}

test('terminal harness kills and reaps a timed-out child while its terminal remains open', { skip: process.platform === 'win32' }, async t => {
  // Given a real child that keeps its terminal open beyond the deadline.
  // When the harness reaches that deadline.
  const result = await runTerminal(t, 'empty bytes', { delay: 30, timeoutSeconds: 0.3 });
  // Then the child is terminated and its timeout is reported.
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, -9);
});
