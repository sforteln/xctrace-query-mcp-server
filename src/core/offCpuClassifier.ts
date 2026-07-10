/**
 * PMT:lean-pass — the off-CPU interval classifier (the "dig" layer of
 * show → narrow → dig).
 *
 * Time Profiler samples only ON-CPU threads, so a call_tree over a window
 * where the thread was off-CPU returns empty — exactly the cases that matter
 * most (stalls) — and can't say WHY. This classifier works from the OTHER
 * side: a System-Trace / `syscall` backtrace, where the thread's actual wait
 * IS captured, and names what the thread was doing.
 *
 * THE LOAD-BEARING LESSON (scratchpad 055→056→062, verified live against
 * 2026-07-07T20-27-57-animation-hitches.trace): a wait's idle-vs-blocked
 * class lives in the BACKTRACE, NOT the syscall name. The two ground-truth
 * cases prove it:
 *
 *   IDLE (row 150080, mach_msg2_trap, 41.5µs cpu / 1.92s wait) — the worst
 *   "hitch" (35.997, 83ms), a FALSE ALARM:
 *     mach_msg2_trap → … → __CFRunLoopServiceMachPort → __CFRunLoopRun →
 *     … → _DPSNextEvent → -[NSApplication run] → … → PromptManagerApp
 *   The run loop is parked waiting for the next UI event. Benign held-frame.
 *
 *   BLOCKED (row 24232, kevent_id, 411µs cpu / 61.71ms wait) — a REAL
 *   render-server stall hiding inside kevent_id:
 *     kevent_id → __DISPATCH_WAIT_FOR_QUEUE__ → _dispatch_sync_f_slow →
 *     CABackingStoreGetFrontTexture → CA::Transaction::commit() → …
 *     → __CFRUNLOOP_IS_CALLING_OUT_TO_A_SOURCE1_PERFORM_FUNCTION__ →
 *     __CFRunLoopRun → … → -[NSApplication run]
 *   The run loop is CALLING OUT (running a CoreAnimation commit) and got
 *   stuck on a synchronous wait for the render server's front texture.
 *
 * Both stacks share the identical outer scaffolding (start → …$main() →
 * NSApplicationMain → -[NSApplication run] → _DPSNextEvent → __CFRunLoopRun).
 * So the presence of _DPSNextEvent / __CFRunLoopRun proves NOTHING on its own
 * — it is in every main-thread sample, idle or busy. What distinguishes them
 * is what sits BETWEEN the run loop and the wait leaf: pure event-pump
 * plumbing (idle) vs. a run-loop CALLOUT into real work that then blocked.
 * And mach_msg2_trap AND kevent_id EACH span both idle and real blocks — so
 * name-based reasoning (the misstep that hid mechanism #3 for an entire
 * session) is structurally wrong. Classify by STACK POSITION, never by name.
 *
 * SAFETY PRINCIPLE (Opus design pass): classify IDLE only from a POSITIVE
 * allowlist of recognized run-loop/worker idle patterns. Anything with a
 * block marker is BLOCKED. Everything else defaults to UNCLASSIFIED — "here
 * is the deepest wait frame + the stack" — never a confident "benign" label.
 * Fail toward showing evidence.
 */
import { WAIT_FRAME_NAMES } from "./callTree.js";

export type OffCpuClass = "idle-in-runloop" | "blocked-on-work" | "scheduling-delay" | "timer-wait" | "unclassified";

export interface OffCpuClassification {
  class: OffCpuClass;
  /** One-line, plain-language verdict — the "show your work" finding line. */
  headline: string;
  /**
   * Why this class was chosen, grounded in the actual stack — the evidence
   * half of the narration (never just the label). Names the specific frame(s)
   * the verdict rests on.
   */
  evidence: string;
  /** The deepest recognized wait primitive (the leaf-most wait frame). */
  deepestWaitFrame: string | null;
  /** For blocked-on-work: the synchronous-wait mechanism (e.g. _dispatch_sync_f_slow). */
  blockingCall?: string;
  /** For blocked-on-work: the app/framework frame that issued the block (e.g. CABackingStoreGetFrontTexture). */
  waitingOn?: string;
  /** For idle-in-runloop: the recognized idle marker (e.g. _DPSNextEvent). */
  idleMarker?: string;
  /** For timer-wait: the recognized voluntary-sleep call (e.g. +[NSThread sleepForTimeInterval:]). */
  timerMarker?: string;
}

