/**
 * PMT:flint-larch corpus detector #2 — animation hitch duration distribution.
 *
 * The Animation Hitches instrument ("hitches" schema) logs one row per dropped
 * frame; a handful of long hitches can hide in an average, but the p95/p99
 * duration is what actually determines whether a user perceives stutter. This
 * fires when either percentile crosses a "missed frame budget" band (33ms ≈ 1
 * dropped frame at 30fps; 50ms ≈ a much worse one), restricted to APP-caused
 * hitches (is-system = No — system-owned hitches aren't actionable by the app).
 *
 * cost: EXPENSIVE — p95/p99 use the mcp_p95/mcp_p99 nearest-rank percentile
 * UDFs (sqlHydrate.ts's registerPercentileUdfs / PMT:round-rime), which is
 * exactly the "percentile UDF" case the core-vs-lens cost rule calls out as
 * never a free/cheap verb (aidocs/howLensesWork.md).
 *
 * Verified live against a real Animation Hitches recording
 * (~/Library/Application Support/far-swan/recordings/…-swiftui.trace): 248
 * app-caused hitches, p95 ≈ 50.0ms, p99 ≈ 66.7ms — comfortably over both
 * bands, a real finding, not just a synthetic one.
 */
import { quoteIdent } from "../engine/sqliteStore.js";
import { fmtCol, rawCol } from "../engine/sqlHydrate.js";
import type { Detector } from "./types.js";

const APP_HITCH = "No"; // is-system=No — app-caused, not system-owned
const MIN_SAMPLES = 5; // don't trust a percentile computed from a handful of hitches
const P95_THRESHOLD_MS = 33; // ~1 dropped frame at 30fps
const P99_THRESHOLD_MS = 50;

export const animationHitchesDistribution: Detector = {
  id: "animation-hitches-distribution",
  title: "Animation hitch duration distribution (p95/p99)",
  requiredSchemas: ["hitches"],
  cost: "expensive",
  run(ctx) {
    const table = quoteIdent(ctx.tableName("hitches"));
    const isSystemFmt = quoteIdent(fmtCol("is-system"));
    const durRaw = quoteIdent(rawCol("duration"));

    const row = ctx.db
      .prepare(
        `SELECT COUNT(*) AS n, mcp_p95(CAST(${durRaw} AS REAL)) AS p95, mcp_p99(CAST(${durRaw} AS REAL)) AS p99 ` +
          `FROM ${table} WHERE ${isSystemFmt} = ?`
      )
      .get(APP_HITCH) as { n: number; p95: number | null; p99: number | null } | undefined;
    if (!row || row.n < MIN_SAMPLES || row.p95 === null || row.p99 === null) return null;

    const p95Ms = row.p95 / 1e6; // duration raw is ns
    const p99Ms = row.p99 / 1e6;

    const firing: Array<{ metric: string; value: number; threshold: number; direction: "over" }> = [];
    if (p95Ms > P95_THRESHOLD_MS) firing.push({ metric: "p95 duration ms", value: Math.round(p95Ms * 10) / 10, threshold: P95_THRESHOLD_MS, direction: "over" });
    if (p99Ms > P99_THRESHOLD_MS) firing.push({ metric: "p99 duration ms", value: Math.round(p99Ms * 10) / 10, threshold: P99_THRESHOLD_MS, direction: "over" });
    if (firing.length === 0) return null;

    const heavy = ctx.db
      .prepare(
        `SELECT ${quoteIdent("_row_idx")} AS idx FROM ${table} WHERE ${isSystemFmt} = ? ORDER BY CAST(${durRaw} AS REAL) DESC LIMIT 1`
      )
      .get(APP_HITCH) as { idx: number } | undefined;

    return {
      summary:
        `App-caused animation hitches (${row.n.toLocaleString("en-US")} over the trace) have a p95 of ${p95Ms.toFixed(1)}ms ` +
        `and p99 of ${p99Ms.toFixed(1)}ms — a real stutter tail, not just a rare outlier`,
      firing,
      callSpec: {
        verb: "aggregate",
        schema: "hitches",
        args: { groupBy: "process", measure: "duration", op: "p95", filter: { "is-system": APP_HITCH }, topN: 10 },
      },
      handles: heavy
        ? [{ kind: "row", schema: "hitches", rowIndex: heavy.idx, label: "longest app-caused hitch" }]
        : [],
    };
  },
};
