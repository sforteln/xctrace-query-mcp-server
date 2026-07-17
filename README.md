# xctrace-query-mcp-server
A headless [MCP](https://modelcontextprotocol.io) server that lets an AI navigate Xcode Instruments .trace files: Time Profiler, Allocations, Leaks, Network, Hangs & Hitches, Core Data / SwiftData, Swift Concurrency, Foundation Models, and more- without dumping raw xctrace XML into the model's context.

Raw xctrace output is ~95% noise (XML envelope, ref-id indirection, triplicated columns). A real profiling trace won't fit in any model's context window. This server turns it into ~200 tokens of navigable summary with drill-down; for any instrument type, not just the ones it was written for.

Most of the processing time will be spent exporting data. Exporting the XML from the trace's internal binary structure and streaming the XML can take up to 20 mins for large traces. To help with this, schemas are loaded only when they are used in a query (except for known small schemas, which are loaded immediately in the hope that they will provide clues on how to proceed). To limit the effects of this, try to keep your traces as short as possible. 

## AI
AI was used extensively in writing this app. There is no chance I would have written a Node app to parse GBs of XML into a SQL db on my own. But this app does not contain an AI agent. It is a set of deterministic tools (really, wrappers around SQL) that expose trace data to your AI in a context-friendly way. The reason for the tools and not allowing your AI to write SQL queries to run directly against the db is that I was concerned about the AI writing valid but incorrect SQL, getting zero results (because of a poorly written query), and taking that to mean there were no results. So instead I decided to give it semantic tools to query the data.

## Version Support
This tool was built to support Xcode 27 beta versions, as I needed it to work with Foundation Models. Once the final is out, I'll do a run-through of the traces to see if anything changed. I don't know how much the existing templates and instrument recording have changed since the last full release.  Even for a wrong version, it's likely this tool will still work; you just may not get the full usage of the lens() shortcuts that can help your AI find things faster by using specific SQL queries instead of having to navigate the whole dataset using the base tools.

## How it works

Every Instruments trace has the same shape underneath: run[] → instrument[] → schema/table[] → row[] with typed columns that almost always fall into a small set of roles (time, duration/weight, backtrace, thread/process, label). The server introspects each schema at runtime, classifies its columns into these roles, and exposes a handful of schema-agnostic verbs that work on any instrument, including ones added in future Xcode versions,f with zero per-instrument code:
- `query`/`find`/`get_row`: filtered/sorted rows, richer predicates (regex, contains, ranges), and full single-row detail including resolved backtraces
- `aggregate`: "top N by weight" grouped by any column(s), including percentile ops (p50/p90/p95/p99) for a real distribution instead of just min/max/sum, and a `having` filter to isolate storms/hotspots (many occurrences), not just the single heaviest one
- `call_tree`: folded/aggregated call stacks for sample-based instruments
- `relate`/`correlate`: join two schemas on shared time windows or equality keys to answer causality ("does this interval contain that event"), leaks ("was this allocation ever freed"), and idle/GPU-bound-window questions over the FULL table, not a sample
- `timeline`: merge several schemas into one time-ordered, origin-tagged stream — the exploratory complement to `relate`, for "what actually happened, in order, across subsystems" before you have a specific hypothesis to test

Every one of these runs as a real SQL query against an on-disk SQLite database the trace is streamed into on first touch, not a hand-rolled scan over rows held in memory. Optional per-instrument "lenses" add ergonomic shortcuts on top of the core verbs (e.g. `list_fm_requests` for Foundation Models), and every response's `nextActions` suggests the next call — including, when a lens recognizes the trace type, one entry flagged `recommended: true`.

### More questions
1. `git clone https://github.com/your-org/xctrace-query-mcp-server`
1. `cd xctrace-query-mcp-server`
1. Start a new `claude(or your chosen AI) session`
1. Ask `Read aiDocs/*`
1. Ask `How does the correlate function work?` or `How does the lens for Hangs work?`

## Requirements
- **Node.js ≥ 22**
- **Xcode** installed (the server shells out to `xcrun xctrace` to export trace data). Xcode is a runtime CLI dependency only — not the build environment.

## Trace Data

A `.trace` is a folder (a bundle) holding a mixture of different file types, not a single readable file — most of the actual data sits in binary blobs that can only be reliably read by first exporting them through `xctrace export` into XML, which is what this server does under the hood. A single schema's export can be hundreds of megabytes to gigabytes of XML. Rows are streamed straight from that XML export into an on-disk SQLite database, not accumulated in a JS array — every verb (`query`, `aggregate`, `find`, `get_row`, `call_tree`, `relate`/`correlate`, `timeline`) reads back out via a real SQL statement instead of scanning an in-memory table. Memory use during both ingestion and every later read is bounded by result size, not by how big the underlying table is — a 275,000-row table and a 5-row table cost the same to *query*, and ingesting either one holds only a bounded batch in memory at a time, not the whole table. A small backstop still watches heap usage during ingestion as cheap insurance against a handful of in-memory caches (backtrace/frame lookups) that don't scale with table size.

Each trace's ingested data is also **persisted to disk right next to the `.trace` file itself** (same folder, same name, `.db` extension) — not deleted when you close the session. Reopening the same trace later, even in a brand-new server process, reuses the already-ingested tables instead of re-exporting and re-parsing them from scratch. If the trace's own folder isn't writable, the cache falls back to a shared directory instead (configurable via the `set_cache_dir` tool). A `.trace` file that gets re-recorded or replaced at the same path is detected automatically (via its modification time) and re-ingested rather than silently served stale data.

The server also re-execs itself once at startup with a larger heap (`--max-old-space-size=8192` by default) if the launch command didn't already request one, so no launcher config (Xcode's MCP registration, `claude mcp add`, etc.) needs to know to pass this flag itself. You'll see two `node` processes for one server as a result — a lightweight parent that just waits, and the actual server running as its child with the enlarged heap.

