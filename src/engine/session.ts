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
import type { DatabaseSync } from "node:sqlite";
import { exportToc, exportXPathStream, buildTableXPath, buildTableXPathAtPosition, buildTrackDetailXPath, XctraceError } from "./xctrace.js";
import { parseTableStreamMeta, parseTableStreamToSqlite, SchemaCol, SchemaMeta } from "./parseTable.js";
import { parseTrackDetailStreamMeta, parseTrackDetailStreamToSqlite } from "./parseTrackDetail.js";
import { quoteIdent, loadIngestedSchemaCols } from "./sqliteStore.js";
import { resolveAndOpenTraceDb } from "./traceCache.js";
import { registerRegexpUdf, registerPercentileUdfs, registerInternDecodeUdf } from "./sqlHydrate.js";
import { classifyWithHints } from "./roleHints.js";
import { buildSchemaModel, updateSchemaCols, assertUnambiguousSchema, SchemaModel, trackDetailSchemaName } from "./schemaModel.js";
import { detectXcodeVersion } from "./xcodeVersion.js";
import type { Toc, TocRun } from "./xctrace.js";

/**
 * A schema-per-table SQLite ingestion result (PMT:gravel-cape) — the handle
 * every verb reads through. No `rows` array: callers read data back out via
 * SQL against (dbPath, tableName), not by iterating a JS array. Every verb
 * (query/aggregate/find/get_row/call_tree/relate/correlate/timeline) reads
 * from SQL against this handle — the JS-array `.rows` shape this replaced is
 * gone entirely (PMT:dusk-floe onward).
 */
export interface SqliteTableHandle {
  schema: string;
  cols: SchemaCol[];
  dbPath: string;
  tableName: string;
  rowCount: number;
}

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
  /** Per-(run,schema) SQLite ingestion cache. Key: `${run}:${schema}`. This
   *  is the real load-once cache — a schema is ingested into SQLite at most
   *  once per session; a cache hit means "already a table in dbPath," not
   *  "rows held in this Map" (see PMT:gravel-cape). */
  tableCache: Map<string, SqliteTableHandle>;
  /** Absolute path to this session's persisted SQLite DB file — one file,
   *  one SQL table per (run,schema) inside it. Colocated next to the .trace
   *  (or in the fallback cache directory) and NOT deleted on close_trace
   *  (PMT:ruby-peak) — a later session reopening the same trace path reuses
   *  it, including tables a PRIOR PROCESS already ingested. Null until the
   *  first table fetch resolves+opens it (see getSessionDb) — open_trace
   *  itself never touches this. */
  dbPath: string | null;
  /** Lazily opened on first table fetch — cheap to defer since open_trace
   *  itself never touches row data. */
  db: DatabaseSync | null;
  /** Memoized query/aggregate/find results keyed by callCache.ts's cacheKey —
   *  see that module's header comment for why this exists (client-side
   *  timeouts vs. server-side completion). */
  callCache: Map<string, unknown>;
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
    callCache: new Map(),
    schemaModel: buildSchemaModel(toc.runs),
    xcodeVersion,
    dbPath: null,
    db: null,
  };

  sessions.set(sessionId, session);
  return { sessionId, runs, instruments, timeRange: null, xcodeVersion };
}

/**
 * Lazily resolve + open (and cache on the session) the persisted SQLite DB
 * backing this session's ingested tables (PMT:ruby-peak). Deferred until the
 * first table fetch — cheap to defer since open_trace never touches row
 * data, and this itself stays cheap regardless of WHEN it runs (a local
 * sqlite file open + a one-row _meta read, no xctrace call).
 */
async function getSessionDb(session: TraceSession): Promise<DatabaseSync> {
  if (session.db) return session.db;
  const resolved = await resolveAndOpenTraceDb(session.tracePath);
  session.dbPath = resolved.dbPath;
  session.db = resolved.db;
  // Registered once per connection, not per query — find()'s regex op compiles
  // down to the regex UDF, aggregate()'s percentile ops to the percentile
  // aggregates (see PMT:dusk-floe / PMT:round-rime / sqlHydrate.ts's headers).
  registerRegexpUdf(session.db);
  registerPercentileUdfs(session.db);
  registerInternDecodeUdf(session.db);
  return session.db;
}

