# instruments-mcp-server
A headless [MCP](https://modelcontextprotocol.io) server that lets an AI navigate Xcode **Instruments `.trace`** files — Time Profiler, Allocations, Leaks, Network, Hangs & Hitches, Core Data / SwiftData, Swift Concurrency, Foundation Models, and more — without dumping raw `xctrace` XML into the model's context.

Raw `xctrace` output is ~95% noise (XML envelope, ref-id indirection, triplicated columns). A real profiling trace won't fit in any model's context window. This server turns it into ~200 tokens of navigable summary with drill-down — for **any** instrument type, not just the ones it was written for.

## How it works
Every Instruments trace has the same shape underneath: `run[] → instrument[] → schema/table[] → row[]` with typed columns that almost always fall into a small set of roles (time, duration/weight, backtrace, thread/process, label). The server introspects each schema at runtime, classifies its columns into these roles, and exposes a handful of schema-agnostic verbs that work on **any** instrument — including ones added in future Xcode versions — with zero per-instrument code:
- `query`/`find`/`get_row` — filtered/sorted rows, richer predicates (regex, contains, ranges), and full single-row detail including resolved backtraces
- `aggregate` — "top N by weight" grouped by any column(s), including percentile ops (p50/p90/p95/p99) for a real distribution instead of just min/max/sum, and a `having` filter to isolate storms/hotspots (many occurrences), not just the single heaviest one
- `call_tree` — folded/aggregated call stacks for sample-based instruments
- `relate`/`correlate` — join two schemas on shared time windows or equality keys to answer causality ("does this interval contain that event"), leaks ("was this allocation ever freed"), and idle/GPU-bound-window questions over the FULL table, not a sample
- `timeline` — merge several schemas into one time-ordered, origin-tagged stream — the exploratory complement to `relate`, for "what actually happened, in order, across subsystems" before you have a specific hypothesis to test

Every one of these runs as a real SQL query against an on-disk SQLite database the trace is streamed into on first touch, not a hand-rolled scan over rows held in memory — see [Memory](#memory) below. Optional per-instrument "lenses" add ergonomic shortcuts on top of the core verbs (e.g. `list_fm_requests` for Foundation Models), and every response's `nextActions` suggests the next call — including, when a lens recognises the trace type, one entry flagged `recommended: true`.

## Requirements
- **Node.js ≥ 22**
- **Xcode** installed (the server shells out to `xcrun xctrace` to export trace data). Xcode is a runtime CLI dependency only — not the build environment.

## Memory

`.trace` files are archives of very large XML tables — a single schema's export can be hundreds of megabytes to gigabytes of XML. Rows are streamed straight from the XML export into an on-disk SQLite database, not accumulated in a JS array — every verb (`query`, `aggregate`, `find`, `get_row`, `call_tree`, `relate`/`correlate`, `timeline`) reads back out via a real SQL statement instead of scanning an in-memory table. Memory use during both ingestion and every later read is bounded by result size, not by how big the underlying table is — a 275,000-row table and a 5-row table cost the same to *query*, and ingesting either one holds only a bounded batch in memory at a time, not the whole table. A small backstop still watches heap usage during ingestion as cheap insurance against a handful of in-memory caches (backtrace/frame lookups) that don't scale with table size, but it's no longer the primary defense the way it was before the SQLite rewrite.

Each trace's ingested data is also **persisted to disk right next to the `.trace` file itself** (same folder, same name, `.db` extension) — not deleted when you close the session. Reopening the same trace later, even in a brand-new server process, reuses the already-ingested tables instead of re-exporting and re-parsing them from scratch. If the trace's own folder isn't writable, the cache falls back to a shared directory instead (configurable via the `set_cache_dir` tool). A `.trace` file that gets re-recorded or replaced at the same path is detected automatically (via its modification time) and re-ingested rather than silently served stale data.

The server also re-execs itself once at startup with a larger heap (`--max-old-space-size=8192` by default) if the launch command didn't already request one, so no launcher config (Xcode's MCP registration, `claude mcp add`, etc.) needs to know to pass this flag itself. You'll see two `node` processes for one server as a result — a lightweight parent that just waits, and the actual server running as its child with the enlarged heap.

Override it if needed:
- Set `INSTRUMENTS_MCP_MAX_HEAP_MB=<value>` to change the default the server re-execs with.
- Or pass `--max-old-space-size=<value>` yourself in the launch command — the server detects it's already set and skips the re-exec, respecting your value instead.

## Install
### From source (until the package is published on npm)

```bash
git clone https://github.com/your-org/instruments-mcp-server
cd instruments-mcp-server
npm install
npm run build
```

**Claude Code:**
```bash
claude mcp add instruments-mcp-server -- node /absolute/path/to/instruments-mcp-server/dist/index.js
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "instruments-mcp-server": {
      "command": "node",
      "args": ["/absolute/path/to/instruments-mcp-server/dist/index.js"]
    }
  }
}
```

**Xcode's Claude agent** — a separate install from the CLI and Desktop app. Edit (or create) `~/Library/Developer/Xcode/CodingAssistant/ClaudeAgentConfig/.claude.json`. Use the **full absolute path** to the node binary — Xcode's minimal `PATH` won't find it otherwise:
```json
{
  "mcpServers": {
    "instruments-mcp-server": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/absolute/path/to/instruments-mcp-server/dist/index.js"]
    }
  }
}
```
After editing, start a **new Claude conversation** in the Xcode panel — the config is read once at session start. Run `/mcp` to confirm the server is connected. See [`installing-mcp-server-in-xcode.md`](./installing-mcp-server-in-xcode.md) for troubleshooting.

### Once published on npm

```bash
claude mcp add instruments-mcp-server -- npx instruments-mcp-server@latest
```


## Example conversations
### Opening an existing trace — Hangs instrument

```
User:   I recorded a Hangs trace of my app — it was freezing on the main thread.
        The file is at ~/Documents/traces/MyApp-Hangs.trace

AI:     [calls open_trace]
        Opened. 1 run, recorded 14 seconds ago. nextActions has one entry flagged
        recommended: aggregate potential-hangs by hang-type — let me see what kind
        of hang dominates first, then drill into the individual ones.

        [calls the recommended aggregate, then query on potential-hangs sorted by duration desc]
        Found 3 hangs, all main-thread. Longest: 4.2 s. The other two are
        800 ms and 310 ms, also main-thread.

        [calls get_row on the 4.2s hang]
        Backtrace points to -[MyViewController viewDidAppear:] → a synchronous
        URLSession.dataTask call blocking the main thread. That's your freeze.

User:   Can you check if the shorter hangs are in the same place?

AI:     [calls find on potential-hangs with duration filter]
        Yes — all three have the same URLSession call in the backtrace. Looks like
        the same root cause at different trigger points.
```

### Recording live then analysing — Foundation Models instrument

```
User:   I want to see what inference calls my app is making. It's already running.

AI:     [calls start_recording, template "Foundation Models", attach to MyApp process]
        Recording started. Interact with the AI feature in your app, then tell me
        when to stop.

User:   Done. I triggered the search feature a few times.

AI:     [calls stop_recording]
        Trace saved. Opening it now.

        [calls open_trace]
        1 run. nextActions has one entry flagged recommended: list_fm_requests —
        let me pull the inference calls.

        [calls list_fm_requests, limit 50]
        12 requests. Most complete in 200–400 ms. Two stand out: requests 7 and 11
        each took over 3 seconds. All are Prompt + Resolve pairs from the "search"
        agent.

User:   Why are 7 and 11 slow?

AI:     [calls find_fm_requests, emptyContext true]
        Requests 7 and 11 both have emptyContext — no help content was retrieved
        before the model call. The model is answering from scratch instead of using
        your indexed content, which explains the extra latency and likely the lower
        quality too.

        [calls get_fm_request, rowIndex for request 7]
        Confirmed: referencedSections is empty. The search query that triggered this
        request was "bluetooth settings" — worth checking whether that term is covered
        in your indexed content.
```
---
For the most common instruments, `open_trace`'s `nextActions` includes one entry flagged `recommended: true` — a pre-filled tool call that gets you to the key data in one step. The rest of `nextActions` are plain, unranked alternatives — if you want to explore a different angle, `list_instruments` shows every schema with row counts and lets you navigate from scratch.

## Want to test the relative health of your app?

You don't need a known bug to get value out of this — pick a category of concern and let the AI do the rest:

```
User:   I want to check my app's memory health.

AI:     [reads your codebase, finds a real, specific flow likely to exercise it —
        e.g. a screen that repeatedly allocates images, or a list that inserts/
        removes rows — not a generic "click around the app"]
        To exercise memory allocation patterns, do this: open the photo import
        screen and import/remove the same 10 photos five times in a row.
        Starting a launch-mode recording now — launch mode is required here so
        allocations from before the recording started aren't invisible.

        [calls start_recording, template: ["Allocations", "Leaks"], launch: <your app path>]
        Recording started — go ahead and run through that flow.

User:   Done.

AI:     [stops, analyzes, reports a verdict — either a real leak with a
        resolved backtrace pointing at the responsible allocation site, or
        "no app-owned leaks found" if the flow is clean]
```

The same pattern works for any category — the AI picks the `template` (and composes a second whole template when the question spans two systems, e.g. `template: ["Data Persistence", "SwiftUI"]` to attribute fetches to the UI event that triggered them) and finds a concrete exercise from your actual code, not a canned script:

| You're worried about... | AI reaches for... |
|---|---|
| Memory leaks / unbounded growth | `template: ["Allocations", "Leaks"]`, launch mode (attach can't symbolicate objects already live before it attached) |
| UI hangs / stutters / jank | `template: "Time Profiler"` (bundles Hangs + Points of Interest + Thermal State for free) or `template: "Animation Hitches"` for animation-specific frame drops |
| Main-actor contention / async task pileup | `template: "Swift Concurrency"` |
| Excessive Core Data / SwiftData fetches | `template: "Data Persistence"`, composed as `template: ["Data Persistence", "SwiftUI"]` (Data Persistence first) if you want fetches attributed to the UI event that caused them |
| Network inefficiency (redundant requests, no connection reuse) | `template: "Network"` |
| CPU/thermal efficiency under sustained load | `template: "Time Profiler"` (Thermal State is bundled in — correlate a hot thermal interval against the CPU samples to see what was driving it) |

**Why composing two templates matters more than it sounds like it should:** the value isn't "twice the data" — it's turning a causal *guess* into a causal *proof*. Two separate recordings can never be correlated after the fact: each has its own clock with no shared reference point, so comparing them means eyeballing rough timestamp alignment and inferring "these probably happened together." Recording both schemas in the *same* session on the *same* clock (`template: ["Data Persistence", "SwiftUI"]`, say) turns that into a direct, provable join instead — exact interval containment, not coincidence. This is easy to miss even with profiling experience, since doing it by hand means deliberately setting up a combined recording *before* you know you'll need the correlation, which is exactly the kind of thing worth just describing to the AI and letting it decide.

Whichever category you pick, if your app already calls `os_signpost` around its own operations, that's not a separate concern — it's a force multiplier for all of them. A Time Profiler sample says *what code* ran; a signpost says *which of your own operations* was in flight at that moment. Correlating the two turns "the CPU was busy for 400ms" into "the CPU was busy for 400ms during your `loadFeed` operation" — see [Instrument your app with signposts](#instrument-your-app-with-signposts) below.

This is a genuinely validated workflow, not a hopeful one: it's exactly what happened when a fresh Claude Code instance was given only *"I saw a stutter in PromptManager's UI, capture a trace and see what's happening"* — no mention of this tool, no prior context — and it reached a specific, code-level root cause end-to-end unaided. You don't need to know which instrument to reach for or how profiling works — describe what you're seeing (or what you want to check), and the AI handles the rest.

## Instrument your app with signposts

Points of Interest (`os_signpost`) is one of the highest-value instruments here, but only if your app actually calls it. Without signposts, a hang or CPU trace shows you *that* something was slow with a system-level backtrace — with signposts around your own operations (a screen load, a sync, a specific business-logic path), it shows you *which named operation* was running, in your own vocabulary, no backtrace-reading required.

Whether a template gives you the full Points of Interest instrument varies more than you'd expect — verified live against real recordings, not assumed. Time Profiler, Swift Concurrency, Network, Hangs (CPU Profiler), Allocations, Leaks, Animation Hitches, and CPU Counters all include the full instrument automatically (`os-signpost`, `PointsOfInterestEvents`, and `OSSignpostIntervals` all present). Core Data and Foundation Models include only a bare `os-signpost` schema — present, but missing the two more useful structured views — so composing `instruments: ["Points of Interest"]` explicitly is still worth doing there. SwiftUI, App Launch, and Processor Trace include none of it at all; pass `instruments: ["Points of Interest"]` explicitly for these too. `start_recording`'s response tells you what actually got composed either way.

Once you have both, use `correlate()` — signposts show up as `os-signpost` (raw begin/end/event signposts), `OSSignpostIntervals` (paired begin→end durations), and `PointsOfInterestEvents` (discrete events). Correlating one of these against whatever you're actually investigating (a hang interval, a CPU sample, a SwiftData fetch) answers "which of my named operations was active when this happened" directly, instead of inferring it from timestamps by hand.

## If the AI seems stuck
These prompts reliably get things moving again:
- **"Which nextAction is recommended?"** — `open_trace`'s response includes a ready-to-run first call flagged `recommended: true` when a lens recognises the trace type. Ask the AI to read it and follow it.
- **"List all instruments in this trace."** — `list_instruments` shows every schema with its row count and the AI can pick the most relevant one.
- **"Describe the schema for [schema name] before you query it."** — `describe_schema` returns each column's role (time, weight, backtrace, etc.) so the AI can form the right query.
- **"I want to look at run 2, not the most recent run."** — The AI defaults to the most recent run; remind it that `open_trace` returned all run numbers and it can pass a different one.
- **"Use aggregate to find the top 10 by [metric]."** — When the AI is fetching raw rows without summarising, pushing it toward `aggregate` usually surfaces the signal faster.

## Supported instruments

The server tracks compatibility against one confirmed-working Xcode version at a time. `open_trace` emits a `versionWarning` when the detected Xcode isn't in that confirmed list — that's a signal the project owner hasn't verified this Xcode build yet, not something a PR fixes per-instrument (see [`aidocs/howVersionResolutionWorks.md`](./aidocs/howVersionResolutionWorks.md)).

| Instrument | Xcode 27.0 |
|------------|:----------:|
| Foundation Models | ✅ |
| Hangs | ✅ |
| Animation Hitches | ✅ |
| Network | ✅ |
| Core Data | ✅ |
| Swift Concurrency | ✅ |
| Time Profiler | ✅ |
| Allocations | ✅ |
| Leaks | ✅ |
| SwiftUI | ✅ |

✅ Verified — fixtures exist and the instrument has a curated quickstart shortcut.  
⚠️ Detected — the instrument is recognised but has no verified fixture yet; core navigation verbs still work.

Any instrument not in this table is still navigable via `describe_schema`, `query`, `aggregate`, and `find` — it just won't have a curated shortcut. Open a PR to add verified support (see below).

## Adding a new instrument
Two PRs in order. The AI does the mechanical work — your job is to record the trace, give the AI the right prompt, and review what it produces.

### PR 1 — Compatibility

1. **Record a trace** with the new instrument in Xcode Instruments
2. **Start a Claude session** in the repo directory, attach the trace file, and say:
   *"Read `Update_for_your_version_and_submit_a_PR.md` and follow Scenario A to add `<InstrumentName>` support using `<trace-file>`."*
3. **Review the fixture** the AI produces — check that it contains no sensitive content (real process names, IP addresses, private class names from your app). The AI will flag anything it's unsure about.
4. **Open the PR**

### PR 2 — Curated lens (optional)

A lens adds a `quickStart` shortcut so `open_trace` immediately suggests the right first call. Merge PR 1 first, then:

1. **Start a Claude session** in the repo directory and say:
   *"Read `Update_for_your_version_and_submit_a_PR.md` and follow Scenario B PR 2 to add a curated lens for `<InstrumentName>`."*
2. **Answer the AI's questions** — it will ask what the instrument measures and what a problematic result looks like. You recorded the trace, so you know the domain.
3. **Review the lens** — confirm the `quickStart` call it chose actually gets to the useful data quickly.
4. **Open the PR**

See [`Update_for_your_version_and_submit_a_PR.md`](./Update_for_your_version_and_submit_a_PR.md) for the full workflow the AI follows, the PR checklist, and privacy review guidelines.

## Develop

```bash
npm install
npm run build     # tsc → dist/
npm test          # run all tests
npm test -- -u    # update snapshots after parser changes
npm run watch     # incremental rebuilds
```

To enable session logging (useful for debugging which tools the agent selects):
```bash
claude mcp add instruments-mcp-server -- node /path/to/dist/index.js --log
# Logs appear in ~/Library/Logs/instruments-mcp-server/session-<timestamp>.jsonl
```

If a call seems to be taking far longer than expected, ask the AI to call `server_info` — Node doesn't hot-reload, so a long-lived server process keeps running whatever code was in memory when it started, even after you rebuild. `server_info` reports the running code's actual on-disk build time and process start time so you can tell whether it predates a fix you just shipped (and needs restarting by whatever spawned it) before assuming the fix didn't work.

## License

MIT
