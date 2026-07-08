/**
 * aggregate — the "top N by weight" workhorse.
 *
 * Groups rows by any label/thread column and aggregates a weight column by
 * sum, count, or average. Returns the heaviest groups descending so the agent
 * can answer "hot functions", "largest allocations", "slowest intervals", or
 * "most samples per thread" with one call, on any instrument.
 *
 * The result value is formatted with the correct unit (ns/bytes/count/cycles)
 * derived from the measure column's inferred role, so the agent sees "1.23 s"
 * not "1234567890".
 *
 * PMT:dusk-floe: the WHERE+GROUP BY+aggregate computation runs as SQL against
 * PMT:gravel-cape's ingested table instead of a hand-rolled JS Map — but the
 * sort/topN slice and the blank-top-group/NON_PARTITIONING_GROUPBY note logic
 * stay identical JS, operating on SQL-computed group sums instead of ones
 * accumulated by hand. This keeps behavior byte-identical for the parts that
 * were never the memory/speed problem in the first place.
 */
import { getTable, getSchemaMeta, getDb, lastRun as sessionLastRun } from "../engine/session.js";
import { classifyWithHints, hintFor } from "../engine/roleHints.js";
import { firstWithRole } from "../engine/roleInference.js";
import { callCacheKey, getCachedCall, setCachedCall } from "./callCache.js";
import {
  buildEqualityFilter,
  buildTimeRangeFilter,
  combineConditions,
  fmtCol,
  rawCol,
  percentileFnFor,
  makeInternResolver,
  makeInternTargetResolver,
} from "../engine/sqlHydrate.js";
import { buildFieldResolver } from "../engine/fieldRef.js";
import { quoteIdent } from "../engine/sqliteStore.js";
import type { WeightUnit } from "../engine/roleInference.js";
import { emptyResultNote } from "./emptyResultNote.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * count → row count (no measure). sum/avg/min/max/median/p50/p90/p95/p99 →
 * aggregate the measure column. Percentile ops (median = p50 alias) use the
 * registered nearest-rank percentile UDFs (see sqlHydrate.ts); the rest map to
 * native SQL aggregates. Every non-count op REQUIRES a measure — asking for a
 * p95 or a max with no column to compute it over is a caller error, not a
 * silent zero (PMT:round-rime).
 */
export type AggOp =
  | "sum" | "count" | "avg" | "min" | "max"
  | "median" | "p50" | "p90" | "p95" | "p99";

/** Post-aggregation filter on each group's computed value / row count (SQL HAVING, done in JS over materialized groups). */
export interface HavingFilter {
  minValue?: number;
  maxValue?: number;
  minRowCount?: number;
  maxRowCount?: number;
}

export interface AggregateOptions {
  run?: number;
  /**
   * 1-based instance index — only needed when the schema appears multiple
   * times in this run's TOC. Omitting it on an ambiguous schema throws a
   * structured "ambiguous-schema" error listing the available instances.
   */
  position?: number;
  /**
   * Mnemonic(s) of the label/thread column(s) to group by. A single string
   * groups by one column (the common case); an array groups by a composite
   * key across several columns (e.g. ["view-name", "thread"] for "hot view
   * broken down by thread"). A row is excluded from grouping if ANY groupBy
   * column is null for it.
   */
  groupBy: string | string[];
  /** Mnemonic of the weight column to aggregate. Required for every op except count; ignored for count. */
  measure?: string;
  /** Aggregation operation (default "sum"). */
  op?: AggOp;
  /** Max groups to return (default 10). */
  topN?: number;
  /** Optional equality pre-filter applied before grouping. */
  filter?: Record<string, string | number>;
  /** Optional time window applied before grouping. */
  timeRange?: { startNs?: number; endNs?: number };
  /** Optional post-aggregation filter on each group's computed value / row count. */
  having?: HavingFilter;
}

