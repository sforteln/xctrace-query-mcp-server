/**
 * Session model — load-once trace cache keyed by sessionId.
 *
 * openTrace(path) is the only entry point. It loads the TOC once and mints a
 * sessionId. All subsequent engine calls take that sessionId and reuse the
 * cached state, avoiding the slow xctrace export round-trip on every call.
 *
 * Each session also owns a per-(run,schema) RefCache so parsed table rows
 * are never re-parsed across tool calls (the cache accumulates as the agent
 * drills into more tables).
 */
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { stat } from "node:fs/promises";
import { exportToc, exportXPathStream, buildTableXPath, buildTableXPathAtPosition, buildTrackDetailXPath, XctraceError } from "./xctrace.js";
import { parseTableStream, ParsedTable } from "./parseTable.js";
import { parseTrackDetailStream } from "./parseTrackDetail.js";
import { buildSchemaModel, updateSchemaCols, assertUnambiguousSchema, SchemaModel, trackDetailSchemaName } from "./schemaModel.js";
import { detectXcodeVersion } from "./xcodeVersion.js";
import type { Toc, TocRun } from "./xctrace.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InstrumentSummary {
  /** The schema name (e.g. "ModelInferenceTable", "time-sample"). */
  schema: string;
  /** Which run this schema appears in. */
  run: number;
  /** Row count — populated lazily when the table is first fetched. */
  rowCount: number | null;
}

export interface RunSummary {
  number: number;
  /** Schema names present in this run. */
  schemas: string[];
  /**
   * ISO8601 timestamp of when this run was recorded, derived from the
   * modification time of the run's subdirectory inside the .trace bundle.
   * Null when the directory is not found (older trace formats, simulator, etc.).
   */
  recordedAt: string | null;
}

/** Coarse time range over the session, populated lazily from the first time-bearing table parsed. */
export interface TimeRange {
  /** Earliest timestamp seen (nanoseconds from trace start, matching xctrace raw values). */
  startNs: number;
  /** Latest timestamp seen (nanoseconds). */
  endNs: number;
  /** Human-readable start (the fmt value from xctrace). */
  startFmt: string;
  /** Human-readable end. */
  endFmt: string;
}

export interface TraceSession {
  sessionId: string;
  /** Absolute, resolved path to the .trace bundle. */
  tracePath: string;
  toc: Toc;
  runs: RunSummary[];
  instruments: InstrumentSummary[];
  /** Populated lazily from the first time-bearing table parsed. */
  timeRange: TimeRange | null;
  /** Per-(run,schema) parsed table cache. Key: `${run}:${schema}`. This is the
   *  real load-once cache — parsed tables are reused across tool calls. */
  tableCache: Map<string, ParsedTable>;
  /** Structured schema model: TOC metadata + lazily-populated column definitions. */
  schemaModel: SchemaModel;
  /** Xcode version that produced this trace (e.g. "16.2"). Null if xcodebuild unavailable. */
  xcodeVersion: string | null;
}

// ─── Session registry ─────────────────────────────────────────────────────────

const sessions = new Map<string, TraceSession>();

/** Engineering-type names that carry a start/timestamp value. */
const TIME_ENGINEERING_TYPES = new Set([
  "start-time",
  "sample-time",
  "start",
  "timestamp",
]);

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Open a trace and return a sessionId for subsequent calls.
 *
 * First call for a given path loads the TOC (fast — just schema enumeration).
 * Row data is fetched lazily per-table. The sessionId is stable for the
 * lifetime of the server process; opening the same path twice returns a new
 * sessionId pointing to an independent session (the agent controls which
 * session is active).
 */
