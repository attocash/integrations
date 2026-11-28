import { appendFileSync, closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [directory, fixedArg, ...args] = process.argv.slice(2);
if (existsSync(join(directory, 'argv-only'))) {
  closeSync(0);
  writeFileSync(join(process.env.HOST_QUEUE_DIR, 'queued-' + args[0]), JSON.stringify(args));
  process.exit(0);
}
const event = JSON.parse(readFileSync(0, 'utf8'));
const leaking = 'MARKETPLACE_TEST_SECRET' in process.env || 'MARKETPLACE_MCP_HOME' in process.env || 'UNRELATED_ALIAS' in process.env || 'LEGACY_ALIAS' in process.env;
appendFileSync(join(directory, 'attempts'), JSON.stringify({event, args, fixedArg, leaking}) + '\n');
if (existsSync(join(directory, 'fail-' + event.id))) process.exit(7);
const key = event.type === 'application.hired' ? event.applicationId : event.id;
try { writeFileSync(join(directory, 'job-' + key), JSON.stringify(event), {flag: 'wx'}); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
// Keep the first successful enqueue open to simulate listener death before acknowledgement.
if (existsSync(join(directory, 'hold-' + event.id))) {
  closeSync(openSync(join(directory, 'enqueued'), 'w'));
  while (existsSync(join(directory, 'hold-' + event.id))) await delay(50);
}
