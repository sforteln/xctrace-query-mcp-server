/**
 * relate — the generic cross-schema join operator (PMT:ruddy-stork).
 *
 * Two orthogonal knobs (scratchpad entry 039.B's 2×2) collapse four distinct
 * profiling questions into one operator instead of one tool each:
 *
 *   join CONDITION | polarity EXISTS (has a match)   | polarity NOT-EXISTS (no match)
 *   ---------------+--------------------------------+-------------------------------
 *   equality       | alloc that WAS freed           | LEAK — alloc never freed
 *   time-range     | CAUSALITY (interval ⊃ event)   | idle / GPU-bound window
 *
 * correlate() (see correlate.ts) is the {time-range, exists} corner exposed as
 * a friendly preset; the Leaks lens's address-join is {equality, not-exists}.
 *
 * A = the "left" schema whose rows are classified as matched / unmatched.
 * B = the "right" schema searched for matches. The result groups A rows by an
 * A label column and, per group, reports how many A rows matched / didn't,
 * the total match multiplicity, and a measure sum — plus an optional
 * drill-down that returns the actual matched (exists) or unmatched
 * (not-exists) A rows (progressive disclosure, not a count-only dead end).
 *
 * Runs as SQL against PMT:gravel-cape's ingested tables (getTable ensures both
 * are ingested + role-indexed), NOT a JS-array parse — the time-range corners
 * are RANGE joins whose speed depends entirely on the time column being indexed
 * (dusk-floe's indexRoleColumns does this at ingest); see ruddy-stork's 039.C caution.
 */
import { getTable, getSchemaMeta, getDb, lastRun as sessionLastRun } from "../engine/session.js";
import { classifyWithHints, hintFor } from "../engine/roleHints.js";
import { firstWithRole, preferredThreadColumn } from "../engine/roleInference.js";
import { formatValue } from "./aggregate.js";
import { combineConditions, fmtCol, rawCol, resolveInternedDisplayValues, makeInternResolver, type SqlCondition } from "../engine/sqlHydrate.js";
import { quoteIdent, ROW_IDX_COLUMN } from "../engine/sqliteStore.js";
import type { WeightUnit, ClassifiedColumn } from "../engine/roleInference.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type JoinCondition = "time-range" | "equality";
export type Polarity = "exists" | "not-exists";

export interface RelateOptions {
  run?: number;
  joinCondition: JoinCondition;
  polarity: Polarity;
  /** equality only: the A↔B column pairs to match on (AND semantics), e.g. [{a:"address", b:"address"}]. */
  on?: Array<{ a: string; b: string }>;
  /** time-range only: also require the matched B row to be on the same thread as A (default true for time-range, ignored for equality). */
  matchThread?: boolean;
  /** Mnemonic of an A label column to group results by. */
  groupBy: string;
  /**
   * A measure column to sum. For exists: on B, summed over matched pairs
   * (e.g. total matched-event duration). For not-exists: on A, summed over
   * the UNMATCHED A rows (e.g. total leaked bytes).
   */
  measure?: string;
  /** Equality pre-filter on A, applied before joining. */
  aFilter?: Record<string, string | number>;
  /** Equality pre-filter on B, applied before joining. */
  bFilter?: Record<string, string | number>;
  /** Restrict both schemas to a time window on each's own primary time column. */
  timeRange?: { startNs?: number; endNs?: number };
  /** Max groups to return (default 10). */
  topN?: number;
  /** Also return the actual A rows (matched for exists, unmatched for not-exists) — progressive-disclosure drill-down. */
  listRows?: boolean;
  /** Max A rows to return when listRows is set (default 20, max 200). */
  listLimit?: number;
}

export interface RelateGroup {
  key: string;
  /** All A rows in this group (after aFilter/timeRange), matched or not. */
  aCount: number;
  /** A rows with ≥1 match (thread-matched, for time-range with matchThread). */
  aMatched: number;
  /** A rows with 0 matches. */
  aUnmatched: number;
  /** Total (A,B) matched pairs across the group (match multiplicity). */
  matchCount: number;
  /** Sum of `measure`: over matched B (exists) or over unmatched A (not-exists). */
  measureSum?: number;
  measureSumFmt?: string;
}

export interface RelateRow {
  /** A row's stable table index — pass to get_row on schemaA for full detail. */
  tableIndex: number;
  /** fmt display values for the A columns relevant to the relation. */
  cells: Record<string, string | null>;
}