export interface AggregateGroup {
  /** The group's display key — a single fmt value, or fmt values joined by " / " for a composite groupBy. */
  key: string;
  /** The individual fmt values of a composite groupBy, in groupBy order. Present only when groupBy is an array. */
  keyParts?: string[];
  /** Aggregated numeric value. */
  value: number;
  /** Human-readable formatted value with unit. */
  valueFmt: string;
  /** Number of rows in this group. */
  rowCount: number;
}

export interface AggregateResult {
  schema: string;
  run: number;
  groupBy: string | string[];
  measure: string | null;
  op: AggOp;
  topN: number;
  /** Total distinct groups found (after HAVING, before topN cap). */
  totalGroups: number;
  /** Total rows that passed the pre-filter. */
  totalRows: number;
  groups: AggregateGroup[];
  /** Unit of the measure column, absent for count op. */
  unit?: WeightUnit;
  /**
   * Set when the TOP group's key is an empty string — a schema where identity
   * is split across columns by row type (e.g. swiftui-updates: View Body rows
   * carry it in "description", Layout rows in "view-name") will silently
   * dump the wrong row type's rows into one blank bucket at the top, looking
   * like a real answer. Confirmed a recurring, generalizable trap (found
   * independently 3 times this project) — not schema-specific by nature, so
   * detected generically here rather than hardcoded per schema.
   */
  note?: string;
}

// ─── Value formatting ─────────────────────────────────────────────────────────

