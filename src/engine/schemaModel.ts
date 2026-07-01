/**
 * Schema model — structured view of each instrument's tables and columns.
 *
 * Data comes from two sources, loaded at different times:
 *   1. TOC attributes (available immediately after openTrace): schema name,
 *      documentation, callstack hint, sampling config, subsystem/category for
 *      os-signpost/os-log, swift-table marker for Foundation Models tables.
 *   2. Column definitions (populated lazily when a table is first fetched via
 *      getTable): mnemonic, display name, engineering-type — the same SchemaCol
 *      objects parsed from the --xpath <schema><col> elements.
 *
 * Role classification (time/weight/backtrace/thread/label/detail) is the next
 * layer and lives in src/engine/roleInference.ts.
 * This module just captures what the raw xctrace output tells us.
 */
import { XctraceError } from "./xctrace.js";
import type { TocTable, TocRun } from "./xctrace.js";
import type { SchemaCol } from "./parseTable.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Attributes available from the TOC <table> element. */
export interface TableTocMeta {
  /** The schema name (e.g. "time-sample", "ModelInferenceTable"). */
  schema: string;
  /** Human-readable description from the documentation attribute. */
  documentation: string | null;
  /** Whether the table includes callstack data ("user", "kernel", or "user kernel"). */
  callstack: string | null;
  /** Sample rate in microseconds (time-sample instrument). */
  sampleRateMicros: number | null;
  /** Swift table class name — present on Foundation Models custom tables. */
  swiftTable: string | null;
  /** os-signpost/os-log subsystem filter(s), space-separated quoted values from xctrace. */
  subsystem: string | null;
  /** os-signpost/os-log category filter(s). */
  category: string | null;
  /** kdebug event codes. */
  codes: string | null;
  /** Target scope: "SINGLE" (one process), "ALL" (system-wide), or other. */
  target: string | null;
  /** Any other raw attributes not explicitly modelled above. */
  extra: Record<string, string>;
}

/** Addressing coords for a track-detail entry (null on schema-tables). */
export interface TrackDetailAddress {
  trackName: string;
  detailName: string;
  detailKind: string;
}

/** A table entry in the schema model — TOC metadata plus lazily-loaded columns. */
export interface TableSchema {
  /** Which run this table entry belongs to. */
  run: number;
  /** Whether this came from /data/table or /tracks/track/details/detail. */
  source: "schema-table" | "track-detail";
  /** TOC-level metadata, available immediately after openTrace. */
  toc: TableTocMeta;
  /**
   * Track-detail addressing (trackName + detailName). Null for schema-tables.
   * Used by the fetch layer to build the correct XPath for track-details.
   */
  trackDetail: TrackDetailAddress | null;
  /**
   * Column definitions from the --xpath <schema><col> elements.
   * Null until the table is first fetched via getTable().
   */
  cols: SchemaCol[] | null;
}

/** The full schema model for a session — a flat list of all table schemas. */
export type SchemaModel = TableSchema[];

// ─── TOC metadata extraction ──────────────────────────────────────────────────

/**
 * Parse the raw TOC table attributes (from the already-parsed Toc structure)
 * into a richer TableTocMeta. The TocTable.attributes map uses the raw XML
 * attribute names with hyphens preserved.
 */
export function parseTocMeta(table: TocTable): TableTocMeta {
  const a = table.attributes;

  // Pull known attributes first, then collect the rest into extra.
  const known = new Set([
    "schema", "documentation", "callstack", "sample-rate-micro-seconds",
    "swift-table", "subsystem", "category", "codes", "target",
    "target-pid", "frequency", "all-thread-states",
    "needs-kernel-callstack", "record-waiting-threads",
    "context-switch-sampling", "high-frequency-sampling",
  ]);

  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(a)) {
    if (!known.has(k)) extra[k] = v;
  }

  return {
    schema: a["schema"] ?? "",
    documentation: a["documentation"] ?? null,
    callstack: a["callstack"] ?? null,
    sampleRateMicros: a["sample-rate-micro-seconds"] != null
      ? Number(a["sample-rate-micro-seconds"])
      : null,
    swiftTable: a["swift-table"] ?? null,
    subsystem: a["subsystem"] ?? null,
    category: a["category"] ?? null,
    codes: a["codes"] ?? null,
    target: a["target"] ?? a["target-pid"] ?? null,
    extra,
  };
}

