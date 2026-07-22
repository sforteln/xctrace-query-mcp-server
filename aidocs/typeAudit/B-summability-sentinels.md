# Audit B — Summability/Categorical, Sentinels, Bit Width

Scope: the 74 distinct engineering-type mnemonics in committed fixtures
(`fixture-mnemonics.json`), cross-checked against
`aidocs/engineeringTypeReference.json` (Apple's Engineering Type Reference).
Read-only discovery pass; no code changes.

Reference tally over the 74:
- **52 categorical** (`usage.categorical` = "Value cannot be summed or averaged. They have no inherent height in a graph.")
- **15 non-categorical numeric** (INTEGER CLIPS type, no categorical flag)
- **7 not in reference** (skipped for reference claims): `analysis-core-swift-task`, `cause-set`, `description-set`, `mach-port`, `swiftui-update`, `typed-array`, `view-hierarchy`
- **19 sentinel-bearing** (`usage.Sentinel` present)

## How the code actually decides "can this be summed"

There is **no categorical/summability concept anywhere in the codebase.** The
mechanism chain, verified in source:

1. `src/core/aggregate.ts` (`aggregateTable`) accepts any `measure` mnemonic and
   resolves it via `FieldResolver.resolveComparable(measure, "aggregate (measure)")`
   (`src/engine/fieldRef.ts:119`). The ONLY rejection is `isBacktraceCol`
   (`src/engine/sqliteStore.ts:263-268`): engineering-type in
   `{backtrace, text-backtrace, tagged-backtrace}` OR mnemonic literally
   `"backtrace"`. **`kperf-bt` is not in that set** (time-sample's
   `cp-kernel-callstack`/`cp-user-callstack` pass the guard).
2. The aggregate expression is `CAST("<col>" AS REAL)` over the **raw** column
   (aggregate.ts:290), fed to SQL `SUM/AVG/MIN/MAX` or the percentile UDFs.
   SQLite's CAST of a non-numeric TEXT raw yields `0.0` (or the leading-digit
   prefix, e.g. `'4 KB'` → `4.0`), so summing a string-raw column returns a
   confident-looking number, never an error.
3. Role classification (`src/engine/roleInference.ts` + per-schema pins in
   `src/engine/roleHints.ts` `primaryWeight`) is **advisory only** — it picks the
   unit for `formatValue` and drives describe_schema/nextActions suggestions. It
   never gates which column may be a measure.
4. Null handling: aggregate excludes rows where the measure/groupBy **fmt IS
   NULL** (aggregate.ts:304-310). This correctly drops `<sentinel/>` XML cells
   (parseTable.ts stores them as SQL NULL). It does nothing for sentinel
   *values* that arrive as literal numbers.
5. Same permissiveness elsewhere: `relate.ts:297` sums
   `CAST(rawCol(measure) AS REAL)`; `correlate.ts` sums an events-schema measure
   the same way; `find.ts` gt/gte/lt/lte compare `CAST(raw AS REAL)`
   (`sqlHydrate.ts:684-699`) on any non-backtrace column.

## (a) Categorical vs summability — per-type verdicts

### MISMATCH — documented-categorical types our aggregate will sum/avg (50 of 52)

**Tier A — INTEGER raw: sum/avg returns a plausible-looking number (worst — looks like a real answer).** 16 types:

| mnemonic | Apple name | notes |
|---|---|---|
| address | Virtual Memory Address | raw is a numeric pointer (or TEXT digit-string when > 2^53) |
| boolean | Boolean | sum of 0/1/3 flags; also sentinel=max, see (b) |
| cfrunloop-result | CFRunLoop Result | enum 0–7 |
| connection-uuid64 | Visual Connection ID | 64-bit id |
| core | CPU Index | summing core indices |
| displayed-surface-swap | Displayed Surface Swap | id; sentinel=max |
| fd | File Descriptor | id; sentinel=max (-1 as unsigned) |
| kdebug-func | kdebug Function | 2-bit enum |
| metal-nesting-level | Metal Encoding Nesting Level | level number |
| metal-workload-priority | Metal Workload Priority | priority enum |
| os-signpost-identifier | os_signpost Identifier | id; sentinel=zero |
| packed-identifier | Packed ID | 22-bit serial; sentinel=max |
| pid | Process ID | summing pids; sentinel=max |
| return-location | Return Location | code address |
| swift-task-id | Swift Task ID | id |
| time-sample-kind | Time Sample Type | enum; sentinel=max |

