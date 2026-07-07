# How sessions work

A session is a load-once cache for one `.trace` file. It avoids calling `xcrun xctrace` more than once per table.

## Files

- `src/engine/session.ts` — session registry, `openTrace()`, `getSession()`, table cache, `getSchemaMeta()`, `getDb()`, per-session ingestion serialization
- `src/core/relate.ts` / `src/core/correlate.ts` — the generic cross-schema SQL join operator and its friendly time-range/exists preset (PMT:ruddy-stork)
- `src/engine/xctrace.ts` — the only place `xcrun xctrace` is called
- `src/engine/parseTable.ts` — parses schema-table XML into typed rows (streaming; also the countOnly/projected/SQLite-sink modes — see "Large-table hardening" below)
- `src/engine/parseTrackDetail.ts` — parses track-detail XML (Allocations, Leaks, VM Tracker)
- `src/engine/sqliteStore.ts` — `SqliteTableWriter`, `openSessionDb()` — the on-disk ingestion sink (PMT:gravel-cape); see "Large-table hardening" below
- `src/engine/memoryGuard.ts` — the mid-parse heap-usage abort check both parsers call
- `src/engine/schemaModel.ts` — builds and lazily populates column metadata per schema

## Lifecycle

```
open_trace(path)
  → xctrace --toc          # enumerate all schemas in the trace
  → randomUUID()           # mint sessionId
  → sessions.set(id, session)
  → registry.quickStart(...) folded into nextActions as the one `recommended: true` entry (PMT:spare-goat — see howLensesWork.md/howHintsWork.md)
  → return sessionId + runs + instruments + nextActions

query/aggregate/find/get_row/call_tree(sessionId, schema, run)
  → getSession(sessionId)  # throws if session not found — invalid sessionId
  → tableCache.get(run:schema)  # hit: SqliteTableHandle already ingested, no re-export
  → xctrace --xpath, streamed        # miss: export one table, piped straight into the parser
  → parseTableStreamToSqlite() or parseTrackDetailStreamToSqlite()  # streams INSERTs into
    session's SQLite db instead of a JS array (PMT:gravel-cape) — see "Large-table hardening"
  → tableCache.set(run:schema, handle)  # handle = {schema, cols, dbPath, tableName, rowCount} — NO rows array
  → return result

As of PMT:gravel-cape, tableCache holds a SqliteTableHandle, not a ParsedTable with
`rows`. Every verb now reads via SQL against (dbPath, tableName): query/aggregate/find/
get_row (PMT:dusk-floe), correlate/relate (PMT:ruddy-stork), and call_tree (PMT:elm-swamp).
The cutover is complete — nothing references the old `.rows` shape anymore.

describe_schema(sessionId, schema, run)
  → getSchemaMeta()  # column shape + row count ONLY — see "Large-table hardening"

correlate(sessionId, intervalsSchema, eventsSchema, opts)   # now a preset over relate() — PMT:ruddy-stork
  → getSchemaMeta() on both schemas (classify which columns form the join)
  → getTable() on both (ensure ingested + role-indexed), then ONE SQL LEFT-JOIN aggregate
    (B.timestamp BETWEEN A.start AND A.start+A.duration [AND thread]) — an indexed range SEEK,
    NOT a JS nested-loop parse

relate(sessionId, schemaA, schemaB, opts)   # the generic cross-schema join operator (PMT:ruddy-stork)
  → same as correlate but with two knobs: joinCondition (time-range | equality) × polarity
    (exists | not-exists) → correlate is the {time-range, exists} corner; {equality, not-exists} = leak

timeline(sessionId, schemas[], opts)   # time-ordered origin-tagged merge — the EXPLORATORY complement to relate (PMT:coral-cliff)
  → getSchemaMeta() + getTable() per schema (role classification + ensure ingested/indexed), same machinery as relate
  → one SQL UNION ALL of N bounded per-schema SELECTs, each projecting {origin, time, dur, label, rowId} —
    NOT full row detail (get_row is the drill-down) — ORDER BY time ASC LIMIT. REQUIRES a bounded timeRange
    (mandatory, not optional — a cost-tier lens like relate, not a free verb); each branch's WHERE uses the
    BARE raw time column so the per-schema time index is a range SEEK, matching relate's 039.C caution
```

