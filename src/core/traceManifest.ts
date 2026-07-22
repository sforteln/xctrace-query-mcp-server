/**
 * Trace/db disk manifest — surfaced on close_trace so the user sees real
 * numbers (free space + what's accumulating) at a point that's already
 * happening, rather than the server guessing when disk usage is "worth"
 * mentioning. See FTR:ruddy-bluff / PMT:thin-crystal in PromptManager for
 * the full design discussion, including three alternatives (a free-space
 * auto-trigger, a user-configurable size cap, a start_recording threshold)
 * that were deliberately rejected in favor of this simpler always-show-it
 * approach — neither this server nor the AI driving it can ever proactively
 * contact a user outside an active tool call, so picking the "right"
 * trigger condition was solving the wrong problem.
 */
import { readdir, stat, statfs, unlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { allTraces } from "./discovery.js";
import { colocatedDbPath, fallbackDbPath, META_MTIME_KEY } from "../engine/traceCache.js";
import { openSessionDb, readMeta } from "../engine/sqliteStore.js";
import { getConfig, defaultFallbackCacheDir, defaultRecordingsDir } from "../config.js";
import { formatBytes } from "./callTree.js";
import { getTraceDescription } from "./traceTemplateInfo.js";

const DEFAULT_CAP = 20;

export interface ManifestEntry {
  index: number;
  name: string;
  path: string;
  recordedAt: string;
  traceSizeBytes: number;
  traceSizeFmt: string;
  dbPath: string | null;
  dbSizeBytes: number | null;
  dbSizeFmt: string | null;
  /** "fresh" = db's stored source mtime still matches the trace; "stale" = trace changed since; "none" = no cached db. */
  dbStatus: "fresh" | "stale" | "none";
  /** Distinct schemas already queried into the cached db, if any — not necessarily every instrument that was recorded, only what's been analyzed so far. */
  schemasAnalyzed: string[] | null;
  /** What this recording was actually FOR, read from the trace's own form.template (Instruments' own description of the template/instruments used) — null if unreadable. */
  description: string | null;
}

export interface TraceManifest {
  totalTraces: number;
  totalBytes: number;
  totalBytesFmt: string;
  freeSpaceBytes: number | null;
  freeSpaceFmt: string | null;
  entries: ManifestEntry[];
  rolledUp: { count: number; bytes: number; bytesFmt: string } | null;
}

/**
 * Recursive, best-effort directory size (a .trace is a bundle/directory, not
 * a single file). Sizes are collected via each callback's RETURN value and
 * summed once every promise settles — deliberately not a shared `total`
 * variable mutated from inside concurrent async callbacks. That pattern was
 * tried first and was empirically wrong: reproducibly and non-deterministically
 * undercounted a real 273MB bundle as anywhere from ~11KB to ~110KB across
 * repeated runs on the exact same, stable (verified via repeated `du -sh`)
 * files — a real concurrency bug in that pattern, not a per-file error (every
 * file's stat succeeded; the accumulation itself was unsound). This
 * return-and-reduce form was verified consistent and correct (matching `du`
 * exactly) across repeated runs against the same bundle.
 */
async function dirSize(path: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(path);
  } catch {
    return 0;
  }
  const sizes = await Promise.all(
    names.map(async (name): Promise<number> => {
      const full = join(path, name);
      let s;
      try {
        s = await stat(full);
      } catch {
        return 0;
      }
      if (s.isDirectory()) {
        return dirSize(full);
      } else if (s.isFile()) {
        return s.size;
      }
      return 0;
    })
  );
  return sizes.reduce((a, b) => a + b, 0);
}

/** Find an existing cached .db for a trace (colocated first, then the fallback dir), without opening/creating/wiping it. */
async function findExistingDb(tracePath: string): Promise<string | null> {
  const colocated = colocatedDbPath(tracePath);
  try {
    if ((await stat(colocated)).isFile()) return colocated;
  } catch {
    // doesn't exist there
  }
  const config = await getConfig();
  const fallbackDir = config.fallbackCacheDir ?? defaultFallbackCacheDir();
  const fallback = fallbackDbPath(tracePath, fallbackDir);
  try {
    if ((await stat(fallback)).isFile()) return fallback;
  } catch {
    // doesn't exist there either
  }
  return null;
}

/** Peek a cached db's freshness + ingested-schema list without mutating it (no wipe-on-stale — that's traceCache.ts's job at actual open time). */
function peekDb(dbPath: string, tracePath: string, traceMtimeMs: number): { status: "fresh" | "stale"; schemas: string[] } {
  const db = openSessionDb(dbPath, { journalMode: "default" });
  try {
    const storedMtime = readMeta(db, META_MTIME_KEY);
    const status: "fresh" | "stale" = storedMtime !== null && Number(storedMtime) === traceMtimeMs ? "fresh" : "stale";
    let schemas: string[] = [];
    try {
      const rows = db
        .prepare(`SELECT DISTINCT table_name FROM _ingested_schema ORDER BY table_name`)
        .all() as Array<{ table_name: string }>;
      schemas = rows.map((r) => r.table_name);
    } catch {
      // _ingested_schema may not exist yet on a brand-new/empty db
    }
    return { status, schemas };
  } finally {
    db.close();
  }
}

