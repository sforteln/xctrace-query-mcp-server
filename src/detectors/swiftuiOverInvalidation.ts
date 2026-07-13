/**
 * Example detector — proves the Detector contract end to end; the real
 * corpus detectors follow this same shape.
 *
 * SwiftUI over-invalidation: one view body re-evaluated far more than the rest,
 * costing real main-thread time — the SidebarView cascade that cost three live
 * traces to find by hand. A single-table, indexed GROUP BY bounded by topN, so
 * it's `cheap` and runs eager once swiftui-updates is loaded.
 */
import { quoteIdent } from "../engine/sqliteStore.js";
import { fmtCol, rawCol, makeInternResolver } from "../engine/sqlHydrate.js";
import type { Detector } from "./types.js";

const COUNT_THRESHOLD = 100; // re-evaluations
const DURATION_THRESHOLD_MS = 150; // total inclusive main-thread time

export const swiftuiOverInvalidation: Detector = {
  id: "swiftui-over-invalidation",
  title: "SwiftUI view over-invalidation",
  requiredSchemas: ["swiftui-updates"],
  cost: "cheap",
  run(ctx) {
    const table = quoteIdent(ctx.tableName("swiftui-updates"));
    const descFmt = quoteIdent(fmtCol("description"));
    const durRaw = quoteIdent(rawCol("duration"));

    const top = ctx.db
      .prepare(
        `SELECT ${descFmt} AS k, COUNT(*) AS n, COALESCE(SUM(CAST(${durRaw} AS REAL)), 0) AS d ` +
          `FROM ${table} WHERE ${descFmt} IS NOT NULL GROUP BY ${descFmt} ORDER BY n DESC LIMIT 1`
      )
      .get() as { k: string; n: number; d: number } | undefined;
    if (!top) return null;

    const durationMs = top.d / 1e6; // duration raw is ns
    if (top.n <= COUNT_THRESHOLD || durationMs <= DURATION_THRESHOLD_MS) return null;

    // Resolve the (possibly interned) description key for display, and find the
    // single heaviest eval of it as a get_row drill-down handle.
    const key = String(makeInternResolver(ctx.db)(top.k) ?? top.k);
    const heavy = ctx.db
      .prepare(`SELECT ${quoteIdent("_row_idx")} AS idx FROM ${table} WHERE ${descFmt} = ? ORDER BY CAST(${durRaw} AS REAL) DESC LIMIT 1`)
      .get(top.k) as { idx: number } | undefined;

    return {
      summary: `${key} re-evaluated ${top.n.toLocaleString("en-US")}× (${durationMs.toFixed(0)}ms total main-thread time) — a rebuild storm from repeated invalidation`,
      firing: [
        { metric: "count", value: top.n, threshold: COUNT_THRESHOLD, direction: "over" },
        { metric: "sum(duration) ms", value: Math.round(durationMs), threshold: DURATION_THRESHOLD_MS, direction: "over" },
      ],
      callSpec: {
        verb: "aggregate",
        schema: "swiftui-updates",
        args: { groupBy: "description", measure: "duration", op: "sum", topN: 10 },
      },
      handles: heavy
        ? [{ kind: "row", schema: "swiftui-updates", rowIndex: heavy.idx, label: `heaviest ${key} eval` }]
        : [],
    };
  },
};
