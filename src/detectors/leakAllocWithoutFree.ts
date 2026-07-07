/**
 * PMT:flint-larch corpus detector #6 — allocations with no matching free.
 *
 * IMPORTANT design note (per the task brief): the obvious implementation is an
 * anti-join against the Leaks recording (an allocation address with no
 * corresponding Leaks row) — but Leaks recordings are currently failing in
 * this environment (see MEMORY.md), so that's not a reliable signal to depend
 * on. It turns out it isn't even necessary: the Allocations List
 * (track-detail format, parseTrackDetail.ts) already carries a `live` column
 * per row — "is this allocation still allocated (never freed) as of the end
 * of the recording" — which is EXACTLY "no matching free", computed by
 * Instruments itself at capture time. Verified live against a real Allocations
 * recording: 347,673 rows, `live` = "true" for all of them in that capture
 * (no frees were ever discarded/recorded in that run), summing to ~677MB of
 * never-freed allocations — a real, large finding straight off one table.
 *
 * cost: CHEAP — this downgrades from the anticipated "expensive anti-join"
 * (Leaks or a same-table alloc/free address anti-join) to a single-table
 * indexed-equality filter + bounded aggregate, the same shape as the
 * swiftui-over-invalidation template detector. It is intrinsically bounded
 * (one WHERE + one GROUP BY/aggregate over one table, no join, no window, no
 * percentile), so per the core-vs-lens cost rule it belongs in the eager,
 * cheap tier, not gated behind an on-demand lens (aidocs/howLensesWork.md).
 */
import { quoteIdent, ROW_IDX_COLUMN } from "../engine/sqliteStore.js";
import { fmtCol, rawCol } from "../engine/sqlHydrate.js";
import type { Detector } from "./types.js";

const ALLOCATIONS_LIST_SCHEMA = "Allocations/Allocations List";
const LIVE_VALUE = "true"; // parseTrackDetail's raw XML attribute value for a still-allocated row
const COUNT_THRESHOLD = 1000; // unfreed allocations
const BYTES_THRESHOLD = 10_000_000; // 10MB

export const leakAllocWithoutFree: Detector = {
  id: "leak-alloc-without-free",
  title: "Allocations with no matching free",
  requiredSchemas: [ALLOCATIONS_LIST_SCHEMA],
  cost: "cheap",
  run(ctx) {
    const table = quoteIdent(ctx.tableName(ALLOCATIONS_LIST_SCHEMA));
    const liveFmt = quoteIdent(fmtCol("live"));
    const sizeRaw = quoteIdent(rawCol("size"));

    const row = ctx.db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(CAST(${sizeRaw} AS REAL)), 0) AS bytes FROM ${table} WHERE ${liveFmt} = ?`)
      .get(LIVE_VALUE) as { n: number; bytes: number } | undefined;
    if (!row || row.n <= COUNT_THRESHOLD || row.bytes <= BYTES_THRESHOLD) return null;

    const heaviest = ctx.db
      .prepare(
        `SELECT ${quoteIdent(ROW_IDX_COLUMN)} AS idx FROM ${table} WHERE ${liveFmt} = ? ` +
          `ORDER BY CAST(${sizeRaw} AS REAL) DESC LIMIT 1`
      )
      .get(LIVE_VALUE) as { idx: number } | undefined;

    const mb = row.bytes / 1e6;
    return {
      summary: `${row.n.toLocaleString("en-US")} allocations (${mb.toFixed(1)}MB) were never freed by the end of the recording`,
      firing: [
        { metric: "count", value: row.n, threshold: COUNT_THRESHOLD, direction: "over" },
        { metric: "sum(size) bytes", value: Math.round(row.bytes), threshold: BYTES_THRESHOLD, direction: "over" },
      ],
      callSpec: {
        verb: "aggregate",
        schema: ALLOCATIONS_LIST_SCHEMA,
        args: { groupBy: "category", measure: "size", op: "sum", filter: { live: LIVE_VALUE }, topN: 10 },
      },
      handles: heaviest
        ? [{ kind: "row", schema: ALLOCATIONS_LIST_SCHEMA, rowIndex: heaviest.idx, label: "heaviest never-freed allocation" }]
        : [],
    };
  },
};
