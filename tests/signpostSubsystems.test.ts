/**
 * PMT:vivid-rill — signpostSubsystems: start_recording's only way to capture
 * custom app-defined os_signpost INTERVALS (beginInterval/endInterval →
 * OSSignpostIntervals). Verified live (test-os-signpost-subsystem-capture.md)
 * that the `os_signpost` instrument's dynamicTracingEnabledSubsystems option
 * defaults to empty and is never set by anything else in this codebase — so
 * without this param, no custom subsystem's intervals are ever captured,
 * regardless of template/instrument composition.
 *
 * spawnRecord is mocked (no real xctrace subprocess — this test only checks
 * startSession's own composition/merge logic) and the recordings directory
 * is redirected to a temp dir (never touches the user's real recordings dir).
 *
 * REAL LIVE BUG (2026-07-10): the recordingSession.ts construction of
 * signpostRecordingOptions used to set ONLY dynamicTracingEnabledSubsystems,
 * omitting os_signpost's OTHER real key (recordAllProcessesInSingleProcessMode)
 * entirely. `--recording-options <file>` requires the COMPLETE real key set
 * for every instrument it mentions — a partial object fails to LOAD at all
 * (the exact same xctrace quirk PMT:rough-bench found and fixed for
 * TEMPLATE_RECORDING_OPTIONS, but this os_signpost path predates that fix and
 * was never updated). Reproduced live: EVERY start_recording call using
 * signpostSubsystems failed at record time with xctrace's real exit code 57,
 * "The data couldn't be read because it is missing" — a misleading error that
 * reads like a missing FILE, not a missing KEY. The complete-key-set guard
 * below (against the same committed fixture PMT:rough-bench's
 * templateRecordingOptions.test.ts uses) is what this test file was missing —
 * the two pre-existing tests only asserted the ONE field they cared about,
 * never the complete object, so they passed despite hiding this bug entirely.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const REAL_KEY_SETS: Record<string, string[]> = JSON.parse(
  await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "fixtures", "xcode-27.0", "recording-option-keys.json"),
    "utf8"
  )
);

const tempRecordingsDir = mkdtempSync(join(tmpdir(), "far-swan-signpost-test-"));

vi.mock("../src/config.js", () => ({
  getConfig: async () => ({ searchRoots: [], fallbackCacheDir: null, recordingsDir: tempRecordingsDir }),
  updateConfig: async () => ({ searchRoots: [], fallbackCacheDir: null, recordingsDir: tempRecordingsDir }),
  defaultRecordingsDir: () => tempRecordingsDir,
  defaultFallbackCacheDir: () => tempRecordingsDir,
  configPath: () => join(tempRecordingsDir, "config.json"),
}));

vi.mock("../src/engine/record.js", () => ({
  spawnRecord: (opts: { template?: string; extraInstruments?: string[] }) => ({
    process: { stdout: null, stderr: null, on: () => {}, kill: () => {} },
    args: ["xctrace", "record", ...(opts.template ? ["--template", opts.template] : [])],
  }),
}));

const { startSession } = await import("../src/core/recordingSession.js");

afterEach(async () => {
  await rm(tempRecordingsDir, { recursive: true, force: true });
});

describe("signpostSubsystems", () => {
  it("composes bare os_signpost and sets dynamicTracingEnabledSubsystems", async () => {
    const result = await startSession({
      attach: "12345",
      signpostSubsystems: ["com.test.myapp"],
    });

    expect(result.compositionNote).toMatch(/os_signpost/);
    expect(result.compositionNote).toMatch(/com\.test\.myapp/);

    const optionsPath = result.tracePath.replace(/\.trace$/, ".recording-options.json");
    const written = JSON.parse(await readFile(optionsPath, "utf8"));
    expect(written.os_signpost.dynamicTracingEnabledSubsystems).toEqual(["com.test.myapp"]);
  });

  it("writes the COMPLETE real os_signpost key set, not just dynamicTracingEnabledSubsystems", async () => {
    // Guards the exact 2026-07-10 live bug: `--recording-options <file>`
    // fails to load entirely (misleading "data couldn't be read because it
    // is missing" error) when an instrument's options object is missing any
    // of its real keys — verified live this reproduces xctrace's actual exit
    // code 57 on a real recording, not just a hypothetical.
    const result = await startSession({ attach: "12345", signpostSubsystems: ["com.test.myapp"] });
    const optionsPath = result.tracePath.replace(/\.trace$/, ".recording-options.json");
    const written = JSON.parse(await readFile(optionsPath, "utf8"));
    const actualKeys = Object.keys(written.os_signpost).sort();
    const expectedKeys = [...REAL_KEY_SETS["os_signpost"]].sort();
    expect(actualKeys).toEqual(expectedKeys);
  });

  it("does not add os_signpost or recordingOptions when signpostSubsystems is omitted", async () => {
    const result = await startSession({
      attach: "12345",
      instruments: ["HTTP Traffic"],
    });

    // defaultPointsOfInterest's own note mentions dynamicTracingEnabledSubsystems
    // generically now (explaining the two-path model) — check for the SPECIFIC
    // signpostSubsystems-composition note instead of the bare phrase.
    expect(result.compositionNote ?? "").not.toMatch(/composed with dynamicTracingEnabledSubsystems/);

    const optionsPath = result.tracePath.replace(/\.trace$/, ".recording-options.json");
    await expect(readFile(optionsPath, "utf8")).rejects.toThrow();
  });

  it("signpostSubsystems alone (no template/instruments) is sufficient to compose a recording", async () => {
    const result = await startSession({
      attach: "12345",
      signpostSubsystems: ["com.test.myapp"],
    });
    expect(result.status).toBe("recording");
  });
});
