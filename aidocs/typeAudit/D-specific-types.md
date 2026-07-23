# D — Deep-dives on specific engineering types (discovery-only)

Audit slice D of the engineering-type reference audit. Sources: `aidocs/engineeringTypeReference.json`
(Apple's reference, corrected re-scrape per `aidocs/engineeringTypeReferenceAudit.md`), the committed
fixtures under `tests/fixtures/xcode-27.0/schema-table/` (values extracted with ref-resolution — the
fixtures intern repeated values via `id=`/`ref=`), and the live code in `src/engine/roleInference.ts`,
`src/engine/roleHints.ts`, `src/core/schema.ts`, `src/core/queryHints.ts`, `src/core/relate.ts`,
`src/core/correlate.ts`, `src/core/aggregate.ts`, plus the lenses that touch these columns.

Fixture-wide ground truth (grep of every `<engineering-type>` across `tests/fixtures/`):
**none** of `config-id`, `key`, `string-value`, `int64-value`, `invalid`, `row-number`,
`narrative-certainty`, `narrative-significance`, `narrative-text` appear in any committed fixture.
`containment-level` appears in 2 schemas, `event-concept` in 9 columns, `narrative` in 10 columns.

---

## (a) Configuration ID (`config-id`) — pre-modeler plumbing, NOT a data-linking key

Apple's full entry (General family, "Configuration ID Engineering Type", dev23789658):

> "Sometimes modelers require a sophisticated configuration to be fed to them via an Analysis Core
> table." … Encoding Notes: "This identifier is a unique ID that allows the modeler to know which
> key/value pairs go together to form a specific configuration element. This is similar to a record
> identifier, or a tuple identifier."

Usage flags: INTEGER, 22 bits, `identifier`, `categorical`. It belongs to a four-type cluster that
only makes sense together — the other three confirm the picture:

- `key` ("Configuration Key"): "An identifier string used in a key/value configuration table for
  modelers to receive complex configurations… the 'key' portion of the pair."
- `string-value` / `int64-value` ("Configuration String/64-bit Integer Value"): "…used in a
  key/value configuration table for modelers to receive complex configurations… the 'value' portion."

So the mechanism is: an instrument's **input** configuration is serialized as a key/value EAV table
fed INTO a modeler before modeling runs; `config-id` is the tuple id that groups a config element's
key/value rows back together. It is intra-table record plumbing on the ingest side, not an output
annotation.

**Fixture check:** zero columns of type `config-id` (or `key`/`string-value`/`int64-value`) exist in
any committed fixture — no values to read, and therefore no cross-schema correlation to test.

**Verdict:** pre-modeler/internal plumbing. It links key/value rows *within one configuration table*,
not data *across* exported analysis schemas. Nothing to do in `describe_schema`/hints today; the only
future-relevant note is that if a `config-id` column ever shows up in an export, that table is a
modeler-input configuration table (recording settings), not analysis data — worth a "this is the
instrument's own configuration, not your app's behavior" hint at that point, not before.

---

## (b) Containment Level (`containment-level`) — display-hierarchy depth integer, orthogonal to relate()/correlate() time joins

Apple's entry (General, dev104988871): "When modeling data where each row is strictly contained
within the time range of a parent, this engineering type is used to indicate the **depth of
containment (i.e. the number of enclosing 'parents')**." Display Conventions: used as a plot
*qualifier* so rows at level n visually enclose rows at level >n; "The display does not enforce that
contained row must fit within its parent's time spans. The modeler must ensure this is true."
Encoding: root = 0, values must be compact (no gaps). INTEGER, 9 bits, `identifier`, sentinel `max`.

**Fixture data** (both occurrences):

- `runloop-intervals.containment-level` ("Containment Level"), 12 rows:
  values `3` (3×, all `interval-type` = "Runloop Run"), `4` (3×, all "Individual Iteration"),
  `5` (6×, "Busy" / "Waiting For Events"). Meanwhile the *separate* `nesting-level` column
  (uint64) is constant `1` for every row. So the value encodes exactly the tree the runLoops lens
  documents: Runloop Run(3) ⊃ Individual Iteration(4) ⊃ Busy/Waiting(5). (It starts at 3, not 0 —
  the runloop rows sit under enclosing qualifier levels Apple's own UI draws above them; consistent
  with "depth of enclosing parents", and a reminder the absolute number is display-tree depth, not
  an app-domain quantity.)
- `hitches-renders.containment-level`: present in the schema pin; the roleHints comment records it
  was verified live as `0` for every top-level (non-nested) render — Metal render passes nesting
  inside another (offscreen passes).

**Mapping onto relate()/correlate():** none, and correctly so. `relate`'s time-range join
(src/core/relate.ts) computes containment from `[start, start+duration] ∋ timestamp` on the actual
time columns; `correlate` is its {time-range, exists} preset. `containment-level` never enters that
code path — and shouldn't as a *join input*, because it's a per-row depth annotation, not a key.
Where it IS relevant is the **double-counting trap**: summing durations across levels counts the
same wall-clock time 3× in runloop-intervals. That trap is currently documented only inside the
runLoops lens's `busyVsWaitingFinder` nextAction text (src/lenses/runLoops/index.ts:26-56 — "don't
sum durations across nesting-level/containment-level; filter interval-type: 'Busy'"), and roleHints
pins the column to `detail`. There is **no** `runloop-intervals` entry in `CURATED_GOTCHAS`
(src/core/queryHints.ts), so an agent that goes straight to describe_schema + aggregate without the
lens nudge gets no warning.

**Verdict:** hierarchy-depth integer for tree display (Apple's own words), matching the fixture data
exactly. It is orthogonal to relate/correlate's time-window containment and needs no join support.
The one genuine gap: the type is a *machine-readable "rows at different levels overlap in time —
don't sum across them"* signal, and it could drive an auto-derived queryHints gotcha (any schema
whose columns include engineering-type `containment-level` + a duration ⇒ "levels nest; aggregate
within one level or one interval-type"), generalizing what today is a single lens-local sentence.

---

## (c) Event Concept (`event-concept`) — Apple's severity/color adjective channel; surfaced as `label`, semantics partially curated, vocabulary unused

Apple's entry (General, dev66257045): "Used as an **adjective to describe another type**. Such as
'Warning', or 'Error'. This also may contain simple shapes or the alphabet…" — with a 20-row
**Special Value Treatments** enumeration (Value → Color → Icon), the severity core of which is:
Fault/Failure/Critical → Red "!", High → Red "h", Error → Orange "e", Moderate → Orange "m",
Low → Green "l", Success → Green, Very Low → Gray, Debug/Info/Normal/Signpost → Blue/Gray, plus
plain color names (Red/Orange/Blue/Purple/Green) rendering as bare colors.

**All 9 fixture occurrences, with actual row values:**

| schema | column (display name) | values in fixture rows |
|---|---|---|
| ModelInferenceTable | `color` (Color) | `Blue` ×2 |
| ModelLoadingTable | `transition-color` (Transition Color) | `Brown` ×12, `Blue` ×10 |
| SwiftUIFilteredUpdates | `severity` (Severity) | `Medium`, `Low` |
| SwiftUILayoutUpdates2 | `severity` | `Medium`, `Low`, `<sentinel>` |
| swiftui-layout-updates | `severity` | `Medium`, `Low`, `<sentinel>` |
| swiftui-updates | `severity` | `Medium`, `Low`, `Very Low` |
| detected-fs-antipattern | `significance` (Significance) | `High` ×28, `Moderate` ×15 |
| hitches-renders | `frame-color` (Frame Color) | `Brown` ×4, `Purple` ×4, `Green` ×4 |
| runloop-intervals | `color` (Color) | `Info` ×7, `Blue` ×5 |

What Apple's modelers annotated: two distinct usage modes share the type.
1. **Semantic severity adjectives** — `severity` (SwiftUI), `significance` (File Activity),
   `Info` (run loops). `High`/`Moderate`/`Low`/`Very Low`/`Info` are all in Apple's enumerated
   treatment table with Red/Orange/Green/Gray coloring. Notably `Medium` (SwiftUI's most common
   mid value) is NOT in Apple's table — SwiftUI's modeler uses an out-of-vocabulary word that would
   render default-Blue; so the enumeration is advisory, not closed.
2. **Plain UI color tags** — `frame-color`, `transition-color`, `color` = `Blue`/`Purple`/`Green`
   (and `Brown`, also out-of-vocabulary). These encode Instruments' timeline tinting, not severity.

**Do we surface or suppress it?** Surfaced, generically: `roleInference.ts:87` maps
`"event-concept" → role "label"` (high confidence), so describe_schema lists these columns with
role `label`, groupable, and prints the engineeringType string. Pins mostly agree (`severity`,
`significance`, `color`, `transition-color` all pinned `label`), with one deliberate demotion:
`hitches-renders.frame-color` pinned `detail` with the comment "a UI color tag… NOT a diagnostic
signal". The color-tag trap is further curated in `aggregate.ts`'s `NON_PARTITIONING_GROUPBY`
(frame-color on 4 hitches schemas: same swap-id appears under multiple colors → double-count), and
the fileActivity lens warns (verified live) that `significance` does NOT track duration. The
swiftUI lens's list tools return `severity` in cells (it's not in `HEAVY_COLUMNS`) but nothing —
lens, gotcha, or detector — interprets it.

**Verdict:** not ignored, but under-exploited and inconsistently curated. The role layer treats
event-concept as a generic label; the two real lessons (severity-flavored vs color-tag-flavored,
and "severity words don't rank cost") were each re-learned per-schema the hard way. Apple's
special-value table is a free severity ordering (Red>Orange>Green>Gray) that nothing consumes —
e.g. SwiftUI `severity` filtering ("show me the Critical/High updates first") is a natural,
currently-unhinted first cut, with the caveat that observed vocab (`Medium`, `Brown`) escapes
Apple's enumeration, so any mapping must pass unknown values through.

---

## (d) Narrative types — Apple's own curated explanation sentences; readable but never highlighted

The reference has four narrative types; only ONE appears in fixtures:

- `narrative` (dev27590759): "An entry in narrative… typically a table of these objects, occurring
  in chronological order, that **tell a story about how something has evolved**, like the life span
  of a thread…" Displayed recursively; 1500 pt display width (the widest type in the reference).
- `narrative-text` (dev76218552): a static text fragment *inside* a narrative entry — "usually only
  displayed for debugging. Not intended to be displayed in an instrument."
- `narrative-certainty` (dev136970465): 1–100 confidence for a narrative entry — debugging-only.
- `narrative-significance` (dev184352997): 3-bit importance enum, "pedantic" → "universal" —
  debugging-only.

So Apple's own guidance: `narrative` is user-facing curated content; the other three are its
internal sub-structure/metadata and are debug-only. Only `narrative` appears in exports — the
xctrace XML flattens each entry to its display string (`fmt`), so certainty/significance never
reach us anyway.

**All 10 fixture occurrences, with sampled actual values:**

| schema | column | sample values (actual fixture rows) |
|---|---|---|
| SwiftTaskStateTable | `narrative` | "Ran for 5.44 ms on actor Main Actor (0x75550177c0) on thread Main Thread (0x2732bb) (TestApp, pid: 12345) with priority High/User Initiated (25) resuming in 0x229fdddbf _SwiftData_SwiftUI"; "Suspended for 1.28 s"; "Creating for 15.42 µs" (331 rows, 317 distinct) |
| core-data-fault | `narrative` | "Fault: \"0xa9178bb8c6eca070 <x-coredata://166AEEB7…/Feature/p95>\" took: 525.08 µs" |
| core-data-relationship-fault | `narrative` | "Relationship fault: \"…/Feature/p95\" with relationship: \"prompts\" took: 301.96 µs" |
| detected-fs-antipattern | `description` | "TestApp (34205) failed performing fgetattrlist on ( Unknown Path ) with: Bad file descriptor." (28×); "performed 32 physical writes within 1 second. This can put excessive strain on physical storage media…" |
| detected-fs-antipattern | `suggestion` | "Return values indicating an error can often be overlooked. Verify that your software can tolerate and respond well to this error." (28×); "A high rate of write activity often stems from involuntarily flushing to disk, usually in a loop." (13×); "Certain file descriptor properties, such as F_NOCACHE, can cause this to occur. Consider disabling any limitations…" |
| fs-syscall | `narrative` | "TestApp (34205) failed on stat64 with path /usr/share/icu/icudt78l/brkitr/word.brk. Error = No such file or directory" |
| fs-syscall | `signature` | "stat64()" (all 10 rows) |
| hang-risks | `message` | (0 rows in fixture — schema declares it) |
| display-vsyncs-interval | `event-label` | "VSync Request 00:00.481.099" (one per row — timestamp echo, low value) |
| displayed-surfaces-interval | `event-label` | "Surface 9" / "Surface 42" / "Surface 19" (id echo, low value) |

Two tiers are visible in the data: **high-value curated prose** (detected-fs-antipattern's
`description` + `suggestion` — literal remediation advice authored by Apple; fs-syscall's failure
explanation; SwiftTaskStateTable's per-state story with actor/thread/priority/resume-site baked in;
core-data fault narratives embedding entity URIs + cost) vs **label echoes** (the two Display
`event-label` columns, which just restate an id/timestamp).

**Are we surfacing these?** Readable but never highlighted:
- `roleInference.ts:107` maps `narrative → detail` ("explicitly opaque/verbose/flag types"), and
  every pinned schema agrees (`narrative`/`description`/`suggestion`/`message` → `detail` in
  roleHints; fs-syscall's `signature`/`narrative` aren't pinned and fall to the same rule).
- describe_schema lists them (role `detail`), and query/get_row return their values — nothing drops
  the data.
- But NO lens, gotcha, or detector points at them. `CURATED_GOTCHAS` has fs-antipattern-adjacent
  entries but none mention `description`/`suggestion`; the fileActivity lens's guidance discusses
  `type`/`significance`/duration and never says "the `suggestion` column contains Apple's own fix
  advice". The only "narrative-description" references in code (frameBudget.ts, bands.ts,
  roleHints hitches pin) concern hitches' `narrative-description`, which is engineering-type
  `string`, not `narrative`.