The cache key is `${run}:${schema}`. A 40-second trace with 50k rows is ingested once and its handle held for the session lifetime. There is no in-process eviction — sessions persist until the MCP server process exits (the on-disk `.db` itself persists even longer, across processes — PMT:ruby-peak). `getSchemaMeta` deliberately bypasses `tableCache` entirely (a column-shape-only view must never be servable to a caller expecting full rows through cache reuse).

## Large-table hardening

A large enough table can hold enough parsed rows to exceed Node's heap and fatally crash the WHOLE process (not just the offending call) — confirmed live twice: `swiftui-updates` at 736K rows, and `Allocations/Allocations List` at 823K rows with rich resolved backtraces. A fatal V8 OOM aborts before a response (or even a log line) can be written, so it reads to the client as a bare "Connection closed." Layers 1–3 below were the original mitigation stack; layer 4 (PMT:gravel-cape) is the structural fix for the ingestion side specifically.

1. **A bigger ceiling** (`src/index.ts`, commit cdaa5eb) — re-execs with `--max-old-space-size=8192` (overridable via `INSTRUMENTS_MCP_MAX_HEAP_MB`) if the launch config didn't already request one. A mitigation, not a fix — an even larger table can still exceed it.
2. **Don't materialize what isn't needed** — `parseTableStream`/`parseTrackDetailStream`'s shared internals support a `countOnly` mode (`getSchemaMeta` — column shape + row count, no row array at all), used by `describe_schema` and by correlate/relate to classify columns before touching rows.
3. **A hard backstop for callers that DO need real rows** (`memoryGuard.ts`, `assertMemoryBudget`) — still called at the same `MEMORY_CHECK_INTERVAL` cadence from the SQLite-sink ingestion path (layer 4) too, now as cheap insurance against RefCache/binaryCache/frameCache retention rather than the primary defense — rows no longer accumulate in a JS array at all for the ingestion step, so the dominant OOM driver this layer was built for is gone for that step specifically. Row count alone was never a safe trigger on its own — confirmed live: 823K Allocations rows with rich backtraces exhausted the heap; 224K rows of the SAME schema from a different trace, where every backtrace happened to be one trivial sentinel frame, didn't come close.
4. **Structural fix: stream straight into SQLite instead of a JS array** (`sqliteStore.ts`'s `SqliteTableWriter`, PMT:gravel-cape) — `parseTableStreamToSqlite`/`parseTrackDetailStreamToSqlite` write each row via a batched `INSERT` (transaction every `MEMORY_CHECK_INTERVAL` rows) into a per-(run,schema) SQLite table instead of pushing into `rows: NormalizedRow[]`. Memory use during ingestion is now bounded by the batch size, not the table size — verified live against a real 145,033-row/412MB Allocations trace (74,882 unique backtraces, genuine multi-frame stacks) with no heap pressure. Every verb (query/aggregate/find/get_row/correlate/relate/call_tree) now reads via SQL against the ingested table, so the memory-safety story extends all the way through — including call_tree, which used to be the one path exposed to a full-DOM OOM (PMT:elm-swamp; see the "surprising but intentional" note below).

**A real, deliberate cost of layer 4 for track-detail schemas specifically**: unlike schema-table (which has an upfront `<schema>` block, so columns are known before any row arrives), track-detail has no such block — column shape is only knowable from the union of attributes across every row. So ingesting a track-detail schema into SQLite costs **two** full `xcrun xctrace export` + SAX-parse passes (a cheap discovery-only pass via the existing `countOnly` path, then a real ingest pass using the now-known columns), not one. Confirmed live: ingesting the 412MB/145,033-row trace above took ~380 seconds total — roughly double what a single old-style pass took for a comparably-sized trace in earlier sessions. A real, deliberate memory-for-time tradeoff, not an oversight.

## Why xctrace is called at open_trace then never again for metadata

The TOC export (`--toc`) is cheap and gives schema names, run counts, and timestamps. Row data is never fetched at open time — only when a tool call requests a specific (run, schema) pair. This keeps `open_trace` fast regardless of trace size.

## Discovery cost tiers — what's cheap, what's expensive, and why that changed twice

Every tool/function in this server falls into one of four cost tiers. This matters for anyone adding a new lens, verb, or hint — reaching for the wrong tier turns a fast call into a multi-minute one, or (the opposite mistake) skips a cheap check that would have made a hint smarter for free.

1. **Free, no I/O at all** — `peekTable(sessionId, run, schema)` / `peekDb(sessionId)`. Reads only what THIS session has already cached in-process; returns `undefined`/`undefined` instantly if nothing's been fetched yet. Never triggers a fetch. This is the only safe way for a lens hint to "check the data" without risking turning a fast call into a slow one.
2. **Cheap — TOC/metadata only, one `xctrace --toc` or a bounded discovery pass** — `open_trace` (TOC export: schema names, run counts, timestamps — never row data) and `list_instruments` (reads the already-loaded TOC). Both stay fast regardless of trace size, by design — see the section above.
3. **"Cheap-ish" — `describe_schema`/`getSchemaMeta`** — column shape + row count only, never full rows. Three ways this can be even cheaper than a bounded pass, cheapest first: (a) already known from an earlier call this process (`session.schemaModel`/`session.instruments`, in-memory, free); (b) already known from PMT:ruby-peak's PERSISTED cache — a prior process's ingestion of this exact (run,schema) into the same colocated/fallback `.db` file, read via `loadIngestedSchemaCols` + a `SELECT COUNT(*)`, still zero `xctrace` calls, even in a brand-new process; (c) otherwise, one bounded discovery-only `xctrace export` pass (no SQLite writes, no row materialization).
4. **Potentially expensive — full ingestion** — `query`/`aggregate`/`find`/`get_row`/`call_tree`/`relate`/`correlate`/`timeline` all call `getTable`/`getTableAtPosition` under the hood, which is where a real `xctrace export` + streaming SQLite ingest happens. This is genuinely slow the FIRST time a given (run,schema) is touched against a fresh cache (see "Large-table hardening" below for just how slow on a huge table). After that first time, two independent caching layers make every LATER touch of the same table fast: within one process, `session.tableCache` (in-memory) serves repeat calls instantly; across process restarts, PMT:ruby-peak's persisted, colocated `.db` file means even a BRAND-NEW process opening the same trace path reuses the already-ingested table with a ~3ms reuse hit instead of paying the full ingest again (verified live: an ~8s real ingest vs. a 3ms reuse on the same table from a fresh session — see PMT:ruby-peak's completion report).

