# How lenses work

A lens is optional ergonomic sugar over the universal core verbs for a specific instrument type. Schemas with no lens are still fully navigable — lenses only add shortcuts.

## Files

- `src/lenses/types.ts` — `Lens` interface, `QuickStart` type
- `src/lenses/registry.ts` — `LensRegistry` singleton, `registry` export
- `src/lenses/index.ts` — re-exports `registry`
- `src/lenses/<name>/index.ts` — one directory per instrument lens
- `src/index.ts` — `LENSES` array; the only place to add a new lens

## What a lens does

```typescript
interface Lens {
  instruments: string[]          // schema names this lens handles
  registerTools(server)          // called once at startup — add MCP tools here
  nextActions(sessionId, schema, run, allSchemas, row?): NextAction[]  // appended to every core verb response
  quickStart?(schemas, sessionId, run): QuickStart | null  // optional; becomes open_trace's `recommended: true` nextAction
}
```

**`instruments`** — the list of schema names this lens claims. The registry indexes these for fast lookup. One lens can claim multiple schemas (e.g. the Core Data lens claims `core-data-fault`, `core-data-fetch`, `core-data-save`, `core-data-relationship-fault`).

**`registerTools`** — most lenses leave this empty (`// No lens-specific tools — core verbs work directly`). Foundation Models (`list_fm_requests`, `find_fm_requests`, `get_fm_request`) and SwiftUI (`list_swiftui_view_body_updates`, `aggregate_swiftui_filtered_updates`, etc.) are the current exceptions — domain-specific shortcuts where the generic core verbs alone weren't enough (see `howHintsWork.md` for how that gets decided). A lens is NOT limited to the base verbs (`query`/`aggregate`/`find`/`relate`) when writing one of these tools — reach for `getDb(sessionId)`/`peekDb(sessionId)` + the `sqlHydrate.ts` helpers (`quoteIdent`, `rawCol`/`fmtCol`, `buildDisplaySelect`, `hydrateNormalizedRow`, `makeFrameLookup`) and write scoped SQL directly whenever a base verb's shape doesn't fit (a single-row lookup, a semi-join with a property check) — see `src/lenses/example.ts`, which demonstrates BOTH patterns (`example_list` calling the base verb `query()`; `example_detail` hand-writing a scoped SQL lookup) side by side as the copy-paste template. Never reach for `fetchAllRowsHydrated` (a whole-table fetch) as a default — see that function's own doc comment in `sqlHydrate.ts` for why (PMT:warm-mica).

**`nextActions`** — suggestions appended to every core verb response when the active schema matches. The optional trailing `row` param (from `get_row`) lets a lens pre-fill a concrete next call from a real value on that row instead of just a table-wide suggestion. Several lenses populate these now (Leaks, Network, Hangs, Thermal, Foundation Models, SwiftUI) — see `howHintsWork.md` for the design patterns (auto-derived vs. curated, table-wide vs. per-row, proactive vs. reactive) rather than re-deriving them per lens. **When your schema has a natural cross-schema companion, suggest joining them, not just querying your own schema in isolation** — a single schema in isolation often can't answer the real question (Leaks/Leaks has no backtrace of its own; Hangs/Thermal have no signal about WHAT was running). The established pattern: check `allSchemas` for the companion, and if present, suggest `relate()` (a specific containment/leak/causality question with counts) or `timeline()` (an exploratory "what else was happening in this window" merge) instead of leaving the agent to guess a companion exists. See the Hangs/Thermal lenses' `timeProfileCorrelationHint` (suggests `correlate`/`call_tree` against Time Profiler samples when present, or a re-record hint when absent) and the Leaks lens's `buildAllocationJoinAction` (suggests the address join into Allocations) as the templates to follow for a new lens with a similar shape.

**`quickStart`** — the most important method. Called by the registry during `open_trace` with the schemas present in the last run. The first lens that returns non-null wins; its result is folded into `open_trace`'s `nextActions` as the ONE entry flagged `recommended: true` (`core/response.ts`'s `withRecommended` — PMT:spare-goat; there is no more separate `suggestedStart` field). Return `null` if your schemas aren't in the trace.

**`quickStart` runs from schema names ALONE — before any row is fetched, before any real row count is known** (that's what keeps `open_trace` fast regardless of trace size). This means it has NO cheap way to tell a small table from a table with 800K+ rows before recommending a call. The resulting rule: default to a call that's bounded-by-construction regardless of size (an `aggregate`, or a lens-specific bounded tool) rather than a raw `query` sorted by some column with no filter/timeRange bound — an unbounded `ORDER BY` forces a full-table scan regardless of the `limit`. This isn't hypothetical: `swiftui-updates`' own quickStart used to recommend exactly that raw-sort shape, and that schema is the ACTUAL one that crashed the server at 736,282 rows in production (`engine/memoryGuard.ts`) — see PMT:spare-goat's completion report for the fix and the full audit of every lens's quickStart. Exception: if a schema is genuinely small BY NATURE regardless of trace length (e.g. Leaks/Leaks — a diagnosed-object list, not a raw per-event log), a raw sorted query is fine and often the more useful default; write down WHY when you make that call, the same way the Leaks lens's own quickStart comment does, so it reads as a deliberate exception rather than an oversight.

## How open_trace assembles nextActions (including the recommended entry)

```
open_trace(path)
  → load session, get schemas for last run
  → registry.quickStart(schemas, sessionId, lastRun)
      → iterate allLenses in registration order
      → call lens.quickStart?(schemas, sessionId, run)
      → first non-null result wins
      → stamp { ...result, forRun: run }
  → withRecommended(quickStartResult, actionsAfterOpen(sessionId))
      → quickStart's {tool, args, hint} becomes one NextAction, hint → description, recommended: true
      → prepended to the generic actionsAfterOpen() entries
  → return the merged list as `nextActions` (no separate `suggestedStart` field)
```

`forRun` is stamped by the registry, not the lens — lenses don't set it themselves. At most ONE entry in the whole list ever carries `recommended: true` — never fabricate a ranking of the rest (they're plain, unranked alternatives). See `howHintsWork.md`'s "One ranked list" section for the full reasoning.

