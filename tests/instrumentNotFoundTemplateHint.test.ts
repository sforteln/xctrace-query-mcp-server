/**
 * PMT:open-mantle — instrumentNotFoundTemplateHint: when xctrace rejects an
 * `instruments` entry as an unrecognized bare instrument, and the rejected
 * name is actually a real TEMPLATE name (no matching bare instrument), steer
 * the caller to `template` instead of leaving xctrace's own opaque error as
 * the only signal.
 *
 * Live xcodeAI feedback: `instruments: ["System Trace"]` was rejected with
 * xctrace's own "Instrument with name 'System Trace' cannot be found" —
 * verified live this exact stderr text and exit code (56). Confirmed live,
 * end to end via the real startSession/stopSession interactive lifecycle
 * (not just this pure function), that stopSession's thrown error now
 * includes the hint for this exact case, and does NOT for a genuinely
 * unrecognized name.
 */
import { describe, it, expect } from "vitest";
import { instrumentNotFoundTemplateHint, TEMPLATE_ONLY_NAMES, TEMPLATE_BUNDLES } from "../src/core/recording.js";

describe("instrumentNotFoundTemplateHint", () => {
  it("returns undefined when stderr doesn't match xctrace's rejection pattern at all", () => {
    expect(instrumentNotFoundTemplateHint("some unrelated failure")).toBeUndefined();
    expect(instrumentNotFoundTemplateHint("")).toBeUndefined();
  });

  it("returns undefined when the rejected name is genuinely unrecognized (neither instrument nor template)", () => {
    const hint = instrumentNotFoundTemplateHint("Instrument with name 'Totally Not A Real Instrument' cannot be found");
    expect(hint).toBeUndefined();
  });

  it("hints for the real motivating case: 'System Trace' (a template-only name)", () => {
    const hint = instrumentNotFoundTemplateHint("Instrument with name 'System Trace' cannot be found");
    expect(hint).toBeDefined();
    expect(hint).toMatch(/Did you mean templates: \["System Trace"\]\?/);
    expect(hint).toMatch(/no matching bare --instrument/);
  });

  it("matches case-insensitively but echoes the REAL (correctly-cased) template name", () => {
    const hint = instrumentNotFoundTemplateHint("Instrument with name 'system trace' cannot be found");
    expect(hint).toMatch(/"System Trace"/);
  });

  it("fires for every currently-known template-only name", () => {
    for (const name of TEMPLATE_ONLY_NAMES) {
      const hint = instrumentNotFoundTemplateHint(`Instrument with name '${name}' cannot be found`);
      expect(hint, `expected a hint for "${name}"`).toBeDefined();
      expect(hint).toContain(name);
    }
  });

  it("also fires for a TEMPLATE_BUNDLES key that happens to ALSO be a valid bare instrument", () => {
    // "Time Profiler" is both a real template AND a valid bare instrument, so
    // xctrace would never actually reject it this way in practice — but the
    // pure function's contract is just "is this name a known template",
    // independent of whether the rejection is realistic for THIS name.
    const [anyTemplateBundleKey] = Object.keys(TEMPLATE_BUNDLES);
    const hint = instrumentNotFoundTemplateHint(`Instrument with name '${anyTemplateBundleKey}' cannot be found`);
    expect(hint).toContain(anyTemplateBundleKey);
  });

  it("tolerates double-quoted rejection text too, not just single-quoted", () => {
    const hint = instrumentNotFoundTemplateHint('Instrument with name "System Trace" cannot be found');
    expect(hint).toBeDefined();
  });
});
