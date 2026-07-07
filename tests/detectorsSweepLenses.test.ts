/**
 * PMT:shingle-bluff (outlier-sweep) / PMT:tidy-shore (near-miss) — unit tests.
 *
 * Both lenses read the SAME shared band map (src/detectors/bands.ts) over
 * the hitches schema — outlierSweep flags rows already OVER Apple's
 * dropped-frame band, nearMissSweep flags the sub-threshold population just
 * UNDER it. Follows tests/detectorsCorpus.test.ts's pattern for expensive
 * detectors: synthetic hitches table via SqliteTableWriter, call run(ctx)
 * directly (runCheapDetectors only drives the cheap tier, so a sanity check
 * confirms these never run eager).
 */
import { describe, it, expect } from "vitest";
import { openSessionDb, SqliteTableWriter } from "../src/engine/sqliteStore.js";
import type { SchemaCol, NormalizedRow } from "../src/engine/parseTable.js";
import { runCheapDetectors, type DetectorContext } from "../src/detectors/index.js";
import { outlierSweep } from "../src/detectors/outlierSweep.js";
import { nearMissSweep } from "../src/detectors/nearMissSweep.js";
import { DEFAULT_REFRESH_INTERVAL_MS } from "../src/detectors/bands.js";

const HITCH_COLS: SchemaCol[] = [
  { mnemonic: "start", name: "Start", engineeringType: "start-time" },
  { mnemonic: "duration", name: "Duration", engineeringType: "duration" },
  { mnemonic: "is-system", name: "Is System", engineeringType: "string" },
];

const cell = (type: string, v: string | number) => ({ type, fmt: String(v), raw: v });

function newDb(): ReturnType<typeof openSessionDb> {
  return openSessionDb(":memory:", { journalMode: "default" });
}

function ingestHitches(db: ReturnType<typeof openSessionDb>, durationsMs: number[]): void {
  const w = new SqliteTableWriter(db, "hitches", HITCH_COLS);
  durationsMs.forEach((ms, i) => {
    const row: NormalizedRow = {
      start: cell("start-time", i * 100_000_000),
      duration: cell("duration", Math.round(ms * 1e6)),
      "is-system": cell("string", "No"),
    };
    w.writeRow(row);
  });
  w.finish();
}

const ctxFor = (db: ReturnType<typeof openSessionDb>): DetectorContext => ({
  db,
  sessionId: "",
  run: 1,
  tableName: () => "hitches",
});

const FRAME_MS = DEFAULT_REFRESH_INTERVAL_MS;

describe("outlier-sweep (PMT:shingle-bluff, expensive: hitches over-band sweep)", () => {
  it("fires when several app-caused hitches cross the 1x/2x frame-budget bands", () => {
    const db = newDb();
    // 10 clean hitches (well under budget) + 6 over 1x (Moderate) + 2 over 2x (High)
    const durations = [
      ...Array(10).fill(FRAME_MS * 0.2),
      ...Array(6).fill(FRAME_MS * 1.5),
      ...Array(2).fill(FRAME_MS * 2.5),
    ];
    ingestHitches(db, durations);
    const ranked = runCheapDetectors([outlierSweep], ctxFor(db), new Set(["hitches"]));
    expect(ranked).toEqual([]); // sanity: expensive detectors never run eager
    const finding = outlierSweep.run(ctxFor(db));
    expect(finding).not.toBeNull();
    expect(finding!.summary).toContain("hitches");
    expect(finding!.firing.some((f) => f.direction === "over" && f.metric.includes("Moderate"))).toBe(true);
    expect(finding!.firing.some((f) => f.direction === "over" && f.metric.includes("High"))).toBe(true);
    expect(finding!.handles[0]).toMatchObject({ kind: "row", schema: "hitches" });
    expect(finding!.callSpec).toMatchObject({ verb: "find", schema: "hitches" });
  });

  it("does not fire when hitches stay well under the frame budget", () => {
    const db = newDb();
    ingestHitches(db, Array(20).fill(FRAME_MS * 0.2));
    expect(outlierSweep.run(ctxFor(db))).toBeNull();
  });
});

describe("near-miss-sweep (PMT:tidy-shore, expensive: hitches near-miss band)", () => {
  it("fires on a leading-indicator cluster of 0.5x-1x hitches, none actually over the line", () => {
    const db = newDb();
    // 10 clean + 8 in the 0.5x-1x near-miss band, none crossing 1x
    const durations = [...Array(10).fill(FRAME_MS * 0.2), ...Array(8).fill(FRAME_MS * 0.9)];
    ingestHitches(db, durations);
    const finding = nearMissSweep.run(ctxFor(db));
    expect(finding).not.toBeNull();
    expect(finding!.summary).toContain("leading indicator");
    expect(finding!.firing.some((f) => f.direction === "over" && f.metric.includes("near-miss band"))).toBe(true);
    expect(finding!.firing.some((f) => f.direction === "under")).toBe(true);
    expect(finding!.handles[0]).toMatchObject({ kind: "row", schema: "hitches" });
    // Sanity: outlier-sweep must stay quiet on the SAME data — nothing here is actually over the line.
    expect(outlierSweep.run(ctxFor(db))).toBeNull();
  });

  it("does not fire when hitches are clean (nowhere near the near-miss band)", () => {
    const db = newDb();
    ingestHitches(db, Array(20).fill(FRAME_MS * 0.2));
    expect(nearMissSweep.run(ctxFor(db))).toBeNull();
  });

  it("does not fire when hitches are already OVER the line (outlier-sweep's territory, not this lens's)", () => {
    const db = newDb();
    ingestHitches(db, [...Array(10).fill(FRAME_MS * 0.2), ...Array(8).fill(FRAME_MS * 1.5)]);
    expect(nearMissSweep.run(ctxFor(db))).toBeNull();
  });
});
