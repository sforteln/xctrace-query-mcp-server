/**
 * PMT:clear-crow — triaging the "launch-mode-injection" adviceCaptureLog
 * candidate: is the code-signing SIGKILL detectable from xctrace's own output,
 * or does it stay pure documentation? Verified live (2026-07-08) against a real
 * hardened system binary (TextEdit.app) under Allocations launch — xctrace's own
 * stderr says "Failed to attach to target: Failed to attach to target process."
 * at exit code 2, DISTINCT from a genuinely-missing PID's "Cannot find process
 * for provided pid" at exit code 21 (also verified live). Detectable → promoted
 * from a pure aiHelp/log candidate to an in-band classifyRecordFailure case.
 */
import { describe, it, expect } from "vitest";
import { classifyRecordFailure } from "../src/engine/record.js";

// Verbatim real xctrace output, captured live against TextEdit.app (a hardened
// system binary) under `xctrace record --template Allocations --launch ...`.
const REAL_INJECTION_FAILURE_STDERR = [
  "Starting recording with the Allocations template. Launching process: TextEdit.app. Time limit: 5.0 s",
  "Run issues were detected (trace is still ready to be viewed):",
  "* [Error] Failed to attach to target: Failed to attach to target process.",
  "",
  "* [Error] Failed to attach to target process",
  "",
  "\t* [Error] Failed to attach to target process.",
  "",
  "Recording failed with errors. Saving output file...",
].join("\n");

describe("PMT:clear-crow classifyRecordFailure — injection-attach-failed", () => {
  it("classifies the real launch-mode injection failure distinctly, citing code-signing as the likely cause", () => {
    const err = classifyRecordFailure(REAL_INJECTION_FAILURE_STDERR, 2, [
      "xcrun", "xctrace", "record", "--template", "Allocations", "--launch", "TextEdit.app",
    ]);
    expect(err.kind).toBe("injection-attach-failed");
    expect(err.message).toMatch(/code-signature|library-validation/i);
    expect(err.message).toMatch(/launched/i);
  });

  it("phrases attach-mode differently from launch-mode (no launched-app claim)", () => {
    const err = classifyRecordFailure("Failed to attach to target: Failed to attach to target process.", 2, [
      "xcrun", "xctrace", "record", "--template", "Allocations", "--attach", "1234",
    ]);
    expect(err.kind).toBe("injection-attach-failed");
    expect(err.message).not.toMatch(/launched/i);
  });

  it("stays distinct from target-not-found (a genuinely missing PID, different message + exit code)", () => {
    // Verified live: exit 21, not 2 — a different failure signature entirely.
    const err = classifyRecordFailure("Cannot find process for provided pid: 999999", 21, [
      "xcrun", "xctrace", "record", "--attach", "999999",
    ]);
    expect(err.kind).toBe("target-not-found");
  });
});
