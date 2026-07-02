# CLAUDE.md — session rules for this repo

## Architecture docs

`aidocs/` contains architecture docs that explain the why behind each subsystem. Read `aidocs/bootstrapping.md` first — it explains the convention.

**Before starting any task:**
- If the task touches a subsystem covered by a doc in `aidocs/`, read that doc before reading code

**Before closing any task:**
- If you modified code covered by an arch doc, check whether the doc needs updating
- If you modified an arch doc, search the repo for its filename and review every reference

## Comments

Never write comments that explain what code does — the code says that. Only write comments for:
- Why a decision was made
- Why something that looks wrong is intentional
- The exit condition for a workaround (what would make it safe to remove)

When a comment would require more than two lines to explain the why, point to the relevant arch doc instead:
```typescript
// — see howVersionResolutionWorks.md
```

## Tests

Run `npm test` after every change. The drift guard enforces tool description format — if it fails, fix the description before committing.

Run `npm test -- -u` only when parser changes require snapshot regeneration. Commit the updated `.snap` file.

## Fixtures

Fixture files in `tests/fixtures/` are XML exported from real `.trace` files or synthetic replacements. Before adding a fixture, check `aidocs/howFixturesWork.md`. Key rules:
- Never commit a fixture over ~500 KB — build a synthetic replacement instead
- Never commit real process names, IP addresses, user prompts, or private app type names
- Every fixture needs a corresponding entry in `VERIFIED_PAIRS` in `src/engine/versionRules.ts`

## Commits

One instrument or concern per commit. Message format:
- `Adding compatibility for {xcodeVersion} {InstrumentName}`
- `Improve diagnostics for {xcodeVersion} {InstrumentName}`
- Otherwise: short imperative description of what changed and why
