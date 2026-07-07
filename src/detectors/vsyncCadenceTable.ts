/**
 * PMT:still-hail — the vsync-cadence "frames held" table.
 *
 * The HIGH-VALUE output this prompt exists to ship: turns a hitch's abstract
 * "duration Xms over budget" into the concrete, legible sequence of vsync
 * ticks a surface sat on-screen through — e.g. a 66.67ms on-screen swap at a
 * 16.67ms cadence is "held through 4 ticks, no new frame arrived for 3 of
 * them, then a recovery swap." This is the cheap "show the WHAT" layer
 * (join vsync ticks against surface-present intervals); the expensive
 * "find the WHY" (call_tree into the render/CPU cause during that window) is
 * a separate drill-down, not this table's job.
 *
 * Built from display-vsyncs-interval (tick timestamps) x
 * displayed-surfaces-interval (surface start/duration) — both OPTIONAL
 * enrichment inputs: a detector calls this defensively (never throws) and
 * simply omits the table when either schema isn't ingested or the join
 * yields nothing, exactly like frameBudget.ts's own graceful degradation.
 *
 * Bounded BY CONSTRUCTION: the window is only ever a few cadence intervals
 * around ONE hitch (never the whole trace), and every query below is either
 * time-range-scoped or hard-LIMITed, so this stays cheap regardless of trace
 * size — consistent with the core-vs-lens cost rule (aidocs/howLensesWork.md).
 */
import { quoteIdent } from "../engine/sqliteStore.js";
import { fmtCol, rawCol } from "../engine/sqlHydrate.js";
import type { DetectorContext } from "./types.js";
import { DISPLAY_VSYNCS_SCHEMA } from "./frameBudget.js";

export const DISPLAYED_SURFACES_SCHEMA = "displayed-surfaces-interval";

/** Ticks before/after the hitch window to show — enough to see the drop into, and recovery out of, the hold. */
const CONTEXT_CADENCES = 2;
/** Hard cap regardless of how long the hitch is — a pathological multi-second "hitch" still yields a bounded table. */
const MAX_ROWS = 64;
/** A swap's `start` matches a vsync tick when within this fraction of one cadence (clock jitter, not a real gap). */
const SWAP_MATCH_FRACTION = 0.5;

export interface VsyncCadenceRow {
  /** Tick time, ms, absolute (same clock as the rest of the trace). */
  tMs: number;
  /** A new surface swapped in AT this tick. */
  hasSwap: boolean;
  /** Set only on a swap row: how long that surface stayed on-screen (ms). */
  onScreenMs?: number;
  /** Set only on a swap row: on-screen duration / cadence, rounded — 1 = normal, >1 = N-1 dropped frames held through. */
  framesHeld?: number;
  /** Human annotation, e.g. "normal", "4 frames held (3 dropped)", "no new frame", "recovery swap". */
  note: string;
}

export interface VsyncCadenceTable {
  cadenceMs: number;
  windowStartMs: number;
  windowEndMs: number;
  rows: VsyncCadenceRow[];
}

function safeTable(ctx: DetectorContext, schema: string): string | null {
  const table = ctx.tableName(schema);
  try {
    ctx.db.prepare(`SELECT 1 FROM ${quoteIdent(table)} LIMIT 1`).get();
    return table;
  } catch {
    return null;
  }
}

interface TickRow {
  ts: number;
}
interface SwapRow {
  start: number;
  duration: number;
}

/**
 * Build the bounded vsync-cadence table around one hitch. `display` scopes
 * both queries to that display's own ticks/surfaces when present (matches
 * the "display-name" engineering-type hitches.display already shares with
 * both Display schemas — a direct string join, unlike device-display-info's
 * numeric display-id). Returns null whenever either schema is missing, the
 * shape doesn't match, or there's simply nothing to show — never throws, so
 * a caller can attach this as pure enrichment without risking the detector's
 * primary finding.
 */