/**
 * Index the columns query/aggregate/find actually filter/group/sort by most —
 * time/thread/weight roles, per aggregate's own "top N by weight" workhorse
 * pattern. Done ONCE, right after ingestion completes, not lazily at query
 * time (PMT:dusk-floe) — a schema should arrive "ready to go." Indexes both
 * the raw column (numeric comparisons, timeRange) and the __fmt column
 * (equality/groupBy, which key off the display value — see aggregate.ts's
 * `groupCell.fmt` groupBy key).
 */
function indexRoleColumns(db: DatabaseSync, tableName: string, cols: SchemaCol[], schema: string): void {
  const classified = classifyWithHints(schema, cols);
  for (const col of classified) {
    if (col.roleInfo.role !== "time" && col.roleInfo.role !== "thread" && col.roleInfo.role !== "weight") continue;
    // Backtrace-typed columns only have a __backtrace_id column, no raw/__fmt —
    // never true for time/thread/weight roles, but a defensive skip regardless.
    for (const suffix of ["", "__fmt"]) {
      const physicalCol = `${col.mnemonic}${suffix}`;
      const idxName = `idx_${tableName}_${physicalCol}`.replace(/[^a-zA-Z0-9_]/g, "_");
      try {
        db.exec(
          `CREATE INDEX IF NOT EXISTS "${idxName}" ON "${tableName}" ("${physicalCol.replace(/"/g, '""')}")`
        );
      } catch {
        // A promoted/renamed column shape that doesn't exist under this exact
        // name is not worth failing ingestion over — indexing is an
        // optimization, not a correctness requirement.
      }
    }
  }
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
 * Public accessor for the session's SQLite connection — used by
 * query/aggregate/find/get_row (PMT:dusk-floe) to run SQL directly against
 * an already-ingested table. Always call getTable/getTableAtPosition FIRST
 * (this never triggers ingestion itself) so the target table actually exists.
 */
export async function getDb(sessionId: string): Promise<DatabaseSync> {
  return getSessionDb(getSession(sessionId));
}

/**
 * Return the already-cached table for a run + schema, or undefined if it
 * hasn't been fetched yet. Never triggers an xctrace export — use this when
 * a cheap, synchronous caller (e.g. a lens's nextActions) wants to enrich its
 * response with data from another schema only when that data is already warm,
 * without risking turning a fast call into a multi-minute one on a cold fetch.
 */
export function peekTable(sessionId: string, run: number, schema: string): SqliteTableHandle | undefined {
  const session = getSession(sessionId);
  return session.tableCache.get(`${run}:${schema}`);
}

/**
 * Synchronous counterpart to getDb, for callers (lens nextActions hints) that
 * only ever run after confirming peekTable() already found a cached handle —
 * if a table is cached, session.db must already be open (getTable/
 * getTableAtPosition always open it before ingesting), so there's no async
 * lazy-init path to await here. Returns undefined if nothing has been
 * ingested yet this session at all.
 */
export function peekDb(sessionId: string): DatabaseSync | undefined {
  return getSession(sessionId).db ?? undefined;
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
): Promise<SqliteTableHandle> {
  const session = getSession(sessionId);
  const cacheKey = `${run}:${schema}[${position}]`;

  const cached = session.tableCache.get(cacheKey);
  if (cached) return cached;

  const db = await getSessionDb(session);

  // PMT:ruby-peak reuse check — see getTable's matching comment.
  const reusedCols = loadIngestedSchemaCols(db, cacheKey);
  let cols: SchemaCol[];
  let rowCount: number;
  if (reusedCols) {
    cols = reusedCols;
    rowCount = (db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(cacheKey)}`).get() as { n: number }).n;
  } else {
    const xpath = buildTableXPathAtPosition(run, schema, position);
    const { stdout, done } = await exportXPathStream(session.tracePath, xpath);
    const [ingested] = await Promise.all([parseTableStreamToSqlite(stdout, db, cacheKey), done]);
    cols = ingested.cols;
    rowCount = ingested.rowCount;
  }
  indexRoleColumns(db, cacheKey, cols, schema);
  const handle: SqliteTableHandle = {
    schema,
    cols,
    dbPath: session.dbPath!,
    tableName: cacheKey,
    rowCount,
  };

  // session.instruments has one entry per TOC <table> occurrence, in the same
  // order as schema-table positions — index into it by position, not .find(),
  // so each duplicated instance gets its own row count instead of all of them
  // colliding on the first match.
  const matchingEntries = session.instruments.filter(
    (i) => i.run === run && i.schema === schema
  );
  const entry = matchingEntries[position - 1];
  if (entry) entry.rowCount = handle.rowCount;

  session.tableCache.set(cacheKey, handle);
  return handle;
}

/**
 * Return (and cache) the ingested-table handle for a given run + schema within
 * a session. First call ingests (xctrace export → SQLite, or a zero-parse reuse
 * of a persisted cache — see getSessionDb/PMT:ruby-peak); subsequent calls
 * return the cached SqliteTableHandle.
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
): Promise<SqliteTableHandle> {
  const session = getSession(sessionId);

  if (position !== undefined) {
    return getTableAtPosition(sessionId, run, schema, position);
  }

  assertUnambiguousSchema(session.schemaModel, run, schema);

  const cacheKey = `${run}:${schema}`;

  const cached = session.tableCache.get(cacheKey);
  if (cached) return cached;

  // Two layers guard the single session db connection against concurrent
  // ingestion (which interleaves transactions and hits "database is locked" —
  // found live via a thread-info self-join in relate()):
  //   (1) per-(run,schema) dedupe — two concurrent calls for the SAME table
  //       (relate() self-joining a schema, or two tool calls racing an
  //       uncached schema) share ONE ingestion.
  //   (2) per-session serialization — two calls for DIFFERENT schemas
  //       (relate()'s Promise.all over A and B) can't both DROP/CREATE/INSERT
  //       on the one connection at once, so each ingestion awaits any prior
  //       one on this session before touching the db.
  const pendKey = `${sessionId}:${cacheKey}`;
  const inflight = pendingIngest.get(pendKey);
  if (inflight) return inflight;

  const prior = sessionIngestChain.get(sessionId) ?? Promise.resolve();
  const ingestion = (async (): Promise<SqliteTableHandle> => {
    await prior.catch(() => {}); // serialize after any prior ingestion; its failure isn't ours
    const db = await getSessionDb(session);

    // PMT:ruby-peak reuse check — this exact (run,schema) table may already
    // sit fully ingested in this SAME persisted db file, left by a PRIOR
    // PROCESS that opened this trace path before (getSessionDb already
    // confirmed the file is fresh — its mtime matches the live .trace — so a
    // table recorded in it is trustworthy). If so, skip xctrace entirely:
    // no export, no parse, not even the track-detail schema's usual second
    // discovery pass. This is the actual "zero re-parse cost" this feature
    // exists to deliver — resolving WHERE the .db lives is necessary but not
    // sufficient without this.
    const reusedCols = loadIngestedSchemaCols(db, cacheKey);

    let cols: SchemaCol[];
    let rowCount: number;
    if (reusedCols) {
      cols = reusedCols;
      rowCount = (db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(cacheKey)}`).get() as { n: number }).n;
    } else {
      // Look up the schema model entry to decide which fetch+parse path to use.
      const modelEntry = session.schemaModel.find(
        (e) => e.run === run && e.toc.schema === schema
      );

      if (modelEntry?.source === "track-detail" && modelEntry.trackDetail) {
        const { trackName, detailName } = modelEntry.trackDetail;
        const xpath = buildTrackDetailXPath(run, trackName, detailName);
        // Track-detail has no upfront <schema> block — column shape is only
        // knowable from the union of attributes across every row. A cheap
        // discovery-only pass (bounded memory, no row data) learns cols first;
        // a second real export+pass ingests using those now-known columns. See
        // parseTrackDetailStreamToSqlite's own doc comment for why this is two
        // xctrace exports instead of one.
        const discoverExport = await exportXPathStream(session.tracePath, xpath);
        const [meta] = await Promise.all([
          parseTrackDetailStreamMeta(discoverExport.stdout, schema),
          discoverExport.done,
        ]);
        cols = meta.cols;
        const ingestExport = await exportXPathStream(session.tracePath, xpath);
        const [ingested] = await Promise.all([
          parseTrackDetailStreamToSqlite(ingestExport.stdout, cols, db, cacheKey),
          ingestExport.done,
        ]);
        rowCount = ingested.rowCount;
      } else {
        const xpath = buildTableXPath(run, schema);
        const { stdout, done } = await exportXPathStream(session.tracePath, xpath);
        const [ingested] = await Promise.all([parseTableStreamToSqlite(stdout, db, cacheKey), done]);
        cols = ingested.cols;
        rowCount = ingested.rowCount;
      }
    }

    indexRoleColumns(db, cacheKey, cols, schema);
    const handle: SqliteTableHandle = { schema, cols, dbPath: session.dbPath!, tableName: cacheKey, rowCount };

    // Update row count on the instruments summary entry.
    const entry = session.instruments.find(
      (i) => i.run === run && i.schema === schema
    );
    if (entry) entry.rowCount = rowCount;

    // Populate column definitions in the schema model.
    updateSchemaCols(session.schemaModel, run, schema, cols);

    // Lazily update session timeRange from any time-bearing column in this table.
    if (session.timeRange === null) {
      updateTimeRange(session, db, handle);
    }

    session.tableCache.set(cacheKey, handle);
    return handle;
  })();

  pendingIngest.set(pendKey, ingestion);
  sessionIngestChain.set(sessionId, ingestion.then(() => {}, () => {}));
  try {
    return await ingestion;
  } finally {
    pendingIngest.delete(pendKey);
  }
}