**This cost story changed twice across this feature, and both changes are easy to get stale advice about if you're reading old notes**: pre-PMT:gravel-cape, "expensive" meant "accumulates in the JS heap and can OOM the whole process" — PMT:gravel-cape/elm-swamp fixed that structurally (SQLite ingestion is memory-bounded regardless of table size). Pre-PMT:ruby-peak, "expensive the first time" meant "expensive EVERY time a new server process opens this trace" — PMT:ruby-peak fixed that too (persisted, colocated, cross-process reuse). What's still genuinely true today: the FIRST real ingestion of a large table into a FRESH cache is slow (real xctrace export dominates, not the SQLite write) — there's no way around paying that once; the entire point of tiers 1–3 and the reuse mechanism in tier 4 is to make sure it's paid AT MOST once, ever, per (trace path, run, schema).

## XctraceError

All `xcrun` failures become a structured `XctraceError` with a `kind` discriminator. The tool layer catches these and returns them as structured JSON — the agent never sees raw stderr. Add new failure modes to `XctraceErrorKind` in `xctrace.ts` rather than throwing generic errors.

## What looks surprising but is intentional

**Each session's SQLite DB file is now a PERSISTED cache, not session-scoped temp storage (PMT:ruby-peak).** `TraceSession.dbPath` used to be `os.tmpdir()/instruments-mcp-server/<sessionId>.db`, deleted by `closeSession` on every close. It's now colocated right next to the `.trace` file itself — same directory, same basename, `.db` extension (e.g. `Leak-08-19.trace` → `Leak-08-19.db`) — resolved lazily on first table fetch (`session.ts`'s `getSessionDb`, via `engine/traceCache.ts`'s `resolveAndOpenTraceDb`), not at `open_trace` time (keeps `open_trace` exactly as fast as before — no xctrace call added). `closeSession` now only closes the connection; it does NOT delete the file. When the trace's own directory isn't writable (a read-only mount, permissions, an Xcode-managed autosave dir), it falls back to a shared cache directory — OS-convention default (`config.ts`'s `defaultFallbackCacheDir()`, sibling to `config.json`) or user-configured via the `set_cache_dir` tool — keyed by a hash of the trace's absolute path (colocation needs no such scheme; a shared directory serving many traces does). "Is this directory writable" is answered by attempting to open a db file there and catching the failure (TOCTOU-safe), not a pre-check.

**Staleness and cross-process reuse are two different mechanisms, both in `engine/traceCache.ts` / `sqliteStore.ts`.** The persisted db's `_meta` key-value table stores the source `.trace`'s mtime (+ its own path, as a fallback-directory hash-collision guard) at ingest time; every open compares it against the live file's current mtime — a mismatch wipes the `.db` and starts fresh rather than ever risking silently stale data. Separately, `_ingested_schema` persists each ingested table's column metadata (mnemonic/name/engineering-type) — the fact a physical SQLite table's column NAMES alone can't reconstruct (a fresh process has no in-memory record of a schema it never itself parsed). `getTable`/`getTableAtPosition`/`getSchemaMeta` all check `loadIngestedSchemaCols` FIRST, before doing any xctrace export — if a prior process already ingested this exact (run,schema) into this same (mtime-verified-fresh) db file, this returns real cols + a `SELECT COUNT(*)` row count with ZERO xctrace calls (verified live: a full ~8s ingestion vs. a 3ms reuse hit on the same table from a fresh session). This is the actual "zero re-parse cost" the whole feature exists to deliver — colocating the file alone wouldn't have delivered it without this reuse check, since the ingestion code otherwise unconditionally `DROP TABLE`s and re-ingests from XML.

**The persisted db does NOT use WAL — a deliberate reversal from the session-temp db's default.** WAL only earns its keep for concurrent reader/writer access; this db is write-once-during-ingest then read-only (no concurrent writer ever touches a schema after it loads), so WAL there is pure downside — it leaves `.db-wal`/`.db-shm` sidecar files next to the `.trace`, defeating the "one obvious file to manage" tidiness this feature is built around. `openSessionDb` takes a `journalMode` option (`"wal"` default, `"default"` for the persisted path) — the default rollback journal leaves only a transient `-journal` during a write transaction, deleted by SQLite on commit, so after ingest exactly one `.db` file sits next to the trace.

**Orphaned `.db` files are deliberately left alone.** If a user deletes a `.trace` by hand but leaves its colocated `.db`, nothing actively cleans it up — a rare, low-urgency, harmless leftover for a human to notice, not worth building directory-scanning cleanup logic for (that would over-engineer the fallback path specifically called out as "the exception, not the common case").

**Concurrent ingestion is serialized per session (PMT:ruddy-stork).** The single session db connection can't run two ingestion transactions at once — two concurrent `getTable` calls (e.g. relate()/correlate() self-joining a schema, or Promise.all over two different schemas) would hit "database is locked" (found live). `getTable` guards this two ways: a per-(run,schema) in-flight dedupe (`pendingIngest`) so same-schema concurrency shares one ingestion, and a per-session serialization chain (`sessionIngestChain`) so different-schema ingestions run one at a time.

**Sessions are never invalidated.** If the user modifies the `.trace` file on disk while a session is open, the server continues using the cached data. This is intentional — `.trace` files written by Instruments are immutable after recording stops.

**`parseTrackDetail` is a separate function from `parseTable`.** xctrace exports Allocations and Leaks in a structurally different XML format (nested under `/tracks/track/details/detail/` rather than `/data/table/`). Both parsers share the same `id`/`ref` resolution logic but have different root XPath handling — see [howFixturesWork.md](howFixturesWork.md) for the format details.

**`call_tree` now streams through SQLite like every other verb (PMT:elm-swamp — the schema-table caveat that used to live here is CLOSED).** It previously buffered the whole XML + built a one-shot `fast-xml-parser` DOM (`ctParser`) because that parser's `isArray` config collapses tagged-backtrace's repeated `<frame>` siblings — the last path exposed to the OOM this whole section is about. The fix wasn't a bespoke SAX parser: the streaming `MiniXmlBuilder` already arrays repeated siblings correctly, so `tagged-backtrace` is now just a backtrace column (see `sqliteStore.ts`'s `isBacktraceCol`) that ingests through the normal `parseTableStreamToSqlite` path. `call_tree` folds from ONE bounded `SELECT` of weight + backtrace_id (streamed via `.iterate()`, filtered by thread/timeRange), resolving frames from the shared table — the full table's rows/DOM never materialize. The buffered `ctParser` is gone.

