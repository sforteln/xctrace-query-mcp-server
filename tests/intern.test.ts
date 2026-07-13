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
import { ColumnStatsAccumulator, decideInternColumns } from "../src/engine/columnStats.js";
import { isNodeEncoded } from "../src/engine/hierarchyEncode.js";
import {
  fmtCol,
  buildCondition,
  buildEqualityFilter,
  makeInternResolver,
  resolveInternedDisplayValues,
  registerRegexpUdf,
  makeInternTargetResolver,
  registerInternDecodeUdf,
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
  registerRegexpUdf(db); // session.ts registers these per connection; find/query regex + internResolved need them
  registerInternDecodeUdf(db);
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
    // eq resolves the TARGET to its stored sentinel (PMT:ruddy-owl); regex resolves the column per-row.
    const t = makeInternTargetResolver(db);
    expect(selectDetailIdx(db, buildCondition("detail", "eq", BIG_A, t))).toEqual([0]);
    expect(selectDetailIdx(db, buildCondition("detail", "regex", "^SidebarRow"))).toEqual([0]);
  });

  it("query equality filter matches an interned value by its full content", () => {
    const db = ingest([BIG_A, BIG_B, SMALL]);
    const t = makeInternTargetResolver(db);
    expect(selectDetailIdx(db, buildEqualityFilter({ detail: BIG_A }, t))).toEqual([0]);
    expect(selectDetailIdx(db, buildEqualityFilter({ detail: SMALL }, t))).toEqual([2]);
  });
});

// ─── PMT:ruddy-owl flavor-2: small-but-repeated ─────────────────────────────────

// Values ≥ FLAVOR2 floor (16B) but well under the 256B flavor-1 threshold.
const CAT_A = "SidebarRow.body.view"; // 20B
const CAT_B = "Button.body.element"; // 19B

function ingestCat(values: string[], internColumns: Set<string>): ReturnType<typeof openSessionDb> {
  const db = openSessionDb(":memory:", { journalMode: "default" });
  const cols: SchemaCol[] = [{ mnemonic: "cat", name: "Category", engineeringType: "string" }];
  const writer = new SqliteTableWriter(db, "tbl", cols, { internColumns });
  for (const v of values) writer.writeRow({ cat: stringCell(v) });
  writer.finish();
  return db;
}