/**
 * In-flight ingestion promises keyed by `${sessionId}:${run}:${schema}` —
 * layer (1), per-table dedupe. See getTable.
 */
const pendingIngest = new Map<string, Promise<SqliteTableHandle>>();
/**
 * Tail of the per-session ingestion chain — layer (2), serialization. Each new
 * ingestion awaits this before touching the db, then becomes the new tail. See getTable.
 */
const sessionIngestChain = new Map<string, Promise<void>>();

/**
 * Like getTable but never materializes row data — column shape and a row
 * count only, for callers like describeSchema that don't touch a single row.
 * Skips the full fetch three ways, cheapest first: (1) cols + rowCount are
 * already known from an earlier fetch (full OR meta) — no xctrace call at
 * all; (2) the full table happens to already be cached (some other caller
 * already paid the cost) — reuse it instead of a redundant round-trip; (3)
 * otherwise stream just enough to learn cols + a count, via
 * parseTableStreamMeta/parseTrackDetailStreamMeta, and record what was
 * learned on session.schemaModel/session.instruments so later calls
 * (including a repeat describeSchema) benefit too. Deliberately does NOT
 * populate session.tableCache — that cache means "full rows available," and
 * a caller expecting real rows (query/aggregate/get_row) must never receive
 * this table's empty rows array by silent cache reuse.
 */
