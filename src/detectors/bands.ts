/**
 * PMT:shingle-bluff (outlier-sweep) / PMT:tidy-shore (near-miss) — the shared
 * band map both lenses read from. Harvested from Apple's own shipped
 * Instruments modeler (aidocs/appleModelerHarvest.md), NOT invented here —
 * factored into one module so the two lenses can never drift apart on what
 * "over" vs "near-miss" means for the same column; they cite the exact same
 * named constants rather than each hand-rolling its own copy.
 *
 * Only ONE domain is wired today: hitches (aidocs #1 — "the canonical
 * relative-to-frame-budget pattern"). Apple's own load-bearing signal is
 * `duration` measured in units of the display's frame budget, never absolute
 * ms — bands: >1x frame budget = Moderate (a dropped frame), >2x = High.
 * aidocs #2 (FileActivity's excessive-writes, a rate-per-second band) is
 * DELIBERATELY not included: verified against the codebase — no detector's
 * requiredSchemas, no test fixture, and no parser anywhere references a
 * FileActivity/disk-io-routine/fs-syscall schema, so this server cannot even
 * ingest that domain yet. Wiring a band for a schema it can't read would be
 * inventing an untested name. Add its band here, beside a real ingestion
 * path, when that lands — never start a second, driftable band map.
 *
 * Frame-budget caveat (documented, not silent): the hitches table itself
 * carries only start/duration/process/is-system/swap-id/label/display/
 * narrative-description (tests/fixtures/xcode-27.0/schema-table/hitches.xml)
 * — no refresh-interval or buffer-count column ships with the row, so there
 * is no per-trace value to read live today. DEFAULT_REFRESH_INTERVAL_MS is a
 * tunable FALLBACK (60Hz's ~16.67ms, the common case), not a read-from-trace
 * value. Every band below is still expressed as a MULTIPLE of it though,
 * never a raw ms cutoff — exactly the "relative, not absolute" discipline
 * the harvest calls out as the durable lesson — so the moment a per-trace
 * refresh-interval source becomes readable, this is a one-constant swap, not
 * a rewrite of either lens.
 */

/** Tunable fallback frame budget (60Hz). Swap for a per-trace value if one ever becomes readable from the trace itself. */
export const DEFAULT_REFRESH_INTERVAL_MS = 16.67;

/** is-system="No" — app-caused, not system-owned (matches animationHitchesDistribution/hitchCauseSplit's own filter). */
export const APP_HITCH = "No";

/** aidocs #1: >1x frame budget = Moderate (≥1 dropped frame) — shingle-bluff's over-band. */
export const HITCH_MODERATE_MULTIPLE = 1;
/** aidocs #1: >2x frame budget = High (≥2 dropped frames) — shingle-bluff's more-severe over-band. */
export const HITCH_HIGH_MULTIPLE = 2;
/** aidocs #1's tidy-shore mapping: 0.5x-1x frame budget — "approaching a dropped frame," not yet over the line. */
export const HITCH_NEAR_MISS_LOW_MULTIPLE = 0.5;
/** The near-miss band's upper edge — deliberately equal to HITCH_MODERATE_MULTIPLE (the line it's approaching). */
export const HITCH_NEAR_MISS_HIGH_MULTIPLE = 1;

/** Don't trust (or fire) a sweep computed off a handful of hitches. */
export const MIN_HITCH_SAMPLES = 5;

/** shingle-bluff: enough Moderate+ (>1x) hitches to be a real discovery signal, not one stray frame drop. */
export const OUTLIER_MODERATE_COUNT_THRESHOLD = 5;
/** shingle-bluff: a genuine cluster of High (>2x) hitches — more than a single severe one-off. */
export const OUTLIER_HIGH_COUNT_THRESHOLD = 1;

/** tidy-shore: enough near-miss (0.5x-1x) hitches to be a real leading-indicator signal, not noise. */
export const NEAR_MISS_COUNT_THRESHOLD = 5;

/** A frame-budget multiple -> its absolute ns cutoff, given the per-trace (or fallback) frame budget in ms. */
export function hitchBandNs(multiple: number, frameBudgetMs: number = DEFAULT_REFRESH_INTERVAL_MS): number {
  return multiple * frameBudgetMs * 1e6;
}
