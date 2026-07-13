/**
 * PMT:birch-river — os-log lens's curated runtime-issues finder: approximates
 * a real Hangs-bundling template's own os-log scope (subsystem
 * com.apple.runtime-issues, message-type Fault, category in the confirmed
 * watchlist) via a plain find() condition tree (PMT:narrow-ochre's anyOf),
 * not a bespoke tool. Safe as a default regardless of how os-log arrived (a
 * no-op against an already-scoped template capture, an approximation against
 * a bare one). message-type: "Fault" (2026-07-10) tightens this to match
 * Apple's own real filter exactly, confirmed live from a real trace's TOC —
 * this is still only the fallback for when the real `hang-risks` schema
 * isn't present (bare-composed Hangs); it can't replicate that schema's
 * main-thread gate.
 */
import { describe, it, expect } from "vitest";
import osLogLens from "../src/lenses/osLog/index.js";

describe("os-log lens runtime-issues finder", () => {
  it("quickStart fires only when os-log is present", () => {
    expect(osLogLens.quickStart?.(["time-sample"], "s", 1)).toBeNull();
    expect(osLogLens.quickStart?.(["os-log"], "s", 1)).not.toBeNull();
  });

  it("filters to subsystem com.apple.runtime-issues AND message-type Fault AND category in the known watchlist", () => {
    const quickStart = osLogLens.quickStart!(["os-log"], "session-1", 3);
    expect(quickStart).not.toBeNull();
    expect(quickStart!.tool).toBe("find");
    expect(quickStart!.args.schema).toBe("os-log");
    expect(quickStart!.args.run).toBe(3);

    const where = quickStart!.args.where as Array<Record<string, unknown>>;
    expect(where[0]).toEqual({ col: "subsystem", op: "eq", val: "com.apple.runtime-issues" });
    expect(where[1]).toEqual({ col: "message-type", op: "eq", val: "Fault" });
    const anyOf = where[2].anyOf as Array<{ col: string; op: string; val: string }>;
    const categories = anyOf.map((c) => c.val);
    expect(categories).toEqual(["Hang Risk", "Severe Hang Risk", "CFNetwork", "Contacts", "CoreML"]);
    expect(anyOf.every((c) => c.col === "category" && c.op === "eq")).toBe(true);
  });

  it("nextActions returns the same finder for the os-log schema, nothing for other schemas", () => {
    const actions = osLogLens.nextActions("session-1", "os-log", 1, ["os-log"]);
    expect(actions).toHaveLength(1);
    expect(actions[0].tool).toBe("find");

    expect(osLogLens.nextActions("session-1", "time-sample", 1, ["time-sample"])).toEqual([]);
  });

  it("description documents this is an approximation, not an exact match", () => {
    const quickStart = osLogLens.quickStart!(["os-log"], "s", 1);
    expect(quickStart!.hint).toMatch(/approximat/i);
  });
});
