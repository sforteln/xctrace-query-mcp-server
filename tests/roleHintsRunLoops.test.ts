/**
 * PMT:steel-spruce — runloop-intervals / runloop-events roleHints entries.
 *
 * Verified live 2026-07-08 (xctrace record --instrument "Run Loops" --attach,
 * a real 5s recording against Finder, real .trace export): both schemas'
 * column shapes below, and the four real interval-type/event fmt values
 * (Runloop Run, Busy, Individual Iteration, Waiting For Events).
 *
 * The generic engineering-type/mnemonic heuristics already classify every
 * column here correctly with NO roleHints entry at all (checked directly
 * against classifyWithHints before adding the entry, same as os-log) — this
 * pin's real job is the friendly "Run Loops" instrument name (describeSchema's
 * `instrument` field has no other source) and pinning primaryTime/primaryWeight
 * explicitly against future heuristic drift.
 */
import { describe, it, expect } from "vitest";
import { hintFor, classifyWithHints } from "../src/engine/roleHints.js";
import type { SchemaCol } from "../src/engine/parseTable.js";

// The exact real column shape, verified live against a real trace's TOC export.
const REAL_RUNLOOP_INTERVALS_COLUMNS: SchemaCol[] = [
  { mnemonic: "start", name: "Start", engineeringType: "start-time" },
  { mnemonic: "duration", name: "Duration", engineeringType: "duration" },
  { mnemonic: "interval-type", name: "Runloop Interval", engineeringType: "short-string" },
  { mnemonic: "interval-identifier", name: "Interval Identifier", engineeringType: "short-string" },
  { mnemonic: "nesting-level", name: "Nesting Level", engineeringType: "uint64" },
  { mnemonic: "containment-level", name: "Containment Level", engineeringType: "containment-level" },
  { mnemonic: "mode", name: "RunLoop Mode", engineeringType: "medium-length-string" },
  { mnemonic: "is-main", name: "Main RunLoop", engineeringType: "boolean" },
  { mnemonic: "thread", name: "Thread", engineeringType: "thread" },
  { mnemonic: "process", name: "Process", engineeringType: "process" },
  { mnemonic: "runloop-pointer", name: "Runloop", engineeringType: "address" },
  { mnemonic: "timeout", name: "Timeout", engineeringType: "uint64" },
  { mnemonic: "run-result", name: "End Reason", engineeringType: "cfrunloop-result" },
  { mnemonic: "return-after-source-handled", name: "Return After Source Handled", engineeringType: "boolean" },
  { mnemonic: "waiting-on-ports", name: "Waiting on Ports", engineeringType: "mach-port" },
  { mnemonic: "received-port", name: "Received Port", engineeringType: "mach-port" },
  { mnemonic: "label", name: "Label", engineeringType: "string" },
  { mnemonic: "color", name: "Color", engineeringType: "event-concept" },
];

const REAL_RUNLOOP_EVENTS_COLUMNS: SchemaCol[] = [
  { mnemonic: "timestamp", name: "Timestamp", engineeringType: "event-time" },
  { mnemonic: "timestamp-accuracy", name: "Timestamp Accuracy", engineeringType: "string" },
  { mnemonic: "interval-type", name: "Runloop Interval", engineeringType: "short-string" },
  { mnemonic: "event-type", name: "Event Type", engineeringType: "kdebug-func" },
  { mnemonic: "interval-identifier", name: "Interval Identifier", engineeringType: "short-string" },
  { mnemonic: "nesting-level", name: "Nesting Level", engineeringType: "uint64" },
  { mnemonic: "mode", name: "RunLoop Mode", engineeringType: "medium-length-string" },
  { mnemonic: "is-main", name: "Main RunLoop", engineeringType: "boolean" },
  { mnemonic: "thread", name: "Thread", engineeringType: "thread" },
  { mnemonic: "runloop-pointer", name: "Runloop", engineeringType: "address" },
  { mnemonic: "timeout", name: "Timeout", engineeringType: "uint64" },
  { mnemonic: "other-arg", name: "Other Argument", engineeringType: "uint64" },
];

