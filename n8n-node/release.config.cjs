module.exports = {
	branches: ["main"],
	tagFormat: "n8n-node-v${version}",
	plugins: [
		"@semantic-release/commit-analyzer",
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
