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
import { getTable, lastRun as sessionLastRun } from "../engine/session.js";
import { classifyWithHints } from "../engine/roleHints.js";
import { firstWithRole } from "../engine/roleInference.js";
import { matchesFilter, matchesTimeRange } from "./tableFilter.js";
import type { WeightUnit } from "../engine/roleInference.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AggOp = "sum" | "count" | "avg";

export interface AggregateOptions {
  run?: number;
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
}

// ─── Value formatting ─────────────────────────────────────────────────────────

function formatValue(value: number, unit: WeightUnit | undefined, op: AggOp): string {
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
  } = opts;

  const run = opts.run ?? sessionLastRun(sessionId);
  const table = await getTable(sessionId, run, schema);

  // Resolve unit for the measure column.
  const classified = classifyWithHints(schema, table.cols);
  const measureClassified = measure
    ? classified.find((c) => c.mnemonic === measure)
    : undefined;
  const unit = measureClassified?.roleInfo.unit;

  // Find time column for timeRange filtering.
  const timeColDef = firstWithRole(classified, "time");
  const timeColumn = timeColDef?.mnemonic ?? null;

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

  return {
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
  };
}
