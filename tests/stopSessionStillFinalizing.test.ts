/**
 * stopSession must never hang indefinitely waiting on xctrace to exit — but
 * it also must NEVER act on that (no SIGKILL) without real data on what a
 * normal vs. stuck finalize actually looks like.
 *
 * Field evidence (a real File Activity audit session on a production app): the
 * target app crashed mid-recording, xctrace got stuck past SIGINT with
 * nothing left to gracefully finalize toward, and there was no fallback —
 * the tool call (and the MCP server / Xcode session driving it) just hung
 * until a human noticed and manually killed the xctrace process.
 *
 * First fix attempt added a timed SIGKILL escalation; reviewed and
 * rejected (2026-07-23) — this server's own README documents xctrace
 * EXPORT taking up to 20 minutes on a large trace, and there's no
 * comparable data for finalize itself, so any auto-kill threshold would be
 * a guess that risks destroying a trace that was genuinely still working.
 * Current design: stopSession only ever REPORTS (stillFinalizing +
 * traceBundleGrowing) after a bounded wait; it never signals the process
 * beyond the initial SIGINT. Real finalize/stall curves are being
 * gathered separately (finalizeWaitLog.ts) to inform a future,
 * evidence-based decision.
 *
 * The wait's tuning constants live in stopStallConfig.ts specifically so
 * this test can shrink them to millisecond scale via vi.mock and run
 * against real timers.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const tempRecordingsDir = mkdtempSync(join(tmpdir(), "xctrace-query-mcp-server-force-kill-test-"));

vi.mock("../src/config.js", () => ({
  getConfig: async () => ({ searchRoots: [], fallbackCacheDir: null, recordingsDir: tempRecordingsDir }),
  updateConfig: async () => ({ searchRoots: [], fallbackCacheDir: null, recordingsDir: tempRecordingsDir }),
  defaultRecordingsDir: () => tempRecordingsDir,
  defaultFallbackCacheDir: () => tempRecordingsDir,
  configPath: () => join(tempRecordingsDir, "config.json"),
}));

// Millisecond-scale stand-ins for the real (15s poll / 90s wait) production
// values — lets this test run against real timers in well under a second.
vi.mock("../src/core/stopStallConfig.js", () => ({
  POLL_INTERVAL_MS: 15,
  WAIT_REPORT_TIMEOUT_MS: 60,
}));

// The diagnostic logger does real fs writes (by design — see
// finalizeWaitLog.ts) but a test has no reason to litter ~/Library/Logs;
// stub it out.
vi.mock("../src/core/finalizeWaitLog.js", () => ({
  logFinalizeWaitSample: () => {},
}));

/** A fake child process that ignores SIGINT entirely (simulating xctrace
 *  stuck past its target crashing) and never exits on its own. Crucially:
 *  .kill is a vi.fn() so the test can assert SIGKILL is NEVER called. */
function makeStuckProcess() {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn(); // deliberately never emits "close" — this is the stuck case
  return proc;
}

/** A normal, well-behaved fake process — exits promptly on SIGINT. Used to
 *  guard that the wait/report machinery doesn't fire spuriously on the
 *  common path (regression guard for the 852-test baseline this sits
 *  alongside). */
function makeCooperativeProcess() {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: (sig?: string) => void };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {
    queueMicrotask(() => proc.emit("close", 0));
  };
  return proc;
}

let fakeProcess: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: (sig?: string) => void };

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

describe("stopSession — reports a stall, never kills the process", () => {
  it("returns stillFinalizing: true and never sends SIGKILL when xctrace never responds", async () => {
    const stuck = makeStuckProcess();
    fakeProcess = stuck;
    const started = await startSession({ instruments: ["File Activity"], attach: "12345" });

    const result = await stopSession(started.recordingId);

    expect(result).toMatchObject({ status: "finalizing", stillFinalizing: true });
    if ("stillFinalizing" in result) {
      expect(result.waitedMs).toBeGreaterThan(0);
      expect(result.traceBundleGrowing).toBe(false); // nonexistent tracePath never "grows"
    }
    // The whole point of this design: report, never act.
    expect(stuck.kill).toHaveBeenCalledTimes(1); // the initial SIGINT only
    expect(stuck.kill).not.toHaveBeenCalledWith("SIGKILL");

    // Calling stop_recording again just resumes waiting — no duplicate SIGINT.
    await stopSession(started.recordingId);
    expect(stuck.kill).toHaveBeenCalledTimes(1);
  });

  it("does NOT report stillFinalizing when xctrace exits normally on SIGINT", async () => {
    fakeProcess = makeCooperativeProcess();
    const started = await startSession({ instruments: ["File Activity"], attach: "12345" });

    const result = await stopSession(started.recordingId);
    expect("stillFinalizing" in result).toBe(false);
    if (!("stillFinalizing" in result)) {
      expect(result.status).toBe("done");
    }
  });
});
