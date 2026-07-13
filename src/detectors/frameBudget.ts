/**
 * Real per-display frame-budget resolver.
 *
 * bands.ts's hitchBandNs() has always taken a `frameBudgetMs` param, but every
 * caller left it defaulted to DEFAULT_REFRESH_INTERVAL_MS (60Hz) because
 * far-swan didn't ingest anything that carried the display's ACTUAL refresh
 * interval — the `hitches` schema itself has no refresh column (verified:
 * start/duration/process/is-system/swap-id/label/display/narrative-description
 * only). This resolver reads the two Display-instrument schemas that DO carry
 * it (device-display-info, display-vsyncs-interval) so the hitch detectors can
 * threshold against the REAL budget instead of assuming 60Hz — a 120Hz
 * ProMotion display's real budget is 8.33ms, not 16.67ms, so a 60Hz assumption
 * under-reports dropped frames by 2x on exactly the devices Apple ships today.
 *
 * Resolution order (first that yields a usable number wins):
 *   1. device-display-info.max-refresh-rate — the primary source (budget =
 *      1000 / rate ms). Ambiguous multi-display join order: try to match the
 *      hitch's `display` label (a "Display N" string) against display-id by
 *      trailing digits; else a single ingested row is used outright (the
 *      common single-display case); else prefer is-main-display; else pick
 *      the HIGHEST refresh rate present (never silently under-report relative
 *      to a connected display just because the join was ambiguous).
 *   2. display-vsyncs-interval — an accuracy-upgrade / independent fallback:
 *      the median gap between CONSECUTIVE vsync timestamps for the display.
 *      NOTE (verified live against 2026-07-07T20-27-57-animation-hitches.trace):
 *      this schema's own `duration` column is NOT the inter-vsync interval in
 *      practice — every one of 2,364 rows carried the exact same value (a 1ns
 *      sentinel for the "VSync Request" marker), despite the column's
 *      engineering-type suggesting otherwise. The real cadence has to be
 *      derived from the GAP between consecutive `timestamp` values, which is
 *      what this does (and which is device-accurate regardless of whether a
 *      future trace's `duration` column turns out to carry real data too).
 *   3. Fallback — DEFAULT_REFRESH_INTERVAL_MS, ONLY when neither schema
 *      yields a number, with `assumed: true` so callers can surface the
 *      caveat in the finding text rather than silently pretending accuracy.
 *
 * CORRECTION (render-baseline follow-up to this same PMT): the header above
 * used to say Apple's render-hitch baseline (aidocs #1's OTHER band —
 * baseline = ((buffer-count - 1) / 2) x refresh-interval) had to be deferred
 * because no buffer-count signal was available. It IS available: verified
 * live against the same authoring trace, display-vsyncs-interval's `color`
 * mnemonic (a name that reads like a UI tag, and IS just that on OTHER
 * Display schemas) carries engineering-type "render-buffer-depth" on THIS
 * schema specifically (fmt="2", constant across all 2,364 rows) — the
 * earlier column probe missed it. resolveRenderBaselineMs() below reads it,
 * reusing this file's resolveFrameBudgetMs() for the refresh-interval term
 * rather than re-deriving it.
 */
import { quoteIdent } from "../engine/sqliteStore.js";
import { fmtCol, rawCol } from "../engine/sqlHydrate.js";
import type { DetectorContext } from "./types.js";
import { DEFAULT_REFRESH_INTERVAL_MS } from "./bands.js";

export const DEVICE_DISPLAY_INFO_SCHEMA = "device-display-info";
export const DISPLAY_VSYNCS_SCHEMA = "display-vsyncs-interval";

/** Bounded sample size for the vsync-cadence fallback — cheap regardless of trace size (a huge trace still only reads this many rows). */
const MAX_VSYNC_SAMPLE_ROWS = 2000;

export type FrameBudgetSource = "device-display-info" | "vsync-cadence" | "fallback";