export function buildVsyncCadenceTable(
  ctx: DetectorContext,
  display: string | null,
  hitchStartNs: number,
  hitchDurationNs: number,
  cadenceMs: number
): VsyncCadenceTable | null {
  if (!(cadenceMs > 0)) return null;
  const vsyncTable = safeTable(ctx, DISPLAY_VSYNCS_SCHEMA);
  const surfaceTable = safeTable(ctx, DISPLAYED_SURFACES_SCHEMA);
  if (!vsyncTable || !surfaceTable) return null;

  const cadenceNs = cadenceMs * 1e6;
  const windowStartNs = hitchStartNs - CONTEXT_CADENCES * cadenceNs;
  const windowEndNs = hitchStartNs + hitchDurationNs + CONTEXT_CADENCES * cadenceNs;

  let rawTicks: Array<{ ts: number | null }>;
  let rawSwaps: Array<{ start: number | null; duration: number | null }>;
  try {
    const displayFilter = display ? `AND ${quoteIdent(fmtCol("display-name"))} = ?` : "";
    const tickStmt = ctx.db.prepare(
      `SELECT CAST(${quoteIdent(rawCol("timestamp"))} AS REAL) AS ts FROM ${quoteIdent(vsyncTable)} ` +
        `WHERE CAST(${quoteIdent(rawCol("timestamp"))} AS REAL) BETWEEN ? AND ? ${displayFilter} ` +
        `ORDER BY CAST(${quoteIdent(rawCol("timestamp"))} AS REAL) ASC LIMIT ${MAX_ROWS}`
    );
    rawTicks = (display ? tickStmt.all(windowStartNs, windowEndNs, display) : tickStmt.all(windowStartNs, windowEndNs)) as Array<{
      ts: number | null;
    }>;

    const surfaceStmt = ctx.db.prepare(
      `SELECT CAST(${quoteIdent(rawCol("start"))} AS REAL) AS start, CAST(${quoteIdent(rawCol("duration"))} AS REAL) AS duration ` +
        `FROM ${quoteIdent(surfaceTable)} ` +
        `WHERE CAST(${quoteIdent(rawCol("start"))} AS REAL) BETWEEN ? AND ? ${displayFilter} ` +
        `ORDER BY CAST(${quoteIdent(rawCol("start"))} AS REAL) ASC LIMIT ${MAX_ROWS}`
    );
    rawSwaps = (display
      ? surfaceStmt.all(windowStartNs - cadenceNs, windowEndNs, display)
      : surfaceStmt.all(windowStartNs - cadenceNs, windowEndNs)) as Array<{ start: number | null; duration: number | null }>;
  } catch {
    return null;
  }
  const ticks: TickRow[] = rawTicks.filter((r): r is { ts: number } => typeof r.ts === "number");
  const swaps: SwapRow[] = rawSwaps.filter(
    (r): r is { start: number; duration: number } => typeof r.start === "number" && typeof r.duration === "number"
  );
  if (ticks.length === 0) return null;

  const matchTolerance = cadenceNs * SWAP_MATCH_FRACTION;
  const rows: VsyncCadenceRow[] = [];
  let prevWasHeld = false;

  for (const tick of ticks) {
    const swap = swaps.find((s) => Math.abs(s.start - tick.ts) <= matchTolerance);
    if (swap) {
      const onScreenMs = swap.duration / 1e6;
      const framesHeld = Math.max(1, Math.round(swap.duration / cadenceNs));
      const note =
        framesHeld > 1
          ? `${framesHeld} frames held (${framesHeld - 1} dropped)`
          : prevWasHeld
            ? "recovery swap"
            : "normal";
      rows.push({ tMs: tick.ts / 1e6, hasSwap: true, onScreenMs, framesHeld, note });
      prevWasHeld = framesHeld > 1;
    } else {
      // No swap at this tick — held over from whichever surface is still on-screen.
      const covering = swaps.find((s) => s.start <= tick.ts && tick.ts < s.start + s.duration);
      rows.push({ tMs: tick.ts / 1e6, hasSwap: false, note: covering ? "no new frame" : "idle" });
    }
    if (rows.length >= MAX_ROWS) break;
  }

  return {
    cadenceMs,
    windowStartMs: windowStartNs / 1e6,
    windowEndMs: windowEndNs / 1e6,
    rows,
  };
}
