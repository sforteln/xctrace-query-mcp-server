/**
 * PMT:stubborn-beck — allocationsLeaksNote: migrated from RECORDING_INTENTS'
 * old "memory"/"leaks"/"leaks-backtraces" entries. The two-Leaks behavior
 * (Leaks alone yields no backtraces; Allocations+Leaks together gives
 * leaked objects their responsible frames) now fires off the ACTUAL resolved
 * template/instrument set, not a `type` key — so it must fire identically
 * regardless of which "role" (base vs. composed extra) each name played.
 */
import { describe, it, expect } from "vitest";
import { allocationsLeaksNote } from "../src/core/recording.js";

describe("allocationsLeaksNote", () => {
  it("returns undefined when neither Allocations nor Leaks is present", () => {
    expect(allocationsLeaksNote(new Set(["Time Profiler"]))).toBeUndefined();
  });

  it("Allocations alone: plain POI-bundled note, no backtrace guidance", () => {
    const note = allocationsLeaksNote(new Set(["Allocations"]));
    expect(note).toMatch(/Points of Interest/);
    expect(note).not.toMatch(/backtrace/i);
  });

  it("Leaks alone: warns no backtraces, points at composing Allocations too", () => {
    const note = allocationsLeaksNote(new Set(["Leaks"]));
    expect(note).toMatch(/without responsible call frames/);
    expect(note).toMatch(/template: \["Allocations", "Leaks"\]/);
  });

  it("Allocations + Leaks together: full launch-vs-attach backtrace guidance, regardless of which was the base", () => {
    // Same resolved set whether Leaks was the base + Allocations composed,
    // or Allocations was the base + Leaks composed bare — the note doesn't
    // care which role each name played, only that both are present.
    const note = allocationsLeaksNote(new Set(["Allocations", "Leaks"]));
    expect(note).toMatch(/responsible frames/);
    expect(note).toMatch(/launch over attach/);
    expect(note).toMatch(/PRE-ATTACHMENT/);
  });
});