describe("PMT:ruddy-owl flavor-2 interning", () => {
  it("interns a flagged small-but-repeated column CONSISTENTLY (one token per value)", () => {
    const db = ingestCat([CAT_A, CAT_A, CAT_A, CAT_B], new Set(["cat"]));

    // Both distinct values interned once each (not per row), despite being < 256B.
    const iv = db.prepare("SELECT COUNT(*) AS n FROM interned_values").get() as { n: number };
    expect(iv.n).toBe(2);

    const stored = db
      .prepare(`SELECT ${quoteIdent(fmtCol("cat"))} AS fmt FROM tbl ORDER BY ${quoteIdent(ROW_IDX_COLUMN)}`)
      .all() as Array<{ fmt: string }>;
    // Every occurrence of CAT_A shares ONE sentinel token — the consistency that
    // keeps GROUP BY / JOIN correct.
    expect(isInternSentinel(stored[0].fmt)).toBe(true);
    expect(stored[0].fmt).toBe(stored[1].fmt);
    expect(stored[1].fmt).toBe(stored[2].fmt);
    expect(stored[3].fmt).not.toBe(stored[0].fmt);
  });

  it("GROUP BY on an interned small column is not split (consistent token → one group per value)", () => {
    const db = ingestCat([CAT_A, CAT_A, CAT_A, CAT_B, CAT_B], new Set(["cat"]));
    const unintern = makeInternResolver(db);
    const groups = db
      .prepare(`SELECT ${quoteIdent(fmtCol("cat"))} AS k, COUNT(*) AS n FROM tbl GROUP BY ${quoteIdent(fmtCol("cat"))}`)
      .all() as Array<{ k: string; n: number }>;
    // Two groups, correct counts — NOT four (which a first-inline/then-sentinel scheme would produce).
    const byKey = new Map(groups.map((g) => [unintern(g.k) as string, g.n]));
    expect(byKey.size).toBe(2);
    expect(byKey.get(CAT_A)).toBe(3);
    expect(byKey.get(CAT_B)).toBe(2);
  });

  it("eq on a small interned value matches via target resolution", () => {
    const db = ingestCat([CAT_A, CAT_B, CAT_A], new Set(["cat"]));
    const t = makeInternTargetResolver(db);
    const idx = db
      .prepare(`SELECT ${quoteIdent(ROW_IDX_COLUMN)} AS idx FROM tbl WHERE ${buildEqualityFilter({ cat: CAT_A }, t).clause} ORDER BY idx`)
      .all(...buildEqualityFilter({ cat: CAT_A }, t).params) as Array<{ idx: number }>;
    expect(idx.map((r) => r.idx)).toEqual([0, 2]);
  });

  it("does NOT intern the same small values when the column is not flagged", () => {
    const db = ingestCat([CAT_A, CAT_A, CAT_B], new Set()); // no flavor-2 columns
    const iv = db.prepare("SELECT COUNT(*) AS n FROM interned_values").get() as { n: number };
    expect(iv.n).toBe(0); // < 256B and not flagged → stays inline
    const stored = db.prepare(`SELECT ${quoteIdent(fmtCol("cat"))} AS fmt FROM tbl`).all() as Array<{ fmt: string }>;
    expect(stored.every((r) => !isInternSentinel(r.fmt))).toBe(true);
  });

  it("self-samples the decision (no injected columns) and interns buffered + later rows consistently", () => {
    const db = openSessionDb(":memory:", { journalMode: "default" });
    const cols: SchemaCol[] = [{ mnemonic: "cat", name: "Category", engineeringType: "string" }];
    // sampleSize 5000 so the decision fires mid-stream; 5001 rows exercises both
    // the flushed buffer AND a post-decision write.
    const writer = new SqliteTableWriter(db, "tbl", cols, { sampleSize: 5000 });
    const vals = ["SidebarRow.body.view", "Button.body.element", "LazyVStack.body.node"];
    for (let i = 0; i < 5001; i++) writer.writeRow({ cat: stringCell(vals[i % 3]) });
    writer.finish();

    // The 3 repeated values interned once each — decided from the sample, no injection.
    const iv = db.prepare("SELECT COUNT(*) AS n FROM interned_values").get() as { n: number };
    expect(iv.n).toBe(3);
    // EVERY row (including the 5000 buffered before the decision) carries a sentinel —
    // the flush applied the decision retroactively, so representation is consistent.
    const stored = db.prepare(`SELECT ${quoteIdent(fmtCol("cat"))} AS fmt FROM tbl`).all() as Array<{ fmt: string }>;
    expect(stored.length).toBe(5001);
    expect(stored.every((r) => isInternSentinel(r.fmt))).toBe(true);
  });

  // ── node-encoded chains: large view-hierarchy values, interned via shared-node dedup (see hierarchyEncode.test.ts) ──
  const NODES_A = Array.from({ length: 20 }, (_, i) => `ViewNode${String(i).padStart(2, "0")}`); // ViewNode00..19
  const CHAIN_A = NODES_A.join(" ← "); // ~360B, ≥256 floor
  const CHAIN_B = ["OtherLeaf", ...NODES_A.slice(1)].join(" ← "); // shares ViewNode01..19

  it("node-encodes large chain values, dedups nodes, and round-trips exactly", () => {
    const db = ingest([CHAIN_A, CHAIN_B, CHAIN_A]); // CHAIN_A twice → one interned value

    // 2 distinct interned chains; nodes deduped to 21 (ViewNode00..19 + OtherLeaf).
    expect((db.prepare("SELECT COUNT(*) AS n FROM interned_values").get() as { n: number }).n).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM hierarchy_nodes").get() as { n: number }).n).toBe(21);

    // Stored content is node-encoded (marker), and smaller than the raw chain.
    const stored = db.prepare("SELECT content FROM interned_values").all() as Array<{ content: string }>;
    expect(stored.every((r) => isNodeEncoded(r.content))).toBe(true);
    expect(stored.every((r) => r.content.length < CHAIN_A.length)).toBe(true);

    // The resolver rebuilds the exact original chains.
    const un = makeInternResolver(db);
    const fmts = db.prepare(`SELECT ${quoteIdent(fmtCol("detail"))} AS f FROM tbl ORDER BY ${quoteIdent(ROW_IDX_COLUMN)}`).all() as Array<{ f: string }>;
    expect(un(fmts[0].f)).toBe(CHAIN_A);
    expect(un(fmts[1].f)).toBe(CHAIN_B);
    expect(un(fmts[2].f)).toBe(CHAIN_A);
  });

  it("find contains matches a node inside a node-encoded chain (via mcp_unintern)", () => {
    const db = ingest([CHAIN_A, CHAIN_B]);
    // ViewNode05 is in both chains; ViewNode00 only in A; OtherLeaf only in B.
    expect(selectDetailIdx(db, buildCondition("detail", "contains", "ViewNode05"))).toEqual([0, 1]);
    expect(selectDetailIdx(db, buildCondition("detail", "contains", "ViewNode00"))).toEqual([0]);
    expect(selectDetailIdx(db, buildCondition("detail", "contains", "OtherLeaf"))).toEqual([1]);
  });

  it("decideInternColumns picks the high-repeat column and skips the unique one", () => {
    const acc = new ColumnStatsAccumulator();
    // `cat` cycles through 3 values over 100k rows (huge duplication); `id` is unique per row.
    for (let i = 0; i < 100_000; i++) {
      acc.observeRow({
        cat: stringCell(["SidebarRow.body.view", "Button.body.element", "LazyVStack.body.node"][i % 3]),
        id: stringCell(`unique-identifier-value-${i}`),
      });
    }
    const chosen = decideInternColumns(acc);
    expect(chosen.has("cat")).toBe(true);
    expect(chosen.has("id")).toBe(false);
  });
});
