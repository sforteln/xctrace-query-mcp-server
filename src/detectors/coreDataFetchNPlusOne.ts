/**
 * PMT:thick-gull — Core Data / SwiftData N+1 fetch detector.
 *
 * core-data-fetch carries `fetch-count` — the number of OBJECTS that ONE
 * fetch call actually returned, distinct from the row count itself (one
 * fetch CALL per row). An entity fetched MANY times, each call returning
 * only a HANDFUL of objects, is the textbook N+1 signature: many separate
 * single/small fetches where one bulk query would do. This is fully self-
 * contained — no external "actual object count in the app" denominator
 * needed, resolving the open question the sourcing retrospective raised.
 *
 * Verified live against a real trace (2026-07-08T23-34-46-data-persistence,
 * a fresh re-recording after confirming the earlier trace's core-data-fetch
 * SIGTRAP-crash-on-export was specific to that trace's data, not a standing
 * bug): "Prompt" fetched 830 times averaging 1.00 objects/call — an obvious
 * case the thresholds below are calibrated to catch, while "Project" (7
 * calls, avg 8.00 objects/call — a legitimate small bulk fetch) correctly
 * does not fire.
 *
 * cost: CHEAP — a single-table GROUP BY + HAVING, same intrinsically-bounded
 * shape as the other corpus detectors.
 */
import { quoteIdent, ROW_IDX_COLUMN } from "../engine/sqliteStore.js";
import { rawCol, fmtCol, makeInternResolver } from "../engine/sqlHydrate.js";
import type { Detector } from "./types.js";

const SCHEMA = "core-data-fetch";
const MIN_CALLS_THRESHOLD = 20; // fewer calls than this isn't a "storm" worth flagging
const MAX_AVG_OBJECTS_PER_CALL = 2; // avg objects/call at or above this reads as legitimate bulk fetching

export const coreDataFetchNPlusOne: Detector = {
  id: "core-data-fetch-n-plus-one",
  title: "Core Data / SwiftData N+1 fetch pattern",
  requiredSchemas: [SCHEMA],
  cost: "cheap",
  run(ctx) {
    const table = quoteIdent(ctx.tableName(SCHEMA));
    const entityFmt = quoteIdent(fmtCol("fetch-entity"));
    const countRaw = quoteIdent(rawCol("fetch-count"));

    const row = ctx.db
      .prepare(
        `SELECT ${entityFmt} AS entity, COUNT(*) AS calls, AVG(CAST(${countRaw} AS REAL)) AS avgObjects ` +
          `FROM ${table} WHERE ${entityFmt} IS NOT NULL AND ${countRaw} IS NOT NULL ` +
          `GROUP BY ${entityFmt} ` +
          `HAVING calls > ? AND avgObjects < ? ` +
          `ORDER BY calls DESC LIMIT 1`
      )
      .get(MIN_CALLS_THRESHOLD, MAX_AVG_OBJECTS_PER_CALL) as
      | { entity: string; calls: number; avgObjects: number }
      | undefined;
    if (!row) return null;

    const unintern = makeInternResolver(ctx.db);
    const entityName = String(unintern(row.entity) ?? row.entity);
    const avgRounded = Math.round(row.avgObjects * 100) / 100;

    const example = ctx.db
      .prepare(
        `SELECT ${quoteIdent(ROW_IDX_COLUMN)} AS idx FROM ${table} ` +
          `WHERE ${entityFmt} = ? LIMIT 1`
      )
      .get(row.entity) as { idx: number } | undefined;

    return {
      summary:
        `"${entityName}" was fetched ${row.calls.toLocaleString("en-US")} times, averaging ` +
        `${avgRounded.toFixed(2)} objects per fetch — a strong N+1 signal (many small fetches ` +
        "instead of one bulk query)",
      firing: [
        { metric: "fetch calls", value: row.calls, threshold: MIN_CALLS_THRESHOLD, direction: "over" },
        { metric: "avg objects per call", value: avgRounded, threshold: MAX_AVG_OBJECTS_PER_CALL, direction: "under" },
      ],
      callSpec: {
        verb: "aggregate",
        schema: SCHEMA,
        args: { groupBy: "fetch-entity", op: "count", topN: 10 },
      },
      handles: example
        ? [{ kind: "row", schema: SCHEMA, rowIndex: example.idx, label: `one of ${row.calls} "${entityName}" fetches` }]
        : [],
    };
  },
};
