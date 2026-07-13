/**
 * parseToc's <info><summary> parsing — what a run was ACTUALLY recorded with
 * (template/mode/time-limit/per-instrument settings), straight from xctrace's
 * own TOC. XML shape below is the REAL output captured live this session
 * (`xcrun xctrace export --input <trace> --toc`) from a bare `--instrument
 * "Hangs" --instrument "Display"` recording — not a guessed/synthetic shape.
 * Motivation: this is a reminder when reopening a trace later, and a
 * self-check against what start_recording was asked to compose (catches
 * silent fidelity loss, e.g. the Hangs threshold defaulting to 100ms bare vs
 * a template's tuned 250ms — the "Reporting Threshold" option below IS that
 * exact live-observed default, human-readable straight from xctrace).
 */
import { describe, it, expect } from "vitest";
import { parseToc } from "../src/engine/xctrace.js";

const REAL_TOC_XML = `<?xml version="1.0"?>
<trace-toc>
    <run number="1">
        <info>
            <target>
                <device platform="macOS" model="MacBook Air" name="Simon's MacBook Air"/>
                <process type="attached" return-exit-status="0" name="Xcode" pid="27497" termination-reason="exit(0)"/>
            </target>
            <summary>
                <start-date>2026-07-10T19:40:29.244-04:00</start-date>
                <end-date>2026-07-10T19:40:35.137-04:00</end-date>
                <duration>5.892702</duration>
                <end-reason>Time limit reached</end-reason>
                <instruments-version>16.0 (27A5209h)</instruments-version>
                <template-name>Blank</template-name>
                <recording-mode>Deferred</recording-mode>
                <time-limit>5 seconds</time-limit>
                <intruments-recording-settings>
                    <instrument name="Hangs">
                        <options>
                            <option key="Reporting Threshold" value="Include Brief Unresponsiveness (&gt;100ms)"/>
                        </options>
                    </instrument>
                </intruments-recording-settings>
            </summary>
        </info>
        <processes>
            <process name="Xcode" pid="27497" path="/Applications/Xcode-beta.app/Contents/MacOS/Xcode"/>
        </processes>
        <data>
            <table schema="potential-hangs" target-pid="SINGLE"/>
        </data>
        <tracks/>
    </run>
</trace-toc>`;

describe("parseToc — <info><summary> recording config (PMT:thick-haze follow-up)", () => {
  it("extracts template/mode/time-limit/duration/end-reason from a real TOC's summary block", () => {
    const toc = parseToc(REAL_TOC_XML, "/fake/path.trace");
    const summary = toc.runs[0].summary;
    expect(summary).toBeDefined();
    expect(summary!.templateName).toBe("Blank");
    expect(summary!.recordingMode).toBe("Deferred");
    expect(summary!.timeLimit).toBe("5 seconds");
    expect(summary!.duration).toBeCloseTo(5.892702);
    expect(summary!.endReason).toBe("Time limit reached");
  });

  it("extracts per-instrument settings already in human-readable form", () => {
    const toc = parseToc(REAL_TOC_XML, "/fake/path.trace");
    const settings = toc.runs[0].summary!.instrumentSettings;
    expect(settings).toEqual([
      { name: "Hangs", options: [{ key: "Reporting Threshold", value: "Include Brief Unresponsiveness (>100ms)" }] },
    ]);
  });

  it("is undefined (not a crash) when the TOC carries no summary block — older trace formats", () => {
    const noSummaryXml = `<?xml version="1.0"?>
<trace-toc>
    <run number="1">
        <data><table schema="time-profile" target-pid="SINGLE"/></data>
        <tracks/>
    </run>
</trace-toc>`;
    const toc = parseToc(noSummaryXml, "/fake/path.trace");
    expect(toc.runs[0].summary).toBeUndefined();
  });

  it("handles multiple instruments and multiple options per instrument (asArray one-vs-many)", () => {
    const multiXml = `<?xml version="1.0"?>
<trace-toc>
    <run number="1">
        <info>
            <summary>
                <template-name>Time Profiler</template-name>
                <intruments-recording-settings>
                    <instrument name="Hangs">
                        <options>
                            <option key="Reporting Threshold" value="250ms"/>
                            <option key="Detect Priority Inversions" value="false"/>
                        </options>
                    </instrument>
                    <instrument name="Time Profiler">
                        <options>
                            <option key="High Frequency" value="false"/>
                        </options>
                    </instrument>
                </intruments-recording-settings>
            </summary>
        </info>
        <data/>
        <tracks/>
    </run>
</trace-toc>`;
    const toc = parseToc(multiXml, "/fake/path.trace");
    const settings = toc.runs[0].summary!.instrumentSettings;
    expect(settings).toHaveLength(2);
    expect(settings[0]).toEqual({
      name: "Hangs",
      options: [
        { key: "Reporting Threshold", value: "250ms" },
        { key: "Detect Priority Inversions", value: "false" },
      ],
    });
    expect(settings[1]).toEqual({ name: "Time Profiler", options: [{ key: "High Frequency", value: "false" }] });
  });
});
