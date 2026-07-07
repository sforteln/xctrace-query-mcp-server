/**
 * PMT:flint-larch corpus detector #4 — allocations growth (high-water mark).
 *
 * Computes the running (cumulative) SUM(size) over time on the Allocations
 * list, ordered by timestamp, and fires on the PEAK of that cumulative curve
 * crossing a byte band. The window buys something a plain SUM can't: the
 * high-water mark. A plain SUM(size) only gives the FINAL net total — if a
 * trace's Allocations List ever contains both grows and shrinks (frees
 * represented as later rows), the running total can dip after a peak, and the
 * peak (worst in-flight memory pressure) can exceed the final resting value.
 * Reporting only the final sum would silently understate how bad it got.
 *
 * cost: EXPENSIVE — a running-total SQL window function over the whole table
 * (sqlHydrate.ts's buildWindowExpr, PMT:round-rime) — the core-vs-lens cost
 * rule places any window function outside "cheap" (aidocs/howLensesWork.md).
 */
import { quoteIdent, ROW_IDX_COLUMN } from "../engine/sqliteStore.js";
import { fmtCol, rawCol, buildWindowExpr } from "../engine/sqlHydrate.js";
import type { Detector } from "./types.js";

const ALLOCATIONS_LIST_SCHEMA = "Allocations/Allocations List";
const PEAK_BYTES_THRESHOLD = 50_000_000; // 50MB high-water mark

export const allocationsGrowth: Detector = {
  id: "allocations-growth",
  title: "Allocations growth (cumulative high-water mark)",
  requiredSchemas: [ALLOCATIONS_LIST_SCHEMA],
  cost: "expensive",
  run(ctx) {
    const table = quoteIdent(ctx.tableName(ALLOCATIONS_LIST_SCHEMA));
    const tsRaw = quoteIdent(rawCol("timestamp"));
    const sizeFmt = quoteIdent(fmtCol("size"));
    const runningTotalExpr = buildWindowExpr({ op: "running-total", orderBy: "timestamp", measure: "size" });

    const row = ctx.db
      .prepare(
        `WITH cum AS (SELECT ${runningTotalExpr} AS total FROM ${table} WHERE ${sizeFmt} IS NOT NULL) ` +
          `SELECT MAX(total) AS peak FROM cum`
      )
      .get() as { peak: number | null } | undefined;
    if (!row || row.peak === null) return null;
    if (row.peak <= PEAK_BYTES_THRESHOLD) return null;

    const heaviest = ctx.db
      .prepare(
        `SELECT ${quoteIdent(ROW_IDX_COLUMN)} AS idx FROM ${table} WHERE ${sizeFmt} IS NOT NULL ` +
          `ORDER BY CAST(${quoteIdent("size")} AS REAL) DESC LIMIT 1`
      )
      .get() as { idx: number } | undefined;
    const range = ctx.db
      .prepare(`SELECT MIN(CAST(${tsRaw} AS REAL)) AS minT, MAX(CAST(${tsRaw} AS REAL)) AS maxT FROM ${table}`)
      .get() as { minT: number; maxT: number } | undefined;

    const peakMb = row.peak / 1e6;
    return {
      summary: `Allocations climbed to a ${peakMb.toFixed(1)}MB high-water mark over the trace — sustained growth, not a transient spike`,
      firing: [{ metric: "peak cumulative bytes", value: Math.round(row.peak), threshold: PEAK_BYTES_THRESHOLD, direction: "over" }],
      callSpec: {
        verb: "aggregate",
        schema: ALLOCATIONS_LIST_SCHEMA,
        args: { groupBy: "category", measure: "size", op: "sum", topN: 10 },
      },
      handles: [
        ...(heaviest ? [{ kind: "row" as const, schema: ALLOCATIONS_LIST_SCHEMA, rowIndex: heaviest.idx, label: "heaviest single allocation" }] : []),
        ...(range ? [{ kind: "window" as const, schema: ALLOCATIONS_LIST_SCHEMA, timeRange: { startNs: range.minT, endNs: range.maxT }, label: "allocation growth curve" }] : []),
      ],
    };
  },
};
