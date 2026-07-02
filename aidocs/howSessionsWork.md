# How sessions work

A session is a load-once cache for one `.trace` file. It avoids calling `xcrun xctrace` more than once per table.

## Files

- `src/engine/session.ts` — session registry, `openTrace()`, `getSession()`, table cache
- `src/engine/xctrace.ts` — the only place `xcrun xctrace` is called
- `src/engine/parseTable.ts` — parses schema-table XML into typed rows
- `src/engine/parseTrackDetail.ts` — parses track-detail XML (Allocations, Leaks)
- `src/engine/schemaModel.ts` — builds and lazily populates column metadata per schema

## Lifecycle

```
open_trace(path)
  → xctrace --toc          # enumerate all schemas in the trace
  → randomUUID()           # mint sessionId
  → sessions.set(id, session)
  → return sessionId + runs + instruments + suggestedStart

query/aggregate/find/get_row(sessionId, schema, run)
  → getSession(sessionId)  # throws if session not found — invalid sessionId
  → tableCache.get(run:schema)  # hit: return cached rows immediately
  → xctrace --xpath        # miss: export one table as XML
  → parseTableXml() or parseTrackDetailXml()
  → tableCache.set(run:schema, rows)
  → return result
```

The cache key is `${run}:${schema}`. A 40-second trace with 50k rows is parsed once and held in memory for the session lifetime. There is no eviction — sessions persist until the MCP server process exits.

## Why xctrace is called at open_trace then never again for metadata

The TOC export (`--toc`) is cheap and gives schema names, run counts, and timestamps. Row data is never fetched at open time — only when a tool call requests a specific (run, schema) pair. This keeps `open_trace` fast regardless of trace size.

## XctraceError

All `xcrun` failures become a structured `XctraceError` with a `kind` discriminator. The tool layer catches these and returns them as structured JSON — the agent never sees raw stderr. Add new failure modes to `XctraceErrorKind` in `xctrace.ts` rather than throwing generic errors.

## What looks surprising but is intentional

**Sessions are never invalidated.** If the user modifies the `.trace` file on disk while a session is open, the server continues using the cached data. This is intentional — `.trace` files written by Instruments are immutable after recording stops.

**`parseTrackDetail` is a separate function from `parseTable`.** xctrace exports Allocations and Leaks in a structurally different XML format (nested under `/tracks/track/details/detail/` rather than `/data/table/`). Both parsers share the same `id`/`ref` resolution logic but have different root XPath handling — see [howFixturesWork.md](howFixturesWork.md) for the format details.
