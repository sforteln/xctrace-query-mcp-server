/**
 * The Detector contract.
 *
 * A detector is server-internal analysis (bounded SQL / relate() / aggregate's
 * window-function machinery over the ingested tables) that either FIRES
 * (returns a Finding) or doesn't.
 * Its SQL is a private implementation detail — it NEVER reaches the AI. What the
 * AI gets is a structured Finding: a plain-language headline, the structured
 * firing conditions (from which the framework derives the criterion text and
 * the rank — detectors never hand-pick a severity that could drift), a
 * re-runnable callSpec in far-swan's OWN verbs (so the AI can tweak the
 * threshold/window and re-issue — a live handle, not a dead result — and never
 * sees SQL), and handles into the raw data.
 *
 * COST is the core-vs-lens axis (041.A): a detector whose query is intrinsically
 * boundable (row-limited / single-table / indexed-filter / timeRange-scoped) is
 * `cheap` and runs eager as soon as its schemas are loaded; one that can't be
 * (range join, full-population anti-join, percentile UDF, big call-tree) is
 * `expensive` — a named lens the author cost-vets and index-guarantees, invoked
 * on demand with bounded params. Only cheap detectors run eager, so surfacing
 * findings never forces an expensive scan.
 */
import type { DatabaseSync } from "node:sqlite";

/** One structured firing condition — a metric crossing a threshold. The
 *  framework derives both the rank and the human `criterion` text from these,
 *  so severity can't drift as detectors accrete. */
export interface FiringCondition {
  /** Human label for the metric, e.g. "count", "sum(duration) ms", "p99 ms". */
  metric: string;
  /** The observed value. */
  value: number;
  /** The bar it crossed. */
  threshold: number;
  /** over = an outlier past the bar; under = a near-miss / leading indicator below it. */
  direction: "over" | "under";
}

/** A re-runnable spec in far-swan's OWN verbs — never a SQL string. */
export interface CallSpec {
  verb: "query" | "aggregate" | "find" | "relate" | "call_tree" | "timeline";
  schema: string;
  /** The verb's own args (filter / timeRange / groupBy / measure / …). */
  args: Record<string, unknown>;
}

/** An entry point into the raw data the AI can follow. */
export type Handle =
  | { kind: "row"; schema: string; rowIndex: number; label: string }
  | { kind: "window"; schema: string; timeRange: { startNs: number; endNs: number }; label: string };

/** What a detector returns when it FIRES (null = didn't fire — surface only
 *  what stood out, never the catalog of what could run). One finding per
 *  detector; the AI re-runs `callSpec` for the next N (fast — table's loaded). */
export interface Finding {
  /** Plain-language headline. */
  summary: string;
  /** Structured firing conditions — the framework ranks + renders the criterion. */
  firing: FiringCondition[];
  /** A spec the AI can tweak and re-issue, in far-swan verbs. */
  callSpec: CallSpec;
  /** get_row / timeRange entry points into the flagged data. */
  handles: Handle[];
  /** Optional severity override; omit to let the framework compute it. */
  severity?: "high" | "medium" | "low";
  /**
   * Optional structured extras beyond firing/handles — for a detector whose
   * most useful output isn't just "did it fire" but a small derived artifact
   * (e.g. vsyncCadenceTable.ts's "frames held" table: a bounded vsync-tick x
   * surface-present table around the worst hitch). Deliberately a loose bag
   * rather than one field per possible enrichment — keeps Finding's core
   * shape stable as detectors accrete richer, detector-specific payloads.
   * Still never raw SQL/rows — always typed, purpose-built structures.
   */
  enrichment?: Record<string, unknown>;
}

/** What a detector's run() receives — access to the ingested tables, never
 *  leaked to the AI. */
export interface DetectorContext {
  db: DatabaseSync;
  sessionId: string;
  run: number;
  /** Resolve a schema name to its physical (ingested) table name. */
  tableName(schema: string): string;
}

/** A registered detector. */
export interface Detector {
  /** Stable slug, e.g. "swiftui-over-invalidation". */
  id: string;
  title: string;
  /** Schema-gate: only runs when ALL of these tables are ingested. */
  requiredSchemas: string[];
  /** cheap → eager once its schemas load; expensive → offered by name on demand. */
  cost: "cheap" | "expensive";
  /** Run the (bounded) analysis; return a Finding or null (didn't fire). */
  run(ctx: DetectorContext): Finding | null;
}

/** A Finding after the framework has derived its rank + criterion + severity. */
export interface RankedFinding {
  detectorId: string;
  title: string;
  summary: string;
  /** Rendered from the firing conditions, e.g. "count 1,134 over 100 AND sum(duration) ms 162 over 150". */
  criterion: string;
  severity: "high" | "medium" | "low";
  /** Ranking score (higher = more alarming); derived, not for display. */
  score: number;
  callSpec: CallSpec;
  handles: Handle[];
}