**Tier B — STRING/EXTERNAL-ADDRESS raw: sum/avg returns 0-ish garbage but still "succeeds"** (CAST of text → 0.0 / leading-digit prefix). 34 types:

category, display-event-name, display-name, domain-name, event-concept,
event-type, file-path, formatted-label, hang-type, **kperf-bt** (compound cell,
raw = fmt summary; NOT blocked by the backtrace guard — see mechanism note 1),
medium-length-string, metal-object-label, narrative, network-interface,
network-protocol, os-log-metadata, process, short-string, signpost-name,
size-in-pixels, sockaddr, string, subsystem, swift-actor, swift-task,
swift-task-priority, swift-task-state, syscall, text-symbol, thread,
thread-state, uuid, vsync-event, word-string.

(`thread`/`process`/`swift-task`/`sockaddr` etc. are compound cells — raw is the
fmt summary string; `narrative`/`os-log-metadata` may additionally be interned,
in which case raw is an SOH-token that CASTs to 0.)

### Correctly blocked (2 of 52)

- `backtrace`, `text-backtrace` — rejected by `resolveComparable` with the
  "use get_row / call_tree" error. REINFORCED (partial: `kperf-bt` and
  `tagged-backtrace`-typed columns whose *mnemonic* differs are the gap;
  `tagged-backtrace` IS in the set, `kperf-bt` is not).

### REINFORCED — non-categorical numeric types where ops are correctly allowed (15)

| mnemonic | classifier verdict | agreement with Apple |
|---|---|---|
| duration | weight/nanoseconds (engineering-type rule, high conf) | ✓ summable; but see zero-sentinel in (b) |
| size-in-bytes | weight/bytes | ✓ |
| network-size-in-bytes | weight/bytes | ✓ |
| event-count | weight/count | ✓ |
| start-time, sample-time, event-time | time role | ✓ not categorical; used for windows, not sums |
| containment-level | detail (default) | ✓ summable per Apple (no categorical flag); has identifier flag though |
| layout-id | detail (via ID_RULE) | ✓ (no categorical flag; 22-bit) |
| render-buffer-depth | detail | ✓ |
| syscall-arg | detail | ✓ (Apple leaves it summable; hex-formatted arbitrary args) |
| syscall-return | detail | ✓ |
| uint32, uint64 | detail unless mnemonic heuristic fires | ✓ |
| vnode | detail | ✓ |

Note: Apple does NOT flag `containment-level`/`layout-id` categorical despite
them carrying an `identifier` treatment — our permissiveness on those matches
the reference exactly, so they are not counted as mismatches.

## (b) Sentinel enumeration — all 19 sentinel-bearing types among the 74

How sentinels arrive, verified against committed fixtures
(`tests/fixtures/xcode-27.0/schema-table/`):

- **Missing cells** are `<sentinel/>` XML elements → parseTable stores NULL →
  aggregate/find/query exclude them correctly. (e.g. runloop-intervals rows 2+
  have `<sentinel/>` for run-result.)
- **Type-level sentinel VALUES arrive as live literals**, NOT `<sentinel/>`.
  Fixture-confirmed: runloop-intervals `timeout` (uint64) carries both
  `18446744073709551615` (uint64 max) and `4294967295` (uint32 max) as "no
  timeout"; com-apple-cfnetwork-task-intervals `error-code` carries uint64 max
  as "no error"; runloop-intervals `return-after-source-handled` carries
  `<boolean fmt="Yes">3</boolean>` — **raw 3 is the 2-bit boolean max sentinel,
  and xctrace itself mis-formats it "Yes"**, so even the fmt is a trap.

Storage of a literal sentinel (`coerceRaw`, parseTable.ts:109): all-digit and
≤ 2^53-1 → plain JS number; > 2^53-1 (uint64 max) → exact digit **string** (TEXT
column). Neither is NULL, so both pass every `IS NOT NULL` guard and
participate in sum/avg/min/max/percentiles, find gt/lt, correlate/relate
measure sums, and timeline bucketing. `CAST('18446744073709551615' AS REAL)` =
1.8446744073709552e19.

