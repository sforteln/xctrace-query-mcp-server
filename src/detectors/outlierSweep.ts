/**
 * PMT:shingle-bluff — outlier sweep (discovery-mode lens over the Apple
 * modeler harvest's band map, src/detectors/bands.ts).
 *
 * Unlike flint-larch's corpus detectors (each chasing one specific,
 * pre-decided hypothesis — a p95/p99 tail, a rebuild storm, a cumulative
 * high-water mark), this is the GENERIC layer: for a trace where the AI has
 * no hypothesis yet, it sweeps whatever harvested (column, band) pairs apply
 * to the schemas actually present and surfaces the single most-significant
 * OVER-band crossing — "here's what's abnormal," full stop. The AI re-runs
 * `callSpec` (a `find` over the same band) to see the rest.
 *
 * Only the hitches band is wired today (bands.ts explains why FileActivity's
 * band isn't). `duration` relative to the frame budget is Apple's own
 * canonical relative-band pattern (aidocs #1): >1x = Moderate, >2x = High.
 *
 * cost: EXPENSIVE — a full unindexed scan over every app-caused hitch row
 * (two COUNT-with-CASE aggregates over the whole table), exactly the
 * "full-table band scan" the core-vs-lens cost rule reserves for a named,
 * on-demand lens rather than a free/cheap verb (aidocs/howLensesWork.md).
 */
import { quoteIdent, ROW_IDX_COLUMN } from "../engine/sqliteStore.js";
import { fmtCol, rawCol } from "../engine/sqlHydrate.js";
import type { Detector, FiringCondition } from "./types.js";
import {
  APP_HITCH,
  DEFAULT_REFRESH_INTERVAL_MS,
  HITCH_HIGH_MULTIPLE,
  HITCH_MODERATE_MULTIPLE,
  MIN_HITCH_SAMPLES,
  OUTLIER_HIGH_COUNT_THRESHOLD,
  OUTLIER_MODERATE_COUNT_THRESHOLD,
  hitchBandNs,
} from "./bands.js";

export const outlierSweep: Detector = {
  id: "outlier-sweep",
  title: "Outlier sweep (Apple-band over-crossings)",
  requiredSchemas: ["hitches"],
  cost: "expensive",
  run(ctx) {
    const table = quoteIdent(ctx.tableName("hitches"));
    const isSystemFmt = quoteIdent(fmtCol("is-system"));
    const durRaw = quoteIdent(rawCol("duration"));

    const moderateNs = hitchBandNs(HITCH_MODERATE_MULTIPLE);
    const highNs = hitchBandNs(HITCH_HIGH_MULTIPLE);

    const row = ctx.db
      .prepare(
        `SELECT COUNT(*) AS n, ` +
          `SUM(CASE WHEN CAST(${durRaw} AS REAL) > ? THEN 1 ELSE 0 END) AS moderateCount, ` +
          `SUM(CASE WHEN CAST(${durRaw} AS REAL) > ? THEN 1 ELSE 0 END) AS highCount ` +
          `FROM ${table} WHERE ${isSystemFmt} = ?`
      )
      .get(moderateNs, highNs, APP_HITCH) as { n: number; moderateCount: number; highCount: number } | undefined;
    if (!row || row.n < MIN_HITCH_SAMPLES) return null;

    const firing: FiringCondition[] = [];
    if (row.moderateCount > OUTLIER_MODERATE_COUNT_THRESHOLD) {
      firing.push({
        metric: `hitches over ${HITCH_MODERATE_MULTIPLE}x frame budget (Moderate)`,
        value: row.moderateCount,
        threshold: OUTLIER_MODERATE_COUNT_THRESHOLD,
        direction: "over",
      });
    }
    if (row.highCount > OUTLIER_HIGH_COUNT_THRESHOLD) {
      firing.push({
        metric: `hitches over ${HITCH_HIGH_MULTIPLE}x frame budget (High)`,
        value: row.highCount,
        threshold: OUTLIER_HIGH_COUNT_THRESHOLD,
        direction: "over",
      });
    }
    if (firing.length === 0) return null;

    const worst = ctx.db
      .prepare(
        `SELECT ${quoteIdent(ROW_IDX_COLUMN)} AS idx FROM ${table} WHERE ${isSystemFmt} = ? ` +
          `ORDER BY CAST(${durRaw} AS REAL) DESC LIMIT 1`
      )
      .get(APP_HITCH) as { idx: number } | undefined;

    return {
      summary:
        `${row.moderateCount.toLocaleString("en-US")} of ${row.n.toLocaleString("en-US")} app-caused hitches crossed Apple's ` +
        `dropped-frame band (> ${HITCH_MODERATE_MULTIPLE}x the ~${DEFAULT_REFRESH_INTERVAL_MS}ms frame budget), ` +
        `${row.highCount.toLocaleString("en-US")} of those at ${HITCH_HIGH_MULTIPLE}x+ (High) — an outlier sweep, not a targeted hypothesis`,
      firing,
      callSpec: {
        verb: "find",
        schema: "hitches",
        args: {
          where: [
            { col: "is-system", op: "eq", val: APP_HITCH },
            { col: "duration", op: "gt", val: Math.round(moderateNs) },
          ],
          sort: { by: "duration", dir: "desc" },
          limit: 10,
        },
      },
      handles: worst
        ? [{ kind: "row", schema: "hitches", rowIndex: worst.idx, label: "worst outlier hitch (over Apple's dropped-frame band)" }]
        : [],
    };
  },
};
