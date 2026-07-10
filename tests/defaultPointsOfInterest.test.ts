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
    // PMT:flint-crystal: the decoder confirmed Processor Trace's archive
    // bundles a real Points of Interest instrument (moved from POI-less to
    // this list — see TEMPLATE_BUNDLES in recording.ts).
    expect(defaultPointsOfInterest("Processor Trace", [])).toEqual({});
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

  it("fires for other POI-less templates too (Animation Hitches, Power Profiler, Core AI/ML)", () => {
    for (const t of ["Animation Hitches", "Power Profiler", "Core AI", "Core ML"]) {
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

  // PMT:ash-stone gap #1: an instruments-only recording (no base template at
  // all) has no TEMPLATE_BUNDLES entry to check — should degrade to the same
  // auto-add behavior as any other POI-less template, not throw.
  it("auto-adds bare Points of Interest when there's no base template at all (instruments-only)", () => {
    const result = defaultPointsOfInterest(undefined, ["HTTP Traffic"]);
    expect(result.instrument).toBe("Points of Interest");
  });

  it("does not re-add it when already present, with no base template", () => {
    const result = defaultPointsOfInterest(undefined, ["Points of Interest"]);
    expect(result).toEqual({});
  });
});
