# C — Special Value Treatments (SVT) vs. the project's severity/band classification

Discovery-only audit slice (2026-07-22). Full-238 sweep of
`aidocs/engineeringTypeReference.json` section keys, cross-checked against
`scratchpad/type-audit/fixture-mnemonics.json` (74 fixture mnemonics), compared
against `src/detectors/` + `aidocs/appleModelerHarvest.md`, and mechanism recon
against the actual SQL path in `src/core/query.ts` / `src/core/aggregate.ts` /
`src/engine/sqlHydrate.ts`.

---

## Headline structural finding (confirms + extends the prior audit's reframe)

Across all 238 entries, exactly **four** section kinds exist: Display Conventions
(90), Encoding Notes (50), **Special Value Treatments (27)**, Structure (18).
Every one of the 27 SVT sections is a **Value → Color → Icon** table — an
enumerated set of (usually string) values with Apple's own display color and
one-character icon. **None of them is a numeric-range → label table.** The
"range → label" premise (e.g. "Energy Impact maps ranges to 'Very High'") is
wrong as harvested: Energy Impact's SVT rows are the labels themselves
(`Very Low`/`Low`/`High`/`Very High` → Green/Green/Orange/Red). This matches and
extends `aidocs/engineeringTypeReferenceAudit.md` § "Special Value Treatments —
reframed from the original assumption" (which covered only the 67
fixture-matched types; this sweep covers all 238 and finds no counterexample).

Only three SVTs have numeric-looking Value entries, and even those are
enumerated breakpoints, not encoded ranges:

- `abstract-power` — `0`→Gray, `1`→Green "l", `6`→Orange "m", `13`→Red "h".
  The *description* (not the SVT) supplies the numeric semantics: "A normalized
  power metric, from 0-20 … a reduction of 1 indicates 1 hour of additional
  battery life." Range semantics are implied (≥13 red etc.) but never encoded.
- `sched-priority` — `default`→Gray, `31`→Green "l", `37`→Orange "m", `93`→Red "h".
- `render-buffer-depth` — `0`→Green, `1`→Blue, `2`→Red, `3`→Purple, plus
  special codes `1000`→Clear, `1001`→Gray, `1002`→Orange, `1003`→Gray.

Second structural finding, verified in fixtures: for these engineering types the
**cell's raw value and fmt are already the qualitative label** — e.g.
`tests/fixtures/xcode-27.0/schema-table/time-sample.xml`:
`<thread-state id="7" fmt="Blocked">Blocked`. So an SVT "fake column" would not
translate a number into a label for 24 of 27 types — the label is already what
query() returns. The genuinely new information an SVT carries is **Apple's
ordinal severity color** (Red > Orange > Blue/Green > Gray/Clear) and the closed
enum of documented values.

---

## (a) Enumeration — all 27 SVT-bearing types (of 238)

"Fixtures" = mnemonic appears in fixture-mnemonics.json (10 of 27 do).
SVT rows given as `value→Color/icon`.

### CPU (5) — none in fixtures

| Mnemonic | SVT table |
|---|---|
| `core-state` | Handling Interrupt→Orange/i, Running→Blue/r, Idle→Clear/i, Unknown→Clear/- |
| `commitment` | Partial→Green/p, Full→Green/f, Over→Orange/!, Unknown→Clear/- |
| `dispatch-work-state` | Waiting in Queue→Red/w, Executing→Blue/e |
| `sched-event` | Run→Blue/r, Runnable→Red/r, Interrupted→Orange/i, Preempted→Orange/p, Wait→Gray/w, Block→Gray/b |
| `sched-priority` | default→Gray/l, 31→Green/l, 37→Orange/m, 93→Red/h |

### Energy (3) — none in fixtures

| Mnemonic | SVT table |
|---|---|
| `abstract-power` | 0→Gray/-, 1→Green/l, 6→Orange/m, 13→Red/h (desc: 0–20 normalized; 1 unit ≈ 1 h battery) |
| `energy-impact` | Unknown→Gray/-, None→Clear/-, Very Low→Green/l, Low→Green/l, High→Orange/h, Very High→Red/! |
| `gpu-power-state` | default→Orange/-, Unknown→Red/!, Off→Clear/-, On→Orange/o |

### General (10) — 7 in fixtures