## Registration order matters

Lenses are iterated in the order they appear in the `LENSES` array in `src/index.ts`. If two lenses claim overlapping schemas, the first one wins for `quickStart`. For `nextActions` and `get()` lookups, the last registration wins (Map semantics). Keep lenses non-overlapping to avoid this.

## Adding a new lens

1. Create `src/lenses/<name>/index.ts` — copy `src/lenses/hangs/index.ts` as a template for the `nextActions`/`quickStart` shape (including its cross-schema correlation hint pattern), and `src/lenses/example.ts` for the registerTools pattern (base verb vs. direct scoped SQL, side by side)
2. Add it to the `LENSES` array in `src/index.ts` — mind registration order if your schemas overlap with an existing lens (see below)
3. Run `npm test` — the drift guard checks tool description format if you added any tools, and `lensActionsDrift.test.ts` validates every `nextActions`/`quickStart` `{tool, args}` payload against the LIVE tool registry's own zod schemas — a stale arg shape fails loudly instead of silently

## Discovery cost — what's cheap to call from a lens, what isn't

A lens's `nextActions`/`quickStart` code runs INSIDE every core-verb response — so it's tempting to reach for "just check the data first" to build a smarter hint. Know which calls are free before doing that:

- **Free, no I/O**: `peekTable(sessionId, run, schema)` / `peekDb(sessionId)` — read only what's ALREADY cached this session; return `undefined` instantly if nothing's been fetched yet. This is the only way to "check the data" from a hint without risk of turning a fast call into a slow one — every existing table-wide hint (Leaks' `unattributableFractionHint`, Network's `preExistingSnapshotHint`) uses exactly this and nothing else.
- **Cheap-ish, no xctrace call**: `getSchemaMeta`/`describeSchema` — column shape + row count only; usually free (already known from an earlier fetch, or from PMT:ruby-peak's persisted-cache metadata if a prior process already ingested this exact table), otherwise a bounded discovery-only pass.
- **Potentially expensive, real work**: `getTable`/`getTableAtPosition` (and anything that calls them: `query`/`aggregate`/`find`/`get_row`/`call_tree`/`relate`) — triggers a real `xctrace export` + full ingestion the FIRST time a given (run,schema) is touched in a FRESH persisted-cache file. After that first time, PMT:ruby-peak's colocated cache makes every later call (even from a brand-new process reopening the same trace path) reuse the ingested table with near-zero cost — but a lens's hint code must never assume that's already true; use `peekTable`/`peekDb` to check, never `getTable`, if the point is "only enrich the hint when this is already warm."

See `howSessionsWork.md`'s "Discovery cost tiers" section for the full picture across every verb, not just what a lens needs.

## Core verb vs lens/detector — the cost rule (PMT:pure-hail)

This is the standing rule for EVERY "should this be a free verb or a named lens/detector?" decision, not just the detector library — write it down here so it doesn't rot as the surface grows.

**The test: can the operation be made intrinsically bounded?** — row-limited, single-table, indexed-filter, or timeRange-scoped so it cannot run away regardless of trace size.
- **Yes → a free core verb** the AI fires freely (`query`/`aggregate`/`find`/`get_row`, and a `cheap` detector that runs eager on open_trace). The guardrail: these must ACTUALLY stay bounded — limits, a required timeRange on big tables, no free-form cross-table joins — or the tiering leaks.
- **No → a named lens/detector** the author cost-vets and index-guarantees, invoked by name with bounded params. This covers range joins, full-population anti-joins, percentile UDFs, multi-CTE causality, big call-trees. Making the expensive operation reachable ONLY as an author-indexed lens turns a mitigation into a guarantee: the AI cannot hand-write the unindexed O(n×m) version.

Two consequences that fall out of the rule:
- **The eager-on-open_trace detector sweep is affordable** precisely because only intrinsically-cheap detectors run eagerly — so open_trace stays fast on any trace size.
- **SQL is never the AI's surface.** SQL is the internal implementation language of verbs and detectors; a detector returns a structured Finding (summary + firing conditions + a re-runnable callSpec in this server's OWN verbs + get_row/timeRange handles), never a SQL string. Exposing SQL is this server's analog of handing the model a delete tool (injection, runaway scans, unbounded surface).

(The core-vs-lens principle also belongs in the `mcp-server-design` skill as a general MCP rule; recorded here as this project's specific home.)

## What looks surprising but is intentional

**The registry is a process-wide singleton.** `registry` is exported from `src/lenses/index.ts` and imported everywhere. There is no dependency injection — this is intentional; the registry is stateless (it holds no session data) and there is only ever one server per process.

**`quickStart` receives all schemas for the run, not just the matched ones.** A lens can look at the full set to make smarter decisions — e.g. preferring one schema over another when both are present.
