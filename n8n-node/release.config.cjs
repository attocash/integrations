const n8nScope = "n8n-node";

module.exports = {
	branches: ["main"],
	tagFormat: "n8n-node-v${version}",
	plugins: [
		[
			"@semantic-release/commit-analyzer",
			{
				releaseRules: [
					{ breaking: true, scope: n8nScope, release: "major" },
					{ revert: true, scope: n8nScope, release: "patch" },
					{ type: "feat", scope: n8nScope, release: "minor" },
					{ type: "fix", scope: n8nScope, release: "patch" },
					{ type: "perf", scope: n8nScope, release: "patch" },
					{ type: "revert", scope: n8nScope, release: "patch" },
					{ type: "*", release: false },
				],
			},
		],
		"@semantic-release/release-notes-generator",
		[
			"@semantic-release/github",
			{
				assets: [
					{
						path: "artifacts/*.tgz",
						label: "@attocash/n8n-nodes-atto package",
					},
				],
			},
		],
	],
};
