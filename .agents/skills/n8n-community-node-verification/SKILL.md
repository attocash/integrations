---
name: "n8n-community-node-verification"
version: "1.0.0"
description: "Verify n8n community node packages in this integrations repo by building the package, checking n8n linter constraints, loading it in n8n with Podman, and executing a small workflow through n8n itself."
license: "MIT"
compatibility: "opencode"
metadata:
  scope: "repo-local"
  audience: "coding-agents"
  workflow: "n8n-community-node"
---

# n8n Community Node Verification

## Scope

Use this repo-local skill in `/var/home/felipe/IdeaProjects/integrations` when adding, changing, or validating an n8n community node package such as `n8n-node`.

## When To Use

Use this skill when the task asks to:
- build or verify an n8n community node
- prove n8n loads a local custom node package
- execute a basic n8n workflow against a local community node
- debug package naming, node type IDs, credentials, or community-node linter failures

Do not use this skill for ordinary TypeScript library tests, generic Docker checks, or n8n workflow design that does not involve a local community node package.

## Procedure

1. Inspect the package before changing behavior.
   - Confirm `package.json` name starts with `n8n-nodes-`.
   - Confirm `package.json` has the `n8n` metadata pointing at built `dist` node and credential files.
   - Confirm the workflow node type is `<package-name>.<node-description-name>`, for example `n8n-nodes-atto.atto`.

2. Build and lint using n8n tooling.
   - Run `npm install` if dependencies changed or a clean install is required.
   - Run `npm run build`.
   - Run `npm run lint`.
   - If the n8n linter rejects runtime dependencies, bundle package-only runtime code into the built node and keep n8n-provided packages external.
   - For CI artifacts, run `npm pack --pack-destination ../artifacts` after tests and upload `artifacts/*.tgz`.

3. Test the node outside n8n first.
   - Unit-test operation helpers and n8n `execute()` behavior.
   - Include a smoke test that imports built `dist` node and credential files.
   - For integration tests, prefer the real local/mock service utilities exposed by the upstream library rather than manually faking protocol behavior.

4. Verify in real n8n with Podman.
   - Build first.
   - Use a writable n8n user folder and mount the package under `nodes/node_modules`.
   - For rootless Podman host-directory permission issues, run the verification container as root inside the container and set `N8N_USER_FOLDER=/home/node`.

Example server command:

```bash
mkdir -p /tmp/n8n-local-verify/.n8n/nodes/node_modules
podman run --rm -it --user 0 -p 5678:5678 \
  -e N8N_USER_FOLDER=/home/node \
  -e N8N_COMMUNITY_PACKAGES_ENABLED=true \
  -e N8N_SECURE_COOKIE=false \
  -v /tmp/n8n-local-verify:/home/node:Z \
  -v "$PWD:/home/node/.n8n/nodes/node_modules/<package-name>:ro,Z" \
  docker.io/n8nio/n8n:latest
```

5. Execute a minimal workflow through n8n.
   - Use `import:workflow --input=<file>` followed by `execute --id=<workflow-id> --rawOutput`.
   - Use a generated local test secret only in temporary files, never in repo files or final output.
   - Delete temporary n8n user folders that contain workflow secrets after verification.

## Pitfalls

- Mounting only the package directory can leave `/home/node/.n8n/nodes` unwritable; mount a writable parent user folder too.
- `N8N_USER_FOLDER=/home/node/.n8n` creates a nested `.n8n` folder; use `N8N_USER_FOLDER=/home/node`.
- n8n CLI execution does not accept `--file` reliably in current images; import the workflow and execute by ID.
- n8n may print node parameters on failed CLI executions, so store real wallet/API secrets in credentials and use disposable test secrets only for workflow verification.
- n8n community node type IDs are package-qualified, for example `n8n-nodes-atto.atto`, even when the UI display name is shorter.
- GitHub Actions artifact downloads are zip files; for n8n installation testing, extract the downloaded artifact and use the packaged `.tgz` inside it.

## Verification

Before finishing, run:
- `npm run build`
- `npm run lint`
- `npm test`
- `npm pack --pack-destination <temporary-artifact-directory>`
- a Podman n8n start check that reaches `http://127.0.0.1:5678`
- a minimal n8n workflow execution that uses the community node type

Confirm there is no leftover n8n verification container and remove any temporary n8n user folder that may contain generated test secrets.

## Trigger Examples

Should use:
- "verify this n8n community node loads in n8n"
- "run a real n8n workflow against the local custom node"
- "why is my n8n community node type called n8n-nodes-foo.bar?"

Should not use:
- "write a generic TypeScript unit test"
- "design an n8n workflow using built-in nodes only"
