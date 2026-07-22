# Audit A — Column-Role Classification vs Apple's Engineering Type Reference

Discovery-only pass. Scope: the 74 distinct `engineering-type` mnemonics in committed fixtures
(`fixture-mnemonics.json`), cross-checked against `aidocs/engineeringTypeReference.json` and the
role classifier in `src/engine/roleInference.ts` + `src/engine/roleHints.ts`.

**Method (no guessing):** ran the project's actual compiled classifier (`dist/engine/roleHints.js`
`classifyWithHints` + `dist/engine/roleInference.js` `classifyColumn`, dist newer than src, clean
tree) over every column of every fixture in `tests/fixtures/xcode-27.0/schema-table/`, then joined
each engineering-type with its Apple reference entry. So every "our-role" below is the classifier's
real output, and every heuristic-fallback trace is executed, not inferred. Harness + raw output:
`classify-harness.mjs`, `classifications.json`, `joined.txt` in this directory.

## The code's actual role taxonomy

From `src/engine/roleInference.ts` L29: `time | weight | backtrace | thread | label | detail`
(weight carries a unit: nanoseconds/bytes/count/cycles). Classification layers (L17–25):
1. `ENGINEERING_TYPE_ROLES` (roleInference.ts L58–111) — exact engineering-type match, high confidence. **This is the "pinned hint" layer for this audit.**
2. Mnemonic name-pattern rules (L124–150) — medium confidence, applies to the *column name*, not the type.
3. Default → `detail` (L192).
Per-schema column pins in `roleHints.ts` `SCHEMA_HINTS` override everything for pinned schemas.

## Verdict counts

| Verdict | Count |
|---|---|
| REINFORCED (type pinned in `ENGINEERING_TYPE_ROLES`, agrees with Apple) | 31 |
| MISMATCH (classification contradicts Apple's documented semantics) | 2 |
| NOT-COVERED (no type rule; falls to name heuristics / schema pins) | 34 |
| UNDOCUMENTED (absent from Apple's reference) | 7 |
| **Total** | **74** |

Within the 34 NOT-COVERED: heuristic gets it **right** (or is rescued only by a schema pin) in 29
cases; heuristic is **wrong-per-Apple with no rescue on unpinned schemas** in 5 cases
(`domain-name`, `display-name` [col `display`], `syscall`, `swift-task-priority`, `vsync-event` —
details below; the last four are rescued by schema pins in the fixtures we ship, `domain-name` is not).

---

## MISMATCH (2)

### 1. `cfrunloop-result` — documented 5-value enum classified as opaque `detail`
- **Apple** (General, CLIPS INTEGER): "Determines why a corresponding cfrunloop run interval ended.
  Valid values are 1–4. 0 is treated as 'Unknown'." Display Conventions: "Displays the reason a
  runloop run ended as string, e.g. 'Finished' or 'Timed Out'."
- **Ours:** column `run-result` on `runloop-intervals` → pinned `detail`
  (roleHints.ts L945: `"run-result": detail`). Heuristic fallback also `detail` (default, low —
  "run-result" matches no mnemonic rule).
- **Why it's a mismatch:** a bounded enum displayed as category strings is exactly the project's own
  definition of `label` ("what-dimension: name / category / type / state", roleInference.ts L13).
  As `detail` it never surfaces as a groupable dimension — "group runloop runs by why they ended"
  (Finished vs Timed Out vs Stopped) is lost. Both the heuristic and the pin get it wrong; the type
  belongs in `ENGINEERING_TYPE_ROLES` as `label`.

### 2. `render-buffer-depth` — three-way internal inconsistency, and `weight/count` sums a gauge
- **Apple** (Graphics, CLIPS INTEGER): "The rendering depth of the frame buffer (e.g., double or
  triple buffering)." I.e. a small configuration **level** (2 or 3), not an accumulating count.
- **Ours:** the same engineering-type on a column named `color` in three fixture schemas gets three
  different treatments:
  - `display-vsyncs-interval.color` → pinned `weight/count` (roleHints.ts L506 `color: count`)
  - `display-surface-swap.color` → pinned `weight/count` (roleHints.ts L567 `color: count`)
  - `displayed-surfaces-interval.color` → pinned `detail` (roleHints.ts L529–530), with a comment
    asserting it is the "same UI visualization tag as display-vsyncs-interval.color — not a
    buffer-depth signal". **But the committed fixture declares `displayed-surfaces-interval.color`
    as engineering-type `render-buffer-depth`** (verified in
    `tests/fixtures/xcode-27.0/schema-table/displayed-surfaces-interval.xml`) — identical to the two
    schemas where the same comment block says the type IS the buffer-depth signal. Either the pin's
    comment is wrong, or Apple's type annotation on that column is (the roleHints comment for
    display-vsyncs cites live verification, but the displayed-surfaces comment contradicts the
    declared type without citing a probe of *that* column).
  - Heuristic fallback (any future unpinned schema): a `color`-named column matches the label rule
    `/…|color$|…/` (roleInference.ts L145) → `label`. Per Apple it's a numeric depth, not a category.
