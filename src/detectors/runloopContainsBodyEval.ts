/**
 * PMT:flint-larch corpus detector #7 — main-thread runloop turns that CONTAIN
 * a SwiftUI body eval.
 *
 * Counts main-thread "Busy" runloop turns (runloop-intervals: interval-type =
 * Busy, is-main = Yes) whose [start, start+duration] window CONTAINS at least
 * one SwiftUI View Body Update (swiftui-updates: update-type = "View Body
 * Updates") — the containment/causality question ("is the runloop busy
 * because SwiftUI is re-evaluating view bodies inside it"), a full-population
 * EXISTS join across BOTH tables, not just a top-N sample.
 *
 * cost: EXPENSIVE — an EXISTS time-range join over the full population of
 * both tables (the {time-range, exists} corner relate.ts documents as
 * causality), hand-written the same shape (A-side arithmetic CAST for safety,
 * B-side range column left bare for the index seek — relate.ts's 039.C perf
 * caution). Confirmed live against a real recording that this is genuinely
 * costly to run unbounded (a correlated EXISTS per busy-main runloop turn
 * against an 890K-row swiftui-updates table did not return within the
 * available real-trace validation window) — exactly the kind of query the
 * core-vs-lens rule says must be a named, on-demand detector, never a free
 * verb the AI could hand-roll itself.
 */
import { quoteIdent } from "../engine/sqliteStore.js";
import { fmtCol, rawCol } from "../engine/sqlHydrate.js";
import type { Detector } from "./types.js";

const RUNLOOP_SCHEMA = "runloop-intervals";
const SWIFTUI_SCHEMA = "swiftui-updates";
const BUSY_TYPE = "Busy";
const MAIN_YES = "Yes";
const BODY_UPDATE_TYPE = "View Body Updates";
const CONTAINS_COUNT_THRESHOLD = 50; // busy main-thread runloop turns containing ≥1 body eval

export const runloopContainsBodyEval: Detector = {
  id: "runloop-contains-body-eval",
  title: "Main-thread runloop turns containing SwiftUI body evals",
  requiredSchemas: [RUNLOOP_SCHEMA, SWIFTUI_SCHEMA],
  cost: "expensive",
  run(ctx) {
    const runloop = quoteIdent(ctx.tableName(RUNLOOP_SCHEMA));
    const swiftui = quoteIdent(ctx.tableName(SWIFTUI_SCHEMA));
    const intervalTypeFmt = quoteIdent(fmtCol("interval-type"));
    const isMainFmt = quoteIdent(fmtCol("is-main"));
    const rStartRaw = quoteIdent(rawCol("start"));
    const rDurRaw = quoteIdent(rawCol("duration"));
    const updateTypeFmt = quoteIdent(fmtCol("update-type"));
    const uStartRaw = quoteIdent(rawCol("start"));

    const windowMatch = `${uStartRaw} BETWEEN CAST(r.${rStartRaw} AS REAL) AND CAST(r.${rStartRaw} AS REAL) + CAST(r.${rDurRaw} AS REAL)`;

    const row = ctx.db
      .prepare(
        `SELECT ` +
          `SUM(CASE WHEN EXISTS (SELECT 1 FROM ${swiftui} u WHERE u.${updateTypeFmt} = ? AND u.${windowMatch}) THEN 1 ELSE 0 END) AS containsBodyEval, ` +
          `COUNT(*) AS total ` +
          `FROM ${runloop} r WHERE r.${intervalTypeFmt} = ? AND r.${isMainFmt} = ?`
      )
      .get(BODY_UPDATE_TYPE, BUSY_TYPE, MAIN_YES) as { containsBodyEval: number; total: number } | undefined;
    if (!row || row.total === 0 || row.containsBodyEval <= CONTAINS_COUNT_THRESHOLD) return null;

    const drill = ctx.db
      .prepare(
        `SELECT CAST(r.${rStartRaw} AS REAL) AS s, CAST(r.${rDurRaw} AS REAL) AS d FROM ${runloop} r ` +
          `WHERE r.${intervalTypeFmt} = ? AND r.${isMainFmt} = ? AND EXISTS (SELECT 1 FROM ${swiftui} u WHERE u.${updateTypeFmt} = ? AND u.${windowMatch}) ` +
          `ORDER BY d DESC LIMIT 1`
      )
      .get(BUSY_TYPE, MAIN_YES, BODY_UPDATE_TYPE) as { s: number; d: number } | undefined;

    return {
      summary:
        `${row.containsBodyEval.toLocaleString("en-US")} of ${row.total.toLocaleString("en-US")} main-thread busy runloop turns contain a ` +
        "SwiftUI view body re-evaluation — SwiftUI work is a real driver of main-thread busy-ness here",
      firing: [{ metric: "containing runloop turns", value: row.containsBodyEval, threshold: CONTAINS_COUNT_THRESHOLD, direction: "over" }],
      callSpec: {
        verb: "relate",
        schema: RUNLOOP_SCHEMA,
        args: {
          schemaA: RUNLOOP_SCHEMA,
          schemaB: SWIFTUI_SCHEMA,
          joinCondition: "time-range",
          polarity: "exists",
          groupBy: "process",
          matchThread: false,
          aFilter: { "interval-type": BUSY_TYPE, "is-main": MAIN_YES },
          bFilter: { "update-type": BODY_UPDATE_TYPE },
          listRows: true,
        },
      },
      handles: drill
        ? [{ kind: "window", schema: RUNLOOP_SCHEMA, timeRange: { startNs: drill.s, endNs: drill.s + drill.d }, label: "busy main-thread runloop turn containing a body eval" }]
        : [],
    };
  },
};