Override it if needed:
- Set `XCTRACE_QUERY_MCP_MAX_HEAP_MB=<value>` to change the default the server re-execs with.
- Or pass `--max-old-space-size=<value>` yourself in the launch command — the server detects it's already set and skips the re-exec, respecting your value instead.

## Install
### From npm

```bash
claude mcp add xctrace-query-mcp-server -- npx xctrace-query-mcp-server@latest
```

### From source

```bash
git clone https://github.com/your-org/xctrace-query-mcp-server
cd xctrace-query-mcp-server
npm install
npm run build
```

**Claude Code:**
```bash
claude mcp add xctrace-query-mcp-server -- node /absolute/path/to/xctrace-query-mcp-server/dist/index.js
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "xctrace-query-mcp-server": {
      "command": "node",
      "args": ["/absolute/path/to/xctrace-query-mcp-server/dist/index.js"]
    }
  }
}
```

**Xcode's Claude agent** — a separate install from the CLI and Desktop app. Edit (or create) `~/Library/Developer/Xcode/CodingAssistant/ClaudeAgentConfig/.claude.json`. Use the **full absolute path** to the node binary — Xcode's minimal `PATH` won't find it otherwise:
```json
{
  "mcpServers": {
    "xctrace-query-mcp-server": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/absolute/path/to/xctrace-query-mcp-server/dist/index.js"]
    }
  }
}
```
After editing, start a **new Claude conversation** in the Xcode panel — the config is read once at session start. Run `/mcp` to confirm the server is connected. See [`installing-mcp-server-in-xcode.md`](./installing-mcp-server-in-xcode.md) for troubleshooting.



## Example conversations
### Opening an existing Hangs trace

```
User:   I recorded a Hangs trace for my app — it was freezing on the main thread.
        The file is at ~/Documents/traces/MyApp-Hangs.trace

AI:     [calls open_trace]
        Opened. 1 run, recorded 14 seconds ago. nextActions has one entry flagged
        recommended: aggregate potential-hangs by hang-type — let me see what kind
        of hang dominates first, then drill into the individual ones.

        [calls the recommended aggregate, then query on potential-hangs sorted by duration desc]
        Found 3 hangs, all main-thread. Longest: 4.2 s. The other two are
        800 ms and 310 ms, also main-thread.

        [calls get_row on the 4.2s hang]
        Backtrace points to MyView's `onAppear` closure → a synchronous
        URLSession.dataTask call blocking the main thread. That's your freeze.

User:   Can you check if the shorter hangs are in the same place?

AI:     [calls find on potential-hangs with duration filter]
        Yes — all three have the same URLSession call in the backtrace. Looks like
        the same root cause at different trigger points.
```

### Recording Foundation Models instrument live then analyzing

```
User:   I want to see what inference calls my app is making. It's already running; start a trace using the Foundation Model template.

AI:     [calls start_recording, template "Foundation Models", attach to MyApp process]
        Recording started. Interact with the AI feature in your app, then tell me
        when to stop.

User:   Done. I triggered the search feature a few times.

AI:     [calls stop_recording — auto-opens the trace, sessionId ready]
        [calls list_instruments]
        nextActions has one entry flagged recommended: list_fm_requests — let me
        pull the inference calls.

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

### Capturing a hang as it happens

```
User:   I'm seeing a hang on the Feed screen — it freezes for a second or two,
        but I can't tell what's causing it.

AI:     I'll use template: "Time Profiler" — it bundles Hangs, Points of Interest,
        and Thermal State for free, so whether this is a straightforward CPU
        stall or something more like resource contention, it's covered either way.

        Navigate to right before you'd normally hit the freeze — one screen back
        from Feed, not already sitting inside it — then let me know and I'll
        start recording.

User:   Ready.

AI:     [calls start_recording, template: "Time Profiler", attach to MyApp process]
        Recording started. Now reproduce it: open Feed and scroll the way you
        normally would until it freezes. Tell me once it's happened.

User:   Just hit it — froze for a couple of seconds while scrolling. You can stop.

AI:     [calls stop_recording — auto-opens the trace, sessionId ready]
        [calls list_instruments, then the recommended aggregate on potential-hangs]
        One hang, 2.1 s, main thread — matches what you described.

        [calls get_row on the hang, correlates against time-profile for that window]
        Backtrace shows FeedRow's `body` synchronously decoding a full-resolution
        image on the main thread for every row as it scrolls into view. Image
        decoding needs to move off the main thread — ideally decoded once and
        cached, not redone every time the row's body re-evaluates.
