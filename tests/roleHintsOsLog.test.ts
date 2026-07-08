/**
 * PMT:full-trace — os-log roleHints entry.
 *
 * Verifies the curated os-log hint against the REAL column shape (verified
 * live 2026-07-08 against an Animation Hitches recording, Xcode 27/xctrace
 * 16.0): time, thread, process, message-type, format-string, backtrace,
 * subsystem, category, message, emit-location.
 *
 * The generic engineering-type heuristics already classify every one of these
 * columns correctly with NO roleHints entry at all (checked directly against
 * classifyWithHints before adding the entry) — so this pin's job isn't fixing
 * a misclassification, it's making list_instruments' hasCallstack flag true.
 * hasPinnedBacktraceColumn (listInstruments.ts) checks ONLY the curated table,
 * never the heuristic layer, so without this entry os-log would report
 * hasCallstack:false despite genuinely carrying a resolvable text-backtrace.
 */
import { describe, it, expect } from "vitest";
import { hintFor, classifyWithHints } from "../src/engine/roleHints.js";
import type { SchemaCol } from "../src/engine/parseTable.js";

// The exact real column shape, verified live against a real trace's TOC export.
const REAL_OS_LOG_COLUMNS: SchemaCol[] = [
  { mnemonic: "time", name: "Timestamp", engineeringType: "event-time" },
  { mnemonic: "thread", name: "Thread", engineeringType: "thread" },
  { mnemonic: "process", name: "Process", engineeringType: "process" },
  { mnemonic: "message-type", name: "Type", engineeringType: "event-type" },
  { mnemonic: "format-string", name: "Format String", engineeringType: "format-string" },
  { mnemonic: "backtrace", name: "Backtrace", engineeringType: "text-backtrace" },
  { mnemonic: "subsystem", name: "Subsystem", engineeringType: "subsystem" },
  { mnemonic: "category", name: "Category", engineeringType: "category" },
  { mnemonic: "message", name: "Message", engineeringType: "os-log-metadata" },
  { mnemonic: "emit-location", name: "Emit Location", engineeringType: "return-location" },
];

describe("PMT:full-trace os-log roleHints", () => {
  it("has a curated hint with primaryTime pinned to time", () => {
    const hint = hintFor("os-log");
    expect(hint).toBeDefined();
    expect(hint!.primaryTime).toBe("time");
  });

  it("has a backtrace-role column — closes the hasCallstack gap in list_instruments", () => {
    const hint = hintFor("os-log")!;
    const hasBacktrace = Object.values(hint.columns).some((c) => c.role === "backtrace");
    expect(hasBacktrace).toBe(true);
  });

  it("classifies subsystem and category as label — reachable via find()/query without a bespoke lens verb", () => {
    const classified = classifyWithHints("os-log", REAL_OS_LOG_COLUMNS);
    const bySchema = Object.fromEntries(classified.map((c) => [c.mnemonic, c.roleInfo.role]));
    expect(bySchema.subsystem).toBe("label");
    expect(bySchema.category).toBe("label");
  });

  it("classifies backtrace as backtrace, thread/process as thread, verbose columns as detail", () => {
    const classified = classifyWithHints("os-log", REAL_OS_LOG_COLUMNS);
    const bySchema = Object.fromEntries(classified.map((c) => [c.mnemonic, c.roleInfo.role]));
    expect(bySchema.backtrace).toBe("backtrace");
    expect(bySchema.thread).toBe("thread");
    expect(bySchema.process).toBe("thread");
    expect(bySchema.message).toBe("detail");
    expect(bySchema["format-string"]).toBe("detail");
    expect(bySchema["emit-location"]).toBe("detail");
  });
});
