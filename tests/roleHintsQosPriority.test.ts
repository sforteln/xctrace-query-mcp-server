/**
 * PMT:lean-knoll — ThreadQoSTable / ThreadPriority roleHints entries.
 *
 * Verified live 2026-07-08 (read-only xctrace export against a real trace,
 * 2026-07-07T20-27-57-animation-hitches.trace). UNLIKE several earlier
 * entries this session (os-log, runloop-intervals), heuristics do NOT
 * already classify these columns correctly — none of requested-qo-s/
 * effective-qo-s/mismatch-qo-s/scheduled-priority/base-priority match any
 * mnemonic heuristic pattern, so without this pin every one of them defaults
 * to "detail". This pin is a genuine correctness fix, not just a friendly-
 * name/gate-closer.
 */
import { describe, it, expect } from "vitest";
import { hintFor, classifyWithHints } from "../src/engine/roleHints.js";
import type { SchemaCol } from "../src/engine/parseTable.js";

const REAL_THREAD_QOS_COLUMNS: SchemaCol[] = [
  { mnemonic: "start", name: "Start", engineeringType: "start-time" },
  { mnemonic: "duration", name: "Duration", engineeringType: "duration" },
  { mnemonic: "process", name: "Process", engineeringType: "process" },
  { mnemonic: "thread", name: "Thread", engineeringType: "thread" },
  { mnemonic: "requested-qo-s", name: "Requested QoS", engineeringType: "quality-of-service-class" },
  { mnemonic: "effective-qo-s", name: "Effective QoS", engineeringType: "quality-of-service-class" },
  { mnemonic: "mismatch-qo-s", name: "Mismatch Qo S", engineeringType: "state" },
];

const REAL_THREAD_PRIORITY_COLUMNS: SchemaCol[] = [
  { mnemonic: "start", name: "Start", engineeringType: "start-time" },
  { mnemonic: "duration", name: "Duration", engineeringType: "duration" },
  { mnemonic: "process", name: "Process", engineeringType: "process" },
  { mnemonic: "thread", name: "Thread", engineeringType: "thread" },
  { mnemonic: "scheduled-priority", name: "Scheduled Priority", engineeringType: "sched-priority" },
  { mnemonic: "base-priority", name: "Base Priority", engineeringType: "sched-priority" },
];

describe("PMT:lean-knoll ThreadQoSTable roleHints", () => {
  it("has a curated hint with primaryTime/primaryWeight pinned", () => {
    const hint = hintFor("ThreadQoSTable");
    expect(hint).toBeDefined();
    expect(hint!.primaryTime).toBe("start");
    expect(hint!.primaryWeight).toBe("duration");
  });

  it("classifies requested-qo-s/effective-qo-s/mismatch-qo-s as label — heuristics alone would default all three to detail", () => {
    const classified = classifyWithHints("ThreadQoSTable", REAL_THREAD_QOS_COLUMNS);
    const byMnemonic = Object.fromEntries(classified.map((c) => [c.mnemonic, c.roleInfo.role]));
    expect(byMnemonic["requested-qo-s"]).toBe("label");
    expect(byMnemonic["effective-qo-s"]).toBe("label");
    expect(byMnemonic["mismatch-qo-s"]).toBe("label");
  });

  it("classifies duration as weight/nanoseconds, thread/process as thread", () => {
    const classified = classifyWithHints("ThreadQoSTable", REAL_THREAD_QOS_COLUMNS);
    const byMnemonic = Object.fromEntries(classified.map((c) => [c.mnemonic, c.roleInfo]));
    expect(byMnemonic.duration.role).toBe("weight");
    expect(byMnemonic.duration.unit).toBe("nanoseconds");
    expect(byMnemonic.thread.role).toBe("thread");
    expect(byMnemonic.process.role).toBe("thread");
  });
});

describe("PMT:lean-knoll ThreadPriority roleHints", () => {
  it("has a curated hint with primaryTime/primaryWeight pinned", () => {
    const hint = hintFor("ThreadPriority");
    expect(hint).toBeDefined();
    expect(hint!.primaryTime).toBe("start");
    expect(hint!.primaryWeight).toBe("duration");
  });

  it("classifies scheduled-priority/base-priority as label — heuristics alone would default both to detail", () => {
    const classified = classifyWithHints("ThreadPriority", REAL_THREAD_PRIORITY_COLUMNS);
    const byMnemonic = Object.fromEntries(classified.map((c) => [c.mnemonic, c.roleInfo.role]));
    expect(byMnemonic["scheduled-priority"]).toBe("label");
    expect(byMnemonic["base-priority"]).toBe("label");
  });
});
