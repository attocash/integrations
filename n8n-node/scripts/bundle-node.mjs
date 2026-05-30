import { rename } from 'node:fs/promises';
import { build } from 'esbuild';

const entryPoints = [
	'dist/nodes/Atto/Atto.node.js',
	'dist/nodes/AttoTrigger/AttoTrigger.node.js',
];

for (const entryPoint of entryPoints) {
	const outfile = entryPoint.replace(/\.js$/, '.bundle.js');

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
}
