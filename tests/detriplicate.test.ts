/**
 * PMT:live-fawn — dropping the redundant __children re-encode.
 *
 * The __children JSON blob re-encodes a compound cell's whole subtree, but its
 * sole consumer (getRow.ts's childValues / extractKperfBt) only reads each
 * IMMEDIATE child's fmt — and every non-null, non-backtrace immediate child is
 * already promoted to its own <mnemonic>__<child>__fmt column. So the writer
 * drops the blob when every immediate child is promotable, and hydrateCell
 * rebuilds the shallow children map from the promoted columns.
 *
 * These tests pin the acceptance gate: get_row's nested detail is byte-identical
 * whether the blob was dropped-and-reconstructed or kept — and the blob really
 * is dropped for the common case and kept for the un-promotable ones (a null
 * immediate child), so nothing is silently lost.
 */
import { describe, it, expect } from "vitest";

import { openSessionDb, SqliteTableWriter, quoteIdent, ROW_IDX_COLUMN } from "../src/engine/sqliteStore.js";
import { hydrateCell, makeFrameLookup, makeInternResolver, childrenCol } from "../src/engine/sqlHydrate.js";
import type { SchemaCol, NormalizedRow, Cell } from "../src/engine/parseTable.js";

// A compound `thread` cell: immediate children tid (scalar) + process (compound, with pid).
function threadCell(tid: string, procFmt: string, pid: number): Cell {
  return {
    type: "thread",
    fmt: `Thread ${tid}`,
    raw: tid,
    children: {
      tid: { type: "uint64", fmt: tid, raw: tid },
      process: {
        type: "process",
        fmt: procFmt,
        raw: procFmt,
        children: { pid: { type: "pid", fmt: String(pid), raw: pid } },
      },
    },
  };
}

/** get_row's generic-compound childValues mapping: each immediate child tag → its fmt. */
function childValuesOf(cell: Cell | null): Record<string, string | null> | undefined {
  if (!cell?.children) return undefined;
  const out: Record<string, string | null> = {};
  for (const [tag, child] of Object.entries(cell.children)) out[tag] = child?.fmt ?? null;
  return out;
}

function ingest(rows: NormalizedRow[]): ReturnType<typeof openSessionDb> {
  const db = openSessionDb(":memory:", { journalMode: "default" });
  const cols: SchemaCol[] = [{ mnemonic: "thread", name: "Thread", engineeringType: "thread" }];
  const writer = new SqliteTableWriter(db, "tbl", cols);
  for (const r of rows) writer.writeRow(r);
  writer.finish();
  return db;
}

function hydrateThread(db: ReturnType<typeof openSessionDb>, rowIdx: number): Cell | null {
  const sqlRow = db.prepare(`SELECT * FROM tbl WHERE ${quoteIdent(ROW_IDX_COLUMN)} = ?`).get(rowIdx) as Record<string, unknown>;
  const col: SchemaCol = { mnemonic: "thread", name: "Thread", engineeringType: "thread" };
  return hydrateCell(col, sqlRow, makeFrameLookup(db), makeInternResolver(db));
}

describe("PMT:live-fawn __children de-triplication", () => {
  it("drops the __children blob when every immediate child is promoted, and reconstructs identical childValues", () => {
    const original = threadCell("0x101", "MyApp (123)", 123);
    const db = ingest([{ thread: original }]);

    // The blob column exists but is NULL — the re-encode was dropped.
    const stored = db.prepare(`SELECT ${quoteIdent(childrenCol("thread"))} AS kids FROM tbl`).get() as { kids: unknown };
    expect(stored.kids).toBeNull();

    // hydrateCell rebuilds the shallow children from the promoted __fmt columns,
    // and get_row's childValues is byte-identical to what the JSON path produced.
    const cell = hydrateThread(db, 0);
    expect(childValuesOf(cell)).toEqual(childValuesOf(original));
    expect(childValuesOf(cell)).toEqual({ tid: "0x101", process: "MyApp (123)" });
  });

  it("keeps the __children blob when an immediate child is null (un-promotable), preserving the null in childValues", () => {
    // Row 0 introduces the promoted columns; row 1 has a null `process` child.
    const full = threadCell("0x1", "MyApp (1)", 1);
    const withNullChild: Cell = {
      type: "thread",
      fmt: "Thread 0x2",
      raw: "0x2",
      children: { tid: { type: "uint64", fmt: "0x2", raw: "0x2" }, process: null },
    };
    const db = ingest([{ thread: full }, { thread: withNullChild }]);

    const kids = db
      .prepare(`SELECT ${quoteIdent(childrenCol("thread"))} AS kids FROM tbl WHERE ${quoteIdent(ROW_IDX_COLUMN)} = 1`)
      .get() as { kids: unknown };
    expect(kids.kids).not.toBeNull(); // blob kept — a null child can't be reconstructed from promoted columns

    const cell = hydrateThread(db, 1);
    expect(childValuesOf(cell)).toEqual({ tid: "0x2", process: null });
  });

  it("leaves a genuine scalar cell with no children (no spurious reconstruction)", () => {
    const db = openSessionDb(":memory:", { journalMode: "default" });
    const cols: SchemaCol[] = [{ mnemonic: "label", name: "Label", engineeringType: "string" }];
    const writer = new SqliteTableWriter(db, "tbl", cols);
    writer.writeRow({ label: { type: "string", fmt: "Yellow", raw: "Yellow" } });
    writer.finish();
    const sqlRow = db.prepare("SELECT * FROM tbl").get() as Record<string, unknown>;
    const cell = hydrateCell(cols[0], sqlRow, makeFrameLookup(db), makeInternResolver(db));
    expect(cell?.children).toBeUndefined();
    expect(cell?.fmt).toBe("Yellow");
  });
});