/**
 * Build the oldest-first, capped trace manifest for close_trace's response.
 * Computes real disk usage for every trace (for an accurate rollup total),
 * but only peeks each shown entry's cached db (schemas/freshness) — the
 * capped subset, not all of them, to keep this cheap regardless of how many
 * traces have accumulated.
 */
export async function buildTraceManifest(cap: number = DEFAULT_CAP): Promise<TraceManifest> {
  const { traces } = await allTraces();
  const oldestFirst = [...traces].sort((a, b) => a.mtimeMs - b.mtimeMs);

  const shown = oldestFirst.slice(0, cap);
  const rest = oldestFirst.slice(cap);

  const shownSizes = await Promise.all(shown.map((t) => dirSize(t.path)));
  const restSizes = await Promise.all(rest.map((t) => dirSize(t.path)));

  const entries: ManifestEntry[] = await Promise.all(
    shown.map(async (t, i) => {
      const traceSizeBytes = shownSizes[i];
      // Run concurrently, not sequentially — each is ~0.3-0.6s (a local plutil
      // read + a db stat/peek, no xctrace), so up to `cap` of these in series
      // would make close_trace noticeably slow; concurrent bounds it to
      // roughly the slowest single one.
      const [dbPath, description] = await Promise.all([findExistingDb(t.path), getTraceDescription(t.path)]);
      let dbSizeBytes: number | null = null;
      let dbStatus: ManifestEntry["dbStatus"] = "none";
      let schemasAnalyzed: string[] | null = null;
      if (dbPath) {
        try {
          dbSizeBytes = (await stat(dbPath)).size;
          const peeked = peekDb(dbPath, t.path, t.mtimeMs);
          dbStatus = peeked.status;
          schemasAnalyzed = peeked.schemas;
        } catch {
          dbStatus = "none";
        }
      }
      return {
        index: i + 1,
        name: t.name,
        path: t.path,
        recordedAt: t.modified,
        traceSizeBytes,
        traceSizeFmt: formatBytes(traceSizeBytes),
        dbPath,
        dbSizeBytes,
        dbSizeFmt: dbSizeBytes !== null ? formatBytes(dbSizeBytes) : null,
        dbStatus,
        schemasAnalyzed,
        description,
      };
    })
  );

  const shownTotal = shownSizes.reduce((a, b) => a + b, 0) + entries.reduce((a, e) => a + (e.dbSizeBytes ?? 0), 0);
  const restTotal = restSizes.reduce((a, b) => a + b, 0);
  const totalBytes = shownTotal + restTotal;

  let freeSpaceBytes: number | null = null;
  try {
    const config = await getConfig();
    const recordingsDir = config.recordingsDir ?? defaultRecordingsDir();
    const fsStat = await statfs(recordingsDir);
    freeSpaceBytes = fsStat.bavail * fsStat.bsize;
  } catch {
    // statfs unsupported or dir missing — omit rather than guess
  }

  return {
    totalTraces: traces.length,
    totalBytes,
    totalBytesFmt: formatBytes(totalBytes),
    freeSpaceBytes,
    freeSpaceFmt: freeSpaceBytes !== null ? formatBytes(freeSpaceBytes) : null,
    entries,
    rolledUp: rest.length > 0 ? { count: rest.length, bytes: restTotal, bytesFmt: formatBytes(restTotal) } : null,
  };
}

export interface DeleteTraceResult {
  path: string;
  deleted: boolean;
  reason?: string;
}

/**
 * Delete specific traces (+ their cached db, colocated or fallback) by exact
 * path. Every path is validated against a FRESH scan of on-disk traces before
 * anything is deleted — a stale/mistyped/already-deleted path is reported,
 * not silently skipped (fail-fast, matching this project's existing
 * error-handling pattern rather than a silent partial success).
 */
export async function deleteTraces(paths: string[]): Promise<DeleteTraceResult[]> {
  const { traces } = await allTraces();
  const validPaths = new Set(traces.map((t) => t.path));

  return Promise.all(
    paths.map(async (path): Promise<DeleteTraceResult> => {
      if (!validPaths.has(path)) {
        return { path, deleted: false, reason: "Not found in the current on-disk trace list — already deleted, moved, or mistyped." };
      }
      try {
        const dbPath = await findExistingDb(path);
        await rm(path, { recursive: true, force: true });
        if (dbPath) {
          await unlink(dbPath).catch(() => {});
        }
        return { path, deleted: true };
      } catch (err) {
        return { path, deleted: false, reason: err instanceof Error ? err.message : String(err) };
      }
    })
  );
}
