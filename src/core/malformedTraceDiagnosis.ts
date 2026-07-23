/**
 * Composed diagnostic note for ANY malformed/unopenable trace — not just the
 * target-crashed case this started from. Field evidence (2026-07-23): faced
 * with a malformed trace, the AI fabricated a plausible-sounding but wrong
 * cause (an instrument-composition theory) and silently started a fresh
 * recording, when the actual cause (the attach target was still SIGSTOP'd
 * from an earlier test) was cheaply checkable. But target death/suspension
 * is only ONE of several real causes — low disk space during recording,
 * a genuine app crash, a debugger breakpoint freezing the target, the OS
 * killing something under memory pressure — so this never claims to have
 * diagnosed THE cause. It gathers what's cheaply knowable (attach-target
 * liveness when available, current free disk space) and hands the AI a
 * firm instruction: present what's known, do NOT guess a specific cause or
 * silently retry, ASK the user how they want to proceed.
 */
import { statfs } from "node:fs/promises";
import { checkTargetLiveness } from "./targetLiveness.js";
import { getConfig, defaultRecordingsDir } from "../config.js";
import { formatBytes } from "./callTree.js";

/** Below this, free disk space is worth calling out explicitly as a
 *  plausible contributor — not a hard science, just enough to flag "this is
 *  low" rather than routine. */
const LOW_DISK_THRESHOLD_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

/**
 * Build the diagnosis note for a malformed/unopenable trace.
 * `attachTarget` is the recording's original `attach` value when known
 * (undefined for a bare open_trace call with no associated recording, or a
 * launch-mode recording) — the liveness check is skipped when absent rather
 * than guessed at.
 */
export async function diagnoseMalformedTrace(attachTarget: string | undefined): Promise<string> {
  const facts: string[] = [];

  const liveness = await checkTargetLiveness(attachTarget);
  if (liveness?.note) facts.push(liveness.note);

  try {
    const config = await getConfig();
    const fsStat = await statfs(config.recordingsDir ?? defaultRecordingsDir());
    const freeBytes = fsStat.bavail * fsStat.bsize;
    if (freeBytes < LOW_DISK_THRESHOLD_BYTES) {
      facts.push(
        `Free disk space is low (${formatBytes(freeBytes)}) — running out of space mid-recording or ` +
          "mid-finalize is a real, separate cause of a malformed trace, independent of the target process."
      );
    }
  } catch {
    // best-effort only — omit rather than guess
  }

  const header =
    "This trace came out malformed. That has several genuinely different possible causes — the target " +
    "process crashing or being suspended (frozen at a breakpoint, SIGSTOP'd), the OS killing something " +
    "under memory pressure, low disk space during recording/finalize, or a known Xcode-beta instrument- " +
    "composition bug — and they are not distinguishable from the error message alone. Do not guess which " +
    "one occurred or silently start a fresh recording to work around it.";

  const factsBlock = facts.length > 0 ? `\n\nWhat's actually checkable right now:\n- ${facts.join("\n- ")}` : "";

  return (
    `${header}${factsBlock}\n\n` +
    "Tell the user what's known (including if nothing above fired) and ASK whether to keep investigating " +
    "or pause here — this is their call, not something to decide unilaterally."
  );
}
