/**
 * PMT:tidy-shore — near-miss sweep (the leading-indicator twin of
 * PMT:shingle-bluff's outlier sweep, over the SAME band map, bands.ts).
 *
 * Where outlierSweep flags rows already OVER an Apple-meaningful band ("this
 * is already bad"), this flags the sub-threshold population sitting just
 * UNDER it — Apple's own binary Moderate/High flag hides everything below
 * the line, but a hitch at 0.9x the frame budget is a trend, not noise. Frame
 * every finding as an early warning, always naming BOTH the Apple cutoff
 * being approached (the frame budget itself) and the lower band used to spot
 * it (0.5x-1x, aidocs #1's tidy-shore mapping) — never presented as if it
 * were an actual dropped frame.
 *
 * Only the hitches band is wired today; see bands.ts for why FileActivity's
 * isn't (and why this and outlierSweep share one small module rather than
 * each keeping its own copy of the thresholds).
 *
 * cost: EXPENSIVE — same full unindexed band scan as outlierSweep, just a
 * different slice of the same table; the core-vs-lens cost rule reserves any
 * full-table band scan for a named, on-demand lens (aidocs/howLensesWork.md).
 */
import { quoteIdent, ROW_IDX_COLUMN } from "../engine/sqliteStore.js";
import { fmtCol, rawCol } from "../engine/sqlHydrate.js";
import type { Detector, FiringCondition } from "./types.js";
import {
  APP_HITCH,
  DEFAULT_REFRESH_INTERVAL_MS,
  HITCH_MODERATE_MULTIPLE,
  HITCH_NEAR_MISS_HIGH_MULTIPLE,
  HITCH_NEAR_MISS_LOW_MULTIPLE,
  MIN_HITCH_SAMPLES,
  NEAR_MISS_COUNT_THRESHOLD,
  hitchBandNs,
} from "./bands.js";

export const nearMissSweep: Detector = {
  id: "near-miss-sweep",
  title: "Near-miss sweep (leading-indicator under-crossings)",
  requiredSchemas: ["hitches"],
  cost: "expensive",
  run(ctx) {
    const table = quoteIdent(ctx.tableName("hitches"));
    const isSystemFmt = quoteIdent(fmtCol("is-system"));
    const durRaw = quoteIdent(rawCol("duration"));

    const lowNs = hitchBandNs(HITCH_NEAR_MISS_LOW_MULTIPLE);
    // Upper edge == the Moderate over-cutoff (1x) — the line this population is approaching but hasn't crossed.
    const highNs = hitchBandNs(HITCH_NEAR_MISS_HIGH_MULTIPLE);

    const row = ctx.db
      .prepare(
        `SELECT COUNT(*) AS n, ` +
          `SUM(CASE WHEN CAST(${durRaw} AS REAL) >= ? AND CAST(${durRaw} AS REAL) <= ? THEN 1 ELSE 0 END) AS nearMissCount, ` +
          `MAX(CASE WHEN CAST(${durRaw} AS REAL) >= ? AND CAST(${durRaw} AS REAL) <= ? THEN CAST(${durRaw} AS REAL) ELSE NULL END) AS worstNearMissNs ` +
          `FROM ${table} WHERE ${isSystemFmt} = ?`
      )
      .get(lowNs, highNs, lowNs, highNs, APP_HITCH) as
      | { n: number; nearMissCount: number; worstNearMissNs: number | null }
      | undefined;
    if (!row || row.n < MIN_HITCH_SAMPLES) return null;
    if (row.nearMissCount <= NEAR_MISS_COUNT_THRESHOLD || row.worstNearMissNs === null) return null;

    const worstMs = row.worstNearMissNs / 1e6;
    const frameBudgetMs = DEFAULT_REFRESH_INTERVAL_MS * HITCH_MODERATE_MULTIPLE; // the Apple cutoff being approached

    const firing: FiringCondition[] = [
      {
        metric: `hitches in near-miss band (${HITCH_NEAR_MISS_LOW_MULTIPLE}x-${HITCH_NEAR_MISS_HIGH_MULTIPLE}x frame budget)`,
        value: row.nearMissCount,
        threshold: NEAR_MISS_COUNT_THRESHOLD,
        direction: "over",
      },
      {
        metric: "closest near-miss hitch duration ms (vs Apple's dropped-frame cutoff)",
        value: Math.round(worstMs * 10) / 10,
        threshold: frameBudgetMs,
        direction: "under",
      },
    ];

    const worst = ctx.db
      .prepare(
        `SELECT ${quoteIdent(ROW_IDX_COLUMN)} AS idx FROM ${table} ` +
          `WHERE ${isSystemFmt} = ? AND CAST(${durRaw} AS REAL) >= ? AND CAST(${durRaw} AS REAL) <= ? ` +
          `ORDER BY CAST(${durRaw} AS REAL) DESC LIMIT 1`
      )
      .get(APP_HITCH, lowNs, highNs) as { idx: number } | undefined;

    return {
      summary:
        `${row.nearMissCount.toLocaleString("en-US")} of ${row.n.toLocaleString("en-US")} app-caused hitches sit in the ` +
        `${HITCH_NEAR_MISS_LOW_MULTIPLE}x-${HITCH_NEAR_MISS_HIGH_MULTIPLE}x frame-budget band — UNDER Apple's dropped-frame cutoff ` +
        `(${HITCH_MODERATE_MULTIPLE}x the ~${DEFAULT_REFRESH_INTERVAL_MS}ms frame budget) but trending toward it; the closest is ${worstMs.toFixed(1)}ms — ` +
        `a leading indicator, not yet an actual dropped frame`,
      firing,
      callSpec: {
        verb: "find",
        schema: "hitches",
        args: {
          where: [
            { col: "is-system", op: "eq", val: APP_HITCH },
            { col: "duration", op: "gte", val: Math.round(lowNs) },
            { col: "duration", op: "lte", val: Math.round(highNs) },
          ],
          sort: { by: "duration", dir: "desc" },
          limit: 10,
        },
      },
      handles: worst
        ? [{ kind: "row", schema: "hitches", rowIndex: worst.idx, label: "closest near-miss hitch (approaching the dropped-frame line)" }]
        : [],
    };
  },
};
