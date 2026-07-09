/**
 * query — generic filtered/sorted/paginated row fetch.
 *
 * Returns summary rows (mnemonic → fmt display value) from any schema-table.
 * Full row detail (raw values, resolved backtraces, compound children) is
 * deferred to getRow. Role awareness lets callers specify a timeRange window
 * without knowing which column carries timestamps.
 *
 * PMT:dusk-floe: runs as SQL against the SQLite table PMT:gravel-cape
 * ingested, instead of a JS-array scan. getTable() always ensures ingestion
 * happened first — SQLite's own WHERE/ORDER BY/LIMIT means there's no longer
 * a reason for the old "projected fetch to avoid materializing everything in
 * JS" optimization the pre-SQLite correlate() relied on.
 */
import { getTable, getSchemaMeta, getDb, lastRun as sessionLastRun } from "../engine/session.js";
import { classifyWithHints, hintFor } from "../engine/roleHints.js";
import { firstWithRole } from "../engine/roleInference.js";
import { callCacheKey, getCachedCall, setCachedCall } from "./callCache.js";
import {
  buildEqualityFilter,
  buildTimeRangeFilter,
  combineConditions,
  rawCol,
  buildDisplaySelect,
  resolveBacktraceDisplayValues,
  resolveInternedDisplayValues,
  makeInternTargetResolver,
  makeFrameLookup,
  makeInternResolver,
  buildWindowExpr,
  type WindowSpec,
} from "../engine/sqlHydrate.js";
import { buildFieldResolver } from "../engine/fieldRef.js";
import { quoteIdent, ROW_IDX_COLUMN } from "../engine/sqliteStore.js";
import { emptyResultNote } from "./emptyResultNote.js";
import { sanitizeCellText } from "./getRow.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 500;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QueryOptions {
  run?: number;
  /**
   * 1-based instance index — only needed when the schema appears multiple
   * times in this run's TOC. Omitting it on an ambiguous schema throws a
   * structured "ambiguous-schema" error listing the available instances.
   */
  position?: number;
  /** Simple equality filter: mnemonic → expected fmt or raw value. */
  filter?: Record<string, string | number>;
  /** Column mnemonics to include in output. Omit to include all columns. */
  columns?: string[];
  /** Restrict to rows whose primary time column falls within [startNs, endNs]. */
  timeRange?: { startNs?: number; endNs?: number };
  /** Sort rows by a column's raw value. */
  sort?: { by: string; dir?: "asc" | "desc" };
  /** Max rows to return (default 20, max 500). */
  limit?: number;
  /** Rows to skip before returning (for pagination). */
  offset?: number;
  /**
   * Compute a window function value per row (running total, inter-arrival
   * delta, rank, or row-number). Added as each row's `window` field. The
   * window is computed over the FULL filtered set (before limit/offset), so
   * a running total is correct across pages. When present and no explicit
   * `sort` is given, rows default to `window.orderBy` ascending so the
   * computed values read naturally down the page.
   */
  window?: WindowSpec;
}

/** One summary row: mnemonic → formatted display value (or null for sentinel). */
export interface QueryRow {
  /** Position in the (post-filter, post-sort) result set, 0-based. */
  index: number;
  /**
   * Position in the raw unfiltered/unsorted table — pass this to get_row as
   * `rowIndex` to retrieve the full cell detail for this row.
   */
  tableIndex: number;
  /** Formatted display values keyed by mnemonic. */
  cells: Record<string, string | null>;
  /** Computed window-function value for this row — present only when the `window` option was supplied. */
  window?: number | null;
}

