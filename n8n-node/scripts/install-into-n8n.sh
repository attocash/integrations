#!/bin/sh

set -eu

log() {
	printf '%s\n' "$*"
}

fail() {
	printf 'ERROR: %s\n' "$*" >&2
	exit 1
}

require_command() {
	command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

require_command node
require_command npm
require_command mktemp

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
package_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
current_dir=$(pwd -P)

if [ "$current_dir" != "$package_dir" ]; then
	fail "Run this from the n8n-node package directory: cd $package_dir && npm run install:n8n"
fi

[ -f package.json ] || fail "package.json not found"

package_name=$(node -p "require('./package.json').name")
package_version=$(node -p "require('./package.json').version")

[ "$package_name" = "n8n-nodes-atto" ] || fail "Unexpected package name: $package_name"

if [ -n "${N8N_NODES_DIR:-}" ]; then
	n8n_nodes_dir=$N8N_NODES_DIR
elif [ -n "${N8N_USER_FOLDER:-}" ]; then
	n8n_nodes_dir=${N8N_USER_FOLDER%/}/nodes
elif [ -n "${HOME:-}" ]; then
	n8n_nodes_dir=$HOME/.n8n/nodes
else
	fail "Set N8N_NODES_DIR or N8N_USER_FOLDER; HOME is not available"
fi

tmp_dir=$(mktemp -d)
cleanup() {
	rm -rf "$tmp_dir"
}
trap cleanup EXIT INT TERM

log "Installing build dependencies for $package_name@$package_version..."
npm ci --include=dev --no-audit --no-fund

if [ "${RUN_TESTS:-0}" = "1" ] || [ "${RUN_TESTS:-0}" = "true" ]; then
	log "Running full test suite..."
	npm test
else
	log "Building package..."
	npm run build
fi

log "Validating built package..."
npm run validate:local

log "Packing package..."
pack_output=$(npm pack --pack-destination "$tmp_dir")
tarball_name=$(printf '%s\n' "$pack_output" | tail -n 1)
tarball_path=$tmp_dir/$tarball_name

[ -f "$tarball_path" ] || fail "npm pack did not create $tarball_path"

log "Installing $tarball_name into $n8n_nodes_dir..."
mkdir -p "$n8n_nodes_dir"

if [ ! -f "$n8n_nodes_dir/package.json" ]; then
	cat >"$n8n_nodes_dir/package.json" <<'EOF'
{
  "private": true,
  "description": "n8n community nodes installed locally"
}
EOF
fi

(
	cd "$n8n_nodes_dir"
	npm install "$tarball_path" --no-audit --no-fund
)

log "Installed $package_name@$package_version."
log "Restart n8n, then search for the Atto node in the editor."
