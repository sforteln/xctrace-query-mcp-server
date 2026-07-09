/**
 * PMT:calm-starling — expandTemplates must fail fast (before ever shelling out
 * to xctrace) when a `templates` composition entry names a template-only
 * instrument (TEMPLATE_ONLY_NAMES). Reproduced live: `xctrace record --template
 * "Time Profiler" --instrument "Data Persistence" ...` fails outright with
 * "Instrument with name 'Data Persistence' cannot be found" (exit 56) — before
 * this guard, that opaque xctrace failure was the ONLY signal, discovered only
 * after actually spawning a recording.
 */
import { describe, it, expect } from "vitest";
import { expandTemplates, TEMPLATE_ONLY_NAMES, TEMPLATE_BUNDLES } from "../src/core/recording.js";
import { XctraceError } from "../src/engine/xctrace.js";

describe("expandTemplates rejects template-only names composed as an extra", () => {
  for (const name of TEMPLATE_ONLY_NAMES) {
    it(`throws a structured "template-only-name" error for "${name}"`, () => {
      expect(() => expandTemplates([name], "Time Profiler")).toThrow(XctraceError);
      try {
        expandTemplates([name], "Time Profiler");
        expect.fail("expected expandTemplates to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(XctraceError);
        expect((err as XctraceError).kind).toBe("template-only-name");
        expect((err as XctraceError).message).toContain(name);
      }
    });
  }

  it("does not throw when the template-only name IS the base (resolvedTemplate) itself", () => {
    // The base is always passed via --template, never --instrument — only
    // composing one of these as an EXTRA on top of a DIFFERENT base is unsafe.
    expect(() => expandTemplates([], "Data Persistence")).not.toThrow();
  });

  it("still expands every non-template-only TEMPLATE_BUNDLES key without throwing", () => {
    for (const name of Object.keys(TEMPLATE_BUNDLES)) {
      if (TEMPLATE_ONLY_NAMES.has(name)) continue;
      expect(() => expandTemplates([name], "SwiftUI"), `composing "${name}"`).not.toThrow();
    }
  });

  it("a caller-supplied `type` key that resolves to a template-only template still throws", () => {
    // resolveTemplateName runs first — the guard checks the RESOLVED name, not the raw type key.
    expect(() => expandTemplates(["core-data"], "Time Profiler")).toThrow(XctraceError);
  });

  // PMT:ash-stone gap #1: an instruments-only recording has no base template
  // at all — expandTemplates must not throw just because there's nothing to
  // seed `seen`/`baseCovered` with.
  it("does not throw with no base template at all (instruments-only, no composed templates)", () => {
    expect(() => expandTemplates([], undefined)).not.toThrow();
    const result = expandTemplates([], undefined);
    expect(result.instruments).toEqual([]);
    expect(result.fidelityAtRisk).toEqual([]);
  });

  it("still expands a composed template correctly with no base template at all", () => {
    const result = expandTemplates(["SwiftUI"], undefined);
    expect(result.instruments).toContain("SwiftUI");
    expect(result.instruments).toContain("Hangs");
  });
});
