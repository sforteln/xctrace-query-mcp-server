# How hints/advice work

Every tool response can carry guidance beyond raw data — a `nextActions` array, a `note` field, a `templateBundleWarning`, a `finalizeWarning`, an intent's static `note`. This doc is about *how to decide what kind of guidance to add and where it lives* — not the mechanics of the envelope itself (see `overallArch.md`'s pointer to `src/core/response.ts` for that).

## Files

- `src/lenses/<name>/index.ts` — per-lens `nextActions`/`quickStart` (see `howLensesWork.md`)
- `src/core/aggregate.ts`, `src/core/callTree.ts`, `src/core/correlate.ts` — core-verb-level computed hints (schema-agnostic, not lens-specific)
- `src/core/recording.ts` — `RECORDING_INTENTS[type].note` — static, pre-recording guidance
- `src/core/recordingSession.ts` — `templateBundleWarning`, `finalizeWarning` — computed at `start_recording`/`stop_recording` time

## The first question: can this be fixed instead?

Before adding any hint for a "surprising" result, ask whether the underlying behavior should just be corrected. A hint that works around a real bug (a wrong default, a wrong column pick) masks the bug and gets harder to remove later once callers depend on it. Every hint in this codebase should be for a *genuine* ambiguity or a fact an agent can't derive by itself — not a patch over broken behavior. (The `matchThread` false-negative early in this project's life looked exactly like a hint-shaped problem and turned out to be a wrong-column bug instead — fixed at the root, no hint needed.)

## Auto-derived vs. curated — the drift-risk axis

**Auto-derived** — computed from the actual data in front of you, every time. Can't go stale, because it's not a claim about the world, it's a live measurement.
- `aggregate()`'s blank-dominant-bucket `note` (top group's key is `""`) — computed from the real query result.
- The Leaks lens's `unattributableFractionHint` — computed by peeking the cached Allocations join.
- The Network lens's `preExistingSnapshotHint` — computed from the fraction of zero-timestamp rows.
- `call_tree`'s `isBlockingWaitFrame` — computed from a frame's own self/total ratio, not just a name match.

Prefer this whenever the fact is structurally detectable. It's the default, not the exception.

