/**
 * timeline — time-ordered, origin-tagged merge of N schemas.
 *
 * relate()/correlate() are CONFIRMATORY: they answer "does A contain/precede
 * B?" and need a hypothesis first. timeline() is the EXPLORATORY counterpart:
 * "what actually happened, in order, across subsystems?" — the narrative
 * reconstruction you do BEFORE you have a hypothesis. It merges rows from
 * multiple schemas into one time-ordered stream, each row tagged with its
 * origin schema, so an interleaving like "00:03.065 enqueue ↔ 00:03.067 body"
 * falls straight out of one call instead of being reconstructed by hand from
 * separate query results (scratchpad 028's still-pine⇄slow-spruce case).
 *
 * A SQL UNION ALL of one bounded per-schema SELECT each, projecting a common
 * {origin, time, dur, label, rowId} shape — NOT every column (that's getRow's
 * job; this stays compact by design, progressive disclosure). Interval vs
 * point event: sorted by start time, carrying dur so intervals are
 * distinguishable from instants (simpler than emitting synthetic begin/end
 * rows, and enough for "what was happening when").
 *
 * COST-TIER LENS, not a free core verb (see howLensesWork.md's core-vs-lens
 * cost rule): a
 * merge over full untrimmed tables is the OOM/latency cliff again, so a
 * bounded timeRange is REQUIRED — each per-schema branch is then an indexed
 * range scan (dusk-floe's per-schema time-column index), not a table scan.
 * The WHERE predicate uses the BARE raw time column (buildTimeRangeFilter,
 * no CAST) so SQLite can actually use that index for a range SEEK — the same
 * 039.C caution relate.ts's coreMatch comment documents (CAST(t AS REAL) in a
 * WHERE clause defeats index use and degrades to a SCAN).
 */
import { getTable, getSchemaMeta, getDb, lastRun as sessionLastRun } from "../engine/session.js";
import { classifyWithHints, hintFor } from "../engine/roleHints.js";
import { firstWithRole } from "../engine/roleInference.js";
import { primaryTime, preferredDurationColumn } from "./relate.js";
import { callCacheKey, getCachedCall, setCachedCall } from "./callCache.js";
import { buildTimeRangeFilter, rawCol, fmtCol } from "../engine/sqlHydrate.js";
import { quoteIdent, ROW_IDX_COLUMN } from "../engine/sqliteStore.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TimelineOptions {
  run?: number;
  /**
   * Required — timeline is a cost-tier lens, not a free core verb (see this
   * file's header). At least one of startNs/endNs must be set so every
   * per-schema branch is an indexed range SEEK, not a full-table SCAN.
   */
  timeRange: { startNs?: number; endNs?: number };
  /** Max merged rows to return, heaviest-bound first by time (default 100, max 1000). */
  limit?: number;
}

/** One merged row. `origin` + `rowId` together are the get_row(origin, rowId) drill-down handle. */
export interface TimelineEvent {
  /** The schema this row came from — pass as `schema` to get_row for full detail. */
  origin: string;
  /** This row's stable table index within `origin` — pass as `rowIndex` to get_row. */
  rowId: number;
  /** Raw start time (ns), the sort key. */
  time: number;
  /** Human-readable start time. */
  timeFmt: string;
  /** Raw duration (ns) if this schema has a nanoseconds-shaped weight column, else null (a point event). */
  dur: number | null;
  durFmt: string | null;
  /** Display value of this schema's primary label/thread column, if any. */
  label: string | null;
}