export async function openTrace(
  path: string
): Promise<{ sessionId: string; runs: RunSummary[]; instruments: InstrumentSummary[]; timeRange: TimeRange | null; xcodeVersion: string | null }> {
  const tracePath = resolve(path.replace(/^~/, process.env.HOME ?? "~"));
  const [toc, xcodeVersion] = await Promise.all([exportToc(tracePath), detectXcodeVersion()]);

  // De-duplicate track-details per run (same as buildSchemaModel does).
  const seenTrackDetails = new Set<string>();

  const runsBase = toc.runs.map((r) => {
    const tableSchemas = r.tables.map((t) => t.schema);
    const trackSchemas: string[] = [];
    for (const track of r.tracks) {
      for (const detail of track.details) {
        const name = trackDetailSchemaName(track.name, detail.name);
        const key = `${r.number}:${name}`;
        if (!seenTrackDetails.has(key)) {
          seenTrackDetails.add(key);
          trackSchemas.push(name);
        }
      }
    }
    return { number: r.number, schemas: [...tableSchemas, ...trackSchemas] };
  });

  // Timestamps from the run subdirectory mtime — free (no xctrace call needed).
  const runs: RunSummary[] = await Promise.all(
    runsBase.map(async (r) => {
      let recordedAt: string | null = null;
      try {
        const s = await stat(join(tracePath, `Run ${r.number}.run`));
        recordedAt = s.mtime.toISOString();
      } catch {
        // Run directory not found or inaccessible — timestamp stays null.
      }
      return { ...r, recordedAt };
    })
  );

  // Reset for instruments loop.
  seenTrackDetails.clear();

  const instruments: InstrumentSummary[] = toc.runs.flatMap((r) => {
    const tableEntries: InstrumentSummary[] = r.tables.map((t) => ({
      schema: t.schema,
      run: r.number,
      rowCount: null,
    }));
    const trackEntries: InstrumentSummary[] = [];
    for (const track of r.tracks) {
      for (const detail of track.details) {
        const name = trackDetailSchemaName(track.name, detail.name);
        const key = `${r.number}:${name}`;
        if (!seenTrackDetails.has(key)) {
          seenTrackDetails.add(key);
          trackEntries.push({ schema: name, run: r.number, rowCount: null });
        }
      }
    }
    return [...tableEntries, ...trackEntries];
  });

  const sessionId = randomUUID();
  const session: TraceSession = {
    sessionId,
    tracePath,
    toc,
    runs,
    instruments,
    timeRange: null,
    tableCache: new Map(),
    schemaModel: buildSchemaModel(toc.runs),
    xcodeVersion,
  };

  sessions.set(sessionId, session);
  return { sessionId, runs, instruments, timeRange: null, xcodeVersion };
}

/**
 * Retrieve an existing session, throwing a structured error if not found.
 */
export function getSession(sessionId: string): TraceSession {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new XctraceError(
      "export-failed",
      `No session found for sessionId "${sessionId}". Call openTrace first.`,
      {}
    );
  }
  return session;
}

/**
 * Like getTable but fetches the Nth occurrence (1-based) of a schema that
 * appears multiple times in a trace — e.g. SwiftUIFilteredUpdates (3 instances).
 * Cached under the key `${run}:${schema}[${position}]` to avoid re-fetching.
 */
export async function getTableAtPosition(
  sessionId: string,
  run: number,
  schema: string,
  position: number
): Promise<ParsedTable> {
  const session = getSession(sessionId);
  const cacheKey = `${run}:${schema}[${position}]`;

  const cached = session.tableCache.get(cacheKey);
  if (cached) return cached;

  const xpath = buildTableXPathAtPosition(run, schema, position);
  const { stdout, done } = await exportXPathStream(session.tracePath, xpath);
  const [table] = await Promise.all([parseTableStream(stdout), done]);

  // session.instruments has one entry per TOC <table> occurrence, in the same
  // order as schema-table positions — index into it by position, not .find(),
  // so each duplicated instance gets its own row count instead of all of them
  // colliding on the first match.
  const matchingEntries = session.instruments.filter(
    (i) => i.run === run && i.schema === schema
  );
  const entry = matchingEntries[position - 1];
  if (entry) entry.rowCount = table.rows.length;

  session.tableCache.set(cacheKey, table);
  return table;
}

/**
 * Return (and cache) the parsed table for a given run + schema within a session.
 * First call shells out to xctrace; subsequent calls return the cached ParsedTable.
 *
 * Pass `position` (1-based) when the schema appears more than once in this run's
 * TOC — an unqualified fetch on an ambiguous schema would silently concatenate
 * all instances together (xctrace's xpath behavior, not a bug in this server),
 * so this throws a structured "ambiguous-schema" error instead when `position`
 * is omitted and more than one instance exists.
 */
