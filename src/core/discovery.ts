/**
 * Discovery: scan configured roots for .trace bundles.
 *
 * Scans built-in Xcode autosave paths and user-configured roots.
 * Each root is scanned one level deep (root children + immediate
 * subdirectory children) to catch both flat and one-deep layouts.
 *
 * findTrace(query) ranks results by word-overlap with the bundle name,
 * with recency as the tiebreaker — "my last Foundation Models run" works.
 */
import { readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { getConfig, defaultRecordingsDir } from "../config.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TraceInfo {
  name: string;
  path: string;
  root: string;
  rootType: "built-in" | "user";
  mtimeMs: number;
  modified: string;
}

export interface RootStatus {
  path: string;
  type: "built-in" | "user";
  exists: boolean;
}

export interface ListTracesResult {
  found: number;
  searchedRoots: RootStatus[];
  traces: TraceInfo[];
  hint?: string;
}

export interface FindTraceResult {
  query: string;
  found: number;
  searchedRoots: RootStatus[];
  traces: TraceInfo[];
  hint?: string;
}

// ─── Built-in roots ───────────────────────────────────────────────────────────

/**
 * `recordingsDir` is whichever directory new recordings are
 * ACTUALLY saved to right now — the user-configured one if set, else
 * defaultRecordingsDir(). Always included as a built-in root (not part of the
 * user-facing searchRoots list) so a trace made in one session stays
 * discoverable by name in a later one without a separate add_search_root call
 * for the server's own output directory — and immediately reflects a
 * set_recordings_dir change with no extra step.
 */
export function builtInRootPaths(recordingsDir: string): string[] {
  const home = homedir();
  return [
    join(home, "Library", "Developer", "Xcode", "Instruments"),
    join(home, "Library", "Caches", "com.apple.dt.instruments"),
    recordingsDir,
  ];
}

// ─── Scanning ────────────────────────────────────────────────────────────────

/** Collect .trace bundles (directories) that are immediate children of dir. */
async function tracesInDir(dir: string): Promise<Array<{ name: string; path: string; mtimeMs: number }>> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const results: Array<{ name: string; path: string; mtimeMs: number }> = [];
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.endsWith(".trace")) return;
      const fullPath = join(dir, entry);
      try {
        const s = await stat(fullPath);
        if (s.isDirectory()) {
          results.push({ name: entry, path: fullPath, mtimeMs: s.mtimeMs });
        }
      } catch {
        // skip inaccessible entries
      }
    })
  );
  return results;
}

/**
 * Scan one root: immediate children + one subdirectory level deep.
 * Handles both flat organization (root/MyApp.trace) and one-deep
 * nesting (root/Project/MyApp.trace).
 */
async function scanRoot(
  rootPath: string,
  rootType: "built-in" | "user"
): Promise<TraceInfo[]> {
  // Gather .trace bundles at the root level.
  const topLevel = await tracesInDir(rootPath);

  // Also scan immediate subdirectories (non-.trace ones).
  let subdirEntries: string[] = [];
  try {
    subdirEntries = await readdir(rootPath);
  } catch {
    // unreadable root
  }

  const subDirTraces: Array<{ name: string; path: string; mtimeMs: number }> = [];
  await Promise.all(
    subdirEntries
      .filter((e) => !e.endsWith(".trace") && !e.startsWith("."))
      .map(async (entry) => {
        const subPath = join(rootPath, entry);
        try {
          const s = await stat(subPath);
          if (!s.isDirectory()) return;
          const found = await tracesInDir(subPath);
          subDirTraces.push(...found);
        } catch {
          // skip
        }
      })
  );

  const all = [...topLevel, ...subDirTraces];

  // De-duplicate by path in case both levels somehow overlap.
  const seen = new Set<string>();
  return all
    .filter(({ path }) => {
      if (seen.has(path)) return false;
      seen.add(path);
      return true;
    })
    .map(({ name, path, mtimeMs }) => ({
      name,
      path,
      root: rootPath,
      rootType,
      mtimeMs,
      modified: new Date(mtimeMs).toISOString(),
    }));
}

// ─── All-roots scan ──────────────────────────────────────────────────────────

