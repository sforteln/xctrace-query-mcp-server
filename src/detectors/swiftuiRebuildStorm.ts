/**
 * Corpus detector #3 — SwiftUI rebuild storm (temporal
 * clustering).
 *
 * Distinct from swiftuiOverInvalidation (#1, which flags a view with a large
 * TOTAL re-evaluation count/duration spread across the whole trace): this
 * detector looks for a view whose re-evaluations arrive in a dense BURST —
 * many inter-arrival gaps under a millisecond, in the same partition — the
 * signature of a synchronous invalidation cascade (a state write triggering
 * itself, or a tight observation loop), which a total-count threshold alone
 * can miss if the same total is spread evenly across a long trace.
 *
 * cost: EXPENSIVE — computes a LAG() inter-arrival gap via a SQL window
 * function partitioned by view description (sqlHydrate.ts's buildWindowExpr),
 * which the core-vs-lens cost rule places outside "cheap"
 * regardless of any LIMIT on the output (aidocs/howLensesWork.md).
 */
import { quoteIdent, ROW_IDX_COLUMN } from "../engine/sqliteStore.js";
import { fmtCol, rawCol, makeInternResolver, buildWindowExpr } from "../engine/sqlHydrate.js";
import type { Detector } from "./types.js";

const DENSE_GAP_NS = 1_000_000; // 1ms — sub-frame-budget inter-arrival
const DENSE_CLUSTER_THRESHOLD = 50; // dense (sub-1ms) gaps in one description's cluster

export const swiftuiRebuildStorm: Detector = {
  id: "swiftui-rebuild-storm",
  title: "SwiftUI rebuild storm (dense re-invalidation burst)",
  requiredSchemas: ["swiftui-updates"],
  cost: "expensive",
  run(ctx) {
    const table = quoteIdent(ctx.tableName("swiftui-updates"));
    const descFmt = quoteIdent(fmtCol("description"));
    const startRaw = quoteIdent(rawCol("start"));
    const gapExpr = buildWindowExpr({ op: "delta", orderBy: "start", partitionBy: "description" });

    const top = ctx.db
      .prepare(
        `WITH gaps AS (SELECT ${descFmt} AS k, ${gapExpr} AS gap FROM ${table} WHERE ${descFmt} IS NOT NULL) ` +
          `SELECT k, COUNT(*) AS denseCount FROM gaps WHERE gap IS NOT NULL AND gap > 0 AND gap < ? ` +
          `GROUP BY k ORDER BY denseCount DESC LIMIT 1`
      )
      .get(DENSE_GAP_NS) as { k: string; denseCount: number } | undefined;
    if (!top || top.denseCount <= DENSE_CLUSTER_THRESHOLD) return null;

    const key = String(makeInternResolver(ctx.db)(top.k) ?? top.k);

    const range = ctx.db
      .prepare(
        `SELECT MIN(CAST(${startRaw} AS REAL)) AS minS, MAX(CAST(${startRaw} AS REAL)) AS maxS, MIN(${quoteIdent(ROW_IDX_COLUMN)}) AS ridx ` +
          `FROM ${table} WHERE ${descFmt} = ?`
      )
      .get(top.k) as { minS: number; maxS: number; ridx: number } | undefined;

    return {
      summary:
        `${key} re-invalidated in a dense burst — ${top.denseCount.toLocaleString("en-US")} consecutive re-evaluations under 1ms apart, ` +
        "the signature of a synchronous invalidation cascade rather than steady-state churn",
      firing: [
        { metric: "dense (<1ms) inter-arrival count", value: top.denseCount, threshold: DENSE_CLUSTER_THRESHOLD, direction: "over" },
      ],
      callSpec: {
        verb: "aggregate",
        schema: "swiftui-updates",
        args: { groupBy: "description", measure: "duration", op: "count", topN: 10 },
      },
      handles: range
        ? [
            { kind: "window", schema: "swiftui-updates", timeRange: { startNs: range.minS, endNs: range.maxS }, label: `${key} rebuild-storm window` },
            { kind: "row", schema: "swiftui-updates", rowIndex: range.ridx, label: `first ${key} eval in the burst` },
          ]
        : [],
    };
  },
};
