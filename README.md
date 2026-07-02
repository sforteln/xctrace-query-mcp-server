# instruments-mcp-server
A headless [MCP](https://modelcontextprotocol.io) server that lets an AI navigate Xcode **Instruments `.trace`** files — Time Profiler, Allocations, Leaks, Network, Hangs & Hitches, Core Data / SwiftData, Swift Concurrency, Foundation Models, and more — without dumping raw `xctrace` XML into the model's context.

Raw `xctrace` output is ~95% noise (XML envelope, ref-id indirection, triplicated columns). A real profiling trace won't fit in any model's context window. This server turns it into ~200 tokens of navigable summary with drill-down — for **any** instrument type, not just the ones it was written for.

## How it works
Every Instruments trace has the same shape underneath: `run[] → instrument[] → schema/table[] → row[]` with typed columns that almost always fall into a small set of roles (time, duration/weight, backtrace, thread/process, label). The server introspects each schema at runtime, classifies its columns into these roles, and exposes a handful of schema-agnostic verbs (`query`, `aggregate`, `call_tree`, `find`) that work on **any** instrument — including ones added in future Xcode versions — with zero per-instrument code. Optional per-instrument "lenses" add ergonomic shortcuts on top.

## Requirements
- **Node.js ≥ 22**
- **Xcode** installed (the server shells out to `xcrun xctrace` to export trace data). Xcode is a runtime CLI dependency only — not the build environment.

## Memory

`.trace` files are archives of very large XML tables — a single schema's export can be hundreds of megabytes to gigabytes of XML, and the server parses each table's rows fully into memory (cached for the life of the session so it isn't re-parsed on every call). Node's default heap ceiling (~4 GB on most systems) isn't always enough for one of these tables on a busy or long recording, and running out crashes the whole process — not just the one call that tripped it.

To avoid that, the server re-execs itself once at startup with a larger heap (`--max-old-space-size=8192` by default) if the launch command didn't already request one, so no launcher config (Xcode's MCP registration, `claude mcp add`, etc.) needs to know to pass this flag itself. You'll see two `node` processes for one server as a result — a lightweight parent that just waits, and the actual server running as its child with the enlarged heap.

Override it if needed:
- Set `INSTRUMENTS_MCP_MAX_HEAP_MB=<value>` to change the default the server re-execs with.
- Or pass `--max-old-space-size=<value>` yourself in the launch command — the server detects it's already set and skips the re-exec, respecting your value instead.

This raises the ceiling; it doesn't remove the underlying cost of holding a fully-parsed large table in memory. For an especially large or long recording, prefer narrower queries (a specific `run`, a `timeRange` where the tool supports one) over describing or aggregating an entire huge schema at once.

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
        Opened. 1 run, recorded 14 seconds ago. suggestedStart: query potential-hangs
        sorted by duration — let me look at the worst hangs first.

        [calls query on potential-hangs, sorted by duration desc]
        Found 3 hangs. Longest: 4.2 s on the main thread, hang-type "main-thread".
        The other two are 800 ms and 310 ms, also main-thread.

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

AI:     [calls start_recording, type "foundation-models", attach to MyApp process]
        Recording started. Interact with the AI feature in your app, then tell me
        when to stop.

User:   Done. I triggered the search feature a few times.

AI:     [calls stop_recording]
        Trace saved. Opening it now.

        [calls open_trace]
        1 run. suggestedStart: list_fm_requests — let me pull the inference calls.

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
The server always returns a `suggestedStart` in the `open_trace` response  a pre-filled tool call that gets you to the key data in one step for the most common instruments. If you want to explore a different angle, `list_instruments` shows every schema with row counts and lets you navigate from scratch.

## Instrument your app with signposts

Points of Interest (`os_signpost`) is one of the highest-value instruments here, but only if your app actually calls it. Without signposts, a hang or CPU trace shows you *that* something was slow with a system-level backtrace — with signposts around your own operations (a screen load, a sync, a specific business-logic path), it shows you *which named operation* was running, in your own vocabulary, no backtrace-reading required.

Points of Interest is bundled for free in most templates (Time Profiler, SwiftUI, Swift Concurrency, Allocations, Leaks, Network, CPU Counters, Processor Trace all include it automatically — `start_recording`'s response tells you when it isn't). For the templates that don't bundle it (Hangs, Animation Hitches, Core Data, Foundation Models, App Launch), pass `instruments: ["Points of Interest"]` explicitly.

Once you have both, use `correlate()` — signposts show up as `os-signpost` (raw begin/end/event signposts), `OSSignpostIntervals` (paired begin→end durations), and `PointsOfInterestEvents` (discrete events). Correlating one of these against whatever you're actually investigating (a hang interval, a CPU sample, a SwiftData fetch) answers "which of my named operations was active when this happened" directly, instead of inferring it from timestamps by hand.

## If the AI seems stuck
These prompts reliably get things moving again:
- **"What does suggestedStart say?"** — The `open_trace` response includes a ready-to-run first call. Ask the AI to read it and follow it.
- **"List all instruments in this trace."** — `list_instruments` shows every schema with its row count and the AI can pick the most relevant one.
- **"Describe the schema for [schema name] before you query it."** — `describe_schema` returns each column's role (time, weight, backtrace, etc.) so the AI can form the right query.
- **"I want to look at run 2, not the most recent run."** — The AI defaults to the most recent run; remind it that `open_trace` returned all run numbers and it can pass a different one.
- **"Use aggregate to find the top 10 by [metric]."** — When the AI is fetching raw rows without summarising, pushing it toward `aggregate` usually surfaces the signal faster.

## Supported instruments

The server emits a `versionWarning` in `open_trace` when it encounters an Xcode version it hasn't seen before — that's the signal to add support (see below).

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

## Adding support for a new Xcode version
When you see a `versionWarning` in `open_trace`, it means the server hasn't seen your Xcode version before and is falling back to the closest known rules. To add full support:
1. **Checkout the repo and create a branch** — `git checkout -b adding-compatibility-<version>-AllSchemas`
2. **Record a trace** with each instrument type using your Xcode version
3. **Start a Claude session** in the repo directory and give it the trace files. Say: *"Read `Update_for_your_version_and_submit_a_PR.md` and follow Scenario A to add Xcode `<version>` support using the trace`<filename>`."*
4. **Review the PR** the AI creates — check that no fixture contains sensitive content (real user prompts, real IP addresses, real process names)
5. **Open the PR** against this repo
The full step-by-step is in [`Update_for_your_version_and_submit_a_PR.md`](./Update_for_your_version_and_submit_a_PR.md).

## Adding a new instrument
Two PRs in order. The AI does the mechanical work — your job is to record the trace, give the AI the right prompt, and review what it produces.

### PR 1 — Compatibility

1. **Record a trace** with the new instrument in Xcode Instruments
2. **Start a Claude session** in the repo directory, attach the trace file, and say:
   *"Read `Update_for_your_version_and_submit_a_PR.md` and follow Scenario B to add `<InstrumentName>` support using `<trace-file>`."*
3. **Review the fixture** the AI produces — check that it contains no sensitive content (real process names, IP addresses, private class names from your app). The AI will flag anything it's unsure about.
4. **Open the PR**

### PR 2 — Curated lens (optional)

A lens adds a `quickStart` shortcut so `open_trace` immediately suggests the right first call. Merge PR 1 first, then:

1. **Start a Claude session** in the repo directory and say:
   *"Read `Update_for_your_version_and_submit_a_PR.md` and follow Scenario C PR 2 to add a curated lens for `<InstrumentName>`."*
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

## License

MIT
