/**
 * PMT:flint-larch — unit tests for the corpus detectors built on top of the
 * PMT:pure-hail framework (swiftui-over-invalidation, detector #1, is already
 * covered by tests/detectors.test.ts). Follows that file's pattern exactly:
 * synthetic tables via SqliteTableWriter, a DetectorContext over an in-memory
 * db, one test that FIRES on data crossing the threshold and one that does
 * NOT fire below it. Expensive detectors are called directly (run(ctx)) since
 * runCheapDetectors only drives the cheap tier. core-data-fetch-n-plus-one
 * (PMT:thick-gull) was added later, same pattern.
 */
import { describe, it, expect } from "vitest";
import { openSessionDb, SqliteTableWriter } from "../src/engine/sqliteStore.js";
import { registerPercentileUdfs } from "../src/engine/sqlHydrate.js";
import type { SchemaCol, NormalizedRow } from "../src/engine/parseTable.js";
import { runCheapDetectors, type DetectorContext } from "../src/detectors/index.js";
import { animationHitchesDistribution } from "../src/detectors/animationHitchesDistribution.js";
import { swiftuiRebuildStorm } from "../src/detectors/swiftuiRebuildStorm.js";
import { allocationsGrowth } from "../src/detectors/allocationsGrowth.js";
import { hitchCauseSplit } from "../src/detectors/hitchCauseSplit.js";
import { leakAllocWithoutFree } from "../src/detectors/leakAllocWithoutFree.js";
import { runloopContainsBodyEval } from "../src/detectors/runloopContainsBodyEval.js";
import { fmPromptCachingMiss } from "../src/detectors/fmPromptCachingMiss.js";
import { fmMainActorSaturation } from "../src/detectors/fmMainActorSaturation.js";
import { coreDataFetchNPlusOne } from "../src/detectors/coreDataFetchNPlusOne.js";

type Row = Record<string, { type: string; fmt: string | number; raw: string | number }>;

/** Build a SchemaCol[] from a plain mnemonic->engineeringType map. */
function colsOf(shape: Record<string, string>): SchemaCol[] {
  return Object.entries(shape).map(([mnemonic, engineeringType]) => ({ mnemonic, name: mnemonic, engineeringType }));
}

/** Ingest one synthetic schema into a shared db, keyed by its schema name as the physical table name. */
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

describe("animation-hitches-distribution (expensive: percentile UDF)", () => {
  const COLS = colsOf({ start: "start-time", duration: "duration", "is-system": "string" });

  function hitchRows(durationsMs: number[]): Row[] {
    return durationsMs.map((ms, i) => ({
      start: cell("start-time", i * 100_000_000),
      duration: cell("duration", Math.round(ms * 1e6)),
      "is-system": cell("string", "No"),
    }));
  }

  it("fires when p95 crosses the 33ms band", () => {
    const db = newDb();
    registerPercentileUdfs(db);
    const durations = [...Array(17).fill(10), ...Array(3).fill(40)]; // p95 (rank19/20) lands on 40ms
    ingest(db, "hitches", COLS, hitchRows(durations));
    const ranked = runCheapDetectors([animationHitchesDistribution], ctxFor(db), new Set(["hitches"]));
    // expensive — not run by runCheapDetectors; call directly.
    const finding = animationHitchesDistribution.run(ctxFor(db));
    expect(ranked).toEqual([]); // sanity: expensive detectors never run eager
    expect(finding).not.toBeNull();
    expect(finding!.summary).toContain("hitches");
    expect(finding!.firing.some((f) => f.metric === "p95 duration ms" && f.direction === "over")).toBe(true);
    expect(finding!.handles[0]).toMatchObject({ kind: "row", schema: "hitches" });
  });

  it("does not fire when all durations are well under the band", () => {
    const db = newDb();
    registerPercentileUdfs(db);
    ingest(db, "hitches", COLS, hitchRows(Array(20).fill(10)));
    expect(animationHitchesDistribution.run(ctxFor(db))).toBeNull();
  });
});

