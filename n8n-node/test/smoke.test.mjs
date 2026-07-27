import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function findJavaScriptFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return findJavaScriptFiles(path);
		return entry.name.endsWith('.js') ? [path] : [];
	});
}

test('build artifacts required by n8n are present', async () => {
	const required = [
		'dist/credentials/AttoApi.credentials.js',
		'dist/nodes/Atto/Atto.node.js',
		'dist/nodes/Atto/Atto.node.json',
		'dist/nodes/Atto/atto.svg',
		'dist/nodes/AttoTrigger/AttoTrigger.node.js',
		'dist/nodes/AttoTrigger/AttoTrigger.node.json',
		'dist/nodes/AttoTrigger/atto.svg',
	];

	for (const file of required) {
		assert.equal(existsSync(file), true, `${file} should exist`);
	}

	const node = await import('../dist/nodes/Atto/Atto.node.js');
	const trigger = await import('../dist/nodes/AttoTrigger/AttoTrigger.node.js');
	const credentials = await import('../dist/credentials/AttoApi.credentials.js');

	assert.equal(typeof node.Atto, 'function');
	assert.equal(typeof trigger.AttoTrigger, 'function');
	assert.equal(typeof credentials.AttoApi, 'function');

	const attoApi = new credentials.AttoApi();
	assert.equal(attoApi.test.request.baseURL, '={{$credentials.nodeUrl}}');
	assert.equal(attoApi.test.request.url, '/');
	assert.equal(attoApi.test.request.method, 'GET');
	assert.doesNotMatch(JSON.stringify(attoApi.test), /walletSecret|walletMaterialType|privateKey|mnemonic/i);
});

test('runtime bundle excludes console calls and Kotlin console logging', () => {
	for (const file of findJavaScriptFiles('dist')) {
		const source = readFileSync(file, 'utf8');
		assert.doesNotMatch(source, /console\.(?:log|debug|info|warn|error)\s*\(/, file);
		assert.doesNotMatch(source, /BufferedOutputToConsoleLog/, file);
		assert.doesNotMatch(
			source,
			/(?:require\(|from\s+|import\s*\()\s*['"](?:@attocash\/|@js-joda\/|@stablelib\/)/,
			file,
		);
	}
});

test('package declares no runtime Commons dependency', () => {
	const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
	assert.equal(packageJson.dependencies, undefined);
	assert.deepEqual(packageJson.peerDependencies, { 'n8n-workflow': '*' });
	assert.equal(typeof packageJson.devDependencies['@attocash/commons-core'], 'string');
	assert.equal(packageJson.devDependencies['@attocash/commons-node-remote'], undefined);
});
