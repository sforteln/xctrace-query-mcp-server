/**
 * PMT:flint-larch corpus detector #9 — Main Actor queue depth saturation.
 *
 * SwiftActorQueueSize is a time-series of how many tasks are waiting on each
 * Swift actor's executor (the `count` column, PMT:round-rime's weight-unit
 * "count"). A deep, sustained queue on an actor — especially the Main Actor —
 * means tasks are piling up faster than the actor can drain them: a real
 * concurrency bottleneck. Fires when the PEAK queue depth crosses a band AND
 * enough samples show it (a single one-sample spike isn't "sustained").
 *
 * cost: CHEAP — a single-table MAX + filtered-COUNT aggregate (no join, no
 * window, no percentile) — intrinsically bounded the same way the template
 * detector's GROUP BY scan is.
 *
 * Not validated against a real trace — no Swift Concurrency recording was
 * available at authoring time (see the PMT:flint-larch completion report).
 * Unit-tested against a synthetic SwiftActorQueueSize table only.
 */
import { quoteIdent, ROW_IDX_COLUMN } from "../engine/sqliteStore.js";
import { rawCol } from "../engine/sqlHydrate.js";
import type { Detector } from "./types.js";

const QUEUE_SCHEMA = "SwiftActorQueueSize";
const QUEUE_DEPTH_THRESHOLD = 10; // tasks waiting on one actor
const SAMPLE_COUNT_THRESHOLD = 20; // samples at/above the depth band (sustained, not a blip)

export const fmMainActorSaturation: Detector = {
  id: "fm-main-actor-saturation",
  title: "Main Actor / executor queue-depth saturation",
  requiredSchemas: [QUEUE_SCHEMA],
  cost: "cheap",
  run(ctx) {
    const table = quoteIdent(ctx.tableName(QUEUE_SCHEMA));
    const countRaw = quoteIdent(rawCol("count"));

    const row = ctx.db
      .prepare(
        `SELECT MAX(CAST(${countRaw} AS REAL)) AS maxDepth, ` +
          `COUNT(CASE WHEN CAST(${countRaw} AS REAL) > ? THEN 1 END) AS overCount ` +
          `FROM ${table} WHERE ${countRaw} IS NOT NULL`
      )
      .get(QUEUE_DEPTH_THRESHOLD) as { maxDepth: number | null; overCount: number } | undefined;
    if (!row || row.maxDepth === null) return null;
    if (row.maxDepth <= QUEUE_DEPTH_THRESHOLD || row.overCount <= SAMPLE_COUNT_THRESHOLD) return null;

    const heaviest = ctx.db
      .prepare(`SELECT ${quoteIdent(ROW_IDX_COLUMN)} AS idx FROM ${table} ORDER BY CAST(${countRaw} AS REAL) DESC LIMIT 1`)
      .get() as { idx: number } | undefined;

    return {
      summary:
        `An actor's executor queue peaked at ${row.maxDepth.toLocaleString("en-US")} waiting tasks, staying above ${QUEUE_DEPTH_THRESHOLD} for ` +
        `${row.overCount.toLocaleString("en-US")} samples — a sustained concurrency bottleneck, not a momentary blip`,
      firing: [
        { metric: "peak queue depth", value: row.maxDepth, threshold: QUEUE_DEPTH_THRESHOLD, direction: "over" },
        { metric: "samples over depth band", value: row.overCount, threshold: SAMPLE_COUNT_THRESHOLD, direction: "over" },
      ],
      callSpec: {
        verb: "aggregate",
        schema: QUEUE_SCHEMA,
        args: { groupBy: "actor", measure: "count", op: "max", topN: 10 },
      },
      handles: heaviest
        ? [{ kind: "row", schema: QUEUE_SCHEMA, rowIndex: heaviest.idx, label: "deepest actor queue sample" }]
        : [],
    };
  },
};