describe("swiftui-rebuild-storm (expensive: window LAG)", () => {
  const COLS = colsOf({ start: "start-time", description: "string" });

  it("fires on a dense (<1ms) re-invalidation burst", () => {
    const db = newDb();
    const rows: Row[] = Array.from({ length: 60 }, (_, i) => ({
      start: cell("start-time", i * 500_000), // 0.5ms apart — dense
      description: cell("string", "SidebarRow.body"),
    }));
    ingest(db, "swiftui-updates", COLS, rows);
    const finding = swiftuiRebuildStorm.run(ctxFor(db));
    expect(finding).not.toBeNull();
    expect(finding!.summary).toContain("SidebarRow.body");
    expect(finding!.firing[0]).toMatchObject({ metric: "dense (<1ms) inter-arrival count", direction: "over" });
    expect(finding!.handles.some((h) => h.kind === "window")).toBe(true);
  });

  it("does not fire when re-evaluations are spread out (no dense burst)", () => {
    const db = newDb();
    const rows: Row[] = Array.from({ length: 60 }, (_, i) => ({
      start: cell("start-time", i * 5_000_000), // 5ms apart — not dense
      description: cell("string", "SidebarRow.body"),
    }));
    ingest(db, "swiftui-updates", COLS, rows);
    expect(swiftuiRebuildStorm.run(ctxFor(db))).toBeNull();
  });
});

describe("allocations-growth (expensive: running-total window)", () => {
  const SCHEMA = "Allocations/Allocations List";
  const COLS = colsOf({ timestamp: "start-time", size: "uint64", category: "string" });

  function rows(sizesBytes: number[]): Row[] {
    return sizesBytes.map((sz, i) => ({
      timestamp: cell("start-time", i * 1_000_000),
      size: cell("uint64", sz),
      category: cell("string", "Malloc 32 Bytes"),
    }));
  }

  it("fires when the cumulative high-water mark crosses 50MB", () => {
    const db = newDb();
    ingest(db, SCHEMA, COLS, rows(Array(10).fill(6_000_000))); // 60MB total
    const finding = allocationsGrowth.run(ctxFor(db));
    expect(finding).not.toBeNull();
    expect(finding!.firing[0]).toMatchObject({ metric: "peak cumulative bytes", direction: "over" });
    expect(finding!.handles.length).toBeGreaterThan(0);
  });

  it("does not fire when total growth stays under 50MB", () => {
    const db = newDb();
    ingest(db, SCHEMA, COLS, rows(Array(10).fill(1_000_000))); // 10MB total
    expect(allocationsGrowth.run(ctxFor(db))).toBeNull();
  });
});

describe("hitch-cause-split (expensive: time-range anti-join)", () => {
  const HITCH_COLS = colsOf({ start: "start-time", duration: "duration", "is-system": "string" });
  const TS_COLS = colsOf({ time: "start-time", "thread-state": "string" });

  function hitchRows(n: number): Row[] {
    return Array.from({ length: n }, (_, i) => ({
      start: cell("start-time", i * 100_000_000), // 100ms apart, non-overlapping windows
      duration: cell("duration", 5_000_000), // 5ms
      "is-system": cell("string", "No"),
    }));
  }

  it("fires when many hitches have no CPU sample in-window (GPU-bound)", () => {
    const db = newDb();
    ingest(db, "hitches", HITCH_COLS, hitchRows(20));
    // Only the first 5 hitches get a Running sample inside their window — 15 GPU-bound.
    const tsRows: Row[] = Array.from({ length: 5 }, (_, i) => ({
      time: cell("start-time", i * 100_000_000 + 1_000_000),
      "thread-state": cell("string", "Running"),
    }));
    ingest(db, "time-sample", TS_COLS, tsRows);
    const finding = hitchCauseSplit.run(ctxFor(db));
    expect(finding).not.toBeNull();
    expect(finding!.firing[0]).toMatchObject({ metric: "GPU-bound hitch count", value: 15, direction: "over" });
    expect(finding!.handles[0]).toMatchObject({ kind: "row", schema: "hitches" });
  });

  it("does not fire when every hitch has a CPU sample in-window", () => {
    const db = newDb();
    ingest(db, "hitches", HITCH_COLS, hitchRows(20));
    const tsRows: Row[] = Array.from({ length: 20 }, (_, i) => ({
      time: cell("start-time", i * 100_000_000 + 1_000_000),
      "thread-state": cell("string", "Running"),
    }));
    ingest(db, "time-sample", TS_COLS, tsRows);
    expect(hitchCauseSplit.run(ctxFor(db))).toBeNull();
  });
});

