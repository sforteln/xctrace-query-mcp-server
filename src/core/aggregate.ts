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
 */
import { getTable, getSchemaMeta, getProjectedTable, lastRun as sessionLastRun } from "../engine/session.js";
import { classifyWithHints, hintFor } from "../engine/roleHints.js";
import { firstWithRole } from "../engine/roleInference.js";
import { matchesFilter, matchesTimeRange } from "./tableFilter.js";
import { callCacheKey, getCachedCall, setCachedCall } from "./callCache.js";
import type { WeightUnit } from "../engine/roleInference.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AggOp = "sum" | "count" | "avg";

export interface AggregateOptions {
  run?: number;
  /**
   * 1-based instance index — only needed when the schema appears multiple
   * times in this run's TOC. Omitting it on an ambiguous schema throws a
   * structured "ambiguous-schema" error listing the available instances.
   */
  position?: number;
  /** Mnemonic of the label/thread column to group by. */
  groupBy: string;
  /** Mnemonic of the weight column to aggregate. Required for sum/avg; ignored for count. */
  measure?: string;
  /** Aggregation operation (default "sum"). */
  op?: AggOp;
  /** Max groups to return (default 10). */
  topN?: number;
  /** Optional equality pre-filter applied before grouping. */
  filter?: Record<string, string | number>;
  /** Optional time window applied before grouping. */
  timeRange?: { startNs?: number; endNs?: number };
}

export interface AggregateGroup {
  /** The groupBy column's fmt value for this group. */
  key: string;
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
  groupBy: string;
  measure: string | null;
  op: AggOp;
  topN: number;
  /** Total distinct groups found (before topN cap). */
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
  } = opts;

  const run = opts.run ?? sessionLastRun(sessionId);

  // An exact repeat of this call returns instantly — see callCache.ts's
  // header comment for why this matters beyond simple speedup.
  const cacheKey = callCacheKey("aggregate", run, schema, { position, groupBy, measure, op, topN, filter, timeRange });
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

  // Project down to only groupBy/measure/filter/time columns and narrow to
  // timeRange DURING the parse — unlike query.ts/find.ts, aggregate never
  // exposes a per-row tableIndex a caller could use to re-fetch from the
  // full table, so there's no index-alignment contract to protect here.
  const wanted = new Set<string>([
    groupBy,
    ...(measure ? [measure] : []),
    ...Object.keys(filter ?? {}),
    ...(timeColumn ? [timeColumn] : []),
  ]);
  const table =
    position === undefined
      ? await getProjectedTable(sessionId, run, schema, wanted, timeColumn ?? undefined, timeRange)
      : await getTable(sessionId, run, schema, position);

  // --- Pre-filter ---
  let rows = table.rows;
  if (filter && Object.keys(filter).length > 0) {
    rows = rows.filter((row) => matchesFilter(row, filter));
  }
  if (timeRange && timeColumn) {
    rows = rows.filter((row) => matchesTimeRange(row, timeColumn, timeRange));
  }
  const totalRows = rows.length;

  // --- Group and aggregate ---
  const groups = new Map<string, { sum: number; count: number }>();

  for (const row of rows) {
    const groupCell = row[groupBy];
    // Skip rows where the groupBy key is null/sentinel.
    if (groupCell === null || groupCell === undefined) continue;
    const key = groupCell.fmt;

    let measureValue = 0;
    if (op !== "count" && measure) {
      const mCell = row[measure];
      if (mCell === null || mCell === undefined) continue;
      const raw = typeof mCell.raw === "number" ? mCell.raw : Number(mCell.raw);
      if (!isFinite(raw)) continue;
      measureValue = raw;
    }

    const existing = groups.get(key) ?? { sum: 0, count: 0 };
    groups.set(key, { sum: existing.sum + measureValue, count: existing.count + 1 });
  }

  const totalGroups = groups.size;

  // Compute final value per group and sort descending.
  const sorted = Array.from(groups.entries())
    .map(([key, { sum, count }]) => {
      let value: number;
      switch (op) {
        case "sum":   value = sum; break;
        case "count": value = count; break;
        case "avg":   value = count > 0 ? sum / count : 0; break;
      }
      return { key, value, rowCount: count };
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, topN);

  const resultGroups: AggregateGroup[] = sorted.map(({ key, value, rowCount }) => ({
    key,
    value,
    valueFmt: formatValue(value, unit, op),
    rowCount,
  }));

  const notes: string[] = [];

  // A blank top group means groupBy chose the wrong column for at least some
  // row types — the result LOOKS like a real answer, which is exactly the
  // trap. See the note on AggregateResult.note for why this is generic, not
  // schema-hardcoded.
  const topGroup = resultGroups[0];
  if (topGroup && topGroup.key === "") {
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
      `The top group by "${groupBy}" is empty (${topGroup.rowCount}/${totalRows} rows, ${pct}%) — ` +
      `"${groupBy}" may not carry identity for every row type in this schema.${schemaNote}`
    );
  }

  // Known-overlapping groupBy column (e.g. hitches-renders' frame-color) —
  // only worth warning about when the caller is actually summing/averaging
  // a measure across it, since count-by-group is safe regardless.
  if ((op === "sum" || op === "avg") && NON_PARTITIONING_GROUPBY[schema]?.[groupBy]) {
    notes.push(NON_PARTITIONING_GROUPBY[schema][groupBy]);
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
