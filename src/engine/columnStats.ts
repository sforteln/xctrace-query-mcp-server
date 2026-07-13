/**
 * Pass 1: per-column repetition/size stats, gathered in a cheap stats-only
 * parse (no SQLite writes, no row materialization), used to decide which
 * columns are worth flavor-2 interning.
 *
 * The dedup opportunity has a schema-agnostic signature — a column whose
 * distinct-value count is far below its row count AND whose values are
 * non-trivially sized wastes ~avgLen × (rows − distinct) bytes to duplication.
 * Detect that from the data (same philosophy as role inference) so it auto-
 * covers every offending table, known and future, with zero per-schema list.
 *
 * Memory is bounded: distinct values are tracked as a capped Set of cheap
 * string hashes per column. A low-distinct column (category, description,
 * thread) stays small and gives an exact-enough count; a high-distinct column
 * (address) blows past the cap fast and is marked cappedOut → not internable
 * (its values barely repeat, so interning would be net overhead). A rare hash
 * collision only nudges the distinct estimate, which at worst makes a slightly
 * sub-optimal (never incorrect — interning stays consistent) decision.
 */
import type { NormalizedRow } from "./parseTable.js";

/** Distinct-hash cap per column — above this a column is deemed high-distinct. */
export const DISTINCT_CAP = 10_000;
/** Min avg value length to bother interning — matches the writer's FLAVOR2_INTERN_FLOOR_BYTES. */
export const DECISION_AVG_LEN_FLOOR = 16;
/**
 * A column is worth interning only when at least this fraction of its
 * occurrences are repeats (distinct/rows ≤ 1 − this). 0.5 = a value recurs on
 * average ≥2×. Scale-invariant, so it reads the same on a bounded sample as on
 * the full table (unlike an absolute wasted-bytes threshold, which a small
 * sample can never cross).
 */
export const MIN_REPEAT_FRACTION = 0.5;
/**
 * Don't intern a column until its (sampled) row count reaches this — tiny
 * tables waste too little to be worth a side table, and it keeps a filled
 * sample (the common trigger) safely above the bar.
 */
export const MIN_ROWS_TO_INTERN = 5_000;

interface ColStat {
  rows: number;
  sumLen: number;
  distinct: Set<number>;
  cappedOut: boolean;
}

/** djb2 — a fast non-crypto string hash; collisions only perturb the distinct estimate. */
function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

export class ColumnStatsAccumulator {
  readonly stats = new Map<string, ColStat>();

  /** Fold one parsed row into the per-column stats (uses each cell's fmt string). */
  observeRow(row: NormalizedRow): void {
    for (const mnemonic in row) {
      const cell = row[mnemonic];
      if (cell === null) continue;
      const value = cell.fmt;
      if (typeof value !== "string") continue;
      let st = this.stats.get(mnemonic);
      if (st === undefined) {
        st = { rows: 0, sumLen: 0, distinct: new Set(), cappedOut: false };
        this.stats.set(mnemonic, st);
      }
      st.rows++;
      st.sumLen += value.length;
      if (!st.cappedOut) {
        st.distinct.add(hashStr(value));
        if (st.distinct.size > DISTINCT_CAP) {
          st.cappedOut = true;
          st.distinct.clear(); // free the memory; the flag is all we need from here
        }
      }
    }
  }
}

export interface InternDecisionOpts {
  /** Minimum avg value length to bother interning (default DECISION_AVG_LEN_FLOOR). */
  floor?: number;
  /** Minimum repeat fraction — distinct/rows must be ≤ 1 − this (default MIN_REPEAT_FRACTION). */
  minRepeatFraction?: number;
  /** Minimum row count before a column can be interned (default MIN_ROWS_TO_INTERN). */
  minRows?: number;
}

/**
 * Decide which columns to flavor-2 intern from the (sampled) stats: values
 * large enough to be worth a side-table row (avgLen ≥ floor), that repeat
 * heavily (distinct/rows low), on a table big enough to matter (rows ≥ minRows).
 * A cappedOut (high-distinct) column is never chosen — its values barely
 * repeat, so interning would cost more than it saves. Because the test is a
 * RATIO, it reads the same on a bounded sample as on the full table.
 */
export function decideInternColumns(acc: ColumnStatsAccumulator, opts: InternDecisionOpts = {}): Set<string> {
  const floor = opts.floor ?? DECISION_AVG_LEN_FLOOR;
  const minRepeat = opts.minRepeatFraction ?? MIN_REPEAT_FRACTION;
  const minRows = opts.minRows ?? MIN_ROWS_TO_INTERN;
  const chosen = new Set<string>();
  for (const [mnemonic, st] of acc.stats) {
    if (st.cappedOut || st.rows < minRows) continue;
    const avgLen = st.sumLen / st.rows;
    if (avgLen < floor) continue;
    const repeatFraction = 1 - st.distinct.size / st.rows;
    if (repeatFraction >= minRepeat) chosen.add(mnemonic);
  }
  return chosen;
}

/** Per-column duplication-waste diagnostic (MB), largest first — "column X wasted N MB". */
export function wasteReport(acc: ColumnStatsAccumulator): Array<{ mnemonic: string; wasteMB: number; rows: number; distinct: number | "capped" }> {
  const rows: Array<{ mnemonic: string; wasteMB: number; rows: number; distinct: number | "capped" }> = [];
  for (const [mnemonic, st] of acc.stats) {
    if (st.rows === 0) continue;
    const distinct = st.cappedOut ? DISTINCT_CAP : st.distinct.size;
    const avgLen = st.sumLen / st.rows;
    const waste = avgLen * (st.rows - distinct);
    rows.push({ mnemonic, wasteMB: waste / 1048576, rows: st.rows, distinct: st.cappedOut ? "capped" : st.distinct.size });
  }
  return rows.sort((a, b) => b.wasteMB - a.wasteMB);
}
