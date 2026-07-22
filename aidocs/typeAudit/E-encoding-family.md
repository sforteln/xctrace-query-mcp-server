# Slice E — Encoding Notes (opaque values) & Family Grouping usability

Discovery-only audit. Inputs: the 74 fixture mnemonics (`fixture-mnemonics.json`),
`aidocs/engineeringTypeReference.json`, `src/engine/parseTable.ts`,
`src/engine/sqlHydrate.ts`, `src/core/schema.ts`, `src/core/getRow.ts`,
`src/core/queryHints.ts`, and the committed fixtures under
`tests/fixtures/xcode-27.0/schema-table/`.

---

## (a) Encoding Notes — what the project currently does per type

### How parsing actually branches (parseTable.ts)

There are exactly THREE parse paths; engineering-type is only hard-coded for one of them:

1. **Backtrace special case** (`parseCell`, ~line 223): tag `backtrace` / `text-backtrace` /
   `tagged-backtrace` **with inline `<frame>` children** → full `resolvedFrames[]` extraction.
   The only per-type special-casing in the parser.
2. **Generic compound recursion**: ANY element with XML children (thread, process, kperf-bt,
   swift-task, swift-actor, swift-task-priority, text-symbol, uuid, narrative, …) → recursive
   `children` map. Nothing type-specific; the XML's own nesting drives it. These are NOT
   flattened away downstream: sqliteStore promotes `mnemonic__child__fmt` columns and
   fieldRef exposes dot-paths (`thread.process.pid`), surfaced in describe_schema's
   `nestedFields`. **Caveat**: repeated child tags take-first
   (`parseCell`: "For repeated child tags (e.g. multiple text-address), take first") — see
   kperf-bt and uuid notes below.
3. **Scalar fall-through**: everything else → `{fmt, raw: coerceRaw(text||fmt)}`. raw is a
   number only if all-digits and ≤ MAX_SAFE_INTEGER, else the exact string.

So "opaque blob / bare string" status is decided by what xctrace's XML emits, not by the
type table — and the fixtures show several documented-structured types that xctrace emits
as **scalars**, which is where the newly-knowable findings live.

### NEWLY-KNOWABLE findings (fall-through types with documented internal structure)

1. **sockaddr** (NetworkConnectionStats `local-address`/`remote-address`,
   network-connection-detected `address`) — **the headline finding**. Apple: "Encoded as a
   sockaddr structure in C." Fixture sample:
   `<sockaddr fmt="192.168.0.47:62260">3386892463258141200 0</sockaddr>`.
   The raw text is the C `struct sockaddr` packed into little-endian 8-byte words —
   **verified by decoding the fixture value**: bytes `10 02 f3 34 c0 a8 00 2f` =
   len 16, family 2 (AF_INET), big-endian port 62260, addr 192.168.0.47 — exact match with
   fmt. We currently store the display string and a non-numeric raw string ("… 0" has a
   space, so coerceRaw keeps it as text). Newly exposable: **address family, port, and IP as
   separate queryable fields** (today: can't filter by port numerically, can't distinguish
   IPv4/IPv6 structurally — only substring-match on fmt).

2. **size-in-pixels** (device-display-info) — Apple: "a 64-bit integer array … (width,
   height)". Fixture: `fmt="2532 x 1170"`, raw text `2532x1170`. Neither stored form is
   numeric → **width/height are not comparable/filterable** (e.g. "displays wider than 2000px"
   needs string parsing). Newly exposable: width/height fields.

3. **packed-identifier** (NetworkConnectionStats `connection-serial`,
   network-connection-update) — Apple: 22-bit ID, and "The 22 bit max is reserved as the
   sentinel" → **4,194,303 (0x3FFFFF) is a documented null-sentinel** nothing in the project
   recognizes. Same trap class as the curated core-data-fetch `spid` gotcha (max-uint64
   sentinel), but this one is *derivable from the reference* rather than needing live
   verification.

4. **fd** (fs-syscall, detected-fs-antipattern) — Apple: "-1 is valid, but the
   implementation type is unsigned. A cast to a signed value should provide the correct
   conversion." → a raw `18446744073709551615` fd means **fd = -1 (no descriptor)**, not a
   real handle. Nothing interprets this today.

5. **vnode** (fs-syscall) — fixture sample is literally `fmt="0xffffffffffffffff"` (max
   uint64): the same unsigned -1 / "none" sentinel pattern, present in real fixture data.
   Not documented in the reference, but the fd note makes the pattern knowable.

6. **os-signpost-identifier** (OSSignpostIntervals `identifier`) — Apple: "The value 0 and
   UINT64_MAX are illegal (OS_SIGNPOST_ID_NULL and OS_SIGNPOST_ID_INVALID)" → knowable
   sentinel semantics for a column agents may try to join/group on.

7. **connection-uuid64** (displayed-surfaces-interval `connection-UUID`) — Apple: "aids in
   **visually connecting a row in one table to a row in another table**." This is a
   documented **cross-table join key** currently stored as a bare number with no hint.
   Direct schemaEdges (equi-join) candidate.

8. **containment-level** (runloop-intervals) — Apple: nesting depth, root = 0, values
   compact. Rows form a **containment hierarchy** — a grain fact ("rows nest; depth column
   present; don't sum durations across depths without filtering a level") that
   queryHints.inferGrain can't currently see.

9. **layout-id** (OSSignpostIntervals `layout-qualifier`) — Apple: a lane index so
   **overlapping** intervals don't visually collide → its very presence documents that this
   schema's intervals overlap. Grain-gotcha material (inferGrain already warns generically
   about interval overlap; this is positive confirmation).

