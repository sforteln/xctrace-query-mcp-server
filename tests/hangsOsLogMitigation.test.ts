/**
 * PMT:birch-river — mitigateHangsOsLogFidelity: auto-add bare "os_log" only
 * when Hangs specifically lands in expandTemplates' fidelityAtRisk (a
 * composed template's Hangs came in bare, losing its real com.apple.
 * runtime-issues os-log coverage — see PMT:full-trace/gravel-falcon).
 * Deliberately scoped to Hangs only — Points of Interest/Foundation Models/
 * Network each have their own DIFFERENT os-log watchlist, so this must not
 * fire for them.
 */
import { describe, it, expect } from "vitest";
import { mitigateHangsOsLogFidelity } from "../src/core/recording.js";

describe("mitigateHangsOsLogFidelity", () => {
  it("does nothing when Hangs is not in fidelityAtRisk", () => {
    const result = mitigateHangsOsLogFidelity(["Points of Interest"], []);
    expect(result).toEqual({});
  });

  it("does nothing when fidelityAtRisk is empty", () => {
    const result = mitigateHangsOsLogFidelity([], []);
    expect(result).toEqual({});
  });

  it("auto-adds bare os_log when Hangs is in fidelityAtRisk", () => {
    const result = mitigateHangsOsLogFidelity(["Hangs"], []);
    expect(result.instrument).toBe("os_log");
    expect(result.note).toMatch(/fidelityAtRisk/);
    expect(result.note).toMatch(/os_log/);
  });

  it("fires alongside other fidelityAtRisk entries, as long as Hangs is one of them", () => {
    const result = mitigateHangsOsLogFidelity(["Hangs", "Time Profiler"], []);
    expect(result.instrument).toBe("os_log");
  });

  it("does not re-add os_log if it's already in the resolved instrument list", () => {
    const result = mitigateHangsOsLogFidelity(["Hangs"], ["os_log"]);
    expect(result).toEqual({});
  });
});
