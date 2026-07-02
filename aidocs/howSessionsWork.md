# How sessions work

A session is a load-once cache for one `.trace` file. It avoids calling `xcrun xctrace` more than once per table.

## Files

- `src/engine/session.ts` — session registry, `openTrace()`, `getSession()`, table cache, `getSchemaMeta()`, `getProjectedTable()`
- `src/engine/xctrace.ts` — the only place `xcrun xctrace` is called
- `src/engine/parseTable.ts` — parses schema-table XML into typed rows (streaming; also the countOnly/projected modes — see "Large-table hardening" below)
- `src/engine/parseTrackDetail.ts` — parses track-detail XML (Allocations, Leaks, VM Tracker)
- `src/engine/memoryGuard.ts` — the mid-parse heap-usage abort check both parsers call
- `src/engine/schemaModel.ts` — builds and lazily populates column metadata per schema

## Lifecycle

```
open_trace(path)
  → xctrace --toc          # enumerate all schemas in the trace
  → randomUUID()           # mint sessionId
  → sessions.set(id, session)
  → return sessionId + runs + instruments + suggestedStart

query/aggregate/find/get_row/call_tree(sessionId, schema, run)
  → getSession(sessionId)  # throws if session not found — invalid sessionId
  → tableCache.get(run:schema)  # hit: return cached rows immediately
  → xctrace --xpath, streamed        # miss: export one table, piped straight into the parser
  → parseTableStream() or parseTrackDetailStream()  # NOT the buffered XML-string variants — see below
  → tableCache.set(run:schema, rows)
  → return result

describe_schema(sessionId, schema, run)
  → getSchemaMeta()  # column shape + row count ONLY — see "Large-table hardening"

correlate(sessionId, intervalsSchema, eventsSchema, opts)
  → getSchemaMeta() on both schemas (classify columns, no rows yet)
  → getProjectedTable() on both — only the classified-as-needed columns, timeRange narrows during the parse
```

The cache key is `${run}:${schema}`. A 40-second trace with 50k rows is parsed once and held in memory for the session lifetime. There is no eviction — sessions persist until the MCP server process exits. `getSchemaMeta`/`getProjectedTable` deliberately bypass this cache entirely (an incomplete view of a table must never be servable to a caller expecting full rows through cache reuse).

## Large-table hardening

A large enough table can hold enough parsed rows to exceed Node's heap and fatally crash the WHOLE process (not just the offending call) — confirmed live twice: `swiftui-updates` at 736K rows, and `Allocations/Allocations List` at 823K rows with rich resolved backtraces. A fatal V8 OOM aborts before a response (or even a log line) can be written, so it reads to the client as a bare "Connection closed." Three layers address this, from coarsest to finest:

1. **A bigger ceiling** (`src/index.ts`, commit cdaa5eb) — re-execs with `--max-old-space-size=8192` (overridable via `INSTRUMENTS_MCP_MAX_HEAP_MB`) if the launch config didn't already request one. A mitigation, not a fix — an even larger table can still exceed it.
2. **Don't materialize what isn't needed** — `parseTableStream`/`parseTrackDetailStream`'s shared internals (see each file's own doc comments) support a `countOnly` mode (`getSchemaMeta` — column shape + row count, no row array at all) and a projected mode (`getProjectedTable` — only specific mnemonics retained, rows outside a `timeRange` discarded during the parse). `describe_schema` and `correlate` use these instead of a full fetch, which is why they're not exposed to case 3 at all for a table this shape of large.
3. **A hard backstop for callers that DO need real rows** (`memoryGuard.ts`, `assertMemoryBudget`) — `query`/`aggregate`/`get_row`/`call_tree` still need full row data, so they can't take shortcut 2. Every `MEMORY_CHECK_INTERVAL` rows during a streaming parse, checks the process's ACTUAL heap usage (`node:v8`'s `getHeapStatistics()`, which reflects whatever `--max-old-space-size` is really in effect) against a fixed fraction of the ceiling, and aborts cleanly with a structured `"table-too-large"` XctraceError instead of letting V8 hit a fatal OOM. Row count alone isn't a safe trigger — confirmed live: 823K Allocations rows with rich backtraces exhausted the heap; 224K rows of the SAME schema from a different trace, where every backtrace happened to be one trivial sentinel frame, didn't come close. Checking actual heap bytes sidesteps needing a row-weight estimation formula entirely.

## Why xctrace is called at open_trace then never again for metadata

The TOC export (`--toc`) is cheap and gives schema names, run counts, and timestamps. Row data is never fetched at open time — only when a tool call requests a specific (run, schema) pair. This keeps `open_trace` fast regardless of trace size.

## XctraceError

All `xcrun` failures become a structured `XctraceError` with a `kind` discriminator. The tool layer catches these and returns them as structured JSON — the agent never sees raw stderr. Add new failure modes to `XctraceErrorKind` in `xctrace.ts` rather than throwing generic errors.

## What looks surprising but is intentional

**Sessions are never invalidated.** If the user modifies the `.trace` file on disk while a session is open, the server continues using the cached data. This is intentional — `.trace` files written by Instruments are immutable after recording stops.

**`parseTrackDetail` is a separate function from `parseTable`.** xctrace exports Allocations and Leaks in a structurally different XML format (nested under `/tracks/track/details/detail/` rather than `/data/table/`). Both parsers share the same `id`/`ref` resolution logic but have different root XPath handling — see [howFixturesWork.md](howFixturesWork.md) for the format details.

**`call_tree`'s schema-table path (time-profile/cpu-profile) is NOT covered by the memory guard above.** Unlike every other verb, it doesn't go through `parseTableStream` at all — it uses the older buffered `exportXPath` + a one-shot `fast-xml-parser` DOM parse (`ctParser`), needed because the generic streaming parser's `isArray` config collapses the repeated `<frame>` siblings tagged-backtrace relies on (see `callTree.ts`'s own header comment). That means the whole XML string + DOM tree materializes before any row is even iterated — a mid-loop heap check would already be too late for THIS path. Migrating it to a SAX-based, tagged-backtrace-aware streaming parser (mirroring what `MiniXmlBuilder`/`ColumnDiscovery` already do for track-detail) would close this gap; not done yet — a known, deliberately-scoped-out limitation, not an oversight.
