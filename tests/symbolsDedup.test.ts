/**
 * PMT:tidy-warbler: frame-content dedup into a `symbols` table.
 *
 * elm-swamp deduped the backtrace STACK; a stack-rich trace still exploded the
 * frame ROWS (a real Allocations trace: 126k backtraces → 16 M frame rows, each
 * storing full name/binary/binary_path strings for only ~24k distinct symbols).
 * Now each frame's (name, binary, binary_path) is interned into `symbols` once
 * and the frame row stores a `symbol_id` FK + its per-instance `addr`; the read
 * path joins frames→symbols to rebuild the resolved frames unchanged.
 */
import { describe, it, expect } from "vitest";

import { openSessionDb, SqliteTableWriter, quoteIdent, ROW_IDX_COLUMN } from "../src/engine/sqliteStore.js";
import { makeFrameLookup, backtraceFmtFromFrames } from "../src/engine/sqlHydrate.js";
import type { SchemaCol, Cell, ResolvedFrame } from "../src/engine/parseTable.js";

function frame(name: string, binary: string | null = "Bin", path: string | null = "/Bin", addr = "0x0"): ResolvedFrame {
  return { name, addr, binaryName: binary, binaryPath: path };
}
function stackCell(frames: ResolvedFrame[]): Cell {
  return { type: "backtrace", fmt: backtraceFmtFromFrames(frames), raw: frames.length, resolvedFrames: frames };
}
function ingest(stacks: ResolvedFrame[][]): ReturnType<typeof openSessionDb> {
  const db = openSessionDb(":memory:", { journalMode: "default" });
  const cols: SchemaCol[] = [{ mnemonic: "stack", name: "Stack", engineeringType: "backtrace" }];
  const w = new SqliteTableWriter(db, "tbl", cols);
  for (const s of stacks) w.writeRow({ stack: stackCell(s) });
  w.finish();
  return db;
}
const count = (db: ReturnType<typeof openSessionDb>, sql: string, ...p: unknown[]) =>
  (db.prepare(sql).get(...p) as { n: number }).n;

describe("PMT:tidy-warbler symbols dedup", () => {
  it("interns shared frame content once; frame rows store symbol_id", () => {
    const common = frame("commonFrame");
    // Stack A shares its deepest frame (commonFrame) with stack B.
    const db = ingest([[frame("fnA0"), frame("fnA1"), common], [frame("fnB0"), common]]);

    expect(count(db, "SELECT COUNT(*) n FROM backtraces")).toBe(2);
    expect(count(db, "SELECT COUNT(*) n FROM frames")).toBe(5); // 3 + 2 frame rows
    expect(count(db, "SELECT COUNT(*) n FROM symbols")).toBe(4); // fnA0, fnA1, fnB0, commonFrame

    // commonFrame is one symbol, referenced by a frame row in BOTH stacks.
    const symId = (db.prepare("SELECT id FROM symbols WHERE name = 'commonFrame'").get() as { id: number }).id;
    expect(count(db, "SELECT COUNT(*) n FROM frames WHERE symbol_id = ?", symId)).toBe(2);
    // frames no longer carry the strings — content lives only in symbols.
    const cols = db.prepare("PRAGMA table_info(frames)").all().map((c: any) => c.name);
    expect(cols).toEqual(["backtrace_id", "frame_index", "symbol_id", "addr"]);
  });

  it("rebuilds resolved frames byte-identical via the frames→symbols join", () => {
    const original = [frame("fnA0"), frame("fnA1"), frame("commonFrame")];
    const db = ingest([original, [frame("fnB0"), frame("commonFrame")]]);
    const btid = (db.prepare(`SELECT ${quoteIdent("stack__backtrace_id")} AS id FROM tbl ORDER BY ${quoteIdent(ROW_IDX_COLUMN)} LIMIT 1`).get() as { id: number }).id;

    const frames = makeFrameLookup(db)(btid);
    expect(frames.map((f) => f.name)).toEqual(["fnA0", "fnA1", "commonFrame"]);
    expect(frames.map((f) => f.binaryName)).toEqual(["Bin", "Bin", "Bin"]);
    expect(frames.map((f) => f.binaryPath)).toEqual(["/Bin", "/Bin", "/Bin"]);
  });

  it("dedups identical stacks and stores the fingerprint as a compact hash, not full JSON (PMT:true-glade)", () => {
    const stack = [frame("a"), frame("b"), frame("c")];
    const db = ingest([stack, stack]); // same stack written twice
    // Deduped to one backtrace + its 3 frame rows (both rows share backtrace_id).
    expect(count(db, "SELECT COUNT(*) n FROM backtraces")).toBe(1);
    expect(count(db, "SELECT COUNT(*) n FROM frames")).toBe(3);
    // The dedup key is a 64-char sha256, not the raw-stack JSON that used to
    // balloon backtrace-heavy dbs.
    const fp = (db.prepare("SELECT fingerprint FROM backtraces").get() as { fingerprint: string }).fingerprint;
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fp).not.toContain("["); // not a JSON array
  });

  it("dedups frames with a null binary/binary_path into one symbol (IS, not =)", () => {
    // Same name, both with null binary — SQL `= NULL` never matches, so this
    // must dedup via IS or it would create two symbol rows.
    const db = ingest([[frame("nul", null, null, "0x1")], [frame("nul", null, null, "0x2")]]);
    expect(count(db, "SELECT COUNT(*) n FROM symbols WHERE name = 'nul'")).toBe(1);
    // ...but the per-instance addr is still distinct on the two frame rows.
    const addrs = db.prepare("SELECT addr FROM frames ORDER BY addr").all().map((r: any) => r.addr);
    expect(addrs).toEqual(["0x1", "0x2"]);
  });
});
