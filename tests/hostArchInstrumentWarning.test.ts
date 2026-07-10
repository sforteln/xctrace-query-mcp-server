/**
 * PMT:flint-crystal follow-up — hostArchInstrumentWarning: warn (never block)
 * when the resolved template/instruments need a CPU architecture the HOST
 * Mac doesn't have (e.g. "Processor Trace" needs Intel PT, permanently absent
 * on Apple Silicon). Distinct axis from deviceOnlyInstrumentWarning — this
 * fires regardless of the recording TARGET (device/Simulator/no device at
 * all), because the limit is the machine running Instruments itself.
 *
 * Verified live: recording "Processor Trace" on an Apple Silicon Mac (this
 * machine) fails with "<hostname> does not have a CPU that supports
 * Processor Trace" — confirming both that the constraint is real and that
 * it fires the same way whether attaching to a device or recording no target
 * at all. TEMPLATE_BUNDLES["Processor Trace"] now correctly includes "Points
 * of Interest"/"Thread Activity" (decoder-confirmed) — this warning is what
 * replaces the earlier "leave the bundle empty to avoid the instrument"
 * workaround: keep the accurate bundle, warn about the real constraint.
 */
import { describe, it, expect } from "vitest";
import { hostArchInstrumentWarning, HOST_ARCH_ONLY_INSTRUMENTS } from "../src/core/recording.js";

describe("hostArchInstrumentWarning", () => {
  it("does nothing on an Intel (x86_64) host, regardless of instruments", () => {
    expect(hostArchInstrumentWarning("Processor Trace", [], "x86_64")).toBeUndefined();
  });

  it("does nothing on Apple Silicon when nothing host-arch-limited is involved", () => {
    expect(hostArchInstrumentWarning("Time Profiler", ["Points of Interest"], "arm64")).toBeUndefined();
  });

  it("warns when the resolved template itself is host-arch-limited", () => {
    const note = hostArchInstrumentWarning("Processor Trace", [], "arm64");
    expect(note).toMatch(/Processor Trace/);
    expect(note).toMatch(/Intel PT|Intel Processor Trace/);
    expect(note).toMatch(/host-machine hardware limit/);
  });

  it("warns when a host-arch-limited instrument is requested as a bare extra", () => {
    const note = hostArchInstrumentWarning("Time Profiler", ["Processor Trace"], "arm64");
    expect(note).toMatch(/"Processor Trace"/);
  });

  it("clarifies switching device/Simulator target won't help — the limit is the host machine", () => {
    const note = hostArchInstrumentWarning("Processor Trace", [], "arm64")!;
    expect(note).toMatch(/not fixable by choosing a different device\/Simulator target/);
  });

  it("every entry in the curated map fires individually as a bare extra on arm64", () => {
    for (const name of Object.keys(HOST_ARCH_ONLY_INSTRUMENTS)) {
      const note = hostArchInstrumentWarning("Points of Interest", [name], "arm64");
      expect(note, `expected a warning for ${name}`).toBeDefined();
      expect(note).toContain(name);
    }
  });

  it("still warns with no base template at all (instruments-only recording)", () => {
    const note = hostArchInstrumentWarning(undefined, ["Processor Trace"], "arm64");
    expect(note).toMatch(/"Processor Trace"/);
  });

  it("does nothing with no base template and no host-arch-limited instruments", () => {
    expect(hostArchInstrumentWarning(undefined, ["HTTP Traffic"], "arm64")).toBeUndefined();
  });
});
