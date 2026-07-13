/**
 * Mid-parse memory guard — aborts a streaming table fetch cleanly before V8
 * exhausts the heap, instead of letting a fatal OOM kill the whole process.
 *
 * Confirmed live (twice, on real traces): fetching a large enough table
 * (swiftui-updates at 736,282 rows; Allocations/Allocations List at 823,471
 * rows with rich resolved backtraces) crashes the ENTIRE MCP server with
 * "FATAL ERROR: JavaScript heap out of memory" — not a catchable exception,
 * a hard process abort. That kills every open session, not just the one
 * query that tripped it, and the client sees only "Connection closed" with
 * no diagnostic (a fatal OOM aborts mid-handler, before the response — or
 * even a log line — can be written). A prior stopgap (commit cdaa5eb)
 * re-execs with a larger --max-old-space-size heap (default 8192 MB,
 * INSTRUMENTS_MCP_MAX_HEAP_MB), which raises the ceiling but doesn't remove
 * it — an even larger table can still exceed it.
 *
 * Row count alone is NOT a safe trigger — confirmed live: 823,471 Allocations
 * rows with rich multi-frame backtraces exhausted an 8 GB heap; 224,154 rows
 * of the SAME schema from a different trace, where every backtrace happened
 * to be a single trivial sentinel frame, did not come close. What actually
 * matters is bytes retained so far, which is what this checks directly via
 * V8's own heap statistics — a proxy row-weight formula would just be a
 * worse approximation of the same thing this can measure exactly.
 */
import { getHeapStatistics } from "node:v8";
import { XctraceError } from "./xctrace.js";

/**
 * Fraction of the process's ACTUAL configured heap ceiling (reflects
 * --max-old-space-size / INSTRUMENTS_MCP_MAX_HEAP_MB, not a hardcoded
 * number) at which a streaming parse aborts. A judgment call, not a
 * measured threshold, same spirit as this codebase's other percentage
 * thresholds (WINDOW_CAPTURE_THRESHOLD_PCT, SPINE_DOMINANCE_THRESHOLD_PCT)
 * — leaves headroom for the rest of this request's own processing (role
 * classification, response serialization) plus whatever other sessions are
 * concurrently resident, rather than aborting only once truly out of room.
 */
const MEMORY_BUDGET_FRACTION = 0.7;

/** Only check every N rows — process.memoryUsage()-class calls aren't free at millions of rows/sec. */
export const MEMORY_CHECK_INTERVAL = 5000;

/**
 * Throws {@link XctraceError} ("table-too-large") if heap usage has crossed
 * the budget. Call periodically (every {@link MEMORY_CHECK_INTERVAL} rows)
 * from a streaming parse's row-accumulation loop — cheap enough to poll at
 * that cadence, too expensive to call per-row.
 */
export function assertMemoryBudget(rowsParsedSoFar: number, schema: string): void {
  const stats = getHeapStatistics();
  const used = stats.used_heap_size;
  const limit = stats.heap_size_limit;
  if (used / limit < MEMORY_BUDGET_FRACTION) return;

  const heapUsedMb = Math.round(used / 1048576);
  const heapLimitMb = Math.round(limit / 1048576);
  throw new XctraceError(
    "table-too-large",
    `Aborted parsing "${schema}" after ${rowsParsedSoFar.toLocaleString("en-US")} rows — heap usage ` +
    `(${heapUsedMb} MB) crossed ${Math.round(MEMORY_BUDGET_FRACTION * 100)}% of the process's ${heapLimitMb} MB ` +
    "limit. This table is too large to materialize fully. Narrow it: pass timeRange (query/aggregate/" +
    "call_tree/correlate) or columns (query) to fetch a bounded subset instead of the whole table. " +
    "A plain filter/find-predicate (query/find's `filter`, correlate's `intervalsFilter`/`eventsFilter`) " +
    "does NOT prevent this on its own — it's applied AFTER parsing, so the full table still gets " +
    "materialized first (verified live). timeRange is the only parameter that narrows " +
    "DURING streaming, before this limit is even at risk.",
    { rowsParsedBeforeAbort: rowsParsedSoFar, heapUsedMb, heapLimitMb }
  );
}
