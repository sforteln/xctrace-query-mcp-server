/**
 * Corpus detector #5 — hitch cause split (GPU-bound vs
 * main-thread-busy).
 *
 * Splits app-caused hitches (hitches.is-system = No) by whether ANY Time
 * Profiler sample landed inside the hitch's [start, start+duration] window
 * with thread-state = Running. No sample in-window → nothing was executing
 * during the hitch, which points at a GPU/compositor stall, not app code; a
 * Running sample in-window → real CPU work was happening, so the app's own
 * code is the likely cause. Fires on the GPU-bound count crossing a band —
 * that's the surprising, actionable split (an app team chasing "why do we
 * hitch" often assumes it's always their code).
 *
 * Simplification (documented, not silent): this doesn't restrict "in-window"
 * samples to the specific thread that hitched — time-sample has no
 * cross-schema-comparable main-thread flag of its own (only a raw thread
 * identity), so ANY Running sample anywhere in the process during the window
 * counts as "busy". A future refinement could join through thread-info's
 * main-thread boolean for a tighter match.
 *
 * cost: EXPENSIVE — a NOT EXISTS anti-join between hitches and time-sample
 * over a time-range predicate, hand-written the same shape relate.ts's
 * {time-range, not-exists} corner uses (A-side arithmetic CAST for safety, the
 * B-side range column left BARE so SQLite can seek its index — see relate.ts's
 * 039.C perf caution). A range anti-join is exactly what the core-vs-lens cost
 * rule reserves for a named detector, never a free verb.
 *
 * Verified live against a real Animation Hitches + Time Profiler recording:
 * 248 app-caused hitches split 122 GPU-bound / 126 main-thread-busy — a real,
 * roughly-even split, comfortably over the default threshold.
 */
import { quoteIdent } from "../engine/sqliteStore.js";
import { fmtCol, rawCol } from "../engine/sqlHydrate.js";
import type { Detector } from "./types.js";

const APP_HITCH = "No"; // is-system=No
const RUNNING_STATE = "Running";
const GPU_BOUND_COUNT_THRESHOLD = 10;

export const hitchCauseSplit: Detector = {
  id: "hitch-cause-split",
  title: "Hitch cause split (GPU-bound vs main-thread-busy)",
  requiredSchemas: ["hitches", "time-sample"],
  cost: "expensive",
  run(ctx) {
    const hitches = quoteIdent(ctx.tableName("hitches"));
    const timeSample = quoteIdent(ctx.tableName("time-sample"));
    const isSystemFmt = quoteIdent(fmtCol("is-system"));
    const hStartRaw = quoteIdent(rawCol("start"));
    const hDurRaw = quoteIdent(rawCol("duration"));
    const tsStateFmt = quoteIdent(fmtCol("thread-state"));
    const tsTimeRaw = quoteIdent(rawCol("time"));

    // A-side (per-hitch) arithmetic is CAST for safety; the B-side time column
    // stays bare so SQLite can index-seek it (relate.ts's 039.C caution).
    const windowMatch =
      `${tsTimeRaw} BETWEEN CAST(h.${hStartRaw} AS REAL) AND CAST(h.${hStartRaw} AS REAL) + CAST(h.${hDurRaw} AS REAL)`;

    const row = ctx.db
      .prepare(
        `SELECT ` +
          `SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM ${timeSample} ts WHERE ts.${tsStateFmt} = ? AND ts.${windowMatch}) THEN 1 ELSE 0 END) AS gpuBound, ` +
          `COUNT(*) AS total ` +
          `FROM ${hitches} h WHERE h.${isSystemFmt} = ?`
      )
      .get(RUNNING_STATE, APP_HITCH) as { gpuBound: number; total: number } | undefined;
    if (!row || row.total === 0 || row.gpuBound <= GPU_BOUND_COUNT_THRESHOLD) return null;

    const drill = ctx.db
      .prepare(
        `SELECT ${quoteIdent("_row_idx")} AS idx FROM ${hitches} h ` +
          `WHERE h.${isSystemFmt} = ? AND NOT EXISTS (SELECT 1 FROM ${timeSample} ts WHERE ts.${tsStateFmt} = ? AND ts.${windowMatch}) ` +
          `ORDER BY CAST(h.${hDurRaw} AS REAL) DESC LIMIT 1`
      )
      .get(APP_HITCH, RUNNING_STATE) as { idx: number } | undefined;

    return {
      summary:
        `${row.gpuBound.toLocaleString("en-US")} of ${row.total.toLocaleString("en-US")} app-caused hitches have NO CPU sample running during ` +
        "the stall — GPU/compositor-bound, not something the app's own code caused",
      firing: [{ metric: "GPU-bound hitch count", value: row.gpuBound, threshold: GPU_BOUND_COUNT_THRESHOLD, direction: "over" }],
      callSpec: {
        verb: "relate",
        schema: "hitches",
        args: {
          schemaA: "hitches",
          schemaB: "time-sample",
          joinCondition: "time-range",
          polarity: "not-exists",
          groupBy: "process",
          matchThread: false,
          aFilter: { "is-system": APP_HITCH },
          bFilter: { "thread-state": RUNNING_STATE },
          listRows: true,
        },
      },
      handles: drill ? [{ kind: "row", schema: "hitches", rowIndex: drill.idx, label: "longest GPU-bound hitch (no CPU sample in-window)" }] : [],
    };
  },
};
