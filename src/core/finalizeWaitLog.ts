/**
 * Diagnostic log for stopSession's finalize wait — timestamped trace-bundle
 * size samples, written purely so we can look at real finalize curves after
 * the fact and calibrate (or decide against) any future auto-kill policy
 * from evidence instead of a guess (see recordingSession.ts's
 * waitForGracefulExit doc comment for the full reasoning).
 *
 * Always on, not gated behind a flag: each line is a few bytes, only
 * written while a recording is actually in the post-SIGINT wait (rare,
 * short-lived), and the data is exactly what's needed to answer "what does
 * a normal finalize look like vs. a stuck one" the next time either occurs
 * live. Same log directory convention as sessionLogger.ts.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG_DIR = join(homedir(), "Library", "Logs", "xctrace-query-mcp-server");

let logPath: string | null = null;

function logFilePath(): string {
  if (logPath) return logPath;
  mkdirSync(LOG_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  logPath = join(LOG_DIR, `finalize-wait-${ts}.jsonl`);
  return logPath;
}

export interface FinalizeWaitSample {
  recordingId: string;
  tracePath: string;
  /** Milliseconds since SIGINT was sent. */
  elapsedMs: number;
  /** Trace bundle size in bytes at this sample, or null if unreadable. */
  size: number | null;
}

export function logFinalizeWaitSample(sample: FinalizeWaitSample): void {
  try {
    appendFileSync(logFilePath(), JSON.stringify({ ts: new Date().toISOString(), ...sample }) + "\n");
  } catch {
    // Best-effort diagnostic only — must never break the actual wait.
  }
}
