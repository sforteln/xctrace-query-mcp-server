# Engineering Type Reference audit — findings (in progress)

Tracks findings from PMT:mossy-bluff's discovery pass. Not a complete audit yet —
see "Still open" at the bottom for what's blocked/pending.

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

## `categorical` flag

48 of the 67 matched types are marked categorical ("cannot be summed or averaged").
Not yet cross-checked against `aggregate.ts`'s actual allowed ops — this is the
PMT:mossy-bluff item most likely to turn up a real bug (a type we currently let get
summed that shouldn't be) and hasn't been done yet.

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

## RESOLVED — hang-risks is not triggerable from PromptManager app code at all (2026-07-14)

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
genuine OS-generated runtime-issue event that PromptManager's own code surface
doesn't produce (no real Contacts/CoreML/main-thread-CFNetwork-internal calls in this
app). Nothing to fix here. The lens/lookup-table work planned in PMT:haze-eagle for
`hang-risks`' severity enum and narrative content remains worth having for OTHER
apps' traces, but can't be validated further against PromptManager specifically —
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

## Still open / blocked

- Why `hang-risks` never populates regardless of hang severity (see above) — the
  main open question for anything depending on real `hang-risks` narrative content,
  including PMT:navy-river's landmark work for that schema specifically.
- `categorical` flag not yet cross-checked against `aggregate.ts`'s real code.
- Sentinel list not yet cross-checked against `correlate()`/`describe_schema` (planned
  action lives in PMT:haze-eagle).
- The 7 unmatched fixture mnemonics not yet investigated.
- Items 4 (Encoding Notes opaque-column audit beyond URLSession/process/swift-task),
  5's remaining exploration, and items 6's other named types (Configuration ID,
  Containment Level, Event Concept) not yet started.
