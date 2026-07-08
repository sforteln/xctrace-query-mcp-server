/**
 * PMT:lean-knoll — unit tests for the two QoS/priority "narrow"-layer
 * detectors. Follows tests/detectorsCorpus.test.ts's exact pattern: synthetic
 * tables via SqliteTableWriter, a DetectorContext over an in-memory db, one
 * test that FIRES on data crossing the threshold and one that does NOT.
 */
import { describe, it, expect } from "vitest";
import { openSessionDb, SqliteTableWriter } from "../src/engine/sqliteStore.js";
import type { SchemaCol, NormalizedRow } from "../src/engine/parseTable.js";
import { runCheapDetectors, type DetectorContext } from "../src/detectors/index.js";
import { qosMismatch } from "../src/detectors/qosMismatch.js";
import { priorityInversion } from "../src/detectors/priorityInversion.js";

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

describe("qos-classes-mismatch (cheap: single-table label filter)", () => {
  const QOS_COLS = colsOf({
    start: "start-time",
    duration: "duration",
    process: "string",
    thread: "string",
    "requested-qo-s": "string",
    "effective-qo-s": "string",
    "mismatch-qo-s": "string",
  });
  const RUNLOOP_EVENTS_COLS = colsOf({ thread: "string", "is-main": "string" });

  it("fires and flags the MAIN thread when the mismatched thread is the identified main thread", () => {
    const db = newDb();
    ingest(db, "ThreadQoSTable", QOS_COLS, [
      {
        start: cell("start-time", 525_659_958),
        duration: cell("duration", 42),
        process: cell("string", "PromptManager (48641)"),
        thread: cell("string", "main-tid-1"),
        "requested-qo-s": cell("string", "Unspecified"),
        "effective-qo-s": cell("string", "Background"),
        "mismatch-qo-s": cell("string", "QoS classes mismatch"),
      },
    ]);
    ingest(db, "runloop-events", RUNLOOP_EVENTS_COLS, [
      { thread: cell("string", "main-tid-1"), "is-main": cell("string", "Yes") },
    ]);

    const ranked = runCheapDetectors([qosMismatch], ctxFor(db), new Set(["ThreadQoSTable", "runloop-events"]));
    expect(ranked.length).toBe(1);
    expect(ranked[0].detectorId).toBe("qos-classes-mismatch");

    const finding = qosMismatch.run(ctxFor(db));
    expect(finding).not.toBeNull();
    expect(finding!.summary).toContain("MAIN thread");
    expect(finding!.summary).toContain("Unspecified");
    expect(finding!.summary).toContain("Background");
    expect(finding!.severity).toBe("high");
    expect(finding!.handles.some((h) => h.kind === "window" && h.schema === "ThreadActivity")).toBe(true);
  });

  it("fires but does not flag main thread when the mismatched thread isn't the identified main thread", () => {
    const db = newDb();
    ingest(db, "ThreadQoSTable", QOS_COLS, [
      {
        start: cell("start-time", 0),
        duration: cell("duration", 1000),
        process: cell("string", "PromptManager (48641)"),
        thread: cell("string", "worker-tid-2"),
        "requested-qo-s": cell("string", "Unspecified"),
        "effective-qo-s": cell("string", "Background"),
        "mismatch-qo-s": cell("string", "QoS classes mismatch"),
      },
    ]);
    ingest(db, "runloop-events", RUNLOOP_EVENTS_COLS, [
      { thread: cell("string", "main-tid-1"), "is-main": cell("string", "Yes") },
    ]);

    const finding = qosMismatch.run(ctxFor(db));
    expect(finding).not.toBeNull();
    expect(finding!.summary).not.toContain("MAIN thread");
    expect(finding!.severity).toBeUndefined();
  });

  it("does not fire when no thread has a QoS classes mismatch", () => {
    const db = newDb();
    ingest(db, "ThreadQoSTable", QOS_COLS, [
      {
        start: cell("start-time", 0),
        duration: cell("duration", 1000),
        process: cell("string", "PromptManager (48641)"),
        thread: cell("string", "main-tid-1"),
        "requested-qo-s": cell("string", "Unspecified"),
        "effective-qo-s": cell("string", "Unspecified"),
        "mismatch-qo-s": cell("string", "No mismatch"),
      },
    ]);
    ingest(db, "runloop-events", RUNLOOP_EVENTS_COLS, [
      { thread: cell("string", "main-tid-1"), "is-main": cell("string", "Yes") },
    ]);

    const ranked = runCheapDetectors([qosMismatch], ctxFor(db), new Set(["ThreadQoSTable", "runloop-events"]));
    expect(ranked).toEqual([]);
    expect(qosMismatch.run(ctxFor(db))).toBeNull();
  });
});

describe("thread-priority-inversion (cheap: single-table cross-column comparison)", () => {
  const COLS = colsOf({
    start: "start-time",
    duration: "duration",
    process: "string",
    thread: "string",
    "scheduled-priority": "uint64",
    "base-priority": "uint64",
  });

  function row(scheduled: number, base: number, durationNs: number): Row {
    return {
      start: cell("start-time", 0),
      duration: cell("duration", durationNs),
      process: cell("string", "PromptManager (48641)"),
      thread: cell("string", "worker-tid-3"),
      "scheduled-priority": cell("uint64", scheduled),
      "base-priority": cell("uint64", base),
    };
  }

  it("fires when scheduled sits below base for a sustained (>50ms) window", () => {
    const db = newDb();
    ingest(db, "ThreadPriority", COLS, [row(10, 40, 100_000_000)]); // 100ms, well above the 50ms bar
    const ranked = runCheapDetectors([priorityInversion], ctxFor(db), new Set(["ThreadPriority"]));
    expect(ranked.length).toBe(1);
    expect(ranked[0].detectorId).toBe("thread-priority-inversion");

    const finding = priorityInversion.run(ctxFor(db));
    expect(finding).not.toBeNull();
    expect(finding!.firing[0]).toMatchObject({ metric: "longest inversion duration ms", direction: "over" });
    expect(finding!.firing[0].value).toBeCloseTo(100, 0);
  });

  it("does not fire when scheduled is at or above base (a boost, not an inversion)", () => {
    const db = newDb();
    ingest(db, "ThreadPriority", COLS, [row(46, 31, 100_000_000)]); // scheduled > base — real data shape seen live
    expect(priorityInversion.run(ctxFor(db))).toBeNull();
  });

  it("does not fire when the inversion window is below the meaningful-duration threshold", () => {
    const db = newDb();
    ingest(db, "ThreadPriority", COLS, [row(10, 40, 1_000_000)]); // 1ms — a routine blip, not sustained
    expect(priorityInversion.run(ctxFor(db))).toBeNull();
  });
});
