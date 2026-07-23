/**
 * Tuning constants for stopSession's bounded wait (recordingSession.ts's
 * waitForGracefulExit). Factored into their own module purely so tests can
 * `vi.mock` this file to shrink them to millisecond scale and exercise the
 * real polling logic against real timers.
 *
 * Deliberately NOT an auto-kill mechanism (see recordingSession.ts's own
 * doc comment on waitForGracefulExit for the full reasoning): we have zero
 * live data on how long a legitimately slow finalize takes for a large or
 * kernel-heavy trace, and SIGKILLing a process based on a guessed threshold
 * risks destroying a trace that was genuinely still finalizing. So this
 * wait only ever REPORTS — it stops blocking the tool call after
 * WAIT_REPORT_TIMEOUT_MS and hands a status (still growing / not growing)
 * back to the caller, who decides whether to keep polling or intervene.
 * Nothing here ever sends a signal to the process.
 */

/** How often to sample the trace bundle's on-disk size while waiting —
 *  purely informational (feeds the "is it still growing" report and a
 *  diagnostic log), never used to decide any action. */
export const POLL_INTERVAL_MS = 15_000;
/** How long stopSession waits before giving up and returning a
 *  still-finalizing report rather than continuing to block the tool call.
 *  A guess, flagged as one — no live data yet on real finalize durations.
 *  Calling stop_recording again afterward just resumes waiting (the
 *  process is untouched), so a too-short value here costs an extra poll
 *  round-trip, not correctness. */
export const WAIT_REPORT_TIMEOUT_MS = 90_000;
