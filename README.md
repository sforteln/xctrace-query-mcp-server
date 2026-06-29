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