**Lenses use bespoke scoped SQL, not just the base verbs (PMT:warm-mica).** A lens is not limited to query/aggregate/find/relate — when a lens needs something those don't cleanly express (a single-row lookup, a semi-join with a property check, a last-wins dedup), it writes its own scoped SQL directly against `getDb(sessionId)`/`peekDb(sessionId)` + the sqlHydrate helpers (`quoteIdent`, `rawCol`/`fmtCol`, `buildDisplaySelect`, `hydrateNormalizedRow`, `makeFrameLookup`). `fetchAllRowsHydrated` (whole-table fetch+hydrate) is kept only as a documented last resort — every lens site that used to reach for it as a default (leaks/network hint checks, swiftUI's paginateTable, the three Foundation Models drill-down files) was rewritten to a scoped query once dusk-floe's SQL cutover made that possible; see `src/lenses/example.ts` for both patterns (base verb vs. direct SQL) demonstrated side by side.

**Backtraces are stored as queryable frame ROWS, not a JSON blob (PMT:elm-swamp).** `openSessionDb` creates a `backtraces (id, fingerprint UNIQUE)` dedup table + a `frames (backtrace_id, frame_index, name, binary, binary_path, addr)` table (one row per frame, leaf-first; indexed on `backtrace_id` and `name`). So "which stacks contain function X" is a real SQL query, `call_tree` folds from frame rows, and there's no opaque blob anywhere — matching the feature's queryable-data thesis. Frames stay deduped (the `backtraces` fingerprint), just as rows.

