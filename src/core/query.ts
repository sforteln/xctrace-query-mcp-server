/**
 * query — generic filtered/sorted/paginated row fetch.
 *
 * Returns summary rows (mnemonic → fmt display value) from any schema-table.
 * Full row detail (raw values, resolved backtraces, compound children) is
 * deferred to getRow. Role awareness lets callers specify a timeRange window
 * without knowing which column carries timestamps.
 */
import { getTable, lastRun as sessionLastRun } from "../engine/session.js";
import { classifyWithHints } from "../engine/roleHints.js";
import { firstWithRole } from "../engine/roleInference.js";
import { matchesFilter, matchesTimeRange, compareRows } from "./tableFilter.js";
import type { NormalizedRow } from "../engine/parseTable.js";

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
  } = opts;

  const limit = Math.min(rawLimit ?? DEFAULT_LIMIT, MAX_LIMIT);

  // Resolve run — default to last run when omitted.
  const run = opts.run ?? sessionLastRun(sessionId);

  // Fetch (or hit cache for) the parsed table.
  const table = await getTable(sessionId, run, schema, position);

  // Find the primary time column for timeRange filtering.
  const classified = classifyWithHints(schema, table.cols);
  const timeColDef = firstWithRole(classified, "time");
  const timeColumn = timeColDef?.mnemonic ?? null;

  // Determine which column mnemonics to include in the response.
  const allMnemonics = table.cols.map((c) => c.mnemonic);
  const columnsShown =
    columns && columns.length > 0
      ? columns.filter((m) => allMnemonics.includes(m))
      : allMnemonics;

  // Track raw table positions through filter + sort so get_row can use them.
  type IndexedRow = { row: NormalizedRow; tableIndex: number };
  let filtered: IndexedRow[] = table.rows.map((row, i) => ({ row, tableIndex: i }));

  // --- Filter ---
  if (filter && Object.keys(filter).length > 0) {
    filtered = filtered.filter(({ row }) => matchesFilter(row, filter));
  }

  if (timeRange && timeColumn) {
    filtered = filtered.filter(({ row }) =>
      matchesTimeRange(row, timeColumn, timeRange)
    );
  }

  // --- Sort ---
  if (sort?.by) {
    const dir = sort.dir ?? "asc";
    filtered = [...filtered].sort((a, b) =>
      compareRows(a.row, b.row, sort.by, dir)
    );
  }

  const totalRows = filtered.length;
  const page = filtered.slice(offset, offset + limit);

  // --- Project to summary rows ---
  const rows: QueryRow[] = page.map(({ row, tableIndex }, pageIdx) => {
    const cells: Record<string, string | null> = {};
    for (const mnemonic of columnsShown) {
      const cell = row[mnemonic];
      cells[mnemonic] = cell === null || cell === undefined ? null : cell.fmt;
    }
    return { index: offset + pageIdx, tableIndex, cells };
  });

  return {
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
  };
}