/** Exported for callers that need the raw newest-first scan directly (e.g. the trace manifest). */
export async function allTraces(): Promise<{ traces: TraceInfo[]; roots: RootStatus[] }> {
  const config = await getConfig();
  const builtIns = builtInRootPaths(config.recordingsDir ?? defaultRecordingsDir());

  const roots: RootStatus[] = [];
  const traceGroups: TraceInfo[][] = [];

  for (const rootPath of builtIns) {
    let exists = false;
    try {
      await stat(rootPath);
      exists = true;
    } catch {
      // doesn't exist
    }
    roots.push({ path: rootPath, type: "built-in", exists });
    if (exists) {
      traceGroups.push(await scanRoot(rootPath, "built-in"));
    }
  }

  for (const rootPath of config.searchRoots) {
    let exists = false;
    try {
      await stat(rootPath);
      exists = true;
    } catch {
      // doesn't exist
    }
    roots.push({ path: rootPath, type: "user", exists });
    if (exists) {
      traceGroups.push(await scanRoot(rootPath, "user"));
    }
  }

  // Merge + de-dup by path, sort newest-first.
  const seen = new Set<string>();
  const traces: TraceInfo[] = [];
  for (const group of traceGroups) {
    for (const t of group) {
      if (!seen.has(t.path)) {
        seen.add(t.path);
        traces.push(t);
      }
    }
  }
  traces.sort((a, b) => b.mtimeMs - a.mtimeMs);

  return { traces, roots };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** List all .trace bundles across built-in and configured roots, newest first. */
export async function listTraces(): Promise<ListTracesResult> {
  const { traces, roots } = await allTraces();
  const result: ListTracesResult = {
    found: traces.length,
    searchedRoots: roots,
    traces,
  };
  if (traces.length === 0) {
    result.hint =
      "No .trace files found. " +
      "Use add_search_root to add the directory where your recordings are saved, " +
      "or open a trace directly with open_trace(path).";
  }
  return result;
}

/**
 * Find .trace bundles matching a natural-language query.
 *
 * Ranking: each query word that appears (case-insensitive) in the bundle
 * name scores 1 point. Ties broken by recency (newest first).
 * The top 10 matches are returned.
 *
 * "last", "latest", "recent", "newest" sort the full list by recency
 * without requiring any name match, so "my last run" returns the newest trace.
 */
export async function findTrace(query: string): Promise<FindTraceResult> {
  const { traces, roots } = await allTraces();

  if (traces.length === 0) {
    return {
      query,
      found: 0,
      searchedRoots: roots,
      traces: [],
      hint:
        "No .trace files found in any search root. " +
        "Use add_search_root to add the directory where your recordings are saved.",
    };
  }

  const recencyWords = new Set(["last", "latest", "recent", "newest", "new"]);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hasRecencyWord = words.some((w) => recencyWords.has(w));
  const contentWords = words.filter((w) => !recencyWords.has(w));

  // Score each trace.
  const scored = traces.map((t) => {
    const nameLower = t.name.toLowerCase();
    const score = contentWords.reduce(
      (acc, w) => acc + (nameLower.includes(w) ? 1 : 0),
      0
    );
    return { t, score };
  });

  let ranked: TraceInfo[];

  if (hasRecencyWord && contentWords.length === 0) {
    // Pure recency query — already sorted newest-first from allTraces().
    ranked = traces.slice(0, 10);
  } else if (hasRecencyWord) {
    // Recency + content: sort by score desc, then mtime desc.
    ranked = scored
      .sort((a, b) => b.score - a.score || b.t.mtimeMs - a.t.mtimeMs)
      .slice(0, 10)
      .map(({ t }) => t);
  } else {
    // Content-only: filter to any match (score > 0), then rank by score+recency.
    // If nothing matches, fall back to all traces sorted by recency.
    const matches = scored.filter(({ score }) => score > 0);
    const pool = matches.length > 0 ? matches : scored;
    ranked = pool
      .sort((a, b) => b.score - a.score || b.t.mtimeMs - a.t.mtimeMs)
      .slice(0, 10)
      .map(({ t }) => t);
  }

  const result: FindTraceResult = {
    query,
    found: ranked.length,
    searchedRoots: roots,
    traces: ranked,
  };

  if (ranked.length === 0) {
    result.hint =
      `No traces matched "${query}". ` +
      "Use list_traces to see all available traces, or add_search_root to add more directories.";
  } else if (contentWords.length > 0) {
    const totalFound = scored.filter(({ score }) => score > 0).length;
    if (totalFound > ranked.length) {
      result.hint = `Showing top 10 of ${totalFound} matches. Use list_traces to see all.`;
    }
  }

  return result;
}
