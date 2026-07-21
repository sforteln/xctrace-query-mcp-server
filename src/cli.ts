#!/usr/bin/env node
/**
 * npx/bin entry point. Kept free of any static import that would pull in
 * node:sqlite (see src/engine/sqliteStore.ts) — ESM resolves the whole
 * import graph before running anything, so a version check inside index.ts
 * itself would never run before a pre-22 Node throws a raw module-resolution
 * error. Checking here, before the dynamic import, is what makes the error
 * message legible instead of an internal Node stack trace.
 */
const MIN_NODE_MAJOR = 22;
const major = Number(process.versions.node.split(".")[0]);

if (major < MIN_NODE_MAJOR) {
  console.error(
    `xctrace-query-mcp-server requires Node.js >= ${MIN_NODE_MAJOR} (it uses the built-in node:sqlite module). ` +
      `You're running Node ${process.versions.node}. Install a newer Node (e.g. \`nvm install 22 && nvm use 22\`) and try again.`,
  );
  process.exit(1);
}

await import("./index.js");
