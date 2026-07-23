/**
 * checkTargetLiveness against REAL OS processes (spawn a real dummy child,
 * signal it, check the reported state) rather than mocking `ps`/process.kill
 * — the whole point of this module is correctly reading actual process
 * state, so a test that mocks that away would verify nothing real.
 *
 * Field motivation (2026-07-23): faced with a malformed trace, the AI
 * fabricated a plausible-but-wrong cause rather than checking whether the
 * attach target was still alive — it was, in fact, SIGSTOP'd the whole
 * time. This module closes that blind spot; these tests confirm it
 * actually detects "stopped" and "dead" correctly, not just in theory.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { checkTargetLiveness } from "../src/core/targetLiveness.js";

let child: ChildProcess | undefined;

afterEach(() => {
  if (child && !child.killed) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone — fine
    }
  }
  child = undefined;
});

/** Spawn a real, harmless long-lived process to test against. */
function spawnDummy(): Promise<number> {
  return new Promise((resolve, reject) => {
    child = spawn("sleep", ["30"]);
    child.once("spawn", () => resolve(child!.pid!));
    child.once("error", reject);
  });
}

describe("checkTargetLiveness (real process states)", () => {
  it("reports 'running' for a genuinely running process", async () => {
    const pid = await spawnDummy();
    const result = await checkTargetLiveness(String(pid));
    expect(result?.state).toBe("running");
    expect(result?.note).toBeUndefined(); // nothing surprising to report
  });

  it("reports 'stopped' with a human-facing note after SIGSTOP", async () => {
    const pid = await spawnDummy();
    process.kill(pid, "SIGSTOP");
    try {
      const result = await checkTargetLiveness(String(pid));
      expect(result?.state).toBe("stopped");
      expect(result?.note).toMatch(/SUSPENDED/);
      expect(result?.note).toMatch(/normal running app from the Dock or window list/);
      expect(result?.note).toMatch(/ask the user/i);
    } finally {
      process.kill(pid, "SIGCONT"); // undo the suspend before afterEach's SIGKILL
    }
  });

  it("reports 'dead' with a human-facing note for a PID that no longer exists", async () => {
    const pid = await spawnDummy();
    process.kill(pid, "SIGKILL");
    await new Promise((resolve) => child!.once("exit", resolve));

    const result = await checkTargetLiveness(String(pid));
    expect(result?.state).toBe("dead");
    expect(result?.note).toMatch(/no longer running/);
    expect(result?.note).toMatch(/not just backgrounded or hidden/);
    expect(result?.note).toMatch(/ask the user/i);
  });

  it("returns 'not-a-pid' for a name string (host-Mac attach-by-name), never guesses", async () => {
    const result = await checkTargetLiveness("MyApp");
    expect(result?.state).toBe("not-a-pid");
    expect(result?.note).toBeUndefined();
  });

  it("returns null for an undefined attach target (launch-mode recording)", async () => {
    const result = await checkTargetLiveness(undefined);
    expect(result).toBeNull();
  });
});
