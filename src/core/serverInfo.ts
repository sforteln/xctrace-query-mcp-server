/**
 * serverInfo — answers "which build of this server is actually running?"
 *
 * Node doesn't hot-reload: a long-lived server process keeps running whatever
 * code was in memory at startup, even after `npm run build` overwrites dist/
 * on disk or a new commit lands. This surfaced as a real, confusing incident —
 * a query that should have been fast (per a same-day fix) instead ran for
 * 10+ minutes, because the server process handling it had been started
 * minutes before the fix was built. There was no way to check this from
 * outside a shell (`ps` + `stat` + `git log`, done by hand) — this tool
 * bundles that exact diagnostic into one call so an agent (or a human) can
 * ask "are you running the version with fix X?" directly.
 *
 * distBuildTime (this file's own on-disk mtime) is the most load-bearing
 * field — it doesn't depend on git and is what actually determines which
 * code is loaded. gitCommit/gitDirty are best-effort: they reflect the repo
 * state read at process startup, which can drift from what was ACTUALLY
 * compiled into dist/ if someone commits without rebuilding (or vice versa) —
 * useful for cross-referencing against a known commit hash, not authoritative
 * on their own. Both are absent when running from a published npm install
 * with no .git directory present.
 */
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ServerInfo {
  packageVersion: string;
  processStartedAt: string;
  /** On-disk mtime of this running file — the ground truth for "when was the loaded code built." */
  distBuildTime: string;
  /** Best-effort — null when not running from a git checkout (e.g. a published npm install). */
  gitCommit: string | null;
  gitCommitDate: string | null;
  /** True if the working tree had uncommitted changes at process startup. Null alongside gitCommit. */
  gitDirty: boolean | null;
  nodeVersion: string;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
// This file compiles to dist/core/serverInfo.js — repo root is two levels up.
const REPO_ROOT = join(MODULE_DIR, "..", "..");

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function gitInfo(): { commit: string | null; commitDate: string | null; dirty: boolean | null } {
  try {
    const commit = execSync("git rev-parse HEAD", { cwd: REPO_ROOT, encoding: "utf8" }).trim();
    const commitDate = execSync("git log -1 --format=%cI", { cwd: REPO_ROOT, encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", { cwd: REPO_ROOT, encoding: "utf8" }).trim().length > 0;
    return { commit, commitDate, dirty };
  } catch {
    return { commit: null, commitDate: null, dirty: null };
  }
}

// Captured once at module load — process start time and git state don't
// change during the life of this process, so there's no reason to re-run a
// subprocess on every call.
const PROCESS_STARTED_AT = new Date().toISOString();
const PACKAGE_VERSION = readPackageVersion();
const GIT = gitInfo();

export function getServerInfo(): ServerInfo {
  return {
    packageVersion: PACKAGE_VERSION,
    processStartedAt: PROCESS_STARTED_AT,
    distBuildTime: statSync(fileURLToPath(import.meta.url)).mtime.toISOString(),
    gitCommit: GIT.commit,
    gitCommitDate: GIT.commitDate,
    gitDirty: GIT.dirty,
    nodeVersion: process.version,
  };
}