The two found the hard way previously, for calibration: (1) `error-code`
uint64-max (drove coerceRaw's string-retention; tests/coerceRawSentinelPrecision.test.ts);
(2) timestamp **0** = "predates recording" (an *undocumented* extra sentinel on
time columns — handled only inside the network and leaks lenses via
`ZERO_TIMESTAMP`, src/lenses/network/index.ts:21-27). The complete documented
list follows.

| # | mnemonic | sentinel | bit width | current pipeline behavior |
|---|---|---|---|---|
| 1 | boolean | max (=3) | 2 | **Fixture-confirmed live**: raw 3 stored as number with fmt "Yes" — filter `eq val:1` misses it, "n/a" state indistinguishable from Yes; summable (categorical). |
| 2 | cfrunloop-result | max (=7) | 3 | Stored as plain number; would group/filter as a phantom result value; summable. Not observed in fixtures. |
| 3 | containment-level | max (=511) | 9 | Non-categorical number — poisons max/avg by +511-scale; not observed. |
| 4 | core | max (=65535) | 16 | Phantom "CPU 65535" group in group-by; filters treat as real; summable. |
| 5 | displayed-surface-swap | max (uint64, "-1 hex") | — | uint64-max → TEXT raw → CAST = 1.8e19, poisons any sum/avg/max; correlate/find treat as real. |
| 6 | duration | **zero** | 50 | **Highest leverage**: 0 stored as ordinary number. Sum unaffected, but avg/min/median/percentiles silently deflated — and `duration` is the pinned `primaryWeight` for ~25 schemas in roleHints.ts, i.e. the *default invited measure*. No exclusion anywhere. |
| 7 | event-count | max | — | Classified weight/count (invited measure). uint64-max → TEXT → CAST 1.8e19 poisons sum/avg/max. |
| 8 | event-time | max (2^50-1) | 50 | ≈13.03 days in ns — safe integer, stored as number; poisons max, timeline extent, timeRange logic; relate/correlate window joins treat as a real instant. |
| 9 | fd | max ("-1", unsigned impl) | — | uint64-max → TEXT → CAST 1.8e19; grouping shows it as its own giant fd; categorical anyway. |
| 10 | network-size-in-bytes | max | — | Classified weight/bytes (invited measure) — sentinel poisons sum/avg/max at 1.8e19 or 4.29e9 scale. |
| 11 | os-signpost-identifier | **zero** | — | 0 stored as number ("OS_SIGNPOST_ID_NULL is illegal"); joins/group-bys on signpost id would merge unrelated rows under 0. |
| 12 | packed-identifier | max (2^22-1 = 4194303) | 22 | Plain number; phantom identifier group; reference explicitly reserves 22-bit max as sentinel. |
| 13 | pid | max (2^17-1 = 131071) | 17 | Plain number; phantom pid; process-filters would happily match it. |
| 14 | render-buffer-depth | max | — | Non-categorical → freely summable; uint64-max → TEXT → CAST 1.8e19. |
| 15 | sample-time | max (2^50-1) | 50 | Same as event-time: real-looking 13-day timestamp; poisons timeline/max/windows. |
| 16 | size-in-bytes | max | — | Classified weight/bytes (invited measure — fs-syscall lwrites/lreads/bytes). Sentinel poisons sum/avg/max. |
| 17 | start-time | max (2^50-1) | 50 | Time role: poisons timeRange windows, timeline extent, interval joins. (Separately, the undocumented 0-sentinel "predates recording" is only mitigated in 2 lenses, not in the universal verbs.) |
| 18 | syscall-return | max ("displayed signed") | — | fs-syscall `return`/`errno`: uint64-max → TEXT → CAST 1.8e19; "sum of errno" is a plausible agent mistake and returns garbage confidently. |
| 19 | time-sample-kind | max (=65535) | 16 | Plain number; phantom sample-kind group; categorical anyway. |

Sentinel magnitude caveat (fixture-verified): the same logical "max" sentinel
appears at *different widths per producer* — runloop-intervals `timeout` shows
both 2^64-1 (TEXT path) and 2^32-1 (number path) in one fixture. Any future
sentinel handling must not assume a single literal.

Related literal "-1 as unsigned" values in types Apple does NOT flag with a
Sentinel (so poisoning is technically per Apple's book "legal" but identical in
effect): `syscall-arg` (detected-fs-antipattern arg1 = 0xffffffffffffffff),
`vnode` (fs-syscall), `address` (runloop-events runloop-pointer), `uint64`
(spid, error-code, timeout).

## (c) Bit width — precision risks for JS number handling

**Parse path (REINFORCED, tested):** `coerceRaw` (parseTable.ts:109-114) keeps
any all-digit value past `Number.MAX_SAFE_INTEGER` as an exact string — no
precision loss at parse/store. Covered by tests/coerceRawSentinelPrecision.test.ts.
Negative-looking values ("-1") never match `/^\d+$/` and also stay strings.

**Types whose documented/practical width can exceed 53 bits** (all CLIPS
INTEGER): `uint64`, `address`, `syscall-arg`, `syscall-return`, `vnode`,
`connection-uuid64`, `swift-task-id`, `os-signpost-identifier`,
`displayed-surface-swap`, and every uint64-max sentinel above.
Fixture-confirmed real (non-sentinel) >2^53 values: runloop-intervals `timeout`
= 4768471730841330159.

**Where precision is still lost downstream** (the parse-path safety does not
carry through):

1. `CAST(raw AS REAL)` in aggregate.ts:290, sqlHydrate.ts gt/gte/lt/lte
   (684-699), relate.ts:297 — a TEXT-stored 64-bit value becomes a double
   (±~1024 at uint64-max scale, verified historically: off by 385). Sums/
   comparisons over such columns are approximate; two distinct large ids can
   compare equal after the cast.
2. Numeric `eq` in find (`raw = ? OR CAST(raw AS REAL) = ?`) can't work for
   >2^53 ids anyway — the JS/JSON caller cannot even express the exact number.
   The string form (`CAST(raw AS TEXT) = '…'`) works and is the survivable
   path; nothing steers an agent toward it.
3. SQLite type-ordering hazard: a TEXT-stored large raw compared to a numeric
   param with plain `>=`/`<=` (buildTimeRangeFilter, sqlHydrate.ts:612) sorts
   ALL TEXT above ALL numbers. Not currently biting for time columns (50-bit →
   always stored as numbers), but any future >2^53 column used in an uncast
   range filter would match unconditionally.

**Safe widths (no JS risk):** the 50-bit time family (start-time, sample-time,
event-time, duration — 2^50 ≪ 2^53, and Apple documents the 50-bit compression
limit), pid 17, core 16, time-sample-kind 16, containment-level 9,
packed-identifier 22, layout-id 22, cfrunloop-result 3, kdebug-func 2,
boolean 2, uint32.

Marginal note: SUM of 50-bit durations across millions of rows is done as SQL
REAL — a >2^53 ns total (≈104 days cumulative) would round, but that magnitude
is implausible for real traces; noted for completeness, not a finding.

## Not-in-reference (7) — noted, no reference claims

`analysis-core-swift-task`, `cause-set`, `description-set`, `mach-port`,
`swiftui-update`, `typed-array`, `view-hierarchy`. All behave per the generic
mechanism: non-backtrace, so summable; compound/array-ish ones (cause-set,
typed-array, view-hierarchy) have string raw → Tier-B-style garbage sums.
`mach-port` raw is a plain number (fixture: `<mach-port fmt="0x2503">9475</mach-port>`)
→ Tier-A-style plausible-looking sums.

## Compact takeaways

1. Summability is ungated: 50 of Apple's 52 documented-categorical types in
   fixture scope can be summed/averaged today; only `backtrace`/`text-backtrace`
   are blocked, and `kperf-bt` slips through the backtrace guard.
2. 19 sentinel-bearing types; sentinel values arrive as live literals (never
   `<sentinel/>`), stored as real numbers or exact digit strings, and no layer
   excludes them. The invited-measure overlaps (`duration` zero-sentinel;
   `event-count`/`size-in-bytes`/`network-size-in-bytes` max-sentinels) are the
   highest-risk because roleHints actively recommends those columns.
3. Parse-path 64-bit safety is real and tested, but `CAST AS REAL` at query
   time re-introduces the exact precision loss coerceRaw was built to avoid,
   for every >2^53 column.
