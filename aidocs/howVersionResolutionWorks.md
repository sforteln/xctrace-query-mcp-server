# How Xcode version tracking works

This project has only ever been verified against ONE Xcode build at a time. There used to be a full adaptive multi-version rules-resolution system here (per-schema `rulesVersion` + `confidence` lookup, nearest-known-version fallback) — removed (PMT:hollow-crystal) after it turned out to be built for a future with many tracked versions but only ever had one real entry. What replaced it is much simpler: a flat list of confirmed-working versions, checked against whatever's actually detected.

## Files

- `src/engine/versionRules.ts` — `CONFIRMED_WORKING_VERSIONS`, `buildVersionWarning()`, `FIXTURED_SCHEMAS`
- `src/engine/xcodeVersion.ts` — `detectXcodeVersion()`, unaffected by any of the above; still runs so we know what the client actually has

## The mechanism

**`CONFIRMED_WORKING_VERSIONS`** is a flat `string[]` of Xcode short versions (e.g. `"27.0"`, whatever `detectXcodeVersion()` returns — `CFBundleShortVersionString`, not the finer build number) that have actually been tested end-to-end.

**`buildVersionWarning(xcodeVersion)`** checks the detected version against that list. In the list → `null` (no warning). Not in the list (including detection failing entirely) → one plain message naming what's actually confirmed, surfaced in `open_trace`'s response. No per-schema breakdown, no "nearest version" guessing — those existed for a version-resolution system this project doesn't have.

**`FIXTURED_SCHEMAS`** is unrelated to any of the above — it's just the set of schema names that have a committed regression fixture, used by the drift guard (`tests/driftGuard.test.ts`) to catch tool descriptions referencing a schema name that doesn't actually exist as tested data. It used to be keyed as `"rulesVersion:schema"` pairs for the old resolution system; now it's just plain schema names.

## Why the parser is version-unaware

Still true, unchanged by any of this: the column schema in xctrace XML output is self-describing — every `<col>` element declares its `engineering-type`. The parser reads whatever is present in the XML rather than branching on a version number. If a new Xcode version adds a column to an existing schema, the parser handles it automatically.

## Confirming a newly-tested version

Deliberate and manual, not automatic: run the full test suite against the new Xcode install, and if it's actually green, append the short version to `CONFIRMED_WORKING_VERSIONS`. Granularity is the short version (e.g. "27.0") — not build/beta level. Chosen deliberately: trace schema formats aren't expected to change often within one short version, and re-verifying against every beta/point release isn't worth the ongoing maintenance cost. If that assumption turns out wrong for a specific release, that's the trigger to reconsider the granularity, not a reason to add it back preemptively.

## Other Xcode-version-dependent facts to re-verify when upgrading

Schema/column shape isn't the only thing that can drift between Xcode versions — anywhere this codebase hardcodes a fact about xctrace's own built-in templates/instruments, that fact needs re-checking against the new Xcode before trusting it, the same spirit as confirming a new version above (manual, deliberate, not automatic).

**`TEMPLATE_BUNDLES` in `src/core/recording.ts`** — records which extra instruments each built-in template (e.g. "Time Profiler", "SwiftUI") bundles for free, verified by running `xcrun xctrace record --template <name> --show-recording-options` for every template referenced there. This table has no runtime version-conditional logic at all — it's a flat, single-version-assumed table — which is exactly why it needs a manual re-check on upgrade rather than failing loudly on its own: a new Xcode version can add, remove, or change a template's bundled instruments, and a stale entry here doesn't error like a schema mismatch would, it silently records an incomplete instrument set instead. When upgrading, re-run that command for each template in `TEMPLATE_BUNDLES` (and check `xcrun xctrace list templates`/`list instruments` for new names worth adding) before trusting `decomposeInstruments()`'s output on the new version.
