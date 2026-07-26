import { readFile, mkdir, readdir, rename, rm, unlink } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join } from "node:path";

import { build } from "esbuild";

const DIST_DIRECTORY = "dist";
const BUNDLE_DIRECTORY = join(DIST_DIRECTORY, ".bundled");
const PROTOCOL_ENTRY = join(DIST_DIRECTORY, "nodes", "Atto", "protocol.js");
const BUNDLED_PROTOCOL = join(BUNDLE_DIRECTORY, "protocol.js");
const BUILTIN_MODULES = new Set([
  ...builtinModules,
  ...builtinModules.map((module) => `node:${module}`),
]);
const DISALLOWED_RUNTIME_IMPORT =
  /(?:require\(|from\s+|import\s*\()\s*["'](?:@attocash\/|@js-joda\/|@stablelib\/)/;

const stripKotlinConsoleLogger = {
  name: "strip-kotlin-console-logger",
  setup(buildContext) {
    buildContext.onLoad(
      { filter: /kotlin-kotlin-stdlib\.mjs$/ },
      async ({ path }) => {
        let contents = await readFile(path, "utf8");
        const browserFallback =
          "output = isNode ? new NodeJsOutput(process.stdout) : new BufferedOutputToConsoleLog();";
        const loggerMetadata =
          "initMetadataForClass(BufferedOutputToConsoleLog, 'BufferedOutputToConsoleLog', BufferedOutputToConsoleLog);";
        const hasBrowserFallback = contents.includes(browserFallback);
        const hasLoggerMetadata = contents.includes(loggerMetadata);
        if (!hasBrowserFallback && !hasLoggerMetadata) {
          return { contents, loader: "js" };
        }
        if (!hasBrowserFallback || !hasLoggerMetadata) {
          throw new Error(
            "Kotlin console logger layout changed; update the bundler transform",
          );
        }
        contents = contents
          .replace(
            browserFallback,
            "output = new NodeJsOutput(process.stdout);",
          )
          .replace(loggerMetadata, "");
        return { contents, loader: "js" };
      },
    );
  },
};

async function findJavaScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findJavaScriptFiles(path)));
    } else if (entry.name.endsWith(".js")) {
      files.push(path);
    }
  }
  return files;
}

async function bundleRuntime() {
  await mkdir(BUNDLE_DIRECTORY, { recursive: true });
  const result = await build({
    entryPoints: [PROTOCOL_ENTRY],
    outfile: BUNDLED_PROTOCOL,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22.16",
    mainFields: ["module", "main"],
    preserveSymlinks: true,
    external: ["n8n-workflow"],
    drop: ["console"],
    minify: true,
    legalComments: "none",
    metafile: true,
    logLevel: "silent",
    plugins: [stripKotlinConsoleLogger],
  });

  const externalImports = Object.values(result.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter((entry) => entry.external)
    .map((entry) => entry.path)
    .filter(
      (path) => path !== "n8n-workflow" && !BUILTIN_MODULES.has(path),
    );
  if (externalImports.length > 0) {
    throw new Error(
      `Protocol bundle contains external runtime imports: ${externalImports.join(", ")}`,
    );
  }

  await rename(BUNDLED_PROTOCOL, PROTOCOL_ENTRY);
  await rm(BUNDLE_DIRECTORY, { recursive: true });
}

async function removeDevelopmentArtifacts(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await removeDevelopmentArtifacts(path);
    } else if (
      entry.name.endsWith(".d.ts") ||
      entry.name.endsWith(".map") ||
      entry.name.endsWith(".tsbuildinfo")
    ) {
      await unlink(path);
    }
  }
}

async function validateRuntimeArtifacts() {
  for (const file of await findJavaScriptFiles(DIST_DIRECTORY)) {
    const source = await readFile(file, "utf8");
    if (DISALLOWED_RUNTIME_IMPORT.test(source)) {
      throw new Error(`${file} contains an unresolved bundled dependency`);
    }
    if (/console\.(?:log|debug|info|warn|error)\s*\(/.test(source)) {
      throw new Error(`${file} contains a console call`);
    }
    if (source.includes("BufferedOutputToConsoleLog")) {
      throw new Error(`${file} contains Kotlin console logging`);
    }
  }
}

await bundleRuntime();
await removeDevelopmentArtifacts(DIST_DIRECTORY);
await validateRuntimeArtifacts();
