/**
 * PMT:plain-creek — defaultPointsOfInterest: auto-add bare "Points of
 * Interest" whenever the resolved template's own TEMPLATE_BUNDLES entry
 * doesn't already include it. Unconditional (not risk-gated like
 * mitigateHangsOsLogFidelity) — calm-starling already confirmed composing
 * POI bare has no fidelity loss, and the re-verified cost is ~0.
 */
import { describe, it, expect } from "vitest";
import { defaultPointsOfInterest } from "../src/core/recording.js";

describe("defaultPointsOfInterest", () => {
  it("does nothing when the resolved template already bundles Points of Interest", () => {
    expect(defaultPointsOfInterest("Time Profiler", [])).toEqual({});
    expect(defaultPointsOfInterest("CPU Profiler", [])).toEqual({});
    expect(defaultPointsOfInterest("Allocations", [])).toEqual({});
    expect(defaultPointsOfInterest("Leaks", [])).toEqual({});
    expect(defaultPointsOfInterest("Network", [])).toEqual({});
    expect(defaultPointsOfInterest("Swift Concurrency", [])).toEqual({});
  });

  it("does nothing when the resolved template IS Points of Interest", () => {
    expect(defaultPointsOfInterest("Points of Interest", [])).toEqual({});
  });

  it("auto-adds bare Points of Interest when the template's bundle omits it", () => {
    const result = defaultPointsOfInterest("SwiftUI", []);
    expect(result.instrument).toBe("Points of Interest");
    expect(result.note).toMatch(/Points of Interest/);
    expect(result.note).toMatch(/auto-added/);
  });

  it("fires for other POI-less templates too (Animation Hitches, Power Profiler, Core AI/ML, Processor Trace)", () => {
    for (const t of ["Animation Hitches", "Power Profiler", "Core AI", "Core ML", "Processor Trace"]) {
      expect(defaultPointsOfInterest(t, []).instrument).toBe("Points of Interest");
    }
  });

  it("does not re-add it if already in the resolved instrument list", () => {
    const result = defaultPointsOfInterest("SwiftUI", ["Points of Interest"]);
    expect(result).toEqual({});
  });

  it("fires alongside other already-resolved extra instruments", () => {
    const result = defaultPointsOfInterest("SwiftUI", ["os_log"]);
    expect(result.instrument).toBe("Points of Interest");
  });
});
