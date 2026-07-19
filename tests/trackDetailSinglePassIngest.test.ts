/**
 * PMT:firm-jay — single-pass adaptive-schema ingestion for track-detail
 * schemas. Replaces the old two-xctrace-export discovery+ingest design
 * (measured 148.6s/38% of a 388.9s total on a real 2.3GB Allocations trace —
 * see FTR:navy-rime) with inline column discovery: parseTrackDetailStreamToSqlite
 * starts with an empty column set and grows it via SqliteTableWriter.addColumn
 * (ALTER TABLE ADD COLUMN) the moment a row introduces a mnemonic not yet seen.
 *
 * This exercises the real streaming path end-to-end (SAX -> discovery ->
 * SqliteTableWriter), not just SqliteTableWriter.addColumn in isolation —
 * the discovery loop lives inside parseTrackDetailStreamToSqlite itself.
 */
import { Readable } from "node:stream";
import { describe, it, expect } from "vitest";

import { parseTrackDetailStreamToSqlite } from "../src/engine/parseTrackDetail.js";
import { openSessionDb, quoteIdent, ROW_IDX_COLUMN } from "../src/engine/sqliteStore.js";

// Row 1: address, size only. Row 2: adds `category` (a column absent from row 1)
// and gives `size` a non-numeric value despite row 1's "10" looking numeric.
// Row 3: adds a <backtrace> (a column absent from rows 1-2).
const XML = `<?xml version="1.0"?>
<trace-query-result>
<node xpath='//trace-toc[1]/run[1]/tracks[1]/track[1]/details[1]/detail[1]'>
<row address="0x1" size="10"/>
<row address="0x2" size="abc" category="Malloc"/>
<row address="0x3" size="20" category="Malloc"><backtrace><frame id="0" name="fn0" addr="0x100"/></backtrace></row>
</node>
</trace-query-result>`;

async function ingest() {
  const db = openSessionDb(":memory:", { journalMode: "default" });
  const result = await parseTrackDetailStreamToSqlite(Readable.from([XML]), db, "tbl");
  return { db, ...result };
}

describe("PMT:firm-jay single-pass track-detail ingestion", () => {
  it("discovers columns inline in first-seen order, across all three rows", async () => {
    const { rowCount, cols } = await ingest();
    expect(rowCount).toBe(3);
    expect(cols.map((c) => c.mnemonic)).toEqual(["address", "size", "category", "backtrace"]);
  });

  it("a row inserted before a later column existed reads back NULL for it, not an error", async () => {
    const { db } = await ingest();
    const rows = db
      .prepare(`SELECT * FROM tbl ORDER BY ${quoteIdent(ROW_IDX_COLUMN)}`)
      .all() as Array<Record<string, unknown>>;

    // Row 0 predates `category` and `backtrace` entirely.
    expect(rows[0]["category"]).toBeNull();
    expect(rows[0]["category__fmt"]).toBeNull();
    expect(rows[0]["backtrace__backtrace_id"]).toBeNull();

    // Row 1 predates `backtrace` but has `category`.
    expect(rows[1]["category__fmt"]).toBe("Malloc");
    expect(rows[1]["backtrace__backtrace_id"]).toBeNull();

    // Row 2 has all four columns.
    expect(rows[2]["category__fmt"]).toBe("Malloc");
    expect(rows[2]["backtrace__backtrace_id"]).not.toBeNull();
  });

  it("a column whose first value looks numeric still stores a later non-numeric value correctly", async () => {
    const { db } = await ingest();
    const rows = db
      .prepare(`SELECT ${quoteIdent("size")} AS size FROM tbl ORDER BY ${quoteIdent(ROW_IDX_COLUMN)}`)
      .all() as Array<{ size: number | string }>;

    // Row 0's "10" was the sample that decided `size`'s engineering type (uint-64) —
    // row 1's "abc" must still round-trip as its own string, not get mangled or dropped.
    expect(rows[0].size).toBe(10);
    expect(rows[1].size).toBe("abc");
    expect(rows[2].size).toBe(20);
  });

  it("the late-appearing backtrace resolves through the shared backtraces/frames tables", async () => {
    const { db } = await ingest();
    const bt = db.prepare("SELECT COUNT(*) n FROM backtraces").get() as { n: number };
    const fr = db.prepare("SELECT COUNT(*) n FROM frames").get() as { n: number };
    expect(bt.n).toBe(1);
    expect(fr.n).toBe(1);
  });
});
