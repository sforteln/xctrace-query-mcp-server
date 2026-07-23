# How fixtures work

Fixtures are small XML files that let the test suite exercise the parsers without needing a real `.trace` file. They are the output of `xcrun xctrace export` — real or synthetic.

## Files

- `tests/fixtures/xcode-<version>/schema-table/*.xml` — one file per schema, schema-table format
- `tests/fixtures/xcode-<version>/track-detail/*.xml` — track-detail format (Allocations, Leaks)
- `tests/__snapshots__/parsers.test.ts.snap` — auto-generated snapshot of parsed output
- `tests/FIXTURE_CONTEXT.md` — notes on which fixtures are synthetic and why
- `scripts/generate-fixtures.sh` — exports fixtures from real `.trace` files

## Two XML formats

xctrace exports two structurally different XML formats depending on the instrument:

**Schema-table** — most instruments:
```
/trace-toc/run[@number="1"]/data/table[@schema="hitches"]
```
```xml
<schema name="hitches"><col>...</col></schema>
<row>...</row>
```

**Track-detail** — Allocations and Leaks only:
```
/trace-toc/run[@number="1"]/tracks/track[@name="Leaks"]/details/detail[@name="Leaks"]
```
Different root XPath, same `id`/`ref` row encoding inside.

Filename convention for track-detail: `{TrackName}__{DetailName}.xml` — two underscores encode the `/`; spaces become `-`. Example: `Allocations__Allocations-List.xml`.

## The id/ref deduplication scheme

xctrace compresses repeated values using an `id`/`ref` scheme. A value is emitted once with an `id` attribute and referenced later with a `ref` that points to that id:

```xml
<string id="4" fmt="ContentView">ContentView</string>   <!-- defined here -->
<string ref="4"/>                                        <!-- reused here — same value -->
```

The parsers resolve all refs before returning rows. This is why fixture files look terse — most values in later rows are refs to earlier definitions.

## Synthetic fixtures

Some fixtures cannot be committed from real traces:

| Reason | Schemas |
|--------|---------|
| Contains private app content (prompts, responses) | `ModelInferenceTable`, `InstructionsTable`, `FMEventTable`, `SessionTable`, `RequestTable` |
| Contains real process names / IP addresses | `NetworkConnectionStats` |
| Contains private app type names | `swiftui-updates`, `swiftui-causes`, `swiftui-changes` |
| Too large (7 MB – 365 MB) | `time-sample`, `Allocations__Allocations-List`, `swiftui-*` |

A synthetic fixture preserves the real `<schema>` element (column definitions are real) but replaces row data with 3–4 hand-written rows using `"MyApp"` and fake PIDs. See `tests/fixtures/xcode-27.0/schema-table/swiftui-updates.xml` as an example.

## Size rule

Fixtures over ~500 KB should not be committed. xctrace XML is 10–100× the binary trace size — a 300 MB trace can produce 365 MB of XML for a single schema. Check size before committing:
```bash
xcrun xctrace export --input my.trace --xpath '...' > /tmp/check.xml
wc -c /tmp/check.xml
```

## Adding a fixture

1. Export or write the XML
2. Place it in `tests/fixtures/xcode-<version>/schema-table/<schema>.xml`
3. Add `"<schema>"` to `FIXTURED_SCHEMAS` in `src/engine/versionRules.ts` — see [howVersionResolutionWorks.md](howVersionResolutionWorks.md)
4. Run `npm test -- -u` to baseline the snapshot, then `npm test` to confirm green
5. Document it in `tests/FIXTURE_CONTEXT.md` if it is synthetic

## What looks surprising but is intentional

**`swiftui-layout-updates.xml` has no rows.** Layout Updates was disabled in the recording that produced `swiftUI.trace`. The fixture is still useful — the `<schema>` element captures all column definitions, which is what the parser and the lens need. Row-free fixtures are valid.

**Snapshots are committed.** `tests/__snapshots__/parsers.test.ts.snap` is not gitignored. It is the ground truth for parser output — regenerate it with `npm test -- -u` only when the parser changes, not when adding new fixtures (new fixtures auto-generate new snapshot entries).

## Fixtures follow claims — the coverage rule

A 2026-07-22 TOC sweep across every real trace on the dev machine measured 99
distinct schemas in live use; **57 had neither a fixture nor a roleHints pin —
the uncovered tail is the MAJORITY**, and it includes heavyweights
(`time-profile` classifies purely through type heuristics). That is by design,
not neglect: the generic layer (engineering-type rules + name heuristics +
type-derived gotchas) re-derives everything from the live trace on every call,
which makes it version-proof by construction — there is nothing stored to
drift. Do NOT try to fixture the tail for its own sake; it regrows every Xcode
release, and a fixture for an unclaimed schema guards nothing.

The rule: **a fixture exists to guard a CLAIM.** The moment you write a
curated, hand-authored assertion about a specific schema — a roleHints pin, a
CURATED_GOTCHAS entry, a lens that names its columns, a detector tuned to its
values, a tool description citing it — that schema MUST get a committed
fixture exhibiting the claimed fact, in the same change, wired into the drift
guards (driftGuard.test.ts referential checks and/or a targeted assertion).
Otherwise the claim silently rots when Apple changes the export, which is the
exact failure class this project's drift tests exist to catch. Conversely: no
claim, no fixture required — the generic layer plus the Tier-2 honesty
fallback ("I can navigate this schema but have no curated analysis for it")
is the DESIGNED coverage for unclaimed schemas.