**Verdict:** authoritative curated content sitting unused — specifically the detected-fs-antipattern
`suggestion` column, which is Apple handing the agent the remediation sentence, and the
SwiftTaskStateTable/fs-syscall/core-data narratives, which are ready-made findings sentences. The
`detail` role is *correct* (they're not groupable partition keys — 317/331 distinct in
SwiftTaskStateTable), so the gap is purely in the hint layers: nothing tells the agent "this schema
carries an Apple-authored explanation column; read it before deriving your own explanation". The
event-label flavor shows the type alone isn't a quality guarantee — any hint should be per-column
curated (or filtered by distinct-ratio), not blanket per-type.

---

## (e) Internal family — 2 types, absent from fixtures, de facto suppressed; no active suppression needed yet

The reference's `Internal` family contains exactly two entries:

- `invalid` ("Invalid Engineering Type"): "Sentinel used throughout the Analysis Core to indicate
  that an engineering type return value is invalid." CLIPS type is the sentinel itself. Display
  Conventions: "**Never shown in UI.**"
- `row-number` ("Row ID"): "Synthetic row id given to data as it's inserted into Analysis Core
  tables… **This type is not something that should appear in a schema.** The value, if displayed,
  is useful only to Instruments' developers for debugging."

**Fixture check:** neither appears anywhere in `tests/fixtures/` (verified against the full distinct
engineering-type list across all fixtures). Apple's own docs say they shouldn't appear in schemas,
and xctrace's export path evidently agrees.

