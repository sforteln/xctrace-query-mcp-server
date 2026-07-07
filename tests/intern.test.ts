/**
 * PMT:lime-bluff value-interning correctness.
 *
 * xctrace's XML dedups a repeated large value to one id + cheap refs; our
 * parser resolves every ref to the full value, so the writer would otherwise
 * serialize that value into EVERY row that shares it (the 303 MB → ~28 GB
 * swiftui-updates blowup found in PMT:lush-spit). SqliteTableWriter instead
 * interns a value ≥ threshold ONCE (deduped by content hash) and stores a tiny
 * sentinel token per row; reads resolve it back.
 *
 * These tests pin the two things that must not silently rot:
 *   1. Storage: a value shared by N rows produces ONE interned_values row and
 *      sentinel tokens in the cells; small values stay inline.
 *   2. Correctness: content predicates (query filter, find contains/eq/regex)
 *      still match the INTERNED rows — the sentinel is resolved in SQL, not
 *      compared literally (which would silently miss every large value).
 */
import { describe, it, expect } from "vitest";

import {
  openSessionDb,
  SqliteTableWriter,
  quoteIdent,
  isInternSentinel,
  ROW_IDX_COLUMN,
  INTERN_THRESHOLD_BYTES,
} from "../src/engine/sqliteStore.js";
import {
  fmtCol,
  buildCondition,
  buildEqualityFilter,
  makeInternResolver,
  resolveInternedDisplayValues,
  registerRegexpUdf,
} from "../src/engine/sqlHydrate.js";
import type { SchemaCol, NormalizedRow, Cell } from "../src/engine/parseTable.js";

const BIG_A = "SidebarRow.body view-hierarchy chain — " + "A".repeat(INTERN_THRESHOLD_BYTES);
const BIG_B = "Button.body view-hierarchy chain — " + "B".repeat(INTERN_THRESHOLD_BYTES);
const SMALL = "Yellow";

function stringCell(v: string): Cell {
  return { type: "string", fmt: v, raw: v };
}

/** Ingest a "detail" string column with the given per-row values into a fresh in-memory db. */
function ingest(values: string[]): ReturnType<typeof openSessionDb> {
  const db = openSessionDb(":memory:", { journalMode: "default" });
  registerRegexpUdf(db); // session.ts registers this per connection; find/query regex needs it
  const cols: SchemaCol[] = [{ mnemonic: "detail", name: "Detail", engineeringType: "string" }];
  const writer = new SqliteTableWriter(db, "tbl", cols);
  for (const v of values) {
    const row: NormalizedRow = { detail: stringCell(v) };
    writer.writeRow(row);
  }
  writer.finish();
  return db;
}

function selectDetailIdx(db: ReturnType<typeof openSessionDb>, cond: { clause: string; params: Array<string | number> }): number[] {
  const rows = db
    .prepare(`SELECT ${quoteIdent(ROW_IDX_COLUMN)} AS idx FROM tbl WHERE ${cond.clause} ORDER BY idx`)
    .all(...cond.params) as Array<{ idx: number }>;
  return rows.map((r) => r.idx);
}

describe("PMT:lime-bluff value interning", () => {
  it("dedups a value shared across rows to one interned row, keeps small values inline", () => {
    // rows 0,1,2 share BIG_A; row 3 is BIG_B; row 4 is a small label.
    const db = ingest([BIG_A, BIG_A, BIG_A, BIG_B, SMALL]);

    const { n } = db.prepare("SELECT COUNT(*) AS n FROM interned_values").get() as { n: number };
    expect(n).toBe(2); // BIG_A + BIG_B, not 4

    const stored = db
      .prepare(`SELECT ${quoteIdent(ROW_IDX_COLUMN)} AS idx, ${quoteIdent(fmtCol("detail"))} AS fmt FROM tbl ORDER BY idx`)
      .all() as Array<{ idx: number; fmt: string }>;

    // The three BIG_A rows carry the SAME sentinel token (one interned id).
    expect(isInternSentinel(stored[0].fmt)).toBe(true);
    expect(stored[0].fmt).toBe(stored[1].fmt);
    expect(stored[1].fmt).toBe(stored[2].fmt);
    // BIG_B is a different sentinel; SMALL is stored inline verbatim.
    expect(isInternSentinel(stored[3].fmt)).toBe(true);
    expect(stored[3].fmt).not.toBe(stored[0].fmt);
    expect(isInternSentinel(stored[4].fmt)).toBe(false);
    expect(stored[4].fmt).toBe(SMALL);
  });

  it("resolves interned display values back to their original content", () => {
    const db = ingest([BIG_A, SMALL]);
    const rows = db
      .prepare(`SELECT ${quoteIdent(fmtCol("detail"))} AS __out_detail FROM tbl ORDER BY ${quoteIdent(ROW_IDX_COLUMN)}`)
      .all() as Record<string, unknown>[];
    const resolved = resolveInternedDisplayValues(rows, ["detail"], makeInternResolver(db));
    expect(resolved[0].__out_detail).toBe(BIG_A);
    expect(resolved[1].__out_detail).toBe(SMALL);
  });

  it("find contains matches inside an interned value (short substring of a big blob)", () => {
    const db = ingest([BIG_A, BIG_B, SMALL]);
    // "SidebarRow" only appears inside the interned BIG_A blob.
    expect(selectDetailIdx(db, buildCondition("detail", "contains", "SidebarRow"))).toEqual([0]);
    // A substring present in the small inline value still matches too.
    expect(selectDetailIdx(db, buildCondition("detail", "contains", "Yellow"))).toEqual([2]);
  });

  it("find not-contains excludes the interned row that contains the term", () => {
    const db = ingest([BIG_A, BIG_B, SMALL]);
    // Every row lacks "Nonexistent" → all match not-contains.
    expect(selectDetailIdx(db, buildCondition("detail", "not-contains", "Nonexistent"))).toEqual([0, 1, 2]);
    // Only the BIG_A interned row contains "SidebarRow" → it is excluded.
    expect(selectDetailIdx(db, buildCondition("detail", "not-contains", "SidebarRow"))).toEqual([1, 2]);
  });

  it("find eq / regex match an interned value by its full content", () => {
    const db = ingest([BIG_A, BIG_B, SMALL]);
    expect(selectDetailIdx(db, buildCondition("detail", "eq", BIG_A))).toEqual([0]);
    expect(selectDetailIdx(db, buildCondition("detail", "regex", "^SidebarRow"))).toEqual([0]);
  });

  it("query equality filter matches an interned value by its full content", () => {
    const db = ingest([BIG_A, BIG_B, SMALL]);
    expect(selectDetailIdx(db, buildEqualityFilter({ detail: BIG_A }))).toEqual([0]);
    expect(selectDetailIdx(db, buildEqualityFilter({ detail: SMALL }))).toEqual([2]);
  });
});