export interface RelateResult {
  schemaA: string;
  schemaB: string;
  run: number;
  joinCondition: JoinCondition;
  polarity: Polarity;
  groupBy: string;
  measure: string | null;
  /** The columns actually used to form the join, surfaced for sanity-checking. */
  joinColumns: {
    aStart?: string; aDuration?: string; bTimestamp?: string;
    equalityPairs?: Array<{ a: string; b: string }>;
    aThread?: string | null; bThread?: string | null;
  };
  matchThread: boolean;
  totalA: number;
  totalB: number;
  totalMatches: number;
  topN: number;
  totalGroups: number;
  groups: RelateGroup[];
  unit?: WeightUnit;
  /** Present only with listRows: the actual matched (exists) / unmatched (not-exists) A rows. */
  rows?: RelateRow[];
  /**
   * Present only when matchThread found zero matches despite in-window
   * temporal candidates existing — the two schemas' thread identity strings
   * likely don't align; retry matchThread:false before concluding no relation.
   */
  threadMismatchWarning?: string;
}

// ─── Column resolution ──────────────────────────────────────────────────────────

/**
 * Duration column must be nanoseconds-shaped (added to start to form end) —
 * see correlate.ts's original note. Exported for PMT:coral-cliff's timeline(),
 * which resolves duration the same way (a schema's dur is only meaningful as
 * a genuine time span, not an arbitrary weight unit like bytes).
 */
export function preferredDurationColumn(classified: ClassifiedColumn[], primaryWeight: string | undefined): string | null {
  if (primaryWeight) {
    const pinned = classified.find((c) => c.mnemonic === primaryWeight);
    if (pinned?.roleInfo.role === "weight" && pinned.roleInfo.unit === "nanoseconds") return pinned.mnemonic;
  }
  const nsWeight = classified.find((c) => c.roleInfo.role === "weight" && c.roleInfo.unit === "nanoseconds");
  if (nsWeight) return nsWeight.mnemonic;
  return firstWithRole(classified, "weight")?.mnemonic ?? null;
}

