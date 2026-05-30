import { rename } from 'node:fs/promises';
import { build } from 'esbuild';

const entryPoint = 'dist/nodes/Atto/Atto.node.js';
const outfile = 'dist/nodes/Atto/Atto.node.bundle.js';

await build({
	entryPoints: [entryPoint],
	outfile,
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node22.16',
	mainFields: ['module', 'main'],
	external: ['n8n-workflow'],
	logLevel: 'silent',
});

await rename(outfile, entryPoint);
