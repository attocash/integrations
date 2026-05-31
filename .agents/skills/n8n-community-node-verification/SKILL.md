---
name: "n8n-community-node-verification"
version: "1.0.7"
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
   - Confirm `package.json` name is either `n8n-nodes-*` or a scoped package whose unscoped name starts with `n8n-nodes-*`, such as `@scope/n8n-nodes-*`.
   - Confirm `package.json` has the `n8n` metadata pointing at built `dist` node and credential files.
   - When the package has action and trigger nodes, confirm every node entrypoint is listed in `package.json` `n8n.nodes`, included by the bundle/build script, and covered by the smoke import test.
   - Confirm the workflow node type is `<package-name>.<node-description-name>`, for example `n8n-nodes-atto.atto` or `@attocash/n8n-nodes-atto.atto`.

2. Build and lint using n8n tooling.
   - Run `npm install` if dependencies changed or a clean install is required.
   - Run `npm run build`.
   - Run `npm run lint`.
   - If the n8n linter rejects runtime dependencies, bundle package-only runtime code into the built node and keep n8n-provided packages external.
   - For CI artifacts, run `npm pack --pack-destination ../artifacts` after tests and upload `artifacts/*.tgz`.
   - If sandboxed `npm pack` fails writing to the host npm cache, rerun with an isolated cache such as `npm --cache /tmp/npm-cache pack --pack-destination <dir>`.
   - For npm releases, use package-scoped semver tags such as `n8n-node-vX.Y.Z` and validate the tag against `n8n-node/package.json` before publishing.
   - Publish n8n community nodes from GitHub Actions with `npm publish --provenance --access public`; support npm Trusted Publisher first and `NPM_TOKEN` only as a fallback.
   - Trusted Publishing requires a new enough CI toolchain. Use Node 24 for the publish workflow, install npm `^11.5.1`, and fail early if `node` or `npm` is below npm's current OIDC minimums.

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
   - Prefer a local-only derive/format workflow for smoke execution when the package supports one; it proves node registration and execution without external service credentials.
   - Include at least one workflow that omits UI-defaulted parameters such as `operation`; this catches `Could not get parameter` failures that unit tests with explicit parameters can miss.
   - For trigger nodes, add a direct unit test around `trigger.trigger.call(ctx)` with a context whose `getNodeParameter` throws unless the node supplies a fallback. Use the trigger signature `getNodeParameter(name, fallback)`, not the action-node signature `getNodeParameter(name, itemIndex, fallback)`.
   - Do not run `n8n execute` inside the same live server process/container if the task broker port is already in use. Stop the server after the HTTP/UI load check, then run a one-shot n8n CLI container with the same temporary user folder and package mount.
   - Delete temporary n8n user folders that contain workflow secrets after verification.

6. Verify credential tests through n8n when changing credential definitions.
   - Start a temporary n8n server with the package mounted.
   - Use the REST API to set up a disposable owner, create a disposable credential, then call `POST /rest/credentials/test`.
   - Treat `{"status":"OK","message":"Connection successful!"}` as the credential-test pass condition.
   - Use disposable wallet material only, because n8n stores the credential in the temporary user folder.

7. For checkout-based installs inside an n8n container, keep host installs isolated.
   - Add a package script that builds, validates, packs, and installs the `.tgz` into `${N8N_USER_FOLDER:-$HOME/.n8n}/nodes`.
   - Default to build plus a local smoke validation; make full tests opt-in because containerized n8n often lacks Docker or Podman access for integration tests.
   - Verify installer behavior in an ephemeral Podman container by copying the package source into the container and installing only into the container filesystem.

## Pitfalls

- Mounting only the package directory can leave `/home/node/.n8n/nodes` unwritable; mount a writable parent user folder too.
- `N8N_USER_FOLDER=/home/node/.n8n` creates a nested `.n8n` folder; use `N8N_USER_FOLDER=/home/node`.
- If `curl http://127.0.0.1:5678` cannot reach a container that logs as ready, set `N8N_LISTEN_ADDRESS=0.0.0.0`; if a sandbox still blocks local networking, rerun the local curl check outside the sandbox.
- n8n CLI execution does not accept `--file` reliably in current images; import the workflow and execute by ID.
- n8n CLI execution can conflict with a running server on the task broker port; use a one-shot CLI container against the same user folder after stopping the server.
- n8n may print node parameters on failed CLI executions, so store real wallet/API secrets in credentials and use disposable test secrets only for workflow verification.
- n8n credential save/test failures can come from the credential `test.request`, even when the credential data itself is valid. Check the exact route in the credential definition before debugging wallet fields.
- UI-created nodes may not persist default values for every parameter. Use `getNodeParameter(name, itemIndex, fallback)` for action-node defaults and `getNodeParameter(name, fallback)` for trigger-node defaults.
- n8n community node type IDs are package-qualified, for example `n8n-nodes-atto.atto` or `@attocash/n8n-nodes-atto.atto`, even when the UI display name is shorter.
- GitHub Actions artifact downloads are zip files; for n8n installation testing, extract the downloaded artifact and use the packaged `.tgz` inside it.
- Do not verify checkout installers against the host `~/.n8n`; use a temporary directory or, preferably, an ephemeral Podman n8n container.
- For npm Trusted Publishing, configure npm with the exact GitHub workflow filename used by the publish job.
- Do not assume Node 22's bundled npm supports Trusted Publishing; Node can satisfy the runtime requirement while npm is still too old for OIDC publishing.
- In a multi-integration repository, avoid repo-wide `vX.Y.Z` tags for n8n releases; they collide with unrelated integration versions.

## Verification

Before finishing, run:
- `npm run build`
- `npm run lint`
- `npm test`
- `npm pack --pack-destination <temporary-artifact-directory>`
- the release-tag validator with a matching tag and, when changed, one intentionally mismatched tag
- `npm publish <tarball> --dry-run --access public` with an isolated npm cache when the host cache is read-only
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