| Mnemonic | Fixtures | SVT table |
|---|---|---|
| `app-period` | — | 26 rows: launch phases (Initializing→Purple, Launching-*→Green, Foreground→Blue, Background/Suspended→Gray, **Unresponsive/Over CPU Budget/Spinning→Red/!**, Exec→Red/e) |
| `event-concept` | YES (ModelInferenceTable, ModelLoadingTable, SwiftUIFilteredUpdates, SwiftUILayoutUpdates2, detected-fs-antipattern, **hitches-renders**, runloop-intervals, swiftui-layout-updates, swiftui-updates) | Fault/Failure/Critical/High→Red, Error/Moderate→Orange, Low/Success→Green, Very Low/Pedantic/Info→Gray, Debug/Normal/Signpost→Blue, plus literal color names Red/Orange/Blue/Purple/Green→themselves |
| `hang-type` | YES (potential-hangs) | unresponsive→Gray/u, Microhang→Blue/m, Hang→Orange/h, **Severe Hang→Red/!** |
| `event-type` | YES (hang-risks) | Fault→Red/!, Error→Orange/e, Debug→Blue/d, Info→Green/i, Default→Gray/- |
| `roi-class` | — | Point→Red/p, Interval→Red/r |
| `roi-kind` | — | KDebug Signpost→Red/s, Signpost→Blue/s, GCD Performance→Purple/g |
| `signpost-name` | YES (OSSignpostIntervals, PointsOfInterestEvents) | default→Blue/s (single row) |
| `swift-task-state` | YES (SwiftTaskStateTable) | Creating→Purple, Running→Blue, Suspended→Gray, Waiting→Orange, Ending→Clear, **Enqueued→Red**, Continuation→Green |
| `thermal-state` | — | Critical→Red/!, Serious→Orange/-, Fair→Green/-, Nominal→Green/-, Unknown→Gray/- |
| `thread-state` | YES (time-sample) | **Runnable→Red/r**, Preempted→Orange/p, Interrupted→Orange/i, Throttled→Green/t, Running→Blue/r, Blocked→Gray/b, Idle/Terminated→Clear, Unknown→Clear |

### Graphics (5) — 2 in fixtures

| Mnemonic | Fixtures | SVT table |
|---|---|---|
| `vsync-event` | YES (display-vsyncs-interval) | VSYNC→Red/v, APTQuantaLead→Gray/l |
| `gpu-performance-state` | — | Unknown→Gray, Minimum→Green, Medium→Blue, Maximum→Orange |
| `gpu-state` | — | Active→Purple, Idle→Clear |
| `metal-event` | — | 14 rows: mostly kind tags (Texture/Buffer→Blue, MTLEvent/ContextSwitch/AR/VR→Purple, **Error→Red/!**) + literal color names |
| `render-buffer-depth` | YES (display-surface-swap, display-vsyncs-interval, displayed-surfaces-interval) | default→Gray, 0→Green, 1→Blue, **2→Red**, 3→Purple, 1000→Clear, 1001→Gray, 1002→Orange, 1003→Gray |

### I/O (3) — 2 in fixtures

| Mnemonic | Fixtures | SVT table |
|---|---|---|
| `diskio-operation` | — | Page Out/Data Write/Metadata Write→Red, Page In/Data Read/Metadata Read→Blue |
| `network-protocol` | YES (NetworkConnectionStats, network-connection-detected) | udp/udp6/udp4→Red/u, tcp/tcp6/tcp4→Orange/t |
| `syscall` | YES (detected-fs-antipattern, fs-syscall) | default→Red/s; BSC_read/pread/recvfrom/recvmsg/read_nocancel→Red/i; BSC_write/sendto/writev/write_nocancel→Red/o |

### Internal (0) — no SVT-bearing types

### Memory (1) — not in fixtures

| Mnemonic | SVT table |
|---|---|
| `vm-op` | 13 rows, ALL Blue (Copy On Write/c, Page Cache Hit/h, Zero Fill/z, Page In/i, Page Out/o, Decompress from Swap/s, …) — icons differentiate, color carries no severity |

**In fixtures (10):** event-concept, hang-type, event-type, signpost-name,
swift-task-state, thread-state, vsync-event, render-buffer-depth,
network-protocol, syscall.
**Theoretical (17):** the 5 CPU, 3 Energy, app-period, roi-class, roi-kind,
thermal-state, gpu-performance-state, gpu-state, metal-event, diskio-operation,
vm-op.

