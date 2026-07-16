/**
 * The shared band map the outlier-sweep and near-miss lenses both read from.
 * Harvested from Apple's own shipped
 * Instruments modeler (aidocs/appleModelerHarvest.md), NOT invented here —
 * factored into one module so the two lenses can never drift apart on what
 * "over" vs "near-miss" means for the same column; they cite the exact same
 * named constants rather than each hand-rolling its own copy.
 *
 * Only ONE domain is wired today: hitches (aidocs #1 — "the canonical
 * relative-to-frame-budget pattern"). Apple's own load-bearing signal is
 * `duration` measured in units of the display's frame budget, never absolute
 * ms — bands: >1x frame budget = Moderate (a dropped frame), >2x = High.
 * aidocs #2 (FileActivity's excessive-writes/suboptimal-caching, both rate-
 * or-recency-window rules) is DELIBERATELY not included, but for a different
 * reason than it once was — real ingestion (fixtures, a File Activity lens,
 * roleHints) has since been added for `fs-syscall`/`detected-fs-antipattern`,
 * so "this server cannot even ingest that domain" is no longer true. What's
 * still true: there's nothing for THIS module to compute. Unlike hitches
 * (Apple ships a raw `duration`, no severity — bands.ts derives it from the
 * harvested frame-budget rule), FileActivity's xctrace-side detector already
 * ships the classification pre-computed: `detected-fs-antipattern`'s own
 * `type` ("Excessive Writes"/"Suboptimal Caching"/...) and `significance`
 * ("High"/"Moderate"/"Low") columns ARE aidocs #2's rate-per-window and
 * same-key-correlation rules, already evaluated by Apple before the row
 * ever reaches this server — there's no raw metric here for this server
 * to threshold. The real gotcha (verified live, documented in the File
 * Activity lens/TEMPLATE_NOTES instead of here) is that `significance`
 * itself doesn't reliably track `duration` — a "Moderate" row can dwarf
 * every "High" row combined — but that's a caveat about trusting Apple's
 * own label, not a missing band this module should add.
 *
 * Frame-budget caveat: the hitches table itself
 * still carries only start/duration/process/is-system/swap-id/label/display/
 * narrative-description (tests/fixtures/xcode-27.0/schema-table/hitches.xml)
 * — no refresh-interval or buffer-count column ships with the row. But the
 * Animation Hitches template's SIBLING Display-instrument schemas do carry it
 * (device-display-info's max-refresh-rate, display-vsyncs-interval's tick
 * cadence) — src/detectors/frameBudget.ts's resolveFrameBudgetMs() reads
 * those live per-trace and returns the REAL per-display budget (this used to
 * be a fixed 60Hz-based constant everywhere the budget was needed; it's now
 * resolved per trace), falling back to DEFAULT_REFRESH_INTERVAL_MS (60Hz's
 * ~16.67ms) only when neither is ingested. DEFAULT_REFRESH_INTERVAL_MS remains
 * the tunable fallback constant, and every band below is still expressed as a
 * MULTIPLE of a frame budget, never a raw ms cutoff — exactly the "relative,
 * not absolute" discipline the harvest calls out as the durable lesson; only
 * which budget the multiple is taken against became dynamic instead of fixed.
 */

/** Tunable fallback frame budget (60Hz). Swap for a per-trace value if one ever becomes readable from the trace itself. */
export const DEFAULT_REFRESH_INTERVAL_MS = 16.67;

/** is-system="No" — app-caused, not system-owned (matches animationHitchesDistribution/hitchCauseSplit's own filter). */
export const APP_HITCH = "No";

/** aidocs #1: >1x frame budget = Moderate (≥1 dropped frame) — the outlier sweep's over-band. */
export const HITCH_MODERATE_MULTIPLE = 1;
/** aidocs #1: >2x frame budget = High (≥2 dropped frames) — the outlier sweep's more-severe over-band. */
export const HITCH_HIGH_MULTIPLE = 2;
/** aidocs #1's near-miss mapping: 0.5x-1x frame budget — "approaching a dropped frame," not yet over the line. */
export const HITCH_NEAR_MISS_LOW_MULTIPLE = 0.5;
/** The near-miss band's upper edge — deliberately equal to HITCH_MODERATE_MULTIPLE (the line it's approaching). */
export const HITCH_NEAR_MISS_HIGH_MULTIPLE = 1;

/** Don't trust (or fire) a sweep computed off a handful of hitches. Reused as-is by
 *  renderHitchSweep for hitches-renders' render passes — same reasoning, a different
 *  table of comparable order of magnitude, not a reason to invent a second constant. */
export const MIN_HITCH_SAMPLES = 5;

/** The outlier sweep: enough Moderate+ (>1x) hitches to be a real discovery signal, not one stray frame drop.
 *  Reused by renderHitchSweep for its over-Low (>1x render baseline) count. */
export const OUTLIER_MODERATE_COUNT_THRESHOLD = 5;
/** The outlier sweep: a genuine cluster of High (>2x) hitches — more than a single severe one-off.
 *  Reused by renderHitchSweep for its High (>=2x render baseline) count. */
export const OUTLIER_HIGH_COUNT_THRESHOLD = 1;

/** The near-miss sweep: enough near-miss (0.5x-1x) hitches to be a real leading-indicator signal, not noise. */
export const NEAR_MISS_COUNT_THRESHOLD = 5;

/**
 * animationHitchesDistribution's p95/p99 bands, expressed as
 * frame-budget multiples instead of the fixed 33ms/50ms this
 * detector used to hardcode — those absolute numbers were themselves an
 * uncredited 60Hz-multiple encoding (33ms ≈ 2x, 50ms ≈ 3x @16.67ms) that
 * could silently drift from the outlier/near-miss bands above; now
 * all three share the same resolved budget via frameBudget.ts.
 */
export const HITCH_P95_MULTIPLE = 2;
export const HITCH_P99_MULTIPLE = 3;

/**
 * Render-baseline follow-up to the frame-budget-resolved-live work above:
 * Apple's OTHER render-hitch band (aidocs/appleModelerHarvest.md's hitches
 * section), for a render PASS's own duration (hitches-renders) relative to
 * frameBudget.ts's resolveRenderBaselineMs() — ((buffer-count - 1) / 2) x the
 * frame budget, the double-buffering pipeline's own time budget. At/under
 * 1x baseline = Low (fine, absorbed by the buffering depth); at/over 2x =
 * High (a slow render likely causing the hitch itself). Same multiple-based
 * discipline as the hitch bands above — never a raw ms cutoff.
 */
export const RENDER_BASELINE_LOW_MULTIPLE = 1;
export const RENDER_BASELINE_HIGH_MULTIPLE = 2;

/** A frame-budget multiple -> its absolute ns cutoff, given the per-trace (or fallback) frame budget in ms. */
export function hitchBandNs(multiple: number, frameBudgetMs: number = DEFAULT_REFRESH_INTERVAL_MS): number {
  return multiple * frameBudgetMs * 1e6;
}
