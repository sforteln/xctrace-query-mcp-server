/**
 * find — generic predicate filter over any table.
 *
 * Returns rows matching ALL supplied conditions (AND semantics). Supports
 * richer predicates than query's simple equality filter: numeric comparisons
 * (gt/gte/lt/lte), substring containment, regex, and null checks.
 *
 * This is the substrate for lens-specific finders. For example:
 *   FM hasError     → [{ col: "error-count",  op: "gt",       val: 0 }]
 *   FM noCitations  → [{ col: "response",      op: "contains", val: "referencedSections\": []" }]
 *   FM needsReform  → [{ col: "response",      op: "contains", val: "needsReformulation\": true" }]
 *   FM slow request → [{ col: "duration",      op: "gt",       val: 5000000000 }]  // >5 s in ns
 *
 * PMT:dusk-floe: conditions compile to SQL WHERE clauses (see sqlHydrate.ts's
 * buildCondition, which mirrors the raw+fmt dual-check semantics the old
 * testCondition used) instead of a JS-array scan; regex runs via a registered
 * SQLite UDF since there's no native REGEXP.
 */
import { getTable, getSchemaMeta, getDb, lastRun as sessionLastRun } from "../engine/session.js";
import { classifyWithHints, hintFor } from "../engine/roleHints.js";
import { firstWithRole } from "../engine/roleInference.js";
import { callCacheKey, getCachedCall, setCachedCall } from "./callCache.js";
import {
  buildCondition,
  buildTimeRangeFilter,
  combineConditions,
  rawCol,
  buildDisplaySelect,
  resolveBacktraceDisplayValues,
  resolveInternedDisplayValues,
  makeFrameLookup,
  makeInternResolver,
  type ConditionOp,
} from "../engine/sqlHydrate.js";
import { buildFieldResolver } from "../engine/fieldRef.js";
import { quoteIdent, ROW_IDX_COLUMN } from "../engine/sqliteStore.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type { ConditionOp };

export interface Condition {
  /** Column mnemonic to test. */
  col: string;
  op: ConditionOp;
  /** Value to compare against. Not needed for is-null/not-null. */
  val?: string | number;
}

export interface FindOptions {
  run?: number;
  /**
   * 1-based instance index — only needed when the schema appears multiple
   * times in this run's TOC. Omitting it on an ambiguous schema throws a
   * structured "ambiguous-schema" error listing the available instances.
   */
  position?: number;
  where: Condition[];
  columns?: string[];
  sort?: { by: string; dir?: "asc" | "desc" };
  limit?: number;
  offset?: number;
  timeRange?: { startNs?: number; endNs?: number };
}

export interface FindRow {
  index: number;
  tableIndex: number;
  cells: Record<string, string | null>;
}

