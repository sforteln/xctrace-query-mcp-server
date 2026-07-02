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
 *
 * Fetches via session.ts's getSchemaMeta (column shape only, to classify
 * which mnemonics matter) + getProjectedTable (only those mnemonics, plus
 * `timeRange` narrowing DURING the parse) instead of a full getTable() —
 * this is what makes correlate() safe on a huge intervals schema like
 * swiftui-updates (364K+ rows, many unbounded columns this never touches).
 * See PMT:still-wisp/PMT:rose-loch. Trade-off: this is TWO xctrace export
 * passes per schema (meta then projected) instead of one, so a call on a
 * genuinely heavy schema is slower in wall-clock time than the old
 * single-pass-but-unsafe approach — accepted, since the OOM this replaces
 * is strictly worse than being slow.
 */
import { getSchemaMeta, getProjectedTable, lastRun as sessionLastRun } from "../engine/session.js";
import { classifyWithHints, hintFor } from "../engine/roleHints.js";
import { firstWithRole, preferredThreadColumn } from "../engine/roleInference.js";
import { matchesFilter } from "./tableFilter.js";
import { formatValue } from "./aggregate.js";
import type { WeightUnit, ClassifiedColumn } from "../engine/roleInference.js";
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
  /**
   * Restrict both schemas to a time window BEFORE full materialization —
   * real streaming narrowing (discarded during the parse), not a post-hoc
   * filter on already-fetched rows. Applied to each schema's own primary
   * time column (intervals: startColumn: events: timestampColumn), same
   * convention as query/aggregate/call_tree's timeRange. See PMT:rose-loch.
   */
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
  /**
   * Present only when matchThread found zero matches despite non-empty
   * intervals/events. Usually means the two schemas' thread identity
   * strings genuinely don't align for this data — but double-check
   * intervalsThreadColumn/eventsThreadColumn first: a schema carrying both
   * a process column and a specific-thread column (e.g. swiftui-update-
   * groups has both) could still resolve to the wrong one if a future
   * schema's column order doesn't match either preferred mnemonic
   * ("thread"/"tid"). Suggests retrying with matchThread:false before
   * concluding there's genuinely no temporal overlap.
   */
  threadMismatchWarning?: string;
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

/**
 * The interval duration column must be nanoseconds-shaped — it gets added to
 * `start` to form `end`. A pinned primaryWeight isn't automatically safe here:
 * some schemas pin a non-duration measure (e.g. SwiftActorQueueSize's
 * primaryWeight is "count", a queue depth — adding that to a timestamp would
 * be nonsense), so verify the pinned column's unit before trusting it, and
 * otherwise search weight-role columns specifically for a nanoseconds one
 * rather than firstWithRole's plain column-order pick.
 */
function preferredDurationColumn(classified: ClassifiedColumn[], primaryWeight: string | undefined): string | null {
  if (primaryWeight) {
    const pinned = classified.find((c) => c.mnemonic === primaryWeight);
    if (pinned?.roleInfo.role === "weight" && pinned.roleInfo.unit === "nanoseconds") return pinned.mnemonic;
  }
  const nsWeight = classified.find((c) => c.roleInfo.role === "weight" && c.roleInfo.unit === "nanoseconds");
  if (nsWeight) return nsWeight.mnemonic;
  return firstWithRole(classified, "weight")?.mnemonic ?? null;
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

  // Column shape only, no row data — enough to classify and pick mnemonics
  // (this is the whole point: know WHICH columns are needed before paying
  // for a full or even a projected fetch). See PMT:still-wisp.
  const [intervalsMeta, eventsMeta] = await Promise.all([
    getSchemaMeta(sessionId, run, intervalsSchema),
    getSchemaMeta(sessionId, run, eventsSchema),
  ]);

  const intervalsClassified = classifyWithHints(intervalsSchema, intervalsMeta.cols);
  const eventsClassified = classifyWithHints(eventsSchema, eventsMeta.cols);

  // Pinned primaryTime/primaryWeight win where they apply — see find.ts's
  // matching comment for why firstWithRole alone isn't safe when 2+ columns
  // share a role.
  const startColumn = hintFor(intervalsSchema)?.primaryTime ?? firstWithRole(intervalsClassified, "time")?.mnemonic ?? null;
  const durationColumn = preferredDurationColumn(intervalsClassified, hintFor(intervalsSchema)?.primaryWeight);
  const timestampColumn = hintFor(eventsSchema)?.primaryTime ?? firstWithRole(eventsClassified, "time")?.mnemonic ?? null;
  const intervalsThreadCol = matchThread ? preferredThreadColumn(intervalsClassified)?.mnemonic ?? null : null;
  const eventsThreadCol = matchThread ? preferredThreadColumn(eventsClassified)?.mnemonic ?? null : null;

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

  // --- Projected, time-windowed fetch (discards unwanted columns and
  // out-of-range rows during the parse — see PMT:still-wisp/PMT:rose-loch).
  // Filter columns MUST be included or matchesFilter would see every
  // filtered row as non-matching (an absent cell reads as "doesn't match").
  const intervalsWanted = new Set([
    groupBy,
    startColumn,
    durationColumn,
    ...(intervalsThreadCol ? [intervalsThreadCol] : []),
    ...Object.keys(intervalsFilter ?? {}),
  ]);
  const eventsWanted = new Set([
    timestampColumn,
    ...(measure ? [measure] : []),
    ...(eventsThreadCol ? [eventsThreadCol] : []),
    ...Object.keys(eventsFilter ?? {}),
  ]);

  const [intervalsTable, eventsTable] = await Promise.all([
    getProjectedTable(sessionId, run, intervalsSchema, intervalsWanted, startColumn, timeRange),
    getProjectedTable(sessionId, run, eventsSchema, eventsWanted, timestampColumn, timeRange),
  ]);

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
  // Tracked independent of matchThread so we can tell "genuinely no temporal
  // overlap" apart from "overlap exists but thread identities didn't match".
  let temporalCandidates = 0;

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
      temporalCandidates++;
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

  const threadMismatchWarning =
    matchThread && totalMatchedEvents === 0 && temporalCandidates > 0
      ? `${temporalCandidates} event(s) fall within an interval's time window but were excluded because their ` +
        `thread identity ("${intervalsThreadCol}" vs "${eventsThreadCol}") didn't match. Check these are the ` +
        "columns you expect (a schema with both a process and a thread column can resolve to either) — " +
        "then retry with matchThread:false if they genuinely differ before concluding there's no causation."
      : undefined;

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
    intervalsThreadColumn: intervalsThreadCol,
    eventsThreadColumn: eventsThreadCol,
    totalIntervals: intervalRows.length,
    totalEvents: events.length,
    totalMatchedEvents,
    topN,
    totalGroups,
    groups: resultGroups,
    ...(measure && unit ? { unit } : {}),
    ...(threadMismatchWarning ? { threadMismatchWarning } : {}),
  };
}
