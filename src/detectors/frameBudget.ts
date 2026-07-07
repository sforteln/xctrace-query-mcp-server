/**
 * PMT:still-hail — real per-display frame-budget resolver.
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