### Drift caveat — live values escape the documented enums (verified in fixtures)

- `potential-hangs` fixture `hang-type` values: `"Brief Unresponsiveness"`,
  `"Potential Interaction Delay"` — **neither appears in the SVT**
  (unresponsive/Microhang/Hang/Severe Hang). Current Xcode's hang vocabulary has
  moved past the reference.
- `hitches-renders` fixture `frame-color` (type `event-concept`) values include
  `"Brown"` — not an SVT row (Red/Orange/Blue/Purple/Green are, Brown isn't).

Any lookup keyed on these enums must LEFT-join semantics (NULL for
undocumented values) and must not present NULL as "not severe."

---

## (b) Comparison against existing detector bands

### 1. Hitch severity (bands.ts) vs `event-concept` SVT — REINFORCES, and explains a known trap

Project side (`src/detectors/bands.ts:55-58`, from `appleModelerHarvest.md`
§1 "> 2 frame budgets → High, > 1 frame budget → Moderate, ≤ 1 → Low / none"):

> `/** aidocs #1: >1x frame budget = Moderate (≥1 dropped frame) — the outlier sweep's over-band. */`
> `export const HITCH_MODERATE_MULTIPLE = 1;`
> `/** aidocs #1: >2x frame budget = High (≥2 dropped frames) — the outlier sweep's more-severe over-band. */`
> `export const HITCH_HIGH_MULTIPLE = 2;`

Apple side (`event-concept` SVT): `High→Red "h"`, `Moderate→Orange "m"`,
`Low→Green "l"` (alongside Fault/Failure/Critical→Red above High). The
Low/Moderate/High vocabulary bands.ts derives from the modeler harvest **is**
Apple's documented event-concept severity ladder, with an explicit ordinal
color order (Green < Orange < Red). No numeric thresholds appear in the SVT, so
it cannot contradict the 1×/2× multiples — it reinforces the *labels* and adds
Apple's own color ranking on top. It also documents a tier ABOVE High
(Critical/Fault/Failure→Red "!") the project has no band for — a possible
refinement, not a contradiction.

Bonus: the SVT explains `aggregate.ts`'s curated `NON_PARTITIONING_GROUPBY`
warning ("frame-color is a severity/phase tint on a frame … not a partition"):
event-concept is a *mixed namespace* — severity words AND literal color words
(`Red→Red`, `Purple→Purple`, …) live in one enum, which is exactly why
`frame-color` grouping looks meaningful but isn't a partition.

### 2. Hang severity (harvest §3) vs `hang-type` SVT — REINFORCES the taxonomy, REFINES with a documented 4-tier ladder, but live data has drifted

Project side (`appleModelerHarvest.md:63-75`):

> "Hang risks are os-log runtime-issue FAULTS … carrying a categorical
> `severity` ∈ {"Hang Risk", "Severe Hang Risk"} … No numeric cutoff here — the
> severity is Apple's own os-log category … the well-known ~250 ms hang /
> ~500 ms severe-hang cutoffs live in compiled `info.mom`, not the plaintext
> `.clp` — treat those as version-fragile if used."

Apple side (`hang-type` SVT): `unresponsive→Gray`, `Microhang→Blue`,
`Hang→Orange`, `Severe Hang→Red "!"`. This is the documented ordinal ladder the
harvest could only infer — including a **Microhang tier below Hang** the harvest
doesn't mention. Verdict: reinforces "surface Apple's own category, don't
re-derive"; refines by supplying the full 4-tier order + colors. BUT the live
fixture (`potential-hangs`) carries `"Brief Unresponsiveness"` /
`"Potential Interaction Delay"` — vocabulary absent from the SVT — so this
enum is version-fragile in the exact way the harvest warns the ms cutoffs are.
(The prior audit doc flagged hang-type as its "highest-value hit"; this pass
adds the concrete drift evidence.)

### 3. Render baseline (frameBudget.ts) vs `render-buffer-depth` SVT — ORTHOGONAL, with one actionable hazard

Project side (`src/detectors/frameBudget.ts:215-222`): reads the
`render-buffer-depth`-typed column (mnemonic `color` on
`display-vsyncs-interval`), takes the **median** depth per display, and computes
Apple's baseline `((bufferDepth − 1) / 2) × frame budget`
(`DEFAULT_RENDER_BUFFER_DEPTH = 2` fallback).

Apple side: the SVT enumerates `0/1/2/3` (colors only — note `2`→Red,
double-buffering = least pipeline slack, consistent with the baseline formula
giving it the tightest budget) **plus special codes `1000`–`1003`**. Verdict:
no contradiction — the project uses the value arithmetically, the SVT colors
it. Hazard worth recording: if a trace ever reports the `1000`–`1003` special
codes, `tryRenderBufferDepth`'s median would be poisoned by values three orders
of magnitude out of range; the SVT is documentary evidence such codes exist.
Fixture data shows only `2` today.

### 4. QoS/priority (qosMismatch.ts) vs `sched-priority` SVT — COMPATIBLE philosophy, unused numbers

`qosMismatch.ts` deliberately has "No numeric threshold to compute here — same
'surface Apple's own category' philosophy" (it keys off the kernel's own
`mismatch-qo-s` label). The `sched-priority` SVT (31→Green, 37→Orange, 93→Red)
is Apple's documented coloring of raw priorities — potential future refinement
if a detector ever needs to band raw `sched-priority` values, but nothing today
reads that type. No conflict.

