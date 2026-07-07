# Apple modeler harvest (PMT:dim-chalk)

Read-for-interop notes from Apple's shipped Instruments `.instrdst` modeler
source (CLIPS `.clp` in `Instruments.app/Contents/Packages/*/…/*.dtac/`). We
mine **techniques, column-choices, and meaning** — NOT hardcoded magic numbers
(version-fragile) and never Apple's CLIPS verbatim. Feeds the outlier-sweep
(PMT:shingle-bluff) and near-miss (PMT:tidy-shore) lenses: those encode the
bands below as tunable constants, keyed to the same columns Apple attaches
significance to.

**The single most durable lesson:** Apple's own bands are almost all **relative**
(to a frame budget, to a baseline, to a per-second rate) rather than absolute ms
— so the technique survives across devices/refresh-rates/OS versions where a
magic-number cutoff would rot. Prefer relative bands in far-swan detectors too.

Only ~4 of the 29 packages are analysis-bearing; the rest are pure
signpost→typed-table transport (`binding-rules.clp`), no detection logic. The
analysis lives in `…/modeling-rules.clp`.

---

## 1. Hitches — relative-to-frame-budget classification (the canonical pattern)

Source: `Hitches.instrdst/…/hitches-interval-modeler` + `hitches-render-modeler`.
The load-bearing signal is **duration measured in FRAME BUDGETS**, never ms.

- `frame-drop-count = duration / refresh-interval` (the display's actual refresh
  period — ~16.67 ms @60Hz, ~8.33 ms @120Hz — read from the trace, never
  assumed). Bands:
  - **> 2 frame budgets → High** (≥2 dropped frames)
  - **> 1 frame budget → Moderate** (≥1 dropped frame)
  - **≤ 1 → Low / none**
- Commit hitches: same 1×/2× refresh bands.
- Render hitches account for pipeline depth: `baseline = ((buffer-count − 1) / 2)
  × refresh-interval`; render-duration ≤ baseline → Low, ≥ 2× baseline → High.
- **Column-choices**: `duration` relative to `refresh-interval` (+ `buffer-count`
  for render). far-swan's hitches table carries `duration` and an is-system flag;
  the refresh-interval is the per-trace frame budget.
- **far-swan mapping**: a hitch outlier detector fires when `duration >
  1×frameBudget` (Moderate) / `2×frameBudget` (High). The near-miss band
  (tidy-shore) is `0.5–1× frameBudget` — "approaching a dropped frame."

## 2. FileActivity — rate-per-window + same-key correlation antipatterns

Source: `FileActivity.instrdst/…/fs-antipatterns/modeling-rules.clp`. Two detectors:

- **Excessive Writes** — count physical writes (`operation` ∈ {Data Write, Page
  Out, Metadata Write}) per `process` in a **1-second window**; fire when
  **> 15 writes/sec** (significance "Moderate"). Narrative: high write rate usually
  = involuntary flushing in a loop. *Technique: rate-per-fixed-window counting.*
  Column-choices: `process`, `operation` (write subtypes), a per-1s counter.
- **Suboptimal disk caching** — the SAME `(process, path, block)` is RE-READ
  (`operation` ∈ {Data Read, Metadata Read, Page In}) **within 10 s** of a prior
  access → a cache miss that shouldn't have happened. *Technique: same-key
  correlation within a bounded window.* Column-choices: `process`, `path`,
  `block`, `operation`; correlation window 10 s.
- Housekeeping windows (1 s / 3 s cleanup) are NOT diagnostic — ignore.

## 3. Hangs — main-thread runtime-issue faults, categorical severity

Source: `Hangs.instrdst/…/hangs-risks-modeler/modeling-rules.clp`.

- Hang risks are **os-log runtime-issue FAULTS** (subsystem
  `com.apple.runtime-issues`), taken only on the **main thread**, carrying a
  categorical `severity` ∈ {"Hang Risk", "Severe Hang Risk"}. Framework-reported
  categories (CFNetwork, Contacts, CoreML) are always "Severe Hang Risk".
- **Technique worth stealing: main-thread identification via `runloop-events
  is-main = 1`, NOT symbolication** — Apple's comment: "more reliable than
  symbolication or other methods. Every main thread should have a main runloop."
  Use this to gate any main-thread-only detector.
- No numeric cutoff here — the severity is Apple's own os-log category; there's
  nothing to threshold, just surface the fault + its severity.
- (The separate `hangs-modeler` produces the actual hang INTERVALS; the
  well-known ~250 ms hang / ~500 ms severe-hang cutoffs live in compiled
  `info.mom`, not the plaintext `.clp` — treat those as version-fragile if used.)

## 4. SwiftUI over-invalidation — column-choices (harvested from real data + the model)

Source: `SwiftUI.instrdst/…/swiftui-body-modeler` + `swiftui-link-modeler` build
the cause graph; the diagnostically load-bearing columns (confirmed live across
the swiftui-updates work) are:

- `description` — the view-body IDENTITY for View Body rows (NOT `view-name`,
  which is empty for bodies). Group/count by this.
- `duration` — inclusive main-thread time of the update (the stutter signal — NOT
  `downstream-cost`, which is cascade-to-others, a different question).
- `downstream-events` / `downstream-cost` — the invalidation cascade size.
- `root-causes` / `view-hierarchy` — the causal chain (a ` ← ` node chain).
- **Technique**: an over-invalidation is `count(description) ≫ others AND
  sum(duration) large` — the swiftui-over-invalidation detector already encodes
  this (count>100, sum(duration)>150ms as defaults).

---

## Techniques catalog (the durable, version-proof harvest)

1. **Relative-to-budget bucketing** — measure a duration in units of the frame
   budget / a computed baseline, not ms (hitches). Bands 1×/2×.
2. **Rate-per-fixed-window** — count events of a kind per (process, 1s) and
   threshold the rate (FS writes).
3. **Same-key correlation within a bounded window** — the same key recurring
   within N seconds is the antipattern (FS re-read caching).
4. **Main-thread gate via runloop is-main**, not symbolication (hangs).
5. **Categorical severity from os-log runtime-issue faults** — surface Apple's
   own category rather than re-deriving one (hangs).

## Schema → input DAG (what's modeled from what)

- `hang-risks` ← os-log, subsystem `com.apple.runtime-issues`, message-type fault,
  gated to main thread.
- hitches (interval/render/commit) ← render + commit intervals vs the display
  refresh interval + buffer count.
- `detected-fs-antipattern` ← `disk-io-routine` + `fs-syscall` events (per
  process/path/block/operation).
- swiftui causes ← body/link/displaylist signpost events → the cause graph.

## For shingle-bluff / tidy-shore

The `(column, comparator, band)` map above is Apple's own judgment of what's
diagnostically load-bearing per domain. shingle-bluff sweeps rows crossing the
**over** side of a band; tidy-shore flags the **just-under** near-miss band
(e.g. 0.5–1× frame budget). Keep every band a tunable constant (version-fragile),
and prefer the RELATIVE forms — they're why Apple's own bands survive across
devices and OS versions.