describe("leak-alloc-without-free (cheap: single-table live-flag filter)", () => {
  const SCHEMA = "Allocations/Allocations List";
  const COLS = colsOf({ size: "uint64", live: "string", category: "string" });

  function rows(n: number, live: string): Row[] {
    return Array.from({ length: n }, () => ({
      size: cell("uint64", 10_000),
      live: cell("string", live),
      category: cell("string", "Malloc 32 Bytes"),
    }));
  }

  it("fires when unfreed allocations cross count + bytes bands", () => {
    const db = newDb();
    ingest(db, SCHEMA, COLS, rows(2000, "true")); // 2000 * 10,000 = 20MB
    const ranked = runCheapDetectors([leakAllocWithoutFree], ctxFor(db), new Set([SCHEMA]));
    expect(ranked.length).toBe(1);
    expect(ranked[0].detectorId).toBe("leak-alloc-without-free");
    expect(ranked[0].criterion).toContain("over");
    expect(ranked[0].handles[0]).toMatchObject({ kind: "row", schema: SCHEMA });
  });

  it("does not fire when allocations were all freed (live=false)", () => {
    const db = newDb();
    ingest(db, SCHEMA, COLS, rows(2000, "false"));
    const ranked = runCheapDetectors([leakAllocWithoutFree], ctxFor(db), new Set([SCHEMA]));
    expect(ranked).toEqual([]);
  });
});

describe("runloop-contains-body-eval (expensive: time-range EXISTS full-population)", () => {
  const RUNLOOP_COLS = colsOf({ start: "start-time", duration: "duration", "interval-type": "string", "is-main": "string" });
  const SWIFTUI_COLS = colsOf({ start: "start-time", "update-type": "string" });

  function runloopRows(n: number): Row[] {
    return Array.from({ length: n }, (_, i) => ({
      start: cell("start-time", i * 100_000_000),
      duration: cell("duration", 5_000_000),
      "interval-type": cell("string", "Busy"),
      "is-main": cell("string", "Yes"),
    }));
  }

  it("fires when many busy main-thread turns contain a body-update eval", () => {
    const db = newDb();
    ingest(db, "runloop-intervals", RUNLOOP_COLS, runloopRows(60));
    const suiRows: Row[] = Array.from({ length: 60 }, (_, i) => ({
      start: cell("start-time", i * 100_000_000 + 1_000_000), // inside each runloop turn's window
      "update-type": cell("string", "View Body Updates"),
    }));
    ingest(db, "swiftui-updates", SWIFTUI_COLS, suiRows);
    const finding = runloopContainsBodyEval.run(ctxFor(db));
    expect(finding).not.toBeNull();
    expect(finding!.firing[0]).toMatchObject({ metric: "containing runloop turns", value: 60, direction: "over" });
    expect(finding!.handles[0]).toMatchObject({ kind: "window", schema: "runloop-intervals" });
  });

  it("does not fire when body-update evals never fall inside a busy main-thread turn", () => {
    const db = newDb();
    ingest(db, "runloop-intervals", RUNLOOP_COLS, runloopRows(60));
    const suiRows: Row[] = Array.from({ length: 60 }, (_, i) => ({
      start: cell("start-time", i * 100_000_000 + 50_000_000), // well outside any 5ms-long turn
      "update-type": cell("string", "View Body Updates"),
    }));
    ingest(db, "swiftui-updates", SWIFTUI_COLS, suiRows);
    expect(runloopContainsBodyEval.run(ctxFor(db))).toBeNull();
  });
});

