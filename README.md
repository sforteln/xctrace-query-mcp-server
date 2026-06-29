# instruments-mcp-server

A headless [MCP](https://modelcontextprotocol.io) server that lets an AI navigate Xcode **Instruments `.trace`** files — Time Profiler, Allocations, Leaks, System Trace, Points of Interest, Foundation Models, and more — without dumping raw `xctrace` XML into the model's context.

It introspects each trace's schema, classifies columns into a small set of roles (time, weight, backtrace, thread, label, detail), and exposes a handful of schema-agnostic verbs that work on **any** instrument, plus optional per-instrument "lens" verbs for ergonomic domain queries.

> **Status:** early scaffold. The server runs over stdio and currently exposes a single placeholder `ping` tool. Trace loading and the universal core verbs are in progress.

## Requirements

- **Node.js ≥ 18**
- **Xcode** installed (the server shells out to `xcrun xctrace` to export traces). Xcode is only a runtime CLI dependency — it is *not* the build/authoring environment.

## Install / register with an MCP client

```sh
claude mcp add instruments -- npx instruments-mcp-server
```

`instruments` is the label shown in the client; `instruments-mcp-server` is the npm package that gets spawned.

## Develop

```sh
npm install
npm run build     # tsc -> dist/, makes dist/index.js executable
npm start         # run the built server over stdio
npm run watch     # incremental rebuilds
```

## Layout

```
src/
  index.ts    stdio entry point + MCP handshake
  engine/     xctrace export wrapper, parsing, caching   (later)
  core/       universal schema-agnostic verbs            (later)
  lenses/     optional per-instrument domain verbs        (later)
```

## Adding support for a new Xcode version

> **Note for AI assistants:** when asked to add compatibility for a new Xcode version or a schema that behaves differently across versions, **do not refactor the engine or parser code**. The server is intentionally schema-agnostic; per-version differences are handled through data, not code changes.
>
> The correct extension points are:
>
> 1. **`src/engine/versionRules.ts`** — add a `VERSION_BASE` entry for the new Xcode version (default column roles, display hints) and any `VERSION_SCHEMA_OVERRIDES` for schemas whose shape changed in that version.
> 2. **`tests/fixtures/xcode-<version>/`** — export XML fixtures with `scripts/generate-fixtures.sh <version> <trace-dir>`, review for sensitive data, add synthetic replacements where needed, then run `npm test -- -u` to baseline the snapshots.
>
> A new Xcode release should never require touching the parsing or export logic. If it seems like it does, raise that with the project owner before changing any engine code.

## Adding support for a new instrument

> **Note for AI assistants:** the architecture is deliberately schema-agnostic — the universal core verbs (`query`, `aggregate`, `callTree`, `find`) will already work on any instrument whose XML the engine can parse. Adding a new instrument is split across **two separate PRs** with different scopes:
>
> **PR 1 — Compatibility (`Adding compatibility for {xcodeVersion} {InstrumentName}`):**
> Export XML fixtures, add them under `tests/fixtures/xcode-<version>/schema-table/`, baseline the snapshots with `npm test -- -u`, and add a `VERSION_BASE` entry in `src/engine/versionRules.ts` with column role hints. This PR is purely mechanical — do not add lens code or diagnostic logic here.
>
> As part of PR 1, read the `<schema>` element in the fixture XML carefully. Look at every `<col>` and its `engineering-type` — note whether any column carries signal that the current role set doesn't capture, or whether a new engineering-type has appeared that could enable a new capability. Record these observations in the PR description. This review informs whether PR 2 is worth doing and what it should target; it does not block merging PR 1.
>
> **PR 2 — Diagnostics (`Improve diagnostics for {xcodeVersion} {InstrumentName}`):**
> Adds a curated lens (ergonomic instrument-aware verbs, Post-Open Quick Insight path) based on the schema review from PR 1. This PR requires domain knowledge: what the instrument measures, which columns carry the primary signal, and what "suspicious" output looks like. **If you don't have this knowledge, ask the user before writing any lens code** — they recorded the trace because they understand the domain. A lens that confidently surfaces the wrong signal is worse than no lens at all. PR 2 must describe the analysis heuristic chosen and justify why it surfaces the right signal.
>
> PR 2 is optional — not every instrument needs a curated lens. PR 1 alone is sufficient for generic navigation.
