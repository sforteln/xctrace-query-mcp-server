/**
 * Persistent trace cache, colocated with the .trace file — PMT:ruby-peak.
 *
 * Once rows live in a SQLite file instead of process memory (PMT:gravel-cape
 * onward), there's no technical reason the cache has to die with the server
 * process the way the old session-scoped temp db did. This module resolves,
 * for a given trace path, WHERE that trace's persistent .db file lives and
 * whether an existing one is still fresh — so a brand-new server process
 * reopening a trace a previous process already ingested pays zero re-parse
 * cost, not just "free within one session."
 *
 * Colocation (same dir, same basename, .db extension) needs no path-hashing
 * scheme and no naming-collision handling — colocation + shared basename
 * already makes identity unambiguous, and deleting the .trace naturally
 * takes its cache with it. When the trace's own directory isn't writable (a
 * read-only mount, permissions, an Xcode-managed autosave dir), this falls
 * back to a shared cache directory (OS-convention default, user-configurable
 * via config.ts's fallbackCacheDir / the set_cache_dir tool) keyed by a hash
 * of the absolute trace path, since a shared directory serving many traces
 * DOES need an identity scheme, unlike the colocated case.
 *
 * Staleness: a re-recorded or replaced .trace at the same path must never
 * silently serve stale cached data. The source file's mtime is stored in the
 * persisted db's `_meta` table at ingest time and compared against the live
 * .trace file's current mtime on every open; a mismatch wipes the .db and
 * starts fresh rather than trusting it.
 *
 * "Is this directory writable" is answered by ATTEMPTING to open a db file
 * there and catching the failure — not a pre-check (which would race and
 * could still be wrong on unusual filesystems) — the standard, TOCTOU-safe
 * approach.
 *
 * Orphaned .db files (the .trace was deleted by hand but the .db wasn't) are
 * deliberately left alone — no active scan-and-clean here. This is a rare,
 * low-urgency, harmless leftover for a human to notice, and building
 * directory-scanning cleanup logic for it would be over-engineering a path
 * that's meant to be the exception, not the common case (see this feature's
 * approach note on not over-building eviction for the fallback directory).
 */
import type { DatabaseSync } from "node:sqlite";
import { stat, unlink, mkdir } from "node:fs/promises";
import { dirname, basename, join, extname } from "node:path";
import { createHash } from "node:crypto";
import { openSessionDb, readMeta, writeMeta, INGEST_SCHEMA_VERSION } from "./sqliteStore.js";
import { getConfig, defaultFallbackCacheDir } from "../config.js";

export interface ResolvedTraceDb {
  /** Absolute path to the persisted .db file actually opened. */
  dbPath: string;
  /** The already-open connection — callers never need to open this path themselves. */
  db: DatabaseSync;
  /** true when colocated next to the .trace; false when using the fallback cache directory. */
  colocated: boolean;
  /**
   * true when an existing, freshness-verified db was reused as-is (any
   * tables it already holds can skip re-ingestion — see session.ts's
   * getTable/getSchemaMeta, which check per-table via
   * sqliteStore.ts's loadIngestedSchemaCols regardless of this flag).
   * false when this db was just created (fresh, or wiped for being stale).
   */
  reused: boolean;
}

const META_MTIME_KEY = "source_mtime_ms";
const META_PATH_KEY = "source_path";
const META_SCHEMA_VERSION_KEY = "ingest_schema_version";

function colocatedDbPath(tracePath: string): string {
  const ext = extname(tracePath);
  const base = basename(tracePath, ext);
  return join(dirname(tracePath), `${base}.db`);
}

/**
 * A hash of the absolute trace path (not just the basename) for the shared
 * fallback directory — many traces can share a basename ("Leak.trace" from
 * two different projects), so identity there must be keyed off the full
 * path, not the human-readable name alone. The basename is still included in
 * the filename (truncated/sanitized) purely so a human browsing the fallback
 * directory can recognize which trace a .db belongs to at a glance.
 */
function fallbackDbPath(tracePath: string, fallbackDir: string): string {
  const hash = createHash("sha256").update(tracePath).digest("hex").slice(0, 16);
  const safeBase = basename(tracePath, extname(tracePath)).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
  return join(fallbackDir, `${safeBase}.${hash}.db`);
}