### 5. Energy / thermal — NO existing coverage; SVT is new ground, not a comparison

No detector in `src/detectors/` touches energy or thermal (grep for
energy/thermal across detectors returns nothing). `energy-impact`,
`abstract-power`, `thermal-state`, `gpu-power-state` SVTs are Apple-authored
severity ladders with **no project-side counterpart to contradict** — and none
of the four appears in any fixture, so they're theoretical until an
energy/thermal trace is ingested.

### 6. FileActivity significance (bands.ts comment) vs `syscall`/`diskio-operation` SVTs — consistent

bands.ts already records that `detected-fs-antipattern` ships pre-computed
`significance` ("High"/"Moderate"/"Low") — which is the event-concept ladder
again. The `syscall` SVT (everything Red, icons distinguish in/out) confirms
color carries no per-syscall severity there; nothing to refine.

Summary verdicts: event-concept **reinforces** the hitch bands' vocabulary;
hang-type **reinforces + refines** (4-tier ladder) but with proven live drift;
render-buffer-depth **orthogonal** with one hazard (1000+ codes vs the median);
sched-priority **compatible/unused**; energy/thermal **new ground, no overlap**;
no SVT **contradicts** any existing band. The broad pattern: SVTs encode
*categorical* severity (colors on labels); the project's bands encode *numeric*
severity (multiples of a budget). They meet only where a label column and a
duration column describe the same event (hitches, hangs).

---

## (c) Mechanism recon — the "fake column" (SVT lookup joined at query time)

### What the SQL path actually looks like

- `queryTable` (src/core/query.ts:207-237) builds a **single-table** SELECT:
  `buildDisplaySelect(fields)` (sqlHydrate.ts:207-219) emits one fragment per
  shown column — `"<base>__fmt" AS "__out_<ref>"` — then query.ts assembles
  `SELECT ${selectCols} FROM ${table} WHERE ${where} ${orderBy} LIMIT ? OFFSET ?`.
  **No JOIN exists anywhere in the query/aggregate builders**; the only
  computed select fragment precedent is the window option
  (`${buildWindowExpr(...)} AS __window`, query.ts:216) — proof the SELECT list
  is already extensible with computed columns without touching FROM.
- `aggregateTable` (aggregate.ts:318-322) is the same single-table shape:
  `SELECT key0…, ${aggExpr}, COUNT(*) FROM ${table} WHERE … GROUP BY …`.
