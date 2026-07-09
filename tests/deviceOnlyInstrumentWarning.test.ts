/**
 * PMT:stormy-coast — deviceOnlyInstrumentWarning: warn (never block) when a
 * Simulator target is asked for an instrument that needs real hardware
 * (GPU/display/energy-thermal/PMU-ANE) that xctrace itself won't flag, per
 * the curated DEVICE_ONLY_INSTRUMENTS map sourced from the Instruments GUI.
 */
import { describe, it, expect } from "vitest";
import { deviceOnlyInstrumentWarning, DEVICE_ONLY_INSTRUMENTS } from "../src/core/recording.js";

describe("deviceOnlyInstrumentWarning", () => {
  it("does nothing when the target isn't a Simulator, regardless of instruments", () => {
    expect(deviceOnlyInstrumentWarning("Animation Hitches", ["GPU"], false)).toBeUndefined();
  });

  it("does nothing on a Simulator when nothing device-only is involved", () => {
    // Allocations' own bundle is just Points of Interest (sim-safe) — unlike
    // Time Profiler/CPU Profiler, which bundle the device-only Thermal State.
    expect(deviceOnlyInstrumentWarning("Allocations", ["Points of Interest"], true)).toBeUndefined();
  });

  it("warns when the resolved template itself is device-only", () => {
    const note = deviceOnlyInstrumentWarning("Animation Hitches", [], true);
    expect(note).toMatch(/Animation Hitches/);
    expect(note).toMatch(/device-only/);
    expect(note).toMatch(/physical device/);
  });

  it("warns when a device-only instrument is requested as a bare extra", () => {
    const note = deviceOnlyInstrumentWarning("Time Profiler", ["GPU"], true);
    expect(note).toMatch(/"GPU"/);
  });

  it("catches a device-only instrument pulled in via TEMPLATE_BUNDLES, not just top-level requests", () => {
    // SwiftUI's own template doesn't list Hitches directly as its name, but
    // Animation Hitches bundles Hangs+Time Profiler (not Hitches) — use a
    // template that DOES bundle a device-only instrument via TEMPLATE_BUNDLES,
    // i.e. asking for "Time Profiler" (bundles Points of Interest, sim-safe)
    // vs. asserting the bundle-lookup path fires for CPU Profiler which
    // bundles Points of Interest + Thermal State (device-only).
    const note = deviceOnlyInstrumentWarning("CPU Profiler", [], true);
    expect(note).toMatch(/Thermal State/);
  });

  it("lists every distinct device-only instrument found, not just the first", () => {
    const note = deviceOnlyInstrumentWarning("Time Profiler", ["GPU"], true);
    // Time Profiler's own bundle includes Thermal State; GPU is requested bare.
    expect(note).toMatch(/Thermal State/);
    expect(note).toMatch(/GPU/);
  });

  it("every entry in the curated map fires individually as a bare extra", () => {
    for (const name of Object.keys(DEVICE_ONLY_INSTRUMENTS)) {
      const note = deviceOnlyInstrumentWarning("Points of Interest", [name], true);
      expect(note, `expected a warning for ${name}`).toBeDefined();
      expect(note).toContain(name);
    }
  });

  // PMT:ash-stone gap #1: an instruments-only recording has no resolved
  // template at all — there's no TEMPLATE_BUNDLES entry to look up, but a
  // device-only instrument requested bare must still warn.
  it("still warns for a device-only bare instrument with no base template at all", () => {
    const note = deviceOnlyInstrumentWarning(undefined, ["GPU"], true);
    expect(note).toMatch(/"GPU"/);
  });

  it("does nothing with no base template and no device-only instruments", () => {
    expect(deviceOnlyInstrumentWarning(undefined, ["HTTP Traffic"], true)).toBeUndefined();
  });
});