export async function getSchemaMeta(
  sessionId: string,
  run: number,
  schema: string,
  position?: number
): Promise<SchemaMeta> {
  const session = getSession(sessionId);

  if (position === undefined) {
    assertUnambiguousSchema(session.schemaModel, run, schema);

    const modelEntry = session.schemaModel.find((e) => e.run === run && e.toc.schema === schema);
    const instrumentEntry = session.instruments.find((i) => i.run === run && i.schema === schema);
    if (modelEntry?.cols && instrumentEntry?.rowCount !== null && instrumentEntry?.rowCount !== undefined) {
      return { cols: modelEntry.cols, rowCount: instrumentEntry.rowCount };
    }
  }

  const cacheKey = position !== undefined ? `${run}:${schema}[${position}]` : `${run}:${schema}`;
  const cachedFull = session.tableCache.get(cacheKey);
  if (cachedFull) {
    return { cols: cachedFull.cols, rowCount: cachedFull.rowCount };
  }

  // PMT:ruby-peak fast path — a PRIOR PROCESS may have already ingested this
  // exact table into the SAME persisted db file this session just opened,
  // even though THIS process's own in-memory schemaModel/tableCache (both
  // process-local, checked above) don't know about it yet. Opening the
  // session db is cheap (a local file open, no xctrace call) regardless of
  // whether this fast path pans out, so it's safe to check unconditionally.
  const db = await getSessionDb(session);
  const reusedCols = loadIngestedSchemaCols(db, cacheKey);
  if (reusedCols) {
    const rowCount = (db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(cacheKey)}`).get() as { n: number }).n;
    if (position !== undefined) {
      const matchingEntries = session.instruments.filter((i) => i.run === run && i.schema === schema);
      const entry = matchingEntries[position - 1];
      if (entry) entry.rowCount = rowCount;
    } else {
      const entry = session.instruments.find((i) => i.run === run && i.schema === schema);
      if (entry) entry.rowCount = rowCount;
      updateSchemaCols(session.schemaModel, run, schema, reusedCols);
    }
    return { cols: reusedCols, rowCount };
  }

  let meta: SchemaMeta;
  if (position !== undefined) {
    // Position-aware ambiguous schemas are schema-table format in every
    // known case (mirrors getTableAtPosition, which never checks track-detail).
    const xpath = buildTableXPathAtPosition(run, schema, position);
    const { stdout, done } = await exportXPathStream(session.tracePath, xpath);
    [meta] = await Promise.all([parseTableStreamMeta(stdout), done]);

    const matchingEntries = session.instruments.filter((i) => i.run === run && i.schema === schema);
    const entry = matchingEntries[position - 1];
    if (entry) entry.rowCount = meta.rowCount;
    // Not calling updateSchemaCols here — getTableAtPosition doesn't either;
    // schemaModel's cols slot isn't position-aware today (see its own comment).
  } else {
    const modelEntry = session.schemaModel.find((e) => e.run === run && e.toc.schema === schema);
    if (modelEntry?.source === "track-detail" && modelEntry.trackDetail) {
      const { trackName, detailName } = modelEntry.trackDetail;
      const xpath = buildTrackDetailXPath(run, trackName, detailName);
      const { stdout, done } = await exportXPathStream(session.tracePath, xpath);
      [meta] = await Promise.all([parseTrackDetailStreamMeta(stdout, schema), done]);
    } else {
      const xpath = buildTableXPath(run, schema);
      const { stdout, done } = await exportXPathStream(session.tracePath, xpath);
      [meta] = await Promise.all([parseTableStreamMeta(stdout), done]);
    }

    const entry = session.instruments.find((i) => i.run === run && i.schema === schema);
    if (entry) entry.rowCount = meta.rowCount;
    updateSchemaCols(session.schemaModel, run, schema, meta.cols);
  }

  return meta;
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
 * Close a session and free its in-process memory. Optional — the process
 * dying achieves the same thing, but explicit close lets agents hand back
 * resources.
 *
 * Does NOT delete the session's SQLite DB file (PMT:ruby-peak) — it's now a
 * persisted cache colocated with the .trace (or in the fallback cache
 * directory), meant to outlive this process so a later session reopening the
 * same trace path pays zero re-parse cost. Only the connection is closed;
 * the file, and every table already ingested into it, stays on disk.
 */
export function closeSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session?.db) session.db.close();
  sessions.delete(sessionId);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Find the session's overall time bounds from a just-ingested table via a
 * SQL MIN/MAX query — the SQLite-backed counterpart of the old JS loop over
 * `table.rows` (PMT:gravel-cape; there is no rows array to loop over anymore).
 */
function updateTimeRange(session: TraceSession, db: DatabaseSync, handle: SqliteTableHandle): void {
  const timeCol = handle.cols.find((c) => TIME_ENGINEERING_TYPES.has(c.engineeringType));
  if (!timeCol || handle.rowCount === 0) return;

  const mnemonic = timeCol.mnemonic;
  const raw = `"${mnemonic.replace(/"/g, '""')}"`;
  const fmt = `"${mnemonic.replace(/"/g, '""')}__fmt"`;
  const table = `"${handle.tableName.replace(/"/g, '""')}"`;

  const minRow = db.prepare(
    `SELECT ${raw} as ns, ${fmt} as fmt FROM ${table} WHERE ${raw} IS NOT NULL ORDER BY ${raw} ASC LIMIT 1`
  ).get() as { ns: number; fmt: string } | undefined;
  const maxRow = db.prepare(
    `SELECT ${raw} as ns, ${fmt} as fmt FROM ${table} WHERE ${raw} IS NOT NULL ORDER BY ${raw} DESC LIMIT 1`
  ).get() as { ns: number; fmt: string } | undefined;

  if (minRow && maxRow && isFinite(minRow.ns) && isFinite(maxRow.ns)) {
    session.timeRange = { startNs: minRow.ns, endNs: maxRow.ns, startFmt: minRow.fmt, endFmt: maxRow.fmt };
  }
}
