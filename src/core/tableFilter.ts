/**
 * Shared row-filtering and comparison helpers used by query and aggregate.
 */
import type { NormalizedRow } from "../engine/parseTable.js";

/** Simple equality filter: every entry in `filter` must match the row. */
export function matchesFilter(
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

/** Restrict to rows whose primary time column falls within [startNs, endNs]. */
export function matchesTimeRange(
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

/** Sort comparator: numeric-aware, supports asc/desc. */
export function compareRows(
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
