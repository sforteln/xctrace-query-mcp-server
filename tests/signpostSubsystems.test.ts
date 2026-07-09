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
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
