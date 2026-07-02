# How version resolution works

Every schema in a trace is resolved to a `rulesVersion` and a `confidence` level before parsing. This is the only place version-specific logic lives — the parser itself is intentionally version-unaware.

## Files

- `src/engine/versionRules.ts` — `VERSION_BASE`, `VERSION_SCHEMA_OVERRIDES`, `VERIFIED_PAIRS`, `resolveRules()`, `buildVersionWarning()`

## The three data structures

**`VERSION_BASE`** maps each known Xcode version to its default rules version:
```typescript
{ "27.0": "27.0" }
```
A version listed here will not trigger a `versionWarning` in `open_trace`. An unknown version falls back to the nearest known version numerically.

**`VERSION_SCHEMA_OVERRIDES`** handles the case where one schema's format changed in a release while everything else stayed the same:
```typescript
{ "28.0": { "hitches": "28.0" } }  // only hitches changed; all other schemas still use 27.0 rules
```
Without this, you'd need an entirely new rules version just for one schema change.

**`VERIFIED_PAIRS`** is a `Set<string>` of `"rulesVersion:schema"` keys. An entry here means a fixture XML file exists for this combination and the parser is known to handle it correctly. Missing from this set = `confidence: "nearest"` (fallback, may not be accurate).

## Resolution order

```
resolveRules(xcodeVersion, schema)
  1. VERSION_SCHEMA_OVERRIDES[xcodeVersion][schema]  — per-schema override wins
  2. VERSION_BASE[xcodeVersion]                      — exact base version match
  3. findNearestVersion(xcodeVersion)                — numeric proximity fallback
```

Confidence is `"verified"` if the resolved `(rulesVersion, schema)` pair is in `VERIFIED_PAIRS`, otherwise `"nearest"`.

## What triggers a versionWarning

`buildVersionWarning()` is called in `open_trace` with the detected Xcode version and all schema names in the trace. It returns `null` (no warning) if the version is in `VERSION_BASE`. Otherwise it returns a warning with per-schema resolution details so the agent can explain exactly which schemas are falling back and to what version.

## Why the parser is version-unaware

The column schema in xctrace XML output is self-describing — every `<col>` element declares its `engineering-type`. The parser reads whatever is present in the XML. `versionRules.ts` exists to track which combinations have been tested and are known-good, not to change parsing behaviour. If a new Xcode version adds a column to an existing schema, the parser handles it automatically; `VERIFIED_PAIRS` just doesn't have an entry for it yet.

## What looks surprising but is intentional

**Adding a new fixture requires updating two things.** The XML file alone is not enough — it also needs a `VERIFIED_PAIRS` entry. Without the entry the schema shows `confidence: "nearest"` even if the fixture exists. The test suite checks this consistency via the drift guard.

**`findNearestVersion` prefers older over newer.** When falling back, it picks the highest version that is ≤ the target. Slightly old rules are safer than slightly new — new versions are more likely to have added columns that the old rules don't know about than to have removed ones the old rules expect.

## Other Xcode-version-dependent facts to re-verify when upgrading

Schema/column shape isn't the only thing that can drift between Xcode versions — anywhere this codebase hardcodes a fact about xctrace's own built-in templates/instruments, that fact needs re-checking against the new Xcode, the same way a fixture needs a `VERIFIED_PAIRS` entry.

**`TEMPLATE_BUNDLES` in `src/core/recording.ts`** — records which extra instruments each built-in template (e.g. "Time Profiler", "SwiftUI") bundles for free, verified by running `xcrun xctrace record --template <name> --show-recording-options` for every template referenced there. A new Xcode version can add, remove, or change a template's bundled instruments. When upgrading, re-run that command for each template in `TEMPLATE_BUNDLES` (and check `xcrun xctrace list templates`/`list instruments` for new names worth adding) before trusting `decomposeInstruments()`'s output on the new version — a stale entry here doesn't fail loudly like a schema-version mismatch does, it silently records an incomplete instrument set instead.
