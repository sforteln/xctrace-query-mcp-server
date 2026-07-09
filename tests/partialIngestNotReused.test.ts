/**
 * PMT:onyx-spark — an aborted (table-too-large) ingest must NOT be silently
 * reused as if it were complete.
 *
 * Root cause (verified live against a real trace, PMT:onyx-spark's SwiftUI ×
 * Core Data retrospective): persistIngestedSchemaCols — the PMT:ruby-peak
 * "this table is fully ingested, safe to reuse" marker in `_ingested_schema`
 * — used to be written in SqliteTableWriter's CONSTRUCTOR, eagerly, before a
 * single row was inserted (rationale: columns are known up front). But a
 * memoryGuard table-too-large abort mid-stream never reaches
 * `writer.finish()` — it just stops. So the marker was ALREADY written by
 * the time the abort happened, and a later getTable() call saw a
 * reuse-eligible entry and silently served the partial row set as if
 * complete, with no error and no indication data was missing. Confirmed
 * live: a real swiftui-updates table sat at 905,000 of ~1.2M real rows after
 * an abort, and every subsequent query/aggregate/correlate call against that
 * trace returned totalRows: 905000 with a clean, ok-looking response.
 *
 * Fix: persistIngestedSchemaCols moved to finish() — only reached when the
 * full row stream is consumed without an exception.
 */
import { describe, it, expect } from "vitest";
import { openSessionDb, SqliteTableWriter, loadIngestedSchemaCols } from "../src/engine/sqliteStore.js";
import type { SchemaCol, Cell } from "../src/engine/parseTable.js";

const COLS: SchemaCol[] = [{ mnemonic: "name", name: "Name", engineeringType: "string" }];

function stringCell(v: string): Cell {
  return { type: "string", fmt: v, raw: v };
}

describe("partial (aborted) ingest is not marked reuse-eligible", () => {
  it("a writer that never reaches finish() (simulating a table-too-large abort) leaves _ingested_schema unwritten", () => {
    const db = openSessionDb(":memory:", { journalMode: "default" });
    const writer = new SqliteTableWriter(db, "1:aborted-schema", COLS);
    // Simulate a real abort: some rows written, then the stream dies
    // (memoryGuard throws) WITHOUT ever calling finish() — exactly what
    // parseTable.ts's/parseTrackDetail.ts's assertMemoryBudget catch block does.
    writer.writeRow({ name: stringCell("row 1") });
    writer.writeRow({ name: stringCell("row 2") });
    // writer.finish() deliberately NOT called.

    const reused = loadIngestedSchemaCols(db, "1:aborted-schema");
    expect(reused).toBeNull();
  });

  it("a writer that DOES reach finish() is correctly marked reuse-eligible", () => {
    const db = openSessionDb(":memory:", { journalMode: "default" });
    const writer = new SqliteTableWriter(db, "1:complete-schema", COLS);
    writer.writeRow({ name: stringCell("row 1") });
    writer.writeRow({ name: stringCell("row 2") });
    const rowCount = writer.finish();

    expect(rowCount).toBe(2);
    const reused = loadIngestedSchemaCols(db, "1:complete-schema");
    expect(reused).not.toBeNull();
    expect(reused).toEqual(COLS);
  });

  it("a later getTable-style reuse check on the SAME tableName after a real abort-then-retry sequence sees no stale entry", () => {
    // Reproduces the exact sequence: first attempt aborts (no finish()), a
    // second attempt on the SAME tableName completes normally. The first
    // attempt must leave no trace that would make the SECOND look complete
    // when it might not be, and the second attempt's own real completion
    // must be the ONLY thing that marks reuse-eligibility.
    const db = openSessionDb(":memory:", { journalMode: "default" });
    const aborted = new SqliteTableWriter(db, "1:retried-schema", COLS);
    aborted.writeRow({ name: stringCell("partial row") });
    // abort — no finish()
    expect(loadIngestedSchemaCols(db, "1:retried-schema")).toBeNull();

    // Retry: a fresh writer for the SAME tableName (mirrors DROP+CREATE in
    // the constructor), this time completing successfully.
    const retried = new SqliteTableWriter(db, "1:retried-schema", COLS);
    retried.writeRow({ name: stringCell("row 1") });
    retried.writeRow({ name: stringCell("row 2") });
    retried.writeRow({ name: stringCell("row 3") });
    const finalCount = retried.finish();

    expect(finalCount).toBe(3);
    expect(loadIngestedSchemaCols(db, "1:retried-schema")).toEqual(COLS);
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM "1:retried-schema"`).get() as { n: number };
    expect(rows.n).toBe(3);
  });
});
