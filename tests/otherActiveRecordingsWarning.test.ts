/**
 * start_recording warns (never blocks, never auto-stops) when another
 * recording is already active/finalizing. Field motivation (2026-07-23):
 * `ps` turned up two real File Activity `xctrace` processes, both still
 * direct children of the live MCP server (never reparented — the server
 * simply never called stop_recording on them and moved on). This is a
 * single-user tool: unlike a multi-tenant service, there's no legitimate
 * workflow where concurrent recordings are the norm, so more than one
 * active at a time is essentially always a forgotten cleanup — worth a
 * loud warning, but only ever informational (an advanced user may have a
 * real reason and can ignore it).
 *
 * `activeRecordings` is a module-level singleton, so every recording
 * started anywhere in this file persists across `it()` blocks unless
 * explicitly stopped — each test cleans up its own recordings in an inner
 * `finally` (via a cooperative fake process that actually exits on kill)
 * rather than relying on `describe`-level isolation that doesn't exist here.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const tempRecordingsDir = mkdtempSync(join(tmpdir(), "xctrace-query-mcp-server-other-active-test-"));

vi.mock("../src/config.js", () => ({
  getConfig: async () => ({ searchRoots: [], fallbackCacheDir: null, recordingsDir: tempRecordingsDir }),
  updateConfig: async () => ({ searchRoots: [], fallbackCacheDir: null, recordingsDir: tempRecordingsDir }),
  defaultRecordingsDir: () => tempRecordingsDir,
  defaultFallbackCacheDir: () => tempRecordingsDir,
  configPath: () => join(tempRecordingsDir, "config.json"),
}));

/** A cooperative fake process — exits promptly (status -> "done") once
 *  killed, so a test can clean itself out of the shared activeRecordings
 *  map instead of leaking into later tests. */
function makeCooperativeProcess() {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {
    queueMicrotask(() => proc.emit("close", 0));
  };
  return proc;
}

vi.mock("../src/engine/record.js", () => ({
  spawnRecord: (_opts: unknown) => ({
    process: makeCooperativeProcess(),
    args: ["xctrace", "record"],
  }),
}));

const { startSession, stopSession } = await import("../src/core/recordingSession.js");

afterEach(async () => {
  await rm(tempRecordingsDir, { recursive: true, force: true });
});

describe("otherActiveRecordings warning on start_recording (single-user anti-pattern gate)", () => {
  it("omits the field entirely when nothing else is active, lists a genuinely active one, then clears once stopped", async () => {
    const first = await startSession({ template: "File Activity", attach: "11111" });
    expect(first.otherActiveRecordings).toBeUndefined();

    const second = await startSession({ template: "Animation Hitches", attach: "22222" });
    // Never blocked — the second recording started normally regardless.
    expect(second.status).toBe("recording");
    expect(second.otherActiveRecordings).toHaveLength(1);
    expect(second.otherActiveRecordings?.[0]).toMatchObject({
      recordingId: first.recordingId,
      template: "File Activity",
      status: "recording",
    });
    expect(second.otherActiveRecordings?.[0].elapsedMs).toBeGreaterThanOrEqual(0);

    // Stop both — once genuinely done, neither should show up as "other
    // active" for a subsequent recording (status filter, not just presence
    // in the map).
    await stopSession(first.recordingId);
    await stopSession(second.recordingId);
    const third = await startSession({ template: "SwiftUI", attach: "33333" });
    expect(third.otherActiveRecordings).toBeUndefined();
  });
});