// ─── Frame-name vocabularies (all matched by STACK POSITION, never trusted
//     as a syscall-name shortcut — see the file header) ──────────────────────

/**
 * A few leaf wait primitives that surface in syscall backtraces but aren't in
 * callTree's WAIT_FRAME_NAMES (which was built from time-profile samples).
 * kevent_id is the marquee one — the blocked ground-truth case's leaf, and the
 * exact frame whose NAME collides with benign kqueue idle (the reason the
 * classifier must read the whole stack, not this leaf).
 */
const EXTRA_WAIT_LEAVES = new Set([
  "kevent_id",
  "__kevent_id",
  "kevent",
  "__wait4",
  "__wait4_nocancel",
  "poll",
  "__ppoll_nocancel",
]);

function isWaitFrame(name: string): boolean {
  return WAIT_FRAME_NAMES.has(name) || EXTRA_WAIT_LEAVES.has(name);
}

/**
 * EXPLICIT synchronous-block primitives — a real block, named precisely.
 * Their presence ANYWHERE in the stack means the thread was blocked waiting
 * for another queue/thread/lock, not idle-parked. This is the positive
 * block allowlist (checked before idle, so a real block can never be
 * mislabeled benign).
 */
const EXPLICIT_BLOCK_FRAMES = new Set([
  // GCD synchronous waits (one queue waiting on another)
  "_dispatch_sync_f_slow",
  "_dispatch_barrier_sync_f_slow",
  "_dispatch_sync_wait",
  "__DISPATCH_WAIT_FOR_QUEUE__",
  "_dispatch_event_loop_wait_for_ownership",
  "_dispatch_thread_event_wait_slow",
  "_dispatch_group_wait_slow",
  // locks / conditions / semaphores reached through app work
  "__psynch_cvwait",
  "__psynch_mutexwait",
  "__psynch_rw_rdlock",
  "__psynch_rw_wrlock",
  "pthread_cond_wait",
  "pthread_mutex_lock",
  "_pthread_mutex_firstfit_lock_slow",
  "semaphore_wait_trap",
  "semaphore_wait",
  "sem_wait",
  "__ulock_wait",
  "__ulock_wait2",
]);

/**
 * "The run loop is running a callout" — i.e. doing real work, not parked. If
 * the thread is off-CPU below one of these, the callout stalled: blocked. A
 * prefix match, because the exact callout kind varies
 * (__CFRUNLOOP_IS_CALLING_OUT_TO_A_SOURCE1_PERFORM_FUNCTION__,
 * ..._TO_AN_OBSERVER_CALLBACK_FUNCTION__, ..._TO_A_TIMER_CALLBACK_FUNCTION__,
 * __CFRUNLOOP_IS_SERVICING_THE_MAIN_DISPATCH_QUEUE__, …).
 */
const WORK_CALLOUT_PREFIXES = ["__CFRUNLOOP_IS_CALLING_OUT_TO_", "__CFRUNLOOP_IS_SERVICING_"];

