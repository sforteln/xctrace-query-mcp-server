/**
 * PMT:ash-stone gap #1: template-less, instruments-only recording.
 *
 * xctrace falls back to its own implicit "Blank template" when --template is
 * never passed at all (verified live: `xcrun xctrace record --instrument
 * "HTTP Traffic" --attach <pid> ...` with no --template flag works and
 * prints "Starting recording with the Blank template and HTTP Traffic
 * Instrument"). RecordOptions.template is now optional — spawnRecord must
 * omit the --template flag entirely in that case, never pass a literal
 * "Blank" string (xctrace doesn't recognize that as a real template name).
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnRecord } from "../src/engine/record.js";

describe("spawnRecord — template omission for bare-instruments recording", () => {
  const handles: ReturnType<typeof spawnRecord>[] = [];

  afterEach(() => {
    for (const h of handles.splice(0)) h.process.kill();
  });

  it("omits --template entirely when no base template is given", () => {
    const handle = spawnRecord({
      extraInstruments: ["HTTP Traffic"],
      attach: "12345",
      output: "/tmp/test-bare-instruments.trace",
    });
    handles.push(handle);
    expect(handle.args).not.toContain("--template");
    expect(handle.args).not.toContain("Blank");
    expect(handle.args).toContain("--instrument");
    expect(handle.args).toContain("HTTP Traffic");
  });

  it("includes --template when a base template IS given", () => {
    const handle = spawnRecord({
      template: "Time Profiler",
      attach: "12345",
      output: "/tmp/test-with-template.trace",
    });
    handles.push(handle);
    expect(handle.args).toContain("--template");
    expect(handle.args).toContain("Time Profiler");
  });
});
