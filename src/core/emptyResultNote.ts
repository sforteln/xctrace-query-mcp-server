/**
 * The auto-derived "why is this empty" note shared across
 * query/find/aggregate/call_tree/relate.
 *
 * Motivating pattern: nearly every misstep observed across AI-driven
 * investigation sessions with this server was "an empty/negative/absent
 * result read as a positive conclusion." A bare `[]` is a conclusion-shaped
 * void the reader fills in — usually wrong. The single highest-value fix:
 * attach the total UNFILTERED
 * count alongside a filtered 0, so "0 matched your filter" and "this table
 * genuinely has nothing" are distinguishable from the response itself,
 * without re-querying to check.
 *
 * Auto-derived only (computed live from counts already in hand or a cheap
 * COUNT(*) — never a stored/curated string), per aidocs/howHintsWork.md's
 * established philosophy — so it can't drift and needs no referential guard.
 */
export function emptyResultNote(opts: {
  /** Rows/samples/matches actually returned after every predicate applied. */
  matchedCount: number;
  /** The schema/table's total row count with NO predicate applied at all. */
  unfilteredCount: number;
  /** Whether any filter/timeRange/predicate was actually supplied (vs. a plain unfiltered call that just happens to hit an empty table). */
  filterApplied: boolean;
  /** Noun for the phrasing — default "rows". */
  itemNoun?: string;
}): string | undefined {
  if (opts.matchedCount > 0) return undefined;
  const noun = opts.itemNoun ?? "rows";
  if (!opts.filterApplied || opts.unfilteredCount === 0) {
    return `This schema genuinely has 0 ${noun} in this trace — not a filter artifact.`;
  }
  return (
    `0 of ${opts.unfilteredCount.toLocaleString("en-US")} ${noun} matched your filter/timeRange — ` +
    "the schema has data, just not matching this predicate."
  );
}