```
---
For the most common instruments, `open_trace`'s `nextActions` includes one entry flagged `recommended: true`; a suggested tool call that will hopefully get you to the key data in one step. `stop_recording` auto-opens the trace too, but its own response doesn't compute this yet; call `list_instruments` right after (its `nextActions` carries the same `recommended: true` entry) rather than a separate `open_trace`. The rest of `nextActions` are plain, unranked alternatives. If you want to explore a different angle, `list_instruments` shows every schema with row counts and lets you navigate from scratch.

## Want to test the relative health of your app?

You don't need a known bug to get value out of this:

```
User:   We just added an "add attachments" feature, and I want to make sure we're
        handling images correctly and avoiding memory waste.

AI:     [reads the attachments feature's code — finds where images are picked,
        decoded, and held onto]
        Looking at AttachmentPicker.swift and AttachmentStore.swift: images are
        decoded at full resolution and stay in the view model's array even after
        being removed from the compose screen — that's the part worth checking
        for a leak. I'll use template: ["Allocations", "Leaks"] in launch mode
        (attach can't symbolicate objects already live before it attaches).

        Do this: open the compose screen, attach 5 photos, remove them, and
        repeat that five times in a row.

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
| UI hangs / stutters/jank | `template: "Time Profiler"` (bundles Hangs + Points of Interest + Thermal State for free) or `template: "Animation Hitches"` for animation-specific frame drops |
| Main-actor contention / async task pileup | `template: "Swift Concurrency"` |
| Excessive Core Data / SwiftData fetches | `template: "Data Persistence"`, composed as `template: ["Data Persistence", "SwiftUI"]` (Data Persistence first) if you want fetches attributed to the UI event that caused them |
| Network inefficiency (redundant requests, no connection reuse) | `template: "Network"` |
| CPU/thermal efficiency under sustained load | `template: "Time Profiler"` (Thermal State is bundled in — correlate a hot thermal interval against the CPU samples to see what was driving it) |

**Why composing two templates matters more than it sounds like it should:** the value isn't "twice the data" — it's turning a causal *guess* into a causal *proof*. Two separate recordings can never be correlated after the fact: each has its own clock with no shared reference point, so comparing them means eyeballing rough timestamp alignment and inferring "these probably happened together." Recording both schemas in the *same* session on the *same* clock (for example, `template: ["Data Persistence", "SwiftUI"]`) turns that into a direct, provable join instead — exact interval containment, not coincidence. This is easy to miss even with profiling experience, since doing it by hand means deliberately setting up a combined recording *before* you know you'll need the correlation, which is exactly the kind of thing worth just describing to the AI and letting it decide.

Whichever category you pick, if your app already calls `os_signpost` around its own operations, that's not a separate concern; it's a force multiplier for all of them. A Time Profiler sample says *what code* ran; a signpost says *which of your own operations* was in flight at that moment. Correlating the two turns "the CPU was busy for 400ms" into "the CPU was busy for 400ms during your `loadFeed` operation" — see [Instrument your app with signposts](#instrument-your-app-with-signposts) below.


## Instrument your app with signposts

Points of Interest (`os_signpost`) is one of the highest-value instruments here, but only if your app actually calls it. Without signposts, a hang or CPU trace shows you *that* something was slow with a system-level backtrace — with signposts around your own operations (a screen load, a sync, a specific business-logic path), it shows you *which named operation* was running, in your own vocabulary, no backtrace-reading required.

## Supported instruments

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

Any instrument not in this table is still navigable via `describe_schema`, `query`, `aggregate`, and `find` — it just won't have a curated shortcut.

## Adding a new instrument
Two PRs in order. The AI does the mechanical work — your job is to record the trace, give the AI the right prompt, and review what it produces.

### PR 1 — Compatibility

1. **Record a trace** with the new instrument in Xcode Instruments or via the AI integration.
2. **Start an AI session** in the trace-query repo directory and s ay:
   *"Read `Update_for_your_version_and_submit_a_PR.md` and follow Scenario A to add `<InstrumentName>` support using `<trace-file>`."*
3. **Review the fixture** the AI produces — check that it contains no sensitive content (real process names, IP addresses, private class names from your app). The AI will flag anything it's unsure about.
4. **Open the PR**

### PR 2 — Curated lens (optional)

A lens adds a `quickStart` shortcut so `open_trace` immediately suggests a likely useful first call — a best guess, not a guarantee it's the right one for every trace. Merge PR 1 first, then:

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
claude mcp add xctrace-query-mcp-server -- node /path/to/dist/index.js --log
# Logs appear in ~/Library/Logs/xctrace-query-mcp-server/session-<timestamp>.jsonl
```

## License

MIT
---
Not affiliated with or endorsed by Apple Inc. "Xcode," "Instruments," and "xctrace" are trademarks of Apple Inc.; this project just talks to their CLI output.