- **Why `weight/count` is itself questionable:** role `weight` is "a measure to aggregate … what
  'top N by weight' sums" (roleInference.ts L9–10). Summing buffer depths across rows is
  meaningless per Apple's semantics (you'd want min/max/mode of a gauge). `frameBudget.ts` reads raw
  values, so nothing breaks today, but any generic `aggregate measure=color` on these schemas
  produces a semantically void number, and the classifier advertises it as a default-able measure
  (it is not `primaryWeight`, which limits the blast radius).

---

## REINFORCED (31)

All of these hit `ENGINEERING_TYPE_ROLES` (roleInference.ts, line cited per row) and Apple's entry
agrees. These upgrade the type table from guesses to grounded facts.

| Mnemonic | Our role (rule line) | Apple says (summary/CLIPS) | Note |
|---|---|---|---|
| `start-time` | time (L60) | "Trace relative start time in ns" / INTEGER | Deliberate pin-demotions on `display-surface-swap` (delay, hid-time, generation-time, desired-presentation-time → detail, roleHints L560–572) — those really are start-time typed per fixture; demotion is a documented axis-selection choice, not a contradiction |
| `sample-time` | time (L61) | "timestamp in ns of when a sample was taken" | |
| `event-time` | time (L62) | "start time in ns of some point-event" | |
| `duration` | weight/ns (L67) | "Duration in nanoseconds" / INTEGER | display-vsyncs sentinel caveat already documented in roleHints L475–482 |
| `network-size-in-bytes` | weight/bytes (L68) | "Network size in bytes" | |
| `size-in-bytes` | weight/bytes (L69) | "Memory or storage size in bytes" | Caveat: `network-connection-detected.recv-buffer-size/used` are capacity gauges — summing is iffy, but the type-level classification matches Apple |
| `event-count` | weight/count (L71) | "A count of events" | |
| `kperf-bt` | backtrace (L75) | "A raw backtrace from kperf" / EXTERNAL-ADDRESS | Apple: needs reconstruction; xctrace export hands us resolved fmt, so treating as backtrace is correct at this layer |
| `text-backtrace` | backtrace (L76) | "A backtrace through Mach-O text sections" | |
| `backtrace` | backtrace (L77) | "A backtrace … structured list of fragments and pids" | |
| `thread` | thread (L80) | "A thread" (TID + process iid) | |
| `pid` | thread (L82) | "A process id" | |
| `process` | thread (L83) | "A process" (pid + session iid) | |
| `core` | thread (L84) | "A logical CPU index … assigned by the kernel at boot" | Agrees with the taxonomy's who-dimension bucketing *by design*, and the code already documents core ≠ identity (roleInference L217–227). **But see cross-cutting finding #1: the safety valve doesn't match the real column name.** |
| `event-concept` | label (L87) | "Used as an adjective … 'Warning', 'Error' … may contain simple shapes" | `hitches-renders.frame-color` pin overrides to detail (roleHints L443) — consistent with Apple's "provides images" clause, verified-live comment |
| `time-sample-kind` | label (L88) | "The sample type … timer fired or kernel fired (PET, LPET)" | |
| `thread-state` | label (L89) | "A thread state" | |
| `event-type` | label (L90) | "A string describing the type of log event" | |
| `signpost-name` | label (L91) | "The name assigned to a user emitted signpost event" | |
| `subsystem` | label (L92) | "the subsystem that owns this OS Logging event" | |
| `category` | label (L93) | "the category of the OS Logging event" | |
| `network-protocol` | label (L94) | "name of a network protocol, such as TCP or UDP" | |
| `network-interface` | label (L95) | "BSD style network interface name, such as en0" | |
| `formatted-label` | label (L98) | "smaller strings that uniquely label something" / EXTERNAL-ADDRESS | displayed-surfaces `detachment-reason/-suggestion` pinned detail (advisory prose) — reasonable per-column deviation |
| `sockaddr` | label (L99) | "A socket address structure (struct sockaddr)" / EXTERNAL-ADDRESS | Apple encodes a C struct; export fmt is the resolved address string, so groupable-label holds |
| `os-signpost-identifier` | detail (L102) | "uniquely identifies a call to os_signpost_interval_begin/end"; display: debugging-only | |
| `packed-identifier` | detail (L103) | "generic, numeric identifier … sequence/serial numbers" | |
| `os-log-metadata` | detail (L104) | "narrative style string … format string and its arguments" | |
| `return-location` | detail (L105) | "UUID and offset pair … return location in a Mach-O text segment" | Apple's UI resolves it to a symbol/emit-site; detail is safe but grouping-by-emit-site is a lost (minor) opportunity |
| `narrative` | detail (L107) | "An entry in narrative" — long recursive formatted strings | |
| `boolean` | detail (L110) | "A yes/no boolean value. Encoded as 0 and 1" | Matches the code's explicit flags-aren't-structural rationale (L108–109); verified: fs-syscall's unpinned `file-created`/`file-deleted` still land detail via the type rule |

