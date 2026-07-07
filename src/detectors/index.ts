/**
 * The detector registry (PMT:pure-hail). Every detector far-swan ships is
 * listed here; runCheapDetectors / availableExpensiveDetectors filter it by
 * cost + which schemas are ingested. The corpus detectors (PMT:flint-larch) and
 * the outlier-sweep / near-miss lenses (PMT:shingle-bluff / tidy-shore) register
 * here as they land.
 */
import type { Detector } from "./types.js";
import { swiftuiOverInvalidation } from "./swiftuiOverInvalidation.js";

export const DETECTORS: readonly Detector[] = [swiftuiOverInvalidation];

export * from "./types.js";
export {
  scoreOf,
  severityOf,
  criterionText,
  rankFinding,
  runCheapDetectors,
  availableExpensiveDetectors,
} from "./framework.js";
