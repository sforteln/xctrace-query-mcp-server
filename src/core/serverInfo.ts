/**
 * serverInfo — answers "which build of this server is actually running?"
 *
 * Node doesn't hot-reload: a long-lived server process keeps running whatever
 * code was in memory at startup, even after `npm run build` overwrites dist/
 * on disk or a new commit lands. This surfaced as a real, confusing incident —
 * a query that should have been fast (per a same-day fix) instead ran for
 * 10+ minutes, because the server process handling it had been started
 * minutes before the fix was built. There was no way to check this from
 * outside a shell (`ps` + `stat`, done by hand) — this tool bundles that
 * exact diagnostic into one call so an agent (or a human) can ask "are you
 * running the version with fix X?" directly.
 *
 * distBuildTime (this file's own on-disk mtime) is the ground truth for
 * "when was the loaded code built" — it's what determines which code is
 * actually running. An earlier version of this also reported gitCommit/
 * gitCommitDate/gitDirty, but those are permanently null for every real
 * npm-installed user (there's no .git directory once published) — dropped
 * as noise that only ever had value for this repo's own dev checkout.
 */
import { fileURLToPath } from "node:url";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ServerInfo {
  packageVersion: string;
  processStartedAt: string;
  /** On-disk mtime of this running file — the ground truth for "when was the loaded code built." */
  distBuildTime: string;
  nodeVersion: string;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
// This file compiles to dist/core/serverInfo.js — repo root is two levels up.
const REPO_ROOT = join(MODULE_DIR, "..", "..");

export function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// Captured once at module load — process start time doesn't change during
// the life of this process, so there's no reason to recompute it per call.
const PROCESS_STARTED_AT = new Date().toISOString();
const PACKAGE_VERSION = readPackageVersion();

export function getServerInfo(): ServerInfo {
  return {
    packageVersion: PACKAGE_VERSION,
    processStartedAt: PROCESS_STARTED_AT,
    distBuildTime: statSync(fileURLToPath(import.meta.url)).mtime.toISOString(),
    nodeVersion: process.version,
  };
}
