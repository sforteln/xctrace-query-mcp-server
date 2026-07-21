# xctrace-query-mcp-server
### What happens if you give your AI access to your app's source code and Instruments?

This is an [MCP](https://modelcontextprotocol.io) server that lets an AI navigate Xcode Instruments .trace files: Time Profiler, Allocations, Leaks, Network, Hangs & Hitches, Core Data / SwiftData, Swift Concurrency, Foundation Models, and more without dumping raw xctrace XML into the AI's context.

Raw xctrace output is ~95% noise (XML envelope, ref-id indirection, includes both raw and display values). A real profiling trace won't fit in any model's context window. This server turns it into ~200 tokens of navigable summary with drill-down; for any instrument type, not just the ones it was written for.

Most of the processing time will be spent exporting data. Exporting the XML from the trace's internal binary structure and streaming the XML **can take up to 20 mins for large traces**. To help with this, schemas are loaded only when they are used in a query (except for known small schemas, which are loaded immediately in the hope that they will provide clues on how to proceed). To limit the effects of this, try to keep your traces as short as possible. 

## AI
AI was used extensively in writing this app. There is no chance I would have written a Node app to parse GBs of XML into a SQL db on my own. But this app does not contain an AI agent. It is a set of deterministic tools (really, wrappers around SQL) that expose trace data to your AI in a context-friendly way. The reason the tools don't allow your AI to write SQL queries to run directly against the db is that I was concerned about the AI writing valid but incorrect SQL, getting zero results (because of a poorly written query), and taking that to mean there were no results. So instead I decided to give it semantic tools to query the data.

## Version Support
This tool was built using Xcode 27 beta versions, as I needed it to work with the Foundation Model instrument. Once the final is out, I'll do a run-through of the traces to see if anything changed. I have not tested it with Xcode 26 and so don't know if the trace format for older Instruments has changed.  Even for a wrong version, it's likely this tool will still work; you just may not get the full usage of the lens() shortcuts that can help your AI find things faster by using specific SQL queries instead of having to navigate the whole dataset using the base tools.

## Example conversation
**User:** I want to look for SwiftUI re-layout issues in the sidebar of PromptManager,
which is running from this Xcode instance.

**AI:** I'll start by confirming the running PromptManager process, then record with SwiftUI instruments focused on layout.

>[Tool Call : List Devices]

**AI:** Good, targeting the Mac. Let me check what processes are running to confirm PromptManager is live before attaching.

>[Tool Call : List Processes]

**AI:** PromptManager is running at PID 16617. Starting a 30-second recording using the SwiftUI template (which bundles layout tracing, view body update tracking, Time Profiler, and hang detection) plus PromptManager's custom signpost subsystems. While it records, please navigate around the sidebar — scroll, expand/collapse items, switch projects — to drive any layout churn.

>[Tool Call : Start Recording]

**AI:** Recording is live. Please navigate the sidebar now — scroll, switch projects/features, expand items — for about 25 seconds to capture representative layout activity. I'll stop it when you're ready, or it auto-stops at 30s.

> [User drives App]

**User:** Stop

>[Tool Call : Stop Recording]

**AI:** Recording stopped. Strong early signal: 250 hitches captured, 237 of them app-caused and clustering in the 8-16ms near-miss band — the closest hits 16.7ms, right at the 60Hz dropped-frame cutoff. Let me now dig into the SwiftUI-specific data. I'll run the hitch query and check available SwiftUI lens tools in parallel.

Good, all tools loaded. Running three queries in parallel now:
1. The worst hitches (app-caused, near-miss band)
2. Which view bodies are consuming the most main-thread time
3. Which layout/env passes are most expensive

>[Tool Call : Find]

>[Tool Call : Aggregate SwiftUI Filtered Updates]

>[Tool Call : Aggregate SwiftUI Filtered Updates]

**AI:** Big picture emerging. Let me call out what I see so far:

* **250 hitches, all app-caused** — worst is 166ms at 4.6s with "Potentially expensive app update(s) + Potentially expensive render". Several 66ms and 50ms hitches throughout.
* **870,795 layout/env update events in ~30s** — roughly 29,000 layout passes per second. That's the smoking gun.
* _LazyLayoutViewCache<LazyVStackLayout> doing **26ms of uncached layout across 172 events is notable** — this is likely the List in your sidebar.

The note tells me view-body identity lives in description, not view-name. Running two more focused queries to find the hot re-evaluating views and layout frequency breakdown:

>[Tool Call : Aggregate SwiftUI Filtered Updates]

>[Tool Call : Aggregate SwiftUI Filtered Updates]

>[Tool Call : Aggregate SwiftUI Layout Env Updates]

**AI:** Excellent data. Clear culprits identified. Let me read the source files to confirm the root cause before presenting findings.

Let me read the rest of SidebarView.swift to see SidebarRow.

>[Reading File : SidebarView.swift]

**AI:** I have everything I need. Let me close the trace and deliver the full findings.

>[Tool Call : Close Trace]

#### Trace findings: SidebarView re-layout issues

**250 hitches, all app-caused.** Worst: **166ms** at 4.6s. Most cluster in the 8–16ms near-miss band — not dropped frames yet at 60Hz, but trending there. **870,795 layout/env update events in ~30 seconds.** That's the smoking gun.

#### Finding 1 — Two dead @Query declarations (High impact)

SidebarView.swift -> lines 89–90:

```swift
@Query private var allFeatures: [Feature]   // DEAD
@Query private var allPrompts: [Prompt]     // DEAD
```
Both are shadowed by local let allFeatures / let allPrompts inside visibleItems — the instance properties are never read. But SwiftData doesn't know that. Every time any Feature or Prompt is written (including MCP tool calls) these queries fire and mark SidebarView.body dirty. The trace shows SidebarView.body ran **27 times in 30 seconds** — this is likely the primary trigger. **Delete both lines.**


#### Finding 2 — SidebarRow holds a binding to shared selection (High impact)

SidebarView.swift -> lines 124–133, 631–632:

Every SidebarRow instance holds @Binding var selection: SidebarSelection?. SwiftUI tracks that binding and re-evaluates every row's body whenever selection changes — a single tap causes all ~40 rows to re-run. The trace confirms this: **1,103 SidebarRow.body calls** in 30 seconds ≈ 40 rows × 27 SidebarView redraws.

Fix: Replace the binding with a value + closure:
```swift
// Before
@Binding var selection: SidebarSelection?
// ...
private var isSelected: Bool { selection == item.selection }
// call site: selection = item.selection

// After (SidebarRow)
let isSelected: Bool
let onSelect: () -> Void

// call site in SidebarView.body
SidebarRow(
    item: item,
    isSelected: selection == item.selection,
    onSelect: { selection = item.selection },
    ...
)
```

Now SidebarRow holds no shared binding — SwiftUI can skip its body if item and isSelected haven't changed.


#### Finding 3 — SidebarRow holds a binding to shared expandedIDs (Medium impact)

SidebarView.swift -> lines 632, 648–652:

Same pattern as selection. All rows hold @Binding var expandedIDs, causing every row to re-evaluate when any expand/collapse happens. But item.isExpanded is already baked into SidebarRowItem — the row only needs to mutate expandedIDs in an action, not read it in body.

Fix:
```swift
// Before
@Binding var expandedIDs: Set<PersistentIdentifier>
// reads item.isExpanded for display, mutates expandedIDs in button action

// After (SidebarRow)
let onToggleExpand: () -> Void   // SidebarView computes the right insert/remove

// call site
SidebarRow(
    item: item,
    onToggleExpand: {
        withAnimation(.easeInOut(duration: 0.15)) {
            if item.isExpanded {
                expandedIDs.remove(item.persistentID)
            } else {
                expandedIDs.insert(item.persistentID)
            }
        }
    },
    ...
)
```

#### Finding 4 — GeometryReader in DropTargetModifier (Medium impact)

SidebarView.swift -> lines 542–547:
``` swift
.background(GeometryReader { geo in
    Color.clear.preference(key: HeightPreferenceKey.self, value: geo.size.height)
})
.onPreferenceChange(HeightPreferenceKey.self) { viewHeight = $0 }
```

This GeometryReader + PreferenceKey combo forces a **double layout pass** on every row — every row reports its height, SwiftUI runs a second layout to apply it. This pattern ran **35,210 times for _PaddingLayout (cached) alone**, contributing heavily to the 870k layout events.

The height is used only to decide if a drop lands above/below the row midpoint. But rows are fixed at 28pt. Fix: Delete the GeometryReader/PreferenceKey entirely and use:
``` swift
@State private var viewHeight: CGFloat = 28  // fixed — all sidebar rows are 28pt
```
---

| Fix | Effort | Expected benefit |
|-----|--------|-----------------|
| Delete 2 unused `@Query` lines | 1 min | Eliminate most `SidebarView.body` re-runs triggered by MCP writes |
| `selection` binding → value+closure | 15 min | Collapse 1,100+ `SidebarRow.body` calls per 30s to ~80 |
| `expandedIDs` binding → closure | 10 min | Same mechanism, removes the expand/collapse churn |
| `GeometryReader` → fixed 28pt | 5 min | Eliminate double layout passes on every row |

Finding 1 is a one-liner and probably the biggest bang — want me to apply any or all of these?

## Getting started
After you have the server installed and available to your AI, I find it helpful to ask your AI `can you see the xctrace-query server`. If I don't do this in a new conversation, the AI seems to get confused when asked to use an MCP server straight away. Almost like even though the MCP server's instructions and tool descriptions are in its context, you still need to prompt it to read them. 

## Requirements
- **Node.js ≥ 22**
- **Xcode** installed (the server shells out to `xcrun xctrace` to export trace data). Xcode is a runtime CLI dependency only — not the build environment.

## Install
### From npm

**Claude Code:**
```bash
claude mcp add xctrace-query-mcp-server -- npx xctrace-query-mcp-server@latest
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "xctrace-query-mcp-server": {
      "command": "npx",
      "args": ["-y", "xctrace-query-mcp-server@latest"]
    }
  }
}
```

**Xcode's Claude agent** — a separate install from the CLI and Desktop app. Edit (or create) `~/Library/Developer/Xcode/CodingAssistant/ClaudeAgentConfig/.claude.json`. Xcode's minimal `PATH` won't resolve bare `npx` — use its **full absolute path** instead:
```bash
which npx   # or, if npx is itself a version-manager shim: readlink -f "$(which npx)"
```
An absolute path to `npx` isn't enough on its own, though: `npx` is itself a script starting with `#!/usr/bin/env node`, so *running* it still requires `node` to be resolvable via `PATH` for that shebang line — and Xcode's spawned subprocess doesn't inherit a `PATH` containing a version-manager-installed `node`'s directory. Without it, the process dies near-instantly before any MCP handshake starts, and Xcode shows a stuck "still connecting" state rather than a clear error. Fix it with an explicit `env.PATH` override that includes `node`'s own directory:
```bash
dirname "$(readlink -f "$(which node)")"   # the directory to prepend to PATH below
```
```json
{
  "mcpServers": {
    "xctrace-query-mcp-server": {
      "command": "/absolute/path/to/npx",
      "args": ["-y", "xctrace-query-mcp-server@latest"],
      "env": {
        "PATH": "/absolute/path/to/node/bin/dir:/usr/bin:/bin:/usr/sbin:/sbin"
      }
    }
  }
}
```
After editing, start a **new Claude conversation** in the Xcode panel — the config is read once at session start. Run `/mcp` to confirm the server is connected.

## How it works
Every Instruments trace has the same shape underneath: run[] → instrument[] → schema/table[] → row[] with typed columns that almost always fall into a small set of roles (time, duration/weight, backtrace, thread/process, label). The server introspects each schema at runtime, classifies its columns into these roles, and exposes a handful of schema-agnostic verbs that work on any instrument, including ones added in future Xcode versions,f with zero per-instrument code:
- `query`/`find`/`get_row`: filtered/sorted rows, richer predicates (regex, contains, ranges), and full single-row detail including resolved backtraces
- `aggregate`: "top N by weight" grouped by any column(s), including percentile ops (p50/p90/p95/p99) for a real distribution instead of just min/max/sum, and a `having` filter to isolate storms/hotspots (many occurrences), not just the single heaviest one
- `call_tree`: folded/aggregated call stacks for sample-based instruments
- `relate`/`correlate`: join two schemas on shared time windows or equality keys to answer causality ("does this interval contain that event"), leaks ("was this allocation ever freed"), and idle/GPU-bound-window questions over the FULL table, not a sample
- `timeline`: merge several schemas into one time-ordered, origin-tagged stream — the exploratory complement to `relate`, for "what actually happened, in order, across subsystems" before you have a specific hypothesis to test

Every one of these runs as a real SQL query against an on-disk SQLite database the trace is streamed into on first touch, not a hand-rolled scan over rows held in memory. Optional per-instrument "lenses" add ergonomic shortcuts on top of the core verbs (e.g. `list_fm_requests` for Foundation Models), and every response's `nextActions` suggests the next call. 

### More questions
Just ask your AI directly — tool descriptions and lens hints are self-documenting by design, so questions like "How does the `correlate` function work?" or "How does the lens for Hangs work?" usually don't need anything beyond the installed server itself.

For implementation-level detail beyond that, the annotated internals live in [`aidocs/`](https://github.com/sforteln/xctrace-query-mcp-server/tree/main/aidocs). Clone the repo and point your AI at that directory for a deeper dive:
1. `git clone https://github.com/sforteln/xctrace-query-mcp-server`
1. `cd xctrace-query-mcp-server`
1. Start a new `claude` (or your chosen AI) session
1. Ask it to `Read aidocs/*`, then ask your question

## Opening an existing trace
If you have an existing trace or want to create one yourself, you can also ask to open and analyze it.

`Open and analyze the trace /absolute/path/to/trace`

## Using multiple Templates or Instruments
You can also request the recording to use multiple Templates (one of them will be decomposed and added as individual instruments). In some cases, this can allow the AI to draw causal lines. For instance, you could run SwiftUI and CoreData together to see if CoreData activity is caused by SwiftUI relayouts.

## Why composing two templates matters more than it sounds like it should
The value isn't "twice the data" — it's turning a causal *guess* into a causal *proof*. Two separate recordings can never be correlated after the fact: each has its own clock with no shared reference point, so comparing them means eyeballing rough timestamp alignment and inferring "these probably happened together." Recording both schemas in the *same* session on the *same* clock (for example, `template: ["Data Persistence", "SwiftUI"]`) turns that into a direct, provable join instead — exact interval containment, not coincidence. This is easy to miss even with profiling experience, since doing it by hand means deliberately setting up a combined recording *before* you know you'll need the correlation, which is exactly the kind of thing worth just describing to the AI and letting it decide.

If your app already calls `os_signpost` around its own operations, that's not a separate concern; it's a force multiplier for all of them. A Time Profiler sample says *what code* ran; a signpost says *which of your own operations* was in flight at that moment. Correlating the two turns "the CPU was busy for 400ms" into "the CPU was busy for 400ms during your `loadFeed` operation".

## Instrument your app with signposts
Points of Interest (`os_signpost`) is one of the highest-value instruments here, but only if your app actually calls it. Without signposts, a hang or CPU trace shows you *that* something was slow with a system-level backtrace — with signposts around your own operations (a screen load, a sync, a specific business-logic path), it shows you *which named operation* was running, in your own vocabulary, no backtrace-reading required.

## Trace Data
A `.trace` is a folder (a bundle) holding a mixture of different file types, not a single readable file — most of the actual data sits in binary blobs that can only be reliably read by first exporting them through `xctrace export` into XML, which is what this server does under the hood. A single schema's export can be hundreds of megabytes to gigabytes of XML. Rows are streamed straight from that XML export into an on-disk SQLite database, not accumulated in a JS array — every verb (`query`, `aggregate`, `find`, `get_row`, `call_tree`, `relate`/`correlate`, `timeline`) reads back out via a real SQL statement instead of scanning an in-memory table.

Each trace's ingested data is also **persisted to disk right next to the `.trace` file itself** (same folder, same name, `.db` extension) — not deleted when you close the session. Reopening the same trace later, even in a brand-new server process, reuses the already-ingested tables instead of re-exporting and re-parsing them from scratch. If the trace's own folder isn't writable, the cache falls back to a shared directory instead (configurable via the `set_cache_dir` tool). A `.trace` file that is re-recorded or replaced at the same path is detected automatically (via its modification time) and re-ingested, rather than silently serving stale data.

## MCP server heap settings
The server also re-execs itself once at startup with a larger heap (`--max-old-space-size=8192` by default) if the launch command didn't already request one, so no launcher config (Xcode's MCP registration, `claude mcp add`, etc.) needs to know to pass this flag itself. You'll see two `node` processes for one server as a result — a lightweight parent that just waits, and the actual server running as its child with the enlarged heap.

Override it if needed:
- Set `XCTRACE_QUERY_MCP_MAX_HEAP_MB=<value>` to change the default the server re-execs with.
- Or pass `--max-old-space-size=<value>` yourself in the launch command — the server detects it's already set and skips the re-exec, respecting your value instead.

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
