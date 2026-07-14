# Engineering Type Reference (harvested from Apple's docs)

`engineeringTypeReference.json` is Apple's own published reference for every
`engineering-type` xctrace can put on a `<col>` — 238 types across 7 families
(CPU, Energy, General, Graphics, I/O, Internal, Memory), scraped from
[Apple's Instruments developer help book](https://help.apple.com/instruments/developer/mac/current/)
(the "Engineering Type Reference" chapter). Regenerate with
`scripts/scrape-engineering-types.py` if Apple updates the docs.

Until now, this project's column-role inference (`roleHints.ts`/`roleInference.ts`)
has been built on hard-coded hints for the top ~6 instruments plus shape-based
heuristics for everything else — reverse-engineered from observed fixture data,
not an authoritative source. This file is that authoritative source.

Each entry has:
- `name` / `description` — the type's title and one-line summary
- `usage` — a flat attribute table: `Mnemonic` (the literal `engineering-type`
  string seen in xctrace XML), `CLIPS Type`, `Family`, `Display Width`,
  `Bit Width`, `Sentinel` (a value meaning "missing/NA", when the type has one),
  plus type-specific flags like `categorical`/`structured`
- `sections` — free-text sections like `Encoding Notes` (what's actually inside
  the value — e.g. URLSession's real field layout) and `Display Conventions`;
  some types (e.g. Energy Impact) carry a "Special Value Treatments" table
  mapping numeric ranges to qualitative levels (e.g. "Very High")

See `PMT:` prompts under the Testing feature for the planned audit that cross-
checks this data against the app's current hints/tool descriptions/detectors.