**Nested fields are addressable by dot-path, with ref-identical duplicates collapsed to one canonical path (PMT:bare-shoal).** PMT:tall-bench promoted nested compound values to physical `mnemonic__child__grandchild` columns; `bare-shoal` lets a verb reference them as `thread.process.pid` — resolved via `engine/fieldRef.ts`'s `FieldResolver`, built per verb-call after ingestion from two metadata tables `openSessionDb` creates: `promoted_column (table_name, base_column, dotpath)` (every DSL-usable nested SCALAR leaf) and `column_identity (table_name, base_column, canonical_column)` (the collapse map). The physical naming makes resolution mostly a separator swap (`a.b.c` → base `a__b__c`, and `sqlHydrate`'s `fmtCol`/`rawCol` append as before), so `FieldResolver`'s real jobs are validation (an unknown path errors with the valid ones listed) and canonicalization. The collapse is a RECORDED FACT from ingestion, not a re-inference: `SqliteTableWriter`'s `ColumnIdentityTracker` observes that a `<x ref="N"/>` resolves to the SAME Cell OBJECT as the `<x id="N">` it points at (per-node RefCache), so two columns landing on one object in a row are provably ref-shared — collapsed only when that holds in every row where both are present. Canonical = shortest path (a top-level column, seg-count 1, always wins), so an agent is offered exactly ONE name per distinct value (thread-info's `pid`, `process.pid`, `thread.process.pid`, `name.thread.process.pid` are all the same ref → only top-level `pid` is surfaced). Dot-paths address scalar leaves only (a compound intermediate's error guides to its children); top-level mnemonics resolve exactly as before, so this is purely additive. `describe_schema.nestedFields` lists the canonical nested paths, but only once the table is ingested (the promoted columns don't exist until then) — describe stays a cheap metadata-only call and does NOT force an ingest; the fields appear after the first real query, and an unknown-path error lists them in the meantime.
