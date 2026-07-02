# Advice capture log

This is NOT a `howXWorks.md` subsystem doc — it doesn't explain how any code works. It's a staging area for candidate `aiHelp()` content (see `PMT:clear-crow` in this project's PromptManager history), decoupled from the decision of where that content should eventually live.

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

### launch-mode-injection — hardened targets get SIGKILLed under an injecting instrument
**Instrument/template/schema:** Allocations, Leaks (any instrument using liboainject)
**Bug-type/category:** launch-mode, macOS code signing
**Date:** 2026-06-30
**Status:** candidate
**Promoted to:**

Launch-mode instrument injection (Allocations/Leaks/anything using liboainject) only works against apps built with debugging entitlements (dev/ad-hoc-signed Debug builds). Launching a hardened production/system app (e.g. TextEdit.app) under an injecting instrument gets it SIGKILLed for code-signature/library-validation reasons — the OS kills the process the instant the injection dylib tries to attach, before any app code runs. Distinguishable from a real app crash by the all-zero thread state and "Code Signature Invalid" termination reason in the crash report (verified live). This is correct OS enforcement, not a bug to work around — the fix is profiling a locally-built Debug target instead.

### thermal-poi-gcd-standalone-value — some instruments only make sense composed with a companion
**Instrument/template/schema:** Thermal State, Points of Interest, general
**Bug-type/category:** recording-composition
**Date:** 2026-06-30
**Status:** candidate
**Promoted to:** partially — see PMT:sage-weasel (complete) and the "want to test relative health" README section

Some instruments carry almost no standalone signal — opening a trace with e.g. just Thermal State and nothing else gives you "the device got hot" with no way to attribute WHY, since there's no CPU/backtrace data to correlate against. The general pattern: Apple's own built-in templates bundle these low-signal-alone instruments together with a signal-carrying one (Time Profiler bundles Thermal State + Points of Interest + Hangs) — that bundling pattern itself is a signal about which instruments are "supporting" vs. "primary." Verified exception that proves the rule: GCD Performance was assumed to be in this same low-signal-alone bucket (no standalone template, similar absence pattern to Thermal State) — checked live, it actually carries its own resolved backtrace column and needs no companion at all. Always verify a specific instrument's real column shape before asserting it's signal-less; don't extend this pattern to a new instrument by analogy alone.

### vm-tracker-needs-automatic-snapshotting — a recording option that isn't settable via xctrace CLI
**Instrument/template/schema:** VM Tracker
**Bug-type/category:** recording-composition, xctrace CLI limitation
**Date:** 2026-07-02
**Status:** candidate
**Promoted to:**

VM Tracker's "Regions Map" comes back empty under both attach and launch when recorded headlessly via `xctrace record`. Root cause (verified via CLI + a manual Instruments.app recording for comparison): VM Tracker needs "Automatic Snapshotting" enabled, which is template-baked and NOT exposed via `xctrace --recording-options` (`--show-recording-options` returns `{}` for both "VM Tracker" and "Virtual Memory Trace" — xctrace omits instruments with no configurable options from that output entirely, which reads as "nothing to configure" rather than "this instrument needs a setting we can't reach"). Two untested headless workarounds: (a) ship a custom `.tracetemplate` with VM Tracker + auto-snapshot baked in, or (b) try the "Virtual Memory Trace" template instead (event-based, may populate with no config needed). In the meantime, Allocations' own `category` column's `VM:` rows already give a usable VM breakdown without VM Tracker at all.
