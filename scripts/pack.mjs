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
const localCommonsVersion = process.env.ATTO_COMMONS_LOCAL_VERSION;

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
  const marketplaceDirectory = join(root, 'atto-marketplace-mcp');
  const nanoDirectory = join(root, 'atto-marketplace-nano-adapter');
  const cli = JSON.parse(await readFile(join(cliDirectory, 'package.json'), 'utf8'));
  const mcp = JSON.parse(await readFile(join(mcpDirectory, 'package.json'), 'utf8'));
  const marketplace = JSON.parse(await readFile(join(marketplaceDirectory, 'package.json'), 'utf8'));
  const nano = JSON.parse(await readFile(join(nanoDirectory, 'package.json'), 'utf8'));
  if (cli.name !== '@attocash/cli' || mcp.name !== '@attocash/mcp' || mcp.dependencies?.[cli.name] !== cli.version) {
    throw new Error('The MCP package must depend on the exact CLI version being packaged.');
  }
  if (marketplace.name !== '@attocash/marketplace-mcp' || marketplace.dependencies?.[cli.name] !== cli.version
      || marketplace.dependencies?.[nano.name] !== nano.version || marketplace.dependencies?.['@attocash/commons-core'] !== '8.0.2') {
    throw new Error('The Marketplace MCP artifact must retain Commons 8.0.2 and depend on the exact CLI and Nano wallet versions being packaged.');
  }
  if (nano.dependencies?.[cli.name] !== cli.version) throw new Error('The Nano adapter must depend on the exact CLI recovery-source library being packaged.');
  if (cli.bundleDependencies || cli.bundledDependencies) throw new Error('Keep bundled dependencies out of the source workspace manifest; packaging adds them only to the staged CLI artifact.');
  for (const manifest of [cli, mcp, nano, marketplace]) {
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
  if (localCommonsVersion) {
    if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(localCommonsVersion)) {
      throw new Error('ATTO_COMMONS_LOCAL_VERSION must be an exact semantic version, such as 8.1.0.');
    }
    const commonsPackages = [...packages.entries()].filter(([name]) => name.startsWith('@attocash/commons-'));
    const commonsVersions = await Promise.all(commonsPackages.map(async ([, directory]) =>
      JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).version));
    if (!commonsPackages.length || commonsVersions.some(version => version !== localCommonsVersion)) {
      throw new Error(`The installed Commons dependency closure must contain one version (${localCommonsVersion}); install the complete local Commons package set before packaging.`);
    }
  }

  const stage = await mkdtemp(join(tmpdir(), 'atto-package-'));
  try {
    const cliStage = join(stage, 'cli');
    const mcpStage = join(stage, 'mcp');
    const marketplaceStage = join(stage, 'atto-marketplace-mcp');
    const nanoStage = join(marketplaceStage, 'node_modules', nano.name);
    for (const [source, target] of [[cliDirectory, cliStage], [mcpDirectory, mcpStage], [marketplaceDirectory, marketplaceStage], [nanoDirectory, nanoStage]]) {
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
    for (const [manifest, directory] of [[cli, cliStage], [mcp, mcpStage], [nano, nanoStage], [marketplace, marketplaceStage]]) {
      const { scripts, devDependencies, overrides, bundleDependencies, bundledDependencies, ...published } = manifest;
      if (manifest === cli) {
        published.bundleDependencies = bundled;
        if (localCommonsVersion) {
          for (const name of bundled.filter(name => name.startsWith('@attocash/commons-'))) {
            if (!published.dependencies?.[name]) throw new Error(`The CLI source manifest does not declare bundled dependency ${name}.`);
            // The local 8.1.0 package is private and unpublished. Keep source
            // manifests pinned to registry versions, but align this artifact's
            // dependencies with the exact Commons packages copied into it.
            published.dependencies[name] = localCommonsVersion;
          }
        }
      }
      // External dependencies belong to the containing package; retaining them
      // here makes npm global installs misclassify them as bundled dependencies.
      if (manifest === nano) delete published.dependencies;
      if (manifest === marketplace) {
        published.bundleDependencies = [nano.name];
        // npm does not install missing transitive dependencies of bundled packages.
        // Keep the adapter's external dependencies on the Marketplace package.
        for (const [name, version] of Object.entries(nano.dependencies)) {
          if (published.dependencies[name] && published.dependencies[name] !== version) {
            throw new Error(`The embedded Nano adapter requires the same ${name} version as Marketplace MCP.`);
          }
          published.dependencies[name] = version;
        }
      }
      await writeFile(join(directory, 'package.json'), `${JSON.stringify(published, null, 2)}\n`);
    }
    for (const [manifest, directory] of [[cli, cliStage], [mcp, mcpStage], [marketplace, marketplaceStage]]) {
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