export interface TimelineResult {
  run: number;
  schemas: string[];
  timeRange: { startNs?: number; endNs?: number };
  /** Which time column each schema was ordered by — surfaced for sanity-checking, like relate's joinColumns. */
  timeColumns: Record<string, string>;
  /** Total rows across all schemas matching timeRange, before limit. */
  totalInWindow: number;
  returnedRows: number;
  limit: number;
  hasMore: boolean;
  events: TimelineEvent[];
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function timeline(
  sessionId: string,
  schemas: string[],
  opts: TimelineOptions
): Promise<TimelineResult> {
  const { timeRange } = opts;
  if (!timeRange || (timeRange.startNs === undefined && timeRange.endNs === undefined)) {
    throw new Error(
      "timeline requires a bounded timeRange (startNs and/or endNs) — merging full, untrimmed tables across " +
      "multiple schemas is the same OOM/latency cliff relate()'s indexed-range caution exists for. Pick a " +
      "window (e.g. around a signpost or event of interest) and retry."
    );
  }
  if (schemas.length === 0) {
    throw new Error("timeline requires at least one schema.");
  }

  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const run = opts.run ?? sessionLastRun(sessionId);

  const sortedSchemas = [...schemas].sort();
  const cacheKey = callCacheKey("timeline", run, sortedSchemas.join(","), { timeRange, limit });
  const cached = getCachedCall<TimelineResult>(sessionId, cacheKey);
  if (cached) return cached;

  // Resolve each schema's time/duration/label columns via the same
  // classifyWithHints/roleHints machinery relate/correlate use, and ensure
  // ingestion (+ role indexes) happened — in parallel, like relate.ts.
  const resolved = await Promise.all(
    schemas.map(async (schema) => {
      const meta = await getSchemaMeta(sessionId, run, schema);
      const classified = classifyWithHints(schema, meta.cols);
      const timeCol = primaryTime(schema, classified);
      if (!timeCol) {
        throw new Error(`timeline: schema "${schema}" has no time column to order by.`);
      }
      const durCol = preferredDurationColumn(classified, hintFor(schema)?.primaryWeight);
      const labelCol = firstWithRole(classified, "label")?.mnemonic ?? firstWithRole(classified, "thread")?.mnemonic ?? null;
      const handle = await getTable(sessionId, run, schema);
      return { schema, timeCol, durCol, labelCol, tableName: handle.tableName };
    })
  );

  const db = await getDb(sessionId);

  // One bounded, indexed-range-scan branch per schema, projecting the common
  // {origin, time, dur, label, rowId} shape. WHERE uses the bare raw time
  // column (buildTimeRangeFilter, no CAST) so the per-schema time index is
  // usable — the 039.C index-seek caution. The origin literal is bound as a
  // parameter (`? AS origin`), not inlined as a quoted string — SQLite treats
  // a double-quoted literal as an IDENTIFIER by default (a real footgun for a
  // schema name inlined via JSON.stringify), so binding sidesteps that entirely.
  const branches: string[] = [];
  const params: Array<string | number> = [];
  for (const r of resolved) {
    const table = quoteIdent(r.tableName);
    const timeSelect = `${quoteIdent(rawCol(r.timeCol))} AS time`;
    const timeFmtSelect = `${quoteIdent(fmtCol(r.timeCol))} AS timeFmt`;
    const durSelect = r.durCol ? `${quoteIdent(rawCol(r.durCol))} AS dur` : "NULL AS dur";
    const durFmtSelect = r.durCol ? `${quoteIdent(fmtCol(r.durCol))} AS durFmt` : "NULL AS durFmt";
    const labelSelect = r.labelCol ? `${quoteIdent(fmtCol(r.labelCol))} AS label` : "NULL AS label";
    const where = buildTimeRangeFilter(r.timeCol, timeRange);
    branches.push(
      `SELECT ? AS origin, ${timeSelect}, ${timeFmtSelect}, ${durSelect}, ${durFmtSelect}, ` +
        `${labelSelect}, ${quoteIdent(ROW_IDX_COLUMN)} AS rowId FROM ${table} WHERE ${where.clause}`
    );
    params.push(r.schema, ...where.params);
  }

  const mergedSql = `SELECT * FROM (${branches.join(" UNION ALL ")}) ORDER BY time ASC LIMIT ?`;
  const eventRows = db.prepare(mergedSql).all(...params, limit) as Array<{
    origin: string; time: number; timeFmt: string; dur: number | null; durFmt: string | null; label: string | null; rowId: number;
  }>;

  // Total count in window across all schemas (before limit) — cheap, each
  // COUNT(*) hits the same time index the branch SELECT does.
  let totalInWindow = 0;
  for (const r of resolved) {
    const where = buildTimeRangeFilter(r.timeCol, timeRange);
    const countRow = db
      .prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(r.tableName)} WHERE ${where.clause}`)
      .get(...where.params) as { n: number };
    totalInWindow += countRow.n;
  }

  const events: TimelineEvent[] = eventRows.map((r) => ({
    origin: r.origin,
    rowId: r.rowId,
    time: r.time,
    timeFmt: r.timeFmt,
    dur: r.dur,
    durFmt: r.durFmt,
    label: r.label,
  }));

  const result: TimelineResult = {
    run,
    schemas,
    timeRange,
    timeColumns: Object.fromEntries(resolved.map((r) => [r.schema, r.timeCol])),
    totalInWindow,
    returnedRows: events.length,
    limit,
    hasMore: events.length < totalInWindow,
    events,
  };

  setCachedCall(sessionId, cacheKey, result);
  return result;
}