/** Exported for PMT:coral-cliff's timeline(), which resolves each merged schema's time column the same way. */
export function primaryTime(schema: string, classified: ClassifiedColumn[]): string | null {
  return hintFor(schema)?.primaryTime ?? firstWithRole(classified, "time")?.mnemonic ?? null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function relate(
  sessionId: string,
  schemaA: string,
  schemaB: string,
  opts: RelateOptions
): Promise<RelateResult> {
  const {
    joinCondition, polarity, on, groupBy, measure,
    aFilter, bFilter, timeRange, topN = 10,
    listRows = false,
  } = opts;
  const matchThread = joinCondition === "time-range" ? (opts.matchThread ?? true) : false;
  const listLimit = Math.min(opts.listLimit ?? 20, 200);
  const run = opts.run ?? sessionLastRun(sessionId);

  const [metaA, metaB] = await Promise.all([
    getSchemaMeta(sessionId, run, schemaA),
    getSchemaMeta(sessionId, run, schemaB),
  ]);
  const classA = classifyWithHints(schemaA, metaA.cols);
  const classB = classifyWithHints(schemaB, metaB.cols);

  // Resolve join columns per condition.
  let aStart: string | null = null, aDuration: string | null = null, bTimestamp: string | null = null;
  let equalityPairs: Array<{ a: string; b: string }> | undefined;
  const aThread = matchThread ? preferredThreadColumn(classA)?.mnemonic ?? null : null;
  const bThread = matchThread ? preferredThreadColumn(classB)?.mnemonic ?? null : null;

  if (joinCondition === "time-range") {
    aStart = primaryTime(schemaA, classA);
    aDuration = preferredDurationColumn(classA, hintFor(schemaA)?.primaryWeight);
    bTimestamp = primaryTime(schemaB, classB);
    if (!aStart || !aDuration) {
      throw new Error(
        `relate (time-range): schema A "${schemaA}" needs a start-time column and a duration-shaped ` +
        "weight column to form the [start, start+duration] window."
      );
    }
    if (!bTimestamp) throw new Error(`relate (time-range): schema B "${schemaB}" has no time column to test for containment.`);
    if (matchThread && (!aThread || !bThread)) {
      throw new Error(
        `relate (time-range): matchThread requires a thread column on both schemas — A ${aThread ? "has one" : "does not"}, ` +
        `B ${bThread ? "has one" : "does not"}. Pass matchThread:false to relate on time alone.`
      );
    }
  } else {
    if (!on || on.length === 0) {
      throw new Error('relate (equality): the `on` param is required — the A↔B column pairs to match, e.g. [{a:"address", b:"address"}].');
    }
    equalityPairs = on;
  }

  const measureClass = measure
    ? (polarity === "exists" ? classB : classA).find((c) => c.mnemonic === measure)
    : undefined;
  const unit = measureClass?.roleInfo.unit;

  // Ensure both tables are ingested + indexed, then read via SQL.
  const [handleA, handleB] = await Promise.all([
    getTable(sessionId, run, schemaA),
    getTable(sessionId, run, schemaB),
  ]);
  const db = await getDb(sessionId);
  const A = quoteIdent(handleA.tableName);
  const B = quoteIdent(handleB.tableName);

  // A-side WHERE (aFilter + A timeRange on A's own time column).
  const aTimeCol = primaryTime(schemaA, classA);
  const aConds: SqlCondition[] = [{ clause: `A.${quoteIdent(fmtCol(groupBy))} IS NOT NULL`, params: [] }];
  if (aFilter && Object.keys(aFilter).length > 0) aConds.push(aliasedEqualityFilter("A", aFilter));
  if (timeRange && aTimeCol) aConds.push(timeRangeOn("A", aTimeCol, timeRange));
  const aWhere = combineConditions(aConds);

  // B-side conditions live in the JOIN's ON (a LEFT JOIN must keep unmatched A
  // rows — a bFilter/B-timeRange in WHERE would silently turn it into an INNER).
  const bTimeCol = primaryTime(schemaB, classB);
  const bConds: SqlCondition[] = [];
  if (bFilter && Object.keys(bFilter).length > 0) bConds.push(aliasedEqualityFilter("B", bFilter));
  if (timeRange && bTimeCol) bConds.push(timeRangeOn("B", bTimeCol, timeRange));

  // Core A↔B match predicate (thread match handled separately as a CASE so we
  // can report both with-thread and ignoring-thread counts in ONE pass — that
  // difference is exactly what threadMismatchWarning needs).
  // CRITICAL for the 039.C perf caution: the B-side range column must appear
  // BARE (no CAST wrapping), or SQLite can't use its index for a range SEEK and
  // the join degrades to an O(n×m) covering-index SCAN per A row (confirmed via
  // EXPLAIN QUERY PLAN — CAST(B.time AS REAL) → SCAN; bare B.time → SEARCH).
  // This relies on the time columns being stored numerically, which they now
  // are for BOTH source formats: schema-table time roles carry ns element text
  // (coerceRaw turns all-digit strings into numbers), and track-detail's
  // "MM:SS.mmm.µµµ" timestamp — which used to land here as a string that
  // compared lexically — is parsed to ns at ingest (PMT:light-reed,
  // parseTrackDetail.ts's coerceTrackDetailRaw). The A side is a per-A-row
  // constant (outer loop), so its + arithmetic is fine bare too.
  const coreMatch =
    joinCondition === "time-range"
      ? `B.${quoteIdent(rawCol(bTimestamp!))} BETWEEN A.${quoteIdent(rawCol(aStart!))} ` +
        `AND A.${quoteIdent(rawCol(aStart!))} + A.${quoteIdent(rawCol(aDuration!))}`
      : equalityPairs!.map((p) => `A.${quoteIdent(fmtCol(p.a))} = B.${quoteIdent(fmtCol(p.b))}`).join(" AND ");

  const onConds = combineConditions([{ clause: coreMatch, params: [] }, ...bConds]);

  // The thread-match CASE: a real thread-matched pair. When matchThread is off,
  // "matched" is just "has a B row".
  const bHasRow = `B.${quoteIdent(ROW_IDX_COLUMN)} IS NOT NULL`;
  const threadMatch = matchThread
    ? `(${bHasRow} AND A.${quoteIdent(fmtCol(aThread!))} = B.${quoteIdent(fmtCol(bThread!))})`
    : bHasRow;

  const bMeasureExpr = polarity === "exists" && measure ? `CAST(B.${quoteIdent(rawCol(measure))} AS REAL)` : "0";

  const aggSql =
    `SELECT A.${quoteIdent(fmtCol(groupBy))} AS gkey, ` +
    `COUNT(DISTINCT A.${quoteIdent(ROW_IDX_COLUMN)}) AS aCount, ` +
    `COUNT(B.${quoteIdent(ROW_IDX_COLUMN)}) AS matchAnyThread, ` +
    `SUM(CASE WHEN ${threadMatch} THEN 1 ELSE 0 END) AS matchCount, ` +
    `COUNT(DISTINCT CASE WHEN ${threadMatch} THEN A.${quoteIdent(ROW_IDX_COLUMN)} END) AS aMatched, ` +
    `SUM(CASE WHEN ${threadMatch} THEN ${bMeasureExpr} ELSE 0 END) AS bMeasureSum ` +
    `FROM ${A} A LEFT JOIN ${B} B ON ${onConds.clause} ` +
    `WHERE ${aWhere.clause} GROUP BY gkey`;

  const aggRows = db.prepare(aggSql).all(...onConds.params, ...aWhere.params) as Array<{
    gkey: string; aCount: number; matchAnyThread: number; matchCount: number; aMatched: number; bMeasureSum: number;
  }>;

  // not-exists measure is on A (leaked bytes = sum of measure over UNMATCHED A) —
  // a dedicated anti-join aggregate (the LEFT JOIN duplicates matched A rows, so
  // A-side sums can't be read off it directly; but unmatched A rows are safe).
  let aMeasureByKey: Map<string, number> | null = null;
  if (polarity === "not-exists" && measure) {
    const notExistsSub =
      `NOT EXISTS (SELECT 1 FROM ${B} B WHERE ${onConds.clause}` +
      (matchThread ? ` AND A.${quoteIdent(fmtCol(aThread!))} = B.${quoteIdent(fmtCol(bThread!))}` : "") + `)`;
    const antiSql =
      `SELECT A.${quoteIdent(fmtCol(groupBy))} AS gkey, SUM(CAST(A.${quoteIdent(rawCol(measure))} AS REAL)) AS aMeasureSum ` +
      `FROM ${A} A WHERE ${aWhere.clause} AND ${notExistsSub} GROUP BY gkey`;
    const antiRows = db.prepare(antiSql).all(...aWhere.params, ...onConds.params) as Array<{ gkey: string; aMeasureSum: number }>;
    aMeasureByKey = new Map(antiRows.map((r) => [r.gkey, Number(r.aMeasureSum ?? 0)]));
  }

  // Global totals. bConds are already aliased to B (used verbatim in the join ON),
  // so they apply directly here for the standalone B count.
  const totalA = (db.prepare(`SELECT COUNT(*) AS n FROM ${A} A WHERE ${aWhere.clause}`).get(...aWhere.params) as { n: number }).n;
  const bTotalConds = combineConditions(bConds);
  const totalB = (db.prepare(`SELECT COUNT(*) AS n FROM ${B} B WHERE ${bTotalConds.clause}`).get(...bTotalConds.params) as { n: number }).n;

  let totalMatches = 0;
  let totalMatchAnyThread = 0;
  const groups: RelateGroup[] = aggRows.map((r) => {
    const aUnmatched = r.aCount - r.aMatched;
    totalMatches += r.matchCount;
    totalMatchAnyThread += r.matchAnyThread;
    const measureSum =
      polarity === "exists" && measure ? r.bMeasureSum
      : polarity === "not-exists" && measure ? (aMeasureByKey?.get(r.gkey) ?? 0)
      : undefined;
    return {
      key: r.gkey,
      aCount: r.aCount,
      aMatched: r.aMatched,
      aUnmatched,
      matchCount: r.matchCount,
      ...(measureSum !== undefined
        ? { measureSum, measureSumFmt: formatValue(measureSum, unit, "sum") }
        : {}),
    };
  });

  const totalGroups = groups.length;
  // Sort by the polarity's headline number: exists → most matches; not-exists → most unmatched.
  const sortKey = (g: RelateGroup) => (polarity === "exists" ? g.matchCount : g.aUnmatched);
  const sortedGroups = groups.sort((a, b) => sortKey(b) - sortKey(a)).slice(0, topN);

  // Optional row-listing drill-down: the actual matched / unmatched A rows.
  let rows: RelateRow[] | undefined;
  if (listRows) {
    const cellCols = [groupBy, ...(aStart ? [aStart] : []), ...(aDuration ? [aDuration] : []),
      ...(aThread ? [aThread] : []), ...(equalityPairs?.map((p) => p.a) ?? []), ...(measure && polarity === "not-exists" ? [measure] : [])];
    const uniqueCols = Array.from(new Set(cellCols));
    const selects = uniqueCols.map((m) => `A.${quoteIdent(fmtCol(m))} AS ${quoteIdent(`__out_${m}`)}`);
    const hasMatchSub =
      `EXISTS (SELECT 1 FROM ${B} B WHERE ${onConds.clause}` +
      (matchThread ? ` AND A.${quoteIdent(fmtCol(aThread!))} = B.${quoteIdent(fmtCol(bThread!))}` : "") + `)`;
    const wantClause = polarity === "exists" ? hasMatchSub : `NOT ${hasMatchSub}`;
    const listSql =
      `SELECT A.${quoteIdent(ROW_IDX_COLUMN)} AS ridx, ${selects.join(", ")} ` +
      `FROM ${A} A WHERE ${aWhere.clause} AND ${wantClause} ` +
      `ORDER BY A.${quoteIdent(ROW_IDX_COLUMN)} ASC LIMIT ?`;
    let listed = db.prepare(listSql).all(...aWhere.params, ...onConds.params, listLimit) as Record<string, unknown>[];
    listed = resolveInternedDisplayValues(listed, uniqueCols, makeInternResolver(db));
    rows = listed.map((r) => {
      const cells: Record<string, string | null> = {};
      for (const m of uniqueCols) cells[m] = (r[`__out_${m}`] as string | null) ?? null;
      return { tableIndex: r.ridx as number, cells };
    });
  }

  const threadMismatchWarning =
    matchThread && totalMatches === 0 && totalMatchAnyThread > 0
      ? `${totalMatchAnyThread} B row(s) fall within an A window but were excluded because their thread ` +
        `identity ("${aThread}" vs "${bThread}") didn't match. Verify these are the columns you expect, ` +
        "then retry matchThread:false if they genuinely differ before concluding there's no relation."
      : undefined;

  return {
    schemaA, schemaB, run, joinCondition, polarity, groupBy,
    measure: measure ?? null,
    joinColumns: {
      ...(joinCondition === "time-range" ? { aStart: aStart!, aDuration: aDuration!, bTimestamp: bTimestamp! } : { equalityPairs }),
      aThread, bThread,
    },
    matchThread,
    totalA, totalB, totalMatches,
    topN, totalGroups,
    groups: sortedGroups,
    ...(measure && unit ? { unit } : {}),
    ...(rows ? { rows } : {}),
    ...(threadMismatchWarning ? { threadMismatchWarning } : {}),
  };
}

// ─── SQL helpers ────────────────────────────────────────────────────────────────

/**
 * Alias-aware equality filter — mirrors sqlHydrate's buildEqualityFilter
 * exactly (same raw+fmt dual-check + numeric coercion), but emits
 * `A."col" = ?` for a two-table join where a bare `"col"` would be ambiguous.
 */
function aliasedEqualityFilter(alias: string, filter: Record<string, string | number>): SqlCondition {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  for (const [mnemonic, expected] of Object.entries(filter)) {
    const raw = `${alias}.${quoteIdent(rawCol(mnemonic))}`;
    const fmt = `${alias}.${quoteIdent(fmtCol(mnemonic))}`;
    if (typeof expected === "number") {
      clauses.push(`(${raw} = ? OR CAST(${raw} AS TEXT) = ?)`);
      params.push(expected, String(expected));
    } else {
      clauses.push(`(${fmt} = ? OR CAST(${raw} AS TEXT) = ?)`);
      params.push(expected, expected);
    }
  }
  return { clause: clauses.join(" AND "), params };
}

function timeRangeOn(alias: string, timeCol: string, tr: { startNs?: number; endNs?: number }): SqlCondition {
  const clauses: string[] = [];
  const params: number[] = [];
  const raw = `${alias}.${quoteIdent(rawCol(timeCol))}`;
  if (tr.startNs !== undefined) { clauses.push(`CAST(${raw} AS REAL) >= ?`); params.push(tr.startNs); }
  if (tr.endNs !== undefined) { clauses.push(`CAST(${raw} AS REAL) <= ?`); params.push(tr.endNs); }
  return { clause: clauses.length ? clauses.join(" AND ") : "1", params };
}
