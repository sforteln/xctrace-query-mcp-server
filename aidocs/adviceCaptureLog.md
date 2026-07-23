# Advice capture log

This is NOT a `howXWorks.md` subsystem doc — it doesn't explain how any code works. It's a staging area for candidate `aiHelp()` content, decoupled from the decision of where that content should eventually live.

## Why this exists

`aiHelp(topic)` — a tool that returns deep-dive conceptual knowledge for a topic — has been proposed but deliberately not built yet. Building the tool without a body of real candidate content first would mean guessing at its shape. This file is the other half: capture advice AS IT'S DISCOVERED, keyed by topic, and defer the "does this become an `aiHelp()` entry, an in-band response hint, or a fix" decision until there's enough material to make that call well. See `aidocs/howHintsWork.md`'s "A sixth, not-yet-exposed layer" and "Curated vs. auto-derived" sections for the destination taxonomy this feeds into.

**The first question for every entry, before writing it down: can this be fixed instead?** A hint captured here that papers over a real bug is worse than useless — it masks the bug and gets harder to remove once something depends on it. Only capture genuine, irreducible facts an agent can't derive by itself.

## Entry template

```
### <topic-key> — <one-line summary>
**Instrument/template/schema:** <name(s), or "general">
**Bug-type/category:** <e.g. "large-table", "launch-mode", "correlation", "recording-composition">
**Date:** YYYY-MM-DD
**Status:** candidate | promoted-to-aiHelp | promoted-to-response | rejected
**Promoted to:** <file:line or tool name, once Status is promoted-* — leave blank otherwise>

<the actual advice content — plain prose, verified live, not guessed>
```

Topic keys should be stable and short (tool name, schema/instrument name, or issue-type) — `aiHelp()`, if it's ever built, would use these as its lookup keys directly.

## Entries

### compose-to-correlate-not-to-guess — why running two templates together matters at all
**Instrument/template/schema:** general — the design principle behind `templates`/`correlate()`
**Bug-type/category:** recording-composition, core value proposition
**Date:** 2026-07-02
**Status:** promoted-to-response (also now stated as its own explicit principle, not just implied)
**Promoted to:** `README.md`, "Want to test the relative health of your app?" section

