/**
 * PMT:ash-stone gap #2 — knownBrokenInstrumentWarning: warn (never block)
 * when the CURRENT Xcode version matches a curated known-broken instrument
 * entry. Distinct evidentiary basis from deviceOnlyInstrumentWarning (a
 * stable hardware fact sourced from the Instruments GUI) — this is genuinely
 * live-repro-only and version-scoped, since a beta crash can be fixed in the
 * very next Xcode release.
 */
import { describe, it, expect } from "vitest";
import { knownBrokenInstrumentWarning, KNOWN_BROKEN_INSTRUMENTS } from "../src/core/recording.js";

describe("knownBrokenInstrumentWarning", () => {
  it("does nothing when xcodeVersion is null (undetectable)", () => {
    expect(knownBrokenInstrumentWarning("Network", [], null)).toBeUndefined();
  });

  it("does nothing when nothing composed matches a curated entry", () => {
    expect(knownBrokenInstrumentWarning("Time Profiler", [], "27.0")).toBeUndefined();
  });

  it("warns when the resolved template's own bundle includes a known-broken instrument on a matching Xcode version", () => {
    // "Network" template bundles "Points of Interest" only per TEMPLATE_BUNDLES —
    // exercise the direct extraInstruments path instead, matching how gap #2's
    // real repro actually composed Network Connections (via type: "network").
    const note = knownBrokenInstrumentWarning(undefined, ["Network Connections"], "27.0");
    expect(note).toMatch(/Network Connections/);
    expect(note).toMatch(/Xcode 27\.0/);
    expect(note).toMatch(/Document Missing Template Error/);
  });

  it("does not warn on a different Xcode version outside the curated prefix", () => {
    expect(knownBrokenInstrumentWarning(undefined, ["Network Connections"], "26.0")).toBeUndefined();
  });

  it("prefix-matches any point release under the curated range", () => {
    expect(knownBrokenInstrumentWarning(undefined, ["Network Connections"], "27.1")).toBeDefined();
    expect(knownBrokenInstrumentWarning(undefined, ["Network Connections"], "27.0.1")).toBeDefined();
  });

  it("every curated entry fires for its own instrument name at its own version", () => {
    for (const [name, entries] of Object.entries(KNOWN_BROKEN_INSTRUMENTS)) {
      for (const entry of entries) {
        const version = entry.xcodeVersion.endsWith(".") ? `${entry.xcodeVersion}0` : entry.xcodeVersion;
        const note = knownBrokenInstrumentWarning(undefined, [name], version);
        expect(note, `expected a warning for ${name} on ${version}`).toBeDefined();
        expect(note).toContain(name);
      }
    }
  });

  it("includes the staleness caveat so a caller can't mistake this for a permanent fact", () => {
    const note = knownBrokenInstrumentWarning(undefined, ["Network Connections"], "27.0");
    expect(note).toMatch(/live-repro-only/);
    expect(note).toMatch(/may already be fixed/);
  });
});
