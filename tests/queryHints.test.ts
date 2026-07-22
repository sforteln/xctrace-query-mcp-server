/**
 * PMT:faint-trout — describe_schema's four-part queryHints (gross form / edges
 * / correlation / gotchas). Unit-tests buildQueryHints directly with synthetic
 * columns + curated-edge schema names (siblings resolve from their roleHints
 * pins, so only their NAME needs to be in presentSchemas). The curated-gotcha
 * referential guard lives in tests/driftGuard.test.ts.
 */
import { describe, it, expect } from "vitest";
import type { SchemaCol } from "../src/engine/parseTable.js";
import { buildQueryHints, CURATED_GOTCHAS } from "../src/core/queryHints.js";

const col = (mnemonic: string, engineeringType: string): SchemaCol => ({ mnemonic, name: mnemonic, engineeringType });

const base = {
  rowCount: 1234,
  primaryTime: "start" as string | null,
  primaryWeight: "duration" as string | null,
  presentSchemas: [] as string[],
};

describe("queryHints — gross form (grain inference)", () => {
  it("names a stack SAMPLE for a tagged-backtrace schema", () => {
    const h = buildQueryHints({ ...base, schema: "x", cols: [col("time", "sample-time"), col("stack", "tagged-backtrace"), col("weight", "weight")], presentSchemas: ["x"] });
    expect(h.grossForm).toMatch(/stack SAMPLE/);
  });
  it("names an INTERVAL for a start+duration schema", () => {
    const h = buildQueryHints({ ...base, schema: "x", cols: [col("start", "start-time"), col("duration", "duration")], presentSchemas: ["x"] });
    expect(h.grossForm).toMatch(/INTERVAL/);
  });
  it("names the kdebug begin/end/point grain for a kdebug-func + time schema", () => {
    const h = buildQueryHints({ ...base, schema: "x", cols: [col("timestamp", "event-time"), col("event-type", "kdebug-func")], primaryTime: "timestamp", presentSchemas: ["x"] });
    // Refined per the Engineering Type Reference audit: Apple's kdebug domain
    // is begin/end/POINT — point rows are standalone, not half of a pair.
    expect(h.grossForm).toMatch(/begin\/end rows come in PAIRS/);
    expect(h.grossForm).toMatch(/DOUBLE-COUNTS/);
    expect(h.grossForm).toMatch(/point events also exist/);
  });
  it("names a point event for a time-only schema and a plain record for neither", () => {
    expect(buildQueryHints({ ...base, schema: "x", cols: [col("time", "event-time")], primaryTime: "time", presentSchemas: ["x"] }).grossForm).toMatch(/point event/);
    expect(buildQueryHints({ ...base, schema: "x", cols: [col("label", "string")], primaryTime: null, primaryWeight: null, presentSchemas: ["x"] }).grossForm).toMatch(/plain record/);
  });
  it("reports the size tier and load-bearing columns", () => {
    const h = buildQueryHints({ ...base, schema: "x", cols: [col("start", "start-time"), col("duration", "duration"), col("name", "string")], rowCount: 600_000, presentSchemas: ["x"] });
    expect(h.grossForm).toMatch(/firehose/);
    expect(h.grossForm).toMatch(/time=start/);
    expect(h.grossForm).toMatch(/weight=duration/);
  });
});

const hitchesCols = [col("start", "start-time"), col("duration", "duration"), col("thread", "thread"), col("display", "display-name"), col("swap-id", "uint32")];

describe("queryHints — edges (from the schemaEdges registry)", () => {
  it("surfaces curated NEGATIVE edges (the swap-id and display-id traps)", () => {
    const h = buildQueryHints({ ...base, schema: "hitches", cols: hitchesCols, presentSchemas: ["hitches", "display-surface-swap", "device-display-info"] });
    expect(h.edges.some((e) => e.startsWith("✗ display-surface-swap"))).toBe(true);
    expect(h.edges.some((e) => e.startsWith("✗ device-display-info"))).toBe(true);
  });
  it("surfaces the curated anti-join (∌) to time-sample", () => {
    const h = buildQueryHints({ ...base, schema: "hitches", cols: hitchesCols, presentSchemas: ["hitches", "time-sample"] });
    expect(h.edges.some((e) => e.startsWith("∌ time-sample"))).toBe(true);
  });
  it("collapses a redundant time-window line when a tuple edge to the same sibling exists", () => {
    // swiftui-updates and time-sample share time AND thread → tuple; the plain time-window line is suppressed.
    const suiCols = [col("start", "start-time"), col("duration", "duration"), col("thread", "thread")];
    const h = buildQueryHints({ ...base, schema: "swiftui-updates", cols: suiCols, presentSchemas: ["swiftui-updates", "time-sample"] });
    const tsLines = h.edges.filter((e) => e.includes("time-sample"));
    expect(tsLines.some((e) => e.includes("causal join"))).toBe(true);
    expect(tsLines.some((e) => e.includes("(time-window / correlate)"))).toBe(false);
  });
  it("does not fabricate edges to siblings not present in the trace", () => {
    const h = buildQueryHints({ ...base, schema: "hitches", cols: hitchesCols, presentSchemas: ["hitches"] });
    expect(h.edges.every((e) => !e.includes("time-sample"))).toBe(true);
  });
});