/**
 * Synthetic schema name for a track-detail entry.
 * Format: "TrackName/DetailName" — the "/" never appears in real schema names.
 */
export function trackDetailSchemaName(trackName: string, detailName: string): string {
  return `${trackName}/${detailName}`;
}

/**
 * Build the initial SchemaModel from the TOC — columns are null until fetched.
 * Covers both /data/table (schema-tables) and /tracks/track/details/detail
 * (track-details). Duplicate (run, trackName, detailName) entries are
 * de-duplicated — first occurrence wins.
 * Called once per session during openTrace.
 */
export function buildSchemaModel(runs: TocRun[]): SchemaModel {
  const result: TableSchema[] = [];
  const seenTrackDetails = new Set<string>();

  for (const run of runs) {
    // Schema-tables from /data/table.
    for (const table of run.tables) {
      result.push({
        run: run.number,
        source: "schema-table",
        toc: parseTocMeta(table),
        trackDetail: null,
        cols: null,
      });
    }

    // Track-details from /tracks/track/details/detail.
    for (const track of run.tracks) {
      for (const detail of track.details) {
        const schemaName = trackDetailSchemaName(track.name, detail.name);
        const dedupKey = `${run.number}:${schemaName}`;
        if (seenTrackDetails.has(dedupKey)) continue;
        seenTrackDetails.add(dedupKey);

        result.push({
          run: run.number,
          source: "track-detail",
          toc: {
            schema: schemaName,
            documentation: null,
            callstack: null,
            sampleRateMicros: null,
            swiftTable: null,
            subsystem: null,
            category: null,
            codes: null,
            target: null,
            extra: {},
          },
          trackDetail: {
            trackName: track.name,
            detailName: detail.name,
            detailKind: detail.kind,
          },
          cols: null,
        });
      }
    }
  }

  return result;
}

/**
 * Update a SchemaModel entry with column definitions once a table has been
 * fetched. Called by the session layer after getTable() succeeds.
 */
export function updateSchemaCols(
  model: SchemaModel,
  run: number,
  schema: string,
  cols: SchemaCol[]
): void {
  const entry = model.find(
    (e) => e.run === run && e.toc.schema === schema && e.cols === null
  );
  if (entry) entry.cols = cols;
}

// ─── Query helpers ────────────────────────────────────────────────────────────

/** Return all TableSchema entries for a given schema name (across all runs). */
export function findBySchema(model: SchemaModel, schema: string): TableSchema[] {
  return model.filter((e) => e.toc.schema === schema);
}

/** Return the TableSchema for a specific run + schema. */
export function findOne(
  model: SchemaModel,
  run: number,
  schema: string
): TableSchema | undefined {
  return model.find((e) => e.run === run && e.toc.schema === schema);
}

/**
 * Return every schema-table TOC entry (not track-details) for a given run +
 * schema, in TOC order — positions 1..N map directly to the xctrace positional
 * xpath `table[@schema="..."][N]`. A schema with more than one entry here is
 * ambiguous: an unqualified xctrace export silently concatenates ALL of them
 * into one table rather than picking one, so callers must disambiguate.
 */
export function findSchemaTableEntries(
  model: SchemaModel,
  run: number,
  schema: string
): TableSchema[] {
  return model.filter(
    (e) => e.run === run && e.toc.schema === schema && e.source === "schema-table"
  );
}

/**
 * Throw a structured "ambiguous-schema" error when a run+schema has more than
 * one TOC instance. Callers invoke this only when they don't already have a
 * `position` — it's the fail-fast guard against the union-merge xctrace
 * silently performs on an unqualified xpath for a duplicated schema name.
 */
export function assertUnambiguousSchema(
  model: SchemaModel,
  run: number,
  schema: string
): void {
  const entries = findSchemaTableEntries(model, run, schema);
  if (entries.length <= 1) return;

  throw new XctraceError(
    "ambiguous-schema",
    `Schema "${schema}" appears ${entries.length} times in run ${run} — an unqualified ` +
      `fetch would silently merge all instances. Pass position (1-${entries.length}) to pick one.`,
    {
      instances: entries.map((e, i) => ({
        position: i + 1,
        documentation: e.toc.documentation,
        swiftTable: e.toc.swiftTable,
        subsystem: e.toc.subsystem,
        category: e.toc.category,
        codes: e.toc.codes,
      })),
    }
  );
}
