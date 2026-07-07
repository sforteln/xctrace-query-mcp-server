/**
 * The detector registry (PMT:pure-hail). Every detector far-swan ships is
 * listed here; runCheapDetectors / availableExpensiveDetectors filter it by
 * cost + which schemas are ingested. The corpus detectors (PMT:flint-larch) and
 * the outlier-sweep / near-miss lenses (PMT:shingle-bluff / tidy-shore) register
 * here as they land.
 */
import type { Detector } from "./types.js";
import { swiftuiOverInvalidation } from "./swiftuiOverInvalidation.js";
import { animationHitchesDistribution } from "./animationHitchesDistribution.js";
import { swiftuiRebuildStorm } from "./swiftuiRebuildStorm.js";
import { allocationsGrowth } from "./allocationsGrowth.js";
import { hitchCauseSplit } from "./hitchCauseSplit.js";
import { leakAllocWithoutFree } from "./leakAllocWithoutFree.js";
import { runloopContainsBodyEval } from "./runloopContainsBodyEval.js";
import { fmPromptCachingMiss } from "./fmPromptCachingMiss.js";
import { fmMainActorSaturation } from "./fmMainActorSaturation.js";
import { outlierSweep } from "./outlierSweep.js";
import { nearMissSweep } from "./nearMissSweep.js";
import { renderHitchSweep } from "./renderHitchSweep.js";

export const DETECTORS: readonly Detector[] = [
  swiftuiOverInvalidation,
  animationHitchesDistribution,
  swiftuiRebuildStorm,
  allocationsGrowth,
  hitchCauseSplit,
  leakAllocWithoutFree,
  runloopContainsBodyEval,
  fmPromptCachingMiss,
  fmMainActorSaturation,
  outlierSweep,
  nearMissSweep,
  renderHitchSweep,
];

export * from "./types.js";
export {
  scoreOf,
  severityOf,
  criterionText,
  rankFinding,
  runCheapDetectors,
  availableExpensiveDetectors,
} from "./framework.js";