The value of composing two templates into one recording isn't "twice the data" — it's turning a causal GUESS into a causal PROOF. Two separate single-instrument recordings can never be correlated after the fact: each has its own clock with no shared reference point, so an agent (or a developer) comparing them side by side is reduced to eyeballing rough timestamp alignment and inferring "these probably happened together." Recording both schemas in the SAME session on the SAME clock (`start_recording`'s `templates`/`instruments` composition) turns that into a direct, provable join via `correlate()` — exact interval containment, not coincidence. This is apparently not obvious even to experienced developers profiling manually (most instinctively reach for one instrument at a time, reactively) — worth stating as an explicit, standalone principle somewhere prominent (README candidate), not just implied by `correlate()`'s own "same trace, same clock" requirement text.

### vague-symptom-vs-instrument-choice — natural-language phrasing can point at the wrong `type` even when a better one exists
**Instrument/template/schema:** general (concrete instance: hangs vs. cpu)
**Bug-type/category:** recording-composition, intent design
**Date:** 2026-07-02
**Status:** promoted-to-response (see `RECORDING_INTENTS.hangs.note` in `src/core/recording.ts`) — logged here for the GENERALIZED pattern, which may recur elsewhere
**Promoted to:** `src/core/recording.ts`'s `hangs` intent note (already ships this exact guidance)

Concrete case validated live: a user asking "find why the app is hanging on scroll" naturally points an agent at `type: "hangs"` — the word in the request literally matches the intent name. But `type: "hangs"` (CPU Profiler) only tells you WHEN a hang happened (start/duration/thread), never WHAT the app was doing during it — no CPU-sampling instrument to correlate against. `type: "cpu"` (Time Profiler) is the better choice whenever the real question is causal ("why"), since it bundles Hangs + Points of Interest + Thermal State AND full CPU attribution in one pass — a strict superset. The `hangs` intent's own note already says this explicitly and steers toward `type: "cpu"` when the caller already knows they'll want causal context, but the underlying pattern is worth watching for generally: a request's own WORDING can coincidentally match a narrower/lower-fidelity `type` name when a broader one is actually the better answer, precisely because the friendly intent vocabulary is designed to read naturally against a user's own phrasing (the whole point of the abstraction) — that same naturalness is what makes the wrong-but-plausible match easy to fall into. Worth periodically checking other intent pairs for the same trap (a "narrow, name-matches-the-symptom" intent sitting next to a "broader, actually-more-useful" one) as more instruments get curated.

### launch-mode-injection — hardened targets get SIGKILLed under an injecting instrument
**Instrument/template/schema:** Allocations, Leaks (any instrument using liboainject)
**Bug-type/category:** launch-mode, macOS code signing
**Date:** 2026-06-30
**Status:** promoted-to-response (PMT:clear-crow, 2026-07-08) — the SIGKILL/code-signature-invalid signature turned out to BE detectable, resolving the entry's own open question
**Promoted to:** `src/engine/record.ts`'s `classifyRecordFailure` (new `injection-attach-failed` XctraceError kind). Verified live against a real hardened binary (TextEdit.app): xctrace's own stderr says "Failed to attach to target: Failed to attach to target process." at exit code 2 — distinct from a genuinely-missing PID's "Cannot find process for provided pid" at exit code 21 (also verified live). This message alone doesn't PROVE code-signing is the cause, so the response offers it as the most-likely explanation for launch-mode, not a certainty.

Launch-mode instrument injection (Allocations/Leaks/anything using liboainject) only works against apps built with debugging entitlements (dev/ad-hoc-signed Debug builds). Launching a hardened production/system app (e.g. TextEdit.app) under an injecting instrument gets it SIGKILLed for code-signature/library-validation reasons — the OS kills the process the instant the injection dylib tries to attach, before any app code runs. Distinguishable from a real app crash by the all-zero thread state and "Code Signature Invalid" termination reason in the crash report (verified live). This is correct OS enforcement, not a bug to work around — the fix is profiling a locally-built Debug target instead.

### attach-mode-degenerate-backtraces — attaching (vs. launching) for Allocations silently produces useless single-frame stacks
**Instrument/template/schema:** Allocations (any instrument using liboainject for backtrace capture)
**Bug-type/category:** launch-mode, attach-mode, data-fidelity
**Date:** 2026-07-06
**Status:** promoted-to-response (PMT:clear-crow, 2026-07-08) — auto-derivable from an already-computed structure, no separate scan needed, so destination 3 not destination 4
**Promoted to:** `src/core/callTree.ts`'s `degenerateBacktraceNote` — fires across all three views (tree/hot/spine) when the ENTIRE sampled population (≥10 samples) collapses to one distinct root/function whose name matches "call stack limit reached", naming the attach-vs-launch cause and steering to launch mode.

Recording Allocations via `xctrace record --attach <pid>` against an already-running, otherwise-healthy process (no crash, no SIGKILL, a completely normal-looking recording) produced 275,314 rows where EVERY backtrace resolved to a single degenerate frame — `<Call stack limit reached>` — with 1 unique backtrace across the whole table. This is a distinct, quieter failure mode from the SIGKILL case in `launch-mode-injection` above: nothing errors, nothing warns, the recording completes normally and looks superficially fine (right schema, right row count, right column shapes) — only the backtrace CONTENT is silently useless. Root cause (verified live via a controlled comparison against a `--launch`-mode recording of the same target immediately after): `--launch` injects `liboainject` via `DYLD_INSERT_LIBRARIES` before any code runs, so its allocation interposer can walk the stack reliably for the process's entire lifetime — a `--launch` recording of the identical app produced 145,033 rows with genuinely rich, multi-frame, fully-symbolicated backtraces (correct function names and binary/module attribution), with only 390 rows (0.27%, the earliest pre-runtime-init allocations before dyld/objc is even set up) showing the same degenerate stub — which is expected and correct for that narrow window, not a bug. Attach-mode's late-injection path apparently cannot reliably unwind existing call stacks. Practical rule: any test, spike, or dogfooding session that needs real Allocations backtrace data MUST use launch mode, not attach — attach-mode backtrace data can look completely normal (right shape, right row count) while being silently worthless, with no signal in the response to suggest checking.

### thermal-poi-gcd-standalone-value — some instruments only make sense composed with a companion
**Instrument/template/schema:** Thermal State, Points of Interest, general
**Bug-type/category:** recording-composition
**Date:** 2026-06-30
**Status:** promoted-to-response (PMT:sage-weasel complete, verified 2026-07-08)
**Promoted to:** `src/lenses/thermal/index.ts` (table-wide + per-row nextActions hint) + README's "want to test relative health" section. GCD Performance was INVALIDATED during sage-weasel's live verification (it carries its own backtrace, doesn't need a companion) — see roleHints.ts + PMT:azure-forge; only Thermal State ended up needing this fix.

Some instruments carry almost no standalone signal — opening a trace with e.g. just Thermal State and nothing else gives you "the device got hot" with no way to attribute WHY, since there's no CPU/backtrace data to correlate against. The general pattern: Apple's own built-in templates bundle these low-signal-alone instruments together with a signal-carrying one (Time Profiler bundles Thermal State + Points of Interest + Hangs) — that bundling pattern itself is a signal about which instruments are "supporting" vs. "primary." Verified exception that proves the rule: GCD Performance was assumed to be in this same low-signal-alone bucket (no standalone template, similar absence pattern to Thermal State) — checked live, it actually carries its own resolved backtrace column and needs no companion at all. Always verify a specific instrument's real column shape before asserting it's signal-less; don't extend this pattern to a new instrument by analogy alone.

### vm-tracker-needs-automatic-snapshotting — a recording option that isn't settable via xctrace CLI
**Instrument/template/schema:** VM Tracker
**Bug-type/category:** recording-composition, xctrace CLI limitation
**Date:** 2026-07-02
**Status:** promoted-to-response (RECORDING_INTENTS["memory-vm"] in `src/core/recording.ts`, PMT:gold-haven, 2026-07-08)
**Promoted to:** PMT:gold-haven

VM Tracker's "Regions Map" comes back empty under both attach and launch when recorded headlessly via `xctrace record`. Root cause (verified via CLI + a manual Instruments.app recording for comparison): VM Tracker needs "Automatic Snapshotting" enabled, which is template-baked and NOT exposed via `xctrace --recording-options` (`--show-recording-options` returns `{}` for both "VM Tracker" and "Virtual Memory Trace" — xctrace omits instruments with no configurable options from that output entirely, which reads as "nothing to configure" rather than "this instrument needs a setting we can't reach"). RESOLVED: workaround (a) shipped — `assets/AllocVMTrackerAuto3s.tracetemplate` (Allocations + VM Tracker with Automatic Snapshotting baked in at a 3s interval, built via Instruments.app's GUI, offline-validated) is now bundled with the published package and reachable via `type: "memory-vm"`. Verified live end-to-end through this server's own query/aggregate (not just raw xctrace): 10,000+ populated Regions Map rows. In the meantime, Allocations' own `category` column's `VM:` rows still give a usable VM breakdown without VM Tracker at all, for callers who don't need the full regions map.

### cli-gui-config-blind-spot — some instrument behavior is set ONLY inside a template definition, invisible to both xctrace CLI and Instruments.app's own GUI
**Instrument/template/schema:** general — confirmed twice independently (VM Tracker, os-log)
**Bug-type/category:** recording-composition, xctrace CLI limitation, generalizes the VM Tracker finding above
**Date:** 2026-07-02 (PMT:full-trace investigation)
**Status:** candidate
**Promoted to:**

Confirmed for a SECOND, independent instrument: `xctrace --recording-options` is not a complete configuration surface, and neither is Instruments.app's own GUI in every case. os-log's subsystem/category filter (the thing that scopes bare `com.apple.runtime-issues` logging down to a curated Hang-Risk/CFNetwork/Contacts/CoreML watchlist when os-log arrives via a real template) is invisible even in the GUI's own os_log configuration panel — that panel exposes exactly one control ("Include System-Wide Logs," unchecked by default), and unchecking it still leaves SOME filter active with zero visibility into what it is. This is the same shape as VM Tracker's Automatic Snapshotting (`--show-recording-options` returns `{}`, so it reads as "nothing to configure" rather than "a setting exists that neither tool can reach"): the setting lives ONLY inside the template's own definition, baked in at template-authoring time, reachable by neither the CLI flag surface nor the GUI's per-instrument config panel.

The practical rule this generalizes to: when a future investigation finds an instrument behaving differently than expected (different scope, different threshold, different data) with NO visible recording-option AND no GUI control to explain it, check whether this is the same pattern before assuming it's a bug in this server. The fix in both known cases is identical — use the real template as the sole base (don't decompose it into bare `--instrument` additions, which lose the template-baked config entirely, confirmed for os-log's hangsThreshold: bare `--instrument "Hangs"` gives 100ms vs. 250ms via a real template), or build a custom `.tracetemplate` that bakes in the exact desired combination (per the VM Tracker workaround above / `PMT:gold-haven`'s `AllocVMTrackerAuto3s.tracetemplate` precedent).