describe("PMT:steel-spruce runloop-intervals roleHints", () => {
  it("has a curated hint with primaryTime/primaryWeight pinned", () => {
    const hint = hintFor("runloop-intervals");
    expect(hint).toBeDefined();
    expect(hint!.primaryTime).toBe("start");
    expect(hint!.primaryWeight).toBe("duration");
    expect(hint!.instrument).toBe("Run Loops");
  });

  it("classifies interval-type and label as label, duration as weight/nanoseconds", () => {
    const classified = classifyWithHints("runloop-intervals", REAL_RUNLOOP_INTERVALS_COLUMNS);
    const byMnemonic = Object.fromEntries(classified.map((c) => [c.mnemonic, c.roleInfo]));
    expect(byMnemonic["interval-type"].role).toBe("label");
    expect(byMnemonic.label.role).toBe("label");
    expect(byMnemonic.color.role).toBe("label");
    expect(byMnemonic.duration.role).toBe("weight");
    expect(byMnemonic.duration.unit).toBe("nanoseconds");
  });

  it("classifies thread and process as thread, has no backtrace column", () => {
    const classified = classifyWithHints("runloop-intervals", REAL_RUNLOOP_INTERVALS_COLUMNS);
    const byMnemonic = Object.fromEntries(classified.map((c) => [c.mnemonic, c.roleInfo.role]));
    expect(byMnemonic.thread).toBe("thread");
    expect(byMnemonic.process).toBe("thread");
    expect(Object.values(byMnemonic)).not.toContain("backtrace");
  });

  it("classifies nesting-level/containment-level/mode as detail — not group/sort keys by default", () => {
    const classified = classifyWithHints("runloop-intervals", REAL_RUNLOOP_INTERVALS_COLUMNS);
    const byMnemonic = Object.fromEntries(classified.map((c) => [c.mnemonic, c.roleInfo.role]));
    expect(byMnemonic["nesting-level"]).toBe("detail");
    expect(byMnemonic["containment-level"]).toBe("detail");
    expect(byMnemonic.mode).toBe("detail");
  });

  it("classifies run-result as label — Apple documents cfrunloop-result as a 5-value end-reason enum (Engineering Type Reference audit correction)", () => {
    const classified = classifyWithHints("runloop-intervals", REAL_RUNLOOP_INTERVALS_COLUMNS);
    const byMnemonic = Object.fromEntries(classified.map((c) => [c.mnemonic, c.roleInfo.role]));
    // Both the pin and the type-level heuristic now agree: "group runs by why
    // they ended" is a legitimate aggregation the old detail classification
    // blocked.
    expect(byMnemonic["run-result"]).toBe("label");
  });
});

describe("PMT:steel-spruce runloop-events roleHints", () => {
  it("has a curated hint with primaryTime pinned to timestamp and no primaryWeight (point events, not intervals)", () => {
    const hint = hintFor("runloop-events");
    expect(hint).toBeDefined();
    expect(hint!.primaryTime).toBe("timestamp");
    expect(hint!.primaryWeight).toBeUndefined();
    expect(hint!.instrument).toBe("Run Loops");
  });

  it("classifies interval-type and event-type as label — the START/END boundary marker", () => {
    const classified = classifyWithHints("runloop-events", REAL_RUNLOOP_EVENTS_COLUMNS);
    const byMnemonic = Object.fromEntries(classified.map((c) => [c.mnemonic, c.roleInfo.role]));
    expect(byMnemonic["interval-type"]).toBe("label");
    expect(byMnemonic["event-type"]).toBe("label");
  });

  it("classifies thread as thread, has no backtrace or weight column", () => {
    const classified = classifyWithHints("runloop-events", REAL_RUNLOOP_EVENTS_COLUMNS);
    const roles = classified.map((c) => c.roleInfo.role);
    expect(roles).toContain("thread");
    expect(roles).not.toContain("backtrace");
    expect(roles).not.toContain("weight");
  });
});
