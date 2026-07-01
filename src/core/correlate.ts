/**
 * correlate — cross-schema interval/point-event containment join.
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
 * Requires both schemas to already be in the same trace, on the same clock —
 * see start_recording's `instruments` param to compose them into one
 * recording. Results are grouped by an intervals-schema label column (e.g.
 * view-name) so the output reads as a direct answer ("SidebarView.body
 * contained 445 Feature fetches") instead of a raw per-interval dump the
 * agent has to summarize itself.
 */
import { getTable, lastRun as sessionLastRun } from "../engine/session.js";
import { classifyWithHints } from "../engine/roleHints.js";
import { firstWithRole } from "../engine/roleInference.js";
import { matchesFilter } from "./tableFilter.js";
import { formatValue } from "./aggregate.js";
import type { WeightUnit } from "../engine/roleInference.js";
import type { NormalizedRow } from "../engine/parseTable.js";

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
  intervalsFilter?: Record<string, string | number>;
  /** Optional equality pre-filter on the events schema, applied before joining. */
  eventsFilter?: Record<string, string | number>;
  /** Max groups to return, heaviest-by-matched-events-first (default 10). */
  topN?: number;
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
  /** Total intervals/events after their respective filters, before joining. */
  totalIntervals: number;
  totalEvents: number;
  totalMatchedEvents: number;
  topN: number;
  /** Total distinct groups found (before topN cap). */
  totalGroups: number;
  groups: CorrelateGroup[];
  unit?: WeightUnit;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rawNumber(row: NormalizedRow, mnemonic: string): number {
  const cell = row[mnemonic];
  if (!cell) return NaN;
  return typeof cell.raw === "number" ? cell.raw : Number(cell.raw);
}

function threadKey(row: NormalizedRow, threadCol: string | null): string | null {
  if (!threadCol) return null;
  return row[threadCol]?.fmt ?? null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function correlate(
  sessionId: string,
  intervalsSchema: string,
  eventsSchema: string,
  opts: CorrelateOptions
): Promise<CorrelateResult> {
  const { groupBy, measure, matchThread = true, intervalsFilter, eventsFilter, topN = 10 } = opts;
  const run = opts.run ?? sessionLastRun(sessionId);

  const [intervalsTable, eventsTable] = await Promise.all([
    getTable(sessionId, run, intervalsSchema),
    getTable(sessionId, run, eventsSchema),
  ]);

  const intervalsClassified = classifyWithHints(intervalsSchema, intervalsTable.cols);
  const eventsClassified = classifyWithHints(eventsSchema, eventsTable.cols);

  const startColumn = firstWithRole(intervalsClassified, "time")?.mnemonic ?? null;
  const durationColumn = firstWithRole(intervalsClassified, "weight")?.mnemonic ?? null;
  const timestampColumn = firstWithRole(eventsClassified, "time")?.mnemonic ?? null;
  const intervalsThreadCol = matchThread ? firstWithRole(intervalsClassified, "thread")?.mnemonic ?? null : null;
  const eventsThreadCol = matchThread ? firstWithRole(eventsClassified, "thread")?.mnemonic ?? null : null;

  if (!startColumn || !durationColumn) {
    throw new Error(
      `correlate: intervals schema "${intervalsSchema}" has no time+weight column pair to form a ` +
      "window — it needs a start-time column and a duration-shaped weight column."
    );
  }
  if (!timestampColumn) {
    throw new Error(`correlate: events schema "${eventsSchema}" has no time column to match against.`);
  }
  if (matchThread && (!intervalsThreadCol || !eventsThreadCol)) {
    throw new Error(
      `correlate: matchThread requires a thread column on both schemas — ` +
      `intervals "${intervalsSchema}" ${intervalsThreadCol ? "has one" : "does not"}, ` +
      `events "${eventsSchema}" ${eventsThreadCol ? "has one" : "does not"}. ` +
      "Pass matchThread: false to correlate on time alone (weaker evidence of causation)."
    );
  }

  const measureClassified = measure ? eventsClassified.find((c) => c.mnemonic === measure) : undefined;
  const unit = measureClassified?.roleInfo.unit;

  // --- Pre-filter ---
  let intervalRows = intervalsTable.rows;
  if (intervalsFilter && Object.keys(intervalsFilter).length > 0) {
    intervalRows = intervalRows.filter((row) => matchesFilter(row, intervalsFilter));
  }
  let eventRows = eventsTable.rows;
  if (eventsFilter && Object.keys(eventsFilter).length > 0) {
    eventRows = eventRows.filter((row) => matchesFilter(row, eventsFilter));
  }

  // Sort events by timestamp once; binary-search each interval's window start,
  // then scan forward only as far as that interval's matches extend.
  const events = eventRows
    .map((row) => ({ row, ts: rawNumber(row, timestampColumn), thread: threadKey(row, eventsThreadCol) }))
    .filter((e) => isFinite(e.ts))
    .sort((a, b) => a.ts - b.ts);
  const eventTimestamps = events.map((e) => e.ts);

  function lowerBound(target: number): number {
    let lo = 0;
    let hi = eventTimestamps.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (eventTimestamps[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  const groups = new Map<
    string,
    { intervalCount: number; intervalsWithMatch: number; matchedEventCount: number; measureSum: number }
  >();
  let totalMatchedEvents = 0;

  for (const row of intervalRows) {
    const groupCell = row[groupBy];
    if (groupCell === null || groupCell === undefined) continue;
    const key = groupCell.fmt;

    const start = rawNumber(row, startColumn);
    const duration = rawNumber(row, durationColumn);
    if (!isFinite(start) || !isFinite(duration)) continue;
    const end = start + duration;
    const intervalThread = threadKey(row, intervalsThreadCol);

    const entry = groups.get(key) ?? { intervalCount: 0, intervalsWithMatch: 0, matchedEventCount: 0, measureSum: 0 };
    entry.intervalCount++;

    let idx = lowerBound(start);
    let matchedHere = 0;
    let measureHere = 0;
    while (idx < events.length && events[idx].ts <= end) {
      const ev = events[idx];
      idx++;
      if (matchThread && ev.thread !== intervalThread) continue;
      matchedHere++;
      if (measure) {
        const mRaw = rawNumber(ev.row, measure);
        if (isFinite(mRaw)) measureHere += mRaw;
      }
    }

    if (matchedHere > 0) entry.intervalsWithMatch++;
    entry.matchedEventCount += matchedHere;
    entry.measureSum += measureHere;
    totalMatchedEvents += matchedHere;
    groups.set(key, entry);
  }

  const totalGroups = groups.size;
  const sortedGroups = Array.from(groups.entries())
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.matchedEventCount - a.matchedEventCount)
    .slice(0, topN);

  const resultGroups: CorrelateGroup[] = sortedGroups.map((g) => ({
    key: g.key,
    intervalCount: g.intervalCount,
    intervalsWithMatch: g.intervalsWithMatch,
    matchedEventCount: g.matchedEventCount,
    ...(measure
      ? { matchedEventValue: g.measureSum, matchedEventValueFmt: formatValue(g.measureSum, unit, "sum") }
      : {}),
  }));

  return {
    intervalsSchema,
    eventsSchema,
    run,
    groupBy,
    measure: measure ?? null,
    matchThread,
    startColumn,
    durationColumn,
    timestampColumn,
    totalIntervals: intervalRows.length,
    totalEvents: events.length,
    totalMatchedEvents,
    topN,
    totalGroups,
    groups: resultGroups,
    ...(measure && unit ? { unit } : {}),
  };
}
