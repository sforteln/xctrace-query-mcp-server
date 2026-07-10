# Authoritative template→instrument enumeration (PMT:pine-basin)

The NSKeyedArchiver decoder (`src/core/tracetemplate.ts`) reads a
`.tracetemplate`'s **own** serialized object graph, so it enumerates every
instrument a stock template bundles — including the no-configurable-options
instruments (Thermal State, Location Energy Model, …) that are invisible to
`xcrun xctrace record --template <t> --show-recording-options`, which is how
`TEMPLATE_BUNDLES` in `src/core/recording.ts` was originally (and
incompletely) built.

## Why this is the authoritative source

There is **no single authoritative discovery method** among the three sources
`PMT:flint-crystal` was going to cross-reference — each has a different blind
spot, all confirmed live:

- `xctrace list instruments` — the full instrument catalog, but says nothing
  about which template bundles which.
- `--show-recording-options` — only lists a template's instruments that have a
  configurable option; a no-options instrument is silently omitted.
- Instruments.app "Add Instrument" GUI picker — has its own omissions (e.g.
  `Run Loops` is CLI-real but does not appear in the picker).

The template archive itself is the fourth and best source: it is what
Instruments/xctrace actually load, so its `stubInfoByUUID` map (instrument-type
identifier → `{name, identifier}`) is the ground-truth bundle. Cross-checked
against far-swan's own independently-recorded `TEMPLATE_BUNDLES["Time Profiler"]`
(`[Hangs, Points of Interest, Thermal State]`): the decoder returns exactly
those three **plus** the headline `Time Profiler` — i.e. decoder = headline +
`TEMPLATE_BUNDLES` auxiliaries, an exact match.

## ⚠️ Naming caveat before copying this into TEMPLATE_BUNDLES

A decoder **display name** is not always a valid bare `--instrument` name:

- RealityKit Trace's archive names its run-loop instrument **`Runloops`**, but
  `xctrace list instruments` calls it **`Run Loops`** (with a space). Composing
  `--instrument "Runloops"` would fail.