export async function getTable(
  sessionId: string,
  run: number,
  schema: string,
  position?: number
): Promise<ParsedTable> {
  const session = getSession(sessionId);

  if (position !== undefined) {
    return getTableAtPosition(sessionId, run, schema, position);
  }

  assertUnambiguousSchema(session.schemaModel, run, schema);

  const cacheKey = `${run}:${schema}`;

  const cached = session.tableCache.get(cacheKey);
  if (cached) return cached;

  // Look up the schema model entry to decide which fetch+parse path to use.
  const modelEntry = session.schemaModel.find(
    (e) => e.run === run && e.toc.schema === schema
  );

  let table: ParsedTable;
  if (modelEntry?.source === "track-detail" && modelEntry.trackDetail) {
    const { trackName, detailName } = modelEntry.trackDetail;
    const xpath = buildTrackDetailXPath(run, trackName, detailName);
    const { stdout, done } = await exportXPathStream(session.tracePath, xpath);
    [table] = await Promise.all([parseTrackDetailStream(stdout, schema), done]);
  } else {
    const xpath = buildTableXPath(run, schema);
    const { stdout, done } = await exportXPathStream(session.tracePath, xpath);
    [table] = await Promise.all([parseTableStream(stdout), done]);
  }

  // Update row count on the instruments summary entry.
  const entry = session.instruments.find(
    (i) => i.run === run && i.schema === schema
  );
  if (entry) entry.rowCount = table.rows.length;

  // Populate column definitions in the schema model.
  updateSchemaCols(session.schemaModel, run, schema, table.cols);

  // Lazily update session timeRange from any time-bearing column in this table.
  if (session.timeRange === null) {
    updateTimeRange(session, table);
  }

  session.tableCache.set(cacheKey, table);
  return table;
}

/**
 * Return a concise summary of the session — runs, instruments, and whatever
 * timeRange has been discovered so far.
 */
export function summary(sessionId: string): {
  sessionId: string;
  tracePath: string;
  runs: RunSummary[];
  instruments: InstrumentSummary[];
  timeRange: TimeRange | null;
  xcodeVersion: string | null;
} {
  const session = getSession(sessionId);
  return {
    sessionId: session.sessionId,
    tracePath: session.tracePath,
    runs: session.runs,
    instruments: session.instruments,
    timeRange: session.timeRange,
    xcodeVersion: session.xcodeVersion,
  };
}

/**
 * Return the schema model for a session.
 */
export function getSchemaModel(sessionId: string): SchemaModel {
  return getSession(sessionId).schemaModel;
}

/**
 * Return the highest run number in the session — the default run for all
 * tools that make `run` optional. Traces commonly have multiple runs (each
 * Record→Stop cycle adds one); the last run is almost always what the user
 * wants when they don't specify.
 */
export function lastRun(sessionId: string): number {
  const session = getSession(sessionId);
  return Math.max(...session.runs.map((r) => r.number));
}

/**
 * Close a session and free its memory. Optional — the process dying achieves
 * the same thing, but explicit close lets agents hand back resources.
 */
export function closeSession(sessionId: string): void {
  sessions.delete(sessionId);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function updateTimeRange(session: TraceSession, table: ParsedTable): void {
  // Find the first column whose engineering-type is time-bearing.
  const timeCol = table.cols.find((c) =>
    TIME_ENGINEERING_TYPES.has(c.engineeringType)
  );
  if (!timeCol || table.rows.length === 0) return;

  const mnemonic = timeCol.mnemonic;
  let startNs = Infinity;
  let endNs = -Infinity;
  let startFmt = "";
  let endFmt = "";

  for (const row of table.rows) {
    const cell = row[mnemonic];
    if (!cell) continue;
    const ns = typeof cell.raw === "number" ? cell.raw : Number(cell.raw);
    if (!isFinite(ns)) continue;
    if (ns < startNs) { startNs = ns; startFmt = cell.fmt; }
    if (ns > endNs) { endNs = ns; endFmt = cell.fmt; }
  }

  if (isFinite(startNs) && isFinite(endNs)) {
    session.timeRange = { startNs, endNs, startFmt, endFmt };
  }
}
