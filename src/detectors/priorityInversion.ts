/**
 * Corpus detector — thread priority inversion (the hitch
 * "narrow" layer, sibling to qosMismatch.ts — together they complete
 * show(vsync table) → narrow(QoS/priority) → dig(ThreadActivity)).
 *
 * ThreadPriority carries a thread's REQUESTED base-priority ("User
 * Interactive - 46") alongside what it was ACTUALLY scheduled at
 * ("Default - 31" — a raw sched-priority number embedded in both, directly
 * comparable). A classic priority inversion is scheduled < base for a
 * meaningful duration — a high-priority thread stuck running at a lower
 * effective priority, typically because it's waiting on a lock held by a
 * lower-priority thread.
 *
 * DURATION_THRESHOLD_NS is grounded in this table's own real distribution
 * (verified live, read-only export against 2026-07-07T20-27-57-animation-
 * hitches.trace): median row duration ~3.3ms, p75 ~16.7ms across 3,611 real
 * rows — 50ms sits well above both, filtering routine short-lived priority
 * transitions while still catching genuinely sustained inversions. No real
 * inversion example existed in that specific trace to calibrate a firing
 * threshold from directly (every real row there was a priority BOOST, not an
 * inversion) — unlike qosMismatch.ts's confirmed real firing case, this
 * detector's LOGIC is verified against the real column shapes but its
 * threshold is a documented, distribution-grounded choice, not empirically
 * tuned against a real inversion.
 *
 * cost: CHEAP — a single-table indexed cross-column comparison + duration
 * filter (the same shape find()'s own compareCol — comparing two columns on
 * the same row instead of a literal — exposes to the AI directly via the
 * callSpec below).
 */
import { quoteIdent, ROW_IDX_COLUMN } from "../engine/sqliteStore.js";
import { fmtCol, rawCol } from "../engine/sqlHydrate.js";
import type { Detector } from "./types.js";

const PRIORITY_SCHEMA = "ThreadPriority";
const DURATION_THRESHOLD_NS = 50_000_000; // 50ms — see header comment for the distribution this is grounded in

export const priorityInversion: Detector = {
  id: "thread-priority-inversion",
  title: "Thread priority inversion — scheduled below base for a sustained window",
  requiredSchemas: [PRIORITY_SCHEMA],
  cost: "cheap",
  run(ctx) {
    const table = quoteIdent(ctx.tableName(PRIORITY_SCHEMA));
    const scheduledRaw = quoteIdent(rawCol("scheduled-priority"));
    const baseRaw = quoteIdent(rawCol("base-priority"));
    const scheduledFmt = quoteIdent(fmtCol("scheduled-priority"));
    const baseFmt = quoteIdent(fmtCol("base-priority"));
    const durationRaw = quoteIdent(rawCol("duration"));
    const startRaw = quoteIdent(rawCol("start"));
    const processFmt = quoteIdent(fmtCol("process"));
    const threadFmt = quoteIdent(fmtCol("thread"));

    const rows = ctx.db
      .prepare(
        `SELECT ${processFmt} AS process, ${threadFmt} AS thread, ${scheduledFmt} AS scheduledFmt, ` +
          `${baseFmt} AS baseFmt, CAST(${startRaw} AS REAL) AS start, CAST(${durationRaw} AS REAL) AS duration, ` +
          `${quoteIdent(ROW_IDX_COLUMN)} AS idx FROM ${table} ` +
          `WHERE CAST(${scheduledRaw} AS REAL) < CAST(${baseRaw} AS REAL) AND CAST(${durationRaw} AS REAL) > ? ` +
          `ORDER BY CAST(${durationRaw} AS REAL) DESC`
      )
      .all(DURATION_THRESHOLD_NS) as Array<{
      process: string; thread: string; scheduledFmt: string; baseFmt: string; start: number; duration: number; idx: number;
    }>;
    if (rows.length === 0) return null;

    const worst = rows[0];
    const worstMs = worst.duration / 1e6;

    return {
      summary:
        `${worst.process} ran at scheduled priority "${worst.scheduledFmt}" — below its base "${worst.baseFmt}" — ` +
        `for ${worstMs.toFixed(1)}ms, a sustained priority inversion` +
        (rows.length > 1 ? ` (${rows.length.toLocaleString("en-US")} inversion windows above the threshold total)` : ""),
      firing: [{ metric: "longest inversion duration ms", value: worstMs, threshold: DURATION_THRESHOLD_NS / 1e6, direction: "over" }],
      callSpec: {
        verb: "find",
        schema: PRIORITY_SCHEMA,
        args: { where: [{ col: "scheduled-priority", op: "lt", compareCol: "base-priority" }] },
      },
      handles: [
        { kind: "row", schema: PRIORITY_SCHEMA, rowIndex: worst.idx, label: "the longest priority-inversion row" },
        {
          kind: "window",
          schema: "ThreadActivity",
          timeRange: { startNs: worst.start, endNs: worst.start + worst.duration },
          label: "the expensive why-dig — open ThreadActivity in this exact window to see what held it down (not eager-ingested)",
        },
      ],
    };
  },
};
