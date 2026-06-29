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
import type { NormalizedRow } from "../engine/parseTable.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 500;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QueryOptions {
  run?: number;
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

// ─── Filter helpers ───────────────────────────────────────────────────────────

function matchesFilter(
  row: NormalizedRow,
  filter: Record<string, string | number>
): boolean {
  for (const [mnemonic, expected] of Object.entries(filter)) {
    const cell = row[mnemonic];
    if (cell === null || cell === undefined) return false;
    if (typeof expected === "number") {
      if (cell.raw !== expected && Number(cell.raw) !== expected) return false;
    } else {
      if (cell.fmt !== expected && String(cell.raw) !== expected) return false;
    }
  }
  return true;
}

function matchesTimeRange(
  row: NormalizedRow,
  timeCol: string,
  range: { startNs?: number; endNs?: number }
): boolean {
  const cell = row[timeCol];
  if (!cell) return false;
  const ns = typeof cell.raw === "number" ? cell.raw : Number(cell.raw);
  if (!isFinite(ns)) return false;
  if (range.startNs !== undefined && ns < range.startNs) return false;
  if (range.endNs !== undefined && ns > range.endNs) return false;
  return true;
}

function compareRows(
  a: NormalizedRow,
  b: NormalizedRow,
  by: string,
  dir: "asc" | "desc"
): number {
  const aCell = a[by];
  const bCell = b[by];
  const aVal = aCell?.raw ?? "";
  const bVal = bCell?.raw ?? "";
  let cmp: number;
  if (typeof aVal === "number" && typeof bVal === "number") {
    cmp = aVal - bVal;
  } else {
    cmp = String(aVal).localeCompare(String(bVal), undefined, { numeric: true });
  }
  return dir === "desc" ? -cmp : cmp;
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
  } = opts;

  const limit = Math.min(rawLimit ?? DEFAULT_LIMIT, MAX_LIMIT);

  // Resolve run — default to last run when omitted.
  const run = opts.run ?? sessionLastRun(sessionId);

  // Fetch (or hit cache for) the parsed table.
  const table = await getTable(sessionId, run, schema);

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

  // --- Filter ---
  let filtered = table.rows;

  if (filter && Object.keys(filter).length > 0) {
    filtered = filtered.filter((row) => matchesFilter(row, filter));
  }

  if (timeRange && timeColumn) {
    filtered = filtered.filter((row) =>
      matchesTimeRange(row, timeColumn, timeRange)
    );
  }

  // --- Sort ---
  if (sort?.by) {
    const dir = sort.dir ?? "asc";
    filtered = [...filtered].sort((a, b) => compareRows(a, b, sort.by, dir));
  }

  const totalRows = filtered.length;
  const page = filtered.slice(offset, offset + limit);

  // --- Project to summary rows ---
  const rows: QueryRow[] = page.map((row, pageIdx) => {
    const cells: Record<string, string | null> = {};
    for (const mnemonic of columnsShown) {
      const cell = row[mnemonic];
      cells[mnemonic] = cell === null || cell === undefined ? null : cell.fmt;
    }
    return { index: offset + pageIdx, cells };
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
