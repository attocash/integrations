module.exports = {
  branches: ['main'],
  tagFormat: 'atto-v${version}',
  // Semantic Release calculates metadata only. The workflow publishes the
  // tested CLI/MCP artifacts before creating the corresponding GitHub release.
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
  ],
};
