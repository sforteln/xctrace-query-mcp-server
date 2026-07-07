/**
 * PMT:muddy-frost — folding backtraces nested inside compound cells (depth > 0)
 * into the shared frames/backtraces tables.
 *
 * elm-swamp deduped TOP-LEVEL backtrace columns; a stack nested inside a
 * compound (e.g. swiftui-updates' cause-graph-node: string + a ~28-frame
 * backtrace + a null sentinel) was instead re-encoded as JSON in the parent's
 * __children blob and stored per distinct value — the dominant remaining
 * on-disk cost. Now the nested stack is promoted to a <mnemonic>__<child>__
 * backtrace_id FK (content-hash deduped, shared DB-wide), the __children blob
 * shrinks to just the null residual, and hydrateCell rebuilds the child from
 * the FK so get_row is unchanged.
 */
import { describe, it, expect } from "vitest";

import { openSessionDb, SqliteTableWriter, quoteIdent, ROW_IDX_COLUMN } from "../src/engine/sqliteStore.js";
import { hydrateCell, makeFrameLookup, makeInternResolver, childrenCol, backtraceFmtFromFrames } from "../src/engine/sqlHydrate.js";
import type { SchemaCol, NormalizedRow, Cell, ResolvedFrame } from "../src/engine/parseTable.js";

function frames(n: number): ResolvedFrame[] {
  return Array.from({ length: n }, (_, i) => ({ name: `fn${i}`, addr: `0x${i.toString(16)}`, binaryName: "Bin", binaryPath: "/Bin" }));
}

// A cause-graph-node-shaped compound: a scalar `string`, a nested `backtrace`, and a null `sentinel`.
function causeNode(str: string, fr: ResolvedFrame[]): Cell {
  return {
    type: "cause-graph-node",
    fmt: str,
    raw: str,
    children: {
      string: { type: "string", fmt: str, raw: str },
      backtrace: { type: "backtrace", fmt: backtraceFmtFromFrames(fr), raw: fr.length, resolvedFrames: fr },
      sentinel: null,
    },
  };
}

function childValuesOf(cell: Cell | null): Record<string, string | null> | undefined {
  if (!cell?.children) return undefined;
  const out: Record<string, string | null> = {};
  for (const [tag, child] of Object.entries(cell.children)) out[tag] = child?.fmt ?? null;
  return out;
}

function ingest(rows: NormalizedRow[]): ReturnType<typeof openSessionDb> {
  const db = openSessionDb(":memory:", { journalMode: "default" });
  const cols: SchemaCol[] = [{ mnemonic: "cause-graph-node", name: "Cause", engineeringType: "cause-graph-node" }];
  const writer = new SqliteTableWriter(db, "tbl", cols);
  for (const r of rows) writer.writeRow(r);
  writer.finish();
  return db;
}

function hydrate(db: ReturnType<typeof openSessionDb>, rowIdx: number): Cell | null {
  const sqlRow = db.prepare(`SELECT * FROM tbl WHERE ${quoteIdent(ROW_IDX_COLUMN)} = ?`).get(rowIdx) as Record<string, unknown>;
  const col: SchemaCol = { mnemonic: "cause-graph-node", name: "Cause", engineeringType: "cause-graph-node" };
  return hydrateCell(col, sqlRow, makeFrameLookup(db), makeInternResolver(db));
}

const FK = quoteIdent("cause-graph-node__backtrace__backtrace_id");

describe("PMT:muddy-frost nested-backtrace dedup", () => {
  it("folds a nested stack into frames/backtraces and stores only a deduped FK", () => {
    const shared = frames(28);
    // Three rows share the identical 28-frame stack; row 3 has a different stack.
    const other = frames(5);
    const db = ingest([causeNode("A", shared), causeNode("B", shared), causeNode("C", shared), causeNode("D", other)].map((c) => ({ "cause-graph-node": c })));

    // The stack is deduped: 2 distinct backtraces, frames stored once per stack.
    const bt = db.prepare("SELECT COUNT(*) n FROM backtraces").get() as { n: number };
    expect(bt.n).toBe(2);
    const fr = db.prepare("SELECT COUNT(*) n FROM frames").get() as { n: number };
    expect(fr.n).toBe(28 + 5);

    // The three shared rows carry the SAME FK id; the fourth differs.
    const ids = db.prepare(`SELECT ${FK} AS id FROM tbl ORDER BY ${quoteIdent(ROW_IDX_COLUMN)}`).all() as Array<{ id: number }>;
    expect(ids[0].id).toBe(ids[1].id);
    expect(ids[1].id).toBe(ids[2].id);
    expect(ids[3].id).not.toBe(ids[0].id);
  });

  it("shrinks __children to just the null residual — the stack is no longer re-encoded per row", () => {
    const db = ingest([{ "cause-graph-node": causeNode("A", frames(28)) }]);
    const stored = db.prepare(`SELECT ${quoteIdent(childrenCol("cause-graph-node"))} AS kids FROM tbl`).get() as { kids: string | null };
    expect(stored.kids).toBe('{"sentinel":null}'); // only the null child; no frames
    expect(stored.kids).not.toContain("fn0"); // the 28-frame stack is not in the blob
  });

  it("get_row childValues is byte-identical, with the nested backtrace rebuilt from the FK", () => {
    const fr = frames(28);
    const original = causeNode("SidebarRow.body", fr);
    const db = ingest([{ "cause-graph-node": original }]);
    const cell = hydrate(db, 0);

    // childValues: string fmt, backtrace fmt (recomputed from folded frames), sentinel null.
    expect(childValuesOf(cell)).toEqual(childValuesOf(original));
    expect(childValuesOf(cell)).toEqual({
      string: "SidebarRow.body",
      backtrace: backtraceFmtFromFrames(fr),
      sentinel: null,
    });

    // The nested backtrace child carries its resolved frames again (from the FK).
    const btChild = cell?.children?.backtrace;
    expect(btChild?.resolvedFrames?.length).toBe(28);
    expect(btChild?.resolvedFrames?.[0].name).toBe("fn0");
  });
});
