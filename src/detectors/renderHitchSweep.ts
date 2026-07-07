/**
 * Render-hitch sweep — the render-PASS twin of PMT:shingle-bluff's outlier
 * sweep. Where outlierSweep sweeps hitches' own duration relative to the
 * frame budget, this sweeps hitches-renders' per-render-pass duration
 * relative to Apple's render-hitch baseline (frameBudget.ts's
 * resolveRenderBaselineMs — ((buffer-count - 1) / 2) x the frame budget, the
 * double-buffering pipeline's own time budget, aidocs #1 / dim-chalk §1).
 *
 * still-hail (PMT) deferred this baseline, believing no buffer-count signal
 * was available anywhere in the ingested Display schemas. It turned out
 * display-vsyncs-interval's `color` mnemonic — a name that reads like a plain
 * UI tag, and IS just that on other Display schemas — carries engineering-
 * type "render-buffer-depth" on THIS schema specifically (verified live,
 * fmt="2" constant); frameBudget.ts's header has the full correction.
 *
 * hitches-renders has no is-system column (unlike hitches) — every row here
 * is already a render pass behind SOME hitch, so there's no app/system split
 * to filter on.
 *
 * cost: EXPENSIVE — same full unindexed band scan as outlierSweep/
 * nearMissSweep, just over hitches-renders instead of hitches; the core-vs-
 * lens cost rule reserves any full-table band scan for a named, on-demand
 * lens (aidocs/howLensesWork.md).
 */
import { quoteIdent, ROW_IDX_COLUMN } from "../engine/sqliteStore.js";
import { rawCol } from "../engine/sqlHydrate.js";
import type { Detector, FiringCondition } from "./types.js";
import {
  MIN_HITCH_SAMPLES,
  OUTLIER_HIGH_COUNT_THRESHOLD,
  OUTLIER_MODERATE_COUNT_THRESHOLD,
  RENDER_BASELINE_HIGH_MULTIPLE,
  RENDER_BASELINE_LOW_MULTIPLE,
} from "./bands.js";
import { resolveRenderBaselineMs } from "./frameBudget.js";

export const HITCHES_RENDERS_SCHEMA = "hitches-renders";

export const renderHitchSweep: Detector = {
  id: "render-hitch-sweep",
  title: "Render-hitch sweep (Apple's render-baseline over-crossings)",
  requiredSchemas: [HITCHES_RENDERS_SCHEMA],
  cost: "expensive",
  run(ctx) {
    const table = quoteIdent(ctx.tableName(HITCHES_RENDERS_SCHEMA));
    const durRaw = quoteIdent(rawCol("duration"));

    const baseline = resolveRenderBaselineMs(ctx);
    const lowNs = RENDER_BASELINE_LOW_MULTIPLE * baseline.baselineMs * 1e6;
    const highNs = RENDER_BASELINE_HIGH_MULTIPLE * baseline.baselineMs * 1e6;

    const row = ctx.db
      .prepare(
        `SELECT COUNT(*) AS n, ` +
          `SUM(CASE WHEN CAST(${durRaw} AS REAL) > ? THEN 1 ELSE 0 END) AS overLowCount, ` +
          `SUM(CASE WHEN CAST(${durRaw} AS REAL) >= ? THEN 1 ELSE 0 END) AS highCount ` +
          `FROM ${table}`
      )
      .get(lowNs, highNs) as { n: number; overLowCount: number; highCount: number } | undefined;
    if (!row || row.n < MIN_HITCH_SAMPLES) return null;

    const firing: FiringCondition[] = [];
    if (row.overLowCount > OUTLIER_MODERATE_COUNT_THRESHOLD) {
      firing.push({
        metric: `render passes over ${RENDER_BASELINE_LOW_MULTIPLE}x the render baseline (past Low)`,
        value: row.overLowCount,
        threshold: OUTLIER_MODERATE_COUNT_THRESHOLD,
        direction: "over",
      });
    }
    if (row.highCount > OUTLIER_HIGH_COUNT_THRESHOLD) {
      firing.push({
        metric: `render passes at/over ${RENDER_BASELINE_HIGH_MULTIPLE}x the render baseline (High)`,
        value: row.highCount,
        threshold: OUTLIER_HIGH_COUNT_THRESHOLD,
        direction: "over",
      });
    }
    if (firing.length === 0) return null;

    const worst = ctx.db
      .prepare(`SELECT ${quoteIdent(ROW_IDX_COLUMN)} AS idx FROM ${table} ORDER BY CAST(${durRaw} AS REAL) DESC LIMIT 1`)
      .get() as { idx: number } | undefined;

    return {
      summary:
        `${row.highCount.toLocaleString("en-US")} of ${row.n.toLocaleString("en-US")} render passes crossed Apple's render-baseline ` +
        `High band (>= ${RENDER_BASELINE_HIGH_MULTIPLE}x the ~${baseline.baselineMs.toFixed(2)}ms baseline for a ${baseline.bufferDepth}-deep buffer) ` +
        `— a slow render likely causing the hitch itself, not just downstream of one` +
        (baseline.assumed ? ` (${baseline.note})` : ""),
      firing,
      callSpec: {
        verb: "find",
        schema: HITCHES_RENDERS_SCHEMA,
        args: {
          where: [{ col: "duration", op: "gte", val: Math.round(highNs) }],
          sort: { by: "duration", dir: "desc" },
          limit: 10,
        },
      },
      handles: worst
        ? [{ kind: "row", schema: HITCHES_RENDERS_SCHEMA, rowIndex: worst.idx, label: "worst render pass (over Apple's render-baseline High band)" }]
        : [],
    };
  },
};
