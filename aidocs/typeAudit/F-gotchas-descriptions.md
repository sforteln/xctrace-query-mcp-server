# F — Curated Gotchas & Tool Descriptions vs Apple's Engineering Type Reference

Discovery-only audit of prose claims about engineering-type semantics in:
- `src/core/queryHints.ts` (CURATED_GOTCHAS + auto-derived grain/gotcha logic)
- `src/index.ts` (registered tool descriptions)
- `src/lenses/*/index.ts` (descriptions, hints, comments making type-semantic claims)

Cross-checked against `aidocs/engineeringTypeReference.json` (Apple's authoritative reference),
scoped to the 74 fixture mnemonics in `scratchpad/type-audit/fixture-mnemonics.json`.
No code was changed.

---

## 1. MISMATCH — our prose contradicts Apple's documented semantics

### M1. `hang-type` glossed as "main-thread vs. background" — Apple says it encodes hang SEVERITY
**Where:** `src/lenses/hangs/index.ts:160` (quickStart hint)
> "Hangs & Hitches trace — total ${HANGS_WEIGHT} by hang-type (**main-thread vs. background**) shows which kind of hang dominates"

**Apple** (`hang-type`, Hang Type Engineering Type):
> "Encodes the type of hang (**microhang, severe hang, etc.**)"
> Special Value Treatments: `unresponsive`, `Microhang`, `Hang`, `Severe Hang`.

**Fixture confirms** (`tests/fixtures/xcode-27.0/schema-table/potential-hangs.xml`): actual values are
`"Brief Unresponsiveness"` and `"Potential Interaction Delay"` — severity/kind classes. Nothing in the
type's domain distinguishes main-thread from background. The parenthetical is wrong on both the
authoritative and the empirical axis; the aggregate itself is fine, the gloss misdirects the agent's
interpretation of the resulting groups.

### M2. `is-system=false` value vocabulary — boolean columns hold 0/1 raw, "Yes"/"No" fmt, never "false"
**Where:** `src/lenses/hangs/index.ts:176` (hitches quickStart hint)
> "aggregate by is-system splits hitches into app-owned vs. system-owned; focus on **is-system=false** rows to find app regressions"

**Apple** (`boolean`, Boolean Engineering Type):
> "A yes/no boolean value. **Encoded as 0 and 1. Other values are illegal.**"
> Display Conventions: "Displays \"Yes\" or \"No\" or \"n/a\"". CLIPS Type: INTEGER. Sentinel: max.

**Fixture confirms** (`hitches.xml`): `<boolean id="6" fmt="No">0</boolean>`. The server's filter matcher
(`src/core/tableFilter.ts:matchesFilter`) compares a string value against `fmt`/`String(raw)` and a number
against `raw` — so `{ "is-system": "No" }` or `{ "is-system": 0 }` work; `{ "is-system": "false" }` matches
**nothing** (silent 0 rows), and JSON `false` is rejected by the zod input schema outright. An agent
following this hint literally gets an empty result it may read as "no app-owned hitches".

### M3. `cached=false` — same boolean vocabulary error, two places
**Where:** `src/lenses/swiftUI/index.ts:677` and `:694` (SwiftUILayoutUpdates2 / swiftui-layout-updates quickStart hints)
> "(**cached=false** rows are uncached/most costly; depth shows nesting level; …)"

**Apple:** same boolean entry as M2. **Fixture confirms** (`SwiftUILayoutUpdates2.xml`): `cached` is
engineering-type `boolean`, rows read `<boolean fmt="Yes">1</boolean>` / `<boolean fmt="No">0</boolean>`.
The working filter values are `"No"` / `0`, not `false`/"false".

### M4. kdebug-func grain claim over-generalizes: Apple's domain is start/end/**point**, not only pairs
**Where:** `src/core/queryHints.ts:153-155` (auto-derived `inferGrain`)
> "a START-or-END point event — rows come in **begin/end PAIRS; counting rows DOUBLE-COUNTS intervals**."

**Apple** (`kdebug-func`, kdebug Function Engineering Type):
> "Determines if the corresponding kdebug-code is a **start/end/point**." (Bit Width: 2 bits)

A kdebug row can be a standalone *point* emission that has no pair; for those, a row count is NOT a
double-count. The double-count warning is right for the start/end population but stated as universal.
Low severity (the advice errs safe), but the type's documented 3-value domain contradicts the
"rows come in pairs" absolutism.

### M5. INTERNAL contradiction: coreData lens says groupBy `fault-object` yields "entity types"; CURATED_GOTCHAS says it provably does not
Not an Apple mismatch (`fault-object` is engineering-type `string` — Apple's entry is just "Generic string
value") but the two project surfaces flatly disagree and both are shipped to the agent:

**`src/lenses/coreData/index.ts:99`** (quickStart hint):
> "aggregate faults by fault-object shows **which entity types fault most often**; high counts on a single entity suggest a missing relationship prefetch"

also `:43` ("total time cost **per entity**") and `:85` ("check which **entity types** fault most often").

**`src/core/queryHints.ts` CURATED_GOTCHAS["core-data-fault"]** (verified live per its own text):
> "**No separate entity-name column** — fault-object is a full description string embedding a `x-coredata://<UUID>/<EntityName>/p<N>` URI … To group/count by entity, **extract the EntityName segment yourself** … **there is no groupBy-able entity column on this schema directly**. A raw row/object count from this schema is **per-OBJECT-FAULT, not per-entity**."

If the gotcha is right (it claims live verification against a real fixture), the three lens hint phrasings
promise a per-entity result that the aggregate cannot deliver — each distinct object gets its own group.

---

## 2. The specific boolean field-report check

**Field report:** hitches' `is-system` displays "Yes"/"No" and `find()` requires the string, not a JSON boolean.

**Apple's boolean entry, in full relevant part:**
> Summary: "A yes/no boolean value. Encoded as 0 and 1. Other values are illegal."
> Usage: CLIPS Type INTEGER; Bit Width **2 bits**; **Sentinel: max**; categorical (cannot be summed/averaged).
> Display Conventions: "Displays \"Yes\" or \"No\" **or \"n/a\"**"

Findings:
1. **Display "Yes"/"No" — REINFORCED.** Exactly Apple's documented display convention; fixture rows match.
2. **Raw is numeric 0/1 — REINFORCED.** The runLoops lens already verified this live
   (`src/lenses/runLoops/index.ts:40-42`: "the raw storage for \"Yes\" is numeric 1 — verified live against
   the real TOC export (`<boolean fmt=\"Yes\">1</boolean>`)") and uses `{ "is-main": 1 }` (`:97`). Apple's
   "Encoded as 0 and 1" upgrades that reverse-engineered fact to an authoritative one — prime candidate for
   a reference citation in that comment.
3. **Boolean-input coercion is fully supported by Apple's encoding.** Since the on-disk encoding is
   *defined* to be 0/1 (other values illegal), a server-side coercion of JSON `true`→1 / `false`→0 in
   `find()`/`filter` would be lossless and spec-backed. Today the zod schemas (`val: string|number`,
   `filter: record(string|number)`) reject JSON booleans, forcing agents to know the "Yes"/1 convention —
   the exact trap M2/M3 document in our own hints.
4. **Third state exists:** boolean's Sentinel is `max` and the display convention includes **"n/a"**
   (2-bit width = room for 0, 1, sentinel). No hint anywhere mentions that a boolean column can be n/a —
   an `is-system: "Yes"` + `is-system: "No"` pair of queries may not partition the table. (Also listed as GAP G3.)

Note the asymmetry with **Allocations' `live` column**: that schema arrives via the *track-detail* export,
which synthesizes `live` as engineering-type `string` with literal `"true"`/`"false"` values (snapshot:
`"live": { "fmt": "false", "raw": "false", "type": "string" }`). So `src/lenses/allocations/index.ts:90`'s
"filter live=true" is *correct for that schema* — Apple's boolean type does not govern it. The two export
formats use opposite boolean vocabularies ("Yes"/"No" ↔ "true"/"false"), which no hint currently warns about.

---

## 3. REINFORCED — our prose matches Apple's documentation (citation candidates)

| # | Our claim (where) | Apple's text | Note |
|---|---|---|---|
| R1 | boolean raw storage "Yes"=1, filter with numeric 1 (`src/lenses/runLoops/index.ts:40-42,97`) | "Encoded as 0 and 1. Other values are illegal." | Verified-live comment can now cite the reference. |
| R2 | Nanoseconds everywhere: `startNs`/`endNs` param docs on query/find/aggregate/correlate/relate/timeline/call_tree in `src/index.ts`; FM `minDuration` "nanoseconds" (`src/lenses/foundationModels/index.ts:309`) | `duration`: "Duration in nanoseconds"; `start-time`/`event-time`: "Trace relative start time in nanoseconds"; `sample-time`: "trace relative timestamp in nanoseconds" | All four time-ish fixture types are ns. Authoritative. |
| R3 | "Every schema in a session shares one clock — a raw start/duration/timestamp value read from any other schema's row is directly usable here with no conversion" (call_tree/correlate timeRange descriptions, `src/index.ts:828-831,1063-1066`) | All time types are "**Trace relative** … in nanoseconds" | Trace-relative + same unit ⇒ shared clock. |
| R4 | timeline: "`dur` is populated only when a schema has a genuine nanoseconds-shaped duration column" (`src/index.ts:948-950`) | `duration`: ns | |
| R5 | inferGrain: "an INTERVAL / span — a row covers [start, start+duration]" (`src/core/queryHints.ts:156-158`) | `duration`: "represents the **entire span of time** an event or state was active or applicable" | Entire-span = inclusive interval semantics. |
| R6 | swiftui-updates gotcha: "'duration' (the **inclusive** … time of the update)" and the duration-vs-downstream-cost split (`queryHints.ts:73`; also swiftUI lens/list tools) | same `duration` entry; fixture: `downstream-cost` is ALSO engineering-type `duration` | "Inclusive span" reinforced; the main-thread and cascade-direction halves stay empirical. |
| R7 | core-data-fetch `spid` gotcha: "every row reads 18,446,744,073,709,551,615 (max uint64) … a SENTINEL, not a join key" (`queryHints.ts:98-99`) | `os-signpost-identifier`: "The value 0 and **UINT64_MAX are illegal (i.e. OS_SIGNPOST_ID_NULL and OS_SIGNPOST_ID_INVALID)**" | Column's display name is "Signpost Identifier" (fixture); its type is generic `uint64`, but Apple's signpost-identifier entry independently confirms UINT64_MAX means invalid/no-id. Strong citation candidate. |
| R8 | fileActivity: "significance (High/Moderate/Low) does NOT track duration … don't trust significance alone" (`src/lenses/fileActivity/index.ts:20-27,94-98,119-125`) | `event-concept`: "Used as an **adjective** to describe another type"; categorical: "Value **cannot be summed or averaged**"; High=Red, Moderate=Orange, Low=Green are display treatments | Apple types significance as a colored adjective, not a magnitude — backs the design; the 9.5s-Moderate observation stays empirical. |
| R9 | runLoops containment: "don't sum durations across nesting-level/containment-level … not a partition key" (`src/lenses/runLoops/index.ts:26-30,52-55`) | `containment-level`: "each row is **strictly contained within the time range of a parent** … indicates the depth of containment (the number of enclosing parents)" | Nested-by-construction ⇒ summing across levels double-counts. Authoritative. |
| R10 | get_row: "For backtrace columns (kperf-bt): surfaces the top-of-stack PC, frame count, and process; use call_tree for a full aggregated symbolicated call tree" (`src/index.ts:1248-1250`) | `kperf-bt`: encoded array = "first slot is the backtrace, the second is the **PC value**, the 3rd is the **process's iid**"; "require **processing before they can be used** as normal backtraces"; "Debugging display only" | Fields named in our description exist exactly; "processing required" backs routing to call_tree. |
| R11 | queryHints correlation: core-data-* / syscall carry "ONE already-resolved, symbolicated stack per row … get_row reads it directly" (`queryHints.ts:268-272`) | `backtrace` (Address Backtrace): "In extended views, the **entire symbolicated backtrace is listed**"; structured/opaque, per-row | Per-row readable stack consistent with the type; the call_tree-returns-0 half is server-empirical. |
| R12 | network lens: sum bytes by process/connection (`src/lenses/network/index.ts:97,114`) | `network-size-in-bytes`: no categorical marker; "context-free: Values have the same meaning regardless of where they appear" | Apple marks most types "cannot be summed"; bytes types are deliberately summable. Quiet reinforcement that the lens's sum is type-legal. |
| R13 | aggregate: "values formatted in the correct unit (s/ms/µs, MB/KB/B, count)" (`src/index.ts:664-665`) | duration=ns base; size-in-bytes="Memory or storage size in bytes" | Unit families match the types' documented bases. |

Count: **13 reinforced claims.**

---

## 4. UNVERIFIABLE — observed behavior the reference doesn't address (stays empirical)

- `view-name` blank for View Body rows; identity lives in `description` (`queryHints.ts` swiftui-updates + SwiftUIFilteredUpdates gotchas). Both columns are generic `string` — Apple has nothing per-column.
- correlate's intervalsFilter/eventsFilter POST-parse materialization vs timeRange streaming (swiftui-updates gotcha #3) — server implementation fact.
- hang-risks empty when Hangs composed bare (hang-risks gotcha) — template-composition behavior.
- core-data-save "aggregate requires groupBy / groupBy thread collapses to Main Thread" — server API + empirical.
- OSSignpostIntervals gated on `signpostSubsystems` / PointsOfInterestEvents instant-only capture (both gotchas + start_recording description) — recording-pipeline behavior; Apple's `os-signpost-identifier`/`signpost-name` entries say nothing about capture gating.
- hitches "long hitch with no on-CPU sample = off-CPU held frame" (hitches gotcha, animationHitches/offCpu lens copy) — analysis methodology.
- hitches.swap-id vs display-surface-swap.swap-id "DIFFERENT ID SPACES" (`animationHitches/index.ts:31-49`) — Apple documents `displayed-surface-swap` as an identifier with hex display and max sentinel but says nothing about cross-schema joinability; the differing engineering types (uint32 vs displayed-surface-swap) are *suggestive* support, not proof.
- device-display-info display-id numeric vs shared "Display N" string (`animationHitches/index.ts:124-134`) — `display-name` entry is just "name of a physical display"; join-key claim stays empirical.
- Leaks/network `ZERO_TIMESTAMP = "00:00.000.000"` ⇒ pre-attach snapshot (`leaks/index.ts:24-40`, `network/index.ts:21-27`). One nuance worth recording: the network comment calls t=0 the "sentinel xctrace uses everywhere" — Apple's documented Sentinel for the time types (`start-time`/`event-time`/`sample-time`) is **max**, not zero (zero is the *duration* type's sentinel). t=0 is a legal trace-relative instant that xctrace *conventionally* assigns to pre-existing rows — an observed convention, not the engineering-type sentinel. The word "sentinel" in those comments is colloquially fine but should not be conflated with the type-level sentinel.
- Allocations `live=true` filter (`allocations/index.ts:90`) — governed by the track-detail export's synthesized string column ("true"/"false"), outside Apple's boolean type. Correct as written, but for a format-specific reason.
- inferGrain's `tagged-backtrace` ⇒ "stack SAMPLE" rule (`queryHints.ts:150-152`) — `tagged-backtrace` does not appear in Apple's reference at all; stays wholly empirical.
- fileActivity's "significance does NOT track duration" *magnitude* observation (28 High rows < 10µs vs one Moderate 9.5s) — empirical (the type-level backing is R8).
- runLoops "Runloop Run ⊃ Busy + Individual Iteration ⊃ Waiting For Events" containment tree and the value vocabulary — the *mechanism* (containment-level) is R9; the specific labels/hierarchy stay empirical.
- aggregate description's "hitches-renders' frame-color … verified overlapping label, not a partition" — empirical.
- correlate description's "ane-hw-intervals has no thread column of its own" — empirical (schema not in reference scope).

Count: **~15 distinct empirical claims checked; none contradicted by the reference.**

---

## 5. GAP — documented type facts no hint/description currently surfaces

Max-value picks, ordered by likely payoff:

1. **`duration` Sentinel = zero.** A duration of 0 is the documented n/a sentinel — not a genuine
   zero-length interval. `aggregate(op: min/avg/p50, measure: duration)` silently includes sentinel zeros;
   inferGrain's `[start, start+duration]` framing treats 0 as instantaneous. No surface mentions this.
2. **Time types' Sentinel = max (+ 50-bit cap).** `start-time`/`event-time`/`sample-time` use max as n/a;
   a sentinel row sorts to the end of a `sort: desc` on time and falls outside every timeRange, and
   start-time is explicitly "limited to what can fit into 50-bits" (~13 days). Nothing warns that a
   max-valued timestamp means "n/a", the mirror image of the ZERO_TIMESTAMP convention we do document.
3. **boolean's third state "n/a" (Sentinel max).** is-system/is-main/cached hints all present a Yes/No
   dichotomy; Apple documents a three-way display. A Yes-query plus a No-query may not partition the table.
   Also: Apple's fixed 0/1 encoding would let find/filter accept and coerce JSON booleans safely.
4. **`size-in-bytes` and `network-size-in-bytes` Sentinel = max.** Summing/averaging byte weight columns
   (allocations size, fs-syscall size, network bytes) can include max-uint sentinel values — the exact
   failure class the spid gotcha catches for core-data-fetch, but generalized to the weight columns
   aggregate() is most often pointed at. No sentinel guard or hint exists.
5. **`event-count` Sentinel = max.** Same hazard for count-typed columns (swiftui-updates `allocations`,
   NetworkConnectionStats/network-connection-update counts).
6. **`fd` is signed-in-meaning, unsigned-in-storage; -1 = error, Sentinel max.** "Should be displayed as a
   signed value where -1 is treated as an error … -1 is valid, but the implementation type is unsigned."
   fs-syscall/detected-fs-antipattern analyses that group or filter on fd never mention that a huge raw fd
   is really -1/error.
7. **`syscall-return` "should be displayed as a signed integer", Sentinel max.** Failed-syscall detection
   (fileActivity's "Failed System Calls" category) hinges on signed reinterpretation of the raw value;
   no hint tells the agent how errors are encoded in syscall-return.
8. **`process` = {pid, device-session} "so that processes can be unique between target device recording
   sessions."** A raw pid is NOT unique across attachments/runs (and `pid`'s own entry says a process
   object "is preferred"). Relevant to pid-based joins, the multi-run default convention, and
   nested-dot-path filtering on `thread.process.pid` — nothing mentions the reuse hazard.
9. **`text-backtrace` frame semantics: first entry is the PC; the rest are RETURN locations, and with tail
   calls eliminated a frame "will be the location the thread will be returning to, even if it's not a call
   to your function."** Directly affects reading hang-risks/OSSignpostIntervals/SwiftTaskStateTable stacks
   via get_row — a middle frame is not necessarily a real caller. Unmentioned anywhere.
10. **`event-concept` has a fixed documented severity vocabulary** (Fault/Failure/Critical/High → Red;
    Error/Moderate → Orange; Low/Success → Green; Debug/Info/… ), shared by the `severity`/`significance`/
    event-concept columns across SwiftUILayoutUpdates2, detected-fs-antipattern, hitches-renders,
    ModelInference/ModelLoading tables. An authoritative value set + ordering agents could filter on,
    currently rediscovered per-trace.

(Also noted, below the top-10 bar: `cfrunloop-result` valid values are 1-4 with 0 = "Unknown";
`packed-identifier` reserves its 22-bit max as sentinel — touches network connection-serial grouping.)
