# Engineering Type Reference audit — findings (COMPLETE)

Tracks findings from PMT:mossy-bluff's discovery pass. The audit is complete as of
2026-07-22: six parallel audit slices (per touchpoint category, not per family)
cross-checked all 74 fixture-used engineering types against Apple's reference and
this project's actual code. **The per-type detail lives in `aidocs/typeAudit/`**
(A: role classification, B: summability/sentinels/bit-width, C: Special Value
Treatments + detector bands, D: specific-type deep dives, E: encoding notes +
family grouping, F: prose claims in gotchas/tool descriptions; plus
`fixture-mnemonics.json`, the bounded scope every slice keyed off). This file is
the synthesis + running history; the per-slice files are the "every checked item's
outcome" record. Implementation actions distilled from all of this live in
PMT:haze-eagle.

## Scope actually in play

74 distinct `engineering-type` mnemonics appear across the committed fixtures
(`grep -rhoE '<engineering-type>[^<]+</engineering-type>' tests/fixtures/ | sort -u`).
67 of those match an entry in `engineeringTypeReference.json` by Mnemonic. 7 do not:
`analysis-core-swift-task`, `cause-set`, `description-set`, `mach-port`,
`swiftui-update`, `typed-array`, `view-hierarchy` — either newer than this reference
revision or named differently than their public Mnemonic. Not yet investigated further.

## Scraper bug found and fixed

The original scraper only captured table rows under a page's "Usage" section (and
only 2-column ones) — any other table (e.g. "Special Value Treatments", "Structure")
was silently dropped. Confirmed by refetching Energy Impact's raw HTML directly and
finding a real 3-column table my own JSON claimed didn't exist. Fixed in
`scripts/scrape-engineering-types.py` (captures any table, any column count, keyed by
its section name) and re-scraped all 238 entries. `aidocs/engineeringTypeReference.json`
is now the corrected version. Lesson: don't trust a "not present" finding from scraped
data without spot-checking the raw source at least once — this one was wrong.

## Sentinel values actually in play

19 of the 67 matched types declare a Sentinel: 17 as `max` (the type's max
representable value), 2 as `zero` (`duration`, `os-signpost-identifier`). Full list
computed directly from the JSON — see the audit script output; not yet cross-checked
against `correlate()`/`describe_schema` per PMT:haze-eagle's planned action.

Empirically verified `duration`'s zero-sentinel is safely distinguishable from real
data: real `syscall` durations from an actual trace never go below ~42ns (quantized to
a 24MHz/41.67ns hardware timebase) — nothing in that gap, so a literal `0` can't be a
genuine measurement on this hardware. Worth re-checking on Intel Macs if that ever
matters (different timebase constant).

## `categorical` flag — CROSS-CHECKED (see typeAudit/B); the predicted real bug exists, at full breadth

