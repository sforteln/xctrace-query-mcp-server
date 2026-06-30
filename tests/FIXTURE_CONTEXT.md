# Fixture Context

## What this is

Snapshot tests for `parseTableXml` (schema-table format) and `parseTrackDetailXml` (track-detail format). Tests live in `tests/parsers.test.ts`. Snapshots are auto-managed by Vitest in `tests/__snapshots__/parsers.test.ts.snap`.

Fixtures are in `tests/fixtures/xcode-27.0/` (Xcode 27.0 beta, the version that produced these traces).

## Directory structure

```
tests/fixtures/xcode-27.0/
  schema-table/          ← parseTableXml() — /data/table format
    ModelInferenceTable.xml       SYNTHETIC — real data contained private app content
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
    swiftui-updates.xml           SYNTHETIC — real data had private app content and was 1.57 GB
    swiftui-causes.xml            SYNTHETIC — real data had private app content and was 365 MB
    swiftui-changes.xml           SYNTHETIC — real data had private app content and was 20 MB
    swiftui-full-causes.xml       SYNTHETIC — real data had private app content and was 1.1 GB
    swiftui-layout-updates.xml    SYNTHETIC — real data had private app content and was 183 MB; 3 rows covering uncached/uncached/cached with Medium/Low/no severity
    swiftui-update-groups.xml     SYNTHETIC — real data was 28 MB; labels use SwiftUI internal layout computer type names
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
| `SwiftActorLifetime`, `SwiftTaskCreationEvent` | Empty in swift.trace (app had no actor activity during recording) |
| kdebug, kdebug-strings, tick, process-info, thread-info, dyld-library-load | Infrastructure tables; not directly queried by the AI |

## ModelInferenceTable is SYNTHETIC

The real ModelInferenceTable.xml contained private app content. The fixture was replaced with 2 fake rows using the same column schema. The column definitions are real (copied from the actual xctrace export); only the row data is synthetic.

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

