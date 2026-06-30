# instruments-mcp-server

A headless [MCP](https://modelcontextprotocol.io) server that lets an AI navigate Xcode **Instruments `.trace`** files — Time Profiler, Allocations, Leaks, Network, Hangs & Hitches, Core Data / SwiftData, Swift Concurrency, Foundation Models, and more — without dumping raw `xctrace` XML into the model's context.

Raw `xctrace` output is ~95% noise (XML envelope, ref-id indirection, triplicated columns). A real profiling trace won't fit in any model's context window. This server turns it into ~200 tokens of navigable summary with drill-down — for **any** instrument type, not just the ones it was written for.

## How it works

Every Instruments trace has the same shape underneath: `run[] → instrument[] → schema/table[] → row[]` with typed columns that almost always fall into a small set of roles (time, duration/weight, backtrace, thread/process, label). The server introspects each schema at runtime, classifies its columns into these roles, and exposes a handful of schema-agnostic verbs (`query`, `aggregate`, `call_tree`, `find`) that work on **any** instrument — including ones added in future Xcode versions — with zero per-instrument code. Optional per-instrument "lenses" add ergonomic shortcuts on top.

## Requirements

- **Node.js ≥ 22**
- **Xcode** installed (the server shells out to `xcrun xctrace` to export trace data). Xcode is a runtime CLI dependency only — not the build environment.

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

### Once published on npm

```bash
claude mcp add instruments-mcp-server -- npx instruments-mcp-server@latest
```

## Example conversation

This is a typical session profiling a hanging app with the Hangs & Hitches instrument:

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

---

The server always returns a `suggestedStart` in the `open_trace` response — a pre-filled tool call that gets you to the key data in one step for the most common instruments. If you want to explore a different angle, `list_instruments` shows every schema with row counts and lets you navigate from scratch.

## If the AI seems stuck

These prompts reliably get things moving again:

- **"What does suggestedStart say?"** — The `open_trace` response includes a ready-to-run first call. Ask the AI to read it and follow it.
- **"List all instruments in this trace."** — `list_instruments` shows every schema with its row count and the AI can pick the most relevant one.
- **"Describe the schema for [schema name] before you query it."** — `describe_schema` returns each column's role (time, weight, backtrace, etc.) so the AI can form the right query.
- **"I want to look at run 2, not the most recent run."** — The AI defaults to the most recent run; remind it that `open_trace` returned all run numbers and it can pass a different one.
- **"Use aggregate to find the top 10 by [metric]."** — When the AI is fetching raw rows without summarising, pushing it toward `aggregate` usually surfaces the signal faster.

## Supported instruments and schemas

Verified against **Xcode 27.0**. The server emits a `versionWarning` in `open_trace` when it encounters an Xcode version it hasn't seen before — that's the signal to add support (see below).

| Instrument | Schemas |
|------------|---------|
| Foundation Models | `ModelInferenceTable`, `InstructionsTable`, `FMEventTable`, `RequestTable`, `SessionTable`, `ModelLoadingTable`, `ToolTable` |
| Hangs & Hitches | `potential-hangs`, `hitches`, `hang-risks` |
| Network | `NetworkConnectionStats`, `network-connection-update`, `network-connection-detected` |
| Core Data / SwiftData | `core-data-fault`, `core-data-fetch`, `core-data-save`, `core-data-relationship-fault` |
| Swift Concurrency | `SwiftTaskLifetime`, `SwiftTaskStateTable`, `SwiftTasksInfoTable` |
| Time Profiler | `time-sample` |
| Allocations | `Allocations/Allocations-List` |
| Leaks | `Leaks/Leaks` |

Any schema not in this table still works with the universal core verbs (`query`, `aggregate`, `describe_schema`, `find`) — it just won't have a curated lens or a `suggestedStart` shortcut.

## Adding support for a new Xcode version

When you see a `versionWarning` in `open_trace`, it means the server hasn't seen your Xcode version before and is falling back to the closest known rules. To add full support:

1. **Checkout the repo and create a branch** — `git checkout -b adding-compatibility-<version>-AllSchemas`
2. **Record a trace** with each instrument type using your Xcode version
3. **Start a Claude session** in the repo directory and give it the trace files. Say: *"Read `Update_for_your_version_and_submit_a_PR.md` and follow Scenario A to add Xcode `<version>` support using the traces in `<directory>`."*
4. **Review the PR** the AI creates — check that no fixture contains sensitive content (real user prompts, real IP addresses, real process names)
5. **Open the PR** against this repo

The full step-by-step is in [`Update_for_your_version_and_submit_a_PR.md`](./Update_for_your_version_and_submit_a_PR.md).

## Adding a new instrument

This is easier than it sounds. The universal core verbs already work on any instrument the engine can parse — "adding an instrument" means adding test fixtures so the server knows what column shapes to expect, and optionally adding a curated lens for smarter navigation.

**Step 1 — Add compatibility (mechanical, one PR):**  
Export XML from a real trace, add it as a fixture, update `VERIFIED_PAIRS` in `versionRules.ts`, and baseline the snapshots. Start a Claude session and say: *"Read `Update_for_your_version_and_submit_a_PR.md` and follow Scenario B to add `<InstrumentName>` support using `<trace-file>`."*

**Step 2 — Add a curated lens (optional, second PR):**  
A lens adds a `quickStart` shortcut (so `open_trace` immediately suggests the right first call) and optionally adds domain-specific tool verbs. This step requires understanding what the instrument measures and what "suspicious" output looks like — the contributor guide explains what's expected.

See [`Update_for_your_version_and_submit_a_PR.md`](./Update_for_your_version_and_submit_a_PR.md) for the full workflow, PR checklist, and privacy review guidelines.

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
