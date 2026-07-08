/**
 * PMT:birch-river — os-log lens's curated runtime-issues finder: approximates
 * a real Hangs-bundling template's own os-log scope (subsystem
 * com.apple.runtime-issues, category in the confirmed watchlist) via a plain
 * find() condition tree (PMT:narrow-ochre's anyOf), not a bespoke tool. Safe
 * as a default regardless of how os-log arrived (a no-op against an
 * already-scoped template capture, an approximation against a bare one).
 */
import { describe, it, expect } from "vitest";
import osLogLens from "../src/lenses/osLog/index.js";

describe("os-log lens runtime-issues finder", () => {
  it("quickStart fires only when os-log is present", () => {
    expect(osLogLens.quickStart?.(["time-sample"], "s", 1)).toBeNull();
    expect(osLogLens.quickStart?.(["os-log"], "s", 1)).not.toBeNull();
  });

  it("filters to subsystem com.apple.runtime-issues AND category in the known watchlist", () => {
    const quickStart = osLogLens.quickStart!(["os-log"], "session-1", 3);
    expect(quickStart).not.toBeNull();
    expect(quickStart!.tool).toBe("find");
    expect(quickStart!.args.schema).toBe("os-log");
    expect(quickStart!.args.run).toBe(3);

    const where = quickStart!.args.where as Array<Record<string, unknown>>;
    expect(where[0]).toEqual({ col: "subsystem", op: "eq", val: "com.apple.runtime-issues" });
    const anyOf = where[1].anyOf as Array<{ col: string; op: string; val: string }>;
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
