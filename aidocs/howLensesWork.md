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
  quickStart?(schemas, sessionId, run): QuickStart | null  // optional; drives suggestedStart
}
```

**`instruments`** — the list of schema names this lens claims. The registry indexes these for fast lookup. One lens can claim multiple schemas (e.g. the Core Data lens claims `core-data-fault`, `core-data-fetch`, `core-data-save`, `core-data-relationship-fault`).

**`registerTools`** — most lenses leave this empty (`// No lens-specific tools — core verbs work directly`). Foundation Models (`list_fm_requests`, `find_fm_requests`, `get_fm_request`) and SwiftUI (`list_swiftui_view_body_updates`, `aggregate_swiftui_filtered_updates`, etc.) are the current exceptions — domain-specific shortcuts where the generic core verbs alone weren't enough (see `howHintsWork.md` for how that gets decided).

**`nextActions`** — suggestions appended to every core verb response when the active schema matches. The optional trailing `row` param (from `get_row`) lets a lens pre-fill a concrete next call from a real value on that row instead of just a table-wide suggestion. Several lenses populate these now (Leaks, Network, Hangs, Thermal, Foundation Models, SwiftUI) — see `howHintsWork.md` for the design patterns (auto-derived vs. curated, table-wide vs. per-row, proactive vs. reactive) rather than re-deriving them per lens.

**`quickStart`** — the most important method. Called by the registry during `open_trace` with the schemas present in the last run. The first lens that returns non-null wins; its result becomes `suggestedStart` in the `open_trace` response. Return `null` if your schemas aren't in the trace.

## How open_trace assembles suggestedStart

```
open_trace(path)
  → load session, get schemas for last run
  → registry.quickStart(schemas, sessionId, lastRun)
      → iterate allLenses in registration order
      → call lens.quickStart?(schemas, sessionId, run)
      → first non-null result wins
      → stamp { ...result, forRun: run }
  → return suggestedStart in response
```

`forRun` is stamped by the registry, not the lens — lenses don't set it themselves.

## Registration order matters

Lenses are iterated in the order they appear in the `LENSES` array in `src/index.ts`. If two lenses claim overlapping schemas, the first one wins for `quickStart`. For `nextActions` and `get()` lookups, the last registration wins (Map semantics). Keep lenses non-overlapping to avoid this.

## Adding a new lens

1. Create `src/lenses/<name>/index.ts` — copy `src/lenses/hangs/index.ts` as a template
2. Add it to the `LENSES` array in `src/index.ts`
3. Run `npm test` — the drift guard checks tool description format if you added any tools

## What looks surprising but is intentional

**The registry is a process-wide singleton.** `registry` is exported from `src/lenses/index.ts` and imported everywhere. There is no dependency injection — this is intentional; the registry is stateless (it holds no session data) and there is only ever one server per process.

**`quickStart` receives all schemas for the run, not just the matched ones.** A lens can look at the full set to make smarter decisions — e.g. preferring one schema over another when both are present.