describe("fm-prompt-caching-miss (cheap: single-table filtered count)", () => {
  const SCHEMA = "ModelInferenceTable";
  const COLS = colsOf({ "cached-tokens": "uint64", "total-tokens": "uint64", "agent-name": "string" });

  function rows(n: number, cachedTokens: number): Row[] {
    return Array.from({ length: n }, () => ({
      "cached-tokens": cell("uint64", cachedTokens),
      "total-tokens": cell("uint64", 100),
      "agent-name": cell("string", "MainAgent"),
    }));
  }

  it("fires when cache-miss count and rate both cross their bands", () => {
    const db = newDb();
    const missRows = rows(20, 0);
    const hitRows = rows(10, 50);
    ingest(db, SCHEMA, COLS, [...missRows, ...hitRows]); // 20/30 misses = 67%
    const ranked = runCheapDetectors([fmPromptCachingMiss], ctxFor(db), new Set([SCHEMA]));
    expect(ranked.length).toBe(1);
    expect(ranked[0].criterion).toContain("cache-miss count");
  });

  it("does not fire when nearly every request reuses the cache", () => {
    const db = newDb();
    const missRows = rows(2, 0);
    const hitRows = rows(50, 50);
    ingest(db, SCHEMA, COLS, [...missRows, ...hitRows]);
    const ranked = runCheapDetectors([fmPromptCachingMiss], ctxFor(db), new Set([SCHEMA]));
    expect(ranked).toEqual([]);
  });
});

describe("fm-main-actor-saturation (cheap: single-table MAX + filtered count)", () => {
  const SCHEMA = "SwiftActorQueueSize";
  const COLS = colsOf({ start: "start-time", count: "uint64", actor: "string" });

  function rows(n: number, depth: number): Row[] {
    return Array.from({ length: n }, (_, i) => ({
      start: cell("start-time", i * 1_000_000),
      count: cell("uint64", depth),
      actor: cell("string", "MainActor"),
    }));
  }

  it("fires when queue depth is deep and sustained", () => {
    const db = newDb();
    ingest(db, SCHEMA, COLS, rows(25, 15)); // depth 15 > 10, 25 samples > 20
    const ranked = runCheapDetectors([fmMainActorSaturation], ctxFor(db), new Set([SCHEMA]));
    expect(ranked.length).toBe(1);
    expect(ranked[0].criterion).toContain("peak queue depth");
  });

  it("does not fire when queue depth stays shallow", () => {
    const db = newDb();
    ingest(db, SCHEMA, COLS, rows(25, 3));
    const ranked = runCheapDetectors([fmMainActorSaturation], ctxFor(db), new Set([SCHEMA]));
    expect(ranked).toEqual([]);
  });
});

describe("core-data-fetch-n-plus-one (cheap: single-table GROUP BY + HAVING)", () => {
  const SCHEMA = "core-data-fetch";
  const COLS = colsOf({ "fetch-entity": "string", "fetch-count": "uint64" });

  function fetchRows(entity: string, n: number, objectsPerCall: number): Row[] {
    return Array.from({ length: n }, () => ({
      "fetch-entity": cell("string", entity),
      "fetch-count": cell("uint64", objectsPerCall),
    }));
  }

  it("fires for many small fetches of the same entity (real-trace-calibrated: 830 calls avg 1.00)", () => {
    const db = newDb();
    ingest(db, SCHEMA, COLS, [
      ...fetchRows("Prompt", 30, 1),
      ...fetchRows("Project", 5, 8), // legitimate small bulk fetch — should not distract
    ]);
    const ranked = runCheapDetectors([coreDataFetchNPlusOne], ctxFor(db), new Set([SCHEMA]));
    expect(ranked.length).toBe(1);
    expect(ranked[0].summary).toContain("Prompt");
    expect(ranked[0].criterion).toContain("fetch calls");
  });

  it("does not fire for a legitimate bulk fetch (many calls, but each returns plenty of objects)", () => {
    const db = newDb();
    ingest(db, SCHEMA, COLS, fetchRows("Project", 30, 8));
    const ranked = runCheapDetectors([coreDataFetchNPlusOne], ctxFor(db), new Set([SCHEMA]));
    expect(ranked).toEqual([]);
  });

  it("does not fire when call count is too low to be a storm, even at 1 object/call", () => {
    const db = newDb();
    ingest(db, SCHEMA, COLS, fetchRows("MediaAttachment", 5, 1));
    const ranked = runCheapDetectors([coreDataFetchNPlusOne], ctxFor(db), new Set([SCHEMA]));
    expect(ranked).toEqual([]);
  });
});