10. **cfrunloop-result** (runloop-intervals) — Apple: valid values 1–4, 0 = "Unknown" — a
    tiny documented enum (why the runloop run ended). fmt likely already names it; the enum
    domain is knowable for validation/grouping hints.

11. **kperf-bt** (time-sample) — Apple's encoding: array of [text-addresses fragments,
    PC, process iid, fix-up registers], and the parent `backtrace` type's note says
    fragments are per-process ("backtrace can be from different processes"). Two flattening
    facts today: (i) the `text-addresses` child is ONE space-separated address string
    (`"6760737324 6760701868 6761773004"`, fmt "frag 1") — individual frame addresses are
    not split out at the Cell level (call_tree's cross-row symbolication handles full
    stacks; get_row surfaces only topPc + frame count, by design); (ii) the take-first
    repeated-child rule means a **multi-fragment** kperf-bt (cross-process stack) would keep
    only frag 1 in `children` — fixtures show 1 frag per cell (labels frag 1–3 across
    cells), so latent, not observed.

12. **uuid** (com-apple-cfnetwork-task-intervals) — compound with TWO `eight-byte-array`
    children (MSB/LSB); take-first keeps only the MSB child. **No practical loss**: fmt
    already carries the full canonical UUID string.

### Where treating-as-text is verifiably CORRECT (no finding)

- **string / short-string / medium-length-string / word-string / uint32 / uint64** —
  Apple explicitly labels these prototyping catch-alls ("should only be used for
  prototyping…"); no internal structure exists to expose. RequestTable/SessionTable/
  ToolTable being ~all string/uint64 is Apple's choice, not our flattening.
- **return-location** — documented as a (uuid, mach-o-vm-offset) pair, but xctrace exports
  it already resolved (`fmt="PreFlightQuery.swift:42"`). Nothing to decode.
- **backtrace's packed 32/32 process+fragment encoding** — moot: the schema-table export
  emits inline resolved `<frame name addr>` which path 1 fully parses (resolvedFrames).
- **thread / process / text-symbol / swift-task / swift-actor / swift-task-priority /
  narrative** — compound in the XML, children captured, nested dot-paths queryable. Apple's
  Structure tables match what the XML actually nests (e.g. thread = [tid, process];
  swift-task-priority = [string, uint32]).
- **start-time's 50-bit limit / duration ns / boolean 0-1** — consistent with current
  numeric handling; no exposure gap.

### Not in the reference at all (7 types)

`analysis-core-swift-task, cause-set, description-set, mach-port, swiftui-update,
typed-array, view-hierarchy` — private/undocumented types (mostly SwiftUI instrument).
No Apple encoding notes exist to mine; the project already gives `view-hierarchy` bespoke
treatment at the storage layer (hierarchyEncode node-encoding of repeated chain segments).

---

## (b) Family grouping as describe_schema's "gross form" — verdict: NO as-is (qualified)

### What gross form is today

`queryHints.grossForm` (part 1 of the 4-part orientation) = grain sentence (inferred from
role/engineering-type signature) + size tier + load-bearing columns (time/weight/identity).
Columns additionally carry a per-column `role` and a `rolesSummary` grouping
(time/weight/backtrace/thread/label/detail) in the describe_schema payload.

### The distribution evidence

Across the 74 distinct fixture types: **General 46 (62%), Graphics 9, I/O 8, unknown 7,
Memory 2, CPU 2** (Energy and Internal: zero). Per representative schema (family of each
column's engineering type, from the fixtures' own `<schema>` blocks):

| Schema | Cols | Family mix |
|---|---|---|
| time-sample | 7 | General 6, CPU 1 |
| hitches | 8 | General 7, Graphics 1 |
| RequestTable | 13 | **General 13 (100%)** |
| core-data-fetch | 7 | **General 7 (100%)** |
| OSSignpostIntervals | 18 | **General 18 (100%)** |
| swiftui-updates | 18 | General 12, unknown 6 |
| fs-syscall | 25 | General 18, I/O 4, Memory 3 |
| NetworkConnectionStats | 17 | General 8, I/O 9 |
| displayed-surfaces-interval | 15 | General 10, Graphics 5 |

### Why that kills per-column family tags

- **No discrimination where orientation is needed.** In 5 of 9 sampled schemas the tag is
  ≥86% one value ("General"); three are 100%. A column annotation that is almost always the
  same token adds tokens, not signal.
- **Family duplicates what the schema name already says, where it works at all.** The two
  schemas with a real minority family (NetworkConnectionStats → I/O,
  displayed-surfaces-interval → Graphics) announce their domain in their own
  name/instrument; family adds nothing an agent doesn't already have.
- **Coverage gap on the highest-traffic schemas.** 7 fixture types (all the SwiftUI
  compound types plus mach-port) have NO family — 6 of swiftui-updates' 18 columns would
  tag "unknown".
- **The role axis already does this job better.** rolesSummary
  (time/weight/thread/backtrace/label/detail) partitions the same columns by what an agent
  actually does with them (timeRange it, aggregate it, group by it, call_tree it) — the
  family axis (what OS domain Apple filed the type under) answers a question no query
  formation step asks.

### The qualified part

Family is salvageable as a **sparse accent, not a grouping**: mention only the non-General
minority when present ("3 Memory-family byte-count columns: lwrites, lreads, bytes" on
fs-syscall) — the minority family reliably marks the schema's domain-specific measure/key
columns and is cheap to compute from the reference. As a per-column tag or a primary
"gross form" grouping, it fails on the distribution above. (Design suggestion only —
out of scope for this discovery pass.)