## NOT-COVERED (34)

Type absent from `ENGINEERING_TYPE_ROLES`; the classifier falls to column-name mnemonic rules
(roleInference.ts L124–150) or default-detail (L192). "Effective" = what the shipped system does
(schema pin, when one exists). All heuristic outcomes below are the harness's executed results.

### Heuristic wrong per Apple (5) — the notable ones

| Mnemonic | Fixture column(s) | Heuristic does | Effective | Apple says | Assessment |
|---|---|---|---|---|---|
| `domain-name` | `com-apple-cfnetwork-task-intervals.host` (schema **unpinned**) | no name rule matches "host" → **detail** (default, low) | **detail** | "A domain name … RFC 882/883" / STRING | **Wrong and un-rescued.** A hostname is a canonical groupable dimension ("requests by host"); the CFNetwork schema has no pin, so this ships as detail today. Strongest candidate for a type-table `label` entry. |
| `display-name` | `hitches.display`, `hitches-renders.display` → pinned label (roleHints L417, L438); `*.display-name` → label only via `/name$/` name-luck | "display" matches no rule → **detail** | label (pins) | "The name of a physical display or HMD" / STRING | Heuristic wrong for any future display-name-typed column not literally ending in `name`; it's also the documented cross-schema join key (roleHints L411–416), so a detail fallback would hide the join. Type-table candidate. |
| `syscall` | `fs-syscall.syscall`, `detected-fs-antipattern.syscall` → pinned label (roleHints L233, L252) | "syscall" matches no rule → **detail** | label (pins) | "The name assigned by the OS to a system call" / STRING | Categorical name; heuristic wrong, pins rescue only the two shipped schemas. Type-table candidate. |
| `swift-task-priority` | `SwiftTaskStateTable.priority` → pinned label (roleHints L770) | "priority" matches no rule → **detail** | label (pin) | "A Swift Task Priority … known priority name and the raw priority value" / EXTERNAL-ADDRESS | Small named set (high/default/background…) → label is right, heuristic wrong; unpinned Swift Concurrency schemas would lose it. |
| `vsync-event` | `display-vsyncs-interval.event` → pinned label (roleHints L509) | "event" matches no rule → **detail** | label (pin) | "A vsync event. Normally just VSYNC. When APT is enabled … also APT events" / STRING | Event-name string → label; heuristic wrong, pin rescues. |

