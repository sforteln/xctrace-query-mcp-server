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
import { resolve } from "node:path";
import { exportToc, exportXPath, buildTableXPath, XctraceError } from "./xctrace.js";
import { parseTableXml, ParsedTable, RefCache } from "./parseTable.js";
import { buildSchemaModel, updateSchemaCols, SchemaModel } from "./schemaModel.js";
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
  /** Per-(run,schema) parsed table cache. Key: `${run}:${schema}`. */
  tableCache: Map<string, ParsedTable>;
  /** Shared ref-id resolution cache across all tables in this session. */
  refCache: RefCache;
  /** Structured schema model: TOC metadata + lazily-populated column definitions. */
  schemaModel: SchemaModel;
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
): Promise<{ sessionId: string; runs: RunSummary[]; instruments: InstrumentSummary[]; timeRange: TimeRange | null }> {
  const tracePath = resolve(path.replace(/^~/, process.env.HOME ?? "~"));
  const toc = await exportToc(tracePath);

  const runs: RunSummary[] = toc.runs.map((r) => ({
    number: r.number,
    schemas: r.tables.map((t) => t.schema),
  }));

  const instruments: InstrumentSummary[] = toc.runs.flatMap((r) =>
    r.tables.map((t) => ({
      schema: t.schema,
      run: r.number,
      rowCount: null,
    }))
  );

  const sessionId = randomUUID();
  const session: TraceSession = {
    sessionId,
    tracePath,
    toc,
    runs,
    instruments,
    timeRange: null,
    tableCache: new Map(),
    refCache: new Map(),
    schemaModel: buildSchemaModel(toc.runs),
  };

  sessions.set(sessionId, session);
  return { sessionId, runs, instruments, timeRange: null };
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
 * Return (and cache) the parsed table for a given run + schema within a session.
 * First call shells out to xctrace; subsequent calls return the cached ParsedTable.
 */
export async function getTable(
  sessionId: string,
  run: number,
  schema: string
): Promise<ParsedTable> {
  const session = getSession(sessionId);
  const cacheKey = `${run}:${schema}`;

  const cached = session.tableCache.get(cacheKey);
  if (cached) return cached;

  const xpath = buildTableXPath(run, schema);
  const xml = await exportXPath(session.tracePath, xpath);
  const table = parseTableXml(xml, session.refCache);

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
} {
  const session = getSession(sessionId);
  return {
    sessionId: session.sessionId,
    tracePath: session.tracePath,
    runs: session.runs,
    instruments: session.instruments,
    timeRange: session.timeRange,
  };
}

/**
 * Return the schema model for a session.
 */
export function getSchemaModel(sessionId: string): SchemaModel {
  return getSession(sessionId).schemaModel;
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
