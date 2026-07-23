/**
 * Best-effort liveness check for a recording's attach target, surfaced when
 * a trace turns out malformed/unopenable — field evidence (2026-07-23) is
 * that the AI has zero visibility into whether the attached process is
 * still alive, running, or stuck (frozen at a debugger exception, SIGSTOP'd,
 * or genuinely dead), so it fabricates plausible-sounding but wrong causes
 * (an instrument-composition theory tested against a target that was the
 * whole time still SIGSTOP'd from an earlier experiment). A cheap PID check
 * closes that blind spot directly instead of leaving it to guesswork.
 *
 * Two things Simon specifically asked this to do, not just report a status:
 * (1) word it for the HUMAN, not just the AI — a suspended-but-present
 * process looks like a normal running app from the Dock/window list, so
 * "it's not just hidden behind another window" is the thing a user actually
 * needs to hear; (2) never let the AI treat this as a green light to keep
 * going on its own — the note explicitly tells it to ask the user whether
 * to continue investigating or pause, not decide unilaterally (see the
 * goal-lock pattern flagged earlier this session: silently starting a new
 * recording rather than surfacing what actually happened).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type TargetLivenessState = "running" | "stopped" | "zombie" | "unknown-alive" | "dead" | "not-a-pid";

export interface TargetLivenessResult {
  state: TargetLivenessState;
  /** Human-facing note — only present when the state is worth surfacing
   *  (stopped/zombie/dead); "running"/"unknown-alive" produce no note since
   *  there's nothing surprising to report. */
  note?: string;
}

/** macOS `ps` state-code first letter -> our category. Unlisted (I, S, R and
 *  anything else) collapses to "running" — those are all normal, unsurprising
 *  states for an actively-profiled process. */
function classifyPsState(stateCode: string): TargetLivenessState {
  const first = stateCode.trim().charAt(0).toUpperCase();
  if (first === "T") return "stopped";
  if (first === "Z") return "zombie";
  return "running";
}

/**
 * Check whether `attachTarget` (the value passed to start_recording's
 * `attach`) is still alive, and in what state. Only meaningful for a
 * numeric PID — attach-by-name (host Mac only) returns "not-a-pid" rather
 * than attempting a fragile name-based lookup. Never throws; a check that
 * can't be performed just reports "unknown-alive" (never fabricates
 * "dead" from an inconclusive result).
 */
export async function checkTargetLiveness(attachTarget: string | undefined): Promise<TargetLivenessResult | null> {
  if (!attachTarget) return null;
  const pid = Number(attachTarget);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { state: "not-a-pid" };
  }

  try {
    process.kill(pid, 0); // signal 0: existence/permission check only, sends nothing
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return {
        state: "dead",
        note:
          `The process this recording was attached to (PID ${pid}) is no longer running — it's not just ` +
          "backgrounded or hidden behind another window, the process itself has exited. Ask the user whether " +
          "to keep investigating (start a fresh recording once the app is relaunched) or pause here — don't " +
          "decide on your own.",
      };
    }
    // EPERM etc. — process exists but we can't signal it; fall through to
    // the ps-based state check rather than guessing.
  }

  try {
    const { stdout } = await execFileAsync("ps", ["-o", "state=", "-p", String(pid)]);
    const state = classifyPsState(stdout);
    if (state === "stopped") {
      return {
        state,
        note:
          `The process this recording was attached to (PID ${pid}) is currently SUSPENDED (stopped, not ` +
          "exited) — it looks like a normal running app from the Dock or window list, but it isn't executing " +
          "at all right now and won't produce new data until resumed. Ask the user whether to keep waiting/ " +
          "investigating or pause — don't decide on your own.",
      };
    }
    if (state === "zombie") {
      return {
        state,
        note:
          `The process this recording was attached to (PID ${pid}) has exited and is a zombie (exit status ` +
          "not yet reaped) — effectively dead for profiling purposes even though the PID still shows up. Ask " +
          "the user whether to keep investigating (start fresh once relaunched) or pause — don't decide on " +
          "your own.",
      };
    }
    return { state: "running" };
  } catch {
    return { state: "unknown-alive" };
  }
}
