# How recording robustness works

The write-side counterpart to `howSessionsWork.md` (the read side). Covers `start_recording`/
`stop_recording` (`src/core/recordingSession.ts`) specifically for the failure modes that show up
when the TARGET being profiled is itself in serious trouble — a severe hang or a crash — since
that's exactly when a recording is most valuable and most likely to go wrong.

## Grounding case (PMT:onyx-spark)

The test app ran a deliberate hang-induction session (Run Loops + SwiftUI, the pairing
`PMT:steel-spruce` validated) to capture a severe main-thread hang on purpose. The hang was real
and measured independently — a burst of 30 rapid app-level calls showed median 103ms / max
357ms latency on the embedded MCP path vs. single-digit-ms baseline, the same main-actor-congestion
mechanism as earlier MCP-stall findings. But the trace itself could not be captured across 3
attempts, and the reason is itself a real, generalizable finding: **the induced hang was severe
enough to freeze Xcode, which hosts both the app being profiled and every MCP connection including
this server's own.** When the target's main thread saturates hard enough, the IDE hosting the recorder
can beachball too, cutting the recording off before it finishes — the tool trying to capture the
hang became a casualty of the hang.

## Lesson 1 — prefer `timeLimit` over open-ended interactive recording when a severe hang/crash is a realistic risk

`timeLimit`'s auto-finalize is more robust than relying on an interactive `stop_recording`
round-trip, specifically because it can preserve bundle structure even if the server process (or
its host IDE) dies mid-session. Observed directly across the 3 failed attempts:

- **No `timeLimit`, interrupted by a server restart mid-record** → a completely unopenable bundle
  (missing `form.template`, "Document Missing Template Error"). The worst outcome.
- **`timeLimit` set, auto-finalized despite the interruption** → an openable bundle (valid
  `form.template`) even after the interruption — but every event schema can still come back EMPTY
  if the underlying data never flushed before the interruption happened. Opens fine, 0 rows, is
  NOT the same as "ran and found nothing" — see Lesson 2.

So: set `timeLimit` whenever there's a realistic chance the target (or its host) won't survive the
recording — a severe-hang investigation, a suspected crash reproduction, anything adversarial —
rather than only reaching for it as a convenience. Open-ended interactive recording is fine for
routine profiling where nothing is expected to go wrong.

## Lesson 2 — an openable trace with 0 rows in every schema is not proof nothing happened

Already fully covered in `howHintsWork.md` (search "finalizeWarning") — `stop_recording`'s
`finalizeWarning` exists specifically for this case, and is load-bearing, not overcautious. Don't
duplicate that reasoning here; cross-referencing so this doc's Lesson 1/3 don't read as if the
empty-schema risk were unaddressed.

## Lesson 3 — for capturing a severe hang specifically, prefer a LOW-OVERHEAD instrument over a heavy one

Routine profiling and "capture the worst hang I can trigger" are different goals with different
tradeoffs. A heavier instrument adds real load that can worsen the exact condition being captured —
in the grounding case, SwiftUI's own 852K-row `swiftui-updates` output added load that worsened the
gumming during an attempt to capture an already-severe hang, so the recorder became part of the
problem it was trying to observe.

When the goal is specifically "capture a severe hang, not routine profiling": reach for
`template: "CPU Profiler"` (low overhead — see its own `TEMPLATE_NOTES` entry for what it
does and doesn't carry) rather than composing heavy instrumentation like full SwiftUI tracing, and
combine it with a bounded `timeLimit` (Lesson 1) for the same robustness reason.

## Lesson 4 — self-profiling a host-freezing hang may not be reliably capturable at all, and that's a real constraint, not a bug to fix

If the condition being profiled is severe enough to freeze the IDE/host that's ALSO running the
recorder (as in the grounding case), there may be no recording configuration — light instrument,
short `timeLimit`, whatever — that reliably survives it, because the recorder and the target share
the same failing host. Document this as a known ceiling, not a problem to keep chasing:

- The realistic mitigations are **out-of-process or remote capture** (profiling from a separate
  machine, or a lighter-weight always-on capture path that doesn't share fate with the target), not
  a cleverer in-process recording strategy.
- Absent that infrastructure, accept a lighter-instrument/shorter-window trace as the practical
  ceiling for the worst-case hang, rather than expecting a full trace of it every time.

## Lesson 5 — when the trace itself is lost, a side-channel signal can still prove the condition happened

In the grounding case, the trace was lost across all 3 attempts, but the hang was still proven via
an independent side channel: the burst-latency measurements (median 103ms / max 357ms on the
embedded MCP path) substituted for the trace that couldn't be captured. This isn't a one-off — see
`PMT:long-arch` (draft; stdout/stderr as a zero-setup event-tagging mechanism) for the same pattern
from the other direction: ambient console noise, correlated onto the trace clock, proved a
condition happened even when it wasn't the primary intended capture target. General principle worth
keeping in mind for any severe-condition investigation: **the trace is the best evidence, not the
only evidence** — an independently-measured side channel (latency numbers, console output, a
crash/watchdog log) can corroborate or substitute for a capture that didn't survive.