- Per-column engineering type is available at build time: `meta.cols`
  (`SchemaCol.engineeringType`) is in hand in `queryTable` before the SELECT is
  built (it's what `hydrateCell` reads at sqlHydrate.ts:414), so mapping
  ref → engineeringType → SVT table requires no new plumbing.
- The DB (`session.db` via `getDb`) is a **persisted per-trace cache .db**
  (traceCache/sqliteStore; fingerprint-versioned, reused across sessions).

### Concrete plug-in point

The cheapest correct shape is **not a LEFT JOIN at all** but an extra computed
select fragment, added in `queryTable` right where `displayPlan.selectCols` is
assembled (query.ts:211-216), for each shown column whose
`meta.cols[i].engineeringType` has an SVT:

1. **CASE-expression variant (no table, no lifecycle):** compile the SVT map
   (≤26 rows worst case, `app-period`) into
   `CASE "<base>__fmt" WHEN 'Hang' THEN 'Orange' … ELSE NULL END AS "__out_<ref>:severity"`.
   Zero schema changes, zero writes to the persisted .db, dies with the
   statement. Since SVT keys are short labels (<256 B) they are never interned
   (intern threshold is 256 B, sqlHydrate.ts:277-291), so plain equality on
   `__fmt` is safe without `makeInternTargetResolver`.
2. **Temp-table variant (if a real join is wanted):**
   `CREATE TEMP TABLE svt_treatments(type TEXT, value TEXT, color TEXT, icon TEXT)`
   + one LEFT JOIN per SVT-bearing shown column
   (`LEFT JOIN temp.svt_treatments s_k ON s_k.type='hang-type' AND s_k.value = t."hang-type__fmt"`).
   Lifecycle: **per-connection** (SQLite TEMP tables live in the connection's
   temp db) = per-session, built lazily on first SVT-eligible call, never
   written into the persisted trace-cache .db — important, because writing a
   real table there would entangle with the cache's version-fingerprint
   invalidation. Building at ingest is the wrong layer: the SVT is
   trace-independent reference data.

### Real obstacles found

1. **Range joins are NOT actually needed.** All 27 SVTs are equality-keyed
   (label → color/icon); the three numeric-looking ones (`abstract-power`,
   `sched-priority`, `render-buffer-depth`) enumerate exact breakpoint values,
   and the JSON encodes no lo/hi bounds to range-join on. Inventing range
   semantics for them would be editorializing beyond the source. So the
   existing equality-only builder is sufficient — the anticipated
   "range joins vs equality joins" obstacle dissolves.
2. **Column/ref naming collision.** Output cells are keyed `__out_<ref>` and
   the response echoes `columnsShown`; a synthetic ref must not collide with a
   real mnemonic AND must avoid the `__` separator — `reconstructShallowChildren`
   (sqlHydrate.ts:464-501) prefix-scans sqlRow keys for `<mnemonic>__…`, and
   fieldRef's promoted-column namespace also uses `__`. A delimiter outside both
   namespaces (e.g. `hang-type:severity`) is required.
3. **The label is already the fmt value.** For 24/27 types the "raw value AND
   documented meaning" two-column framing collapses — query() already returns
   the label. The honest added column is Apple's ordinal **color** (severity
   tier), or nothing. Only render-buffer-depth / sched-priority / abstract-power
   raw numerics would gain a genuine value→meaning translation, and none of the
   latter two is in any fixture.
4. **Enum drift → NULL floods.** Verified live values outside the documented
   enums (hang-type's "Brief Unresponsiveness"/"Potential Interaction Delay";
   event-concept's "Brown"). A LEFT-join NULL must be distinguishable from
   "documented as non-severe" (Gray/Clear) or it will mislead.
5. **The reference JSON is not runtime data today.** Nothing in src/ reads
   `engineeringTypeReference.json` (grep: zero hits); it lives in aidocs/. Any
   mechanism needs the 27 SVT maps promoted into a src asset (assetPaths.ts is
   the existing pattern for bundled assets) — a build/packaging decision, not a
   query-builder one.
6. **Cache coherence is free.** `callCacheKey` already hashes the full opts
   object, so a new opt-in flag (e.g. `explainValues`) is cache-correct with no
   changes.

### Feasibility verdict

Mechanically easy — the SELECT list is the plug-in point and is already
extensible (the `__window` precedent), equality lookup suffices, and a CASE
compile avoids all table-lifecycle questions. The design question is whether
it's *worth* a column: for the fixture-live types the payoff is Apple's
severity color on labels the caller already sees (highest value: `hang-type`,
`thread-state`, `swift-task-state`, `event-concept`-typed columns like
frame-color), plus a validation/autocomplete enum for filters — not the
number→label translation originally imagined. A hint-layer surfacing
(per the project's "prefer context-sensitive hints over a lookup tool"
convention) may deliver the same meaning at lower cost than a response-shape
change; that choice is out of scope for this discovery pass.