export interface FindResult {
  schema: string;
  run: number;
  /** Conditions that were applied. */
  conditions: Condition[];
  /** Total rows matching all conditions (before limit/offset). */
  matchCount: number;
  returnedRows: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  rows: FindRow[];
  columnsShown: string[];
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function findRows(
  sessionId: string,
  schema: string,
  opts: FindOptions
): Promise<FindResult> {
  const {
    where,
    columns,
    sort,
    offset = 0,
    timeRange,
    position,
  } = opts;
  const limit = Math.min(opts.limit ?? 50, 500);
  const run = opts.run ?? sessionLastRun(sessionId);

  // An exact repeat of this call returns instantly — see callCache.ts's
  // header comment for why this matters beyond simple speedup.
  const cacheKey = callCacheKey("find", run, schema, { position, where, columns, sort, offset, limit, timeRange });
  const cached = getCachedCall<FindResult>(sessionId, cacheKey);
  if (cached) return cached;

  // Column shape only, no row data yet — enough to classify and pick which
  // mnemonics are actually needed (see correlate.ts's matching comment).
  const meta = await getSchemaMeta(sessionId, run, schema, position);

  const classified = classifyWithHints(schema, meta.cols);
  // Pinned primaryTime wins — a schema can have 2+ time-role columns (e.g.
  // InstructionsTable's start + session-start), so falling straight to
  // firstWithRole would only be correct by coincidence of column order.
  const timeColumn = hintFor(schema)?.primaryTime ?? firstWithRole(classified, "time")?.mnemonic ?? null;

  // Validate regex patterns early and throw a clear error — before touching SQL.
  for (const cond of where) {
    if (cond.op === "regex" && cond.val !== undefined) {
      try {
        new RegExp(String(cond.val), "i");
      } catch {
        throw new Error(`Invalid regex pattern for column "${cond.col}": ${cond.val}`);
      }
    }
  }

  // Ensures ingestion happened (a no-op if already cached this session).
  const handle = await getTable(sessionId, run, schema, position);
  const db = await getDb(sessionId);
  const table = quoteIdent(handle.tableName);

  // Dot-path field resolution (PMT:bare-shoal), built after getTable. A
  // condition's col / sort.by / a display column may be a nested dot-path
  // (thread.process.pid); resolveComparable also rejects backtrace columns
  // with a clear error (was assertNotBacktraceMnemonic).
  const resolver = buildFieldResolver(db, handle.tableName, meta.cols);
  const columnsShown =
    columns && columns.length > 0
      ? columns.filter((c) => resolver.tryResolve(c) !== null)
      : meta.cols.map((c) => c.mnemonic);

  // --- Build WHERE (each condition's col resolved to its physical base) ---
  const conditions = where.map((c) =>
    buildCondition(resolver.resolveComparable(c.col, "filter on").base, c.op, c.val)
  );
  const sortBase = sort?.by ? resolver.resolveComparable(sort.by, "sort by").base : undefined;
  if (timeRange && timeColumn) conditions.push(buildTimeRangeFilter(timeColumn, timeRange));
  const combined = combineConditions(conditions);

  const matchCount = (
    db.prepare(`SELECT COUNT(*) as n FROM ${table} WHERE ${combined.clause}`).get(...combined.params) as {
      n: number;
    }
  ).n;

  const displayFields = columnsShown.map((ref) => {
    const f = resolver.resolve(ref);
    return { ref, base: f.base, isBacktrace: f.isBacktrace };
  });
  const displayPlan = buildDisplaySelect(displayFields);
  const selectCols = [quoteIdent(ROW_IDX_COLUMN), ...displayPlan.selectCols];

  let orderBy = `ORDER BY ${quoteIdent(ROW_IDX_COLUMN)} ASC`;
  if (sortBase) {
    const dir = (sort!.dir ?? "asc").toUpperCase();
    // See query.ts's matching comment — known minor divergence from the old
    // natural-sort comparator for TEXT columns with embedded digits.
    orderBy = `ORDER BY ${quoteIdent(rawCol(sortBase))} ${dir}`;
  }

  const pageStmt = db.prepare(
    `SELECT ${selectCols.join(", ")} FROM ${table} WHERE ${combined.clause} ${orderBy} LIMIT ? OFFSET ?`
  );
  let sqlRows = pageStmt.all(...combined.params, limit, offset) as Record<string, unknown>[];
  if (displayPlan.backtraceMnemonics.length > 0) {
    sqlRows = resolveBacktraceDisplayValues(sqlRows, displayPlan.backtraceMnemonics, makeFrameLookup(db));
  }
  sqlRows = resolveInternedDisplayValues(sqlRows, columnsShown, makeInternResolver(db));

  const rows: FindRow[] = sqlRows.map((sqlRow, pageIdx) => {
    const cells: Record<string, string | null> = {};
    for (const mnemonic of columnsShown) {
      cells[mnemonic] = (sqlRow[`__out_${mnemonic}`] as string | null) ?? null;
    }
    return {
      index: offset + pageIdx,
      tableIndex: sqlRow[ROW_IDX_COLUMN] as number,
      cells,
    };
  });

  const result: FindResult = {
    schema,
    run,
    conditions: where,
    matchCount,
    returnedRows: rows.length,
    offset,
    limit,
    hasMore: offset + rows.length < matchCount,
    rows,
    columnsShown,
  };

  setCachedCall(sessionId, cacheKey, result);
  return result;
}
