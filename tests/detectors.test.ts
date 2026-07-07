/**
 * PMT:pure-hail — the detector framework contract.
 *
 * Pins the load-bearing behavior: framework-computed ranking (not detector-
 * picked severity), schema-gating, cost-gating (only cheap run eager), a broken
 * detector never breaking the run, and the one example detector firing (and not
 * firing) end to end over a real ingested table.
 */
import { describe, it, expect } from "vitest";
import { openSessionDb, SqliteTableWriter } from "../src/engine/sqliteStore.js";
import type { SchemaCol, NormalizedRow } from "../src/engine/parseTable.js";
import {
  DETECTORS,
  runCheapDetectors,
  scoreOf,
  severityOf,
  criterionText,
  type Detector,
  type DetectorContext,
  type RankedFinding,
} from "../src/detectors/index.js";
import { findingToNextAction } from "../src/detectors/surface.js";

// ── Synthetic swiftui-updates table ──────────────────────────────────────────
function ingestSwiftui(rows: Array<{ desc: string; durNs: number }>): ReturnType<typeof openSessionDb> {
  const db = openSessionDb(":memory:", { journalMode: "default" });
  const cols: SchemaCol[] = [
    { mnemonic: "description", name: "Description", engineeringType: "string" },
    { mnemonic: "duration", name: "Duration", engineeringType: "duration" },
  ];
  const w = new SqliteTableWriter(db, "tbl", cols);
  for (const r of rows) {
    const row: NormalizedRow = {
      description: { type: "string", fmt: r.desc, raw: r.desc },
      duration: { type: "duration", fmt: `${(r.durNs / 1e6).toFixed(2)} ms`, raw: r.durNs },
    };
    w.writeRow(row);
  }
  w.finish();
  return db;
}
const ctxFor = (db: ReturnType<typeof openSessionDb>): DetectorContext => ({
  db,
  sessionId: "",
  run: 1,
  tableName: () => "tbl",
});

describe("PMT:pure-hail framework ranking", () => {
  it("scores by geometric mean of exceedance; over ≥1, under <1", () => {
    expect(scoreOf([{ metric: "count", value: 1000, threshold: 100, direction: "over" }])).toBeCloseTo(10, 5);
    // geomean of 11.34 and 1.08 ≈ 3.5
    expect(
      scoreOf([
        { metric: "count", value: 1134, threshold: 100, direction: "over" },
        { metric: "ms", value: 162, threshold: 150, direction: "over" },
      ])
    ).toBeCloseTo(Math.sqrt(11.34 * 1.08), 1);
    // a near-miss below the bar scores <1
    expect(scoreOf([{ metric: "ms", value: 15, threshold: 16.67, direction: "under" }])).toBeLessThan(1);
  });

  it("buckets severity from score, not from the detector", () => {
    expect(severityOf(10)).toBe("high");
    expect(severityOf(3)).toBe("medium");
    expect(severityOf(0.9)).toBe("low");
  });

  it("renders criterion text from the structured conditions", () => {
    expect(
      criterionText([
        { metric: "count", value: 1134, threshold: 100, direction: "over" },
        { metric: "sum(duration) ms", value: 162, threshold: 150, direction: "over" },
      ])
    ).toBe("count 1,134 over 100 AND sum(duration) ms 162 over 150");
  });
});

describe("PMT:pure-hail runner gating + isolation", () => {
  const fire = (id: string, score: number): Detector => ({
    id,
    title: id,
    requiredSchemas: ["swiftui-updates"],
    cost: "cheap",
    run: () => ({
      summary: id,
      firing: [{ metric: "x", value: score, threshold: 1, direction: "over" }],
      callSpec: { verb: "query", schema: "swiftui-updates", args: {} },
      handles: [],
    }),
  });

  it("only runs cheap detectors whose schemas are all present, ranked most-alarming first", () => {
    const db = ingestSwiftui([{ desc: "A", durNs: 1 }]);
    const detectors: Detector[] = [
      fire("low", 2),
      fire("high", 9),
      { ...fire("expensive-skip", 100), cost: "expensive" },
      { ...fire("gated-out", 5), requiredSchemas: ["not-present"] },
    ];
    const ranked = runCheapDetectors(detectors, ctxFor(db), new Set(["swiftui-updates"]));
    expect(ranked.map((r) => r.detectorId)).toEqual(["high", "low"]); // expensive + gated excluded; sorted by score
  });

  it("skips a detector that throws — never breaks the run", () => {
    const db = ingestSwiftui([{ desc: "A", durNs: 1 }]);
    const boom: Detector = {
      id: "boom",
      title: "boom",
      requiredSchemas: ["swiftui-updates"],
      cost: "cheap",
      run: () => {
        throw new Error("detector bug");
      },
    };
    const ranked = runCheapDetectors([boom, fire("ok", 3)], ctxFor(db), new Set(["swiftui-updates"]));
    expect(ranked.map((r) => r.detectorId)).toEqual(["ok"]);
  });
});

describe("PMT:pure-hail surfacing (findingToNextAction)", () => {
  const rf = (callSpec: RankedFinding["callSpec"]): RankedFinding => ({
    detectorId: "d", title: "D", summary: "SidebarRow.body storm", criterion: "count 1,000 over 100",
    severity: "high", score: 10, callSpec, handles: [],
  });

  it("maps a single-schema verb's callSpec to an invokable NextAction (sessionId + schema injected)", () => {
    const na = findingToNextAction(rf({ verb: "aggregate", schema: "swiftui-updates", args: { groupBy: "description", op: "sum" } }), "sess1");
    expect(na.tool).toBe("aggregate");
    expect(na.args).toEqual({ sessionId: "sess1", schema: "swiftui-updates", groupBy: "description", op: "sum" });
    expect(na.description).toContain("SidebarRow.body storm");
    expect(na.description).toContain("count 1,000 over 100");
  });

  it("does not inject a plain `schema` arg for relate (it carries its own schema params)", () => {
    const na = findingToNextAction(rf({ verb: "relate", schema: "A", args: { schemaA: "A", schemaB: "B" } }), "sess1");
    expect(na.args).toEqual({ sessionId: "sess1", schemaA: "A", schemaB: "B" });
  });
});

describe("PMT:pure-hail example detector (swiftui-over-invalidation)", () => {
  it("fires on an over-invalidated view with a structured finding", () => {
    const rows = [
      ...Array.from({ length: 1134 }, () => ({ desc: "SidebarRow.body", durNs: 143_000 })), // ~162ms total
      ...Array.from({ length: 10 }, () => ({ desc: "Button.body", durNs: 1_000_000 })),
    ];
    const db = ingestSwiftui(rows);
    const ranked = runCheapDetectors(DETECTORS, ctxFor(db), new Set(["swiftui-updates"]));
    expect(ranked.length).toBe(1);
    const f = ranked[0];
    expect(f.detectorId).toBe("swiftui-over-invalidation");
    expect(f.summary).toContain("SidebarRow.body");
    expect(f.criterion).toContain("over");
    expect(f.callSpec).toEqual({ verb: "aggregate", schema: "swiftui-updates", args: { groupBy: "description", measure: "duration", op: "sum", topN: 10 } });
    expect(f.handles[0]).toMatchObject({ kind: "row", schema: "swiftui-updates" });
  });

  it("does not fire when no view crosses the thresholds", () => {
    const db = ingestSwiftui(Array.from({ length: 20 }, () => ({ desc: "Small.body", durNs: 1_000_000 })));
    const ranked = runCheapDetectors(DETECTORS, ctxFor(db), new Set(["swiftui-updates"]));
    expect(ranked).toEqual([]);
  });
});
