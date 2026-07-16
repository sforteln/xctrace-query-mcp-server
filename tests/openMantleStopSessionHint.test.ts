/**
 * PMT:open-mantle — integration-level regression: stopSession's thrown error
 * for a failed recording includes the "did you mean templates" hint when
 * xctrace rejected an `instruments` entry that's actually a real template
 * name. Complements instrumentNotFoundTemplateHint.test.ts's pure-function
 * coverage by guarding the actual WIRING in recordingSession.ts, not just the
 * standalone helper — this is the level real callers (start_recording/
 * stop_recording) interact with. spawnRecord is mocked (a fake EventEmitter-
 * based child process) so no real xctrace subprocess runs; the recordings
 * directory is redirected to a temp dir.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const tempRecordingsDir = mkdtempSync(join(tmpdir(), "xctrace-query-mcp-server-open-mantle-test-"));

vi.mock("../src/config.js", () => ({
  getConfig: async () => ({ searchRoots: [], fallbackCacheDir: null, recordingsDir: tempRecordingsDir }),
  updateConfig: async () => ({ searchRoots: [], fallbackCacheDir: null, recordingsDir: tempRecordingsDir }),
  defaultRecordingsDir: () => tempRecordingsDir,
  defaultFallbackCacheDir: () => tempRecordingsDir,
  configPath: () => join(tempRecordingsDir, "config.json"),
}));

/** A fake child process that immediately "fails" with the given stderr + exit code once .kill() is called. */
function makeFakeProcess(stderrText: string, exitCode: number) {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: (sig?: string) => void };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {
    // Simulate xctrace writing its rejection then exiting, asynchronously
    // (mirrors real process timing — data arrives before close).
    queueMicrotask(() => {
      proc.stderr.emit("data", Buffer.from(stderrText));
      queueMicrotask(() => proc.emit("close", exitCode));
    });
  };
  return proc;
}

let fakeProcess: ReturnType<typeof makeFakeProcess>;

vi.mock("../src/engine/record.js", () => ({
  spawnRecord: (_opts: unknown) => ({
    process: fakeProcess,
    args: ["xctrace", "record"],
  }),
}));

const { startSession, stopSession } = await import("../src/core/recordingSession.js");

afterEach(async () => {
  await rm(tempRecordingsDir, { recursive: true, force: true });
});

describe("stopSession — instrument-not-found template hint (PMT:open-mantle)", () => {
  it("includes the 'did you mean templates' hint for the real motivating case (System Trace)", async () => {
    fakeProcess = makeFakeProcess("Instrument with name 'System Trace' cannot be found", 56);
    const started = await startSession({ instruments: ["System Trace"], attach: "12345" });

    await expect(stopSession(started.recordingId)).rejects.toMatchObject({
      message: expect.stringMatching(/Did you mean templates: \["System Trace"\]\?/),
    });
  });

  it("does NOT attach a false-positive hint for a genuinely unrecognized instrument name", async () => {
    fakeProcess = makeFakeProcess("Instrument with name 'Totally Not Real' cannot be found", 56);
    const started = await startSession({ instruments: ["Totally Not Real"], attach: "12345" });

    await expect(stopSession(started.recordingId)).rejects.toMatchObject({
      message: expect.not.stringMatching(/Did you mean templates/),
    });
  });
});