describe("queryHints — correlation (carries-own-backtrace)", () => {
  it("says call_tree directly for a schema that carries its own backtrace", () => {
    const h = buildQueryHints({ ...base, schema: "x", cols: [col("time", "sample-time"), col("stack", "tagged-backtrace")], presentSchemas: ["x"] });
    expect(h.correlation).toMatch(/Carries its OWN backtrace/);
    expect(h.correlation).toMatch(/call_tree/);
  });
  it("points a keyed equi at the backtrace-carrying sibling (Leaks → Allocations by address)", () => {
    // Leaks/Leaks carries no backtrace; Allocations/Allocations List does; curated equi on address.
    const leaksCols = [col("address", "address"), col("size", "size-in-bytes")];
    const h = buildQueryHints({ ...base, schema: "Leaks/Leaks", cols: leaksCols, primaryTime: null, presentSchemas: ["Leaks/Leaks", "Allocations/Allocations List"] });
    expect(h.correlation).toMatch(/Allocations\/Allocations List/);
    expect(h.correlation).toMatch(/address.*address.*equality|equality/i);
  });
  it("uses a plain time-window (not the anti-join) when the only edge to the bt-sibling is an anti-join", () => {
    const h = buildQueryHints({ ...base, schema: "hitches", cols: hitchesCols, presentSchemas: ["hitches", "time-sample"] });
    expect(h.correlation).toMatch(/time-window/);
    expect(h.correlation).toMatch(/anti-join/); // acknowledges the ∌ edge is not the way to a stack
  });
  it("names the SPECIFIC known-but-absent bt-sibling (Leaks → Allocations) instead of a generic default, when Allocations isn't in this run", () => {
    // Same "same layer as you" case as the present-sibling test above, but
    // Allocations/Allocations List is NOT in presentSchemas this time — the
    // curated registry still knows it's Leaks' own designated backtrace
    // source (via latentRecovery), so the fallback should name it specifically
    // rather than defaulting to a generic "e.g. Time Profiler" suggestion that
    // wouldn't actually attribute a leaked object's allocation site.
    const leaksCols = [col("address", "address"), col("size", "size-in-bytes")];
    const h = buildQueryHints({ ...base, schema: "Leaks/Leaks", cols: leaksCols, primaryTime: null, presentSchemas: ["Leaks/Leaks"] });
    expect(h.correlation).toMatch(/Allocations\/Allocations List/);
    expect(h.correlation).toMatch(/leaks-backtraces/);
    expect(h.correlation).not.toMatch(/Time Profiler/);
  });
  it("falls back to the fully generic suggestion only when no known bt-sibling exists at all, present or absent", () => {
    const h = buildQueryHints({ ...base, schema: "device-thermal-state-intervals", cols: hitchesCols, primaryTime: "start", presentSchemas: ["device-thermal-state-intervals"] });
    expect(h.correlation).toMatch(/e\.g\. Time Profiler/);
  });
});

describe("queryHints — gotchas", () => {
  it("flags multiple thread-role columns and the value-priority winner", () => {
    const cols = [col("start", "start-time"), col("process", "process"), col("thread", "thread")];
    const h = buildQueryHints({ ...base, schema: "x", cols, presentSchemas: ["x"] });
    expect(h.gotchas.some((g) => /thread-role columns/.test(g) && /resolves to "thread"/.test(g))).toBe(true);
  });
  it("flags multiple time-role columns", () => {
    const cols = [col("start", "start-time"), col("session-start", "start-time")];
    const h = buildQueryHints({ ...base, schema: "x", cols, presentSchemas: ["x"] });
    expect(h.gotchas.some((g) => /time-role columns/.test(g))).toBe(true);
  });
  it("includes the curated static gotchas for a schema that has them", () => {
    const suiCols = [col("start", "start-time"), col("duration", "duration"), col("view-name", "string")];
    const h = buildQueryHints({ ...base, schema: "swiftui-updates", cols: suiCols, presentSchemas: ["swiftui-updates"] });
    expect(h.gotchas.some((g) => /view-name is BLANK/.test(g))).toBe(true);
    expect(h.gotchas.some((g) => /downstream-cost/.test(g))).toBe(true);
  });
  it("adds no curated gotchas for a schema that has none", () => {
    const h = buildQueryHints({ ...base, schema: "time-sample", cols: [col("time", "sample-time")], primaryTime: "time", presentSchemas: ["time-sample"] });
    expect(h.gotchas.every((g) => !/view-name/.test(g))).toBe(true);
  });
});