export interface QueryResult {
  schema: string;
  run: number;
  /** Total rows matching the filter (before limit/offset). */
  totalRows: number;
  /** Rows returned in this page. */
  returnedRows: number;
  offset: number;
  limit: number;
  /** Whether more rows exist beyond this page. */
  hasMore: boolean;
  rows: QueryRow[];
  /** The mnemonics present in each row (respects `columns` projection). */
  columnsShown: string[];
  /** The time column used for timeRange filtering, if any. */
  timeColumn: string | null;
  /** Whether this schema has a backtrace-role column (get_row/call_tree can resolve one). */
  hasBacktrace: boolean;
  /**
   * Present only when totalRows is 0 — distinguishes "your filter/timeRange
   * excluded everything" (the schema has data) from "this schema genuinely
   * has 0 rows" (PMT:thorny-verge).
   */
  note?: string;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function queryTable(
  sessionId: string,
  schema: string,
  opts: QueryOptions = {}
): Promise<QueryResult> {
  const {
    filter,
    columns,
    timeRange,
    sort,
    offset = 0,
    limit: rawLimit,
    position,
    window,
  } = opts;

  const limit = Math.min(rawLimit ?? DEFAULT_LIMIT, MAX_LIMIT);

  // Resolve run — default to last run when omitted.
  const run = opts.run ?? sessionLastRun(sessionId);

  // An exact repeat of this call (same schema/run/filter/sort/columns/page)
  // returns instantly — see callCache.ts's header comment for why this
  // matters beyond simple speedup (client-side timeouts vs. server-side
  // completion on multi-minute schemas).
  const cacheKey = callCacheKey("query", run, schema, { position, filter, columns, timeRange, sort, offset, limit, window });
  const cached = getCachedCall<QueryResult>(sessionId, cacheKey);
  if (cached) return cached;

  // Column shape only, no row data yet — enough to classify and pick which
  // mnemonics are actually needed before paying for a potentially huge
  // fetch (see correlate.ts's matching comment / PMT:still-wisp).
  const meta = await getSchemaMeta(sessionId, run, schema, position);
  const classified = classifyWithHints(schema, meta.cols);
  const timeColumn = hintFor(schema)?.primaryTime ?? firstWithRole(classified, "time")?.mnemonic ?? null;

  if (window && window.op === "running-total" && !window.measure) {
    throw new Error('window op "running-total" requires a measure column to accumulate.');
  }

  // Ensures ingestion happened (a no-op if already cached this session).
  const handle = await getTable(sessionId, run, schema, position);
  const db = await getDb(sessionId);
  const table = quoteIdent(handle.tableName);

  // Dot-path field resolution (PMT:bare-shoal) — needs the ingested table's
  // promoted-column metadata, so it's built after getTable. A mnemonic or a
  // nested dot-path (thread.process.pid) both resolve here; resolveComparable
  // also rejects backtrace columns with a clear error (was
  // assertNotBacktraceMnemonic — the same guard, now dot-path aware).
  const resolver = buildFieldResolver(db, handle.tableName, meta.cols);

  // Determine which columns to include in the response — mnemonics by default,
  // or caller-supplied refs (which may be nested dot-paths); unresolvable ones
  // are dropped silently, matching the old allMnemonics.includes filter.
  const columnsShown =
    columns && columns.length > 0
      ? columns.filter((c) => resolver.tryResolve(c) !== null)
      : meta.cols.map((c) => c.mnemonic);

  // --- Build WHERE (filter keys resolved to physical base columns) ---
  const resolvedFilter: Record<string, string | number> = {};
  for (const [ref, val] of Object.entries(filter ?? {})) {
    resolvedFilter[resolver.resolveComparable(ref, "filter on").base] = val;
  }
  const sortBase = sort?.by ? resolver.resolveComparable(sort.by, "sort by").base : undefined;
  const resolvedWindow: WindowSpec | undefined = window
    ? {
        op: window.op,
        orderBy: resolver.resolveComparable(window.orderBy, "window orderBy").base,
        ...(window.partitionBy ? { partitionBy: resolver.resolveComparable(window.partitionBy, "window partitionBy").base } : {}),
        ...(window.measure ? { measure: resolver.resolveComparable(window.measure, "window measure").base } : {}),
      }
    : undefined;

  const conditions = [];
  if (Object.keys(resolvedFilter).length > 0) conditions.push(buildEqualityFilter(resolvedFilter, makeInternTargetResolver(db)));
  if (timeRange && timeColumn) conditions.push(buildTimeRangeFilter(timeColumn, timeRange));
  const where = combineConditions(conditions);

  // --- Total count (matching filter, before limit/offset) ---
  const totalRows = (
    db.prepare(`SELECT COUNT(*) as n FROM ${table} WHERE ${where.clause}`).get(...where.params) as { n: number }
  ).n;

  // --- Build the page query ---
  // Select _row_idx (the tableIndex contract get_row relies on) plus each
  // shown column's display value. query only ever needs the display value —
  // full detail is getRow's job. Each column ref is resolved to its physical
  // base so a nested dot-path displays the value at its promoted column.
  const displayFields = columnsShown.map((ref) => {
    const f = resolver.resolve(ref);
    return { ref, base: f.base, isBacktrace: f.isBacktrace };
  });
  const displayPlan = buildDisplaySelect(displayFields);
  const selectCols = [quoteIdent(ROW_IDX_COLUMN), ...displayPlan.selectCols];
  // The window value is computed by SQLite over the FULL filtered set (the
  // OVER clause is evaluated before LIMIT/OFFSET), so a running total stays
  // correct across pages.
  if (resolvedWindow) selectCols.push(`${buildWindowExpr(resolvedWindow)} AS __window`);

  let orderBy = `ORDER BY ${quoteIdent(ROW_IDX_COLUMN)} ASC`;
  if (sortBase) {
    const dir = (sort!.dir ?? "asc").toUpperCase();
    // Sorting on the raw column — SQLite's own type-then-value ordering
    // (NULL < numeric < text) matches JS behavior for homogeneous-type
    // columns (the common case: a column's raw values share one JS type).
    // Known minor divergence from the old JS natural-sort comparator
    // (localeCompare with {numeric:true}) for TEXT columns containing
    // embedded digits (e.g. "item2" vs "item10") — not replicated via a
    // custom collation; flagged rather than silently claimed identical.
    orderBy = `ORDER BY ${quoteIdent(rawCol(sortBase))} ${dir}`;
  } else if (resolvedWindow) {
    // No explicit sort + a window present → display in window order (asc) so
    // the running total / delta / rank reads naturally down the page.
    orderBy = `ORDER BY ${quoteIdent(rawCol(resolvedWindow.orderBy))} ASC`;
  }

  const pageStmt = db.prepare(
    `SELECT ${selectCols.join(", ")} FROM ${table} WHERE ${where.clause} ${orderBy} LIMIT ? OFFSET ?`
  );
  let sqlRows = pageStmt.all(...where.params, limit, offset) as Record<string, unknown>[];
  if (displayPlan.backtraceMnemonics.length > 0) {
    sqlRows = resolveBacktraceDisplayValues(sqlRows, displayPlan.backtraceMnemonics, makeFrameLookup(db));
  }
  // Resolve any interned large display values back to their content (PMT:lime-bluff).
  sqlRows = resolveInternedDisplayValues(sqlRows, columnsShown, makeInternResolver(db));

  const rows: QueryRow[] = sqlRows.map((sqlRow, pageIdx) => {
    const cells: Record<string, string | null> = {};
    for (const mnemonic of columnsShown) {
      const raw = (sqlRow[`__out_${mnemonic}`] as string | null) ?? null;
      // A "summary" cell can still resolve to an unbounded blob (a large
      // interned value, a full prompt/response text field) — verified live
      // (a Foundation Models + SwiftUI retrospective session, 2026-07-09): a
      // 12-row ModelInferenceTable query() returned 163,000 characters,
      // forcing the caller to work around it by saving to a file and reading
      // in chunks. query()'s own contract is "summary rows, full detail via
      // get_row" — cap + redact the same way get_row already does (PMT:loam-
      // merlin), so a caller who genuinely needs the full value reaches for
      // get_row instead of query silently handing back a multi-hundred-KB response.
      cells[mnemonic] = raw !== null ? sanitizeCellText(mnemonic, raw).text : null;
    }
    return {
      index: offset + pageIdx,
      tableIndex: sqlRow[ROW_IDX_COLUMN] as number,
      cells,
      ...(window ? { window: (sqlRow.__window as number | null) ?? null } : {}),
    };
  });

  const result: QueryResult = {
    schema,
    run,
    totalRows,
    returnedRows: rows.length,
    offset,
    limit,
    hasMore: offset + rows.length < totalRows,
    rows,
    columnsShown,
    timeColumn,
    hasBacktrace: classified.some((c) => c.roleInfo.role === "backtrace"),
    ...(totalRows === 0
      ? {
          note: emptyResultNote({
            matchedCount: totalRows,
            unfilteredCount: meta.rowCount,
            filterApplied: Boolean((filter && Object.keys(filter).length > 0) || timeRange),
          }),
        }
      : {}),
  };

  setCachedCall(sessionId, cacheKey, result);
  return result;
}