**Current code behavior if one ever did appear:** no special handling. Neither mnemonic is in
`ENGINEERING_TYPE_ROLES` (roleInference.ts), so classification would fall through to mnemonic
heuristics and typically land on `detail` (low confidence) — though a `row-number`-typed column
whose *mnemonic* happened to match a heuristic regex (e.g. ending in `-index` hits `ID_RULE` →
`detail`; fine) would still be shown in describe_schema's column list. Note the server already
synthesizes its own row identity (`ROW_IDX_COLUMN` in sqliteStore.ts / `tableIndex` in results),
which is unrelated to and unaffected by Apple's `row-number`.

**Verdict:** nothing to suppress today — the types are export-invisible, and the default `detail`
classification is a safe landing if that ever changes. Active suppression code would be speculative
dead weight. The one cheap, defensible hardening consistent with Apple's "never shown in UI"
designation: if a column with engineering-type `invalid` or `row-number` ever surfaces, treat it as
a signal the export is malformed/debug-mode rather than as data (e.g. a describe_schema gotcha),
but that belongs in a future change only if a real trace ever produces one.

---

## Cross-cutting observations for the parent audit

1. The audit's most actionable finds in this slice are **(d) narrative** (Apple-authored
   explanation/remediation prose, fully parsed, zero hint-layer pointers — especially
   `detected-fs-antipattern.suggestion`) and the **(c) severity-flavored event-concept** columns
   (an Apple-enumerated severity vocabulary nothing consumes, with the observed caveat that real
   modelers use out-of-vocabulary words: `Medium`, `Brown`).
2. (b) suggests one small auto-derivable gotcha (containment-level ⇒ cross-level duration sums
   double-count) that would generalize an existing lens-local warning.
3. (a) and (e) are clean no-ops: pre-modeler plumbing and internal types that never reach exports.