describe("queryHints — recovery (absent-sibling, latent)", () => {
  it("surfaces an absent curated sibling as a re-record suggestion", () => {
    const suiCols = [col("start", "start-time"), col("duration", "duration"), col("thread", "thread")];
    const h = buildQueryHints({ ...base, schema: "swiftui-updates", cols: suiCols, presentSchemas: ["swiftui-updates"] });
    expect(h.recovery.some((r) => r.includes("core-data-fetch") && r.includes("core-data"))).toBe(true);
  });
  it("does not suggest recovery for a sibling that IS present", () => {
    const suiCols = [col("start", "start-time"), col("duration", "duration"), col("thread", "thread")];
    const h = buildQueryHints({ ...base, schema: "swiftui-updates", cols: suiCols, presentSchemas: ["swiftui-updates", "core-data-fetch"] });
    expect(h.recovery.some((r) => r.includes("core-data-fetch"))).toBe(false);
  });
});

describe("queryHints — CURATED_GOTCHAS shape", () => {
  it("every curated gotcha has a note", () => {
    for (const [, list] of Object.entries(CURATED_GOTCHAS)) {
      for (const g of list) expect(g.note.length).toBeGreaterThan(10);
    }
  });
});

describe("queryHints — type-derived gotchas (Engineering Type Reference audit)", () => {
  // These derive from the schema's own declared engineering types at read
  // time — unfixtured schemas, schemas Apple adds a type to, and schemas
  // Apple removes one from all get the correct hint with no curation to rot.

  it("flags time-column sentinels (2^50−1 max + the undocumented t=0 convention)", () => {
    const h = buildQueryHints({ ...base, schema: "x", cols: [col("start", "start-time"), col("duration", "duration")], presentSchemas: ["x"] });
    const joined = h.gotchas.join(" | ");
    expect(joined).toMatch(/2\^50−1/);
    expect(joined).toMatch(/pre-recording\/not\s*recorded/);
  });

  it("flags non-time max-sentinel columns and aggregate's automatic exclusion", () => {
    const h = buildQueryHints({ ...base, schema: "x", cols: [col("start", "start-time"), col("errno", "syscall-return")], presentSchemas: ["x"] });
    const joined = h.gotchas.join(" | ");
    expect(joined).toMatch(/errno.*MAX/s);
    expect(joined).toMatch(/aggregate\(\) excludes/);
  });

  it("flags zero-sentinel columns (duration) as annotation", () => {
    const h = buildQueryHints({ ...base, schema: "x", cols: [col("start", "start-time"), col("duration", "duration")], presentSchemas: ["x"] });
    expect(h.gotchas.join(" | ")).toMatch(/literal 0 in duration.*missing/s);
  });

  it("derives the nested-interval double-counting gotcha from containment-level + duration", () => {
    const h = buildQueryHints({
      ...base, schema: "x",
      cols: [col("start", "start-time"), col("duration", "duration"), col("containment-level", "containment-level")],
      presentSchemas: ["x"],
    });
    expect(h.gotchas.join(" | ")).toMatch(/multiply-counts wall-clock time/);
  });

  it("does NOT derive the double-counting gotcha without a duration", () => {
    const h = buildQueryHints({
      ...base, schema: "x", primaryWeight: null,
      cols: [col("time", "event-time"), col("containment-level", "containment-level")],
      presentSchemas: ["x"],
    });
    expect(h.gotchas.join(" | ")).not.toMatch(/multiply-counts/);
  });

  it("surfaces narrative columns as Apple-authored prose worth reading", () => {
    const h = buildQueryHints({
      ...base, schema: "x",
      cols: [col("start", "start-time"), col("suggestion", "narrative")],
      presentSchemas: ["x"],
    });
    expect(h.gotchas.join(" | ")).toMatch(/Apple-authored prose: suggestion/);
  });
});
