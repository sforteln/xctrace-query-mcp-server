/**
 * PMT:pure-hail — the detector framework: rank findings, gate by schema + cost,
 * run the cheap ones, and shape them for the ranked nextActions list.
 *
 * Ranking is FRAMEWORK-COMPUTED from each finding's structured firing conditions
 * (not a severity each detector hand-picks — that drifts as detectors accrete):
 * the score is the geometric mean of every condition's exceedance ratio
 * (value/threshold), so a finding that crosses several bars, or crosses one by a
 * lot, ranks above one that barely crosses. `over` outliers score ≥1; `under`
 * near-misses score <1 (closer to the bar = higher, but below any real outlier),
 * so leading-indicator findings naturally rank beneath actual problems.
 */
import type { Detector, DetectorContext, Finding, RankedFinding, FiringCondition } from "./types.js";

/** Compact number for the criterion text — thousands-separated, ints as ints. */
function fmtNum(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(2);
}

/** value/threshold for each condition; over → ≥1, under → <1 (closer-to-bar = higher). */
function exceedance(f: FiringCondition): number {
  if (f.threshold === 0) return f.value === 0 ? 1 : Infinity;
  return f.value / f.threshold;
}

/** Geometric mean of the conditions' exceedance ratios — the ranking score. */
export function scoreOf(firing: FiringCondition[]): number {
  if (firing.length === 0) return 0;
  const logSum = firing.reduce((a, f) => a + Math.log(Math.max(exceedance(f), 1e-9)), 0);
  return Math.exp(logSum / firing.length);
}

/** Bucket a score into a severity (tunable). Under-findings (<1) fall to low/medium. */
export function severityOf(score: number): "high" | "medium" | "low" {
  if (score >= 5) return "high";
  if (score >= 2) return "medium";
  return "low";
}

/** Human criterion text, rendered from the structured conditions. */
export function criterionText(firing: FiringCondition[]): string {
  return firing.map((f) => `${f.metric} ${fmtNum(f.value)} ${f.direction} ${fmtNum(f.threshold)}`).join(" AND ");
}

/** Derive a finding's rank + criterion + severity from its firing conditions. */
export function rankFinding(detector: Detector, finding: Finding): RankedFinding {
  const score = scoreOf(finding.firing);
  return {
    detectorId: detector.id,
    title: detector.title,
    summary: finding.summary,
    criterion: criterionText(finding.firing),
    severity: finding.severity ?? severityOf(score),
    score,
    callSpec: finding.callSpec,
    handles: finding.handles,
  };
}

/** Shared run loop: filter by `include`, then by schema-availability, then run
 *  + rank. A detector that throws is skipped (a broken detector must never
 *  break the response). */
function runGated(
  detectors: readonly Detector[],
  ctx: DetectorContext,
  availableSchemas: ReadonlySet<string>,
  include: (d: Detector) => boolean
): RankedFinding[] {
  const ranked: RankedFinding[] = [];
  for (const d of detectors) {
    if (!include(d)) continue;
    if (!d.requiredSchemas.every((s) => availableSchemas.has(s))) continue;
    let finding: Finding | null;
    try {
      finding = d.run(ctx);
    } catch {
      continue; // a detector error is never the caller's problem
    }
    if (finding) ranked.push(rankFinding(d, finding));
  }
  return ranked.sort((a, b) => b.score - a.score);
}

/**
 * Run every CHEAP detector whose required schemas are all ingested, ranked most-
 * alarming first. A detector that throws is skipped (a broken detector must
 * never break the response). Expensive detectors are not run here — they're
 * offered by name on demand (see availableDetectors).
 */
export function runCheapDetectors(
  detectors: readonly Detector[],
  ctx: DetectorContext,
  availableSchemas: ReadonlySet<string>
): RankedFinding[] {
  return runGated(detectors, ctx, availableSchemas, (d) => d.cost === "cheap");
}

/**
 * Run EVERY detector (cheap AND expensive) whose required schemas are all
 * ingested — mirrors runCheapDetectors but WITHOUT the `cost !== "cheap"`
 * guard (PMT:ruddy-elk). A detector's `expensive` flag exists to keep an
 * unbounded scan off a firehose schema, not to keep it off a schema that's
 * bounded BY NAME (see eagerSchemas.ts) and has already been eager-ingested
 * — an "expensive" p95/p99 band scan over a bounded ~800-row diagnosed-event
 * table runs in milliseconds. Callers must only pass `ingestedSchemas` that
 * were actually gated on boundedness (the eager sweep), never on the
 * detector's own cost flag, or this defeats the reason `expensive` exists.
 */
export function runDetectorsOverIngested(
  detectors: readonly Detector[],
  ctx: DetectorContext,
  ingestedSchemas: ReadonlySet<string>
): RankedFinding[] {
  return runGated(detectors, ctx, ingestedSchemas, () => true);
}

/** The expensive detectors whose schemas are present — offered by name, not run. */
export function availableExpensiveDetectors(
  detectors: readonly Detector[],
  availableSchemas: ReadonlySet<string>
): Array<{ id: string; title: string }> {
  return detectors
    .filter((d) => d.cost === "expensive" && d.requiredSchemas.every((s) => availableSchemas.has(s)))
    .map((d) => ({ id: d.id, title: d.title }));
}
