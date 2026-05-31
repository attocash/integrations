import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const version = String(packageJson.version ?? '');
const refName = process.argv[2] ?? process.env.RELEASE_TAG_NAME ?? process.env.GITHUB_REF_NAME ?? '';
const semverPattern =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

assert.match(version, semverPattern, `package.json version must be valid semver, got ${version}`);
assert.ok(refName, 'GITHUB_REF_NAME or a tag argument is required');

const expectedRefName = `n8n-node-v${version}`;
assert.equal(
	refName,
	expectedRefName,
	`Release tag must match package version: expected ${expectedRefName}, got ${refName}`,
);

console.log(`OK: ${packageJson.name}@${version} matches ${refName}`);
