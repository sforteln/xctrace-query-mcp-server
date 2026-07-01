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
 */
import { getTable, lastRun as sessionLastRun } from "../engine/session.js";
import { classifyWithHints, hintFor } from "../engine/roleHints.js";
import { firstWithRole } from "../engine/roleInference.js";
import { matchesTimeRange } from "./tableFilter.js";
import type { NormalizedRow } from "../engine/parseTable.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConditionOp =
  | "eq" | "ne"
  | "gt" | "gte" | "lt" | "lte"
  | "contains" | "not-contains"
  | "regex"
  | "is-null" | "not-null";

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

// ─── Condition evaluation ─────────────────────────────────────────────────────

function testCondition(row: NormalizedRow, cond: Condition, regexCache: Map<string, RegExp>): boolean {
  const { col, op, val } = cond;
  const cell = row[col];

  if (op === "is-null") return cell === null || cell === undefined;
  if (op === "not-null") return cell !== null && cell !== undefined;

  // All other ops require a non-null cell.
  if (cell === null || cell === undefined) return false;

  const fmtStr = cell.fmt;
  const rawVal = cell.raw;
  const rawNum = typeof rawVal === "number" ? rawVal : Number(rawVal);

  switch (op) {
    case "eq":
      if (val === undefined) return false;
      if (typeof val === "number") return rawVal === val || rawNum === val;
      return fmtStr === val || String(rawVal) === val;

    case "ne":
      if (val === undefined) return false;
      if (typeof val === "number") return rawVal !== val && rawNum !== val;
      return fmtStr !== val && String(rawVal) !== val;

    case "gt":
      if (val === undefined) return false;
      return isFinite(rawNum) && rawNum > Number(val);

    case "gte":
      if (val === undefined) return false;
      return isFinite(rawNum) && rawNum >= Number(val);

    case "lt":
      if (val === undefined) return false;
      return isFinite(rawNum) && rawNum < Number(val);

    case "lte":
      if (val === undefined) return false;
      return isFinite(rawNum) && rawNum <= Number(val);

    case "contains":
      if (val === undefined) return false;
      return fmtStr.includes(String(val)) || String(rawVal).includes(String(val));

    case "not-contains":
      if (val === undefined) return false;
      return !fmtStr.includes(String(val)) && !String(rawVal).includes(String(val));

    case "regex": {
      if (val === undefined) return false;
      const pattern = String(val);
      let re = regexCache.get(pattern);
      if (!re) {
        re = new RegExp(pattern, "i");
        regexCache.set(pattern, re);
      }
      return re.test(fmtStr) || re.test(String(rawVal));
    }

    default:
      return false;
  }
}

function matchesAll(row: NormalizedRow, conditions: Condition[], regexCache: Map<string, RegExp>): boolean {
  for (const cond of conditions) {
    if (!testCondition(row, cond, regexCache)) return false;
  }
  return true;
}

// ─── Sort ─────────────────────────────────────────────────────────────────────

function compareByCol(
  a: NormalizedRow,
  b: NormalizedRow,
  by: string,
  dir: "asc" | "desc"
): number {
  const aVal = a[by]?.raw ?? "";
  const bVal = b[by]?.raw ?? "";
  let cmp: number;
  if (typeof aVal === "number" && typeof bVal === "number") {
    cmp = aVal - bVal;
  } else {
    cmp = String(aVal).localeCompare(String(bVal), undefined, { numeric: true });
  }
  return dir === "desc" ? -cmp : cmp;
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

  const table = await getTable(sessionId, run, schema, position);

  const classified = classifyWithHints(schema, table.cols);
  // Pinned primaryTime wins — a schema can have 2+ time-role columns (e.g.
  // InstructionsTable's start + session-start), so falling straight to
  // firstWithRole would only be correct by coincidence of column order.
  const timeColumn = hintFor(schema)?.primaryTime ?? firstWithRole(classified, "time")?.mnemonic ?? null;

  const allMnemonics = table.cols.map((c) => c.mnemonic);
  const columnsShown =
    columns && columns.length > 0
      ? columns.filter((m) => allMnemonics.includes(m))
      : allMnemonics;

  // Pre-compile regex patterns.
  const regexCache = new Map<string, RegExp>();

  // Validate regex patterns early and throw a clear error.
  for (const cond of where) {
    if (cond.op === "regex" && cond.val !== undefined) {
      try {
        new RegExp(String(cond.val), "i");
      } catch {
        throw new Error(`Invalid regex pattern for column "${cond.col}": ${cond.val}`);
      }
    }
  }

  // Filter rows.
  type Indexed = { row: NormalizedRow; tableIndex: number };
  let filtered: Indexed[] = table.rows.map((row, i) => ({ row, tableIndex: i }));

  if (timeRange && timeColumn) {
    filtered = filtered.filter(({ row }) => matchesTimeRange(row, timeColumn, timeRange));
  }

  filtered = filtered.filter(({ row }) => matchesAll(row, where, regexCache));

  // Sort.
  if (sort?.by) {
    const dir = sort.dir ?? "asc";
    filtered = [...filtered].sort((a, b) => compareByCol(a.row, b.row, sort.by, dir));
  }

  const matchCount = filtered.length;
  const page = filtered.slice(offset, offset + limit);

  const rows: FindRow[] = page.map(({ row, tableIndex }, pageIdx) => {
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
    conditions: where,
    matchCount,
    returnedRows: rows.length,
    offset,
    limit,
    hasMore: offset + rows.length < matchCount,
    rows,
    columnsShown,
  };
}