### Heuristic right (or right-by-name-luck), Apple agrees (17)

| Mnemonic | Fixture column(s) → effective | Heuristic trace | Apple says | Assessment |
|---|---|---|---|---|
| `address` | `runloop-events/-intervals.runloop-pointer` → detail (pin L943/L971; heuristic default-detail) | no rule matches | "A virtual memory address" — hex display | Right |
| `cfrunloop-result` | — | — | — | (counted under MISMATCH) |
| `connection-uuid64` | `displayed-surfaces-interval.connection-UUID` → detail (pin L527; heuristic detail via `ID_RULE` `/uuid$/` L150) | ID rule | "An ID for connections between the planes of a graph … aids in visually connecting a row in one table to a row in another"; debugging-only display | Role right; note Apple documents it as a **cross-table join key** — a fact the role taxonomy can't express (relate/schemaEdges territory, out of this audit's scope) |
| `containment-level` | `runloop-intervals.containment-level` → detail (pin L938) | default | "depth of containment (number of enclosing parents)" | Right — structural int, not measure/label |
| `display-event-name` | `displayed-surfaces-interval.category` → label (pin L533; heuristic label via `/category/` L145) | name-luck | "A generic event label for Display related events, such as Stutter, HMD" | Right outcome; only because the column happens to be named `category`. Type-table `label` candidate |
| `displayed-surface-swap` | `display-surface-swap.{swap-id,surface-id,layer1/2-surface-id}` → detail (pins; heuristic detail via ID_RULE) | ID rule | "An identifier representing the displayed surface swap transaction" — hex, sentinel −1 | Right. schemaEdges already records the ≠-hitches.swap-id negative edge (roleHints L552–554) |
| `fd` | `fs-syscall`/`detected-fs-antipattern.fd` → detail (not listed in pins; heuristic default) | no rule | "UNIX file descriptor"; −1 = error | Right |
| `file-path` | `.path` → detail (pins L237, L255) | default | "A file path … middle-truncation display" | Right — high-cardinality verbose content; detail matches |
| `hang-type` | `potential-hangs.hang-type` → label (pin L392) | **heuristic is also label** — `/(^|[-_])type$/` L145 matches "hang-type" (harness-verified: label/mnemonic/medium) | "Encodes the type of hang (microhang, severe hang, etc.)" | Right. **Note:** roleHints L390–391 comment "heuristics would mark it detail" is factually wrong — see cross-cutting #2 |
| `kdebug-func` | `runloop-events.event-type` → label (pin L965; heuristic label via `-type$`) | name-luck | "Determines if the corresponding kdebug-code is a start/end/point" | Right — small enum |
| `layout-id` | `OSSignpostIntervals.layout-qualifier` → detail (pin L268) | default | "numerically sortable indicator as to which 'lane' this row should be graphed in"; debugging-only | Right |
| `metal-nesting-level` | `displayed-surfaces-interval.event-depth` → detail (pin L538) | default | command-buffer work nesting; debugging-only display | Right |
| `metal-object-label` | `device-display-info.device-name` → label (pin L463; heuristic label via `/name$/`) | name-luck | "metal framework assigns object labels … for tracking" | Right |
| `size-in-pixels` | `device-display-info.resolution` → detail (pin L465) | default | "A size in pixels … displayed as a tuple" / EXTERNAL-ADDRESS array | Right — a tuple, not aggregatable |
| `swift-actor` | `SwiftTaskStateTable.{actor,enqueued-actor}` → detail (pins L766–767) | default | "A Swift Actor" — 64-bit ID + name / EXTERNAL-ADDRESS | Right — instance identity → detail; the groupable class name is a separate column (`SwiftActorLifetime.actor-class`, pinned label) |
| `swift-task` | `SwiftTasksInfoTable.task` → detail (unpinned; default) | default | "A Swift Task" — ID + name + creation backtrace | Right — instance identity |
| `swift-task-id` | `SwiftTasksInfoTable.swift-task-id` → detail (ID_RULE `/id$/`) | ID rule | "Swift Task ID" / INTEGER | Right |
| `swift-task-state` | `SwiftTaskStateTable.state` → label (pin L769; heuristic label via `/state$/`) | name rule | "State of a Swift Task" / STRING | Right, both layers agree |