**Curated (static prose)** — a fact hardcoded because it can't be computed from the trace at hand: `WAIT_FRAME_NAMES` in `callTree.ts`, `roleHints.ts`'s pinned `primaryTime`/`primaryWeight`/column-role maps, `RECORDING_INTENTS[type].note` bodies, `TEMPLATE_BUNDLES` in `recording.ts`. These accept a real, bounded staleness risk (Apple could rename a schema, change what a template bundles, add a column) — mitigated two ways, not by trying to eliminate the risk:
1. **Referential drift guard** (`tests/driftGuard.test.ts`) — checks that a schema/tool name a description *refers to* still exists. Cheap, no fixtures, derived from live source imports. Currently only scans registered tool descriptions in `src/index.ts` — extending it to `RECORDING_INTENTS` notes is a known, deliberately-deferred gap (see `howVersionResolutionWorks.md`).
2. **Upgrade checklist** (`howVersionResolutionWorks.md`'s "Other Xcode-version-dependent facts" section) — `TEMPLATE_BUNDLES` needs re-verifying against `--show-recording-options` when a new Xcode version ships, the same way schema fixtures do.

**Deliberately rejected**: a fingerprint-versioned curated-advice database (key advice on a schema's observed column shape, fork additively per fingerprint, fixture-backed drift assertions per curated claim, degrade to auto-derived on an unknown fingerprint). Real complexity and fragility for a guarantee (curated advice staying correct across every future export-shape change) that isn't worth it, and it would raise the bar for contributing a new instrument a lot (every curated note would need a fingerprint signature and a backing fixture). If a curated fact goes stale, fix it when it's noticed — same as any other hardcoded knowledge in this codebase.

The deeper reason this is the right tradeoff: **when a consuming AI hits an unfamiliar or surprising trace shape, the right move is to research it on the real trace in front of it** (the same way every gotcha documented in this codebase was actually discovered — not read from a pre-existing note, found live by inspecting real output). This doc's job, and `describe_schema`'s job, is to make that research cheap — good column-role introspection — not to try to make research unnecessary via an ever-larger pre-encoded database.

## Two shapes: table-wide vs. per-row

Most lens `nextActions` functions branch on whether `get_row` supplied a `row` (see `Lens.nextActions`'s signature in `src/lenses/types.ts` — `row?: Record<string, CellDetail | null>` is the last param):
- **Table-wide** (no `row`): fires on any `query`/`aggregate` result for the schema. Answers "is this whole result trustworthy" — e.g. the Leaks lens's `unattributableFractionHint`, the Hangs/Thermal lenses' `timeProfileCorrelationHint`.
- **Per-row** (`row` present): fires from `get_row` on one specific record. Answers "here's the concrete next call for THIS row" — e.g. the Leaks lens's `buildAllocationJoinAction` (join by address), the Hangs/Thermal lenses' `timeProfileRowAction` (pre-fills `call_tree`'s `timeRange` from that row's own `start`/`duration`, so the caller never re-derives it by hand).

Table-wide hints must **peek, never fetch** (`peekTable` from `engine/session.ts`) — a hint is a bonus on data the caller already paid for, never a reason to trigger an expensive fetch by itself. Getting this wrong turns a cheap `query` call into a slow one just to decide whether to show a hint.

## Two timing points: proactive vs. reactive

- **Proactive** — `RECORDING_INTENTS[type].note` in `recording.ts`, surfaced in `start_recording`'s response, *before* the recording even happens. Use this for facts that can't be discovered after the fact without re-recording — e.g. `hangs`' note that `potential-hangs`/`hitches` carry no backtrace at all, so `instruments: ["Time Profiler"]` needs composing *now*, not after querying comes up empty. Also where `templateBundleWarning`/`finalizeWarning` live (computed at `start_recording`/`stop_recording` time specifically because the decision point is then, not later).
- **Reactive** — lens `nextActions`, fires when the schema is actually queried/aggregated/fetched. This is the *only* mechanism that reaches an agent reopening a `.trace` file recorded in a completely different session — a proactive note is invisible then, since that agent never saw `start_recording`'s response at all. Build both when a fact matters enough (the Hangs/Thermal lenses' `nextActions` is a deliberate backstop for their own `RECORDING_INTENTS` notes, in case the note got missed or the trace predates it).

## Lens-specific vs. core-verb-level

If a hint's *pattern* could apply to any schema regardless of which lens claims it, put it in the core verb (`aggregate.ts`, `callTree.ts`, `correlate.ts`), not a lens. The blank-dominant-bucket check started as a SwiftUI-specific idea but was built into `aggregate()` itself — it now also protects `aggregate_swiftui_filtered_updates` (which calls the same `aggregateTable` under the hood) and any future schema with the same trap, for free. Reserve lens-level hints for genuinely schema-specific correlations (an address join, a specific companion instrument).

## Verify before curating — don't guess a schema's shape

Never add a curated fact (a column list, a "this schema has no backtrace" claim, a suggested companion instrument) from the name alone or from `--show-recording-options` output (that only shows *configurable option keys*, not schema/column shape). Record a real trace and read the actual TOC/export. This caught a real mistake: GCD Performance was assumed to be context-only like Thermal State (by analogy — no standalone template, seemed similar), but a live recording showed it carries its own resolved `backtrace` column and needs no companion at all. The wrong assumption would have shipped a misleading warning if it hadn't been checked. See `PMT:azure-forge`/`PMT:sage-weasel` in the project's PromptManager history for the full story.

## What looks surprising but is intentional

**Some schemas have zero hint coverage and that's fine.** Not every schema needs a lens or a computed check — core verbs (`query`/`aggregate`/`find`/`get_row`) work on anything, hints are additive ergonomics, not a completeness requirement.

**A hint can point at a tool call that hasn't happened yet** (`start_recording` with specific `instruments`, as a `nextAction`'s `tool`/`args`) — this is intentional; a "next action" isn't always a read, sometimes the right next step is a re-recording, and the hint should make that call directly executable (pre-filled args), not just describe it in prose.