export interface FrameBudgetResult {
  budgetMs: number;
  source: FrameBudgetSource;
  /** True only for the fallback constant — callers should surface `note` in finding text when true. */
  assumed: boolean;
  /** Human-readable caveat; only set when assumed. */
  note?: string;
}

/** Probe whether a schema is ingested and queryable in THIS session — returns its physical table name or null. Never throws. */
function safeTable(ctx: DetectorContext, schema: string): string | null {
  const table = ctx.tableName(schema);
  try {
    ctx.db.prepare(`SELECT 1 FROM ${quoteIdent(table)} LIMIT 1`).get();
    return table;
  } catch {
    return null;
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

interface DisplayInfoRow {
  rate: number | null;
  isMain: string | null;
  displayId: string | null;
}

function tryDeviceDisplayInfo(ctx: DetectorContext, display: string | null): FrameBudgetResult | null {
  const table = safeTable(ctx, DEVICE_DISPLAY_INFO_SCHEMA);
  if (!table) return null;

  let rows: DisplayInfoRow[];
  try {
    rows = ctx.db
      .prepare(
        `SELECT CAST(${quoteIdent(rawCol("max-refresh-rate"))} AS REAL) AS rate, ` +
          `${quoteIdent(fmtCol("is-main-display"))} AS isMain, ` +
          `${quoteIdent(fmtCol("display-id"))} AS displayId ` +
          `FROM ${quoteIdent(table)}`
      )
      .all() as Array<{ rate: number | null; isMain: string | null; displayId: string | null }>;
  } catch {
    return null; // schema present but not the shape we expect — degrade gracefully
  }

  const withRate = rows.filter((r): r is DisplayInfoRow & { rate: number } => typeof r.rate === "number" && r.rate > 0);
  if (withRate.length === 0) return null;

  let chosen: DisplayInfoRow | undefined;
  if (display) {
    const trailingDigits = display.match(/(\d+)\s*$/)?.[1];
    if (trailingDigits) {
      chosen = withRate.find((r) => r.displayId === trailingDigits || r.displayId === String(Number(trailingDigits)));
    }
  }
  if (!chosen && withRate.length === 1) chosen = withRate[0]; // the common single-display case
  if (!chosen) chosen = withRate.find((r) => r.isMain === "Yes" || r.isMain === "1" || r.isMain === "true");
  if (!chosen) {
    // Ambiguous multi-display join, no main flag — pick the highest refresh rate
    // present so the band is at least as strict as the fastest connected display
    // (never silently under-report relative to it).
    chosen = [...withRate].sort((a, b) => b.rate! - a.rate!)[0];
  }
  if (!chosen?.rate) return null;

  return { budgetMs: 1000 / chosen.rate, source: "device-display-info", assumed: false };
}

function tryVsyncCadence(ctx: DetectorContext, display: string | null): FrameBudgetResult | null {
  const table = safeTable(ctx, DISPLAY_VSYNCS_SCHEMA);
  if (!table) return null;

  let rawRows: Array<{ ts: number | null; disp: string | null }>;
  try {
    const displayFilter = display ? `WHERE ${quoteIdent(fmtCol("display-name"))} = ?` : "";
    const stmt = ctx.db.prepare(
      `SELECT CAST(${quoteIdent(rawCol("timestamp"))} AS REAL) AS ts, ${quoteIdent(fmtCol("display-name"))} AS disp ` +
        `FROM ${quoteIdent(table)} ${displayFilter} ORDER BY ${quoteIdent(rawCol("timestamp"))} ASC LIMIT ${MAX_VSYNC_SAMPLE_ROWS}`
    );
    rawRows = (display ? stmt.all(display) : stmt.all()) as Array<{ ts: number | null; disp: string | null }>;
  } catch {
    return null;
  }
  const rows = rawRows.filter((r): r is { ts: number; disp: string | null } => typeof r.ts === "number");
  if (rows.length < 5) return null;

  // Consecutive-gap-per-display-name — keyed by name (not row order) so an
  // interleaved multi-display tick stream still computes each display's own
  // cadence correctly instead of diffing across displays.
  const lastTsByDisplay = new Map<string, number>();
  const deltasByDisplay = new Map<string, number[]>();
  for (const r of rows) {
    const key = r.disp ?? "";
    const prevTs = lastTsByDisplay.get(key);
    if (prevTs !== undefined) {
      const delta = r.ts - prevTs;
      if (delta > 0) {
        const bucket = deltasByDisplay.get(key) ?? [];
        bucket.push(delta);
        deltasByDisplay.set(key, bucket);
      }
    }
    lastTsByDisplay.set(key, r.ts);
  }

  const medians = [...deltasByDisplay.values()].map(median).filter((m): m is number => m !== null && m > 0);
  if (medians.length === 0) return null;

  // Ambiguous multi-display stream, no explicit display requested — conservative:
  // the fastest (smallest cadence) present, same reasoning as the device-display-info tie-break.
  const cadenceNs = Math.min(...medians);
  return { budgetMs: cadenceNs / 1e6, source: "vsync-cadence", assumed: false };
}

/**
 * Resolve the real per-display frame budget (ms) for a hitch, given its
 * `display` label (hitches.display, e.g. "Display 1") — or null to resolve a
 * trace-wide budget when no specific display is known/needed. Never throws;
 * degrades through device-display-info -> vsync-cadence -> the fallback
 * constant, always returning a usable number.
 */
export function resolveFrameBudgetMs(ctx: DetectorContext, display: string | null = null): FrameBudgetResult {
  return (
    tryDeviceDisplayInfo(ctx, display) ??
    tryVsyncCadence(ctx, display) ?? {
      budgetMs: DEFAULT_REFRESH_INTERVAL_MS,
      source: "fallback",
      assumed: true,
      note:
        `assuming ~${Math.round(1000 / DEFAULT_REFRESH_INTERVAL_MS)}Hz (${DEFAULT_REFRESH_INTERVAL_MS}ms); ` +
        `${DEVICE_DISPLAY_INFO_SCHEMA} not ingested — bands may under-report dropped frames on higher-refresh ` +
        `(e.g. ProMotion) displays`,
    }
  );
}

// ─── Render baseline (render-baseline follow-up) ───────────────────────────────

/**
 * display-vsyncs-interval's mnemonic that carries the swap-chain / back-
 * buffer count on THIS schema (engineering-type "render-buffer-depth",
 * verified live — fmt="2" constant across the authoring trace). The name is
 * misleading (the same mnemonic is a plain UI color tag on other Display
 * schemas — hitches-renders' frame-color, displayed-surfaces-interval's own
 * `color`), which is exactly why this resolver's original column probe missed
 * this signal; see this file's header for the correction.
 */
const RENDER_BUFFER_DEPTH_COLUMN = "color";

/** Observed default buffer depth (double-buffering) — verified live against the
 *  render-baseline authoring trace, where this was the ONLY value
 *  present. Used only when the column is present but every row's value is
 *  missing/non-numeric (or the schema isn't ingested at all) — never silently
 *  assumed when a real depth is readable. */
const DEFAULT_RENDER_BUFFER_DEPTH = 2;

export type RenderBaselineDepthSource = "render-buffer-depth" | "fallback";

export interface RenderBaselineResult {
  /** Apple's render-hitch baseline (ms): ((bufferDepth - 1) / 2) x the resolved frame budget. */
  baselineMs: number;
  /** The buffer depth used to compute it (observed, or the fallback default). */
  bufferDepth: number;
  /** Where bufferDepth came from. */
  depthSource: RenderBaselineDepthSource;
  /** The underlying frame-budget resolution this baseline was built on (see resolveFrameBudgetMs). */
  frameBudget: FrameBudgetResult;
  /** True if EITHER the buffer depth or the underlying frame budget had to be assumed — callers should surface `note`. */
  assumed: boolean;
  /** Human-readable caveat; only set when assumed. */
  note?: string;
}

/**
 * Read the per-display render-buffer-depth from display-vsyncs-interval —
 * the median across that display's rows (a real trace's depth is stable per
 * display, but median guards against a stray bad value the same way
 * tryVsyncCadence's cadence median does). Returns null when the schema isn't
 * ingested, isn't the expected shape, or every row's value is missing —
 * never throws.
 */
function tryRenderBufferDepth(ctx: DetectorContext, display: string | null): number | null {
  const table = safeTable(ctx, DISPLAY_VSYNCS_SCHEMA);
  if (!table) return null;

  let rawRows: Array<{ depth: number | null }>;
  try {
    const displayFilter = display ? `WHERE ${quoteIdent(fmtCol("display-name"))} = ?` : "";
    const stmt = ctx.db.prepare(
      `SELECT CAST(${quoteIdent(rawCol(RENDER_BUFFER_DEPTH_COLUMN))} AS REAL) AS depth ` +
        `FROM ${quoteIdent(table)} ${displayFilter} LIMIT ${MAX_VSYNC_SAMPLE_ROWS}`
    );
    rawRows = (display ? stmt.all(display) : stmt.all()) as Array<{ depth: number | null }>;
  } catch {
    return null; // schema present but not the shape we expect — degrade gracefully
  }

  const depths = rawRows.map((r) => r.depth).filter((d): d is number => typeof d === "number" && d > 0);
  return median(depths);
}

/**
 * Resolve Apple's render-hitch baseline (ms) for a hitch's render passes,
 * given its `display` label — or null to resolve a trace-wide baseline.
 * baseline = ((buffer-count - 1) / 2) x the REAL per-display frame budget
 * (aidocs/appleModelerHarvest.md's hitches section): render-duration at/under this is Low (fine, the
 * double-buffering pipeline absorbs it), at/over 2x is High (a slow render
 * likely causing the hitch itself, not just downstream of one) — see
 * bands.ts's RENDER_BASELINE_LOW_MULTIPLE/RENDER_BASELINE_HIGH_MULTIPLE.
 *
 * Reuses resolveFrameBudgetMs() for the refresh-interval term rather than
 * re-deriving it — the two resolvers must never disagree on what "the frame
 * budget" is for the same display. Never throws; falls back to
 * DEFAULT_RENDER_BUFFER_DEPTH (the observed default) when the buffer-depth
 * column is present-but-empty or the schema isn't ingested at all, with
 * `assumed: true` (also true when the underlying frame budget itself had to
 * be assumed) so callers can surface the caveat exactly like
 * resolveFrameBudgetMs's own fallback.
 */
export function resolveRenderBaselineMs(ctx: DetectorContext, display: string | null = null): RenderBaselineResult {
  const frameBudget = resolveFrameBudgetMs(ctx, display);
  const observedDepth = tryRenderBufferDepth(ctx, display);
  const depthAssumed = observedDepth === null;
  const bufferDepth = observedDepth ?? DEFAULT_RENDER_BUFFER_DEPTH;
  const baselineMs = ((bufferDepth - 1) / 2) * frameBudget.budgetMs;

  const notes: string[] = [];
  if (depthAssumed) {
    notes.push(
      `assuming render-buffer-depth=${DEFAULT_RENDER_BUFFER_DEPTH} (the observed default) — ${DISPLAY_VSYNCS_SCHEMA}'s ` +
        `${RENDER_BUFFER_DEPTH_COLUMN} column wasn't ingested or was empty for this display`
    );
  }
  if (frameBudget.assumed && frameBudget.note) notes.push(frameBudget.note);

  return {
    baselineMs,
    bufferDepth,
    depthSource: depthAssumed ? "fallback" : "render-buffer-depth",
    frameBudget,
    assumed: depthAssumed || frameBudget.assumed,
    ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
  };
}