function isWorkCalloutFrame(name: string): boolean {
  return WORK_CALLOUT_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * POSITIVE idle allowlist — recognized run-loop / worker "parked, nothing to
 * do" markers. An IDLE verdict REQUIRES one of these AND the absence of any
 * block marker (see the safety principle). Presence alone is NOT enough (the
 * outer AppKit scaffolding markers appear in busy stacks too) — the classifier
 * additionally requires the path from the marker to the wait leaf to be free
 * of work callouts.
 *
 * PRIMARY markers explain WHY the thread is parked (waiting for a UI event, a
 * GCD worker idle) — the meaningful, human-facing "here's what it was doing"
 * name. SECONDARY markers are the lower-level mechanism (a CFRunLoop servicing
 * its mach port) — a real idle signal, but only named when no primary marker
 * is present (e.g. a secondary run-loop thread with no AppKit event pump above
 * it). This is why the classifier reports _DPSNextEvent, not the leaf-most
 * __CFRunLoopServiceMachPort, for the main event loop.
 */
const IDLE_MARKER_PRIORITY: readonly string[] = [
  // AppKit main event loop — the canonical "waiting for the next UI event"
  // name a developer recognizes (preferred over the lower-level Carbon/CF
  // frames beneath it: ReceiveNextEventCommon, __CFRunLoopServiceMachPort).
  "_DPSNextEvent",
  "_DPSBlockUntilNextEventMatchingListInMode",
  "_BlockUntilNextEventMatchingListInMode",
  "ReceiveNextEventCommon",
  // GCD worker thread parked waiting for the next block
  "_dispatch_worker_thread",
  "_dispatch_worker_thread2",
  "_dispatch_worker_thread3",
  "_pthread_wqthread",
  "start_wqthread",
  // A CFRunLoop parked servicing its mach port (no callout) — a real idle
  // signal on its own for a non-AppKit run-loop thread, but the least
  // specific, so it's the last resort.
  "__CFRunLoopServiceMachPort",
];
/** The most meaningful idle marker present, by the priority above — so the
 *  main event loop reports _DPSNextEvent, not the leaf-most CF/Carbon frame. */
function findIdleMarker(frames: string[]): string | null {
  const present = new Set(frames);
  return IDLE_MARKER_PRIORITY.find((m) => present.has(m)) ?? null;
}

/**
 * A thread deliberately pausing ITSELF for a fixed duration — distinct from
 * idle-in-runloop (parked waiting for an EXTERNAL event) and blocked-on-work
 * (waiting on ANOTHER thread's work): nothing else could complete this call
 * faster, so its presence alone (once the block/callout checks above have
 * already ruled those out) is sufficient — unlike idle-in-runloop, there's no
 * "marker→leaf path must be callout-free" nuance to check, since a sleep call
 * doesn't call out into arbitrary app code the way a run loop does.
 *
 * Verified live against the real off-CPU retrospective's Session 2 trace
 * (2026-07-09T03-31-24-system-trace.trace): `+[NSThread sleepForTimeInterval:]`
 * (Thread.sleep's ObjC bridge) sits directly above `nanosleep` above the
 * `__semwait_signal` leaf. `nanosleep`/`usleep`/`sleep` are included too, for
 * the same pattern without the NSThread wrapper (a raw C-level sleep).
 *
 * Priority-ordered like IDLE_MARKER_PRIORITY, for the same reason: report the
 * human-recognizable caller-level name (`+[NSThread sleepForTimeInterval:]`)
 * over the lower-level libc primitive it calls into (`nanosleep`), when both
 * are present in the same stack.
 */
const TIMER_WAIT_MARKER_PRIORITY: readonly string[] = [
  "+[NSThread sleepForTimeInterval:]",
  "-[NSThread sleepUntilDate:]",
  "thread_sleep",
  "nanosleep",
  "usleep",
  "sleep",
];
function findTimerMarker(frames: string[]): string | null {
  const present = new Set(frames);
  return TIMER_WAIT_MARKER_PRIORITY.find((m) => present.has(m)) ?? null;
}

/** Internal plumbing to skip when naming WHAT a block is waiting on — we want
 *  the first real app/framework frame above the wait mechanism, not the GCD/
 *  pthread/kernel internals that implement the wait. */
function isPlumbingFrame(name: string): boolean {
  return (
    isWaitFrame(name) ||
    EXPLICIT_BLOCK_FRAMES.has(name) ||
    name.startsWith("_dispatch") ||
    name.startsWith("__DISPATCH") ||
    name.startsWith("_pthread") ||
    name.startsWith("__psynch") ||
    name.startsWith("mach_msg") ||
    name.startsWith("__ulock") ||
    name === "semaphore_wait" ||
    name === "semaphore_wait_trap"
  );
}

// ─── Classifier ────────────────────────────────────────────────────────────

/**
 * Classify one off-CPU wait by its backtrace. `frames` is leaf-first (frame 0
 * = the innermost wait primitive, higher indices toward `start`), matching how
 * the engine hydrates a resolved backtrace. `cputimeNs`/`waittimeNs` are the
 * syscall row's on-core vs waiting split when available — used only as
 * corroborating evidence in the narration, never as the classification gate
 * (the stack is authoritative; the times can be null).
 */
export function classifyOffCpuBacktrace(
  frames: string[],
  cputimeNs?: number | null,
  waittimeNs?: number | null
): OffCpuClassification {
  const deepestWaitFrame = frames.find((f) => isWaitFrame(f)) ?? frames[0] ?? null;
  const cpuNote = describeCpuSplit(cputimeNs, waittimeNs);

  // ── 1. BLOCKED — checked FIRST so a real block is never mislabeled idle ──
  // An explicit synchronous-block primitive names the mechanism precisely.
  // Name from the OUTERMOST block frame of the cluster (e.g. _dispatch_sync_f_slow,
  // the sync-wait ENTRY) rather than its leaf-most implementation details
  // (_dispatch_event_loop_wait_for_ownership / __DISPATCH_WAIT_FOR_QUEUE__),
  // and take waitingOn as the first real frame above THAT — the app/framework
  // call that issued the synchronous wait.
  const outermostBlockIdx = lastIndexOf(frames, (f) => EXPLICIT_BLOCK_FRAMES.has(f));
  if (outermostBlockIdx !== -1) {
    const blockingCall = frames[outermostBlockIdx];
    const waitingOn = firstRealFrameAbove(frames, outermostBlockIdx);
    return {
      class: "blocked-on-work",
      headline: waitingOn
        ? `Off-CPU BLOCKED on a synchronous wait in ${waitingOn} — a real stall, not idle`
        : `Off-CPU BLOCKED on a synchronous wait (${blockingCall}) — a real stall, not idle`,
      evidence:
        `stack shows ${blockingCall}${waitingOn ? ` under ${waitingOn}` : ""} — a synchronous ` +
        `wait for another queue/thread/lock to complete, hidden inside the ${deepestWaitFrame ?? "wait"} ` +
        `leaf (whose NAME alone would look like benign idle).${cpuNote}`,
      deepestWaitFrame,
      blockingCall,
      waitingOn: waitingOn ?? undefined,
    };
  }

  // A run-loop callout means the run loop is doing real work; off-CPU below it
  // = that work stalled. Less precisely named than an explicit block, but still
  // a real stall (the frame drop is caused by the callout not completing).
  const calloutIdx = frames.findIndex((f) => isWorkCalloutFrame(f));
  if (calloutIdx !== -1) {
    const waitingOn = firstRealFrameAbove(frames, calloutIdx);
    return {
      class: "blocked-on-work",
      headline: waitingOn
        ? `Off-CPU BLOCKED inside a run-loop callout (${waitingOn}) — real work stalled, not idle`
        : "Off-CPU BLOCKED inside a run-loop callout — real work stalled, not idle",
      evidence:
        `the run loop is CALLING OUT (${frames[calloutIdx]})${waitingOn ? ` into ${waitingOn}` : ""} ` +
        `and went off-CPU below it — it is running real work that stalled, not parked idle waiting ` +
        `for input.${cpuNote}`,
      deepestWaitFrame,
      waitingOn: waitingOn ?? undefined,
    };
  }

  // ── 2. TIMER-WAIT — a deliberate, self-initiated sleep, checked after the
  //       block checks above (so a real block can never be mislabeled a
  //       benign sleep) and before IDLE (more specific than the generic
  //       run-loop-parked pattern) ──
  const timerMarker = findTimerMarker(frames);
  if (timerMarker) {
    const waitMsText = waittimeNs != null ? ` for ${(waittimeNs / 1e6).toFixed(1)}ms` : "";
    return {
      class: "timer-wait",
      headline: `Off-CPU TIMER-WAIT — deliberately sleeping in ${timerMarker}${waitMsText} (voluntary, not a stall)`,
      evidence:
        `stack shows ${timerMarker} above the ${deepestWaitFrame ?? "wait"} leaf — a deliberate, self-initiated ` +
        `pause (Thread.sleep-style), not a stall waiting on another thread's work or an event-loop park. If this ` +
        `sleep is unexpectedly long or on a latency-sensitive thread (e.g. Main), that's the actual finding — the ` +
        `class itself is not evidence of a bug.${cpuNote}`,
      deepestWaitFrame,
      timerMarker,
    };
  }

  // ── 3. IDLE — positive allowlist only, and only if the marker→leaf path
  //       has no work callout (already ruled out above) ──
  const idleMarker = findIdleMarker(frames);
  if (idleMarker && deepestWaitFrame && isWaitFrame(deepestWaitFrame)) {
    return {
      class: "idle-in-runloop",
      headline: `Off-CPU IDLE — parked at ${idleMarker} waiting for the next event (benign held-frame)`,
      evidence:
        `stack bottoms into ${idleMarker} → ${deepestWaitFrame} with no run-loop callout and no ` +
        `synchronous-block frame between the run loop and the wait — the thread is parked with nothing ` +
        `to do, not blocked on work.${cpuNote}`,
      deepestWaitFrame,
      idleMarker,
    };
  }

  // ── 4. UNCLASSIFIED — the safe default: show the evidence, claim nothing ──
  return {
    class: "unclassified",
    headline: `Off-CPU, UNCLASSIFIED — deepest wait ${deepestWaitFrame ?? "(unknown)"}; read the stack`,
    evidence:
      `no recognized idle pattern and no synchronous-block marker in the stack — this is genuinely ` +
      `off-CPU but its class can't be positively determined from the backtrace vocabulary. Deepest wait ` +
      `frame: ${deepestWaitFrame ?? "(none recognized)"}. Read the full stack rather than assuming ` +
      `benign.${cpuNote}`,
    deepestWaitFrame,
  };
}

/** The first real (non-plumbing) frame ABOVE (outer of) `idx` — what a block
 *  is actually waiting to complete. */
function firstRealFrameAbove(frames: string[], idx: number): string | null {
  for (let i = idx + 1; i < frames.length; i++) {
    if (!isPlumbingFrame(frames[i])) return frames[i];
  }
  return null;
}

/** Highest index (outermost frame) matching `pred`, or -1. */
function lastIndexOf(frames: string[], pred: (f: string) => boolean): number {
  for (let i = frames.length - 1; i >= 0; i--) {
    if (pred(frames[i])) return i;
  }
  return -1;
}

/** A corroborating one-liner on the on-core vs waiting split (idle burns ~no
 *  CPU; a block also waits but the stack is what proves it). Soft evidence
 *  only — appended to `evidence`, never gating the class. */
function describeCpuSplit(cputimeNs?: number | null, waittimeNs?: number | null): string {
  if (cputimeNs == null || waittimeNs == null || waittimeNs <= 0) return "";
  const cpuMs = cputimeNs / 1e6;
  const waitMs = waittimeNs / 1e6;
  const pct = (cputimeNs / waittimeNs) * 100;
  return ` (on-core ${cpuMs.toFixed(2)}ms vs waiting ${waitMs.toFixed(1)}ms — ${pct < 1 ? "~0%" : pct.toFixed(1) + "%"} on CPU).`;
}