export function formatValue(value: number, unit: WeightUnit | undefined, op: AggOp): string {
  // Only count is unit-less (a row tally). Every other op — sum/avg/min/max
  // and the percentiles — yields a value in the measure column's own unit,
  // so all format identically by unit.
  if (op === "count") return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (!unit || unit === "unknown") return value.toFixed(2);

  switch (unit) {
    case "nanoseconds":
      if (value >= 1e9) return `${(value / 1e9).toFixed(2)} s`;
      if (value >= 1e6) return `${(value / 1e6).toFixed(2)} ms`;
      if (value >= 1e3) return `${(value / 1e3).toFixed(2)} µs`;
      return `${Math.round(value)} ns`;
    case "bytes":
      if (value >= 1073741824) return `${(value / 1073741824).toFixed(2)} GB`;
      if (value >= 1048576) return `${(value / 1048576).toFixed(2)} MB`;
      if (value >= 1024) return `${(value / 1024).toFixed(2)} KB`;
      return `${Math.round(value)} B`;
    case "cycles":
    case "count":
      return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
}

/**
 * groupBy columns known to be an OVERLAPPING label rather than a partition —
 * the same underlying row can appear under more than one group with an
 * identical measure value, so sum/avg across the whole result silently
 * double-counts. Verified live: hitches-renders' frame-color is a severity/
 * phase tint on a frame (keyed by swap-id), not a distinct-frame split — the
 * same swap-id/duration showed up under both "Blue" and "Red". Unlike the
 * blank-bucket check above, this can't be detected generically (it requires
 * knowing which OTHER column is the row's real identity key for a given
 * schema), so it's a small curated table — same tradeoff as WAIT_FRAME_NAMES
 * in callTree.ts, extend only after verifying live, not by guessing from a
 * column name that merely sounds similar.
 */
const NON_PARTITIONING_GROUPBY: Record<string, Record<string, string>> = {
  "hitches-renders": {
    "frame-color": "frame-color is a severity/phase tint on a frame (keyed by swap-id), not a " +
      "partition — the same swap-id can appear under multiple colors with identical duration. " +
      "Summing/averaging across frame-color double-counts; dedupe on swap-id first, or read per-row instead.",
  },
  "hitches-gpu": {
    "frame-color": "frame-color is a severity/phase tint on a frame (keyed by swap-id), not a " +
      "partition — the same swap-id can appear under multiple colors with identical duration. " +
      "Summing/averaging across frame-color double-counts; dedupe on swap-id first, or read per-row instead.",
  },
  "hitches-frame-lifetimes": {
    "frame-color": "frame-color is a severity/phase tint on a frame (keyed by swap-id), not a " +
      "partition — the same swap-id can appear under multiple colors with identical duration. " +
      "Summing/averaging across frame-color double-counts; dedupe on swap-id first, or read per-row instead.",
  },
  "hitches-updates": {
    "frame-color": "frame-color is a severity/phase tint on a frame (keyed by swap-id), not a " +
      "partition — the same swap-id can appear under multiple colors with identical duration. " +
      "Summing/averaging across frame-color double-counts; dedupe on swap-id first, or read per-row instead.",
  },
};

// ─── Public API ───────────────────────────────────────────────────────────────

export async function aggregateTable(
  sessionId: string,
  schema: string,
  opts: AggregateOptions
): Promise<AggregateResult> {
  const {
    groupBy,
    measure,
    op = "sum",
    topN = 10,
    filter,
    timeRange,
    position,
    having,
  } = opts;

  // Normalize groupBy to an array internally; a single string stays
  // single-element (and is echoed back as a string in the result for
  // backward compatibility).
  const groupByCols = Array.isArray(groupBy) ? groupBy : [groupBy];
  if (groupByCols.length === 0) {
    throw new Error("aggregate requires at least one groupBy column.");
  }

  // Every op except count aggregates the measure column — asking for a p95/
  // max/sum with no column to compute it over is a caller error, not a
  // silent zero (the pre-SQL implementation silently summed 0 in this case).
  if (op !== "count" && !measure) {
    throw new Error(`aggregate op "${op}" requires a measure column (only "count" works without one).`);
  }

  const run = opts.run ?? sessionLastRun(sessionId);

  // An exact repeat of this call returns instantly — see callCache.ts's
  // header comment for why this matters beyond simple speedup.
  const cacheKey = callCacheKey("aggregate", run, schema, { position, groupBy, measure, op, topN, filter, timeRange, having });
  const cached = getCachedCall<AggregateResult>(sessionId, cacheKey);
  if (cached) return cached;

  // Column shape only, no row data yet — enough to classify and pick which
  // mnemonics are actually needed (see correlate.ts's matching comment).
  const meta = await getSchemaMeta(sessionId, run, schema, position);

  // Resolve unit for the measure column.
  const classified = classifyWithHints(schema, meta.cols);
  const measureClassified = measure
    ? classified.find((c) => c.mnemonic === measure)
    : undefined;
  const unit = measureClassified?.roleInfo.unit;

  // Find time column for timeRange filtering. Pinned primaryTime wins — see
  // the matching comment in find.ts for why firstWithRole alone isn't safe
  // when a schema has 2+ time-role columns.
  const timeColumn = hintFor(schema)?.primaryTime ?? firstWithRole(classified, "time")?.mnemonic ?? null;

  // Ensures ingestion happened (a no-op if already cached this session).
  const handle = await getTable(sessionId, run, schema, position);
  const db = await getDb(sessionId);
  const table = quoteIdent(handle.tableName);

  // Dot-path field resolution (PMT:bare-shoal), built after getTable so the
  // promoted-column metadata exists. groupBy/measure/filter keys may be nested
  // dot-paths (thread.process.pid); resolveComparable also rejects backtrace
  // columns with a clear error (was assertNotBacktraceMnemonic).
  const resolver = buildFieldResolver(db, handle.tableName, meta.cols);
  const groupByBases = groupByCols.map((gb) => resolver.resolveComparable(gb, "group by").base);
  const measureBase = measure ? resolver.resolveComparable(measure, "aggregate (measure)").base : undefined;

  // --- Pre-filter (matches "rows that passed the pre-filter", including
  // rows with a null groupBy key — those are excluded from GROUPING below,
  // but still count toward totalRows/the blank-top-group percentage). ---
  const resolvedFilter: Record<string, string | number> = {};
  for (const [ref, val] of Object.entries(filter ?? {})) {
    resolvedFilter[resolver.resolveComparable(ref, "filter on").base] = val;
  }
  const preFilterConditions = [];
  if (Object.keys(resolvedFilter).length > 0) preFilterConditions.push(buildEqualityFilter(resolvedFilter, makeInternTargetResolver(db)));
  if (timeRange && timeColumn) preFilterConditions.push(buildTimeRangeFilter(timeColumn, timeRange));
  const preFilterWhere = combineConditions(preFilterConditions);

  const totalRows = (
    db.prepare(`SELECT COUNT(*) as n FROM ${table} WHERE ${preFilterWhere.clause}`).get(...preFilterWhere.params) as {
      n: number;
    }
  ).n;

  // --- Group + aggregate (SQL does the scan + the aggregate math; JS keeps
  // the HAVING filter, sort/topN, and notes logic over the materialized
  // groups — bounded by distinct-group count, not table size). Rows with a
  // null value in ANY groupBy column are excluded from grouping (matching the
  // original single-column "continue" on a null groupCell, generalized to a
  // composite key) — plain SQL GROUP BY would otherwise bucket every NULL as
  // its own group. Rows with a null MEASURE are also excluded for every op
  // that takes a measure — matching the original's continue conditions. ---
  const isCount = op === "count";
  const measureExpr = isCount ? "" : `CAST(${quoteIdent(rawCol(measureBase!))} AS REAL)`;

  // The SQL aggregate expression for this op. count → COUNT(*); native
  // sum/avg/min/max; percentiles → the registered UDFs (see sqlHydrate.ts).
  let aggExpr: string;
  const pctlFn = percentileFnFor(op);
  if (isCount) aggExpr = "COUNT(*)";
  else if (pctlFn) aggExpr = `${pctlFn}(${measureExpr})`;
  else if (op === "sum") aggExpr = `SUM(${measureExpr})`;
  else if (op === "avg") aggExpr = `AVG(${measureExpr})`;
  else if (op === "min") aggExpr = `MIN(${measureExpr})`;
  else if (op === "max") aggExpr = `MAX(${measureExpr})`;
  else throw new Error(`Unknown aggregate op "${op}".`);

  const groupConditions = [...preFilterConditions];
  for (const gbBase of groupByBases) {
    groupConditions.push({ clause: `${quoteIdent(fmtCol(gbBase))} IS NOT NULL`, params: [] });
  }
  if (!isCount) {
    groupConditions.push({ clause: `${quoteIdent(fmtCol(measureBase!))} IS NOT NULL`, params: [] });
  }
  const groupWhere = combineConditions(groupConditions);

  // Select each groupBy column's fmt as key0, key1, … so a composite key's
  // parts stay distinct (no delimiter-collision from pre-joining in SQL).
  const keySelects = groupByBases.map((gbBase, i) => `${quoteIdent(fmtCol(gbBase))} as key${i}`);
  const groupByClause = groupByBases.map((gbBase) => quoteIdent(fmtCol(gbBase))).join(", ");

  const rawGroups = db
    .prepare(
      `SELECT ${keySelects.join(", ")}, ${aggExpr} as aggVal, COUNT(*) as cnt ` +
        `FROM ${table} WHERE ${groupWhere.clause} GROUP BY ${groupByClause}`
    )
    .all(...groupWhere.params) as Record<string, unknown>[];

  // Materialize each group's composite key parts + value + rowCount. A group
  // key can be an interned sentinel if the groupBy column holds large values
  // (grouping by the sentinel is a correct partition — same content, same
  // sentinel — so only the DISPLAY key needs resolving here). PMT:lime-bluff.
  const unintern = makeInternResolver(db);
  const isMulti = groupByCols.length > 1;
  let groups = rawGroups.map((r) => {
    const keyParts = groupByCols.map((_, i) => String(unintern(r[`key${i}`]) ?? ""));
    return {
      key: keyParts.join(" / "),
      keyParts,
      value: Number(r.aggVal ?? 0),
      rowCount: Number(r.cnt),
    };
  });

  // HAVING — filter on the computed value / row count (done in JS over the
  // already-materialized groups; the expensive row scan stayed in SQL).
  if (having) {
    groups = groups.filter((g) => {
      if (having.minValue !== undefined && g.value < having.minValue) return false;
      if (having.maxValue !== undefined && g.value > having.maxValue) return false;
      if (having.minRowCount !== undefined && g.rowCount < having.minRowCount) return false;
      if (having.maxRowCount !== undefined && g.rowCount > having.maxRowCount) return false;
      return true;
    });
  }

  const totalGroups = groups.length;

  const sorted = groups.sort((a, b) => b.value - a.value).slice(0, topN);

  const resultGroups: AggregateGroup[] = sorted.map(({ key, keyParts, value, rowCount }) => ({
    key,
    ...(isMulti ? { keyParts } : {}),
    value,
    valueFmt: formatValue(value, unit, op),
    rowCount,
  }));

  const notes: string[] = [];

  // PMT:thorny-verge: an empty `groups` array is ambiguous on its own — did
  // the filter/timeRange exclude everything, or did every row that DID match
  // have a null groupBy/measure value (excluded from GROUP BY, not from the
  // filter)? Distinguish both from "this schema genuinely has 0 rows".
  if (totalGroups === 0) {
    if (totalRows === 0) {
      const filterApplied = Boolean((filter && Object.keys(filter).length > 0) || timeRange);
      const zeroRowsNote = emptyResultNote({ matchedCount: totalRows, unfilteredCount: meta.rowCount, filterApplied });
      if (zeroRowsNote) notes.push(zeroRowsNote);
    } else {
      notes.push(
        `${totalRows.toLocaleString("en-US")} row(s) matched your filter/timeRange, but every one had a null ` +
        `"${groupByCols.join(", ")}" and/or "${measure ?? ""}" value — excluded from grouping, not from the filter. ` +
        "Check describe_schema's role classification for a column that's actually populated for these rows."
      );
    }
  }

  // A blank top group means groupBy chose the wrong column for at least some
  // row types — the result LOOKS like a real answer, which is exactly the
  // trap. See the note on AggregateResult.note for why this is generic, not
  // schema-hardcoded. Only meaningful for a SINGLE groupBy column — a blank
  // composite-key part is a different, less clear-cut situation, so this
  // check stays scoped to the single-column case it was designed for.
  const singleGroupBy = groupByCols.length === 1 ? groupByCols[0] : null;
  const topGroup = resultGroups[0];
  if (singleGroupBy && topGroup && topGroup.key === "") {
    const pct = totalRows > 0 ? Math.round((topGroup.rowCount / totalRows) * 1000) / 10 : 0;
    const schemaNote =
      schema === "swiftui-updates" || schema === "SwiftUIFilteredUpdates"
        ? " For this schema specifically: View Body Update rows carry their identity in " +
          "\"description\" (view-name is empty for them); Layout Update rows carry it in " +
          "\"view-name\" instead (description is that row's sub-operation, not a view). Try " +
          "groupBy: \"description\" for view-body rows."
        : " Check describe_schema's role classification, or try a different groupBy column — " +
          "this schema may split identity across more than one column depending on row type.";
    notes.push(
      `The top group by "${singleGroupBy}" is empty (${topGroup.rowCount}/${totalRows} rows, ${pct}%) — ` +
      `"${singleGroupBy}" may not carry identity for every row type in this schema.${schemaNote}`
    );
  }

  // Known-overlapping groupBy column (e.g. hitches-renders' frame-color) —
  // only worth warning about when the caller is actually summing/averaging
  // a measure across it, since count-by-group (and min/max/percentiles, which
  // pick an existing value rather than combine across rows) are safe
  // regardless. Scoped to single-column groupBy — the curated table is keyed
  // by one mnemonic.
  if (singleGroupBy && (op === "sum" || op === "avg") && NON_PARTITIONING_GROUPBY[schema]?.[singleGroupBy]) {
    notes.push(NON_PARTITIONING_GROUPBY[schema][singleGroupBy]);
  }

  const note = notes.length > 0 ? notes.join(" ") : undefined;

  const result: AggregateResult = {
    schema,
    run,
    groupBy,
    measure: measure ?? null,
    op,
    topN,
    totalGroups,
    totalRows,
    groups: resultGroups,
    ...(op !== "count" && unit ? { unit } : {}),
    ...(note ? { note } : {}),
  };

  setCachedCall(sessionId, cacheKey, result);
  return result;
}
