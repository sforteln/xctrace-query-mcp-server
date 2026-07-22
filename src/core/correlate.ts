/**
 * correlate — the friendly {time-range, EXISTS} preset over relate().
 *
 * Answers causal questions no single schema can, e.g. "did this SwiftUI
 * view-body update cause this Core Data fetch storm?" Finds every events-
 * schema row (e.g. core-data-fetch, a point timestamp) whose time falls
 * inside an intervals-schema row's [start, start+duration] window (e.g.
 * swiftui-updates), matched on the same thread by default — the
 * discriminator that turns "roughly the same time" into "provably the same
 * call path" (two unrelated interval/event pairs on different threads can
 * easily overlap in time by coincidence).
 *
 * This is now a thin mapping onto relate(A=intervals, B=events, {
 * joinCondition:"time-range", polarity:"exists" }) — the SQL indexed range
 * join over the session's SQLite-ingested tables (each schema is streamed
 * into a per-session SQLite table on first access, rather than held as a JS
 * array — see howSessionsWork.md's "Large-table hardening" section).
 * correlate() keeps its own established result shape
 * (intervalCount/intervalsWithMatch/matchedEventCount)
 * as the ergonomic entry point; relate() is the general operator underneath.
 * Requires both schemas in the same trace on the same clock — see
 * start_recording's `instruments` param to compose them.
 */
import { relate } from "./relate.js";
import { lastRun as sessionLastRun } from "../engine/session.js";
import type { WeightUnit } from "../engine/roleInference.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CorrelateOptions {
  run?: number;
  /** Mnemonic of the intervals-schema column to group results by (e.g. "view-name"). */
  groupBy: string;
  /** Mnemonic of an events-schema weight column to sum per group, alongside the match count. */
  measure?: string;
  /** Require the matched event to be on the same thread as the interval (default true). */
  matchThread?: boolean;
  /** Optional equality pre-filter on the intervals schema, applied before joining. */
  intervalsFilter?: Record<string, string | number | boolean>;
  /** Optional equality pre-filter on the events schema, applied before joining. */
  eventsFilter?: Record<string, string | number | boolean>;
  /** Max groups to return, heaviest-by-matched-events-first (default 10). */
  topN?: number;
  /** Restrict both schemas to a time window on each's own primary time column. */
  timeRange?: { startNs?: number; endNs?: number };
}

export interface CorrelateGroup {
  /** The groupBy column's fmt value for this group. */
  key: string;
  /** Intervals in this group (after intervalsFilter, before matching). */
  intervalCount: number;
  /** Of those, how many had at least one matched event. */
  intervalsWithMatch: number;
  /** Total matched events across all intervals in this group. */
  matchedEventCount: number;
  /** Sum of `measure` across matched events, if `measure` was given. */
  matchedEventValue?: number;
  matchedEventValueFmt?: string;
}

export interface CorrelateResult {
  intervalsSchema: string;
  eventsSchema: string;
  run: number;
  groupBy: string;
  measure: string | null;
  matchThread: boolean;
  /** The columns actually used to form the join — surfaced so a caller can sanity-check them. */
  startColumn: string;
  durationColumn: string;
  timestampColumn: string;
  /** The "who" columns actually used for thread matching, null if matchThread was false. */
  intervalsThreadColumn: string | null;
  eventsThreadColumn: string | null;
  /** Total intervals/events after their respective filters, before joining. */
  totalIntervals: number;
  totalEvents: number;
  totalMatchedEvents: number;
  topN: number;
  /** Total distinct groups found (before topN cap). */
  totalGroups: number;
  groups: CorrelateGroup[];
  unit?: WeightUnit;
  /** Present only when matchThread found zero matches despite temporal candidates existing. */
  threadMismatchWarning?: string;
  /** Present only when totalIntervals is 0 — distinguishes an excluded-by-filter intervalsSchema from a genuinely empty one; see emptyResultNote.ts. */
  note?: string;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function correlate(
  sessionId: string,
  intervalsSchema: string,
  eventsSchema: string,
  opts: CorrelateOptions
): Promise<CorrelateResult> {
  const { groupBy, measure, matchThread = true, intervalsFilter, eventsFilter, topN = 10, timeRange } = opts;
  const run = opts.run ?? sessionLastRun(sessionId);

  const r = await relate(sessionId, intervalsSchema, eventsSchema, {
    run,
    joinCondition: "time-range",
    polarity: "exists",
    groupBy,
    measure,
    matchThread,
    aFilter: intervalsFilter,
    bFilter: eventsFilter,
    topN,
    timeRange,
  });

  return {
    intervalsSchema,
    eventsSchema,
    run: r.run,
    groupBy,
    measure: r.measure,
    matchThread: r.matchThread,
    startColumn: r.joinColumns.aStart!,
    durationColumn: r.joinColumns.aDuration!,
    timestampColumn: r.joinColumns.bTimestamp!,
    intervalsThreadColumn: r.joinColumns.aThread ?? null,
    eventsThreadColumn: r.joinColumns.bThread ?? null,
    totalIntervals: r.totalA,
    totalEvents: r.totalB,
    totalMatchedEvents: r.totalMatches,
    topN: r.topN,
    totalGroups: r.totalGroups,
    groups: r.groups.map((g) => ({
      key: g.key,
      intervalCount: g.aCount,
      intervalsWithMatch: g.aMatched,
      matchedEventCount: g.matchCount,
      ...(g.measureSum !== undefined
        ? { matchedEventValue: g.measureSum, matchedEventValueFmt: g.measureSumFmt }
        : {}),
    })),
    ...(r.unit ? { unit: r.unit } : {}),
    ...(r.threadMismatchWarning ? { threadMismatchWarning: r.threadMismatchWarning } : {}),
    ...(r.note ? { note: r.note } : {}),
  };
}
