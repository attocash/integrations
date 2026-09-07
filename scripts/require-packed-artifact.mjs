// npm run pack invokes its prepack lifecycle too; allow that explicit script.
if (!['run', 'run-script'].includes(process.env.npm_command)) {
  process.stderr.write('Run npm run pack from the repository root to create the CLI and MCP artifacts with patched Commons dependencies. Install the resulting .tgz files.\n');
  process.exitCode = 1;
}