### Heuristic right → detail; Apple confirms opaque/numeric (5)

| Mnemonic | Columns → effective | Apple says | Assessment |
|---|---|---|---|
| `mach-port` | — | — | (counted under UNDOCUMENTED) |
| `syscall-arg` | `fs-syscall`/`antipattern.arg1–4` → detail (default) | "An argument supplied to a system call" — arbitrary, hex | Right |
| `syscall-return` | `fs-syscall.return` (default-detail), `.errno` (pin L257) | "The return value of a system call" — signed | Right (grouping by errno could be nice but Apple doesn't call it categorical) |
| `uuid` | `com-apple-cfnetwork-task-intervals.task-uuid` → detail (ID_RULE) | ISO UUID | Right |
| `vnode` | `fs-syscall.vnode` → detail (pin L254) | "A vnode identifier in use by the VFS" | Right |

### Questionable-but-defensible (2)

| Mnemonic | Columns → effective | Apple says | Assessment |
|---|---|---|---|
| `metal-workload-priority` | `displayed-surfaces-interval.event-priority` → detail (pin L531; heuristic default-detail) | "The priority/type of the workload in the Metal framework" / INTEGER | Apple's "priority/type" leans categorical → `label` would let "group surfaces by workload priority"; detail is safe but loses that. Soft; not promoted to MISMATCH because Apple gives no value-set/display convention |
| `text-symbol` | `SwiftTaskStateTable.resume-function` → detail (pin L771; heuristic default-detail) | "An address … representing executable code"; UI "will attempt to provide a symbol name, library, and possibly source line" / EXTERNAL-ADDRESS | Export fmt is the resolved symbol string; "group task states by resume function" is analytically valuable for Swift Concurrency, so `label` is arguably better. detail is the safe under-claim, not a contradiction |

### Generic-by-design types (5) — heuristic fallback is the intended path

Apple's own Encoding Notes for all of these: "should only be used for prototyping purposes when the
other engineering types aren't a good match." So per-column name heuristics are the *correct*
strategy; Apple's entry carries no per-column semantics to contradict.

| Mnemonic | Notable executed outcomes |
|---|---|
| `string` | 60+ columns. Name rules do well (`view-name`/`tool-name`/`plot-label` → label; `*-id`/`*-index` → detail via ID_RULE; `tokens` → weight/count via `/token/`). Pins correct the misses (`asset-id` → label, `transition` → label, `fetch-entity`/`relationship` → label, `hitches-renders.label` → detail). **Hazard:** `runloop-events.timestamp-accuracy` (a STRING) heuristically classifies **time** via `/timestamp/` (L142) — rescued only by the pin (L963); see cross-cutting #3 |
| `medium-length-string` | `server-ip`, `task-description`, `http-path`, `mode` → detail. Fine |
| `short-string` | `interval-type` → label (name rule); `hang-risks.severity` → label **only via pin** L588 (heuristic default-detail — "severity" matches no rule, unlike event-concept-typed severity columns which the type rule catches) |
| `word-string` | `com-apple-cfnetwork-task-intervals.http-method` → detail (unpinned, no rule). GET/POST is a classic groupable label — but that's a schema-curation gap (CFNetwork schema has no pin at all), not a type-rule gap |
| `uint32` / `uint64` | ids/indexes → detail via ID_RULE; `tokens`/`error-count`/`fetch-count` → weight/count via name rules — all sensible. `device-display-info.display-id` → label only via pin L459 (documented join-key correction) |

(Counting note: `uint32` and `uint64` are two mnemonics; the generic bucket is 6 mnemonics total —
5 rows above. Overall NOT-COVERED tally: 5 wrong + 17 right + 5 opaque-right + 2 questionable +
6 generic = 35, minus `cfrunloop-result` and `render-buffer-depth` promoted to MISMATCH, plus both
appear in tables above only as pointers = 34 distinct NOT-COVERED mnemonics.)

## UNDOCUMENTED (7) — absent from Apple's reference

All classify as the harness shows; no Apple entry exists to contradict.

| Mnemonic | Columns → effective | Note |
|---|---|---|
| `analysis-core-swift-task` | `SwiftTaskLifetime.task`, `SwiftTaskStateTable.waiting-for` → detail (pins) | Opaque task ref; consistent with documented sibling `swift-task` → detail |
| `cause-set` | `swiftui-updates.downstream-events` → detail (pin); `SwiftUIFilteredUpdates.downstream-events` → detail (default) | |
| `description-set` | `root-causes` → detail (pin / default) | |
| `mach-port` | `runloop-intervals.{waiting-on-ports,received-port}` → detail (pins L947–948) | Port identity — detail is right |
| `swiftui-update` | `update-type` → label (pin on swiftui-updates L791; **unpinned SwiftUIFilteredUpdates also lands label** via `-type$` name rule) | Only undocumented type that classifies to a structural role; harmless — the value is a small category set ("View Body Update" etc.) |
| `typed-array` | `cause-graph-node`, `full-cause-graph-node`, `source-node`, `destination-node` → detail | |
| `view-hierarchy` | `view-hierarchy` → detail (pin / default) | |

## Cross-cutting findings (discovered while tracing, not per-type verdicts)

1. **`preferredThreadColumn`'s core-exclusion doesn't match the real column name.**
   roleInference.ts L236–238 filters candidates by exact mnemonic `"core"`/`"cpu"`, but the only
   fixture column carrying engineering-type `core` is **`core-index`** (time-sample), which passes
   the filter. No harm today (time-sample also has `thread`, which wins the preference loop L241),
   and `gcd-perf-event.running-cpu` was pinned `detail` (roleHints L639) specifically to dodge the
   same gap — but a future schema whose only "who" column is a core-typed `core-index` would be
   treated as a thread identity for relate/callTree correlation, exactly what the L217–227 comment
   says must not happen. Apple confirms the semantics: "A logical CPU index … assigned by the kernel
   at boot" — not an identity.
2. **Stale comment in roleHints.ts L390–391** (`potential-hangs.hang-type`): claims "heuristics
   would mark it detail". Harness-verified false — the `/(^|[-_])type$/` rule (roleInference L145)
   classifies it `label` (mnemonic, medium). The pin is still useful (confidence high vs medium) but
   the stated rationale is wrong. Same pattern of comment-vs-verified tension as the
   `displayed-surfaces-interval.color` note under MISMATCH #2.
3. **Generic strings can heuristically become `time`.** The mnemonic time rule
   `/^time$|timestamp|^start($|-)|^end($|-)/` (roleInference L142) runs for *any* engineering-type
   not in the type table — including STRING types. Observed live: `runloop-events.timestamp-accuracy`
   (type `string`) → heuristic `time`; only the schema pin (L963 → detail) prevents it from becoming
   a timeRange-filter candidate. Any unpinned schema with a string column named like
   `*-timestamp-*` reproduces this.
4. **Unpinned twin schemas silently lose pin corrections.** `SwiftUIFilteredUpdates` (unpinned)
   carries the same columns as pinned `swiftui-updates`; the pin's corrections don't transfer —
   e.g. `module` → label when pinned (roleHints L830) but default-detail on SwiftUIFilteredUpdates.
   Same exposure for the unpinned Foundation Models tables (`RequestTable`/`SessionTable`/
   `ToolTable`/`FMEventTable`) and `com-apple-cfnetwork-task-intervals` (where the un-rescued
   `domain-name`→detail and `http-method`→detail gaps live).
5. **Type-table promotion candidates** (types Apple documents crisply enough to classify without
   name-luck, currently reachable only via schema pins): `syscall` → label, `display-name` → label,
   `domain-name` → label, `vsync-event` → label, `swift-task-priority` → label, `hang-type` → label,
   `display-event-name` → label, `cfrunloop-result` → label (the MISMATCH), `file-path` → detail,
   `syscall-arg`/`syscall-return`/`fd`/`vnode`/`address` → detail, `swift-task`/`swift-actor` →
   detail. (Discovery note only — no changes made.)
