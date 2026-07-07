/**
 * PMT:still-hail — unit tests for the vsync-cadence "frames held" table
 * (src/detectors/vsyncCadenceTable.ts): display-vsyncs-interval ticks joined
 * against displayed-surfaces-interval swaps, bounded to a window around one
 * hitch. Synthesizes exactly the shape the prompt's own worked example
 * describes: a normal swap, then a swap held through 4 cadence intervals
 * (3 dropped frames), then a recovery swap back to normal.
 */
import { describe, it, expect } from "vitest";
import { openSessionDb, SqliteTableWriter } from "../src/engine/sqliteStore.js";
import type { SchemaCol, NormalizedRow } from "../src/engine/parseTable.js";
import type { DetectorContext } from "../src/detectors/index.js";
import { DISPLAY_VSYNCS_SCHEMA } from "../src/detectors/frameBudget.js";
import { buildVsyncCadenceTable, DISPLAYED_SURFACES_SCHEMA } from "../src/detectors/vsyncCadenceTable.js";

type Row = Record<string, { type: string; fmt: string | number; raw: string | number }>;

function colsOf(shape: Record<string, string>): SchemaCol[] {
  return Object.entries(shape).map(([mnemonic, engineeringType]) => ({ mnemonic, name: mnemonic, engineeringType }));
}

function ingest(db: ReturnType<typeof openSessionDb>, schema: string, cols: SchemaCol[], rows: Row[]): void {
  const w = new SqliteTableWriter(db, schema, cols);
  for (const r of rows) w.writeRow(r as NormalizedRow);
  w.finish();
}

function newDb(): ReturnType<typeof openSessionDb> {
  return openSessionDb(":memory:", { journalMode: "default" });
}

const ctxFor = (db: ReturnType<typeof openSessionDb>): DetectorContext => ({
  db,
  sessionId: "",
  run: 1,
  tableName: (schema: string) => schema,
});

const cell = (type: string, v: string | number) => ({ type, fmt: String(v), raw: v });

const CADENCE_MS = 16.67;
const CADENCE_NS = CADENCE_MS * 1e6;

function tick(n: number): number {
  return Math.round(n * CADENCE_NS);
}

describe("buildVsyncCadenceTable (PMT:still-hail)", () => {
  it("shows a 4-cadence hold: normal swap, held-through ticks, recovery swap", () => {
    const db = newDb();
    ingest(
      db,
      DISPLAY_VSYNCS_SCHEMA,
      colsOf({ timestamp: "start-time", "display-name": "display-name" }),
      [0, 1, 2, 3, 4, 5].map((n) => ({
        timestamp: cell("start-time", tick(n)),
        "display-name": cell("display-name", "Display 1"),
      }))
    );
    ingest(
      db,
      DISPLAYED_SURFACES_SCHEMA,
      colsOf({ start: "start-time", duration: "duration", "display-name": "display-name" }),
      [
        // Normal swap at tick 0, on-screen exactly one cadence.
        { start: cell("start-time", tick(0)), duration: cell("duration", CADENCE_NS), "display-name": cell("display-name", "Display 1") },
        // The hitch: swaps in at tick 1, stays on-screen 4 cadences (3 dropped frames).
        { start: cell("start-time", tick(1)), duration: cell("duration", 4 * CADENCE_NS), "display-name": cell("display-name", "Display 1") },
        // Recovery swap at tick 5, back to one cadence.
        { start: cell("start-time", tick(5)), duration: cell("duration", CADENCE_NS), "display-name": cell("display-name", "Display 1") },
      ] as Row[]
    );

    const table = buildVsyncCadenceTable(ctxFor(db), "Display 1", tick(1), 4 * CADENCE_NS, CADENCE_MS);
    expect(table).not.toBeNull();
    expect(table!.cadenceMs).toBe(CADENCE_MS);
    expect(table!.rows.length).toBe(6); // ticks 0..5

    const [row0, row1, row2, row3, row4, row5] = table!.rows;
    expect(row0).toMatchObject({ hasSwap: true, framesHeld: 1, note: "normal" });
    expect(row1).toMatchObject({ hasSwap: true, framesHeld: 4, note: "4 frames held (3 dropped)" });
    expect(row2).toMatchObject({ hasSwap: false, note: "no new frame" });
    expect(row3).toMatchObject({ hasSwap: false, note: "no new frame" });
    expect(row4).toMatchObject({ hasSwap: false, note: "no new frame" });
    expect(row5).toMatchObject({ hasSwap: true, framesHeld: 1, note: "recovery swap" });
  });

  it("returns null when displayed-surfaces-interval isn't ingested (degrades gracefully, no throw)", () => {
    const db = newDb();
    ingest(
      db,
      DISPLAY_VSYNCS_SCHEMA,
      colsOf({ timestamp: "start-time", "display-name": "display-name" }),
      [0, 1, 2].map((n) => ({ timestamp: cell("start-time", tick(n)), "display-name": cell("display-name", "Display 1") }))
    );
    expect(buildVsyncCadenceTable(ctxFor(db), "Display 1", tick(1), CADENCE_NS, CADENCE_MS)).toBeNull();
  });

  it("returns null when neither schema is ingested", () => {
    const db = newDb();
    expect(buildVsyncCadenceTable(ctxFor(db), "Display 1", 0, CADENCE_NS, CADENCE_MS)).toBeNull();
  });
});
