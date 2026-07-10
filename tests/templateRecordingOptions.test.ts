/**
 * PMT:rough-bench — TEMPLATE_RECORDING_OPTIONS restores an EXTRA-composed
 * template's real tuned recordingOptions for its bundled instruments, not
 * just its own headline (e.g. SwiftUI tunes Hangs to 250ms; bare default is
 * 100ms). Three properties verified here, each corresponding to a real bug
 * or risk found while building this:
 *
 *   1. Every entry lists the instrument's COMPLETE real key set, not a
 *      partial override. Verified live: `--recording-options <file>` fails
 *      to load AT ALL on a partial object (a misleading "data couldn't be
 *      read because it is missing" error) — confirmed by feeding xctrace's
 *      own `--show-recording-options` output back in verbatim (works) vs. a
 *      hand-trimmed partial version of the exact same object (fails
 *      identically). Guarded against a committed snapshot of the real key
 *      sets (tests/fixtures/xcode-27.0/recording-option-keys.json) so this
 *      can't silently regress.
 *   2. The merge is PER-INSTRUMENT conditional on addedAtRisk, not a blanket
 *      merge of an extra's whole options object — otherwise composing
 *      SwiftUI (tunes Hangs to 250ms) onto an Animation Hitches base (which
 *      already natively tunes Hangs to 33ms) would silently overwrite the
 *      base's correct value. Verified live via real recordings: a bare
 *      Hangs@250 produces a real trace whose TOC reports
 *      `hangs-threshold="250"`; composing SwiftUI onto Animation Hitches
 *      preserves `hangs-threshold="33"` untouched.
 *   3. fidelityAtRisk keeps flagging an instrument even after its
 *      recordingOptions gap is closed (mitigateHangsOsLogFidelity depends on
 *      this for Hangs' os-log scope, which isn't recordingOptions-reachable
 *      at all) — the note text distinguishes "tuning restored" from "still
 *      not guaranteed to match" instead of stopping the flag.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { expandTemplates, TEMPLATE_RECORDING_OPTIONS } from "../src/core/recording.js";

const REAL_KEY_SETS: Record<string, string[]> = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "fixtures", "xcode-27.0", "recording-option-keys.json"),
    "utf8"
  )
);

describe("TEMPLATE_RECORDING_OPTIONS entries use the COMPLETE real key set", () => {
  it("every instrument's option object has exactly the keys xctrace reports for it — no partial overrides", () => {
    const mismatches: string[] = [];
    for (const [templateName, byInstrument] of Object.entries(TEMPLATE_RECORDING_OPTIONS)) {
      for (const [instrumentName, values] of Object.entries(byInstrument)) {
        const expectedKeys = REAL_KEY_SETS[instrumentName];
        if (!expectedKeys) continue; // no fixture captured for this instrument — not one we're guarding
        const actualKeys = Object.keys(values).sort();
        const expected = [...expectedKeys].sort();
        if (JSON.stringify(actualKeys) !== JSON.stringify(expected)) {
          mismatches.push(
            `${templateName} → ${instrumentName}: has [${actualKeys.join(", ")}], expected [${expected.join(", ")}]`
          );
        }
      }
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });
});

describe("expandTemplates — recordingOptions fidelity restoration (PMT:rough-bench)", () => {
  it("restores a bundled auxiliary instrument's tuned recordingOptions when genuinely added bare", () => {
    // Allocations' own bundle is just Points of Interest — doesn't cover Hangs/Time Profiler at all.
    const expanded = expandTemplates(["SwiftUI"], "Allocations");
    expect(expanded.fidelityAtRisk).toEqual(expect.arrayContaining(["Hangs", "Time Profiler"]));
    expect(expanded.recordingOptions.Hangs).toEqual({ detectPriorityInversions: false, hangsThreshold: 250 });
    expect(expanded.recordingOptions["Time Profiler"]).toEqual({
      contextSwitchSampling: false,
      highFrequencySampling: true,
      recordKernelStacks: false,
      recordWaitingThreads: false,
    });
    // SwiftUI's own headline opinion still applies too.
    expect(expanded.recordingOptions.SwiftUI).toEqual({ enableLayoutTracing: true });
  });

  it("does NOT restore tuning for an instrument the base already covers — no clobbering the base's own real tuning", () => {
    // Animation Hitches' own bundle already includes Hangs (natively tuned to
    // 33ms via ITS real --template invocation) — composing SwiftUI (which
    // wants Hangs at 250ms) must not inject that override, since Hangs isn't
    // genuinely being added bare here.
    const expanded = expandTemplates(["SwiftUI"], "Animation Hitches");
    expect(expanded.fidelityAtRisk).toEqual([]);
    expect(expanded.recordingOptions.Hangs).toBeUndefined();
    expect(expanded.recordingOptions["Time Profiler"]).toBeUndefined();
    // Only SwiftUI's own headline option is present.
    expect(expanded.recordingOptions).toEqual({ SwiftUI: { enableLayoutTracing: true } });
  });

  it("restores tuning for a template composed as an extra with no auxiliary bundle overlap risk (Time Profiler itself)", () => {
    const expanded = expandTemplates(["Time Profiler"], "Allocations");
    expect(expanded.fidelityAtRisk).toContain("Hangs");
    expect(expanded.recordingOptions.Hangs).toEqual({ detectPriorityInversions: false, hangsThreshold: 250 });
  });

  it("restores CPU Counters' own headline tuning when composed as an extra", () => {
    const expanded = expandTemplates(["CPU Counters"], "Allocations");
    expect(expanded.recordingOptions["CPU Counters"]).toMatchObject({
      selectedCountingMode: { analysisMode: "bottleneck", countingMode: "bottlenecks" },
      selectedCountingModeDisplayName: "CPU Bottlenecks",
    });
  });

  it("restores Processor Trace's own headline tuning when composed as an extra", () => {
    const expanded = expandTemplates(["Processor Trace"], "Allocations");
    expect(expanded.recordingOptions["Processor Trace"]).toMatchObject({ bufferSizeFill: 1 });
  });
});

describe("expandTemplates — fidelityAtRisk stays flagged after recordingOptions restoration (item 4)", () => {
  it("keeps Hangs in fidelityAtRisk even though its recordingOptions gap is closed", () => {
    const expanded = expandTemplates(["SwiftUI"], "Allocations");
    // If this ever changes, mitigateHangsOsLogFidelity's os-log auto-add
    // (keyed purely on fidelityAtRisk.includes("Hangs")) would silently stop
    // firing, even though os-log subsystem/category scope is NOT
    // recordingOptions-reachable at all and remains genuinely unrestored.
    expect(expanded.fidelityAtRisk).toContain("Hangs");
  });

  it("the note distinguishes 'tuning restored' from 'no known override' per instrument", () => {
    const expanded = expandTemplates(["SwiftUI"], "Allocations");
    const note = expanded.notes.join("\n");
    expect(note).toMatch(/Known recordingOptions-level tuning WAS restored for Hangs, Time Profiler/);
    expect(note).toMatch(/Hitches has no known tuned-value override/);
    expect(note).toMatch(/os-log subsystem\/category scope/);
  });

  it("reports full fidelity when nothing ends up added bare", () => {
    // Animation Hitches' own bundle (Display, Hangs, Hitches, Thermal State,
    // Thread Activity, Time Profiler) covers EVERY instrument SwiftUI's own
    // expansion would add (SwiftUI, Hangs, Hitches, Time Profiler) except
    // SwiftUI itself — so nothing ends up genuinely bare here.
    const expanded = expandTemplates(["SwiftUI"], "Animation Hitches");
    expect(expanded.fidelityAtRisk).toEqual([]);
    expect(expanded.notes.join("\n")).toMatch(/Full fidelity/);
  });
});
