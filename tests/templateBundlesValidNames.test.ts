/**
 * PMT:flint-crystal — every name in TEMPLATE_BUNDLES must be a real bare
 * `--instrument` name, because expandTemplates() composes a `template` extra as
 * `[name, ...TEMPLATE_BUNDLES[name]]` and passes each to `xctrace --instrument`.
 * A wrong/misspelled name (the exact bug class this prompt fixed — the decoder's
 * display name "Runloops" is NOT xctrace's "Run Loops") would make composition
 * fail at record time, far from this table.
 *
 * Guarded against a committed snapshot of `xcrun xctrace list instruments`
 * rather than a live call, so it's deterministic in CI. Refresh the fixture
 * (tests/fixtures/xcode-27.0/instrument-names.txt) when the Xcode baseline moves.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TEMPLATE_BUNDLES, TEMPLATE_ONLY_NAMES } from "../src/core/recording.js";

const validInstruments = new Set(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "fixtures", "xcode-27.0", "instrument-names.txt"),
    "utf8"
  )
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
);

describe("TEMPLATE_BUNDLES uses only valid bare instrument names", () => {
  it("every auxiliary instrument in every bundle is a real --instrument name", () => {
    const bad: string[] = [];
    for (const [template, bundle] of Object.entries(TEMPLATE_BUNDLES)) {
      for (const inst of bundle) {
        if (!validInstruments.has(inst)) bad.push(`${template} → "${inst}"`);
      }
    }
    expect(bad, `not in \`xctrace list instruments\`: ${bad.join("; ")}`).toEqual([]);
  });

  it("every composable (non-template-only) TEMPLATE_BUNDLES key is itself a valid bare instrument", () => {
    // expandTemplates records a composed extra as [name, ...bundle], so the key
    // itself is passed to --instrument unless it's a TEMPLATE_ONLY_NAME.
    const bad: string[] = [];
    for (const template of Object.keys(TEMPLATE_BUNDLES)) {
      if (TEMPLATE_ONLY_NAMES.has(template)) continue;
      if (!validInstruments.has(template)) bad.push(template);
    }
    expect(bad, `composable keys not valid bare instruments: ${bad.join(", ")}`).toEqual([]);
  });

  it("every TEMPLATE_ONLY_NAME is genuinely NOT a bare instrument (that's what makes it template-only)", () => {
    const wrong: string[] = [];
    for (const name of TEMPLATE_ONLY_NAMES) {
      if (validInstruments.has(name)) wrong.push(name);
    }
    expect(wrong, `these ARE valid bare instruments, so shouldn't be template-only: ${wrong.join(", ")}`).toEqual([]);
  });

  it("the flint-crystal named fixes are present and correctly spelled", () => {
    // Power Profiler's confirmed-missing no-options instrument.
    expect(TEMPLATE_BUNDLES["Power Profiler"]).toContain("Location Energy Model");
    // RealityKit Trace: new entry, template-only, uses the reconciled "Run Loops"
    // (NOT the decoder display name "Runloops").
    expect(TEMPLATE_BUNDLES["RealityKit Trace"]).toContain("Run Loops");
    expect(TEMPLATE_BUNDLES["RealityKit Trace"]).not.toContain("Runloops");
    expect(TEMPLATE_ONLY_NAMES.has("RealityKit Trace")).toBe(true);
    // Foundation Models: new entry, genuinely empty auxiliary bundle, and it IS
    // a valid bare instrument (so not template-only).
    expect(TEMPLATE_BUNDLES["Foundation Models"]).toEqual([]);
    expect(TEMPLATE_ONLY_NAMES.has("Foundation Models")).toBe(false);
  });
});
