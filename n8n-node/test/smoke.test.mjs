import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

test('build artifacts required by n8n are present', async () => {
	const required = [
		'dist/credentials/AttoApi.credentials.js',
		'dist/nodes/Atto/Atto.node.js',
		'dist/nodes/Atto/Atto.node.json',
		'dist/nodes/Atto/atto.svg',
	];

	for (const file of required) {
		assert.equal(existsSync(file), true, `${file} should exist`);
	}

	const node = await import('../dist/nodes/Atto/Atto.node.js');
	const credentials = await import('../dist/credentials/AttoApi.credentials.js');

	assert.equal(typeof node.Atto, 'function');
	assert.equal(typeof credentials.AttoApi, 'function');
});
