import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundled = [
  '@attocash/commons-core', '@attocash/commons-node', '@attocash/commons-node-remote',
  '@attocash/commons-worker-remote',
];

async function packageDirectory(name, parent) {
  const require = createRequire(join(parent, 'package.json'));
  let entry;
  try { entry = require.resolve(`${name}/package.json`); }
  catch { entry = require.resolve(name); }
  let directory = dirname(await realpath(entry));
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (manifest.name === name) return directory;
    } catch {}
    const next = dirname(directory);
    if (next === directory) throw new Error(`Cannot locate the installed manifest for ${name}.`);
    directory = next;
  }
}

async function pack() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--pack-destination')) {
    throw new Error('Use npm run pack -- --pack-destination <directory>.');
  }
  const destination = resolve(args[1] ?? root);
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Run packaging through npm run pack.');
  const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const cliDirectory = join(root, 'atto-cli');
  const mcpDirectory = join(root, 'atto-mcp');
  const cli = JSON.parse(await readFile(join(cliDirectory, 'package.json'), 'utf8'));
  const mcp = JSON.parse(await readFile(join(mcpDirectory, 'package.json'), 'utf8'));
  if (cli.name !== '@attocash/cli' || mcp.name !== '@attocash/mcp' || mcp.dependencies?.[cli.name] !== cli.version) {
    throw new Error('The MCP package must depend on the exact CLI version being packaged.');
  }
  if (cli.bundleDependencies || cli.bundledDependencies) throw new Error('Keep bundled dependencies out of the source workspace manifest; packaging adds them only to the staged CLI artifact.');
  for (const manifest of [cli, mcp]) {
    if (Object.values(manifest.dependencies ?? {}).some(version => /^(?:workspace:|file:|link:)/.test(version))) {
      throw new Error('Published dependencies must use registry versions rather than workspace or file paths.');
    }
  }
  const packages = new Map();
  const pending = bundled.map(name => ({ name, parent: cliDirectory }));
  while (pending.length) {
    const { name, parent } = pending.pop();
    const directory = await packageDirectory(name, parent);
    const previous = packages.get(name);
    if (previous) {
      if (previous !== directory) throw new Error(`Packaging requires one resolved copy of ${name}; run npm ci and check the dependency tree.`);
      continue;
    }
    packages.set(name, directory);
    const dependency = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    for (const child of Object.keys(dependency.dependencies ?? {})) pending.push({ name: child, parent: directory });
  }
  const ws = JSON.parse(await readFile(join(packages.get('ws'), 'package.json'), 'utf8'));
  if (ws.version !== rootManifest.overrides.ws) throw new Error('Installed ws does not match the patched override; run npm ci before packaging.');

  const stage = await mkdtemp(join(tmpdir(), 'atto-package-'));
  try {
    const cliStage = join(stage, 'cli');
    const mcpStage = join(stage, 'mcp');
    for (const [source, target] of [[cliDirectory, cliStage], [mcpDirectory, mcpStage]]) {
      await mkdir(target, { recursive: true });
      for (const file of ['dist', 'README.md', 'LICENSE']) await cp(join(source, file), join(target, file), { recursive: true });
    }
    for (const [name, directory] of packages) {
      const target = join(cliStage, 'node_modules', name);
      await mkdir(dirname(target), { recursive: true });
      // Copy only resolved production packages. Dev packages and native keyring
      // bindings are outside this dependency closure and stay unbundled.
      await cp(directory, target, { recursive: true, dereference: true, filter: source => source === directory || !source.slice(directory.length + 1).split(/[\\/]/).includes('node_modules') });
    }
    await mkdir(destination, { recursive: true });
    for (const [manifest, directory] of [[cli, cliStage], [mcp, mcpStage]]) {
      const { scripts, devDependencies, overrides, bundleDependencies, bundledDependencies, ...published } = manifest;
      if (manifest === cli) published.bundleDependencies = bundled;
      await writeFile(join(directory, 'package.json'), `${JSON.stringify(published, null, 2)}\n`);
      await execute(process.execPath, [npm, 'pack', '--ignore-scripts', '--quiet', '--pack-destination', destination], {
        cwd: directory, timeout: 60_000, maxBuffer: 1024 * 1024,
      });
      const filename = `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`;
      const artifact = join(destination, filename);
      if (!(await stat(artifact)).isFile()) throw new Error('npm did not create the expected package artifact.');
      process.stdout.write(`${artifact}\n`);
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

try { await pack(); }
catch (error) {
  process.stderr.write(`${error.code ? 'Packaging failed. Check npm, the installed dependencies, and the destination directory.' : error.message}\n`);
  process.exitCode = 1;
}
