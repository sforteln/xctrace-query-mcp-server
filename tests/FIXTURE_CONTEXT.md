# Fixture Context — PMT:vesper-ember

## What this is

Snapshot tests for `parseTableXml` (schema-table format) and `parseTrackDetailXml` (track-detail format). Tests live in `tests/parsers.test.ts`. Snapshots are auto-managed by Vitest in `tests/__snapshots__/parsers.test.ts.snap`.

Fixtures are in `tests/fixtures/xcode-27.0/` (Xcode 27.0 beta, the version that produced these traces).

## Directory structure

```
tests/fixtures/xcode-27.0/
  schema-table/          ← parseTableXml() — /data/table format
    ModelInferenceTable.xml       SYNTHETIC — real data had PromptManager app content
    ModelLoadingTable.xml         from model.trace run 1
    SessionTable.xml              from model.trace run 1
    ToolTable.xml                 from model.trace run 1
    FMEventTable.xml              from model.trace run 1
    RequestTable.xml              from model.trace run 1
    InstructionsTable.xml         from model.trace run 1
    hitches.xml                   from HangsAndHitches.trace run 1
    potential-hangs.xml           from HangsAndHitches.trace run 1
    hang-risks.xml                from HangsAndHitches.trace run 1
    network-connection-detected.xml   from network.trace run 1
    NetworkConnectionStats.xml        from network.trace run 1
    network-connection-update.xml     from network.trace run 1
    core-data-save.xml            from SwiftData.trace run 1
    core-data-fetch.xml           from SwiftData.trace run 1
    core-data-fault.xml           from SwiftData.trace run 1
    core-data-relationship-fault.xml  from SwiftData.trace run 1
    SwiftTaskLifetime.xml         from swift.trace run 1
    SwiftTaskStateTable.xml       from swift.trace run 1
    SwiftTasksInfoTable.xml       from swift.trace run 1
  track-detail/          ← parseTrackDetailXml() — /tracks/track/details/detail format
    Leaks__Leaks.xml              from AllocAndLeaksWithBacktraces.trace run 1
```

`__` in track-detail filenames encodes `/` (trackName/detailName).

## What was SKIPPED and why

| Schema | Reason |
|--------|--------|
| `time-sample` | 7.9MB (run 3 of modelAndTime.trace) — too large for a text fixture |
| `Allocations/Allocations List` | 79MB — way too large |
| `Allocations/Statistics` | appeared empty in available traces |
| `swiftui-updates`, `SwiftActorLifetime`, `SwiftTaskCreationEvent` | Empty in swift.trace (app had no SwiftUI/actor activity during recording) |
| kdebug, kdebug-strings, tick, process-info, thread-info, dyld-library-load | Infrastructure tables; not directly queried by the AI |

## ModelInferenceTable is SYNTHETIC

The real ModelInferenceTable.xml contained PromptManager app prompts and responses (private user data). The fixture was replaced with 2 fake rows using the same column schema. The column definitions are real (copied from the actual xctrace export); only the row data is synthetic.

To replace it with real data from a clean trace (one that has no sensitive content), re-export and overwrite this file, then run `npm test -- -u`.

## Adding fixtures for a new Xcode version

```bash
./scripts/generate-fixtures.sh <version> ~/Documents/traces
npm test -- -u
```

## Running tests

```bash
npm test              # run all
npm test -- -u        # update snapshots after parser changes
```

## Pending work (next sessions)

### PMT:green-deer — VERSION_BASE + VERSION_SCHEMA_OVERRIDES
Implement `src/engine/versionRules.ts` with:
- `VERSION_BASE`: map of `xcodeVersion → default rules { rulesVersion, confidence }`
- `VERSION_SCHEMA_OVERRIDES`: two-level map `xcodeVersion → schema → { rulesVersion, confidence }`
- `resolveRules(xcodeVersion, schema) → { rulesVersion, confidence }` — checks overrides first, falls back to VERSION_BASE, then falls back to nearest version (pessimistic: highest version below detected)
- Coverage manifest: which (version, schema) combinations have been verified
- `list_instruments` should annotate each schema with `{ rulesVersion, confidence }`

Initial state: VERSION_BASE for xcode-27.0 (all schemas → rulesVersion: "27.0", confidence: "verified"); no overrides yet.

### PMT:coal-stag — versionWarning in open_trace response
When `detectXcodeVersion()` returns a version not covered by VERSION_BASE, add a `versionWarning` block to the `open_trace` response:
```json
{
  "versionWarning": {
    "detectedVersion": "28.0",
    "note": "No rules for this version. Falling back to nearest known version.",
    "schemaWarnings": [
      { "schema": "ModelInferenceTable", "rulesVersion": "27.0", "confidence": "fallback" }
    ]
  }
}
```
Per-schema entries because different schemas may fall back to different versions.

### PMT:smooth-finch — contributor documentation
Write `docs/Update_for_your_version.md` explaining:
- How to record a trace for each instrument type
- How to export XML fixtures from it
- How to run tests and update snapshots
- The ModelInferenceTable synthetic fixture situation (privacy)
- How to add VERSION_BASE entry for a new Xcode version

### FTR:pine-mount — Post-Open Quick Insight (10 draft prompts)
After `open_trace`, return an instrument-aware summary with:
- Row count and key findings
- For Leaks: "4 leaks — types and top responsible frames — command to get backtrace for each"
- For Foundation Models: "N inference requests — total tokens, slowest request, session count"
- For Hangs: "N hangs detected — longest duration, affected threads"
- Next-action commands the AI should call immediately

All 10 prompts are in draft status — need refining before implementation.