/**
 * Try to open (or create) a persisted trace db at `dbPath`, checking
 * freshness against `mtimeMs` when it already exists. Returns null if the
 * path can't be opened at all (permission denied, read-only filesystem) —
 * the caller's signal to try the next candidate location.
 */
async function tryOpenAt(
  dbPath: string,
  tracePath: string,
  mtimeMs: number
): Promise<{ db: DatabaseSync; reused: boolean } | null> {
  let existedBefore = false;
  try {
    existedBefore = (await stat(dbPath)).isFile();
  } catch {
    // Doesn't exist yet — a fresh create, not a staleness question.
  }

  let db: DatabaseSync;
  try {
    db = openSessionDb(dbPath, { journalMode: "default" });
  } catch {
    return null;
  }

  if (!existedBefore) {
    writeMeta(db, META_MTIME_KEY, String(mtimeMs));
    writeMeta(db, META_PATH_KEY, tracePath);
    writeMeta(db, META_SCHEMA_VERSION_KEY, INGEST_SCHEMA_VERSION);
    return { db, reused: false };
  }

  const storedMtime = readMeta(db, META_MTIME_KEY);
  const storedPath = readMeta(db, META_PATH_KEY);
  // A .db written by an older build has a different (or absent) schema version;
  // reusing it against new-code reads would hit a mismatched frames/symbols
  // shape (PMT:tidy-warbler). Treat a version mismatch exactly like an mtime
  // staleness — wipe + re-ingest, no in-place migration.
  const storedVersion = readMeta(db, META_SCHEMA_VERSION_KEY);
  const fresh =
    storedMtime !== null &&
    Number(storedMtime) === mtimeMs &&
    storedPath === tracePath &&
    storedVersion === INGEST_SCHEMA_VERSION;
  if (fresh) {
    return { db, reused: true };
  }

  // Stale — the .trace at this path was re-recorded/replaced since this .db was
  // written, OR the .db was written by an older schema version, OR (in the
  // fallback directory) storedPath mismatches entirely (a sha256 hash collision
  // — astronomically unlikely, but checked for a hard guarantee). Never
  // silently serve stale data: wipe and start over.
  db.close();
  await unlink(dbPath).catch(() => {});
  const freshDb = openSessionDb(dbPath, { journalMode: "default" });
  writeMeta(freshDb, META_MTIME_KEY, String(mtimeMs));
  writeMeta(freshDb, META_PATH_KEY, tracePath);
  writeMeta(freshDb, META_SCHEMA_VERSION_KEY, INGEST_SCHEMA_VERSION);
  return { db: freshDb, reused: false };
}

/**
 * Resolve and open the persisted db for one trace path — colocated first,
 * falling back to the configured/default shared cache directory if the
 * trace's own directory isn't writable. Called once per session, lazily, on
 * first table fetch (see session.ts's getSessionDb) — open_trace itself
 * never pays this cost, matching its existing "fast regardless of trace
 * size" contract (a local sqlite file open + a one-row _meta read, no
 * xctrace call, so this is cheap regardless of when it runs).
 */
export async function resolveAndOpenTraceDb(tracePath: string): Promise<ResolvedTraceDb> {
  const mtimeMs = (await stat(tracePath)).mtimeMs;

  const colocated = colocatedDbPath(tracePath);
  const viaColocated = await tryOpenAt(colocated, tracePath, mtimeMs);
  if (viaColocated) {
    return { dbPath: colocated, db: viaColocated.db, colocated: true, reused: viaColocated.reused };
  }

  const config = await getConfig();
  const fallbackDir = config.fallbackCacheDir ?? defaultFallbackCacheDir();
  await mkdir(fallbackDir, { recursive: true });
  const fallback = fallbackDbPath(tracePath, fallbackDir);
  const viaFallback = await tryOpenAt(fallback, tracePath, mtimeMs);
  if (viaFallback) {
    return { dbPath: fallback, db: viaFallback.db, colocated: false, reused: viaFallback.reused };
  }

  throw new Error(
    `Could not open a persistent cache database for this trace — neither colocated at "${colocated}" ` +
    `nor in the fallback cache directory "${fallbackDir}" is writable. Check filesystem permissions, ` +
    "or set a different fallback directory with set_cache_dir."
  );
}