52 of the 67 matched types are marked categorical (the earlier "48" here was
counted against the pre-scraper-fix JSON; 52 is verified against the corrected
data). The cross-check against `aggregate.ts` predicted "most likely to turn up a
real bug" — confirmed, and it's structural, not per-type: **the codebase has no
summability concept at all.** The only measure rejection anywhere is
`isBacktraceCol` (sqliteStore.ts); everything else becomes
`SUM(CAST(raw AS REAL))`. So 50 of the 52 categorical types are summable today —
16 with INTEGER raws produce plausible-looking wrong sums (pid, fd, address,
boolean, core, …), 34 string-raw types CAST to 0/garbage but "succeed". Bonus:
`kperf-bt` (time-sample's `cp-user-callstack`) slips through even the backtrace
guard, whose set only covers {backtrace, text-backtrace, tagged-backtrace}.
Reinforced on the other side: all 15 non-categorical numeric types are correctly
allowed, with correct units for the weight types.

## Special Value Treatments — reframed from the original assumption

These are **Value → Color → Icon** tables (an enumerated set of valid string values,
each with Apple's own display color), not numeric-range → label tables as originally
assumed from Energy Impact's name alone. 12 of our 67 matched types have one, including
several we already query: `hang-type`, `event-type`, `thread-state`, `swift-task-state`,
`signpost-name`, `vsync-event`, `render-buffer-depth`, `network-protocol`, `syscall`.

**Highest-value hit: `hang-type`.** Real rows: `unresponsive`/Gray, `Microhang`/Blue,
`Hang`/Orange, `Severe Hang`/Red — Apple's own authoritative, already-color-coded hang
severity classification, for a column our own Hangs/hitches detectors already touch.
Strong candidate to reinforce or replace our own derived severity bands with this one.
Not yet implemented — needs real `hang-risks` data first (see "Still open").

The "fake column via join" idea from the original prompt needs adjusting: since the
raw value is usually already the qualitative string (not a number), the real value-add
here is (a) a closed, authoritative enum of valid values per type — useful for
validating/autocompleting filter predicates — and (b) Apple's own severity coloring as
a signal, not literally translating a number into a label.

## Structure tables — a capability the original prompt didn't anticipate

13 of our 67 matched types have a "Structure" section: a formal sub-field list for
composite/opaque values, each field referencing another engineering-type by its real
mnemonic (e.g. `process` → `[pid, device-session]`; `swift-task` →
`[swift-task-id, text-symbol, text-backtrace]`).

Confirmed this is most valuable combined with "Encoding Notes," not read alone —
`urlsession`'s Structure gives the gross 5-slot shape (`uuid, string, string, string,
data`); its Encoding Notes says what each slot actually means (session uuid /
background-session id / human-readable name / session-type enum / unused metadata
dict). Structure alone would be close to useless without that second half.

## Narrative — investigated in real data, not just the docs

`narrative` appears on at least 8 fixtured schemas, not just one: `context-switch`,
`hang-risks`, `core-data-fault`, `core-data-relationship-fault`, `fs-syscall`,
`detected-fs-antipattern`, `displayed-surfaces-interval`, `display-vsyncs-interval`,
`SwiftTaskStateTable`.

**Reinforcement finding, not a bug**: ran a real trace's `context-switch` table
through this project's actual `parseTableStream` — `narrative`'s `fmt`/`raw`
resolution already works correctly today with zero special-casing (same generic
mechanism that resolves `process`/`thread`). Real example pulled from a live trace:
`"will wait for event/lock with id 0xbe162032e3cd6eab when it blocks"`,
`"CPU 1 (E Core) became idle"`. ~855 of 73,156 real rows had actual content in the one
trace checked; the rest are sentinel.

`narrative-certainty`/`narrative-significance`/`narrative-text` were NOT found as
their own top-level schema columns anywhere — only `narrative-text` nested inside a
`narrative` value, as expected. Apple's own docs mark certainty/significance as
"usually only displayed for debugging... not intended to be displayed in an
instrument or augmentation" — plausible read: these are Apple's own internal
weighting for which narrative text gets included in the exported `fmt`, not something
meant to reach us at all. Not pursuing further.

**Recommendation, not yet implemented**: don't build a per-schema hint or a dedicated
lens yet. The right fix is systematic — `describe_schema` flagging any column whose
engineering-type is `narrative` as high-signal automatically, derived from the type
itself rather than hand-curated per schema (same principle as the sentinel/family
work). Whether it also needs a summarizer (clustering similar narrative strings)
depends on real `hang-risks` narrative content specifically — the one schema checked
so far only had 2-3 repeated templates, not enough variety to justify one, but
`hang-risks` (the highest-value hit) hasn't been checked yet because we don't have a
live recording for it — see "Still open."

## Update — real Hangs data now exists (2026-07-14, via scratch_do_not_commit/debug-hang-harness.md)

Three real recordings now exist (Time Profiler run, two System Trace runs), the
second System Trace run deliberately triggering a genuine 9.61-second hang.

**Real empirical `hang-type` tier boundaries** (finally have numbers behind the
qualitative labels from the Special Value Treatments enum found earlier):
- Microhang — 100–250ms
- Hang — 250ms–~2s
- Severe Hang — >~2s (9.61s classified here)

**`hang-risks` is STILL completely empty across all three real recordings** —
including the 9.61s Severe Hang. This kills the "just needs to be long/severe enough"
hypothesis: duration was the one lever we hadn't maxed out, and maxing it out (10x
longer than anything tried before) still produced nothing. Whatever gates
`com.apple.runtime-issues`'s fault emission (see appleModelerHarvest.md's note that
hang-risks is sourced from that os-log subsystem, not computed by Hangs directly),
it isn't simply about how long the main thread was blocked.

## RESOLVED — hang-risks is not triggerable from the test app's code at all (2026-07-14)

Three more runs (via debug-hang-harness.md) exhausted every plausible remaining
trigger:

| Run | Mechanism | hang-risks rows |
|---|---|---|
| 4 | `URLSession`+semaphore, sandbox-blocked (missing entitlement) | 0 |
| 5 | `URLSession`+semaphore, entitlement fixed, call succeeds | 0 |
| 6 | `NSURLConnection.sendSynchronousRequest` (explicitly deprecated sync API), 12.29s Severe Hang | 0 |

`hang-risks`' own `severity` values ("Hang Risk"/"Severe Hang Risk" — see the update
above) come from os-log runtime-issue FAULTs that specific Apple frameworks
(CFNetwork, Contacts, CoreML) self-report internally, at a call site *inside the
framework's own implementation* — not at the app-code call boundary. A `URLSession`
call forced synchronous via a semaphore doesn't trigger it (the OS can't distinguish
that from ordinary async coordination); even the genuinely deprecated, genuinely
synchronous `NSURLConnection.sendSynchronousRequest` didn't either — either
CFNetwork's internal self-instrumentation for that specific entry point was removed
when NSURLConnection was deprecated, or it only fires under conditions (entitlements,
OS version, etc.) this test environment didn't meet.

**Conclusion**: the `hang-risks` schema and this project's handling of it are both
correct — it's real, present in every System Trace recording, and requires a
genuine OS-generated runtime-issue event that the test app's own code surface
doesn't produce (no real Contacts/CoreML/main-thread-CFNetwork-internal calls in this
app). Nothing to fix here. The lens/lookup-table work planned in PMT:haze-eagle for
`hang-risks`' severity enum and narrative content remains worth having for OTHER
apps' traces, but can't be validated further against this test app specifically —
would need a real trace from a different app that actually exercises one of those
three frameworks on the main thread.

**Root-caused the earlier trace corruption**: NOT a "System Trace + long hangs"
interaction as initially suspected — a clean, short recording handled the 9.61s
Severe Hang without any corruption at all. The actual cause was an earlier ~30-minute
recording being killed uncleanly, leaving a ~21GB leftover `.ktrace` temp file
mid-finalization. Confirms the data-volume/recording-duration theory over a
hang-specific corruption mechanism. Recovery recipe (now documented in the harness
file too): kill the DTService PID, remove the leftover `instruments*.ktrace` temp
file; DTService restarts automatically.

## Audit completion synthesis (2026-07-22) — six slices, all former open items resolved

Every previously-open item is now covered; per-type detail in `aidocs/typeAudit/`.
Headline findings by slice:

**A — Role classification** (method note: the agent ran the *actual compiled
classifier* over every fixture column and joined against Apple's reference —
executed-code-grounded, not hand-traced). 31 REINFORCED / 2 MISMATCH /
34 NOT-COVERED / 7 UNDOCUMENTED. The two mismatches: `cfrunloop-result` (documented
5-value enum; both heuristic and the runloop-intervals pin classify it `detail`,
losing group-by-end-reason) and `render-buffer-depth` (three different treatments
across three schemas — summed as weight on two, and pinned `detail` on
displayed-surfaces-interval with a pin comment claiming "not a buffer-depth signal"
while the committed fixture declares exactly that type). Shipping-wrong-with-no-
rescue: `domain-name` → detail (CFNetwork hostname ungroupable, no pin exists).
Cross-cutting bugs: `preferredThreadColumn`'s core/cpu exclusion never fires (real
column is `core-index`); a roleHints comment whose claim the harness disproved;
the mnemonic time-rule can promote generic strings to `time`; unpinned twin schemas
(SwiftUIFilteredUpdates, RequestTable/SessionTable/ToolTable/FMEventTable,
com-apple-cfnetwork-task-intervals) silently lack their pinned twins' corrections.

**B — Summability + sentinels** (see the rewritten `categorical` section above for
the summability half). The complete sentinel list is **19 types** (we'd previously
found 2 the hard way; 17 have no handling). Highest leverage: `duration` → sentinel
ZERO, stored as a plain 0, silently deflating avg/min/percentiles on the pinned
primaryWeight of ~25 schemas. Fixture-confirmed live: runloop-intervals contains
`<boolean fmt="Yes">3</boolean>` — xctrace itself mis-formats boolean's sentinel
(3) as "Yes". All three time types share sentinel 2^50−1 (a real-looking 13-day
timestamp). Caveat: sentinel magnitude varies by producer — one fixture column
shows both 2^64−1 and 2^32−1 for "no timeout". Precision: `coerceRaw` keeps >2^53
digit-strings exact (tested), but `CAST(raw AS REAL)` at query time re-introduces
the loss for uint64-class ids (fixture-real example: timeout 4768471730841330159).

**C — Special Value Treatments** (full-238 sweep): 27 of 238 have one; **all are
Value→Color→Icon enums, zero are numeric-range→label tables** — confirming and
extending this doc's earlier reframe. For 24/27 the cell's fmt already IS the
label, so the original "fake column showing 5/Low" idea collapses; honest residual
value = Apple's severity *color* as an orderable signal + closed enums for filter
validation + genuinely numeric translation for exactly `render-buffer-depth` (in
fixtures) and abstract-power/sched-priority (not). No SVT contradicts any existing
detector band; hitch bands REINFORCED (Apple documents the Low→Green/
Moderate→Orange/High→Red ladder bands.ts uses; the 1×/2× multiples are ours and
uncontradicted), plus an undocumented-in-our-bands tier above High (Critical/
Fault). Proven enum drift: live potential-hangs values ("Brief Unresponsiveness",
"Potential Interaction Delay") aren't in Apple's hang-type SVT — version-fragile,
so nothing should hard-fail on enum membership. Hazard: render-buffer-depth's
documented special codes 1000–1003 would poison `tryRenderBufferDepth`'s median.
Mechanism recon: no JOIN needed — a compiled CASE WHEN in the SELECT list plugs in
at query.ts's existing `__window` fragment slot; obstacles recorded in typeAudit/C.

**D — Specific types**: Configuration ID = pre-modeler EAV plumbing, zero fixture
presence, clean no-op. Containment Level = hierarchy-depth integer (fixture values
3/4/5 map exactly to Run ⊃ Iteration ⊃ Busy/Waiting), correctly orthogonal to
relate()'s time-window containment — but it's a machine-readable "levels overlap;
summing across them double-counts" signal currently voiced only in one runLoops
nextAction string, never as a general gotcha. Event Concept = Apple's 20-value
severity/color enumeration we've re-learned piecemeal per-schema (frame-color
demotion, significance-doesn't-track-duration) without ever consuming the ordering;
real values escape the enum (Medium, Brown). Narrative = the big one: all 10
fixture narrative columns carry Apple-authored prose (detected-fs-antipattern's
`suggestion` is literal remediation advice; fs-syscall failure explanations;
SwiftTaskStateTable per-state stories with actor/thread/resume-site) that
query/get_row can return but no lens, gotcha, or detector ever steers toward —
authoritative curated content sitting unused; any fix should be per-column since
type alone doesn't guarantee quality (two of the 10 are low-value label echoes).
Internal family = de facto suppressed (neither type appears in any export);
active suppression would be dead weight.

**E — Encoding notes + family grouping**: parseTable special-cases only the
backtrace family; everything else is XML-shape-driven. Newly-knowable from Apple's
Encoding Notes for current fall-through types: `sockaddr` is fully decodable
(agent verified by hand-decoding a fixture value to AF_INET 192.168.0.47:62260,
exactly matching the display string) — family/port/IP could become queryable
fields; `size-in-pixels` stores "2532x1170" text so dimensions aren't numerically
comparable; `packed-identifier` has a documented 22-bit sentinel (4194303 — the
spid gotcha class, derivable from the reference); `connection-uuid64` is
documented as a cross-table row-connection ID (schemaEdges equi-join candidate);
`kperf-bt` multi-fragment (cross-process) stacks would have fragments 2+ dropped
by the take-first repeated-child rule (latent; fixtures only show 1 fragment).
Family-as-gross-form verdict: **NO as-is** — General is 62% of fixture types
overall and 100% of columns on several schemas (RequestTable 13/13,
OSSignpostIntervals 18/18); the existing rolesSummary discriminates strictly
better. Salvageable only as a sparse non-General accent.

**F — Prose claims** (gotchas + tool descriptions): 5 MISMATCHES / 13 REINFORCED /
~15 unverifiable-but-uncontradicted / 10 GAPs. The mismatches: hangs lens
quickStart glosses hang-type as "(main-thread vs. background)" (it's a severity
enum); hangs lens says filter `is-system=false` and swiftUI lens says
`cached=false` — both silently match 0 rows (boolean columns encode 0/1 and
display Yes/No; the same error class as the PMT:navy-glen field report, now found
in our own shipped hint text); the kdebug-func grain hint over-generalizes
begin/end pairing (Apple's domain includes unpaired point events; errs safe); and
an internal contradiction — coreData lens promises groupBy fault-object yields
"entity types" while CURATED_GOTCHAS (verified live) says exactly the opposite;
both ship simultaneously. Boolean coercion (true→1/false→0 in find/filter) is
fully supported by Apple's "Encoded as 0 and 1. Other values are illegal" — with
the sharp caveat that track-detail's Allocations `live` column uses literal
"true"/"false" strings, i.e. **the two export formats use opposite boolean
vocabularies**. Several previously "verified live" gotchas can now cite Apple's
reference as authority (spid ⇐ os-signpost-identifier's documented
OS_SIGNPOST_ID_INVALID; runLoops' boolean comment; significance-as-adjective ⇐
event-concept).

**Scope-level finding**: 7 of the 74 fixture mnemonics have no entry in Apple's
reference at all (`analysis-core-swift-task`, `cause-set`, `description-set`,
`mach-port`, `swiftui-update`, `typed-array`, `view-hierarchy`) — verified
genuinely absent, not name-mismatched. Apple's reference is authoritative where it
speaks, but it does not speak for everything already in live use.

## Real-data verification pass (2026-07-22, same day) — sentinel shape measured across 23 real ingested dbs

The audit's sentinel/summability claims were fixture- and code-read-grounded; this
pass measured the REAL shape by scanning every sentinel-bearing column (identified
precisely via each db's own `_ingested_schema` engineering-type records) across all
23 ingested `.db` caches on disk (194 column instances, tables up to 870K rows),
then EXECUTING the claimed failure modes as the exact SQL aggregate() generates.
Results reprioritize slice B's findings:

1. **`duration` → 0 sentinel: ZERO occurrences in real data.** Across every
   duration column in all 23 dbs (100+ instances, up to 870K rows), not one zero.
   Consistent with the earlier 24MHz-timebase note (real durations bottom out
   ~42ns). Slice B's "highest leverage" concern is real per Apple's docs but does
   NOT manifest in practice on this machine's traces — demote from runtime
   exclusion to a describe_schema annotation.
2. **The zero-sentinel that IS prevalent sits on TIME columns, and it's the
   UNdocumented one:** `display-surface-swap.hid-time` 1630/1630 zeros,
   `syscall-name-map.time` 3325/3325, `life-cycle-period.start`,
   `stackshot-info.time`, `device-display-info.timestamp` — the t=0 "not
   recorded/pre-attach" convention currently special-cased only in the
   network/leaks lenses. Generalizing THAT beats handling duration-zero.
3. **Max-magnitude sentinels are real and at scale exactly where documented:**
   `syscall.errno` is sentinel in 4-9% of ALL rows (13,641 of 150,215 in one db).
   Executed proof of poisoning: `AVG(errno)` = 1.675e18 vs 0.065 with sentinels
   excluded — 19 orders of magnitude wrong, silently.
4. **"Magnitude varies by producer" CONFIRMED, in three independent ways:**
   (a) same schema, different columns: `syscall.return` sentinel-class values are
   2^32−2 (4294967294) while `errno`'s are 2^64-class; (b) same column, different
   recordings: errno's sentinel is exact-TEXT `18446744073709551614` (2^64−2) in
   the system-trace dbs but REAL-float ~1.8446744073709552e19 in the
   animation-hitches db; (c) that storage divergence occurs at the SAME
   ingest_schema_version (4) — meaning a precision-affecting parse-behavior change
   landed without a version bump, so stale lossy caches still pass the freshness
   check. Mini-finding for haze-eagle: precision-affecting coerceRaw changes must
   bump INGEST_SCHEMA_VERSION.
5. **NULL, not sentinel, is the dominant missing-value representation in real
   exports:** `thread-state.core` up to 24K NULLs (no 65535 sentinels anywhere);
   `thermal-throttled` and cfnetwork's `successful` 100% NULL;
   `downstream-cost` NULL for ~57% of 770K rows. SQL aggregates already skip
   NULLs correctly, so this common case is safe TODAY — the sentinel work should
   not disturb that.
6. **boolean:** real histograms are strictly {0, 1, NULL} across all dbs — no
   live value-3 sentinel found (the fixture's `fmt="Yes">3` row stands as
   evidence it exists, but no runloop-intervals table is ingested anywhere to
   re-verify against; noted honestly).
7. **Executed categorical-sum demos** (the SQL aggregate() would emit):
   `SUM(core)`=26,207 / `AVG`=4.79 over time-profile — plausible-looking,
   semantically void; kperf-bt's promoted children sum freely
   (`__text-address` → 39.8e12, `__register-content` → 1.1e20) — the
   backtrace-guard hole, live.

## Verification round 2 (2026-07-22) — remaining slices verified against real data + the fixture-scope long tail

The first verification round covered slice B; this round executed the remaining
slices' fixture-only/code-read claims against real dbs, and extended the audit's
deliberately fixture-bounded scope to what's actually in live use:

1. **Enum-drift breadth measured** (slice C's fixture-only finding, now
   quantified): `thread-state` and `vsync-event` real values are 100% inside
   Apple's SVT enums; `event-concept` mostly contained (3 drifts, all plain
   colors: Brown/Teal/Yellow); `hang-type`'s 2 fixture drifts confirmed in real
   data; **`syscall`'s SVT enum is uselessly incomplete** — 100+ real distinct
   values (open/read/mmap/mach_msg2_trap/IOMDESC_*/DYLD_*…) vs Apple's handful of
   BSC_* rows. Closed-enum filter validation is dead for syscall specifically and
   per-type viability must be checked before relying on any SVT enum. (Caveat:
   raw sqlite reads bypass the app's interning hydration — \x01-prefixed refs in
   the scan were interned-value markers, not drift; the plain-name drifts are
   genuine.)
2. **render-buffer-depth ≥1000 special codes: LIVE, not theoretical** — 697 of
   1,629 rows (42%) in the real animation-hitches trace carry values 1000–1002.
   The median tryRenderBufferDepth computes sits just below the poisoning
   threshold (932 rows < 1000) — near-firing today, upgrade the guard's priority.
3. **Narrative quality confirmed on real data**: a real trace's
   detected-fs-antipattern rows carry genuine Apple-authored remediation prose
   ("A high rate of write activity often stems from involuntarily flushing to
   disk, usually in a loop"), not just the curated fixture samples.
4. **cached='false' zero-row proof executed**: 0 rows vs 237,909 for the correct
   predicate, on a real 359K-row SwiftUILayoutUpdates2 table — slice F's
   boolean-vocabulary mismatch, live.
5. **Fixture-scope long tail: 17 engineering types in live ingested use are NOT
   in the fixture-bounded 74** — including `weight` itself (the core profiling
   measure type — non-categorical, sentinel=MAX per Apple), `duration-on-core`/
   `duration-waiting` (sentinel=ZERO, on syscall — feeds the off-CPU work),
   `http-status` (sentinel=max), `sched-priority` (sentinel=max, live on
   thread-state), and four SVT-bearing types slice C had classed "theoretical"
   (sched-priority, thermal-state, gpu-state, app-period) that are in live use.
   Also `tagged-backtrace` is an EIGHTH type absent from Apple's reference
   (handled today — it's in the backtrace guard set — but undocumented).
   Implication: haze-eagle's generated-module scope should be the ~91 live types
   (74 fixture + 17), not the fixture 74.
6. **Not verifiable from dbs**: kperf-bt multi-fragment loss (fragments are
   dropped at ingest; needs a raw-XML export check) — still open.
7. **Schema-name long tail (TOC sweep over 28 of 29 on-disk traces, 30s
   per-trace timeout; the 2.2GB 2026-07-12 animation-hitches trace's TOC
   export alone exceeds 30s and was skipped): 99 distinct schemas are in live
   use, and 57 of them — the MAJORITY — have neither a committed fixture nor
   a roleHints pin.** Headliners by instance count: kdebug (413), tick (65),
   kdebug-strings (52), os-signpost-arg (32), dyld-library-load (28),
   life-cycle-period (23), and time-profile itself (23 — Time Profiler's
   primary schema classifies purely through type heuristics, no pin).
   Also in the tail: hitches-updates (11 traces — the exact discoverability
   gap the 2026-07-22 field retro hit) and cpu-narrative (13 — a
   narrative-bearing schema by name, prime landmark material). This is the
   strongest quantitative argument yet for the project's core bet: per-schema
   curation can never cover the tail (it's most of the population), so
   type-derived generic behavior (roles, sentinel handling, gotchas,
   landmarks) is what carries the majority of real schemas.

## Still open / blocked

- Why `hang-risks` never populates regardless of hang severity (see the RESOLVED
  section above for the test-app-specific dead end) — validating its
  severity-enum/narrative handling needs a trace from an app that actually
  exercises CFNetwork/Contacts/CoreML on the main thread.
- The 7 unmatched fixture mnemonics: confirmed absent from the reference, but not
  themselves investigated beyond that (what IS analysis-core-swift-task's
  structure? private/newer-than-docs?). Low urgency — current handling of all 7 is
  empirically fine per slices A/E.
- boolean's value-3 sentinel unverifiable against real data until a
  runloop-intervals table is ingested from a real trace.
- Why the animation-hitches db's errno raws became REAL while system-trace's
  stayed TEXT at the same ingest version (exact root cause of the unbumped
  behavior change) — matters for haze-eagle's version-bump fix, not for the
  audit itself.