So each addition to `TEMPLATE_BUNDLES` must have its name reconciled against
`xctrace list instruments` before it is trusted — this is the systematic work
`PMT:flint-crystal` owns. `PMT:pine-basin` only committed the ONE already-
validated gap (Power Profiler's `Location Energy Model`, an exact-match name).

## Full enumeration (Xcode-beta, this machine)

Names are the archive's own display names — **reconcile against
`xctrace list instruments` before use**. The headline instrument (same name as
the template) is included here; `TEMPLATE_BUNDLES` stores only the auxiliaries.

| Template | Instruments (decoder display names) |
|---|---|
| Activity Monitor | Activity Monitor, Thermal State |
| Allocations | Points of Interest |
| Animation Hitches | Display, Hangs, Hitches, Thermal State, Thread Activity, Time Profiler |
| App Launch | dyld Activity, Thread Activity, Time Profiler |
| Audio System Trace | Audio Client, Audio Server, Audio Statistics, Hangs, Points of Interest, System Call Trace, System Load, Thermal State, Thread Activity, Virtual Memory Trace |
| Blank | (none) |
| CPU Counters | CPU Counters, Points of Interest, Thread Activity, Time Profiler |
| CPU Profiler | CPU Profiler, Hangs, Points of Interest, Thermal State |
| Core AI | Core AI, GPU, Neural Engine, Time Profiler |
| Core ML | Core ML, GPU, Metal Application, Neural Engine, Time Profiler |
| Data Persistence | Data Faults, Data Fetches, Data Saves |
| File Activity | Disk I/O Latency, Disk Usage, Filesystem Activity, Filesystem Suggestions |
| Foundation Models | Foundation Models |
| Game Memory | GPU, Metal Application, Metal Resource Events, Virtual Memory Trace |
| Game Performance | Display, GPU, Hangs, Metal Application, Metal Resource Events, Points of Interest, System Call Trace, System Load, Thermal State, Thread Activity, Time Profiler, Virtual Memory Trace |
| Game Performance Overview | Game Performance Overview, Thermal State, Time Profiler |
| Leaks | Points of Interest |
| Logging | os_log, os_signpost |
| Metal System Trace | Display, GPU, Hangs, Metal Application, Metal Resource Events, Thermal State, Time Profiler |
| Network | HTTP Traffic, Network Connections, Points of Interest |
| Power Profiler | Location Energy Model, Metal Performance Overview, Network Connections, Power Profiler, Thermal State, Time Profiler |
| Processor Trace | Points of Interest, Processor Trace, Thread Activity |
| RealityKit Trace | GPU, Hangs, Metal Application, RealityKit Frames, RealityKit Metrics, Runloops (→ "Run Loops"), Time Profiler |
| Swift Concurrency | Hangs, Points of Interest, Swift Actors, Swift Executors, Swift Tasks, Time Profiler |
| SwiftUI | Hangs, Hitches, SwiftUI, Time Profiler |
| System Trace | Hangs, Points of Interest, System Call Trace, System Load, Thermal State, Thread Activity, Time Profiler, Virtual Memory Trace |
| Time Profiler | Hangs, Points of Interest, Thermal State, Time Profiler |
| TimerDiagnostics | System Call Trace, Thread State Trace |
| iOSLocation | Location Energy Model |

### TEMPLATE_BUNDLES reconciliation — DONE (PMT:flint-crystal)

Every entry was reconciled to the decoder enumeration above (display name →
valid bare `--instrument` via `xctrace list instruments`, headline dropped).
The reconciled set was spot-recorded live to confirm it composes without
rejection. Changes applied to `src/core/recording.ts`:

| Template | Change |
|---|---|
| Time Profiler | none (decoder-confirmed complete) |
| SwiftUI | +Hitches |
| CPU Profiler | none (complete) |
| CPU Counters | +Thread Activity |
| Power Profiler | +Location Energy Model (pine-basin), +Network Connections, +Thermal State |
| Allocations / Leaks | none (complete) |
| Core AI | +GPU, +Neural Engine |
| Core ML | +GPU, +Metal Application, +Neural Engine |
| Processor Trace | **left `[]`** — see below |
| Network | +HTTP Traffic, +Network Connections |
| App Launch | +dyld Activity, +Thread Activity |
| Animation Hitches | +Display, +Hitches, +Thermal State, +Thread Activity |
| Swift Concurrency | +Swift Actors, +Swift Executors, +Swift Tasks |
| RealityKit Trace | **NEW** (also added to TEMPLATE_ONLY_NAMES) |
| Foundation Models | **NEW**, genuinely empty auxiliary bundle |

Two entries were NOT blindly overridden by the decoder:

- **Processor Trace** — the decoder shows the archive declares `Points of
  Interest` + `Thread Activity` + `Processor Trace`, but PMT:calm-starling
  deliberately set it to `[]` on a SCHEMA-level "no signpost schema recorded"
  finding that cannot be re-verified here (this Mac's Apple Silicon CPU does
  not support Processor Trace). Left `[]`, flagged in-code for hardware-enabled
  re-check.
- **Animation Hitches** — the decoder CONFIRMS calm-starling's "no Points of
  Interest instrument" finding (POI is genuinely absent from the archive), so
  that correction stands; the other real bundle members were added.

Naming reconciliations needed: only `Runloops` → `Run Loops` (RealityKit
Trace). `RealityKit Trace` itself is NOT a bare instrument (its instruments are
`RealityKit Frames`/`RealityKit Metrics`) → added to `TEMPLATE_ONLY_NAMES`.
`Foundation Models` IS a bare instrument, so it is composable (empty bundle).
Guarded by `tests/templateBundlesValidNames.test.ts` against a committed
`xctrace list instruments` snapshot.

Platform note: `RealityKit Frames`/`RealityKit Metrics` error on a macOS target
("does not support the macOS platform") — RealityKit Trace is for
iOS/visionOS apps. That's a runtime platform limit of those instruments, not a
bundle-correctness problem.

## Hangs threshold across templates (PMT:flint-crystal item 5 → hand to PMT:rough-bench)

`hangsThreshold` in the archive is a **3-level enum**, not raw milliseconds. The
enum→ms mapping (confirmed via `--show-recording-options`):

| enum | ms | templates |
|---|---|---|
| 1 | 250 | Time Profiler, CPU Profiler, Swift Concurrency, System Trace, **SwiftUI** |
| 2 | 100 | Metal System Trace, Game Performance, Audio System Trace |
| 3 | 33 | **Animation Hitches, RealityKit Trace** |

Finding (answers the prompt's question): **33ms is NOT Animation-Hitches-
specific** — RealityKit Trace shares it. But it is **NOT a general
"rendering-sensitive → 33ms" rule** either: it's a graded scale, and the axis
is frame-pacing/hitch focus, not rendering per se. Notably SwiftUI — a UI
template — sits at the default 250ms, while GPU/Metal/Audio system traces get
the middle 100ms tier and only the two frame-hitch templates (Animation
Hitches, RealityKit Trace) get the tightest 33ms. The bare-added default is
100ms (PMT:gravel-falcon), so preserving a template's tuned Hangs threshold on
bare composition needs, per template: Animation Hitches/RealityKit Trace → 33,
Metal System Trace/Game Performance/Audio System Trace → 100, else → 250.
Actual `TEMPLATE_RECORDING_OPTIONS` value edits are PMT:rough-bench's scope.

## Named-target findings (PMT:pine-basin items 3 & 4)

### VM Tracker "Automatic Snapshotting" (item 3)

Decoded from far-swan's own shipped `assets/AllocVMTrackerAuto3s.tracetemplate`.
The auto-snapshot config lives on the `XRVMInstrument` object, authoritatively
(replacing the earlier grep-for-known-substrings guess):

```
XRVMInstrument:
  XRVMInstrumentKey_autoSnapshot:      true       ← the auto-snapshot toggle
  XRVMInstrumentKey_snapRateMicros:    3000000    ← interval in microseconds (3 s — matches the "Auto3s" asset name)
  XRVMInstrumentKey_protectionFilter:  0
  XRVMInstrumentKey_trackInspectionHead: true
  XRVMInstrumentKey_coalesceRegions:   true
  XRVMInstrumentKey_fullPaths:         false
```

This is a template-only setting with **no CLI-reachable equivalent** (confirms
PMT:gravel-falcon's finding): `snapRateMicros` + `autoSnapshot` cannot be set
via bare `--instrument`, which is exactly why far-swan ships a pre-built,
GUI-validated template asset instead of composing it.

Caveat surfaced here: this custom template's `stubInfoByUUID` lists only
`Points of Interest`, while the actual VM instrument lives in the `$5`/`$6`
top-level entries. So for **hand-composed** templates, `stubInfoByUUID` can
under-list — it is authoritative for **stock** templates (validated above), not
necessarily for user-saved ones.

### os_log process-scope vs topic-scope (item 4)

Tested by decoding a user-composed `Foundation Models + bare os_log` template
(saved via Instruments.app GUI) against stock Hangs-bearing templates. The
prompt's hypothesis was that "Include System-Wide Logs" (process-scope) and the
subsystem/category filter (topic-scope, e.g. Hangs' `com.apple.runtime-issues`
watchlist) are two separate mechanisms, with topic-scope "very likely a property
of the pre-built template." The decoder **confirms the two-axis split but
refines where topic-scope lives:**

1. **Process-scope IS a distinct, real template key: `excludeOSLogs`** (a
   boolean on an instrument's `recordingControlState`). Found on stock Time
   Profiler and Swift Concurrency; it is the "Include System-Wide Logs"
   mechanism (inverted). It is present when explicitly set and omitted at
   default (absent on Animation Hitches).
2. **Topic-scope is NOT stored in the template at all.** `runtime-issue`
   appears **0 times** in the raw bytes of every Hangs-bearing stock template
   (Animation Hitches, Swift Concurrency, Time Profiler) — not in plaintext and
   not in any NSData blob. So `com.apple.runtime-issues` is **the Hangs
   instrument's own built-in runtime behavior**, injected when that instrument
   records, NOT a serialized template property. This *refutes* the "property of
   the template" half of the hypothesis while confirming the axes are separate.
3. **The composed FM + bare-os_log pairing genuinely lacks both:** no
   `excludeOSLogs` key at all (process-scope left at bare default) and no
   topic-scope (it has no Hangs instrument, and topic-scope isn't a template
   thing regardless) — consistent with the earlier bare-os_log CLI test
   (`subsystem=null, category=null`).

Practical upshot: a bare `os_log` added by composition can have its
process-scope set via the `excludeOSLogs` recordingOption, but there is **no**
template-level knob to reproduce Hangs' `com.apple.runtime-issues` topic
filter — that only comes from recording the Hangs instrument itself.
